import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {applyAction,createWorld,DomainError,normalizeWorld,recordsFor,summarize} from './world.ts';
import type {Action,Actor,World} from './world.ts';
const worker:Actor={id:'reconciliation-worker',role:'agent'},controller:Actor={id:'reconciliation-controller',role:'controller'};
const act=(w:World,action:Action,actor=controller)=>applyAction(w,action,actor).result;
const fixture=(options:any={})=>createWorld({kind:'bank-reconciliation',seed:51,...options});
const prepare=(w:World,id=w.bankStatements[0].id)=>act(w,{type:'prepare_reconciliation',statement_id:id},worker).report;
const close=(w:World,report:any,extra:any={})=>act(w,{type:'close_reconciliation',statement_id:report.statement_id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((item:any)=>item.id),external_event_id:`close-${report.id}`,...extra});
function matchAll(w:World,id=w.bankStatements[0].id){const statement=w.bankStatements.find((statement:any)=>statement.id===id);for(const line of statement.lines){const ids=w.bankTransactions.filter(row=>row.posted_at>statement.start_at&&row.posted_at<=statement.end_at&&line.source_refs.some((ref:string)=>[row.id,row.source_id,row.receipt_id].includes(ref))).map(row=>row.id);act(w,{type:'match_statement_line',statement_id:id,line_id:line.id,bank_transaction_ids:ids},worker);}}
function money(w:World){return structuredClone({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts,operations:w.operations,payments:w.payments,invoices:w.invoices,bills:w.bills});}
function rejects(w:World,action:Action,code:string,actor=worker){const before=structuredClone(w);assert.throws(()=>act(w,action,actor),(error:any)=>error instanceof DomainError&&error.code===code);assert.deepEqual(w,before);}
function definition(w:World,statement=w.bankStatements[0],source='replacement-v2'){return {source_statement_id:source,account_id:'cash-bank',currency:'USD',start_at:statement.start_at,end_at:statement.end_at,opening_balance_minor:statement.opening_balance_minor,closing_balance_minor:statement.closing_balance_minor,lines:statement.lines.map((line:any)=>({source_line_id:line.source_line_id,posted_at:line.posted_at,amount_minor:line.amount_minor,source_refs:[...line.source_refs]}))};}

test('new statement scenario preserves genuine equal-amount receipts and grouped sources without inventing cash',()=>{
  const w=fixture();assert.deepEqual(w,fixture());assert.equal(w.name,'Reconciliation');assert.equal(w.invoices.length,4);assert.equal(w.payments.filter(payment=>payment.status==='succeeded').length,4);assert.equal(w.bankStatements.length,1);assert.equal(w.bankStatements[0].lines.length,3);
  const collectionRows=w.bankTransactions.filter(row=>row.id!=='bank-opening');assert.equal(collectionRows[0].amount_minor,collectionRows[1].amount_minor);assert.notEqual(collectionRows[0].receipt_id,collectionRows[1].receipt_id);assert.deepEqual(w.bankStatements[0].lines[0].source_refs,[collectionRows[0].receipt_id,collectionRows[1].receipt_id]);
  assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,0);assert.match(w.documents.find(doc=>doc.type==='bank-reconciliation-brief').body,/posted one hour after/);
  const snapshot=money(w);matchAll(w);const report=prepare(w);assert.equal(report.can_close,true);assert.equal(report.timing_items.length,4);assert.equal(report.book_closing_minor,2_000_000);assert.equal(report.bank_closing_minor,2_000_000+collectionRows.reduce((sum,row)=>sum+row.amount_minor,0));assert.equal(report.bank_book_difference_minor,report.later_posted_cash_minor);assert.equal(report.adjusted_difference_minor,0);close(w,report);assert.deepEqual(money(w),snapshot);
  for(const feed of ['bank-statement','reconciliation-match','reconciliation-report'])assert.deepEqual(recordsFor(w,'mercury',feed),recordsFor(w,'ledger',feed));
});

test('statement import validates exact arithmetic, unique source identities, UTC timestamps and exclusive start boundary',()=>{
  const w=fixture(),base=definition(w),external={type:'record_bank_statement',...base,external_event_id:'independent-statement'};
  rejects(w,external,'controller_required');
  for(const patch of [{start_at:'2026-10-24T09:00:00Z'},{end_at:'2026-10-24T03:00:00.000-07:00'},{start_at:'2026-02-30T09:00:00.000Z'}])rejects(w,{...external,...patch},'invalid_statement_timestamp',controller);
  rejects(w,{...external,end_at:'2026-10-25T10:00:00.000Z'},'invalid_statement_period',controller);
  rejects(w,{...external,closing_balance_minor:base.closing_balance_minor+1},'statement_does_not_balance',controller);
  rejects(w,{...external,lines:[base.lines[0],base.lines[0]]},'duplicate_statement_line',controller);
  rejects(w,{...external,lines:[{...base.lines[0],posted_at:base.start_at}]},'statement_line_outside_period',controller);
  rejects(w,{...external,lines:[{...base.lines[0],amount_minor:0}]},'zero_statement_line',controller);
  rejects(w,{...external,currency:'EUR'},'unsupported_statement_account',controller);
  const result=act(w,external);const bank=money(w);assert.equal(act(w,external).replayed,true);assert.deepEqual(money(w),bank);assert.equal(w.bankStatements.filter((statement:any)=>statement.id===result.statement.id).length,1);
  rejects(w,{...external,external_event_id:'new-event-same-source'},'duplicate_statement_source',controller);
  rejects(w,{...external,source_statement_id:'different-version'},'external_event_conflict',controller);
});

test('equal amounts cannot substitute for receipt identity, and exact reference coverage governs grouping',()=>{
  const w=fixture({orderCount:2,reconciliationControls:{deferredPosting:false}}),original=w.bankStatements[0],rows=w.bankTransactions.filter(row=>row.id!=='bank-opening');
  const statement=act(w,{type:'replace_bank_statement',statement_id:original.id,...definition(w),lines:rows.map((row,index)=>({source_line_id:`separate-${index}`,posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.receipt_id]})),reason:'Separate source receipt lines',external_event_id:'split-source'}).statement;
  rejects(w,{type:'match_statement_line',statement_id:statement.id,line_id:statement.lines[0].id,bank_transaction_ids:[rows[1].id]},'invalid_statement_match');
  rejects(w,{type:'match_statement_line',statement_id:statement.id,line_id:statement.lines[0].id,bank_transaction_ids:rows.map(row=>row.id)},'invalid_statement_match');
  matchAll(w,statement.id);assert.equal(prepare(w,statement.id).can_close,true);
  const match=w.reconciliationMatches.find((match:any)=>match.statement_id===statement.id&&match.status==='active');assert.equal(act(w,{type:'match_statement_line',statement_id:statement.id,line_id:match.line_id,bank_transaction_ids:match.bank_transaction_ids},worker).replayed,true);
});

test('missing statement activity stays blocked until an explicit replacement preserves and supersedes its old evidence',()=>{
  const w=fixture({reconciliationControls:{omitStatementLine:true,deferredPosting:false}}),original=w.bankStatements[0],snapshot=money(w);matchAll(w);const report=prepare(w);
  assert.equal(report.can_close,false);assert.deepEqual(report.unmatched_bank_transaction_ids,w.reconciliationSources.omitted_bank_transaction_ids);assert.ok(report.blockers.some((item:any)=>item.code==='closing_balance_mismatch'));
  rejects(w,{type:'close_reconciliation',statement_id:original.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:'blocked-close'},'reconciliation_blocked',controller);
  const missing=w.bankTransactions.filter(row=>w.reconciliationSources.omitted_bank_transaction_ids.includes(row.id));const replacement=act(w,{type:'replace_bank_statement',statement_id:original.id,...definition(w),closing_balance_minor:report.bank_closing_minor,lines:[...definition(w).lines,...missing.map(row=>({source_line_id:`restored-${row.id}`,posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.receipt_id]}))],reason:'Bank supplied corrected complete statement',external_event_id:'corrected-statement'}).statement;
  assert.equal(w.bankStatements[0].status,'superseded');assert.equal(w.bankStatements[0].superseded_by_id,replacement.id);assert.equal(replacement.supersedes_id,original.id);assert.ok(w.documents.some(doc=>doc.id===original.document_id));assert.ok(w.reconciliationMatches.filter((match:any)=>match.statement_id===original.id).every((match:any)=>match.status==='superseded'));
  matchAll(w,replacement.id);close(w,prepare(w,replacement.id));assert.deepEqual(money(w),snapshot);
});

test('active and closed statements retain unique consumption until explicit reopened supersession releases their claims',()=>{
  const w=fixture({reconciliationControls:{deferredPosting:false}}),first=w.bankStatements[0];matchAll(w);const report=prepare(w);close(w,report);
  const second=act(w,{type:'record_bank_statement',...definition(w,first,'overlap-other-source'),external_event_id:'overlap-import'}).statement;
  const assigned=w.reconciliationMatches.find((match:any)=>match.statement_id===first.id&&match.status==='active');rejects(w,{type:'match_statement_line',statement_id:second.id,line_id:second.lines[0].id,bank_transaction_ids:assigned.bank_transaction_ids},'invalid_statement_match');
  rejects(w,{type:'replace_bank_statement',statement_id:first.id,...definition(w,first,'cannot-rewrite-closed'),reason:'Attempted rewrite',external_event_id:'closed-rewrite'},'statement_locked',controller);
  act(w,{type:'reopen_reconciliation',statement_id:first.id,reason:'Review revised bank evidence',external_event_id:'reopen-first'});
  rejects(w,{type:'match_statement_line',statement_id:second.id,line_id:second.lines[0].id,bank_transaction_ids:assigned.bank_transaction_ids},'invalid_statement_match');
  const third=act(w,{type:'replace_bank_statement',statement_id:first.id,...definition(w,first,'third-source-version'),reason:'Supersede former bank source',external_event_id:'replace-after-reopen'}).statement;
  assert.ok(w.bankStatements[0].history.some((event:any)=>event.type==='closed'));assert.ok(w.bankStatements[0].history.some((event:any)=>event.type==='reopened'));
  act(w,{type:'match_statement_line',statement_id:second.id,line_id:second.lines[0].id,bank_transaction_ids:assigned.bank_transaction_ids},worker);assert.equal(third.status,'open');
});

test('preparation binds exact assignments and relevant sources while unrelated mail and later-period transactions do not stale it',()=>{
  const w=fixture({reconciliationControls:{deferredPosting:false}}),statement=w.bankStatements[0];matchAll(w);const first=prepare(w),assignment=w.reconciliationMatches[0];
  act(w,{type:'unmatch_statement_line',statement_id:statement.id,line_id:assignment.line_id,reason:'Recheck receipt grouping'},worker);act(w,{type:'match_statement_line',statement_id:statement.id,line_id:assignment.line_id,bank_transaction_ids:assignment.bank_transaction_ids},worker);
  rejects(w,{type:'close_reconciliation',statement_id:statement.id,report_id:first.id,source_fingerprint:first.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:'old-report'},'reconciliation_not_prepared',controller);
  const second=prepare(w);assert.notEqual(second.source_fingerprint,first.source_fingerprint);act(w,{type:'send_email',to:['review@simulation.test'],subject:'Review update',body:'Source assignments confirmed.'},worker);
  assert.equal(close(w,second).closed,true);assert.equal(w.reconciliationReports.find((report:any)=>report.id===first.id).source_fingerprint,first.source_fingerprint);
});

test('unposted cash blocks close, recovery changes the fingerprint, and later journal dates remain explicitly acknowledged',()=>{
  const w=createWorld({kind:'saas-collections',orderCount:1}),start=w.now,opening=summarize(w).cash_minor;
  act(w,{type:'close_period'});act(w,{type:'collect_invoice',invoice_id:w.invoices[0].id},worker);act(w,{type:'advance_time',hours:1});const row=w.bankTransactions.at(-1)!,end=w.now;
  const statement=act(w,{type:'record_bank_statement',source_statement_id:'unposted-source',account_id:'cash-bank',currency:'USD',start_at:start,end_at:end,opening_balance_minor:opening,closing_balance_minor:opening+row.amount_minor,lines:[{source_line_id:'cash-1',posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.receipt_id]}],external_event_id:'unposted-statement'}).statement;
  matchAll(w,statement.id);const before=prepare(w,statement.id);assert.equal(before.can_close,false);assert.ok(before.blockers.some((item:any)=>item.code==='missing_cash_journal'));assert.equal(before.timing_items.length,0);
  act(w,{type:'advance_time',hours:1});act(w,{type:'reopen_period'});rejects(w,{type:'close_reconciliation',statement_id:statement.id,report_id:before.id,source_fingerprint:before.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:'stale-posting-report'},'stale_reconciliation',controller);
  const after=prepare(w,statement.id);assert.equal(after.can_close,true);assert.equal(after.book_closing_minor,opening);assert.equal(after.bank_book_difference_minor,row.amount_minor);assert.equal(after.timing_items[0].amount_minor,row.amount_minor);assert.ok(after.timing_items[0].posted_at>end);
  rejects(w,{type:'close_reconciliation',statement_id:statement.id,report_id:after.id,source_fingerprint:after.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:'missing-timing-ack'},'timing_acknowledgment_required',controller);assert.equal(close(w,after).closed,true);
});

test('independent closure rejects wrong report ownership and extra or missing timing acknowledgments atomically',()=>{
  const w=fixture();matchAll(w);const report=prepare(w),base={type:'close_reconciliation',statement_id:report.statement_id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((item:any)=>item.id),external_event_id:'controller-close'};
  rejects(w,base,'controller_required');rejects(w,base,'separate_controller_required',{id:worker.id,role:'controller'});rejects(w,{...base,source_fingerprint:'wrong'},'stale_reconciliation',controller);rejects(w,{...base,acknowledged_timing_item_ids:[...base.acknowledged_timing_item_ids,'invented-timing']},'timing_acknowledgment_required',controller);
  act(w,base);assert.equal(act(w,base).replayed,true);rejects(w,{...base,external_event_id:'another-close-event'},'statement_locked',controller);assert.equal(w.bankStatements[0].history.filter((entry:any)=>entry.type==='closed').length,1);
});

test('zero opening balances and boundary transactions are accounted without requiring fictitious opening journals',()=>{
  const w=fixture({startingCashMinor:0,reconciliationControls:{deferredPosting:false}}),statement=w.bankStatements[0];assert.equal(w.bankTransactions[0].amount_minor,0);assert.equal(w.journals.some(journal=>journal.source_type==='opening'),false);matchAll(w);const report=prepare(w);assert.equal(report.bank_opening_minor,0);assert.equal(report.book_opening_minor,0);assert.equal(report.can_close,true);close(w,report);
  const start=statement.end_at,end=w.now,empty=act(w,{type:'record_bank_statement',source_statement_id:'next-empty-period',account_id:'cash-bank',currency:'USD',start_at:start,end_at:end,opening_balance_minor:report.bank_closing_minor,closing_balance_minor:report.bank_closing_minor,lines:[],external_event_id:'next-period'}).statement;
  const emptyReport=prepare(w,empty.id);assert.equal(emptyReport.unmatched_bank_transaction_ids.length,0);assert.equal(emptyReport.can_close,true);assert.equal(emptyReport.bank_opening_minor,report.bank_closing_minor);close(w,emptyReport);
});

test('provider outages block operator work but preserve source evidence and do not fabricate financial corrections',()=>{
  const w=fixture(),statement=w.bankStatements[0],before=money(w);act(w,{type:'set_fault',system:'mercury',mode:'offline'});
  rejects(w,{type:'prepare_reconciliation',statement_id:statement.id},'connection_unavailable');
  const observed=act(w,{type:'record_bank_statement',...definition(w,statement,'received-during-outage'),external_event_id:'source-during-outage'}).statement;assert.equal(observed.status,'open');act(w,{type:'set_fault',system:'mercury',mode:'healthy'});matchAll(w);assert.equal(prepare(w).can_close,true);assert.deepEqual(money(w),before);
});

test('normalizing old worlds adds only empty statement collections, and controls leave existing economic histories intact',()=>{
  const w=createWorld({orderCount:1}),prior=money(w);for(const key of ['bankStatements','reconciliationMatches','reconciliationReports'])delete w[key];normalizeWorld(w);assert.deepEqual(money(w),prior);assert.deepEqual(recordsFor(w,'mercury','bank-statement'),[]);
  assert.equal(fixture({orderCount:1}).bankStatements[0].lines.length,1);assert.equal(fixture({orderCount:1,reconciliationControls:{omitStatementLine:true}}).bankStatements[0].lines.length,0);assert.equal(fixture({orderCount:200}).payments.length,200);
  assert.throws(()=>fixture({orderCount:201}),DomainError);assert.throws(()=>createWorld({kind:'treasury',reconciliationControls:{}}),DomainError);for(const reconciliationControls of [{omitStatementLine:1},{deferredPosting:'yes'},{invented:true}])assert.throws(()=>fixture({reconciliationControls}),DomainError);
  const named=createWorld({name:'gram touring',orderCount:1});assert.equal(named.events[0].name,'gram touring — Saturday');assert.match(named.documents.find(doc=>doc.id==='contract-promoter').body,/gram touring sells/);
});

test('independent statement booking lag remains explicit within the same window and does not rewrite either timestamp',()=>{
  const w=createWorld({kind:'saas-collections',orderCount:1}),start=w.now,opening=summarize(w).cash_minor;act(w,{type:'collect_invoice',invoice_id:w.invoices[0].id},worker);act(w,{type:'advance_time',hours:1});const row=structuredClone(w.bankTransactions.at(-1));act(w,{type:'advance_time',hours:1});
  const statement=act(w,{type:'record_bank_statement',source_statement_id:'booking-lag-source',account_id:'cash-bank',currency:'USD',start_at:start,end_at:w.now,opening_balance_minor:opening,closing_balance_minor:opening+row.amount_minor,lines:[{source_line_id:'booking-batch',posted_at:w.now,amount_minor:row.amount_minor,source_refs:[row.receipt_id]}],external_event_id:'booking-lag-statement'}).statement;
  assert.notEqual(statement.lines[0].posted_at,row.posted_at);matchAll(w,statement.id);const snapshot=money(w),report=prepare(w,statement.id);assert.equal(report.can_close,true);assert.equal(report.timing_items.length,0);close(w,report);assert.deepEqual(money(w),snapshot);assert.equal(w.bankTransactions.at(-1).posted_at,row.posted_at);
});

test('a future-dated cash journal becoming observed invalidates only the relevant prepared proof',()=>{
  const w=fixture({orderCount:1,reconciliationControls:{deferredPosting:false}}),row=w.bankTransactions.find(row=>row.id!=='bank-opening')!,journal=w.journals.find(journal=>journal.source_id===row.source_id)!;
  // Corrupt-state fixture: normal domain writes cannot create future journals.
  journal.posted_at='2026-10-24T12:00:00.000Z';matchAll(w);const prior=prepare(w);assert.equal(prior.can_close,false);assert.ok(prior.blockers.some((item:any)=>item.code==='future_cash_journal'));
  act(w,{type:'advance_time',hours:1});rejects(w,{type:'close_reconciliation',statement_id:prior.statement_id,report_id:prior.id,source_fingerprint:prior.source_fingerprint,acknowledged_timing_item_ids:[`timing:${prior.statement_id}:${journal.id}`],external_event_id:'stale-observation'},'stale_reconciliation',controller);
  const next=prepare(w);assert.notEqual(next.source_fingerprint,prior.source_fingerprint);assert.equal(next.can_close,true);act(w,{type:'advance_time',hours:1});close(w,next);
});

import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError,normalizeWorld,recordsFor,summarize} from './world.ts';
import type {Action,Actor,World} from './world.ts';
const worker:Actor={id:'reconciliation-worker',role:'agent'},controller:Actor={id:'reconciliation-controller',role:'controller'};
const act=(w:World,action:Action,actor=controller)=>applyAction(w,action,actor).result;
const fixture=(options:any={})=>createWorld({kind:'bank-reconciliation',seed:51,...options});
const prepare=(w:World,id=w.bankStatements[0].id)=>act(w,{type:'prepare_reconciliation',statement_id:id},worker).report;
const close=(w:World,report:any,extra:any={})=>act(w,{type:'close_reconciliation',statement_id:report.statement_id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((item:any)=>item.id),external_event_id:`close-${report.id}`,...extra});
function matchAll(w:World,id=w.bankStatements[0].id){const statement=w.bankStatements.find((statement:any)=>statement.id===id);for(const line of statement.lines){const ids=w.bankTransactions.filter(row=>row.posted_at>statement.start_at&&row.posted_at<=statement.end_at&&line.source_refs.some((ref:string)=>[row.id,row.source_id,row.receipt_id].includes(ref))).map(row=>row.id);act(w,{type:'match_statement_line',statement_id:id,line_id:line.id,bank_transaction_ids:ids},worker);}}
function money(w:World){return structuredClone({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts,operations:w.operations,payments:w.payments,invoices:w.invoices,bills:w.bills});}
function rejects(w:World,action:Action,code:string,actor=worker){const before=structuredClone(w);expect(()=>act(w,action,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);}
function definition(w:World,statement=w.bankStatements[0],source='replacement-v2'){return {source_statement_id:source,account_id:'cash-bank',currency:'USD',start_at:statement.start_at,end_at:statement.end_at,opening_balance_minor:statement.opening_balance_minor,closing_balance_minor:statement.closing_balance_minor,lines:statement.lines.map((line:any)=>({source_line_id:line.source_line_id,posted_at:line.posted_at,amount_minor:line.amount_minor,source_refs:[...line.source_refs]}))};}

test('new statement scenario preserves genuine equal-amount receipts and grouped sources without inventing cash',()=>{
  const w=fixture();expect(w).toStrictEqual(fixture());expect(w.name).toBe('Reconciliation');expect(w.invoices.length).toBe(4);expect(w.payments.filter(payment=>payment.status==='succeeded').length).toBe(4);expect(w.bankStatements.length).toBe(1);expect(w.bankStatements[0].lines.length).toBe(3);
  const collectionRows=w.bankTransactions.filter(row=>row.id!=='bank-opening');expect(collectionRows[0].amount_minor).toBe(collectionRows[1].amount_minor);expect(collectionRows[0].receipt_id).not.toBe(collectionRows[1].receipt_id);expect(w.bankStatements[0].lines[0].source_refs).toStrictEqual([collectionRows[0].receipt_id,collectionRows[1].receipt_id]);
  expect(summarize(w).reconciliation.bank_ledger_difference_minor).toBe(0);expect(w.documents.find(doc=>doc.type==='bank-reconciliation-brief').body).toMatch(/posted one hour after/);
  const snapshot=money(w);matchAll(w);const report=prepare(w);expect(report.can_close).toBe(true);expect(report.timing_items.length).toBe(4);expect(report.book_closing_minor).toBe(2_000_000);expect(report.bank_closing_minor).toBe(2_000_000+collectionRows.reduce((sum,row)=>sum+row.amount_minor,0));expect(report.bank_book_difference_minor).toBe(report.later_posted_cash_minor);expect(report.adjusted_difference_minor).toBe(0);close(w,report);expect(money(w)).toStrictEqual(snapshot);
  for(const feed of ['bank-statement','reconciliation-match','reconciliation-report'])expect(recordsFor(w,'mercury',feed)).toStrictEqual(recordsFor(w,'ledger',feed));
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
  const result=act(w,external);const bank=money(w);expect(act(w,external).replayed).toBe(true);expect(money(w)).toStrictEqual(bank);expect(w.bankStatements.filter((statement:any)=>statement.id===result.statement.id).length).toBe(1);
  rejects(w,{...external,external_event_id:'new-event-same-source'},'duplicate_statement_source',controller);
  rejects(w,{...external,source_statement_id:'different-version'},'external_event_conflict',controller);
});

test('equal amounts cannot substitute for receipt identity, and exact reference coverage governs grouping',()=>{
  const w=fixture({orderCount:2,reconciliationControls:{deferredPosting:false}}),original=w.bankStatements[0],rows=w.bankTransactions.filter(row=>row.id!=='bank-opening');
  const statement=act(w,{type:'replace_bank_statement',statement_id:original.id,...definition(w),lines:rows.map((row,index)=>({source_line_id:`separate-${index}`,posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.receipt_id]})),reason:'Separate source receipt lines',external_event_id:'split-source'}).statement;
  rejects(w,{type:'match_statement_line',statement_id:statement.id,line_id:statement.lines[0].id,bank_transaction_ids:[rows[1].id]},'invalid_statement_match');
  rejects(w,{type:'match_statement_line',statement_id:statement.id,line_id:statement.lines[0].id,bank_transaction_ids:rows.map(row=>row.id)},'invalid_statement_match');
  matchAll(w,statement.id);expect(prepare(w,statement.id).can_close).toBe(true);
  const match=w.reconciliationMatches.find((match:any)=>match.statement_id===statement.id&&match.status==='active');expect(act(w,{type:'match_statement_line',statement_id:statement.id,line_id:match.line_id,bank_transaction_ids:match.bank_transaction_ids},worker).replayed).toBe(true);
});

test('missing statement activity stays blocked until an explicit replacement preserves and supersedes its old evidence',()=>{
  const w=fixture({reconciliationControls:{omitStatementLine:true,deferredPosting:false}}),original=w.bankStatements[0],snapshot=money(w);matchAll(w);const report=prepare(w);
  expect(report.can_close).toBe(false);expect(report.unmatched_bank_transaction_ids).toStrictEqual(w.reconciliationSources.omitted_bank_transaction_ids);expect(report.blockers.some((item:any)=>item.code==='closing_balance_mismatch')).toBeTruthy();
  rejects(w,{type:'close_reconciliation',statement_id:original.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:'blocked-close'},'reconciliation_blocked',controller);
  const missing=w.bankTransactions.filter(row=>w.reconciliationSources.omitted_bank_transaction_ids.includes(row.id));const replacement=act(w,{type:'replace_bank_statement',statement_id:original.id,...definition(w),closing_balance_minor:report.bank_closing_minor,lines:[...definition(w).lines,...missing.map(row=>({source_line_id:`restored-${row.id}`,posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.receipt_id]}))],reason:'Bank supplied corrected complete statement',external_event_id:'corrected-statement'}).statement;
  expect(w.bankStatements[0].status).toBe('superseded');expect(w.bankStatements[0].superseded_by_id).toBe(replacement.id);expect(replacement.supersedes_id).toBe(original.id);expect(w.documents.some(doc=>doc.id===original.document_id)).toBeTruthy();expect(w.reconciliationMatches.filter((match:any)=>match.statement_id===original.id).every((match:any)=>match.status==='superseded')).toBeTruthy();
  matchAll(w,replacement.id);close(w,prepare(w,replacement.id));expect(money(w)).toStrictEqual(snapshot);
});

test('active and closed statements retain unique consumption until explicit reopened supersession releases their claims',()=>{
  const w=fixture({reconciliationControls:{deferredPosting:false}}),first=w.bankStatements[0];matchAll(w);const report=prepare(w);close(w,report);
  const second=act(w,{type:'record_bank_statement',...definition(w,first,'overlap-other-source'),external_event_id:'overlap-import'}).statement;
  const assigned=w.reconciliationMatches.find((match:any)=>match.statement_id===first.id&&match.status==='active');rejects(w,{type:'match_statement_line',statement_id:second.id,line_id:second.lines[0].id,bank_transaction_ids:assigned.bank_transaction_ids},'invalid_statement_match');
  rejects(w,{type:'replace_bank_statement',statement_id:first.id,...definition(w,first,'cannot-rewrite-closed'),reason:'Attempted rewrite',external_event_id:'closed-rewrite'},'statement_locked',controller);
  act(w,{type:'reopen_reconciliation',statement_id:first.id,reason:'Review revised bank evidence',external_event_id:'reopen-first'});
  rejects(w,{type:'match_statement_line',statement_id:second.id,line_id:second.lines[0].id,bank_transaction_ids:assigned.bank_transaction_ids},'invalid_statement_match');
  const third=act(w,{type:'replace_bank_statement',statement_id:first.id,...definition(w,first,'third-source-version'),reason:'Supersede former bank source',external_event_id:'replace-after-reopen'}).statement;
  expect(w.bankStatements[0].history.some((event:any)=>event.type==='closed')).toBeTruthy();expect(w.bankStatements[0].history.some((event:any)=>event.type==='reopened')).toBeTruthy();
  act(w,{type:'match_statement_line',statement_id:second.id,line_id:second.lines[0].id,bank_transaction_ids:assigned.bank_transaction_ids},worker);expect(third.status).toBe('open');
});

test('preparation binds exact assignments and relevant sources while unrelated mail and later-period transactions do not stale it',()=>{
  const w=fixture({reconciliationControls:{deferredPosting:false}}),statement=w.bankStatements[0];matchAll(w);const first=prepare(w),assignment=w.reconciliationMatches[0];
  act(w,{type:'unmatch_statement_line',statement_id:statement.id,line_id:assignment.line_id,reason:'Recheck receipt grouping'},worker);act(w,{type:'match_statement_line',statement_id:statement.id,line_id:assignment.line_id,bank_transaction_ids:assignment.bank_transaction_ids},worker);
  rejects(w,{type:'close_reconciliation',statement_id:statement.id,report_id:first.id,source_fingerprint:first.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:'old-report'},'reconciliation_not_prepared',controller);
  const second=prepare(w);expect(second.source_fingerprint).not.toBe(first.source_fingerprint);act(w,{type:'send_email',to:['review@simulation.test'],subject:'Review update',body:'Source assignments confirmed.'},worker);
  expect(close(w,second).closed).toBe(true);expect(w.reconciliationReports.find((report:any)=>report.id===first.id).source_fingerprint).toBe(first.source_fingerprint);
});

test('unposted cash blocks close, recovery changes the fingerprint, and later journal dates remain explicitly acknowledged',()=>{
  const w=createWorld({kind:'saas-collections',orderCount:1}),start=w.now,opening=summarize(w).cash_minor;
  act(w,{type:'close_period'});act(w,{type:'collect_invoice',invoice_id:w.invoices[0].id},worker);act(w,{type:'advance_time',hours:1});const row=w.bankTransactions.at(-1)!,end=w.now;
  const statement=act(w,{type:'record_bank_statement',source_statement_id:'unposted-source',account_id:'cash-bank',currency:'USD',start_at:start,end_at:end,opening_balance_minor:opening,closing_balance_minor:opening+row.amount_minor,lines:[{source_line_id:'cash-1',posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.receipt_id]}],external_event_id:'unposted-statement'}).statement;
  matchAll(w,statement.id);const before=prepare(w,statement.id);expect(before.can_close).toBe(false);expect(before.blockers.some((item:any)=>item.code==='missing_cash_journal')).toBeTruthy();expect(before.timing_items.length).toBe(0);
  act(w,{type:'advance_time',hours:1});act(w,{type:'reopen_period'});rejects(w,{type:'close_reconciliation',statement_id:statement.id,report_id:before.id,source_fingerprint:before.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:'stale-posting-report'},'stale_reconciliation',controller);
  const after=prepare(w,statement.id);expect(after.can_close).toBe(true);expect(after.book_closing_minor).toBe(opening);expect(after.bank_book_difference_minor).toBe(row.amount_minor);expect(after.timing_items[0].amount_minor).toBe(row.amount_minor);expect(after.timing_items[0].posted_at>end).toBeTruthy();
  rejects(w,{type:'close_reconciliation',statement_id:statement.id,report_id:after.id,source_fingerprint:after.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:'missing-timing-ack'},'timing_acknowledgment_required',controller);expect(close(w,after).closed).toBe(true);
});

test('independent closure rejects wrong report ownership and extra or missing timing acknowledgments atomically',()=>{
  const w=fixture();matchAll(w);const report=prepare(w),base={type:'close_reconciliation',statement_id:report.statement_id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((item:any)=>item.id),external_event_id:'controller-close'};
  rejects(w,base,'controller_required');rejects(w,base,'separate_controller_required',{id:worker.id,role:'controller'});rejects(w,{...base,source_fingerprint:'wrong'},'stale_reconciliation',controller);rejects(w,{...base,acknowledged_timing_item_ids:[...base.acknowledged_timing_item_ids,'invented-timing']},'timing_acknowledgment_required',controller);
  act(w,base);expect(act(w,base).replayed).toBe(true);rejects(w,{...base,external_event_id:'another-close-event'},'statement_locked',controller);expect(w.bankStatements[0].history.filter((entry:any)=>entry.type==='closed').length).toBe(1);
});

test('zero opening balances and boundary transactions are accounted without requiring fictitious opening journals',()=>{
  const w=fixture({startingCashMinor:0,reconciliationControls:{deferredPosting:false}}),statement=w.bankStatements[0];expect(w.bankTransactions[0].amount_minor).toBe(0);expect(w.journals.some(journal=>journal.source_type==='opening')).toBe(false);matchAll(w);const report=prepare(w);expect(report.bank_opening_minor).toBe(0);expect(report.book_opening_minor).toBe(0);expect(report.can_close).toBe(true);close(w,report);
  const start=statement.end_at,end=w.now,empty=act(w,{type:'record_bank_statement',source_statement_id:'next-empty-period',account_id:'cash-bank',currency:'USD',start_at:start,end_at:end,opening_balance_minor:report.bank_closing_minor,closing_balance_minor:report.bank_closing_minor,lines:[],external_event_id:'next-period'}).statement;
  const emptyReport=prepare(w,empty.id);expect(emptyReport.unmatched_bank_transaction_ids.length).toBe(0);expect(emptyReport.can_close).toBe(true);expect(emptyReport.bank_opening_minor).toBe(report.bank_closing_minor);close(w,emptyReport);
});

test('provider outages block operator work but preserve source evidence and do not fabricate financial corrections',()=>{
  const w=fixture(),statement=w.bankStatements[0],before=money(w);act(w,{type:'set_fault',system:'mercury',mode:'offline'});
  rejects(w,{type:'prepare_reconciliation',statement_id:statement.id},'connection_unavailable');
  const observed=act(w,{type:'record_bank_statement',...definition(w,statement,'received-during-outage'),external_event_id:'source-during-outage'}).statement;expect(observed.status).toBe('open');act(w,{type:'set_fault',system:'mercury',mode:'healthy'});matchAll(w);expect(prepare(w).can_close).toBe(true);expect(money(w)).toStrictEqual(before);
});

test('normalizing old worlds adds only empty statement collections, and controls leave existing economic histories intact',()=>{
  const w=createWorld({orderCount:1}),prior=money(w);for(const key of ['bankStatements','reconciliationMatches','reconciliationReports'])delete w[key];normalizeWorld(w);expect(money(w)).toStrictEqual(prior);expect(recordsFor(w,'mercury','bank-statement')).toStrictEqual([]);
  expect(fixture({orderCount:1}).bankStatements[0].lines.length).toBe(1);expect(fixture({orderCount:1,reconciliationControls:{omitStatementLine:true}}).bankStatements[0].lines.length).toBe(0);expect(fixture({orderCount:200}).payments.length).toBe(200);
  expect(()=>fixture({orderCount:201})).toThrow(DomainError);expect(()=>createWorld({kind:'treasury',reconciliationControls:{}})).toThrow(DomainError);for(const reconciliationControls of [{omitStatementLine:1},{deferredPosting:'yes'},{invented:true}])expect(()=>fixture({reconciliationControls})).toThrow(DomainError);
  const named=createWorld({name:'gram touring',orderCount:1});expect(named.events[0].name).toBe('gram touring — Saturday');expect(named.documents.find(doc=>doc.id==='contract-promoter').body).toMatch(/gram touring sells/);
});

test('independent statement booking lag remains explicit within the same window and does not rewrite either timestamp',()=>{
  const w=createWorld({kind:'saas-collections',orderCount:1}),start=w.now,opening=summarize(w).cash_minor;act(w,{type:'collect_invoice',invoice_id:w.invoices[0].id},worker);act(w,{type:'advance_time',hours:1});const row=structuredClone(w.bankTransactions.at(-1));act(w,{type:'advance_time',hours:1});
  const statement=act(w,{type:'record_bank_statement',source_statement_id:'booking-lag-source',account_id:'cash-bank',currency:'USD',start_at:start,end_at:w.now,opening_balance_minor:opening,closing_balance_minor:opening+row.amount_minor,lines:[{source_line_id:'booking-batch',posted_at:w.now,amount_minor:row.amount_minor,source_refs:[row.receipt_id]}],external_event_id:'booking-lag-statement'}).statement;
  expect(statement.lines[0].posted_at).not.toBe(row.posted_at);matchAll(w,statement.id);const snapshot=money(w),report=prepare(w,statement.id);expect(report.can_close).toBe(true);expect(report.timing_items.length).toBe(0);close(w,report);expect(money(w)).toStrictEqual(snapshot);expect(w.bankTransactions.at(-1).posted_at).toBe(row.posted_at);
});

test('a future-dated cash journal becoming observed invalidates only the relevant prepared proof',()=>{
  const w=fixture({orderCount:1,reconciliationControls:{deferredPosting:false}}),row=w.bankTransactions.find(row=>row.id!=='bank-opening')!,journal=w.journals.find(journal=>journal.source_id===row.source_id)!;
  // Corrupt-state fixture: normal domain writes cannot create future journals.
  journal.posted_at='2026-10-24T12:00:00.000Z';matchAll(w);const prior=prepare(w);expect(prior.can_close).toBe(false);expect(prior.blockers.some((item:any)=>item.code==='future_cash_journal')).toBeTruthy();
  act(w,{type:'advance_time',hours:1});rejects(w,{type:'close_reconciliation',statement_id:prior.statement_id,report_id:prior.id,source_fingerprint:prior.source_fingerprint,acknowledged_timing_item_ids:[`timing:${prior.statement_id}:${journal.id}`],external_event_id:'stale-observation'},'stale_reconciliation',controller);
  const next=prepare(w);expect(next.source_fingerprint).not.toBe(prior.source_fingerprint);expect(next.can_close).toBe(true);act(w,{type:'advance_time',hours:1});close(w,next);
});

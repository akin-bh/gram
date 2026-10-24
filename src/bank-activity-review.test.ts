import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {applyAction,createWorld,DomainError,summarize} from './world.ts';
import type {Action,Actor,World} from './world.ts';

const controller:Actor={id:'bank-activity-review-controller',role:'controller'};
const operator:Actor={id:'bank-activity-review-operator',role:'agent'};
const act=(w:World,input:Action,actor:Actor=controller)=>applyAction(w,input,actor).result;
const world=()=>createWorld({kind:'supplier-fraud',orderCount:2,initialCashMinor:100_000,approvalThresholdMinor:1_000_000_000});
let sequence=0;
const ref=(prefix:string)=>`${prefix}-${++sequence}`;
function activityInput(w:World,kind='fee',amount=250,overrides:any={}){
  return {type:'record_bank_activity',source_transaction_id:ref('bank-source'),account_id:'cash-bank',currency:'USD',kind,amount_minor:amount,posted_at:w.now,description:'Observed bank activity',external_event_id:ref('bank-event'),...overrides};
}
function classify(w:World,activity:any,account=activity.kind==='fee'?'bank-fee-expense':'interest-income'){
  return act(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:account},operator);
}
function rejects(w:World,input:Action,actor:Actor=operator,code?:string){
  const before=structuredClone(w);
  assert.throws(()=>act(w,input,actor),(error:any)=>error instanceof DomainError&&(!code||error.code===code));
  assert.deepEqual(w,before,'Failed activity actions must preserve cash, evidence, operations, journals and ID allocation');
}
const at=(w:World,account:string,cutoff:string)=>w.journals.filter(entry=>entry.posted_at<=cutoff).flatMap(entry=>entry.lines).filter(line=>line.account_id===account).reduce((sum,line)=>sum+line.debit_minor-line.credit_minor,0);
const effective=(w:World,account:string)=>w.accounts.find(row=>row.id===account).balance_minor+w.operations.filter(operation=>operation.status==='settled'&&!operation.journal_id).flatMap(operation=>operation.journal_lines||[]).filter(line=>line.account_id===account).reduce((sum,line)=>sum+(line.debit_minor||0)-(line.credit_minor||0),0);
function balanced(w:World){
  assert.equal(summarize(w).reconciliation.balanced,true);
  for(const entry of w.journals)assert.equal(entry.lines.reduce((sum:number,line:any)=>sum+line.debit_minor-line.credit_minor,0),0);
  const unclassified=w.bankActivities.filter((activity:any)=>activity.status==='unclassified').reduce((sum:number,activity:any)=>sum-activity.cash_effect_minor,0);
  assert.equal(effective(w,'bank-suspense'),unclassified);
}
function statement(w:World,start='2026-10-24T08:00:00.000Z',end=w.now){
  const rows=w.bankTransactions.filter(row=>row.status==='posted'&&row.account_id==='cash-bank'&&row.posted_at>start&&row.posted_at<=end&&row.amount_minor!==0);
  const opening=w.bankTransactions.filter(row=>row.status==='posted'&&row.posted_at<=start).reduce((sum,row)=>sum+row.amount_minor,0);
  return act(w,{type:'record_bank_statement',source_statement_id:ref('statement'),account_id:'cash-bank',currency:'USD',start_at:start,end_at:end,opening_balance_minor:opening,closing_balance_minor:opening+rows.reduce((sum,row)=>sum+row.amount_minor,0),lines:rows.map(row=>({source_line_id:`line-${row.id}`,posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.source_transaction_id||row.id]})),external_event_id:ref('statement-event')}).statement;
}
function matchAll(w:World,source:any){
  for(const line of source.lines){const rows=w.bankTransactions.filter(row=>line.source_refs.some((id:string)=>[row.id,row.source_id,row.receipt_id,row.source_transaction_id].includes(id)));act(w,{type:'match_statement_line',statement_id:source.id,line_id:line.id,bank_transaction_ids:rows.map(row=>row.id)},operator);}
}
const prepare=(w:World,source:any)=>act(w,{type:'prepare_reconciliation',statement_id:source.id},operator).report;
const closeInput=(source:any,report:any)=>({type:'close_reconciliation',statement_id:source.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((item:any)=>item.id),external_event_id:ref('closure')});

test('fee and interest observations move cash once; their classifications only clear suspense',()=>{
  const w=world(),opening=summarize(w).cash_minor;
  const fee=act(w,activityInput(w,'fee',250)),interest=act(w,activityInput(w,'interest',80));
  assert.equal(fee.bank_activity.cash_effect_minor,-250);assert.equal(interest.bank_activity.cash_effect_minor,80);
  assert.equal(summarize(w).cash_minor,opening-170);assert.equal(effective(w,'bank-suspense'),170);
  for(const result of [fee,interest]){
    assert.equal(result.bank_transaction.source_id,result.operation.id);assert.equal(result.bank_transaction.receipt_id,result.bank_activity.receipt_id);assert.equal(result.bank_transaction.source_transaction_id,result.bank_activity.source_transaction_id);
    assert.equal(result.bank_activity.bank_transaction_id,result.bank_transaction.id);assert.ok(w.documents.some(document=>document.id===result.bank_activity.document_id));
  }
  const bank=structuredClone(w.bankTransactions);classify(w,fee.bank_activity);classify(w,interest.bank_activity);
  assert.deepEqual(w.bankTransactions,bank);assert.equal(effective(w,'bank-suspense'),0);assert.equal(effective(w,'bank-fee-expense'),250);assert.equal(effective(w,'interest-income'),-80);balanced(w);
});

test('external event replay preserves the original receipt; reused business source identity cannot create new cash',()=>{
  const w=world(),input=activityInput(w),first=act(w,input),bank=structuredClone(w.bankTransactions),operations=w.operations.length,journals=w.journals.length;
  const replay=act(w,input);assert.equal(replay.replayed,true);assert.equal(replay.bank_activity.id,first.bank_activity.id);assert.equal(replay.operation.id,first.operation.id);assert.deepEqual(w.bankTransactions,bank);
  rejects(w,{...input,external_event_id:ref('duplicate-source')},controller,'duplicate_bank_activity_source');
  rejects(w,{...input,kind:'interest'},controller,'external_event_conflict');
  rejects(w,{...input,amount_minor:251,external_event_id:ref('changed-source')},controller,'duplicate_bank_activity_source');
  assert.equal(w.operations.length,operations);assert.equal(w.journals.length,journals);
  act(w,{...input,source_transaction_id:ref('equal-real-fee'),external_event_id:ref('equal-real-event')});
  assert.equal(w.bankActivities.length,2,'Equal amount and date alone must not erase a different observed source');
});

test('source IDs cannot collide with canonical bank IDs, operation IDs, receipts or prior external facts',()=>{
  const w=world();act(w,{type:'collect_invoice',invoice_id:w.invoices[0].id,amount_minor:1000},operator);act(w,{type:'advance_time',hours:1});
  const activity=act(w,activityInput(w));
  const identities=[...new Set(w.bankTransactions.flatMap(row=>[row.id,row.source_id,row.receipt_id,row.external_event_id,row.source_transaction_id]).filter(Boolean))];
  for(const identity of identities)rejects(w,activityInput(w,'fee',100,{source_transaction_id:identity}),controller);
  assert.ok(identities.includes('bank-opening'));assert.ok(identities.includes(activity.bank_activity.external_event_id));balanced(w);
});

test('recording is controller-only and classification rejects wrong categories and foreign records atomically',()=>{
  const w=world(),input=activityInput(w);rejects(w,input);
  const fee=act(w,input).bank_activity,interest=act(w,activityInput(w,'interest')).bank_activity;
  for(const [activity,account] of [[fee,'interest-income'],[interest,'bank-fee-expense'],[fee,'cash-bank'],[fee,'bank-suspense'],[fee,'expenses']])rejects(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:account});
  rejects(w,{type:'classify_bank_activity',bank_activity_id:'foreign-activity',account_id:'bank-fee-expense'});
  classify(w,fee);const bank=structuredClone(w.bankTransactions),count=w.operations.length;
  assert.equal(classify(w,fee).replayed,true);assert.equal(w.operations.length,count);assert.deepEqual(w.bankTransactions,bank);
  rejects(w,{type:'classify_bank_activity',bank_activity_id:fee.id,account_id:'interest-income'});
});

test('source dates and money are bounded without backdating the actual journal',()=>{
  const w=world(),origin=w.now;act(w,{type:'advance_time',hours:2});
  for(const posted_at of ['2026-10-24','2026-10-24T09:00:00Z','2026-10-24T09:00:00.000+00:00','2026-02-30T09:00:00.000Z','2026-10-24T08:59:59.999Z','2026-10-25T00:00:00.000Z'])rejects(w,activityInput(w,'fee',1,{posted_at}),controller);
  for(const amount of [0,-1,0.1,1_000_000_000_001,Number.MAX_SAFE_INTEGER])rejects(w,activityInput(w,'fee',amount),controller);
  for(const overrides of [{currency:'EUR'},{account_id:'cash-processor'},{kind:'adjustment'}])rejects(w,activityInput(w,'fee',1,overrides),controller);
  const recorded=act(w,activityInput(w,'fee',250,{posted_at:origin})),entry=w.journals.find(row=>row.source_id===recorded.operation.id);
  assert.equal(recorded.bank_activity.posted_at,origin);assert.equal(recorded.bank_activity.observed_at,w.now);assert.equal(recorded.bank_transaction.posted_at,origin);assert.equal(entry.posted_at,w.now);assert.ok(entry.posted_at>recorded.bank_transaction.posted_at);balanced(w);
});

test('observed fees preserve reality when cash is reserved and accepted outgoing payment waits for recovery',()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:1,initialCashMinor:1000,approvalThresholdMinor:1_000_000_000});
  const outgoing=act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:900},operator).operation;
  act(w,activityInput(w,'fee',200));assert.equal(summarize(w).cash_minor,800);assert.equal(summarize(w).reserved_minor,900);assert.equal(summarize(w).available_cash_minor,-100);
  const held=act(w,{type:'advance_time',hours:1});assert.ok(held.blocked.some((item:any)=>item.operation_id===outgoing.id));assert.equal(w.bills[0].amount_paid_minor,0);
  act(w,activityInput(w,'interest',100));act(w,{type:'advance_time',hours:1});
  assert.equal(w.bills[0].amount_paid_minor,900);assert.equal(summarize(w).cash_minor,0);assert.equal(summarize(w).reserved_minor,0);assert.equal(w.bankTransactions.filter(row=>row.source_id===outgoing.id).length,1);balanced(w);
});

test('locked or unavailable accounting retains cash evidence and posts observation and classification once after recovery',()=>{
  const w=world();act(w,{type:'close_period'});const sourceTime=w.now,recorded=act(w,activityInput(w)),classified=classify(w,recorded.bank_activity),bank=structuredClone(w.bankTransactions);
  assert.equal(recorded.operation.accounting_status,'pending_posting');assert.equal(classified.operation.accounting_status,'pending_posting');assert.equal(w.settledUnposted.length,2);balanced(w);
  act(w,{type:'advance_time',hours:1});act(w,{type:'set_fault',system:'ledger',mode:'offline'});act(w,{type:'reopen_period'});
  assert.equal(w.settledUnposted.length,2);assert.deepEqual(w.bankTransactions,bank);
  act(w,{type:'set_fault',system:'ledger',mode:'healthy'});act(w,{type:'advance_time',hours:1});act(w,{type:'advance_time',hours:1});
  assert.equal(w.settledUnposted.length,0);assert.deepEqual(w.bankTransactions,bank);
  for(const operation of [recorded.operation,classified.operation]){const entries=w.journals.filter(entry=>entry.source_id===operation.id);assert.equal(entries.length,1);assert.ok(entries[0].posted_at>sourceTime);}
  assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,0);balanced(w);
});

test('protected suspense cannot be cleared manually and classification outage never consumes the source',()=>{
  const w=world(),recorded=act(w,activityInput(w));
  rejects(w,{type:'post_journal',description:'Bypass activity classification',lines:[{account_id:'bank-suspense',credit_minor:250},{account_id:'expenses',debit_minor:250}]},controller,'control_account_locked');
  act(w,{type:'set_fault',system:'netsuite',mode:'offline'});
  rejects(w,{type:'classify_bank_activity',bank_activity_id:recorded.bank_activity.id,account_id:'bank-fee-expense'},operator,'connection_unavailable');
  assert.equal(w.bankActivities[0].status,'unclassified');assert.equal(w.bankActivities[0].classification_operation_id,undefined);
  act(w,{type:'set_fault',system:'netsuite',mode:'healthy'});classify(w,recorded.bank_activity);balanced(w);
});

test('offsetting unclassified fee and interest cannot hide behind zero aggregate suspense',()=>{
  const w=world(),fee=act(w,activityInput(w,'fee',100)).bank_activity,interest=act(w,activityInput(w,'interest',100)).bank_activity;
  assert.equal(effective(w,'bank-suspense'),0);
  const source=statement(w);matchAll(w,source);const report=prepare(w,source);
  assert.equal(report.can_close,false);assert.equal(report.blockers.filter((item:any)=>item.code==='unclassified_bank_activity').length,2);rejects(w,closeInput(source,report),controller);
  classify(w,fee);classify(w,interest);
  rejects(w,closeInput(source,report),controller,'stale_reconciliation');
  const ready=prepare(w,source);assert.equal(ready.can_close,true);act(w,closeInput(source,ready));balanced(w);
});

test('a later classification explains historical suspense without changing cutoff cash or cash timing totals',()=>{
  const w=world(),recorded=act(w,activityInput(w)),cutoff=w.now,source=statement(w);matchAll(w,source);
  const blocked=prepare(w,source);assert.equal(blocked.can_close,false);assert.equal(at(w,'bank-suspense',cutoff),250);
  act(w,{type:'advance_time',hours:1});const classified=classify(w,recorded.bank_activity),report=prepare(w,source),entry=w.journals.find(row=>row.source_id===classified.operation.id);
  assert.equal(report.can_close,true);assert.equal(report.bank_book_difference_minor,0);assert.equal(report.later_posted_cash_minor,0);assert.equal(report.adjusted_difference_minor,0);
  const timing=report.timing_items.filter((item:any)=>item.kind==='classification_posted_after_cutoff');assert.equal(timing.length,1);assert.equal(timing[0].journal_id,entry.id);assert.equal(timing[0].cash_effect_minor,0);assert.equal(timing[0].amount_minor,250);
  assert.equal(at(w,'bank-suspense',cutoff),250);assert.equal(effective(w,'bank-suspense'),0);
  rejects(w,{...closeInput(source,report),acknowledged_timing_item_ids:[]},controller);act(w,closeInput(source,report));assert.equal(at(w,'bank-suspense',cutoff),250);
});

test('late bank observations require reopening prior closure even when their date changes its opening balance',()=>{
  const w=world(),origin=w.now;act(w,{type:'advance_time',hours:1});const start=w.now;act(w,{type:'advance_time',hours:1});
  const source=statement(w,start,w.now),report=prepare(w,source);assert.equal(report.can_close,true);act(w,closeInput(source,report));
  const late=activityInput(w,'fee',250,{posted_at:origin});rejects(w,late,controller);
  act(w,{type:'reopen_reconciliation',statement_id:source.id,reason:'Observe late bank source facts',external_event_id:ref('reopen')});
  act(w,late);assert.ok(w.reconciliationReports.some((row:any)=>row.id===report.id));const next=prepare(w,source);assert.equal(next.can_close,false);assert.ok(next.blockers.some((item:any)=>item.code==='opening_balance_mismatch'));
});

test('guessing the next allocated activity or settlement identity is rejected after allocation without side effects',()=>{
  const w=world(),probe=act(structuredClone(w),activityInput(w));
  for(const id of [probe.bank_activity.id,probe.operation.id,probe.operation.receipt_id,probe.bank_transaction.id])rejects(w,activityInput(w,'fee',250,{source_transaction_id:id}),controller,'duplicate_bank_activity_source');
  assert.equal(w.bankActivities.length,0);assert.equal(w.operations.length,0);
});

test('classified status without a posted classification journal still blocks reconciliation closure',()=>{
  const w=world(),recorded=act(w,activityInput(w));act(w,{type:'close_period'});const classified=classify(w,recorded.bank_activity);
  const source=statement(w);matchAll(w,source);const report=prepare(w,source);
  assert.equal(classified.bank_activity.status,'classified');assert.equal(classified.operation.accounting_status,'pending_posting');assert.equal(report.can_close,false);assert.ok(report.blockers.some((item:any)=>item.code==='unposted_bank_classification'));
  rejects(w,closeInput(source,report),controller);
  act(w,{type:'advance_time',hours:1});act(w,{type:'reopen_period'});
  rejects(w,closeInput(source,report),controller,'stale_reconciliation');
  const ready=prepare(w,source);assert.equal(ready.can_close,true);assert.equal(ready.timing_items.filter((item:any)=>item.kind==='classification_posted_after_cutoff').length,1);act(w,closeInput(source,ready));balanced(w);
});

test('cash and classification posted after source cutoff remain separate timing items with only cash in the difference',()=>{
  const w=world(),sourceTime=w.now;act(w,{type:'advance_time',hours:1});const cutoff=w.now;act(w,{type:'advance_time',hours:1});
  const observed=act(w,activityInput(w,'fee',250,{posted_at:sourceTime}));classify(w,observed.bank_activity);
  const source=statement(w,'2026-10-24T08:00:00.000Z',cutoff);matchAll(w,source);const report=prepare(w,source);
  assert.equal(report.can_close,true);assert.equal(report.bank_closing_minor,99_750);assert.equal(report.book_closing_minor,100_000);assert.equal(report.bank_book_difference_minor,-250);assert.equal(report.later_posted_cash_minor,-250);assert.equal(report.adjusted_difference_minor,0);
  assert.equal(report.timing_items.length,2);assert.equal(report.timing_items.find((item:any)=>item.kind==='posted_after_cutoff').cash_effect_minor,-250);assert.equal(report.timing_items.find((item:any)=>item.kind==='classification_posted_after_cutoff').cash_effect_minor,0);
  const before=structuredClone({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts});act(w,closeInput(source,report));assert.deepEqual({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts},before);
});

test('classification proof checks the exact source operation and exact cash-neutral journal rather than a status label',()=>{
  const w=world(),observed=act(w,activityInput(w)),classified=classify(w,observed.bank_activity),source=statement(w);matchAll(w,source);
  for(const variant of ['wrong-operation-amount','wrong-source','wrong-journal-amount','cash-journal','missing-journal','duplicate-journal']){
    const damaged=structuredClone(w),activity=damaged.bankActivities[0],operation=damaged.operations.find(row=>row.id===classified.operation.id),entry=damaged.journals.find(row=>row.id===operation.journal_id);
    let expected='bank_classification_journal_mismatch';
    if(variant==='wrong-operation-amount'){operation.amount_minor++;expected='invalid_bank_classification';}
    else if(variant==='wrong-source'){activity.source_transaction_id='forged-bank-fact';expected='invalid_bank_activity_source';}
    else if(variant==='wrong-journal-amount'){for(const line of entry.lines){if(line.debit_minor)line.debit_minor++;if(line.credit_minor)line.credit_minor++;}}
    else if(variant==='cash-journal')entry.lines.find((line:any)=>line.account_id==='bank-suspense').account_id='cash-bank';
    else if(variant==='missing-journal'){damaged.journals=damaged.journals.filter(row=>row.id!==entry.id);expected='unposted_bank_classification';}
    else{damaged.journals.push({...structuredClone(entry),id:'duplicate-classification-journal'});expected='ambiguous_bank_classification_journal';}
    const report=prepare(damaged,source);assert.equal(report.can_close,false,variant);assert.ok(report.blockers.some((item:any)=>item.code===expected),variant);rejects(damaged,closeInput(source,report),controller);
  }
});

test('a future-dated classification journal cannot be acknowledged early and clock eligibility changes stale its report',()=>{
  const w=world(),observed=act(w,activityInput(w)),classified=classify(w,observed.bank_activity),source=statement(w);matchAll(w,source);
  const journal=w.journals.find(row=>row.source_id===classified.operation.id);journal.posted_at='2026-10-24T10:00:00.000Z';
  const future=prepare(w,source);assert.equal(future.can_close,false);assert.ok(future.blockers.some((item:any)=>item.code==='future_bank_classification_journal'));rejects(w,closeInput(source,future),controller);
  act(w,{type:'advance_time',hours:1});rejects(w,closeInput(source,future),controller,'stale_reconciliation');
  const current=prepare(w,source);assert.equal(current.can_close,true);assert.notEqual(current.source_fingerprint,future.source_fingerprint);assert.equal(current.timing_items[0].kind,'classification_posted_after_cutoff');act(w,closeInput(source,current));
});

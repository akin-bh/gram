import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {createWorld,applyAction,recordsFor,summarize,systemCatalog,scenarioCatalog,DomainError,normalizeWorld} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {scenarioSchema} from './agent.ts';

const agent:Actor={id:'agent-1',role:'agent'},controller:Actor={id:'controller-1',role:'controller'};
const act=(w:World,action:Action,actor=controller)=>applyAction(w,action,actor).result;
function balanced(w:World) {
  for(const journal of w.journals) assert.equal(journal.lines.reduce((sum:number,line:any)=>sum+line.debit_minor-line.credit_minor,0),0,journal.id);
  assert.equal(w.accounts.reduce((sum:number,a:any)=>sum+a.balance_minor,0),0);
  assert.equal(summarize(w).reconciliation.balanced,true);
}
function unchangedOnError(w:World,action:Action,code:string,actor=agent) {
  const before=structuredClone(w);
  assert.throws(()=>act(w,action,actor),(error:any)=>error instanceof DomainError&&error.code===code);
  assert.deepEqual(w,before);
}

test('all scenario seeds are deterministic, balanced and exposed through coherent catalog projections',()=>{
  assert.ok(systemCatalog.length>=45);
  for(const scenario of scenarioCatalog) {
    const a=createWorld({kind:scenario.kind,seed:'repeatable',orderCount:20},'test');
    assert.deepEqual(a,createWorld({kind:scenario.kind,seed:'repeatable',orderCount:20},'test'));balanced(a);
    assert.equal(summarize(a).reconciliation.bank_ledger_difference_minor,0);
    for(const system of systemCatalog)for(const feed of system.feeds)assert.ok(Array.isArray(recordsFor(a,system.id,feed)),`${system.id}/${feed}`);
    assert.deepEqual(recordsFor(a,'netsuite','book-transaction'),recordsFor(a,'quickbooks','book-transaction'));
    assert.deepEqual(recordsFor(a,'gmail','message'),a.messages);
  }
  const a=createWorld({seed:1}),b=createWorld({seed:2});assert.notEqual(a.orders[0].total_minor,b.orders[0].total_minor);
});

test('partial refund reserves funds then settles once across Stripe, bank, journal and Gmail',()=>{
  const w=createWorld({orderCount:2}),payment=w.payments[0],opening=summarize(w).cash_minor;
  const initialJournals=w.journals.length,amount=Math.floor(payment.refundable_minor/2);
  const outcome=applyAction(w,{type:'refund',payment_id:payment.id,amount_minor:amount},agent),result=outcome.result;
  assert.equal(outcome.events[0].type,'operation.created');assert.equal(outcome.events[0].operation_type,'refund');
  assert.equal(result.refund.status,'pending');assert.equal(summarize(w).available_cash_minor,opening-amount);
  assert.equal(summarize(w).cash_minor,opening);assert.equal(w.journals.length,initialJournals);
  act(w,{type:'advance_time',hours:1});
  assert.equal(w.refunds[0].status,'succeeded');assert.equal(w.payments[0].amount_refunded_minor,amount);
  assert.equal(summarize(w).cash_minor,opening-amount);assert.equal(summarize(w).reserved_minor,0);
  assert.equal(w.journals.filter(j=>j.source_id===result.operation.id).length,1);
  assert.equal(w.bankTransactions.filter(t=>t.source_id===result.operation.id).length,1);
  assert.equal(w.messages.filter(m=>m.source_refs.includes(result.refund.id)).length,1);
  const after=structuredClone(w);act(w,{type:'advance_time',hours:24});
  assert.deepEqual(w.refunds,after.refunds);assert.deepEqual(w.bankTransactions,after.bankTransactions);assert.deepEqual(w.journals,after.journals);
  act(w,{type:'refund',payment_id:payment.id},agent);act(w,{type:'advance_time',hours:1});
  assert.equal(w.payments[0].amount_refunded_minor,payment.refundable_minor);balanced(w);
  unchangedOnError(w,{type:'refund',payment_id:payment.id,amount_minor:1},'refund_exceeds_remaining');
});

test('voided authorizations, over-refunds, rerouting and pending duplication cannot move money',()=>{
  const w=createWorld({orderCount:20}),payment=w.payments[0],voided=w.payments.find(p=>p.status==='voided');
  unchangedOnError(w,{type:'refund',payment_id:voided.id},'not_captured');
  unchangedOnError(w,{type:'refund',payment_id:payment.id,amount_minor:payment.amount_minor},'refund_exceeds_remaining');
  unchangedOnError(w,{type:'refund',payment_id:payment.id,route:'different-card'},'invalid_beneficiary');
  act(w,{type:'refund',payment_id:payment.id},agent);
  unchangedOnError(w,{type:'refund',payment_id:payment.id,amount_minor:1},'refund_exceeds_remaining');
  unchangedOnError(w,{type:'refund',payment_id:w.payments[1].id,amount_minor:0.1},'invalid_integer');
});

test('high-value effects require distinct controller, approval produces exactly one operation',()=>{
  const w=createWorld({orderCount:2,approvalThresholdMinor:100});
  const request={type:'refund',payment_id:w.payments[0].id,amount_minor:500};
  const waiting=act(w,request,agent);assert.equal(waiting.status,'awaiting_approval');assert.equal(w.operations.length,0);
  const same=act(w,request,agent);assert.equal(same.approval_id,waiting.approval_id);assert.equal(w.approvals.length,1);
  unchangedOnError(w,{type:'decide_approval',approval_id:waiting.approval_id,decision:'approve'},'controller_required');
  unchangedOnError(w,{type:'decide_approval',approval_id:waiting.approval_id,decision:'approve'},'separate_controller_required',{id:agent.id,role:'controller'});
  const accepted=act(w,{type:'decide_approval',approval_id:waiting.approval_id,decision:'approve'});
  assert.equal(accepted.operation.status,'pending');assert.equal(w.operations.length,1);
  unchangedOnError(w,{type:'decide_approval',approval_id:waiting.approval_id,decision:'approve'},'approval_already_decided',controller);
  act(w,{type:'advance_time',hours:1});assert.equal(w.refunds[0].status,'succeeded');balanced(w);
});

test('supplier fraud cannot change verified beneficiary; reservations prevent overdraft',()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:3,initialCashMinor:50000,approvalThresholdMinor:1000000});
  const bill=w.bills[0];
  assert.ok(w.messages.some(m=>m.body.includes('attacker-beneficiary')));
  unchangedOnError(w,{type:'pay_bill',bill_id:bill.id,beneficiary_id:'attacker-beneficiary-999',amount_minor:100},'unverified_beneficiary');
  act(w,{type:'pay_bill',bill_id:bill.id,amount_minor:10000},agent);
  assert.equal(summarize(w).reserved_minor,10000);
  const target=w.bills.find(b=>b.amount_minor>40001);
  unchangedOnError(w,{type:'pay_bill',bill_id:target.id,amount_minor:40001},'insufficient_funds');
  act(w,{type:'advance_time',hours:1});assert.equal(w.bills[0].amount_paid_minor,10000);balanced(w);
});

test('outage blocks settlement; recovery settles once and Gmail outbox flushes independently',()=>{
  const w=createWorld({orderCount:2});const refund=act(w,{type:'refund',payment_id:w.payments[0].id},agent);
  act(w,{type:'set_fault',system:'stripe',mode:'offline'});const blocked=act(w,{type:'advance_time',hours:2});
  assert.equal(blocked.blocked.length,1);assert.equal(w.refunds[0].status,'pending');assert.equal(w.operations[0].attempts,1);
  unchangedOnError(w,{type:'refund',payment_id:w.payments[1].id},'connection_unavailable');
  act(w,{type:'set_fault',system:'stripe',mode:'healthy'});act(w,{type:'set_fault',system:'gmail',mode:'expired'});
  act(w,{type:'advance_time',hours:1});assert.equal(w.refunds[0].status,'succeeded');
  const notice=w.messages.find(m=>m.source_refs.includes(refund.refund.id));assert.equal(notice.delivery_status,'queued');
  act(w,{type:'set_fault',system:'gmail',mode:'healthy'});act(w,{type:'advance_time',hours:1});
  assert.equal(w.messages.find(m=>m.id===notice.id).delivery_status,'delivered');assert.equal(w.messages.filter(m=>m.id===notice.id).length,1);balanced(w);
});

test('locked period preserves provider settlement truth and posts once after reopen',()=>{
  const w=createWorld({kind:'period-close',orderCount:2}),invoice=w.invoices[0];
  const opening=summarize(w).cash_minor;
  const result=act(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:1000},agent);
  act(w,{type:'advance_time',hours:1});
  assert.equal(w.invoices[0].amount_paid_minor,1000);assert.equal(summarize(w).cash_minor,opening+1000);
  assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,1000);assert.equal(w.settledUnposted.length,1);
  assert.equal(w.journals.filter(j=>j.source_id===result.operation.id).length,0);
  act(w,{type:'reopen_period'});assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,0);
  assert.equal(w.journals.filter(j=>j.source_id===result.operation.id).length,1);assert.equal(w.settledUnposted.length,0);
  act(w,{type:'reopen_period'});assert.equal(w.journals.filter(j=>j.source_id===result.operation.id).length,1);balanced(w);
});

test('journals reject imbalance atomically; adjustments cannot fabricate provider cash',()=>{
  const w=createWorld({kind:'saas-collections',orderCount:2});
  unchangedOnError(w,{type:'post_journal',lines:[{account_id:'expenses',debit_minor:100},{account_id:'revenue',credit_minor:99}]},'unbalanced_journal',controller);
  unchangedOnError(w,{type:'post_journal',lines:[{account_id:'cash-bank',debit_minor:100},{account_id:'equity',credit_minor:100}]},'control_account_locked',controller);
  act(w,{type:'post_journal',description:'Accrued tax adjustment',lines:[{account_id:'expenses',debit_minor:100},{account_id:'tax-liability',credit_minor:100}]});balanced(w);
  unchangedOnError(w,{type:'advance_time',hours:1},'controller_required');
  unchangedOnError(w,{type:'set_fault',system:'stripe',mode:'offline'},'controller_required');
});

test('SaaS collections preserve partially-paid receivables and matching bank receipts',()=>{
  const w=createWorld({kind:'saas-collections',orderCount:1}),invoice=w.invoices[0];
  const amount=Math.floor(invoice.amount_minor/3),initial=summarize(w).receivables_minor;
  act(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:amount},agent);
  assert.equal(w.payments[0].status,'processing');assert.equal(w.payments[0].invoice_id,invoice.id);
  unchangedOnError(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:invoice.amount_minor},'amount_exceeds_remaining');
  act(w,{type:'advance_time',hours:1});assert.equal(w.invoices[0].status,'partially_paid');assert.equal(summarize(w).receivables_minor,initial-amount);
  assert.equal(w.payments[0].status,'succeeded');assert.equal(w.payments[0].amount_minor,amount);
  act(w,{type:'collect_invoice',invoice_id:invoice.id},agent);act(w,{type:'advance_time',hours:1});assert.equal(w.invoices[0].status,'paid');assert.equal(summarize(w).receivables_minor,0);balanced(w);
});

test('splitting a refund or bill payment cannot bypass the cumulative approval threshold',()=>{
  for(const kind of ['ticket-cancellation','supplier-fraud']) {
    const w=createWorld({kind,orderCount:2,approvalThresholdMinor:1000});
    const action=kind==='ticket-cancellation'?{type:'refund',payment_id:w.payments[0].id}:{type:'pay_bill',bill_id:w.bills[0].id};
    act(w,{...action,amount_minor:600},agent);
    const pendingReview=act(w,{...action,amount_minor:500},agent);
    assert.equal(pendingReview.status,'awaiting_approval');assert.equal(w.operations.length,1);
    act(w,{type:'advance_time',hours:1});
    const settledReview=act(w,{...action,amount_minor:500},agent);
    assert.equal(settledReview.approval_id,pendingReview.approval_id);assert.equal(w.operations.length,1);
    act(w,{type:'decide_approval',approval_id:settledReview.approval_id,decision:'approve'});
    assert.equal(w.operations.length,2);act(w,{type:'advance_time',hours:1});balanced(w);
  }
});

test('generated inputs retain context and apply only supported explicit simulation controls',()=>{
  const w=createWorld({kind:'ticket-cancellation',startingCashMinor:120000,description:'An arena event',narrative:'Bank access has failed.',cancelEvent:false,initialFaults:[{system:'bank',mode:'offline'}]});
  assert.equal(w.description,'An arena event');assert.ok(w.documents.find(d=>d.id==='scenario-context').body.includes('Bank access has failed.'));
  assert.equal(w.events[0].status,'scheduled');assert.equal(w.faults.bank.mode,'offline');
  assert.equal(w.bankTransactions[0].amount_minor,120000);
  act(w,{type:'set_fault',system:'bank',mode:'healthy'});
  unchangedOnError(w,{type:'refund',payment_id:w.payments[0].id},'event_not_cancelled');
  const cancelled=act(w,{type:'cancel_event',event_id:w.events[0].id});assert.equal(cancelled.event.status,'cancelled');
  assert.ok(w.messages.some(m=>m.source_refs.includes(cancelled.document.id)));
  assert.throws(()=>createWorld({currency:'EUR'}),/Only USD/);
  assert.throws(()=>createWorld({initialCashMinor:100,startingCashMinor:200}),/disagree/);
  assert.throws(()=>createWorld({initialFaults:[{system:'unknown',mode:'offline'}]}),/Unknown initial/);
});

function collected(kind='saas-collections',options:any={}){
  const w=createWorld({kind,orderCount:2,...options});
  act(w,{type:'collect_invoice',invoice_id:w.invoices[0].id,amount_minor:5000},agent);act(w,{type:'advance_time',hours:1});
  return {w,payment:w.payments[0],invoice:w.invoices[0]};
}
const balance=(w:World,id:string)=>w.accounts.find(a=>a.id===id).balance_minor;

test('SaaS credit notes authorize only original paid collections and discharge a real credit liability',()=>{
  const {w,payment,invoice}=collected(),initialBank=summarize(w).cash_minor,initialRevenue=balance(w,'revenue'),initialAR=balance(w,'receivables');
  unchangedOnError(w,{type:'refund',payment_id:payment.id,amount_minor:100},'credit_note_required');
  const issue={type:'issue_credit_note',invoice_id:invoice.id,payment_id:payment.id,amount_minor:2000,reason:'Delivered service SLA adjustment',external_event_id:'credit-1'};
  unchangedOnError(w,issue,'controller_required');
  const note=act(w,issue).credit_note;
  assert.equal(balance(w,'revenue'),initialRevenue+2000);assert.equal(balance(w,'refunds-payable'),-2000);
  assert.equal(balance(w,'receivables'),initialAR);assert.equal(summarize(w).cash_minor,initialBank);
  const counts={journals:w.journals.length,messages:w.messages.length,notes:w.creditNotes.length};
  assert.equal(act(w,issue).replayed,true);assert.deepEqual({journals:w.journals.length,messages:w.messages.length,notes:w.creditNotes.length},counts);
  unchangedOnError(w,{...issue,amount_minor:1000},'external_event_conflict',controller);
  unchangedOnError(w,{...issue,external_event_id:'credit-too-much',amount_minor:3001},'credit_exceeds_collection',controller);
  unchangedOnError(w,{...issue,external_event_id:'credit-wrong-invoice',invoice_id:w.invoices[1].id},'credit_requires_collection',controller);
  act(w,{type:'refund',payment_id:payment.id,credit_note_id:note.id,amount_minor:500},agent);act(w,{type:'advance_time',hours:1});
  assert.equal(balance(w,'refunds-payable'),-1500);assert.equal(summarize(w).cash_minor,initialBank-500);
  act(w,{type:'refund',payment_id:payment.id,credit_note_id:note.id},agent);act(w,{type:'advance_time',hours:1});
  assert.equal(w.creditNotes[0].status,'refunded');assert.equal(w.creditNotes[0].amount_refunded_minor,2000);assert.equal(balance(w,'refunds-payable'),0);
  assert.equal(w.invoices[0].amount_paid_minor,5000);assert.equal(w.invoices[0].amount_credited_minor,2000);assert.equal(balance(w,'receivables'),initialAR);
  assert.equal(summarize(w).cash_minor,initialBank-2000);assert.equal(recordsFor(w,'chargebee','credit-notes')[0].id,note.id);balanced(w);
});

test('credit issuance and refund settlements stay observable while accounting is locked or offline',()=>{
  const {w,payment,invoice}=collected(),initialBank=summarize(w).cash_minor,initialJournals=w.journals.length;
  act(w,{type:'close_period'});
  const note=act(w,{type:'issue_credit_note',invoice_id:invoice.id,payment_id:payment.id,amount_minor:1000,reason:'Service credit',external_event_id:'credit-locked'}).credit_note;
  act(w,{type:'refund',payment_id:payment.id,credit_note_id:note.id,amount_minor:1000},agent);act(w,{type:'advance_time',hours:1});
  assert.equal(w.journals.length,initialJournals);assert.equal(summarize(w).cash_minor,initialBank-1000);assert.equal(w.settledUnposted.length,2);
  act(w,{type:'set_fault',system:'netsuite',mode:'offline'});act(w,{type:'reopen_period'});assert.equal(w.settledUnposted.length,2);
  act(w,{type:'set_fault',system:'netsuite',mode:'healthy'});act(w,{type:'advance_time',hours:1});
  assert.equal(w.settledUnposted.length,0);assert.equal(w.journals.length,initialJournals+2);assert.equal(balance(w,'refunds-payable'),0);
  assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,0);balanced(w);
});

test('a dispute withdraws once, requires real source evidence and returns the same funds when won',()=>{
  const {w,payment}=collected(),initialBank=summarize(w).cash_minor;
  const opening={type:'open_dispute',payment_id:payment.id,amount_minor:3000,reason:'Customer alleges non-delivery',external_event_id:'dispute-open-1'};
  const dispute=act(w,opening).dispute;
  assert.equal(summarize(w).cash_minor,initialBank-3000);assert.equal(balance(w,'dispute-suspense'),3000);
  assert.equal(act(w,opening).replayed,true);assert.equal(summarize(w).cash_minor,initialBank-3000);
  unchangedOnError(w,{...opening,amount_minor:2000},'external_event_conflict',controller);
  unchangedOnError(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'premature-win'},'evidence_required',controller);
  unchangedOnError(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['invented-document'],statement:'Delivered'},'not_found');
  act(w,{type:'set_fault',system:'stripe',mode:'offline'});
  unchangedOnError(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Contract confirms service delivery'},'connection_unavailable');
  act(w,{type:'set_fault',system:'stripe',mode:'healthy'});
  act(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Contract confirms service delivery'},agent);
  assert.equal(w.disputes[0].status,'evidence_submitted');
  const outcome={type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'dispute-win-1'};act(w,outcome);
  assert.equal(summarize(w).cash_minor,initialBank);assert.equal(balance(w,'dispute-suspense'),0);assert.equal(balance(w,'chargeback-expense'),0);
  const bankCount=w.bankTransactions.length;assert.equal(act(w,outcome).replayed,true);assert.equal(w.bankTransactions.length,bankCount);
  unchangedOnError(w,{...outcome,external_event_id:'duplicate-win'},'dispute_closed',controller);balanced(w);
});

test('lost dispute clears existing credit liability first and cannot double-debit a pending partial refund',()=>{
  const {w,payment,invoice}=collected(),before=summarize(w).cash_minor;
  const note=act(w,{type:'issue_credit_note',invoice_id:invoice.id,payment_id:payment.id,amount_minor:2000,reason:'SLA credit',external_event_id:'credit-before-dispute'}).credit_note;
  act(w,{type:'refund',payment_id:payment.id,credit_note_id:note.id,amount_minor:1000},agent);
  unchangedOnError(w,{type:'open_dispute',payment_id:payment.id,amount_minor:4001,reason:'Dispute',external_event_id:'overlapping-dispute'},'dispute_exceeds_remaining',controller);
  const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:4000,reason:'Issuer dispute',external_event_id:'dispute-over-credit'}).dispute;
  act(w,{type:'advance_time',hours:1});assert.equal(w.refunds[0].status,'pending');assert.equal(w.operations.find(o=>o.type==='refund').last_error,'unresolved_dispute');
  const bankRows=w.bankTransactions.length;
  act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'lost',external_event_id:'lost-over-credit'});
  assert.equal(w.bankTransactions.length,bankRows,'Losing an already withdrawn dispute must not debit cash again');
  assert.equal(balance(w,'dispute-suspense'),0);assert.equal(balance(w,'chargeback-expense'),3000);assert.equal(balance(w,'refunds-payable'),-1000);
  assert.equal(w.creditNotes[0].amount_disputed_minor,1000);
  act(w,{type:'advance_time',hours:1});assert.equal(w.refunds[0].status,'succeeded');assert.equal(balance(w,'refunds-payable'),0);
  assert.equal(summarize(w).cash_minor,before-5000);assert.equal(w.creditNotes[0].status,'satisfied');assert.equal(w.payments[0].amount_disputed_lost_minor,4000);
  unchangedOnError(w,{type:'refund',payment_id:payment.id,credit_note_id:note.id,amount_minor:1},'invalid_credit_note');balanced(w);
});

test('lost ticket chargeback discharges refundable liability and charges only the residual fee to expense',()=>{
  const w=createWorld({orderCount:1}),payment=w.payments[0],initialBank=summarize(w).cash_minor;
  const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:payment.amount_minor,reason:'Full issuer chargeback',external_event_id:'ticket-dispute'}).dispute;
  act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'lost',external_event_id:'ticket-lost'});
  assert.equal(balance(w,'ticket-liability'),0);assert.equal(balance(w,'chargeback-expense'),w.orders[0].fee_minor);assert.equal(balance(w,'dispute-suspense'),0);
  assert.equal(summarize(w).cash_minor,initialBank-payment.amount_minor);assert.equal(summarize(w).refundable_minor,0);
  unchangedOnError(w,{type:'refund',payment_id:payment.id,amount_minor:1},'refund_exceeds_remaining');balanced(w);
});

test('bank returns preserve original settlement and reopen only the genuinely returned bill amount',()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:2}),bill=w.bills[0],initialBank=summarize(w).cash_minor,initialAP=balance(w,'payables');
  const paid=act(w,{type:'pay_bill',bill_id:bill.id,amount_minor:2000},agent);
  const returning={type:'return_bill_payment',operation_id:paid.operation.id,amount_minor:800,reason:'Beneficiary account closed',return_code:'R02',external_event_id:'bank-return-1'};
  unchangedOnError(w,returning,'return_requires_settlement',controller);act(w,{type:'advance_time',hours:1});
  const original=structuredClone(w.operations.find(o=>o.id===paid.operation.id));
  unchangedOnError(w,returning,'controller_required');const result=act(w,returning);
  assert.equal(w.bills[0].amount_paid_minor,1200);assert.equal(w.bills[0].status,'partially_paid');assert.equal(summarize(w).cash_minor,initialBank-1200);assert.equal(balance(w,'payables'),initialAP+1200);
  const preserved=w.operations.find(o=>o.id===original.id);assert.equal(preserved.status,'settled');assert.equal(preserved.receipt_id,original.receipt_id);assert.equal(preserved.journal_id,original.journal_id);
  assert.equal(result.payment_return.original_receipt_id,original.receipt_id);assert.notEqual(result.payment_return.receipt_id,original.receipt_id);
  const count=w.bankTransactions.length;assert.equal(act(w,returning).replayed,true);assert.equal(w.bankTransactions.length,count);
  unchangedOnError(w,{...returning,external_event_id:'over-return',amount_minor:1201},'return_exceeds_payment',controller);
  act(w,{...returning,external_event_id:'return-rest',amount_minor:1200});assert.equal(w.bills[0].status,'open');assert.equal(summarize(w).cash_minor,initialBank);
  assert.equal(balance(w,'payables'),initialAP);assert.equal(recordsFor(w,'mercury','payment-returns').length,2);balanced(w);
});

test('locked original settlement and bank return reconcile once after reopening, even if the connector is offline',()=>{
  const w=createWorld({kind:'period-close',orderCount:1}),initialAP=balance(w,'payables'),initialCash=summarize(w).cash_minor;
  const operation=act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:2000},agent).operation;act(w,{type:'advance_time',hours:1});
  act(w,{type:'set_fault',system:'mercury',mode:'offline'});
  act(w,{type:'return_bill_payment',operation_id:operation.id,amount_minor:500,reason:'Partial bank return',external_event_id:'locked-return'});
  assert.equal(w.settledUnposted.length,2);assert.equal(balance(w,'payables'),initialAP);assert.equal(summarize(w).cash_minor,initialCash-1500);
  act(w,{type:'reopen_period'});assert.equal(w.settledUnposted.length,0);assert.equal(balance(w,'payables'),initialAP+1500);
  assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,0);const journals=w.journals.length;act(w,{type:'reopen_period'});assert.equal(w.journals.length,journals);balanced(w);
});

test('external cash withdrawal blocks an already reserved outgoing payment until liquidity actually recovers',()=>{
  const {w,payment}=collected('supplier-fraud',{initialCashMinor:0});
  const bill=act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:4000},agent).operation;
  const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:4000,reason:'Issuer inquiry',external_event_id:'liquidity-shock'}).dispute;
  act(w,{type:'advance_time',hours:1});assert.equal(w.operations.find(o=>o.id===bill.id).status,'pending');assert.equal(summarize(w).cash_minor,1000);
  act(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Delivered as contracted'},agent);
  act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'liquidity-recovery'});
  act(w,{type:'advance_time',hours:1});assert.equal(w.operations.find(o=>o.id===bill.id).status,'settled');assert.equal(summarize(w).cash_minor,1000);balanced(w);
});

test('additive world normalization preserves all historical balances and failed migration mutations remain atomic',()=>{
  const w=createWorld({orderCount:2});for(const key of ['creditNotes','disputes','paymentReturns','externalEvents'])delete w[key];
  w.accounts=w.accounts.filter(a=>!['refunds-payable','dispute-suspense','chargeback-expense'].includes(a.id));
  for(const payment of w.payments){delete payment.amount_disputed_lost_minor;delete payment.amount_ticket_liability_discharged_minor;}
  const before=structuredClone(w);
  unchangedOnError(w,{type:'open_dispute',payment_id:'missing',amount_minor:1,reason:'Invalid',external_event_id:'invalid-migration'},'not_found',controller);
  normalizeWorld(w);assert.deepEqual(w.bankTransactions,before.bankTransactions);assert.deepEqual(w.journals,before.journals);
  for(const account of before.accounts)assert.equal(balance(w,account.id),account.balance_minor);
  for(const id of ['refunds-payable','dispute-suspense','chargeback-expense'])assert.equal(balance(w,id),0);
  assert.deepEqual(recordsFor(w,'stripe','disputes'),[]);assert.deepEqual(recordsFor(w,'ledger','credit-notes'),[]);balanced(w);
});

test('dispute cash truth and reversal survive a locked period without replaying bank effects on reopen',()=>{
  const {w,payment}=collected(),initialBank=summarize(w).cash_minor,initialJournals=w.journals.length;
  act(w,{type:'close_period'});
  const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:2000,reason:'Issuer chargeback',external_event_id:'locked-hold'}).dispute;
  assert.equal(summarize(w).cash_minor,initialBank-2000);assert.equal(balance(w,'dispute-suspense'),0);assert.equal(w.settledUnposted.length,1);
  act(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Accepted delivered service'},agent);
  act(w,{type:'set_fault',system:'stripe',mode:'offline'});
  act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'locked-release'});
  assert.equal(summarize(w).cash_minor,initialBank);assert.equal(w.settledUnposted.length,2);assert.equal(w.journals.length,initialJournals);
  const bankTransactions=structuredClone(w.bankTransactions);act(w,{type:'reopen_period'});
  assert.equal(w.journals.length,initialJournals+2);assert.equal(balance(w,'dispute-suspense'),0);assert.equal(w.settledUnposted.length,0);
  assert.deepEqual(w.bankTransactions,bankTransactions);assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,0);balanced(w);
});

test('expired dispute evidence and resolved disputes cannot be rewritten by a worker',()=>{
  const {w,payment}=collected();
  const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:1000,reason:'Issuer dispute',evidence_due_hours:1,external_event_id:'deadline-hold'}).dispute;
  act(w,{type:'advance_time',hours:2});
  unchangedOnError(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Late response'},'evidence_deadline_passed');
  unchangedOnError(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'worker-forged-win'},'controller_required');
  act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'lost',external_event_id:'deadline-loss'});
  assert.equal(balance(w,'dispute-suspense'),0);assert.equal(balance(w,'chargeback-expense'),1000);
  unchangedOnError(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Rewrite outcome'},'dispute_closed');balanced(w);
});

test('canonical mail preserves validated HTML and attachment bytes without allowing header injection',()=>{
  const w=createWorld({orderCount:1});
  const attachment={filename:'credit-receipt.txt',mimeType:'text/plain',data:Buffer.from('Receipt CN-1').toString('base64url')};
  const sent=act(w,{type:'send_email',to:['customer@example.test'],subject:'Credit receipt',html:'<p>Credit issued.</p>',attachments:[attachment]},agent);
  assert.equal(sent.html,'<p>Credit issued.</p>');assert.equal(sent.body,'Credit issued.');assert.equal(sent.attachments[0].data,attachment.data);assert.equal(sent.attachments[0].filename,'credit-receipt.txt');
  const before=structuredClone(w);
  assert.throws(()=>act(w,{type:'send_email',to:['customer@example.test'],subject:'Receipt\r\nBcc: outsider@example.test',body:'Hi'},agent),/single-line/);
  assert.deepEqual(w,before);
});

test('generated settlement exception history contains actual original settlements, independent approvals and linked source records',()=>{
  const input={kind:'settlement-exceptions',seed:19,orderCount:3,approvalThresholdMinor:1};
  const w=createWorld(input,'exception-world');assert.deepEqual(w,createWorld(input,'exception-world'));
  const source=w.exceptionSources,invoice=w.invoices.find(i=>i.id===source.invoice_id),payment=w.payments.find(p=>p.id===source.collected_payment_id),bill=w.bills.find(b=>b.id===source.bill_id);
  const collection=w.operations.find(o=>o.type==='collect_invoice'),billPayment=w.operations.find(o=>o.id===source.original_bill_operation_id);
  assert.equal(payment.status,'succeeded');assert.equal(invoice.amount_paid_minor,invoice.amount_minor);assert.equal(collection.status,'settled');
  assert.equal(billPayment.status,'settled');assert.equal(source.original_bill_receipt_id,billPayment.receipt_id);assert.equal(source.collection_receipt_id,payment.receipt_id);
  assert.ok(w.approvals.some(a=>a.status==='approved'&&a.operation_id===billPayment.id&&a.requested_by!==a.decided_by));
  for(const op of [collection,billPayment]){
    assert.ok(w.bankTransactions.some(t=>t.source_id===op.id&&t.receipt_id===op.receipt_id));assert.ok(w.journals.some(j=>j.id===op.journal_id&&j.source_id===op.id));
  }
  const credit=Math.floor(invoice.amount_minor*0.2),dispute=Math.floor(invoice.amount_minor*0.3),returned=Math.floor(bill.amount_minor*0.5);
  assert.equal(w.creditNotes[0].amount_minor,credit);assert.equal(w.disputes[0].amount_minor,dispute);assert.equal(w.disputes[0].status,'open');assert.equal(w.paymentReturns[0].amount_minor,returned);
  assert.equal(bill.amount_paid_minor,bill.amount_minor-returned);assert.equal(balance(w,'refunds-payable'),-credit);assert.equal(balance(w,'dispute-suspense'),dispute);
  assert.equal(summarize(w).cash_minor,w.bankTransactions[0].amount_minor+invoice.amount_minor-bill.amount_minor-dispute+returned);
  assert.equal(balance(w,'receivables'),w.invoices.reduce((sum,i)=>sum+i.amount_minor,0)-invoice.amount_minor);
  assert.equal(balance(w,'payables'),-w.bills.reduce((sum,b)=>sum+b.amount_minor,0)+bill.amount_minor-returned);
  assert.ok(w.documents.some(d=>d.type==='service-acceptance'&&d.invoice_id===invoice.id));
  assert.ok(w.messages.some(m=>m.source_refs.includes(source.original_bill_operation_id)));
  const history=recordsFor(w,'ledger','generation-event');assert.equal(history.length,w.generationHistory.length);
  assert.ok(history.some(entry=>entry.action.type==='decide_approval'));assert.ok(history.some(entry=>entry.events.some((event:any)=>event.type==='operation.settled')));
  assert.ok(w.disputes[0].evidence_due_at>w.now);balanced(w);
});

test('exception controls create a concrete locked loss and full return, then reconcile each journal without new bank effects',()=>{
  const w=createWorld({kind:'settlement-exceptions',orderCount:2,exceptionControls:{creditNotePercent:10,disputePercent:40,disputeStatus:'lost',returnedPaymentPercent:100,periodClosed:true}});
  const source=w.exceptionSources,payment=w.payments.find(p=>p.id===source.collected_payment_id),bill=w.bills.find(b=>b.id===source.bill_id);
  assert.equal(w.periodClosed,true);assert.equal(w.disputes[0].status,'lost');assert.equal(w.creditNotes[0].status,'satisfied');assert.equal(bill.status,'open');assert.equal(bill.amount_paid_minor,0);
  assert.equal(w.settledUnposted.length,4);assert.equal(balance(w,'refunds-payable'),0);assert.equal(balance(w,'chargeback-expense'),0);
  assert.equal(summarize(w).cash_minor,w.bankTransactions[0].amount_minor+payment.amount_minor-w.disputes[0].amount_minor);
  const bank=structuredClone(w.bankTransactions);act(w,{type:'reopen_period'});
  assert.deepEqual(w.bankTransactions,bank);assert.equal(w.settledUnposted.length,0);assert.equal(balance(w,'dispute-suspense'),0);assert.equal(balance(w,'refunds-payable'),0);
  assert.equal(balance(w,'chargeback-expense'),w.disputes[0].amount_minor-w.creditNotes[0].amount_minor);assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,0);balanced(w);
});

test('configured exception outcomes and source outages agree with the generated records',()=>{
  const w=createWorld({kind:'settlement-exceptions',orderCount:1,exceptionControls:{creditNotePercent:0,disputePercent:25,disputeStatus:'won',returnedPaymentPercent:0},initialFaults:[{system:'stripe',mode:'offline'},{system:'gmail',mode:'expired'}]});
  assert.equal(w.creditNotes.length,0);assert.equal(w.paymentReturns.length,0);assert.equal(w.disputes[0].status,'won');assert.equal(w.disputes[0].evidence.length,1);
  assert.equal(balance(w,'dispute-suspense'),0);assert.ok(w.operations.every(o=>o.status==='settled'));
  assert.equal(w.faults.stripe.mode,'offline');assert.equal(w.faults.gmail.mode,'expired');assert.ok(w.messages.every(m=>m.delivery_status==='delivered'));
  const noExceptions=createWorld({kind:'settlement-exceptions',orderCount:1,exceptionControls:{creditNotePercent:0,disputePercent:0,returnedPaymentPercent:0}});
  assert.equal(noExceptions.creditNotes.length,0);assert.equal(noExceptions.disputes.length,0);assert.equal(noExceptions.paymentReturns.length,0);
  assert.equal(noExceptions.invoices[0].status,'paid');assert.equal(noExceptions.bills[0].status,'paid');balanced(w);balanced(noExceptions);
  for(const kind of ['ticket-cancellation','saas-collections','supplier-fraud','period-close','treasury']){
    const ordinary=createWorld({kind,orderCount:2});assert.equal(ordinary.generationHistory,undefined);assert.equal(ordinary.creditNotes.length,0);assert.equal(ordinary.disputes.length,0);assert.equal(ordinary.paymentReturns.length,0);
  }
});

test('generator exception schema builds the selected family and rejects invalid or contradictory controls',()=>{
  const scenario={kind:'settlement-exceptions',name:'Subscriptions',description:'A settled subscription credit and returned supplier payment.',seed:123,orderCount:6,currency:'USD',startingCashMinor:500000,cancelEvent:false,initialFaults:[],limitations:['Synthetic normalized API subsets.'],exceptionControls:{creditNotePercent:15,disputePercent:0,disputeStatus:'open',returnedPaymentPercent:40,periodClosed:false}};
  const parsed=scenarioSchema.parse(scenario);const world=createWorld(parsed);
  assert.equal(world.creditNotes[0].amount_minor,Math.floor(world.payments[0].amount_minor*0.15));assert.equal(world.disputes.length,0);assert.equal(world.paymentReturns[0].amount_minor,Math.floor(world.bills[0].amount_minor*0.4));
  for(const controls of [{creditNotePercent:101},{disputePercent:-1},{returnedPaymentPercent:0.5},{disputeStatus:'pending'},{unimplementedRail:true}])assert.equal(scenarioSchema.safeParse({...scenario,exceptionControls:controls}).success,false);
  assert.throws(()=>createWorld({kind:'saas-collections',exceptionControls:{creditNotePercent:20}}),/require the settlement-exceptions/);
  assert.throws(()=>createWorld({kind:'settlement-exceptions',exceptionControls:{disputePercent:0,disputeStatus:'won'}}),/positive disputePercent/);
  assert.throws(()=>createWorld({kind:'settlement-exceptions',exceptionControls:{creditNotePercent:101}}),/integer between 0 and 100/);balanced(world);
});

test('a lost dispute covering many credit notes aggregates its journal and never poisons period reopening',()=>{
  for(const locked of [false,true]){
    const {w,payment,invoice}=collected();
    for(let index=0;index<100;index++)act(w,{type:'issue_credit_note',invoice_id:invoice.id,payment_id:payment.id,amount_minor:1,reason:'Small service credit',external_event_id:`many-credit-${index}`});
    if(locked)act(w,{type:'close_period'});
    const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:100,reason:'Issuer chargeback',external_event_id:'many-credit-dispute'}).dispute;
    assert.doesNotThrow(()=>act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'lost',external_event_id:'many-credit-loss'}));
    if(locked)assert.doesNotThrow(()=>act(w,{type:'reopen_period'}));
    const operation=w.operations.find(o=>o.type==='dispute_lost'),entry=w.journals.find(j=>j.id===operation.journal_id);
    assert.equal(entry.lines.length,2);assert.equal(entry.lines.find((line:any)=>line.account_id==='refunds-payable').debit_minor,100);
    assert.ok(w.creditNotes.every((note:any)=>note.amount_disputed_minor===1&&note.status==='satisfied'));
    assert.equal(balance(w,'refunds-payable'),0);assert.equal(balance(w,'dispute-suspense'),0);assert.equal(w.settledUnposted.length,0);balanced(w);
  }
});

test('seeded chargeback loss counters remain finite and cannot authorize a credit after the full capture was lost',()=>{
  const w=createWorld({kind:'settlement-exceptions',orderCount:1,exceptionControls:{creditNotePercent:0,disputePercent:100,disputeStatus:'lost',returnedPaymentPercent:0}}),payment=w.payments[0];
  assert.equal(payment.amount_disputed_lost_minor,payment.amount_minor);
  assert.ok(Number.isSafeInteger(payment.amount_disputed_lost_minor));
  unchangedOnError(w,{type:'issue_credit_note',invoice_id:payment.invoice_id,payment_id:payment.id,amount_minor:1,reason:'No unreturned collection remains',external_event_id:'forbidden-after-total-loss'},'credit_exceeds_collection',controller);
  const history=structuredClone({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts});
  for(const corrupted of [null,NaN,0]){
    w.payments[0].amount_disputed_lost_minor=corrupted;normalizeWorld(w);assert.equal(w.payments[0].amount_disputed_lost_minor,payment.amount_minor);
    assert.deepEqual({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts},history);
  }
  const tickets=createWorld({orderCount:1}),ticket=tickets.payments[0];
  const dispute=act(tickets,{type:'open_dispute',payment_id:ticket.id,amount_minor:ticket.amount_minor,reason:'Issuer debit',external_event_id:'ticket-counter-hold'}).dispute;
  act(tickets,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'lost',external_event_id:'ticket-counter-loss'});
  tickets.payments[0].amount_ticket_liability_discharged_minor=null;normalizeWorld(tickets);
  assert.equal(tickets.payments[0].amount_ticket_liability_discharged_minor,ticket.refundable_minor);balanced(w);balanced(tickets);
});

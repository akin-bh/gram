import { test, expect } from 'bun:test';
import {createWorld,applyAction,recordsFor,summarize,systemCatalog,scenarioCatalog,DomainError,normalizeWorld} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {scenarioSchema} from './agent.ts';

const agent:Actor={id:'agent-1',role:'agent'},controller:Actor={id:'controller-1',role:'controller'};
const act=(w:World,action:Action,actor=controller)=>applyAction(w,action,actor).result;
function balanced(w:World) {
  for(const journal of w.journals) expect(journal.lines.reduce((sum:number,line:any)=>sum+line.debit_minor-line.credit_minor,0),journal.id).toBe(0);
  expect(w.accounts.reduce((sum:number,a:any)=>sum+a.balance_minor,0)).toBe(0);
  expect(summarize(w).reconciliation.balanced).toBe(true);
}
function unchangedOnError(w:World,action:Action,code:string,actor=agent) {
  const before=structuredClone(w);
  expect(()=>act(w,action,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);
  expect(w).toStrictEqual(before);
}

test('all scenario seeds are deterministic, balanced and exposed through coherent catalog projections',()=>{
  expect(systemCatalog.length>=45).toBeTruthy();
  for(const scenario of scenarioCatalog) {
    const a=createWorld({kind:scenario.kind,seed:'repeatable',orderCount:20},'test');
    expect(a).toStrictEqual(createWorld({kind:scenario.kind,seed:'repeatable',orderCount:20},'test'));balanced(a);
    expect(summarize(a).reconciliation.bank_ledger_difference_minor).toBe(0);
    for(const system of systemCatalog)for(const feed of system.feeds)expect(Array.isArray(recordsFor(a,system.id,feed)),`${system.id}/${feed}`).toBeTruthy();
    expect(recordsFor(a,'netsuite','book-transaction')).toStrictEqual(recordsFor(a,'quickbooks','book-transaction'));
    expect(recordsFor(a,'gmail','message')).toStrictEqual(a.messages);
  }
  const a=createWorld({seed:1}),b=createWorld({seed:2});expect(a.orders[0].total_minor).not.toBe(b.orders[0].total_minor);
});

test('partial refund reserves funds then settles once across Stripe, bank, journal and Gmail',()=>{
  const w=createWorld({orderCount:2}),payment=w.payments[0],opening=summarize(w).cash_minor;
  const initialJournals=w.journals.length,amount=Math.floor(payment.refundable_minor/2);
  const outcome=applyAction(w,{type:'refund',payment_id:payment.id,amount_minor:amount},agent),result=outcome.result;
  expect(outcome.events[0].type).toBe('operation.created');expect(outcome.events[0].operation_type).toBe('refund');
  expect(result.refund.status).toBe('pending');expect(summarize(w).available_cash_minor).toBe(opening-amount);
  expect(summarize(w).cash_minor).toBe(opening);expect(w.journals.length).toBe(initialJournals);
  act(w,{type:'advance_time',hours:1});
  expect(w.refunds[0].status).toBe('succeeded');expect(w.payments[0].amount_refunded_minor).toBe(amount);
  expect(summarize(w).cash_minor).toBe(opening-amount);expect(summarize(w).reserved_minor).toBe(0);
  expect(w.journals.filter(j=>j.source_id===result.operation.id).length).toBe(1);
  expect(w.bankTransactions.filter(t=>t.source_id===result.operation.id).length).toBe(1);
  expect(w.messages.filter(m=>m.source_refs.includes(result.refund.id)).length).toBe(1);
  const after=structuredClone(w);act(w,{type:'advance_time',hours:24});
  expect(w.refunds).toStrictEqual(after.refunds);expect(w.bankTransactions).toStrictEqual(after.bankTransactions);expect(w.journals).toStrictEqual(after.journals);
  act(w,{type:'refund',payment_id:payment.id},agent);act(w,{type:'advance_time',hours:1});
  expect(w.payments[0].amount_refunded_minor).toBe(payment.refundable_minor);balanced(w);
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
  const waiting=act(w,request,agent);expect(waiting.status).toBe('awaiting_approval');expect(w.operations.length).toBe(0);
  const same=act(w,request,agent);expect(same.approval_id).toBe(waiting.approval_id);expect(w.approvals.length).toBe(1);
  unchangedOnError(w,{type:'decide_approval',approval_id:waiting.approval_id,decision:'approve'},'controller_required');
  unchangedOnError(w,{type:'decide_approval',approval_id:waiting.approval_id,decision:'approve'},'separate_controller_required',{id:agent.id,role:'controller'});
  const accepted=act(w,{type:'decide_approval',approval_id:waiting.approval_id,decision:'approve'});
  expect(accepted.operation.status).toBe('pending');expect(w.operations.length).toBe(1);
  unchangedOnError(w,{type:'decide_approval',approval_id:waiting.approval_id,decision:'approve'},'approval_already_decided',controller);
  act(w,{type:'advance_time',hours:1});expect(w.refunds[0].status).toBe('succeeded');balanced(w);
});

test('supplier fraud cannot change verified beneficiary; reservations prevent overdraft',()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:3,initialCashMinor:50000,approvalThresholdMinor:1000000});
  const bill=w.bills[0];
  expect(w.messages.some(m=>m.body.includes('attacker-beneficiary'))).toBeTruthy();
  unchangedOnError(w,{type:'pay_bill',bill_id:bill.id,beneficiary_id:'attacker-beneficiary-999',amount_minor:100},'unverified_beneficiary');
  act(w,{type:'pay_bill',bill_id:bill.id,amount_minor:10000},agent);
  expect(summarize(w).reserved_minor).toBe(10000);
  const target=w.bills.find(b=>b.amount_minor>40001);
  unchangedOnError(w,{type:'pay_bill',bill_id:target.id,amount_minor:40001},'insufficient_funds');
  act(w,{type:'advance_time',hours:1});expect(w.bills[0].amount_paid_minor).toBe(10000);balanced(w);
});

test('outage blocks settlement; recovery settles once and Gmail outbox flushes independently',()=>{
  const w=createWorld({orderCount:2});const refund=act(w,{type:'refund',payment_id:w.payments[0].id},agent);
  act(w,{type:'set_fault',system:'stripe',mode:'offline'});const blocked=act(w,{type:'advance_time',hours:2});
  expect(blocked.blocked.length).toBe(1);expect(w.refunds[0].status).toBe('pending');expect(w.operations[0].attempts).toBe(1);
  unchangedOnError(w,{type:'refund',payment_id:w.payments[1].id},'connection_unavailable');
  act(w,{type:'set_fault',system:'stripe',mode:'healthy'});act(w,{type:'set_fault',system:'gmail',mode:'expired'});
  act(w,{type:'advance_time',hours:1});expect(w.refunds[0].status).toBe('succeeded');
  const notice=w.messages.find(m=>m.source_refs.includes(refund.refund.id));expect(notice.delivery_status).toBe('queued');
  act(w,{type:'set_fault',system:'gmail',mode:'healthy'});act(w,{type:'advance_time',hours:1});
  expect(w.messages.find(m=>m.id===notice.id).delivery_status).toBe('delivered');expect(w.messages.filter(m=>m.id===notice.id).length).toBe(1);balanced(w);
});

test('locked period preserves provider settlement truth and posts once after reopen',()=>{
  const w=createWorld({kind:'period-close',orderCount:2}),invoice=w.invoices[0];
  const opening=summarize(w).cash_minor;
  const result=act(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:1000},agent);
  act(w,{type:'advance_time',hours:1});
  expect(w.invoices[0].amount_paid_minor).toBe(1000);expect(summarize(w).cash_minor).toBe(opening+1000);
  expect(summarize(w).reconciliation.bank_ledger_difference_minor).toBe(1000);expect(w.settledUnposted.length).toBe(1);
  expect(w.journals.filter(j=>j.source_id===result.operation.id).length).toBe(0);
  act(w,{type:'reopen_period'});expect(summarize(w).reconciliation.bank_ledger_difference_minor).toBe(0);
  expect(w.journals.filter(j=>j.source_id===result.operation.id).length).toBe(1);expect(w.settledUnposted.length).toBe(0);
  act(w,{type:'reopen_period'});expect(w.journals.filter(j=>j.source_id===result.operation.id).length).toBe(1);balanced(w);
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
  expect(w.payments[0].status).toBe('processing');expect(w.payments[0].invoice_id).toBe(invoice.id);
  unchangedOnError(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:invoice.amount_minor},'amount_exceeds_remaining');
  act(w,{type:'advance_time',hours:1});expect(w.invoices[0].status).toBe('partially_paid');expect(summarize(w).receivables_minor).toBe(initial-amount);
  expect(w.payments[0].status).toBe('succeeded');expect(w.payments[0].amount_minor).toBe(amount);
  act(w,{type:'collect_invoice',invoice_id:invoice.id},agent);act(w,{type:'advance_time',hours:1});expect(w.invoices[0].status).toBe('paid');expect(summarize(w).receivables_minor).toBe(0);balanced(w);
});

test('splitting a refund or bill payment cannot bypass the cumulative approval threshold',()=>{
  for(const kind of ['ticket-cancellation','supplier-fraud']) {
    const w=createWorld({kind,orderCount:2,approvalThresholdMinor:1000});
    const action=kind==='ticket-cancellation'?{type:'refund',payment_id:w.payments[0].id}:{type:'pay_bill',bill_id:w.bills[0].id};
    act(w,{...action,amount_minor:600},agent);
    const pendingReview=act(w,{...action,amount_minor:500},agent);
    expect(pendingReview.status).toBe('awaiting_approval');expect(w.operations.length).toBe(1);
    act(w,{type:'advance_time',hours:1});
    const settledReview=act(w,{...action,amount_minor:500},agent);
    expect(settledReview.approval_id).toBe(pendingReview.approval_id);expect(w.operations.length).toBe(1);
    act(w,{type:'decide_approval',approval_id:settledReview.approval_id,decision:'approve'});
    expect(w.operations.length).toBe(2);act(w,{type:'advance_time',hours:1});balanced(w);
  }
});

test('generated inputs retain context and apply only supported explicit simulation controls',()=>{
  const w=createWorld({kind:'ticket-cancellation',startingCashMinor:120000,description:'An arena event',narrative:'Bank access has failed.',cancelEvent:false,initialFaults:[{system:'bank',mode:'offline'}]});
  expect(w.description).toBe('An arena event');expect(w.documents.find(d=>d.id==='scenario-context').body.includes('Bank access has failed.')).toBeTruthy();
  expect(w.events[0].status).toBe('scheduled');expect(w.faults.bank.mode).toBe('offline');
  expect(w.bankTransactions[0].amount_minor).toBe(120000);
  act(w,{type:'set_fault',system:'bank',mode:'healthy'});
  unchangedOnError(w,{type:'refund',payment_id:w.payments[0].id},'event_not_cancelled');
  const cancelled=act(w,{type:'cancel_event',event_id:w.events[0].id});expect(cancelled.event.status).toBe('cancelled');
  expect(w.messages.some(m=>m.source_refs.includes(cancelled.document.id))).toBeTruthy();
  expect(()=>createWorld({currency:'EUR'})).toThrow(/Only USD/);
  expect(()=>createWorld({initialCashMinor:100,startingCashMinor:200})).toThrow(/disagree/);
  expect(()=>createWorld({initialFaults:[{system:'unknown',mode:'offline'}]})).toThrow(/Unknown initial/);
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
  expect(balance(w,'revenue')).toBe(initialRevenue+2000);expect(balance(w,'refunds-payable')).toBe(-2000);
  expect(balance(w,'receivables')).toBe(initialAR);expect(summarize(w).cash_minor).toBe(initialBank);
  const counts={journals:w.journals.length,messages:w.messages.length,notes:w.creditNotes.length};
  expect(act(w,issue).replayed).toBe(true);expect({journals:w.journals.length,messages:w.messages.length,notes:w.creditNotes.length}).toStrictEqual(counts);
  unchangedOnError(w,{...issue,amount_minor:1000},'external_event_conflict',controller);
  unchangedOnError(w,{...issue,external_event_id:'credit-too-much',amount_minor:3001},'credit_exceeds_collection',controller);
  unchangedOnError(w,{...issue,external_event_id:'credit-wrong-invoice',invoice_id:w.invoices[1].id},'credit_requires_collection',controller);
  act(w,{type:'refund',payment_id:payment.id,credit_note_id:note.id,amount_minor:500},agent);act(w,{type:'advance_time',hours:1});
  expect(balance(w,'refunds-payable')).toBe(-1500);expect(summarize(w).cash_minor).toBe(initialBank-500);
  act(w,{type:'refund',payment_id:payment.id,credit_note_id:note.id},agent);act(w,{type:'advance_time',hours:1});
  expect(w.creditNotes[0].status).toBe('refunded');expect(w.creditNotes[0].amount_refunded_minor).toBe(2000);expect(balance(w,'refunds-payable')).toBe(0);
  expect(w.invoices[0].amount_paid_minor).toBe(5000);expect(w.invoices[0].amount_credited_minor).toBe(2000);expect(balance(w,'receivables')).toBe(initialAR);
  expect(summarize(w).cash_minor).toBe(initialBank-2000);expect(recordsFor(w,'chargebee','credit-notes')[0].id).toBe(note.id);balanced(w);
});

test('credit issuance and refund settlements stay observable while accounting is locked or offline',()=>{
  const {w,payment,invoice}=collected(),initialBank=summarize(w).cash_minor,initialJournals=w.journals.length;
  act(w,{type:'close_period'});
  const note=act(w,{type:'issue_credit_note',invoice_id:invoice.id,payment_id:payment.id,amount_minor:1000,reason:'Service credit',external_event_id:'credit-locked'}).credit_note;
  act(w,{type:'refund',payment_id:payment.id,credit_note_id:note.id,amount_minor:1000},agent);act(w,{type:'advance_time',hours:1});
  expect(w.journals.length).toBe(initialJournals);expect(summarize(w).cash_minor).toBe(initialBank-1000);expect(w.settledUnposted.length).toBe(2);
  act(w,{type:'set_fault',system:'netsuite',mode:'offline'});act(w,{type:'reopen_period'});expect(w.settledUnposted.length).toBe(2);
  act(w,{type:'set_fault',system:'netsuite',mode:'healthy'});act(w,{type:'advance_time',hours:1});
  expect(w.settledUnposted.length).toBe(0);expect(w.journals.length).toBe(initialJournals+2);expect(balance(w,'refunds-payable')).toBe(0);
  expect(summarize(w).reconciliation.bank_ledger_difference_minor).toBe(0);balanced(w);
});

test('a dispute withdraws once, requires real source evidence and returns the same funds when won',()=>{
  const {w,payment}=collected(),initialBank=summarize(w).cash_minor;
  const opening={type:'open_dispute',payment_id:payment.id,amount_minor:3000,reason:'Customer alleges non-delivery',external_event_id:'dispute-open-1'};
  const dispute=act(w,opening).dispute;
  expect(summarize(w).cash_minor).toBe(initialBank-3000);expect(balance(w,'dispute-suspense')).toBe(3000);
  expect(act(w,opening).replayed).toBe(true);expect(summarize(w).cash_minor).toBe(initialBank-3000);
  unchangedOnError(w,{...opening,amount_minor:2000},'external_event_conflict',controller);
  unchangedOnError(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'premature-win'},'evidence_required',controller);
  unchangedOnError(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['invented-document'],statement:'Delivered'},'not_found');
  act(w,{type:'set_fault',system:'stripe',mode:'offline'});
  unchangedOnError(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Contract confirms service delivery'},'connection_unavailable');
  act(w,{type:'set_fault',system:'stripe',mode:'healthy'});
  act(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Contract confirms service delivery'},agent);
  expect(w.disputes[0].status).toBe('evidence_submitted');
  const outcome={type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'dispute-win-1'};act(w,outcome);
  expect(summarize(w).cash_minor).toBe(initialBank);expect(balance(w,'dispute-suspense')).toBe(0);expect(balance(w,'chargeback-expense')).toBe(0);
  const bankCount=w.bankTransactions.length;expect(act(w,outcome).replayed).toBe(true);expect(w.bankTransactions.length).toBe(bankCount);
  unchangedOnError(w,{...outcome,external_event_id:'duplicate-win'},'dispute_closed',controller);balanced(w);
});

test('lost dispute clears existing credit liability first and cannot double-debit a pending partial refund',()=>{
  const {w,payment,invoice}=collected(),before=summarize(w).cash_minor;
  const note=act(w,{type:'issue_credit_note',invoice_id:invoice.id,payment_id:payment.id,amount_minor:2000,reason:'SLA credit',external_event_id:'credit-before-dispute'}).credit_note;
  act(w,{type:'refund',payment_id:payment.id,credit_note_id:note.id,amount_minor:1000},agent);
  unchangedOnError(w,{type:'open_dispute',payment_id:payment.id,amount_minor:4001,reason:'Dispute',external_event_id:'overlapping-dispute'},'dispute_exceeds_remaining',controller);
  const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:4000,reason:'Issuer dispute',external_event_id:'dispute-over-credit'}).dispute;
  act(w,{type:'advance_time',hours:1});expect(w.refunds[0].status).toBe('pending');expect(w.operations.find(o=>o.type==='refund').last_error).toBe('unresolved_dispute');
  const bankRows=w.bankTransactions.length;
  act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'lost',external_event_id:'lost-over-credit'});
  expect(w.bankTransactions.length,'Losing an already withdrawn dispute must not debit cash again').toBe(bankRows);
  expect(balance(w,'dispute-suspense')).toBe(0);expect(balance(w,'chargeback-expense')).toBe(3000);expect(balance(w,'refunds-payable')).toBe(-1000);
  expect(w.creditNotes[0].amount_disputed_minor).toBe(1000);
  act(w,{type:'advance_time',hours:1});expect(w.refunds[0].status).toBe('succeeded');expect(balance(w,'refunds-payable')).toBe(0);
  expect(summarize(w).cash_minor).toBe(before-5000);expect(w.creditNotes[0].status).toBe('satisfied');expect(w.payments[0].amount_disputed_lost_minor).toBe(4000);
  unchangedOnError(w,{type:'refund',payment_id:payment.id,credit_note_id:note.id,amount_minor:1},'invalid_credit_note');balanced(w);
});

test('lost ticket chargeback discharges refundable liability and charges only the residual fee to expense',()=>{
  const w=createWorld({orderCount:1}),payment=w.payments[0],initialBank=summarize(w).cash_minor;
  const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:payment.amount_minor,reason:'Full issuer chargeback',external_event_id:'ticket-dispute'}).dispute;
  act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'lost',external_event_id:'ticket-lost'});
  expect(balance(w,'ticket-liability')).toBe(0);expect(balance(w,'chargeback-expense')).toBe(w.orders[0].fee_minor);expect(balance(w,'dispute-suspense')).toBe(0);
  expect(summarize(w).cash_minor).toBe(initialBank-payment.amount_minor);expect(summarize(w).refundable_minor).toBe(0);
  unchangedOnError(w,{type:'refund',payment_id:payment.id,amount_minor:1},'refund_exceeds_remaining');balanced(w);
});

test('bank returns preserve original settlement and reopen only the genuinely returned bill amount',()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:2}),bill=w.bills[0],initialBank=summarize(w).cash_minor,initialAP=balance(w,'payables');
  const paid=act(w,{type:'pay_bill',bill_id:bill.id,amount_minor:2000},agent);
  const returning={type:'return_bill_payment',operation_id:paid.operation.id,amount_minor:800,reason:'Beneficiary account closed',return_code:'R02',external_event_id:'bank-return-1'};
  unchangedOnError(w,returning,'return_requires_settlement',controller);act(w,{type:'advance_time',hours:1});
  const original=structuredClone(w.operations.find(o=>o.id===paid.operation.id));
  unchangedOnError(w,returning,'controller_required');const result=act(w,returning);
  expect(w.bills[0].amount_paid_minor).toBe(1200);expect(w.bills[0].status).toBe('partially_paid');expect(summarize(w).cash_minor).toBe(initialBank-1200);expect(balance(w,'payables')).toBe(initialAP+1200);
  const preserved=w.operations.find(o=>o.id===original.id);expect(preserved.status).toBe('settled');expect(preserved.receipt_id).toBe(original.receipt_id);expect(preserved.journal_id).toBe(original.journal_id);
  expect(result.payment_return.original_receipt_id).toBe(original.receipt_id);expect(result.payment_return.receipt_id).not.toBe(original.receipt_id);
  const count=w.bankTransactions.length;expect(act(w,returning).replayed).toBe(true);expect(w.bankTransactions.length).toBe(count);
  unchangedOnError(w,{...returning,external_event_id:'over-return',amount_minor:1201},'return_exceeds_payment',controller);
  act(w,{...returning,external_event_id:'return-rest',amount_minor:1200});expect(w.bills[0].status).toBe('open');expect(summarize(w).cash_minor).toBe(initialBank);
  expect(balance(w,'payables')).toBe(initialAP);expect(recordsFor(w,'mercury','payment-returns').length).toBe(2);balanced(w);
});

test('locked original settlement and bank return reconcile once after reopening, even if the connector is offline',()=>{
  const w=createWorld({kind:'period-close',orderCount:1}),initialAP=balance(w,'payables'),initialCash=summarize(w).cash_minor;
  const operation=act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:2000},agent).operation;act(w,{type:'advance_time',hours:1});
  act(w,{type:'set_fault',system:'mercury',mode:'offline'});
  act(w,{type:'return_bill_payment',operation_id:operation.id,amount_minor:500,reason:'Partial bank return',external_event_id:'locked-return'});
  expect(w.settledUnposted.length).toBe(2);expect(balance(w,'payables')).toBe(initialAP);expect(summarize(w).cash_minor).toBe(initialCash-1500);
  act(w,{type:'reopen_period'});expect(w.settledUnposted.length).toBe(0);expect(balance(w,'payables')).toBe(initialAP+1500);
  expect(summarize(w).reconciliation.bank_ledger_difference_minor).toBe(0);const journals=w.journals.length;act(w,{type:'reopen_period'});expect(w.journals.length).toBe(journals);balanced(w);
});

test('external cash withdrawal blocks an already reserved outgoing payment until liquidity actually recovers',()=>{
  const {w,payment}=collected('supplier-fraud',{initialCashMinor:0});
  const bill=act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:4000},agent).operation;
  const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:4000,reason:'Issuer inquiry',external_event_id:'liquidity-shock'}).dispute;
  act(w,{type:'advance_time',hours:1});expect(w.operations.find(o=>o.id===bill.id).status).toBe('pending');expect(summarize(w).cash_minor).toBe(1000);
  act(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Delivered as contracted'},agent);
  act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'liquidity-recovery'});
  act(w,{type:'advance_time',hours:1});expect(w.operations.find(o=>o.id===bill.id).status).toBe('settled');expect(summarize(w).cash_minor).toBe(1000);balanced(w);
});

test('additive world normalization preserves all historical balances and failed migration mutations remain atomic',()=>{
  const w=createWorld({orderCount:2});for(const key of ['creditNotes','disputes','paymentReturns','externalEvents'])delete w[key];
  w.accounts=w.accounts.filter(a=>!['refunds-payable','dispute-suspense','chargeback-expense'].includes(a.id));
  for(const payment of w.payments){delete payment.amount_disputed_lost_minor;delete payment.amount_ticket_liability_discharged_minor;}
  const before=structuredClone(w);
  unchangedOnError(w,{type:'open_dispute',payment_id:'missing',amount_minor:1,reason:'Invalid',external_event_id:'invalid-migration'},'not_found',controller);
  normalizeWorld(w);expect(w.bankTransactions).toStrictEqual(before.bankTransactions);expect(w.journals).toStrictEqual(before.journals);
  for(const account of before.accounts)expect(balance(w,account.id)).toBe(account.balance_minor);
  for(const id of ['refunds-payable','dispute-suspense','chargeback-expense'])expect(balance(w,id)).toBe(0);
  expect(recordsFor(w,'stripe','disputes')).toStrictEqual([]);expect(recordsFor(w,'ledger','credit-notes')).toStrictEqual([]);balanced(w);
});

test('dispute cash truth and reversal survive a locked period without replaying bank effects on reopen',()=>{
  const {w,payment}=collected(),initialBank=summarize(w).cash_minor,initialJournals=w.journals.length;
  act(w,{type:'close_period'});
  const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:2000,reason:'Issuer chargeback',external_event_id:'locked-hold'}).dispute;
  expect(summarize(w).cash_minor).toBe(initialBank-2000);expect(balance(w,'dispute-suspense')).toBe(0);expect(w.settledUnposted.length).toBe(1);
  act(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Accepted delivered service'},agent);
  act(w,{type:'set_fault',system:'stripe',mode:'offline'});
  act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'locked-release'});
  expect(summarize(w).cash_minor).toBe(initialBank);expect(w.settledUnposted.length).toBe(2);expect(w.journals.length).toBe(initialJournals);
  const bankTransactions=structuredClone(w.bankTransactions);act(w,{type:'reopen_period'});
  expect(w.journals.length).toBe(initialJournals+2);expect(balance(w,'dispute-suspense')).toBe(0);expect(w.settledUnposted.length).toBe(0);
  expect(w.bankTransactions).toStrictEqual(bankTransactions);expect(summarize(w).reconciliation.bank_ledger_difference_minor).toBe(0);balanced(w);
});

test('expired dispute evidence and resolved disputes cannot be rewritten by a worker',()=>{
  const {w,payment}=collected();
  const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:1000,reason:'Issuer dispute',evidence_due_hours:1,external_event_id:'deadline-hold'}).dispute;
  act(w,{type:'advance_time',hours:2});
  unchangedOnError(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Late response'},'evidence_deadline_passed');
  unchangedOnError(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'worker-forged-win'},'controller_required');
  act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'lost',external_event_id:'deadline-loss'});
  expect(balance(w,'dispute-suspense')).toBe(0);expect(balance(w,'chargeback-expense')).toBe(1000);
  unchangedOnError(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:['doc-contract-1'],statement:'Rewrite outcome'},'dispute_closed');balanced(w);
});

test('canonical mail preserves validated HTML and attachment bytes without allowing header injection',()=>{
  const w=createWorld({orderCount:1});
  const attachment={filename:'credit-receipt.txt',mimeType:'text/plain',data:Buffer.from('Receipt CN-1').toString('base64url')};
  const sent=act(w,{type:'send_email',to:['customer@example.test'],subject:'Credit receipt',html:'<p>Credit issued.</p>',attachments:[attachment]},agent);
  expect(sent.html).toBe('<p>Credit issued.</p>');expect(sent.body).toBe('Credit issued.');expect(sent.attachments[0].data).toBe(attachment.data);expect(sent.attachments[0].filename).toBe('credit-receipt.txt');
  const before=structuredClone(w);
  expect(()=>act(w,{type:'send_email',to:['customer@example.test'],subject:'Receipt\r\nBcc: outsider@example.test',body:'Hi'},agent)).toThrow(/single-line/);
  expect(w).toStrictEqual(before);
});

test('generated settlement exception history contains actual original settlements, independent approvals and linked source records',()=>{
  const input={kind:'settlement-exceptions',seed:19,orderCount:3,approvalThresholdMinor:1};
  const w=createWorld(input,'exception-world');expect(w).toStrictEqual(createWorld(input,'exception-world'));
  const source=w.exceptionSources,invoice=w.invoices.find(i=>i.id===source.invoice_id),payment=w.payments.find(p=>p.id===source.collected_payment_id),bill=w.bills.find(b=>b.id===source.bill_id);
  const collection=w.operations.find(o=>o.type==='collect_invoice'),billPayment=w.operations.find(o=>o.id===source.original_bill_operation_id);
  expect(payment.status).toBe('succeeded');expect(invoice.amount_paid_minor).toBe(invoice.amount_minor);expect(collection.status).toBe('settled');
  expect(billPayment.status).toBe('settled');expect(source.original_bill_receipt_id).toBe(billPayment.receipt_id);expect(source.collection_receipt_id).toBe(payment.receipt_id);
  expect(w.approvals.some(a=>a.status==='approved'&&a.operation_id===billPayment.id&&a.requested_by!==a.decided_by)).toBeTruthy();
  for(const op of [collection,billPayment]){
    expect(w.bankTransactions.some(t=>t.source_id===op.id&&t.receipt_id===op.receipt_id)).toBeTruthy();expect(w.journals.some(j=>j.id===op.journal_id&&j.source_id===op.id)).toBeTruthy();
  }
  const credit=Math.floor(invoice.amount_minor*0.2),dispute=Math.floor(invoice.amount_minor*0.3),returned=Math.floor(bill.amount_minor*0.5);
  expect(w.creditNotes[0].amount_minor).toBe(credit);expect(w.disputes[0].amount_minor).toBe(dispute);expect(w.disputes[0].status).toBe('open');expect(w.paymentReturns[0].amount_minor).toBe(returned);
  expect(bill.amount_paid_minor).toBe(bill.amount_minor-returned);expect(balance(w,'refunds-payable')).toBe(-credit);expect(balance(w,'dispute-suspense')).toBe(dispute);
  expect(summarize(w).cash_minor).toBe(w.bankTransactions[0].amount_minor+invoice.amount_minor-bill.amount_minor-dispute+returned);
  expect(balance(w,'receivables')).toBe(w.invoices.reduce((sum,i)=>sum+i.amount_minor,0)-invoice.amount_minor);
  expect(balance(w,'payables')).toBe(-w.bills.reduce((sum,b)=>sum+b.amount_minor,0)+bill.amount_minor-returned);
  expect(w.documents.some(d=>d.type==='service-acceptance'&&d.invoice_id===invoice.id)).toBeTruthy();
  expect(w.messages.some(m=>m.source_refs.includes(source.original_bill_operation_id))).toBeTruthy();
  const history=recordsFor(w,'ledger','generation-event');expect(history.length).toBe(w.generationHistory.length);
  expect(history.some(entry=>entry.action.type==='decide_approval')).toBeTruthy();expect(history.some(entry=>entry.events.some((event:any)=>event.type==='operation.settled'))).toBeTruthy();
  expect(w.disputes[0].evidence_due_at>w.now).toBeTruthy();balanced(w);
});

test('exception controls create a concrete locked loss and full return, then reconcile each journal without new bank effects',()=>{
  const w=createWorld({kind:'settlement-exceptions',orderCount:2,exceptionControls:{creditNotePercent:10,disputePercent:40,disputeStatus:'lost',returnedPaymentPercent:100,periodClosed:true}});
  const source=w.exceptionSources,payment=w.payments.find(p=>p.id===source.collected_payment_id),bill=w.bills.find(b=>b.id===source.bill_id);
  expect(w.periodClosed).toBe(true);expect(w.disputes[0].status).toBe('lost');expect(w.creditNotes[0].status).toBe('satisfied');expect(bill.status).toBe('open');expect(bill.amount_paid_minor).toBe(0);
  expect(w.settledUnposted.length).toBe(4);expect(balance(w,'refunds-payable')).toBe(0);expect(balance(w,'chargeback-expense')).toBe(0);
  expect(summarize(w).cash_minor).toBe(w.bankTransactions[0].amount_minor+payment.amount_minor-w.disputes[0].amount_minor);
  const bank=structuredClone(w.bankTransactions);act(w,{type:'reopen_period'});
  expect(w.bankTransactions).toStrictEqual(bank);expect(w.settledUnposted.length).toBe(0);expect(balance(w,'dispute-suspense')).toBe(0);expect(balance(w,'refunds-payable')).toBe(0);
  expect(balance(w,'chargeback-expense')).toBe(w.disputes[0].amount_minor-w.creditNotes[0].amount_minor);expect(summarize(w).reconciliation.bank_ledger_difference_minor).toBe(0);balanced(w);
});

test('configured exception outcomes and source outages agree with the generated records',()=>{
  const w=createWorld({kind:'settlement-exceptions',orderCount:1,exceptionControls:{creditNotePercent:0,disputePercent:25,disputeStatus:'won',returnedPaymentPercent:0},initialFaults:[{system:'stripe',mode:'offline'},{system:'gmail',mode:'expired'}]});
  expect(w.creditNotes.length).toBe(0);expect(w.paymentReturns.length).toBe(0);expect(w.disputes[0].status).toBe('won');expect(w.disputes[0].evidence.length).toBe(1);
  expect(balance(w,'dispute-suspense')).toBe(0);expect(w.operations.every(o=>o.status==='settled')).toBeTruthy();
  expect(w.faults.stripe.mode).toBe('offline');expect(w.faults.gmail.mode).toBe('expired');expect(w.messages.every(m=>m.delivery_status==='delivered')).toBeTruthy();
  const noExceptions=createWorld({kind:'settlement-exceptions',orderCount:1,exceptionControls:{creditNotePercent:0,disputePercent:0,returnedPaymentPercent:0}});
  expect(noExceptions.creditNotes.length).toBe(0);expect(noExceptions.disputes.length).toBe(0);expect(noExceptions.paymentReturns.length).toBe(0);
  expect(noExceptions.invoices[0].status).toBe('paid');expect(noExceptions.bills[0].status).toBe('paid');balanced(w);balanced(noExceptions);
  for(const kind of ['ticket-cancellation','saas-collections','supplier-fraud','period-close','treasury']){
    const ordinary=createWorld({kind,orderCount:2});expect(ordinary.generationHistory).toBeUndefined();expect(ordinary.creditNotes.length).toBe(0);expect(ordinary.disputes.length).toBe(0);expect(ordinary.paymentReturns.length).toBe(0);
  }
});

test('generator exception schema builds the selected family and rejects invalid or contradictory controls',()=>{
  const scenario={kind:'settlement-exceptions',name:'Subscriptions',description:'A settled subscription credit and returned supplier payment.',seed:123,orderCount:6,currency:'USD',startingCashMinor:500000,cancelEvent:false,initialFaults:[],limitations:['Synthetic normalized API subsets.'],exceptionControls:{creditNotePercent:15,disputePercent:0,disputeStatus:'open',returnedPaymentPercent:40,periodClosed:false}};
  const parsed=scenarioSchema.parse(scenario);const world=createWorld(parsed);
  expect(world.creditNotes[0].amount_minor).toBe(Math.floor(world.payments[0].amount_minor*0.15));expect(world.disputes.length).toBe(0);expect(world.paymentReturns[0].amount_minor).toBe(Math.floor(world.bills[0].amount_minor*0.4));
  for(const controls of [{creditNotePercent:101},{disputePercent:-1},{returnedPaymentPercent:0.5},{disputeStatus:'pending'},{unimplementedRail:true}])expect(scenarioSchema.safeParse({...scenario,exceptionControls:controls}).success).toBe(false);
  expect(()=>createWorld({kind:'saas-collections',exceptionControls:{creditNotePercent:20}})).toThrow(/require the settlement-exceptions/);
  expect(()=>createWorld({kind:'settlement-exceptions',exceptionControls:{disputePercent:0,disputeStatus:'won'}})).toThrow(/positive disputePercent/);
  expect(()=>createWorld({kind:'settlement-exceptions',exceptionControls:{creditNotePercent:101}})).toThrow(/integer between 0 and 100/);balanced(world);
});

test('a lost dispute covering many credit notes aggregates its journal and never poisons period reopening',()=>{
  for(const locked of [false,true]){
    const {w,payment,invoice}=collected();
    for(let index=0;index<100;index++)act(w,{type:'issue_credit_note',invoice_id:invoice.id,payment_id:payment.id,amount_minor:1,reason:'Small service credit',external_event_id:`many-credit-${index}`});
    if(locked)act(w,{type:'close_period'});
    const dispute=act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:100,reason:'Issuer chargeback',external_event_id:'many-credit-dispute'}).dispute;
    expect(()=>act(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'lost',external_event_id:'many-credit-loss'})).not.toThrow();
    if(locked)expect(()=>act(w,{type:'reopen_period'})).not.toThrow();
    const operation=w.operations.find(o=>o.type==='dispute_lost'),entry=w.journals.find(j=>j.id===operation.journal_id);
    expect(entry.lines.length).toBe(2);expect(entry.lines.find((line:any)=>line.account_id==='refunds-payable').debit_minor).toBe(100);
    expect(w.creditNotes.every((note:any)=>note.amount_disputed_minor===1&&note.status==='satisfied')).toBeTruthy();
    expect(balance(w,'refunds-payable')).toBe(0);expect(balance(w,'dispute-suspense')).toBe(0);expect(w.settledUnposted.length).toBe(0);balanced(w);
  }
});

test('seeded chargeback loss counters remain finite and cannot authorize a credit after the full capture was lost',()=>{
  const w=createWorld({kind:'settlement-exceptions',orderCount:1,exceptionControls:{creditNotePercent:0,disputePercent:100,disputeStatus:'lost',returnedPaymentPercent:0}}),payment=w.payments[0];
  expect(payment.amount_disputed_lost_minor).toBe(payment.amount_minor);
  expect(Number.isSafeInteger(payment.amount_disputed_lost_minor)).toBeTruthy();
  unchangedOnError(w,{type:'issue_credit_note',invoice_id:payment.invoice_id,payment_id:payment.id,amount_minor:1,reason:'No unreturned collection remains',external_event_id:'forbidden-after-total-loss'},'credit_exceeds_collection',controller);
  const history=structuredClone({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts});
  for(const corrupted of [null,NaN,0]){
    w.payments[0].amount_disputed_lost_minor=corrupted;normalizeWorld(w);expect(w.payments[0].amount_disputed_lost_minor).toBe(payment.amount_minor);
    expect({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts}).toStrictEqual(history);
  }
  const tickets=createWorld({orderCount:1}),ticket=tickets.payments[0];
  const dispute=act(tickets,{type:'open_dispute',payment_id:ticket.id,amount_minor:ticket.amount_minor,reason:'Issuer debit',external_event_id:'ticket-counter-hold'}).dispute;
  act(tickets,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'lost',external_event_id:'ticket-counter-loss'});
  tickets.payments[0].amount_ticket_liability_discharged_minor=null;normalizeWorld(tickets);
  expect(tickets.payments[0].amount_ticket_liability_discharged_minor).toBe(ticket.refundable_minor);balanced(w);balanced(tickets);
});

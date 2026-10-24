import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {applyAction,createWorld,summarize,type World} from './world.ts';
import {processorBalance} from './ticketing.ts';
const controller={id:'ticket-controller',role:'controller' as const},operator={id:'ticket-operator',role:'operator' as const};
const opening='2026-10-24T09:00:00.000Z';
function fixture(threshold=1e12){return createWorld({kind:'ticket-cancellation',name:'Tickets',startingCashMinor:100000,approvalThresholdMinor:threshold,blueprint:{version:1,opening_at:opening,as_of:'2026-10-24T12:00:00.000Z',customers:[{ref:'fan',name:'Fan',email:'fan@tickets.test'}],vendors:[{ref:'promoter',name:'Promoter',email:'ops@tickets.test'}],ticket_events:[{ref:'show',name:'Autumn',promoter_ref:'promoter',starts_at:'2026-10-31T19:00:00.000Z',agreement_reference:'SIGNED-AUTUMN',agreement_signed_at:opening}],ticket_orders:[{ref:'sale',event_ref:'show',customer_ref:'fan',source_order_id:'ORDER-AUTUMN',ordered_at:'2026-10-24T09:10:00.000Z',quantity:2,face_minor:10000,tax_minor:900,fee_minor:1500}],ticket_payment_outcomes:[{ref:'capture',order_ref:'sale',source_payment_id:'CAPTURE-AUTUMN',outcome:'captured',amount_minor:12400,occurred_at:'2026-10-24T09:20:00.000Z',processor_fee_minor:400,available_at:'2026-10-24T09:30:00.000Z'}],ticket_cancellations:[{ref:'cancellation',event_ref:'show',source_notice_id:'NOTICE-AUTUMN',cancelled_at:'2026-10-24T10:00:00.000Z',reason:'Promoter cancellation'}]}} as any,'ticket-cash-proof');}
const act=(w:World,input:any,actor=controller as any)=>applyAction(w,input,actor).result;
const balance=(w:World,id:string)=>w.accounts.find(row=>row.id===id)!.balance_minor;
const fault=(w:World,system:string,mode='offline')=>act(w,{type:'set_fault',system,mode});
const tick=(w:World)=>act(w,{type:'advance_time',hours:1});
function rejected(w:World,input:any,code:string,actor:any=controller){const before=structuredClone(w);assert.throws(()=>act(w,input,actor),(e:any)=>e.code===code);assert.deepEqual(w,before);}
function movement(w:World,type:'payout'|'topup',amount:number,source:string){return {type:`record_processor_${type}`,[`source_${type}_id`]:source,source_bank_transaction_id:`BANK-${source}`,amount_minor:amount,[type==='payout'?'paid_at':'posted_at']:w.now,external_event_id:`source-${source}`};}

test('processor refund keeps independent Stripe, bank, ledger and mail outage boundaries with one receipt and late journal',()=>{
 const w=fixture(5000),bank=structuredClone(w.bankTransactions),request=act(w,{type:'refund',payment_id:w.payments[0].id,amount_minor:6000},operator);assert.equal(request.status,'awaiting_approval');assert.equal(processorBalance(w).reserved_minor,0);
 act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'});const id=w.refunds[0].operation_id;assert.equal(processorBalance(w).reserved_minor,6000);assert.equal(summarize(w).reserved_minor,0);assert.equal(summarize(w).available_cash_minor,100000);
 for(const system of ['stripe','bank','ledger','gmail'])fault(w,system);tick(w);assert.equal(w.operations.find(row=>row.id===id).status,'pending');assert.equal(w.refunds[0].receipt_id,undefined);assert.equal(processorBalance(w).available_minor,12000);assert.equal(processorBalance(w).reserved_minor,6000);
 fault(w,'stripe','healthy');tick(w);const op=w.operations.find(row=>row.id===id);assert.equal(op.status,'settled');assert.equal(op.accounting_status,'pending_posting');assert.ok(op.receipt_id);assert.equal(w.refunds[0].status,'succeeded');assert.equal(processorBalance(w).available_minor,6000);assert.equal(processorBalance(w).reserved_minor,0);assert.deepEqual(w.bankTransactions,bank);assert.equal(balance(w,'cash-processor'),12000);assert.equal(balance(w,'ticket-liability'),-10900);
 const notice=w.messages.find(row=>row.source_refs?.includes(w.refunds[0].id))!;assert.equal(notice.delivery_status,'queued');const receipt=op.receipt_id;
 fault(w,'gmail','healthy');tick(w);assert.equal(w.messages.find(row=>row.id===notice.id).delivery_status,'delivered');assert.equal(w.operations.find(row=>row.id===id).journal_id,undefined);
 fault(w,'ledger','healthy');tick(w);const posted=w.operations.find(row=>row.id===id),journal=w.journals.find(row=>row.id===posted.journal_id);assert.ok(journal.posted_at>posted.settled_at);assert.equal(posted.receipt_id,receipt);assert.equal(balance(w,'cash-processor'),6000);assert.equal(balance(w,'ticket-liability'),-4900);assert.equal(balance(w,'processor-fees'),400);assert.equal(summarize(w).reconciliation.balanced,true);
 const history=structuredClone({processor:w.processorTransactions,journals:w.journals,messages:w.messages,bank:w.bankTransactions});tick(w);assert.deepEqual({processor:w.processorTransactions,journals:w.journals,messages:w.messages,bank:w.bankTransactions},history);
});

test('processor refund reservations constrain payout without reserving unrelated bank cash',()=>{
 const w=fixture();act(w,{type:'refund',payment_id:w.payments[0].id,amount_minor:10900},operator);assert.equal(processorBalance(w).spendable_minor,1100);assert.equal(summarize(w).reserved_minor,0);
 const denied=movement(w,'payout',1101,'TOO-MUCH');const before=structuredClone(w);assert.throws(()=>act(w,denied));assert.deepEqual(w,before);
 act(w,movement(w,'payout',1100,'EARNED-FEES'));assert.equal(processorBalance(w).available_minor,10900);assert.equal(processorBalance(w).spendable_minor,0);assert.equal(summarize(w).cash_minor,101100);
 act(w,movement(w,'topup',500,'TOPUP'));assert.equal(summarize(w).cash_minor,100600);assert.equal(processorBalance(w).available_minor,11400);assert.equal(processorBalance(w).reserved_minor,10900);
 tick(w);assert.equal(processorBalance(w).total_minor,500);assert.equal(balance(w,'ticket-liability'),0);assert.equal(balance(w,'revenue'),-1500);assert.equal(balance(w,'processor-fees'),400);assert.equal(summarize(w).cash_minor,100600);assert.equal(summarize(w).reconciliation.balanced,true);
});

test('bank-funded legacy refunds share bank reservations with topups but never consume processor funds',()=>{
 const w=createWorld({kind:'ticket-cancellation',name:'Legacy',orderCount:2,seed:1,cancelEvent:true,approvalThresholdMinor:1e12,startingCashMinor:1000},'legacy-reservation');const p=w.payments.find(row=>row.status==='succeeded')!,cash=summarize(w).cash_minor;
 act(w,{type:'refund',payment_id:p.id,amount_minor:100},operator);assert.equal(summarize(w).reserved_minor,100);assert.equal(processorBalance(w).reserved_minor,0);
 const before=structuredClone(w);assert.throws(()=>act(w,movement(w,'topup',cash-99,'RESERVED')));assert.deepEqual(w,before);
 act(w,movement(w,'topup',cash-100,'AVAILABLE'));assert.equal(summarize(w).cash_minor,100);assert.equal(processorBalance(w).available_minor,cash-100);tick(w);assert.equal(summarize(w).cash_minor,0);assert.equal(processorBalance(w).available_minor,cash-100);assert.equal(w.refunds[0].cash_account_id,undefined);assert.equal(summarize(w).reconciliation.balanced,true);
});

test('new payment disputes withdraw and restore processor funds while retaining bank source and separate cash reservations',()=>{
 const w=fixture(),p=w.payments[0],bank=structuredClone(w.bankTransactions),applied=applyAction(w,{type:'open_dispute',payment_id:p.id,amount_minor:3000,reason:'requested_by_customer',external_event_id:'SOURCE-DISPUTE'},controller),opened=applied.result;const settled=applied.events.find(row=>row.type==='operation.settled')!;assert.equal(settled.cash_effect_minor,0);assert.equal(settled.processor_cash_effect_minor,-3000);assert.ok(opened.operation.processor_transaction_id);assert.equal(w.processorTransactions.find((row:any)=>row.id===opened.operation.processor_transaction_id).operation_id,opened.operation.id);assert.equal(processorBalance(w).available_minor,9000);assert.equal(balance(w,'cash-processor'),9000);assert.equal(balance(w,'dispute-suspense'),3000);assert.deepEqual(w.bankTransactions,bank);
 rejected(w,{type:'refund',payment_id:p.id,amount_minor:100},'unresolved_dispute',operator);
 act(w,{type:'submit_dispute_evidence',dispute_id:opened.dispute.id,document_ids:[w.events[0].document_id],statement:'The captured order and signed terms identify the original payment.'},operator);
 act(w,{type:'resolve_dispute',dispute_id:opened.dispute.id,outcome:'won',external_event_id:'SOURCE-WIN'});assert.equal(processorBalance(w).available_minor,12000);assert.equal(balance(w,'dispute-suspense'),0);assert.equal(balance(w,'cash-processor'),12000);assert.deepEqual(w.bankTransactions,bank);assert.deepEqual(w.processorTransactions.map((row:any)=>row.type),['charge','dispute_hold','dispute_release']);
 const again=act(w,{type:'open_dispute',payment_id:p.id,amount_minor:2000,reason:'product_not_received',external_event_id:'SOURCE-SECOND-DISPUTE'});act(w,{type:'resolve_dispute',dispute_id:again.dispute.id,outcome:'lost',external_event_id:'SOURCE-LOSS'});assert.equal(processorBalance(w).available_minor,10000);assert.equal(w.payments[0].amount_ticket_liability_discharged_minor,2000);assert.equal(balance(w,'ticket-liability'),-8900);assert.deepEqual(w.bankTransactions,bank);
 act(w,{type:'refund',payment_id:p.id,amount_minor:8900},operator);tick(w);assert.equal(processorBalance(w).available_minor,1100);assert.equal(balance(w,'ticket-liability'),0);assert.equal(balance(w,'dispute-suspense'),0);assert.equal(summarize(w).reconciliation.balanced,true);
});

test('external processor loss can create a real shortfall without fabricating a bank debit or moving refunds to bank funds',()=>{
 const w=fixture(),p=w.payments[0];act(w,movement(w,'payout',12000,'PAID-OUT'));const bank=structuredClone(w.bankTransactions);
 const opened=act(w,{type:'open_dispute',payment_id:p.id,amount_minor:2000,reason:'product_not_received',external_event_id:'POST-PAYOUT-DISPUTE'});assert.equal(processorBalance(w).available_minor,-2000);assert.deepEqual(w.bankTransactions,bank);
 act(w,{type:'resolve_dispute',dispute_id:opened.dispute.id,outcome:'lost',external_event_id:'POST-PAYOUT-LOSS'});rejected(w,{type:'refund',payment_id:p.id,amount_minor:100},'insufficient_funds',operator);assert.equal(summarize(w).cash_minor,112000);
 act(w,movement(w,'topup',10900,'REFUND-FUNDING'));assert.equal(processorBalance(w).available_minor,8900);act(w,{type:'refund',payment_id:p.id,amount_minor:8900},operator);tick(w);assert.equal(processorBalance(w).available_minor,0);assert.equal(summarize(w).cash_minor,101100);assert.equal(balance(w,'ticket-liability'),0);assert.equal(summarize(w).reconciliation.balanced,true);
});

test('operator cannot inject a refund funding pool or redirect the original captured route',()=>{
 const w=fixture(),p=w.payments[0];for(const patch of [{cash_account_id:'cash-bank'},{processor_cash_effect_minor:0},{original_route:'different-card'}])rejected(w,{type:'refund',payment_id:p.id,amount_minor:100,...patch},'invalid_refund_fields',operator);
 rejected(w,{type:'refund',payment_id:p.id,amount_minor:100,route:'different-card'},'invalid_beneficiary',operator);assert.equal(w.refunds.length,0);
});

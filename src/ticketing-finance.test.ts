import {test,expect} from 'bun:test';
import {applyAction,createWorld,summarize,type World} from './world.ts';
import {processorBalance} from './ticketing.ts';
const controller={id:'ticket-controller',role:'controller' as const},operator={id:'ticket-operator',role:'operator' as const};
const opening='2026-10-24T09:00:00.000Z';
function fixture(threshold=1e12){return createWorld({kind:'ticket-cancellation',name:'Tickets',startingCashMinor:100000,approvalThresholdMinor:threshold,blueprint:{version:1,opening_at:opening,as_of:'2026-10-24T12:00:00.000Z',customers:[{ref:'fan',name:'Fan',email:'fan@tickets.test'}],vendors:[{ref:'promoter',name:'Promoter',email:'ops@tickets.test'}],ticket_events:[{ref:'show',name:'Autumn',promoter_ref:'promoter',starts_at:'2026-10-31T19:00:00.000Z',agreement_reference:'SIGNED-AUTUMN',agreement_signed_at:opening}],ticket_orders:[{ref:'sale',event_ref:'show',customer_ref:'fan',source_order_id:'ORDER-AUTUMN',ordered_at:'2026-10-24T09:10:00.000Z',quantity:2,face_minor:10000,tax_minor:900,fee_minor:1500}],ticket_payment_outcomes:[{ref:'capture',order_ref:'sale',source_payment_id:'CAPTURE-AUTUMN',outcome:'captured',amount_minor:12400,occurred_at:'2026-10-24T09:20:00.000Z',processor_fee_minor:400,available_at:'2026-10-24T09:30:00.000Z'}],ticket_cancellations:[{ref:'cancellation',event_ref:'show',source_notice_id:'NOTICE-AUTUMN',cancelled_at:'2026-10-24T10:00:00.000Z',reason:'Promoter cancellation'}]}} as any,'ticket-cash-proof');}
const act=(w:World,input:any,actor=controller as any)=>applyAction(w,input,actor).result;
const balance=(w:World,id:string)=>w.accounts.find(row=>row.id===id)!.balance_minor;
const fault=(w:World,system:string,mode='offline')=>act(w,{type:'set_fault',system,mode});
const tick=(w:World)=>act(w,{type:'advance_time',hours:1});
function rejected(w:World,input:any,code:string,actor:any=controller){const before=structuredClone(w);expect(()=>act(w,input,actor)).toThrowSatisfying((e:any)=>e.code===code);expect(w).toStrictEqual(before);}
function movement(w:World,type:'payout'|'topup',amount:number,source:string){return {type:`record_processor_${type}`,[`source_${type}_id`]:source,source_bank_transaction_id:`BANK-${source}`,amount_minor:amount,[type==='payout'?'paid_at':'posted_at']:w.now,external_event_id:`source-${source}`};}

test('processor refund keeps independent Stripe, bank, ledger and mail outage boundaries with one receipt and late journal',()=>{
 const w=fixture(5000),bank=structuredClone(w.bankTransactions),request=act(w,{type:'refund',payment_id:w.payments[0].id,amount_minor:6000},operator);expect(request.status).toBe('awaiting_approval');expect(processorBalance(w).reserved_minor).toBe(0);
 act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'});const id=w.refunds[0].operation_id;expect(processorBalance(w).reserved_minor).toBe(6000);expect(summarize(w).reserved_minor).toBe(0);expect(summarize(w).available_cash_minor).toBe(100000);
 for(const system of ['stripe','bank','ledger','gmail'])fault(w,system);tick(w);expect(w.operations.find(row=>row.id===id).status).toBe('pending');expect(w.refunds[0].receipt_id).toBeUndefined();expect(processorBalance(w).available_minor).toBe(12000);expect(processorBalance(w).reserved_minor).toBe(6000);
 fault(w,'stripe','healthy');tick(w);const op=w.operations.find(row=>row.id===id);expect(op.status).toBe('settled');expect(op.accounting_status).toBe('pending_posting');expect(op.receipt_id).toBeTruthy();expect(w.refunds[0].status).toBe('succeeded');expect(processorBalance(w).available_minor).toBe(6000);expect(processorBalance(w).reserved_minor).toBe(0);expect(w.bankTransactions).toStrictEqual(bank);expect(balance(w,'cash-processor')).toBe(12000);expect(balance(w,'ticket-liability')).toBe(-10900);
 const notice=w.messages.find(row=>row.source_refs?.includes(w.refunds[0].id))!;expect(notice.delivery_status).toBe('queued');const receipt=op.receipt_id;
 fault(w,'gmail','healthy');tick(w);expect(w.messages.find(row=>row.id===notice.id).delivery_status).toBe('delivered');expect(w.operations.find(row=>row.id===id).journal_id).toBeUndefined();
 fault(w,'ledger','healthy');tick(w);const posted=w.operations.find(row=>row.id===id),journal=w.journals.find(row=>row.id===posted.journal_id);expect(journal.posted_at>posted.settled_at).toBeTruthy();expect(posted.receipt_id).toBe(receipt);expect(balance(w,'cash-processor')).toBe(6000);expect(balance(w,'ticket-liability')).toBe(-4900);expect(balance(w,'processor-fees')).toBe(400);expect(summarize(w).reconciliation.balanced).toBe(true);
 const history=structuredClone({processor:w.processorTransactions,journals:w.journals,messages:w.messages,bank:w.bankTransactions});tick(w);expect({processor:w.processorTransactions,journals:w.journals,messages:w.messages,bank:w.bankTransactions}).toStrictEqual(history);
});

test('processor refund reservations constrain payout without reserving unrelated bank cash',()=>{
 const w=fixture();act(w,{type:'refund',payment_id:w.payments[0].id,amount_minor:10900},operator);expect(processorBalance(w).spendable_minor).toBe(1100);expect(summarize(w).reserved_minor).toBe(0);
 const denied=movement(w,'payout',1101,'TOO-MUCH');const before=structuredClone(w);expect(()=>act(w,denied)).toThrow();expect(w).toStrictEqual(before);
 act(w,movement(w,'payout',1100,'EARNED-FEES'));expect(processorBalance(w).available_minor).toBe(10900);expect(processorBalance(w).spendable_minor).toBe(0);expect(summarize(w).cash_minor).toBe(101100);
 act(w,movement(w,'topup',500,'TOPUP'));expect(summarize(w).cash_minor).toBe(100600);expect(processorBalance(w).available_minor).toBe(11400);expect(processorBalance(w).reserved_minor).toBe(10900);
 tick(w);expect(processorBalance(w).total_minor).toBe(500);expect(balance(w,'ticket-liability')).toBe(0);expect(balance(w,'revenue')).toBe(-1500);expect(balance(w,'processor-fees')).toBe(400);expect(summarize(w).cash_minor).toBe(100600);expect(summarize(w).reconciliation.balanced).toBe(true);
});

test('bank-funded legacy refunds share bank reservations with topups but never consume processor funds',()=>{
 const w=createWorld({kind:'ticket-cancellation',name:'Legacy',orderCount:2,seed:1,cancelEvent:true,approvalThresholdMinor:1e12,startingCashMinor:1000},'legacy-reservation');const p=w.payments.find(row=>row.status==='succeeded')!,cash=summarize(w).cash_minor;
 act(w,{type:'refund',payment_id:p.id,amount_minor:100},operator);expect(summarize(w).reserved_minor).toBe(100);expect(processorBalance(w).reserved_minor).toBe(0);
 const before=structuredClone(w);expect(()=>act(w,movement(w,'topup',cash-99,'RESERVED'))).toThrow();expect(w).toStrictEqual(before);
 act(w,movement(w,'topup',cash-100,'AVAILABLE'));expect(summarize(w).cash_minor).toBe(100);expect(processorBalance(w).available_minor).toBe(cash-100);tick(w);expect(summarize(w).cash_minor).toBe(0);expect(processorBalance(w).available_minor).toBe(cash-100);expect(w.refunds[0].cash_account_id).toBeUndefined();expect(summarize(w).reconciliation.balanced).toBe(true);
});

test('new payment disputes withdraw and restore processor funds while retaining bank source and separate cash reservations',()=>{
 const w=fixture(),p=w.payments[0],bank=structuredClone(w.bankTransactions),applied=applyAction(w,{type:'open_dispute',payment_id:p.id,amount_minor:3000,reason:'requested_by_customer',external_event_id:'SOURCE-DISPUTE'},controller),opened=applied.result;const settled=applied.events.find(row=>row.type==='operation.settled')!;expect(settled.cash_effect_minor).toBe(0);expect(settled.processor_cash_effect_minor).toBe(-3000);expect(opened.operation.processor_transaction_id).toBeTruthy();expect(w.processorTransactions.find((row:any)=>row.id===opened.operation.processor_transaction_id).operation_id).toBe(opened.operation.id);expect(processorBalance(w).available_minor).toBe(9000);expect(balance(w,'cash-processor')).toBe(9000);expect(balance(w,'dispute-suspense')).toBe(3000);expect(w.bankTransactions).toStrictEqual(bank);
 rejected(w,{type:'refund',payment_id:p.id,amount_minor:100},'unresolved_dispute',operator);
 act(w,{type:'submit_dispute_evidence',dispute_id:opened.dispute.id,document_ids:[w.events[0].document_id],statement:'The captured order and signed terms identify the original payment.'},operator);
 act(w,{type:'resolve_dispute',dispute_id:opened.dispute.id,outcome:'won',external_event_id:'SOURCE-WIN'});expect(processorBalance(w).available_minor).toBe(12000);expect(balance(w,'dispute-suspense')).toBe(0);expect(balance(w,'cash-processor')).toBe(12000);expect(w.bankTransactions).toStrictEqual(bank);expect(w.processorTransactions.map((row:any)=>row.type)).toStrictEqual(['charge','dispute_hold','dispute_release']);
 const again=act(w,{type:'open_dispute',payment_id:p.id,amount_minor:2000,reason:'product_not_received',external_event_id:'SOURCE-SECOND-DISPUTE'});act(w,{type:'resolve_dispute',dispute_id:again.dispute.id,outcome:'lost',external_event_id:'SOURCE-LOSS'});expect(processorBalance(w).available_minor).toBe(10000);expect(w.payments[0].amount_ticket_liability_discharged_minor).toBe(2000);expect(balance(w,'ticket-liability')).toBe(-8900);expect(w.bankTransactions).toStrictEqual(bank);
 act(w,{type:'refund',payment_id:p.id,amount_minor:8900},operator);tick(w);expect(processorBalance(w).available_minor).toBe(1100);expect(balance(w,'ticket-liability')).toBe(0);expect(balance(w,'dispute-suspense')).toBe(0);expect(summarize(w).reconciliation.balanced).toBe(true);
});

test('external processor loss can create a real shortfall without fabricating a bank debit or moving refunds to bank funds',()=>{
 const w=fixture(),p=w.payments[0];act(w,movement(w,'payout',12000,'PAID-OUT'));const bank=structuredClone(w.bankTransactions);
 const opened=act(w,{type:'open_dispute',payment_id:p.id,amount_minor:2000,reason:'product_not_received',external_event_id:'POST-PAYOUT-DISPUTE'});expect(processorBalance(w).available_minor).toBe(-2000);expect(w.bankTransactions).toStrictEqual(bank);
 act(w,{type:'resolve_dispute',dispute_id:opened.dispute.id,outcome:'lost',external_event_id:'POST-PAYOUT-LOSS'});rejected(w,{type:'refund',payment_id:p.id,amount_minor:100},'insufficient_funds',operator);expect(summarize(w).cash_minor).toBe(112000);
 act(w,movement(w,'topup',10900,'REFUND-FUNDING'));expect(processorBalance(w).available_minor).toBe(8900);act(w,{type:'refund',payment_id:p.id,amount_minor:8900},operator);tick(w);expect(processorBalance(w).available_minor).toBe(0);expect(summarize(w).cash_minor).toBe(101100);expect(balance(w,'ticket-liability')).toBe(0);expect(summarize(w).reconciliation.balanced).toBe(true);
});

test('operator cannot inject a refund funding pool or redirect the original captured route',()=>{
 const w=fixture(),p=w.payments[0];for(const patch of [{cash_account_id:'cash-bank'},{processor_cash_effect_minor:0},{original_route:'different-card'}])rejected(w,{type:'refund',payment_id:p.id,amount_minor:100,...patch},'invalid_refund_fields',operator);
 rejected(w,{type:'refund',payment_id:p.id,amount_minor:100,route:'different-card'},'invalid_beneficiary',operator);expect(w.refunds.length).toBe(0);
});

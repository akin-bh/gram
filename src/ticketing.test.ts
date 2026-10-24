import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError,summarize,type World} from './world.ts';
import {processorBalance,processorReserved,recordProcessorMovement,ticketingAction,type TicketingHooks} from './ticketing.ts';

const controller={id:'ticket-source-controller',role:'controller'} as const;
const operator={id:'refund-operator',role:'operator'} as const;
const action=(w:World,a:any,actor:any=controller)=>applyAction(w,a,actor).result;
const later=(at:string,ms:number)=>new Date(Date.parse(at)+ms).toISOString();
const advance=(w:World,ms=1)=>action(w,{type:'advance_to',at:later(w.now,ms)});
function fresh(cash=100000):World {
  return createWorld({kind:'ticket-cancellation',name:'Ticket sources',startingCashMinor:cash,approvalThresholdMinor:1e12,blueprint:{version:1,opening_at:"2026-10-24T09:00:00.000Z",customers:[{ref:'buyer',name:'Ticket Buyer',email:'buyer@fans.test'}],vendors:[{ref:'promoter',name:'Event Promoter',email:'operations@promoter.test'}]}} as any,'ticketing-domain-test');
}
function event(w:World,patch:any={}) {
  return action(w,{type:'record_ticket_event',name:'Autumn concert',promoter_id:w.vendors[0].id,starts_at:later(w.now,86400000),agreement_reference:'AGREEMENT-ONE',agreement_signed_at:w.now,external_event_id:'source-event',...patch}).event;
}
function order(w:World,eventId:string,patch:any={}) {
  return action(w,{type:'record_ticket_order',event_id:eventId,customer_id:w.customers[0].id,source_order_id:'ORDER-ONE',ordered_at:w.now,quantity:2,face_minor:10000,tax_minor:900,fee_minor:1500,external_event_id:'source-order',...patch}).order;
}
function capture(w:World,orderId:string,patch:any={}) {
  return action(w,{type:'record_ticket_payment',order_id:orderId,source_payment_id:'CAPTURE-ONE',outcome:'captured',amount_minor:12400,occurred_at:w.now,processor_fee_minor:400,available_at:w.now,external_event_id:'source-payment',...patch});
}
function captured(cash=100000) {const w=fresh(cash),e=event(w),o=order(w,e.id),p=capture(w,o.id);return {w,e,o,...p};}
function cancel(w:World,eventId:string,patch:any={}) {return action(w,{type:'record_ticket_cancellation',event_id:eventId,source_notice_id:'NOTICE-ONE',cancelled_at:w.now,reason:'Promoter has cancelled the performance; original terms govern refunds.',external_event_id:'source-cancellation',...patch});}
function payout(w:World,amount:number,patch:any={}) {return action(w,{type:'record_processor_payout',source_payout_id:'PAYOUT-ONE',source_bank_transaction_id:'BANK-PAYOUT-ONE',amount_minor:amount,paid_at:w.now,external_event_id:'source-payout',...patch});}
function topup(w:World,amount:number,patch:any={}) {return action(w,{type:'record_processor_topup',source_topup_id:'TOPUP-ONE',source_bank_transaction_id:'BANK-TOPUP-ONE',amount_minor:amount,posted_at:w.now,external_event_id:'source-topup',...patch});}
const balance=(w:World,id:string)=>w.accounts.find((row:any)=>row.id===id)?.balance_minor;
const finance=(w:World)=>structuredClone({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts,operations:w.operations,processor:w.processorTransactions});
function fails(w:World,a:any,code:string,actor:any=controller) {const before=structuredClone(w);expect(()=>action(w,a,actor),JSON.stringify(a)).toThrowSatisfying((error:any)=>error.code===code);expect(w,'Rejected source cannot leave facts, identities or economic effects').toStrictEqual(before);}

test('ticket source captures preserve whole-order totals, actual processor fees and original route without a bank receipt',()=>{
  const w=fresh(),before=finance(w),e=event(w),o=order(w,e.id,{quantity:1e6});expect(finance(w)).toStrictEqual(before);
  const result=capture(w,o.id),p=result.payment,tx=result.processor_transaction,op=result.operation;
  expect(p.amount_minor).toBe(12400);expect(p.refundable_minor).toBe(10900);expect(o.quantity).toBe(1e6);expect(p.cash_account_id).toBe('cash-processor');expect(p.id).toMatch(/^pi_/);expect(p.charge_id).toMatch(/^ch_/);expect(p.original_route).toMatch(/^card_/);expect(p.charge_id).not.toBe(p.id);
  expect(w.bankTransactions).toStrictEqual(before.bank);expect(op.cash_effect_minor).toBe(0);expect(op.processor_cash_effect_minor).toBe(12000);expect(op.cash_account_id).toBe('cash-processor');expect(tx.source_id).toBe(p.charge_id);expect(tx.payment_id).toBe(p.id);expect(tx.receipt_id).toBe(op.receipt_id);expect(tx.amount_minor).toBe(12400);expect(tx.fee_minor).toBe(400);expect(tx.net_minor).toBe(12000);
  expect(processorBalance(w)).toStrictEqual({available_minor:12000,pending_minor:0,total_minor:12000,reserved_minor:0,spendable_minor:12000});expect(balance(w,'cash-processor')).toBe(12000);expect(balance(w,'processor-fees')).toBe(400);expect(balance(w,'ticket-liability')).toBe(-10900);expect(balance(w,'revenue')).toBe(-1500);expect(balance(w,'cash-bank')).toBe(100000);expect(op.journal_id).toBeTruthy();expect(summarize(w).reconciliation.balanced).toBe(true);
  const source=w.documents.find((row:any)=>row.id===p.document_id);expect(source.processor_transaction_id).toBe(tx.id);expect(source.body).toMatch(/processor funds, not an operating-bank deposit/);expect(w.documents.find((row:any)=>row.id===e.document_id).promoter_id).toBe(w.vendors[0].id);
});

test('full capture with a fee equal to gross has zero processor cash and no invented cent',()=>{
  const {w,payment,operation,processor_transaction}=(()=>{const w=fresh(),e=event(w),o=order(w,e.id);return {w,...capture(w,o.id,{processor_fee_minor:12400})};})();
  expect(processorBalance(w).total_minor).toBe(0);expect(processor_transaction.net_minor).toBe(0);expect(operation.processor_cash_effect_minor).toBe(0);expect(balance(w,'processor-fees')).toBe(12400);expect(balance(w,'cash-processor')).toBe(0);expect(payment.refundable_minor).toBe(10900);expect(w.journals.find((row:any)=>row.id===operation.journal_id).lines.some((line:any)=>line.account_id==='cash-processor')).toBe(false);expect(summarize(w).reconciliation.balanced).toBe(true);
});

test('void source is immutable, creates no charge or movement, and excludes a second payment outcome',()=>{
  const w=fresh(),e=event(w),o=order(w,e.id),before=finance(w),a={type:'record_ticket_payment',order_id:o.id,source_payment_id:'VOID-ONE',outcome:'voided',amount_minor:12400,occurred_at:w.now,processor_fee_minor:0,external_event_id:'source-void'};
  const p=action(w,a).payment;expect(p.status).toBe('voided');expect(p.captured_at).toBeNull();expect(p.cash_account_id).toBe('cash-processor');expect(p.charge_id).toBeUndefined();expect(p.available_at).toBeUndefined();expect(p.receipt_id).toBeUndefined();expect(p.operation_id).toBeUndefined();expect(p.refundable_minor).toBe(0);expect(finance(w)).toStrictEqual(before);expect(w.accounts.some((row:any)=>row.id==='processor-fees')).toBe(false);
  const created=p.created_at;advance(w,3600000);expect(w.payments.find((row:any)=>row.id===p.id).created_at).toBe(created);const replay=action(w,a);expect(replay.replayed).toBe(true);expect(replay.payment.created_at).toBe(created);expect(w.payments.length).toBe(1);
  fails(w,{...a,source_payment_id:'CAPTURE-AFTER-VOID',outcome:'captured',occurred_at:w.now,available_at:w.now,external_event_id:'other-outcome'},'ticket_order_already_paid');fails(w,{type:'refund',payment_id:p.id,amount_minor:1},'not_captured',operator);
});

test('source authority, strict fields, observed clock and exact complete capture are atomic',()=>{
  const w=fresh(),e=event(w),o=order(w,e.id),a={type:'record_ticket_payment',order_id:o.id,source_payment_id:'CAPTURE-VALID',outcome:'captured',amount_minor:12400,occurred_at:w.now,processor_fee_minor:400,available_at:w.now,external_event_id:'capture-valid'};
  fails(w,a,'controller_required',operator);
  for(const patch of [{bank_account_id:'cash-bank'},{original_route:'attacker'},{status:'succeeded'},{fee_minor:0}])fails(w,{...a,...patch},'invalid_ticket_source_field');
  for(const occurred_at of [later(w.now,-1),later(w.now,1)])fails(w,{...a,occurred_at},'ticket_source_clock_mismatch');
  fails(w,{...a,occurred_at:w.now.replace('.000Z','Z')},'invalid_ticket_timestamp');fails(w,{...a,available_at:undefined},'invalid_ticket_timestamp');fails(w,{...a,available_at:later(w.now,-1)},'invalid_ticket_chronology');
  for(const amount_minor of [12399,12401])fails(w,{...a,amount_minor},'ticket_payment_amount_mismatch');fails(w,{...a,processor_fee_minor:12401},'invalid_integer');fails(w,{...a,outcome:'partial'},'invalid_ticket_payment_outcome');
  fails(w,{...a,outcome:'voided',processor_fee_minor:0},'invalid_ticket_void');fails(w,{...a,outcome:'voided',available_at:undefined},'invalid_ticket_void');
  const original=action(w,a);expect(original.operation.receipt_id).toBeTruthy();const counts={payments:w.payments.length,operations:w.operations.length,transactions:w.processorTransactions.length,journals:w.journals.length};expect(action(w,a).replayed).toBe(true);expect({payments:w.payments.length,operations:w.operations.length,transactions:w.processorTransactions.length,journals:w.journals.length}).toStrictEqual(counts);fails(w,{...a,processor_fee_minor:0},'external_event_conflict');
});

test('late captured and voided source outcomes retain a cancelled order and an exact original cancellation notice',()=>{
  for(const voided of [false,true]){
    const w=fresh(),e=event(w),o=order(w,e.id);advance(w);const before=finance(w),notice=cancel(w,e.id);expect(finance(w)).toStrictEqual(before);expect(notice.cancellation.document_id).toBe(notice.document.id);expect(notice.document.source_notice_id).toBe('NOTICE-ONE');expect(w.messages.find((row:any)=>row.source_refs?.includes(notice.document.id)).from).toBe(w.vendors[0].email);
    advance(w);const result=capture(w,o.id,voided?{outcome:'voided',processor_fee_minor:0,available_at:undefined}:{});expect(w.orders.find((row:any)=>row.id===o.id).status).toBe('cancelled');expect(w.events.find((row:any)=>row.id===e.id).status).toBe('cancelled');expect(result.payment.status).toBe(voided?'voided':'succeeded');
    fails(w,{type:'record_ticket_order',event_id:e.id,customer_id:w.customers[0].id,source_order_id:'AFTER-CANCELLATION',ordered_at:notice.cancellation.cancelled_at,quantity:1,face_minor:1,tax_minor:0,fee_minor:0,external_event_id:'late-order'},'invalid_ticket_chronology');
    const retained=order(w,e.id,{source_order_id:'LATE-DELIVERED-ORDER',ordered_at:o.ordered_at,external_event_id:'late-delivered-order'});expect(retained.status).toBe('cancelled');
    fails(w,{type:'record_ticket_cancellation',event_id:e.id,source_notice_id:'SECOND-NOTICE',cancelled_at:w.now,reason:'Different notice',external_event_id:'duplicate-cancellation'},'ticket_event_already_cancelled');
  }
});

test('available processor funds differ from pending funds and release at the exact source availability instant',()=>{
  const w=fresh(),e=event(w),o=order(w,e.id),available=later(w.now,900000);capture(w,o.id,{available_at:available});
  expect(processorBalance(w)).toStrictEqual({available_minor:0,pending_minor:12000,total_minor:12000,reserved_minor:0,spendable_minor:0});expect(balance(w,'cash-processor')).toBe(12000);
  fails(w,{type:'record_processor_payout',source_payout_id:'EARLY-PAYOUT',source_bank_transaction_id:'EARLY-BANK',amount_minor:1,paid_at:w.now,external_event_id:'early-payout'},'insufficient_processor_balance');
  advance(w,899999);expect(processorBalance(w).available_minor).toBe(0);advance(w);expect(w.now).toBe(available);expect(processorBalance(w).available_minor).toBe(12000);expect(processorBalance(w).pending_minor).toBe(0);const result=payout(w,12000);expect(result.payout.paid_at).toBe(available);expect(processorBalance(w).total_minor).toBe(0);expect(balance(w,'cash-bank')).toBe(112000);
});

test('processor payouts and top-ups retain both actual rail receipts and never recognize new revenue',()=>{
  const {w}=captured();const sourceAccounts={liability:balance(w,'ticket-liability'),revenue:balance(w,'revenue'),fees:balance(w,'processor-fees')};
  const paid=payout(w,10000),funded=topup(w,1000);expect(processorBalance(w).available_minor).toBe(3000);expect(balance(w,'cash-processor')).toBe(3000);expect(balance(w,'cash-bank')).toBe(109000);
  for(const result of [paid,funded]){const record=result.payout??result.topup;expect(record.operation_id).toBe(result.operation.id);expect(record.receipt_id).toBe(result.operation.receipt_id);expect(record.receipt_id).toBe(result.bank_transaction.receipt_id);expect(record.receipt_id).toBe(result.processor_transaction.receipt_id);expect(record.source_bank_transaction_id).toBe(result.bank_transaction.source_transaction_id);expect(result.bank_transaction.source_id).toBe(result.operation.id);expect(result.processor_transaction.source_id).toBe(record.id);expect(result.processor_transaction.net_minor).toBe(-result.bank_transaction.amount_minor);expect(record.processor_transaction_id).toBe(result.processor_transaction.id);}
  expect({liability:balance(w,'ticket-liability'),revenue:balance(w,'revenue'),fees:balance(w,'processor-fees')}).toStrictEqual(sourceAccounts);expect(summarize(w).reconciliation.balanced).toBe(true);
  const before=finance(w);expect(payout(w,10000).replayed).toBe(true);expect(finance(w)).toStrictEqual(before);
  for(const source_bank_transaction_id of ['BANK-PAYOUT-ONE','bank-opening','op_999999','banktx_999999','banktx-op_999999'])fails(w,{type:'record_processor_topup',source_topup_id:'TOPUP-TWO',source_bank_transaction_id,amount_minor:1,posted_at:w.now,external_event_id:`identity-${source_bank_transaction_id}`},'duplicate_ticket_source');
  fails(w,{type:'record_processor_topup',source_topup_id:'PAYOUT-ONE',source_bank_transaction_id:'NEW-BANK-SOURCE',amount_minor:1,posted_at:w.now,external_event_id:'cross-source'},'duplicate_ticket_source');
  fails(w,{type:'record_bank_activity',source_transaction_id:'BANK-TOPUP-ONE',account_id:'cash-bank',currency:'USD',kind:'interest',amount_minor:1,posted_at:w.now,description:'Cannot reuse a top-up receipt',external_event_id:'reused-bank-source'},'duplicate_bank_activity_source');
});

test('pending processor refunds reserve payouts but not operating bank; original-card settlement debits only processor funds',()=>{
  const {w,e,payment}=captured();advance(w);cancel(w,e.id);const request=action(w,{type:'refund',payment_id:payment.id,amount_minor:10900},operator);expect(request.operation.status).toBe('pending');expect(request.operation.cash_account_id).toBe('cash-processor');expect(processorReserved(w)).toBe(10900);expect(processorBalance(w).spendable_minor).toBe(1100);expect(summarize(w).reserved_minor).toBe(0);
  fails(w,{type:'record_processor_payout',source_payout_id:'OVER-RESERVED',source_bank_transaction_id:'OVER-RESERVED-BANK',amount_minor:1101,paid_at:w.now,external_event_id:'over-reserved'},'insufficient_processor_balance');payout(w,1100);
  const bankBefore=structuredClone(w.bankTransactions);action(w,{type:'set_fault',system:'bank',mode:'offline'});advance(w,3600000);expect(w.bankTransactions).toStrictEqual(bankBefore);expect(w.refunds.find((row:any)=>row.id===request.refund.id).status).toBe('succeeded');expect(processorBalance(w).available_minor).toBe(0);expect(processorReserved(w)).toBe(0);expect(balance(w,'cash-processor')).toBe(0);expect(balance(w,'ticket-liability')).toBe(0);expect(balance(w,'processor-fees')).toBe(400);expect(balance(w,'revenue')).toBe(-1500);
  const tx=w.processorTransactions.find((row:any)=>row.refund_id===request.refund.id);expect(tx.net_minor).toBe(-10900);expect(tx.source_id).toBe(request.refund.id);const op=w.operations.find((row:any)=>row.id===request.operation.id);expect(op.receipt_id).toBe(tx.receipt_id);expect(op.cash_effect_minor).toBe(0);expect(op.processor_cash_effect_minor).toBe(-10900);expect(w.journals.find((row:any)=>row.id===op.journal_id).lines.find((line:any)=>line.credit_minor).account_id).toBe('cash-processor');
  const count=w.processorTransactions.length;advance(w,3600000);expect(w.processorTransactions.length).toBe(count);expect(summarize(w).reconciliation.balanced).toBe(true);
});

test('processor source accounting defers independently while actual payout, top-up and refund evidence remains readable',()=>{
  const w=fresh(),e=event(w),o=order(w,e.id),initialJournal=structuredClone(w.journals);action(w,{type:'close_period'});action(w,{type:'set_fault',system:'ledger',mode:'offline'});capture(w,o.id);payout(w,2000);topup(w,1000);
  expect(processorBalance(w).total_minor).toBe(11000);expect(w.bankTransactions.reduce((sum:number,row:any)=>sum+row.amount_minor,0)).toBe(101000);expect(w.journals).toStrictEqual(initialJournal);expect(balance(w,'cash-bank')).toBe(100000);expect(balance(w,'cash-processor')).toBe(0);expect(w.settledUnposted.length).toBe(3);
  const bank=structuredClone(w.bankTransactions),provider=structuredClone(w.processorTransactions);action(w,{type:'set_fault',system:'ledger',mode:'healthy'});action(w,{type:'reopen_period'});expect(w.bankTransactions).toStrictEqual(bank);expect(w.processorTransactions).toStrictEqual(provider);expect(balance(w,'cash-bank')).toBe(101000);expect(balance(w,'cash-processor')).toBe(11000);expect(balance(w,'processor-fees')).toBe(400);expect(w.settledUnposted.length).toBe(0);expect(w.journals.length).toBe(initialJournal.length+3);
  const after=structuredClone(w.journals);advance(w,3600000);expect(w.journals).toStrictEqual(after);expect(summarize(w).reconciliation.balanced).toBe(true);
});

test('top-ups respect accepted bank reservations while processor refunds remain independently reserved',()=>{
  const {w,e,payment}=captured(100000);const contract=action(w,{type:'record_service_contract',external_contract_id:'BANK-RESERVED-CONTRACT',counterparty_kind:'vendor',counterparty_id:w.vendors[0].id,amount_minor:90000,description:'Completed operating service',signed_at:w.now,external_event_id:'bank-contract'}).contract;
  const bill=action(w,{type:'record_service_bill',contract_id:contract.id,source_invoice_id:'BANK-RESERVED-INVOICE',amount_minor:90000,issued_at:w.now,due_at:w.now,service_completed_at:w.now,completion_reference:'SERVICE-COMPLETE',external_event_id:'bank-bill'}).bill;action(w,{type:'pay_bill',bill_id:bill.id},operator);
  advance(w);cancel(w,e.id);action(w,{type:'refund',payment_id:payment.id,amount_minor:10900},operator);expect(processorReserved(w)).toBe(10900);expect(summarize(w).reserved_minor).toBe(90000);
  fails(w,{type:'record_processor_topup',source_topup_id:'TOO-LARGE',source_bank_transaction_id:'TOO-LARGE-BANK',amount_minor:10001,posted_at:w.now,external_event_id:'too-large-topup'},'insufficient_bank_balance');topup(w,10000);expect(w.bankTransactions.reduce((sum:number,row:any)=>sum+row.amount_minor,0)).toBe(90000);expect(processorBalance(w).spendable_minor).toBe(11100);expect(summarize(w).reserved_minor).toBe(90000);
});

test('actual dispute withdrawals and recoveries use provider funds even after payout, without a fabricated bank debit',()=>{
  const {w,payment}=captured();payout(w,12000);const bank=structuredClone(w.bankTransactions),dispute=action(w,{type:'open_dispute',payment_id:payment.id,amount_minor:5000,reason:'Issuer disputes performance',external_event_id:'processor-dispute'}).dispute;
  expect(processorBalance(w).available_minor).toBe(-5000);expect(balance(w,'cash-processor')).toBe(-5000);expect(w.bankTransactions).toStrictEqual(bank);expect(w.processorTransactions.at(-1).type).toBe('dispute_hold');expect(w.processorTransactions.at(-1).source_id).toBe(dispute.id);
  fails(w,{type:'record_processor_payout',source_payout_id:'NEGATIVE-PAYOUT',source_bank_transaction_id:'NEGATIVE-BANK',amount_minor:1,paid_at:w.now,external_event_id:'negative-payout'},'insufficient_processor_balance');
  action(w,{type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:[payment.document_id],statement:'Original processor capture source supports this response.'},operator);action(w,{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'processor-recovery'});expect(w.bankTransactions).toStrictEqual(bank);expect(processorBalance(w).available_minor).toBe(0);expect(balance(w,'cash-processor')).toBe(0);expect(balance(w,'dispute-suspense')).toBe(0);expect(w.processorTransactions.at(-1).type).toBe('dispute_release');expect(w.processorTransactions.at(-1).source_id).toBe(dispute.id);expect(summarize(w).reconciliation.balanced).toBe(true);
});

test('pure provider balance reads preserve old saved JSON and never synthesize transactions from preset bank captures',()=>{
  const w=createWorld({kind:'ticket-cancellation',orderCount:3,startingCashMinor:100000}),before=JSON.stringify(w);
  expect(processorBalance(w)).toStrictEqual({available_minor:0,pending_minor:0,total_minor:0,reserved_minor:0,spendable_minor:0});expect(processorReserved(w)).toBe(0);expect(JSON.stringify(w)).toBe(before);expect(w.processorTransactions).toBeUndefined();expect(w.processorPayouts).toBeUndefined();expect(w.processorTopups).toBeUndefined();expect(w.ticketCancellations).toBeUndefined();expect(w.accounts.some((row:any)=>row.id==='processor-fees')).toBe(false);
});

test('movement helper rejects duplicate operations and malformed directions; source action rejects controller impersonation',()=>{
  const {w,operation,processor_transaction}=captured();let sequence=0;
  const hooks={id:()=>`test-transaction-${++sequence}`,fail:(code:string,message:string,status=400):never=>{throw new DomainError(status,code,message);},emit:()=>{}};
  const input={type:'charge' as const,source_id:processor_transaction.source_id,operation_id:operation.id,amount_minor:12400,fee_minor:400};const before=structuredClone(w);
  expect(()=>recordProcessorMovement(w,input,hooks)).toThrowSatisfying((error:any)=>error.code==='duplicate_processor_movement');
  for(const patch of [{type:'refund',amount_minor:1},{type:'topup',amount_minor:-1},{type:'refund',amount_minor:0},{type:'refund',amount_minor:-1,fee_minor:1},{type:'refund',amount_minor:-1,available_at:later(w.now,1)}])expect(()=>recordProcessorMovement(w,{...input,source_id:'new-source',operation_id:'new-operation',fee_minor:0,...patch} as any,hooks)).toThrowSatisfying((error:any)=>error.code==='invalid_processor_movement');
  expect(w).toStrictEqual(before);expect(sequence).toBe(0);
  const never=()=>{throw Error('Unauthorized action must not invoke economic hooks');};const domainHooks={...hooks,integer:never,text:never,find:never,document:never,mail:never,post:never,bankAvailable:never,cancel:never} as TicketingHooks;
  expect(()=>ticketingAction(w,{type:'record_ticket_event'},operator,domainHooks)).toThrowSatisfying((error:any)=>error.code==='controller_required');expect(w).toStrictEqual(before);
});

test('processor arithmetic checks pending partitions and reservations independently from an offsetting negative available balance',()=>{
  const w=fresh(),future=later(w.now,3600000),max=BigInt(Number.MAX_SAFE_INTEGER);let sequence=0;
  const hooks={id:()=>`overflow-transaction-${++sequence}`,fail:(code:string,message:string,status=400):never=>{throw new DomainError(status,code,message);},emit:()=>{}};
  const chunks=(total:bigint,at:string)=>{const rows:any[]=[];while(total){const value=total>1000000000000n?1000000000000n:total;rows.push({id:`prior-${at}-${rows.length}`,net_minor:Number(value),available_at:at});total-=value;}return rows;};
  w.processorTransactions=[{id:'prior-negative',net_minor:-1000,available_at:w.now},...chunks(max,future)];expect(processorBalance(w).pending_minor).toBe(Number.MAX_SAFE_INTEGER);expect(processorBalance(w).total_minor).toBe(Number.MAX_SAFE_INTEGER-1000);const before=JSON.stringify(w);
  expect(()=>recordProcessorMovement(w,{type:'charge',source_id:'extra-charge',operation_id:'extra-operation',amount_minor:1,available_at:future},hooks)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.status===409&&error.code==='processor_balance_overflow');expect(sequence).toBe(0);expect(JSON.stringify(w)).toBe(before);
  w.processorTransactions.push({id:'corrupt-partition',net_minor:1,available_at:future});expect(()=>processorBalance(w)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='processor_balance_overflow');
  const offset=fresh(),past=later(offset.now,-1);offset.processorTransactions=[...chunks(max,past).map(row=>({...row,net_minor:-row.net_minor})),...chunks(max,future)];
  expect(processorBalance(offset).total_minor).toBe(0);recordProcessorMovement(offset,{type:'topup',source_id:'current-topup',operation_id:'current-operation',amount_minor:100},hooks);expect(processorBalance(offset).available_minor).toBe(-Number.MAX_SAFE_INTEGER+100);expect(processorBalance(offset).pending_minor).toBe(Number.MAX_SAFE_INTEGER);expect(processorBalance(offset).total_minor,'A current top-up never creates historical pending funds').toBe(100);
  const reserved=fresh();reserved.payments=[{id:'processor-payment',cash_account_id:'cash-processor'}];reserved.refunds=[{id:'reserved-refund',payment_id:'processor-payment'}];reserved.operations=chunks(max+1n,reserved.now).map(row=>({id:row.id,type:'refund',status:'pending',target_id:'reserved-refund',amount_minor:row.net_minor}));expect(()=>processorReserved(reserved)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='processor_balance_overflow');
  reserved.operations=[{type:'refund',status:'pending',target_id:'reserved-refund',amount_minor:1}];reserved.processorTransactions=[{net_minor:-Number.MAX_SAFE_INTEGER,available_at:reserved.now}];expect(()=>processorBalance(reserved)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='processor_balance_overflow');
});

test('bank receipt sources cannot alter an already closed statement window',()=>{
  const {w}=captured();w.bankStatements.push({id:'closed-statement',status:'closed',account_id:'cash-bank',currency:'USD',end_at:w.now});
  fails(w,{type:'record_processor_payout',source_payout_id:'CLOSED-PAYOUT',source_bank_transaction_id:'CLOSED-PAYOUT-BANK',amount_minor:1,paid_at:w.now,external_event_id:'closed-payout'},'processor_bank_statement_closed');
  fails(w,{type:'record_processor_topup',source_topup_id:'CLOSED-TOPUP',source_bank_transaction_id:'CLOSED-TOPUP-BANK',amount_minor:1,posted_at:w.now,external_event_id:'closed-topup'},'processor_bank_statement_closed');
  advance(w);expect(payout(w,1).bank_transaction.posted_at).toBe(w.now);
});

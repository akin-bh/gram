/** Controller-observed ticket sources and the processor's independent cash ledger.
 * Provider funds remain distinct from bank cash and from deferred GL posting. */
import {DomainError,type Action,type Actor,type World} from './world.ts';
import type {ProcurementHooks} from './procurement.ts';

export const ticketingAccounts=[['processor-fees','Processor fees','expense']];
export const ticketingCollections:Record<string,string>={
  'processor-transaction':'processorTransactions','processor-payout':'processorPayouts',
  'processor-topup':'processorTopups','ticket-cancellation':'ticketCancellations',
};
export const ticketingFeeds=Object.keys(ticketingCollections);
export const ticketingRequirements:Record<string,{role:'controller';system:string;external:true}>={
  record_ticket_event:{role:'controller',system:'ticketing',external:true},
  record_ticket_order:{role:'controller',system:'ticketing',external:true},
  record_ticket_payment:{role:'controller',system:'stripe',external:true},
  record_processor_payout:{role:'controller',system:'stripe',external:true},
  record_processor_topup:{role:'controller',system:'stripe',external:true},
  record_ticket_cancellation:{role:'controller',system:'ticketing',external:true},
};
export type TicketingHooks=Pick<ProcurementHooks,'id'|'integer'|'text'|'fail'|'find'|'emit'|'document'|'mail'>&{
  post:(operation:any)=>void;
  bankAvailable:()=>number;
  cancel:(eventId:string,reason:string)=>{event:any;document?:any;already_cancelled?:boolean};
};
export type ProcessorMovementInput={
  type:'charge'|'refund'|'payout'|'topup'|'dispute_hold'|'dispute_release';
  source_id:string;operation_id:string;amount_minor:number;fee_minor?:number;available_at?:string;
  payment_id?:string;refund_id?:string;payout_id?:string;topup_id?:string;dispute_id?:string;receipt_id?:string;
};
export type ProcessorBalance={available_minor:number;pending_minor:number;total_minor:number;reserved_minor:number;spendable_minor:number};

function exact(value:bigint):number {
  if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(Number.MIN_SAFE_INTEGER))throw new DomainError(409,'processor_balance_overflow','Processor balances, reservations and spendable funds must remain exact integers');
  return Number(value);
}
/** Reading legacy worlds never creates a processor history from accounting. */
export function processorReserved(w:World):number {
  return exact((w.operations??[]).filter((op:any)=>op.type==='refund'&&op.status==='pending').reduce((sum:bigint,op:any)=>{
    const refund=(w.refunds??[]).find((row:any)=>row.id===op.target_id),payment=(w.payments??[]).find((row:any)=>row.id===refund?.payment_id);
    return sum+(payment?.cash_account_id==='cash-processor'?BigInt(op.amount_minor):0n);
  },0n));
}
export function processorBalance(w:World):ProcessorBalance {
  let available=0n,pending=0n;
  for(const row of w.processorTransactions??[])if(row.available_at<=w.now)available+=BigInt(row.net_minor);else pending+=BigInt(row.net_minor);
  const reserved=processorReserved(w);
  return {available_minor:exact(available),pending_minor:exact(pending),total_minor:exact(available+pending),reserved_minor:reserved,spendable_minor:exact(available-BigInt(reserved))};
}
function utc(value:any,label:string,h:Pick<TicketingHooks,'fail'>):string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)h.fail('invalid_ticket_timestamp',`${label} must be an exact UTC timestamp with milliseconds`);
  return value;
}
function now(w:World,value:any,label:string,h:TicketingHooks):string {
  const date=utc(value,label,h);if(date!==w.now)h.fail('ticket_source_clock_mismatch',`${label} must equal current simulation time; advance the clock before recording the source`,409);return date;
}
function safeBalance(w:World,candidate:any,h:Pick<TicketingHooks,'fail'>) {
  const rows=[...(w.processorTransactions??[]),candidate],groups=new Map<string,bigint>();let total=0n;
  for(const row of rows){const value=BigInt(row.net_minor);total+=value;groups.set(row.available_at,(groups.get(row.available_at)??0n)+value);}
  groups.set(w.now,groups.get(w.now)??0n);
  const check=(value:bigint)=>{if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(Number.MIN_SAFE_INTEGER))h.fail('processor_balance_overflow','Processor total, available, pending and spendable partitions must remain exact at each availability boundary',409);};
  check(total);let available=0n;const reserved=BigInt(processorReserved(w));
  for(const [at,value]of [...groups.entries()].sort(([a],[b])=>a.localeCompare(b))){
    available+=value;
    // A newly observed movement did not exist at earlier source times. Check
    // every reachable partition, without inventing historical pending funds.
    if(at>=w.now){check(available);check(total-available);check(available-reserved);}
  }
}
/** Append one factual provider movement per economic operation. No bank or GL effect. */
export function recordProcessorMovement(w:World,input:ProcessorMovementInput,h:Pick<TicketingHooks,'id'|'fail'|'emit'>):any {
  const amount=input.amount_minor,fee=input.fee_minor??0,at=utc(input.available_at??w.now,'available_at',h);
  if(!['charge','refund','payout','topup','dispute_hold','dispute_release'].includes(input.type)||!Number.isSafeInteger(amount)||amount===0||Math.abs(amount)>1e12||!Number.isSafeInteger(fee)||fee<0||fee>Math.max(amount,0)||(input.type!=='charge'&&fee!==0))h.fail('invalid_processor_movement','Processor movement requires a bounded nonzero signed amount and an explicit charge fee');
  const debit=['refund','payout','dispute_hold'].includes(input.type);
  if((debit&&amount>=0)||(!debit&&amount<=0)||(input.type!=='charge'&&at!==w.now)||(input.type==='charge'&&at<w.now))h.fail('invalid_processor_movement','Movement direction and availability must match the observed processor source');
  if(!input.source_id||!input.operation_id)h.fail('invalid_processor_movement','Processor movements require their actual source and operation identities');
  if((w.processorTransactions??[]).some((row:any)=>row.operation_id===input.operation_id||(row.type===input.type&&row.source_id===input.source_id)))h.fail('duplicate_processor_movement','This source already has a processor movement',409);
  const value={...input,fee_minor:fee,net_minor:amount-fee,currency:'USD',created_at:w.now,available_at:at};
  safeBalance(w,value,h);const row={id:h.id('txn'),...value};(w.processorTransactions??=[]).push(row);
  h.emit('processor.transaction_recorded',{processor_transaction_id:row.id,source_id:row.source_id,operation_id:row.operation_id,type:row.type,amount_minor:amount,fee_minor:fee,net_minor:row.net_minor,available_at:at});return row;
}
function fields(a:Action,names:string[],h:TicketingHooks) {
  if(Object.keys(a).some(key=>!['type','action','external_event_id',...names].includes(key))||(a.type&&a.action&&a.type!==a.action))h.fail('invalid_ticket_source_field','Unsupported ticketing source field');
}
function identity(value:any,label:string,h:TicketingHooks):string {
  const text=h.text(value,label,200);if(text!==value||/[\u0000-\u001f\u007f]/.test(text))h.fail('invalid_ticket_source_identity',`${label} must be an exact nonempty source identity`);return text;
}
function sourceTaken(w:World,id:string):boolean {
  const collections=[w.events,w.orders,w.payments,w.processorPayouts,w.processorTopups,w.ticketCancellations,w.processorTransactions,w.bankTransactions,w.bankActivities];
  return collections.some(rows=>(rows??[]).some((row:any)=>['id','source_order_id','source_payment_id','source_payout_id','source_topup_id','source_notice_id','source_bank_transaction_id','source_transaction_id','source_id','operation_id','receipt_id','charge_id'].some(key=>row[key]===id)));
}
function uniqueSource(w:World,value:any,label:string,h:TicketingHooks,bank=false):string {
  const text=identity(value,label,h);
  if(sourceTaken(w,text)||/^(?:(?:op|receipt|banktx|bank-activity|pi|ch|card|txn|event|order|payout|topup|ticket-cancellation)_\d+|banktx-op_\d+|bank-opening|bank-sale-\d+)$/.test(text))h.fail('duplicate_ticket_source','External source identity is already used or belongs to a reserved host namespace',409);
  if(bank&&(w.operations??[]).some((op:any)=>op.bank_transaction_id===text||`banktx-${op.id}`===text))h.fail('duplicate_ticket_source','External bank source conflicts with an accepted instruction identity',409);
  return text;
}
function closedBank(w:World,h:TicketingHooks) {
  if((w.bankStatements??[]).some((statement:any)=>statement.status==='closed'&&statement.account_id==='cash-bank'&&statement.currency==='USD'&&statement.end_at>=w.now))h.fail('processor_bank_statement_closed','Reopen an affected closed statement before recording another bank cash fact',409);
}
function settled(w:World,h:TicketingHooks,type:string,target:string,amount:number,external:string,lines:any[],bankDelta=0,processorDelta=0):any {
  const operation={id:h.id('op'),type,target_id:target,amount_minor:amount,currency:'USD',status:'settled',created_at:w.now,settled_at:w.now,receipt_id:h.id('receipt'),external_event_id:external,cash_account_id:'cash-processor',cash_effect_minor:bankDelta,processor_cash_effect_minor:processorDelta,journal_lines:lines};
  w.operations.push(operation);return operation;
}
function post(w:World,h:TicketingHooks,op:any) {
  h.post(op);h.emit('operation.settled',{operation_id:op.id,receipt_id:op.receipt_id,amount_minor:op.amount_minor,cash_effect_minor:op.cash_effect_minor,processor_cash_effect_minor:op.processor_cash_effect_minor});
}
function bankRow(w:World,h:TicketingHooks,op:any,source:string,description:string):any {
  const aggregate=w.bankTransactions.filter((row:any)=>row.account_id==='cash-bank'&&row.status==='posted').reduce((sum:bigint,row:any)=>sum+BigInt(row.amount_minor),0n)+BigInt(op.cash_effect_minor);
  if(aggregate>BigInt(Number.MAX_SAFE_INTEGER)||aggregate<BigInt(Number.MIN_SAFE_INTEGER))h.fail('processor_bank_balance_overflow','Bank cash must remain exact within the aggregate integer limit',409);
  const row={id:h.id('banktx'),account_id:'cash-bank',amount_minor:op.cash_effect_minor,currency:'USD',status:'posted',description,posted_at:w.now,source_id:op.id,receipt_id:op.receipt_id,source_transaction_id:source,external_event_id:op.external_event_id};
  w.bankTransactions.push(row);op.bank_transaction_id=row.id;op.source_bank_transaction_id=source;return row;
}

export function ticketingAction(w:World,a:Action,actor:Actor,h:TicketingHooks):{handled:boolean;result?:any} {
  const type=a.type??a.action;if(!type||!ticketingRequirements[type])return {handled:false};
  if(actor.role!=='controller')h.fail('controller_required','Ticketing sources require a controller-observed external fact',403);
  identity(a.external_event_id,'external_event_id',h);
  const done=(result:any)=>({handled:true,result});
  if(type==='record_ticket_event'){
    fields(a,['name','promoter_id','starts_at','agreement_reference','agreement_signed_at'],h);
    const promoter=h.find(w.vendors,a.promoter_id,'Promoter'),start=utc(a.starts_at,'starts_at',h),signed=utc(a.agreement_signed_at,'agreement_signed_at',h),reference=identity(a.agreement_reference,'agreement_reference',h);
    if(signed>w.now||signed>=start)h.fail('invalid_ticket_chronology','The signed promoter agreement must precede the event and cannot be in the future');
    const event:any={id:h.id('event'),name:h.text(a.name,'name',120),promoter_id:promoter.id,starts_at:start,status:'scheduled',agreement_reference:reference,agreement_signed_at:signed,recorded_at:w.now,recorded_by:actor.id,external_event_id:a.external_event_id};
    const doc=h.document('ticket-promoter-agreement',`Agreement: ${event.name}`,`Promoter ${promoter.name} (${promoter.id}) signed agreement ${reference} at ${signed} for event ${event.id}, starting ${start}. Each order records whole-order admission, admission tax and service fee amounts in USD cents. On a recorded cancellation, refund admission and admission tax to the original captured card. Service fees are nonrefundable. Processor fees are a separate merchant expense and do not alter the customer's refundable entitlement. This signed source alone creates no sale, capture or bank receipt.`,{event_id:event.id,promoter_id:promoter.id,agreement_reference:reference,external_event_id:a.external_event_id});
    event.document_id=doc.id;w.events.push(event);h.emit('ticketing.event_recorded',{event_id:event.id,promoter_id:promoter.id,document_id:doc.id});return done({event});
  }
  if(type==='record_ticket_order'){
    fields(a,['event_id','customer_id','source_order_id','ordered_at','quantity','face_minor','tax_minor','fee_minor'],h);
    const event=h.find(w.events,a.event_id,'Ticket event'),customer=h.find(w.customers,a.customer_id,'Customer'),source=uniqueSource(w,a.source_order_id,'source_order_id',h),at=utc(a.ordered_at,'ordered_at',h);
    if(!event.agreement_signed_at||at<event.agreement_signed_at||at>w.now||at>=event.starts_at||(event.status==='cancelled'&&at>=event.cancelled_at))h.fail('invalid_ticket_chronology','An order must follow the signed agreement, precede the event and any cancellation, and not be in the future');
    const face=h.integer(a.face_minor,'face_minor',1,1e12),tax=h.integer(a.tax_minor,'tax_minor',0,1e12),fee=h.integer(a.fee_minor,'fee_minor',0,1e12),total=h.integer(face+tax+fee,'order total',1,1e12);
    const order:any={id:h.id('order'),event_id:event.id,customer_id:customer.id,source_order_id:source,ordered_at:at,created_at:at,recorded_at:w.now,recorded_by:actor.id,external_event_id:a.external_event_id,quantity:h.integer(a.quantity,'quantity',1,1e6),face_minor:face,tax_minor:tax,fee_minor:fee,total_minor:total,currency:'USD',status:event.status==='cancelled'?'cancelled':'confirmed'};
    const doc=h.document('ticket-order-source',`Ticket order ${source}`,`Customer ${customer.name} (${customer.id}) placed order ${source} for event ${event.id} at ${at}, quantity ${order.quantity}. Whole-order amounts, not unit prices: admission ${face}, admission tax ${tax}, nonrefundable service fee ${fee}, total ${total} USD cents. Agreement ${event.document_id} governs cancellation entitlement. This order does not prove payment or a bank deposit.`,{event_id:event.id,order_id:order.id,customer_id:customer.id,source_order_id:source,external_event_id:a.external_event_id});order.document_id=doc.id;w.orders.push(order);
    h.emit('ticketing.order_recorded',{order_id:order.id,event_id:event.id,document_id:doc.id,total_minor:total});return done({order});
  }
  if(type==='record_ticket_payment'){
    fields(a,['order_id','source_payment_id','outcome','amount_minor','occurred_at','processor_fee_minor','available_at'],h);
    const order=h.find(w.orders,a.order_id,'Ticket order'),source=uniqueSource(w,a.source_payment_id,'source_payment_id',h),at=now(w,a.occurred_at,'occurred_at',h);
    if(!order.source_order_id||at<order.ordered_at)h.fail('invalid_ticket_chronology','Processor evidence must follow the original typed order');
    if(order.payment_id||w.payments.some((row:any)=>row.order_id===order.id))h.fail('ticket_order_already_paid','An order permits one full captured or voided payment source',409);
    if(!['captured','voided'].includes(a.outcome))h.fail('invalid_ticket_payment_outcome','Payment evidence must report captured or voided');
    const amount=h.integer(a.amount_minor,'amount_minor',1,1e12),fee=h.integer(a.processor_fee_minor,'processor_fee_minor',0,amount),captured=a.outcome==='captured';
    if(amount!==order.total_minor)h.fail('ticket_payment_amount_mismatch','A source payment must cover exactly the whole order total',409);
    let available:string|undefined;
    if(captured){available=utc(a.available_at,'available_at',h);if(available<at)h.fail('invalid_ticket_chronology','Captured funds cannot become available before capture');}
    else if(fee!==0||a.available_at!==undefined)h.fail('invalid_ticket_void','A void has zero processor fee and no available_at');
    const payment:any={id:h.id('pi'),order_id:order.id,customer_id:order.customer_id,source_payment_id:source,status:captured?'succeeded':'voided',amount_minor:amount,amount_refunded_minor:0,amount_disputed_lost_minor:0,amount_ticket_liability_discharged_minor:0,refundable_minor:captured?order.face_minor+order.tax_minor:0,currency:'USD',original_route:h.id('card'),cash_account_id:'cash-processor',created_at:at,occurred_at:at,captured_at:captured?at:null,processor_fee_minor:fee,recorded_by:actor.id,external_event_id:a.external_event_id};
    if(captured){payment.charge_id=h.id('ch');payment.available_at=available;}
    order.payment_id=payment.id;w.payments.push(payment);
    let operation:any,transaction:any;
    if(captured){
      if(!w.accounts.some((row:any)=>row.id==='processor-fees'))w.accounts.push({id:'processor-fees',name:'Processor fees',type:'expense',currency:'USD',balance_minor:0});
      const net=amount-fee,lines=[...(net?[{account_id:'cash-processor',debit_minor:net}]:[]),...(fee?[{account_id:'processor-fees',debit_minor:fee}]:[]),{account_id:'ticket-liability',credit_minor:order.face_minor+order.tax_minor},...(order.fee_minor?[{account_id:'revenue',credit_minor:order.fee_minor}]:[])];
      operation=settled(w,h,'ticket_capture',payment.id,amount,a.external_event_id,lines,0,net);payment.operation_id=operation.id;payment.receipt_id=operation.receipt_id;
      transaction=recordProcessorMovement(w,{type:'charge',source_id:payment.charge_id,payment_id:payment.id,operation_id:operation.id,amount_minor:amount,fee_minor:fee,available_at:available,receipt_id:operation.receipt_id},h);payment.processor_transaction_id=transaction.id;operation.processor_transaction_id=transaction.id;post(w,h,operation);
    }
    const doc=h.document('ticket-payment-source',`Processor ${a.outcome}: ${source}`,`Processor source ${source} reports ${a.outcome} for order ${order.id}, original payment ${payment.id}, amount ${amount} USD cents, observed at ${at}. ${captured?`Captured charge ${payment.charge_id} has processor fee ${fee}, net ${amount-fee}, available at ${available}. Provider transaction ${transaction.id}, receipt ${operation.receipt_id}. These are processor funds, not an operating-bank deposit.`:'The void produces no cash, fee, receipt or accounting journal.'} Refunds, if authorized by the event cancellation, return only to original card ${payment.original_route}.`,{payment_id:payment.id,order_id:order.id,event_id:order.event_id,source_payment_id:source,...(captured?{operation_id:operation.id,processor_transaction_id:transaction.id,receipt_id:operation.receipt_id}:{}),external_event_id:a.external_event_id});payment.document_id=doc.id;
    h.emit('ticketing.payment_recorded',{payment_id:payment.id,order_id:order.id,status:payment.status,amount_minor:amount,processor_fee_minor:fee,document_id:doc.id,...(captured?{operation_id:operation.id,processor_transaction_id:transaction.id}: {})});return done({payment,...(captured?{operation,processor_transaction:transaction}:{})});
  }
  if(type==='record_processor_payout'||type==='record_processor_topup'){
    const payout=type==='record_processor_payout',sourceKey=payout?'source_payout_id':'source_topup_id',timeKey=payout?'paid_at':'posted_at';
    fields(a,[sourceKey,'source_bank_transaction_id','amount_minor',timeKey],h);
    const source=uniqueSource(w,a[sourceKey],sourceKey,h),bankSource=uniqueSource(w,a.source_bank_transaction_id,'source_bank_transaction_id',h,true),amount=h.integer(a.amount_minor,'amount_minor',1,1e12),at=now(w,a[timeKey],timeKey,h);
    if(source===bankSource)h.fail('duplicate_ticket_source','Processor and bank source identities must be distinct',409);closedBank(w,h);
    if(payout&&processorBalance(w).spendable_minor<amount)h.fail('insufficient_processor_balance','Payout exceeds available processor funds after pending refund reservations',409);
    if(!payout&&h.bankAvailable()<amount)h.fail('insufficient_bank_balance','Top-up exceeds operating-bank cash after all accepted reservations',409);
    const record:any={id:h.id(payout?'payout':'topup'),[sourceKey]:source,source_bank_transaction_id:bankSource,amount_minor:amount,currency:'USD',status:payout?'paid':'succeeded',[timeKey]:at,created_at:at,recorded_by:actor.id,external_event_id:a.external_event_id,...(payout?{destination_account_id:'cash-bank'}:{source_account_id:'cash-bank'})};
    const lines=payout?[{account_id:'cash-bank',debit_minor:amount},{account_id:'cash-processor',credit_minor:amount}]:[{account_id:'cash-processor',debit_minor:amount},{account_id:'cash-bank',credit_minor:amount}];
    const operation=settled(w,h,payout?'processor_payout':'processor_topup',record.id,amount,a.external_event_id,lines,payout?amount:-amount,payout?-amount:amount),bank=bankRow(w,h,operation,bankSource,payout?'Observed processor payout':'Observed processor top-up');
    const transaction=recordProcessorMovement(w,{type:payout?'payout':'topup',source_id:record.id,...(payout?{payout_id:record.id}:{topup_id:record.id}),operation_id:operation.id,amount_minor:payout?-amount:amount,receipt_id:operation.receipt_id},h);
    Object.assign(record,{operation_id:operation.id,receipt_id:operation.receipt_id,bank_transaction_id:bank.id,processor_transaction_id:transaction.id});operation.processor_transaction_id=transaction.id;post(w,h,operation);
    const doc=h.document(payout?'processor-payout-source':'processor-topup-source',`Processor ${payout?'payout':'top-up'} ${source}`,`Observed ${payout?'payout from processor to operating bank':'top-up from operating bank to processor'}: ${amount} USD cents at ${at}. Processor source ${source}, bank source ${bankSource}, bank transaction ${bank.id}, processor transaction ${transaction.id}, operation ${operation.id}, receipt ${operation.receipt_id}. This recorded cash movement does not recognize new revenue or extinguish customer refund liabilities.`,{[payout?'payout_id':'topup_id']:record.id,source_bank_transaction_id:bankSource,bank_transaction_id:bank.id,processor_transaction_id:transaction.id,operation_id:operation.id,receipt_id:operation.receipt_id,external_event_id:a.external_event_id});record.document_id=doc.id;(w[payout?'processorPayouts':'processorTopups']??=[]).push(record);
    h.mail({from:'receipts@processor.simulation.test',subject:`Processor ${payout?'payout':'top-up'} received: ${source}`,body:doc.body,source_refs:[record.id,doc.id,bank.id,transaction.id,operation.receipt_id]});h.emit(payout?'processor.payout_recorded':'processor.topup_recorded',{[payout?'payout_id':'topup_id']:record.id,operation_id:operation.id,receipt_id:operation.receipt_id,bank_transaction_id:bank.id,processor_transaction_id:transaction.id,amount_minor:amount,document_id:doc.id});return done({[payout?'payout':'topup']:record,operation,bank_transaction:bank,processor_transaction:transaction});
  }
  fields(a,['event_id','source_notice_id','cancelled_at','reason'],h);
  const event=h.find(w.events,a.event_id,'Ticket event'),source=uniqueSource(w,a.source_notice_id,'source_notice_id',h),at=now(w,a.cancelled_at,'cancelled_at',h),reason=h.text(a.reason,'reason');
  if(event.status==='cancelled')h.fail('ticket_event_already_cancelled','A recorded cancellation already governs this event',409);
  if(event.agreement_signed_at&&at<event.agreement_signed_at)h.fail('invalid_ticket_chronology','Cancellation cannot precede its signed agreement');
  const cancellation:any={id:h.id('ticket-cancellation'),event_id:event.id,source_notice_id:source,cancelled_at:at,reason,recorded_by:actor.id,external_event_id:a.external_event_id},result=h.cancel(event.id,reason);
  if(!result.document)h.fail('ticket_cancellation_document_missing','Cancellation must produce its original notice document',409);
  cancellation.document_id=result.document.id;Object.assign(result.document,{cancellation_id:cancellation.id,source_notice_id:source,external_event_id:a.external_event_id});event.cancellation_id=cancellation.id;(w.ticketCancellations??=[]).push(cancellation);
  h.emit('ticketing.cancellation_recorded',{cancellation_id:cancellation.id,event_id:event.id,document_id:result.document.id,source_notice_id:source});return done({cancellation,event:result.event,document:result.document});
}

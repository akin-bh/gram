/** Explicit ticket and processor source facts. Construction does not infer
 * ticket prices, tax rates, payout balances, refunds or approval decisions. */
import {z} from 'zod';
import type {World} from './world.ts';
import {blueprintRef as ref,blueprintName as name,blueprintTimestamp as timestamp} from './blueprint-support.ts';
import type {BlueprintValidationHooks,BlueprintMaterializationHooks} from './blueprint-support.ts';

const sourceId=z.string().min(1).max(200).refine(value=>value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value),'Use a nonempty source identifier without surrounding whitespace or control characters');
const positive=z.number().int().min(1).max(1e12),nonnegative=z.number().int().min(0).max(1e12);
const reservedIdentity=/^(?:(?:op|receipt|banktx|bank-activity|bank-account|pi|ch|card|txn|event|order|payout|topup|ticket-cancellation)_\d+|banktx-op_\d+|bank-opening|bank-sale-\d+|opening:bank-account_\d+)$/;
const externalId=sourceId.refine(value=>!reservedIdentity.test(value),'External sources cannot use generated canonical identity namespaces');
const event=z.object({ref,name,promoter_ref:ref,starts_at:timestamp,agreement_reference:sourceId,agreement_signed_at:timestamp}).strict();
const order=z.object({ref,event_ref:ref,customer_ref:ref,source_order_id:externalId,ordered_at:timestamp,quantity:z.number().int().min(1).max(1e6),face_minor:positive,tax_minor:nonnegative,fee_minor:nonnegative}).strict();
const payment=z.discriminatedUnion('outcome',[
  z.object({ref,order_ref:ref,source_payment_id:externalId,outcome:z.literal('captured'),amount_minor:positive,occurred_at:timestamp,processor_fee_minor:nonnegative,available_at:timestamp}).strict(),
  z.object({ref,order_ref:ref,source_payment_id:externalId,outcome:z.literal('voided'),amount_minor:positive,occurred_at:timestamp,processor_fee_minor:z.literal(0)}).strict(),
]);
const payout=z.object({ref,source_payout_id:externalId,source_bank_transaction_id:externalId,amount_minor:positive,paid_at:timestamp}).strict();
const topup=z.object({ref,source_topup_id:externalId,source_bank_transaction_id:externalId,amount_minor:positive,posted_at:timestamp}).strict();
const cancellation=z.object({ref,event_ref:ref,source_notice_id:externalId,cancelled_at:timestamp,reason:z.string().trim().min(1).max(2000)}).strict();

// No defaults: omitting the new sources preserves existing blueprint digests.
export const ticketingBlueprintShape={
  ticket_events:z.array(event).max(100).optional(),
  ticket_orders:z.array(order).max(200).optional(),
  ticket_payment_outcomes:z.array(payment).max(200).optional(),
  processor_payouts:z.array(payout).max(100).optional(),
  processor_topups:z.array(topup).max(100).optional(),
  ticket_cancellations:z.array(cancellation).max(100).optional(),
};
const schema=z.object(ticketingBlueprintShape).strict();
export type BlueprintTicketingInput=z.infer<typeof schema>;
type TicketingInput=BlueprintTicketingInput&{bank_activities?:{ref:string;source_transaction_id:string}[]};

export const TICKETING_BLUEPRINT_GENERATION_GUIDANCE=`For exact custom ticketing, use optional ticket_events, ticket_orders, ticket_payment_outcomes, processor_payouts, processor_topups and ticket_cancellations source arrays, not preset counts or prose. Keep cancelEvent=false with every blueprint. Each source has a globally unique local ref and counts toward the same200-record budget. Events cite an existing vendor promoter_ref, name, starts_at, agreement_reference and agreement_signed_at<=opening_at; event start must be after opening_at. The supported signed policy refunds admission plus explicitly sourced admission tax after cancellation; service fees remain earned. No statutory tax rate is inferred.
Orders cite event_ref, existing customer_ref, unique source_order_id, ordered_at, whole quantity1..1000000, and explicit face_minor>0,tax_minor>=0,fee_minor>=0. These components are TOTALS for the entire order, never per-ticket unit prices; quantity does not multiply them. Their exact sum must be at most1000000000000USD cents. Orders precede event start and cancellation. One optional full payment outcome per order cites order_ref, unique source_payment_id, outcome captured|voided, exact full amount_minor and occurred_at>=ordered_at. Captured outcomes require explicit processor_fee_minor0..gross and available_at>=occurred_at; availability may lie after as_of. Voided outcomes require processor_fee_minor0 and omit available_at. A genuinely pre-cancellation order can have a later captured or voided outcome; no new sale is allowed after cancellation. Capture recognizes net processor clearing, processor fee expense and ticket liability/earned fee; it does NOT imply a bank payout or cash receipt.
Processor payouts contain ref,unique source_payout_id,unique source_bank_transaction_id,amount_minor and paid_at. They observe an actual pooled USD processor-to-operating-bank payment, limited by available processor funds; never supply capture allocations, balances or automatic settlement flags. Processor topups contain ref,unique source_topup_id,unique source_bank_transaction_id,amount_minor and posted_at; they move actual available operating-bank funds into processor clearing. Topups cannot invent bank money or spend reserved cash. Source identifiers must not imitate generated operation/receipt/bank identity namespaces. These transfer sources create actual bank receipts; bank statement source_refs can cite typed processor_payout or processor_topup aliases, with independent explicit statement amounts.
Ticket cancellations contain ref,event_ref,unique source_notice_id,cancelled_at and reason. They create genuine source notice/document/mail authority, not refunds. All order/outcome/payout/topup/cancellation source times fall within opening_at..as_of, and the host executes each at its exact timestamp through controller source actions. Pooled availability, reservations and accounting bounds are enforced by the domain; an impossible payout/topup rejects the complete blueprint. Do not silently alter source amounts or dates to make it pass. Refund requests, controller reviews, clock settlement, communication and reconciliation remain subsequent work; never claim them completed in generated prose. Initial faults apply after this explicit construction history; period_closed preserves source facts with deferred actual GL posting.`;

export function registerBlueprintTicketingRefs(input:TicketingInput,h:BlueprintValidationHooks){
  for(const row of input.ticket_events??[])h.add(row,'event');
  for(const row of input.ticket_orders??[])h.add(row,'order');
  for(const row of input.ticket_payment_outcomes??[])h.add(row,'ticket_payment');
  for(const row of input.processor_payouts??[])h.add(row,'processor_payout');
  for(const row of input.processor_topups??[])h.add(row,'processor_topup');
  for(const row of input.ticket_cancellations??[])h.add(row,'ticket_cancellation');
}

/** Topology and immutable source arithmetic are preflighted. Pooled processor
 * availability and bank reservations remain actual domain-action checks. */
export function validateBlueprintTicketing(input:TicketingInput,h:BlueprintValidationHooks){
  const within=(at:string,rowRef:string,field:string)=>{
    if(at<h.openingAt||at>h.asOf)h.fail('invalid_blueprint_ticket_time',`${rowRef}.${field} must fall within opening_at..as_of`,{ref:rowRef,field,at});
  };
  const unique=(seen:Set<string>,value:string,rowRef:string,field:string)=>{
    if(seen.has(value))h.fail('duplicate_blueprint_ticket_source',`Repeated ${field}: ${value}`,{ref:rowRef,field});
    seen.add(value);
  };
  const cancellationTimes=new Map<string,string>(),sourceIds=new Set<string>((input.bank_activities??[]).map(row=>row.source_transaction_id));
  for(const row of input.ticket_events??[]){
    h.use(row.promoter_ref,'vendor',`${row.ref}.promoter_ref`);
    if(row.agreement_signed_at>h.openingAt||row.starts_at<=h.openingAt)h.fail('invalid_blueprint_ticket_time','A recorded event requires agreement_signed_at <= opening_at < starts_at',{ref:row.ref});
  }
  for(const row of input.ticket_cancellations??[]){
    h.use(row.event_ref,'event',`${row.ref}.event_ref`);within(row.cancelled_at,row.ref,'cancelled_at');
    if(cancellationTimes.has(row.event_ref))h.fail('duplicate_blueprint_ticket_cancellation','Only one cancellation source may name an event',{ref:row.ref,event_ref:row.event_ref});
    cancellationTimes.set(row.event_ref,row.cancelled_at);unique(sourceIds,row.source_notice_id,row.ref,'source_notice_id');
  }
  for(const row of input.ticket_orders??[]){
    const parent=h.use(row.event_ref,'event',`${row.ref}.event_ref`);h.use(row.customer_ref,'customer',`${row.ref}.customer_ref`);
    within(row.ordered_at,row.ref,'ordered_at');
    if(row.ordered_at>=parent.starts_at||(cancellationTimes.has(row.event_ref)&&row.ordered_at>=cancellationTimes.get(row.event_ref)!))h.fail('invalid_blueprint_ticket_time','Ticket orders must precede event start and cancellation',{ref:row.ref,event_ref:row.event_ref});
    const total=BigInt(row.face_minor)+BigInt(row.tax_minor)+BigInt(row.fee_minor);
    if(total>1_000_000_000_000n)h.fail('blueprint_ticket_amount_exceeded','Whole-order admission, tax and service fee totals must sum to at most 1000000000000 USD cents',{ref:row.ref});
    unique(sourceIds,row.source_order_id,row.ref,'source_order_id');
  }
  const paidOrders=new Set<string>();
  for(const row of input.ticket_payment_outcomes??[]){
    const parent=h.use(row.order_ref,'order',`${row.ref}.order_ref`);within(row.occurred_at,row.ref,'occurred_at');
    if(row.occurred_at<parent.ordered_at)h.fail('invalid_blueprint_ticket_time','Payment outcomes cannot precede the original order',{ref:row.ref,order_ref:row.order_ref});
    if(paidOrders.has(row.order_ref))h.fail('duplicate_blueprint_ticket_payment','An order may have only one full captured or voided source outcome',{ref:row.ref,order_ref:row.order_ref});
    paidOrders.add(row.order_ref);unique(sourceIds,row.source_payment_id,row.ref,'source_payment_id');
    if(BigInt(row.amount_minor)!==BigInt(parent.face_minor)+BigInt(parent.tax_minor)+BigInt(parent.fee_minor))h.fail('blueprint_ticket_payment_mismatch','The full source payment amount must equal the original whole-order total',{ref:row.ref,order_ref:row.order_ref});
    if(row.outcome==='captured'&&(row.processor_fee_minor>row.amount_minor||row.available_at<row.occurred_at))h.fail('invalid_blueprint_ticket_capture','Capture fees cannot exceed gross funds and availability cannot precede capture',{ref:row.ref});
  }
  for(const row of input.processor_topups??[]){within(row.posted_at,row.ref,'posted_at');unique(sourceIds,row.source_topup_id,row.ref,'source_topup_id');unique(sourceIds,row.source_bank_transaction_id,row.ref,'source_bank_transaction_id');}
  for(const row of input.processor_payouts??[]){within(row.paid_at,row.ref,'paid_at');unique(sourceIds,row.source_payout_id,row.ref,'source_payout_id');unique(sourceIds,row.source_bank_transaction_id,row.ref,'source_bank_transaction_id');}
}

export function materializeBlueprintTicketing(w:World,input:TicketingInput,h:BlueprintMaterializationHooks){
  const clockError=(message:string):never=>{throw Object.assign(new Error(message),{status:400,code:'blueprint_ticket_clock_mismatch'});};
  if((input.ticket_events?.length||input.ticket_orders?.length||input.ticket_payment_outcomes?.length||input.processor_payouts?.length||input.processor_topups?.length||input.ticket_cancellations?.length)&&w.now!==h.openingAt)clockError('Ticket sources must be scheduled from the opening construction clock');
  const schedule=(at:string,alias:string,priority:number,run:()=>void)=>h.schedule(at,alias,()=>{
    if(w.now!==at)clockError('A ticket source must execute at its exact declared timestamp');
    run();
  },priority);
  for(const row of input.ticket_events??[]){const {ref:alias,promoter_ref,...facts}=row;h.bind(alias,h.source(alias,{type:'record_ticket_event',promoter_id:h.id(promoter_ref),...facts}).event,'event');}
  for(const row of input.ticket_orders??[])schedule(row.ordered_at,row.ref,20,()=>{const {ref:alias,event_ref,customer_ref,...facts}=row;h.bind(alias,h.source(alias,{type:'record_ticket_order',event_id:h.id(event_ref),customer_id:h.id(customer_ref),...facts}).order,'order');});
  for(const row of input.ticket_payment_outcomes??[])schedule(row.occurred_at,row.ref,25,()=>{const {ref:alias,order_ref,...facts}=row;h.bind(alias,h.source(alias,{type:'record_ticket_payment',order_id:h.id(order_ref),...facts}).payment,'ticket_payment');});
  for(const row of input.processor_topups??[])schedule(row.posted_at,row.ref,45,()=>{const {ref:alias,...facts}=row;h.bind(alias,h.source(alias,{type:'record_processor_topup',...facts}).topup,'processor_topup');});
  for(const row of input.processor_payouts??[])schedule(row.paid_at,row.ref,50,()=>{const {ref:alias,...facts}=row;h.bind(alias,h.source(alias,{type:'record_processor_payout',...facts}).payout,'processor_payout');});
  for(const row of input.ticket_cancellations??[])schedule(row.cancelled_at,row.ref,60,()=>{const {ref:alias,event_ref,...facts}=row;h.bind(alias,h.source(alias,{type:'record_ticket_cancellation',event_id:h.id(event_ref),...facts}).cancellation,'ticket_cancellation');});
}

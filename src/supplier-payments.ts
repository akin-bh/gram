/** Controller-observed supplier route succession and terminal bank outcomes.
 * Original commercial sources and accepted payment routes remain immutable;
 * a successor never retargets an already accepted payment. */
import {createHash} from 'node:crypto';
import type {World,Action,Actor} from './world.ts';

export const supplierPaymentRequirements={
  record_supplier_route:{role:'controller',system:'mercury',external:true},
  cancel_bill_payment:{role:'controller',system:'mercury',external:true},
  reject_bill_payment:{role:'controller',system:'mercury',external:true},
} as const;
export const supplierPaymentCollections={'supplier-route':'supplierRoutes','supplier-route-hold':'supplierRouteHolds','bill-payment-outcome':'billPaymentOutcomes'} as const;
export const supplierPaymentFeeds=Object.keys(supplierPaymentCollections);
export type SupplierPaymentHooks={
  id:(prefix:string)=>string;
  fail:(code:string,message:string,status?:number)=>never;
  emit:(type:string,data?:any)=>void;
  document:(type:string,name:string,body:string,refs:any)=>any;
};
export type SupplierPaymentBinding={beneficiary_id:string;route_source_id:string|null;route_source_fingerprint:string;requires_independent_approval:boolean};
export type SupplierRouteHoldSource={kind:'return'|'rejection';source_id:string;reason:string};
const canonical=(value:any):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const fingerprint=(value:any)=>createHash('sha256').update(canonical(value)).digest('hex');
function text(value:any,label:string,h:SupplierPaymentHooks,max=200){
  if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value))h.fail('invalid_supplier_payment_field',`${label} must be nonempty text without surrounding whitespace or control characters`,400);
  return value as string;
}
function lookup(rows:any[],id:any,label:string,h:SupplierPaymentHooks){return rows.find(row=>row.id===id)??h.fail('not_found',`${label} not found`,404);}
function billVendor(w:World,bill:any,h:SupplierPaymentHooks){
  if(!bill||bill.currency!=='USD'||bill.approved_source!==true||typeof bill.beneficiary_id!=='string'||!bill.beneficiary_id)h.fail('unverified_beneficiary','Payment requires an approved USD bill retaining its original supplier route',403);
  return lookup(w.vendors,bill.vendor_id,'Vendor',h);
}
function routeRecord(w:World,vendor:any,id:string,h:SupplierPaymentHooks){
  const rows=(w.supplierRoutes??[]).filter((row:any)=>row.id===id);
  if(rows.length>1||rows.some((row:any)=>row.vendor_id!==vendor.id))h.fail('invalid_supplier_route_source','Supplier route identity must belong uniquely to its original vendor',409);
  const row=rows[0];
  if(!row&&id.startsWith('supplier-route_'))h.fail('invalid_supplier_route_source','Verified successor route source is missing',409);
  return row;
}
/** Legacy operations use their accepted route, or the immutable bill source.
 * Never substitute the vendor's latest route for missing historical evidence. */
export function supplierPaymentOperationRoute(w:World,operation:any,h:SupplierPaymentHooks):string{
  if(operation?.type!=='pay_bill'||operation.currency!=='USD')h.fail('invalid_bill_payment_operation','A supplier outcome must name a USD bill-payment operation',409);
  const bill=lookup(w.bills,operation.target_id,'Bill',h);billVendor(w,bill,h);
  const route=operation.supplier_route?.beneficiary_id??operation.verified_counterparty_route??bill.beneficiary_id;
  if(typeof route!=='string'||!route||(operation.supplier_route&&operation.verified_counterparty_route&&operation.verified_counterparty_route!==route))h.fail('invalid_supplier_route_source','Accepted supplier route evidence is inconsistent',409);
  return route;
}
function heldSources(w:World,vendor:any,routeId:string,h:SupplierPaymentHooks):{id:string;at:string}[]{
  const held=(w.supplierRouteHolds??[]).filter((row:any)=>row.vendor_id===vendor.id&&row.route_id===routeId).map((row:any)=>({id:row.id,at:row.recorded_at}));
  // Old persisted returns are already source evidence. Reading their effect
  // must not backfill arrays or permit a retry merely because holds are new.
  for(const record of w.paymentReturns??[]){
    const bill=w.bills.find(row=>row.id===record.bill_id);if(bill?.vendor_id!==vendor.id)continue;
    const original=lookup(w.operations,record.original_operation_id,'Returned payment operation',h);
    if(supplierPaymentOperationRoute(w,original,h)===routeId)held.push({id:record.id,at:record.returned_at});
  }
  for(const record of w.billPaymentOutcomes??[])if(record.vendor_id===vendor.id&&record.beneficiary_id===routeId&&record.kind==='rejected'&&record.rejection_code==='invalid_beneficiary')held.push({id:record.id,at:record.recorded_at});
  return held;
}
function lineage(w:World,vendor:any,current:string,original:string,h:SupplierPaymentHooks){
  const visited=new Set<string>();let id=current;
  while(true){
    if(visited.has(id))h.fail('invalid_supplier_route_source','Supplier route lineage cannot contain a cycle',409);visited.add(id);
    const row=routeRecord(w,vendor,id,h);
    if(id===original)return;
    if(!row||typeof row.previous_route_id!=='string'||!row.previous_route_id)h.fail('unverified_beneficiary','Verified successor does not descend from the bill original supplier route',403);
    id=row.previous_route_id;
  }
}
/** A detached, deterministic source binding. Status and mutable names are not
 * part of its hash; changing either cannot create a new payment authority. */
export function resolveSupplierPaymentRoute(w:World,bill:any,h:SupplierPaymentHooks):SupplierPaymentBinding{
  const vendor=billVendor(w,bill,h),current=text(vendor.verified_bank_account,'verified supplier route',h);
  lineage(w,vendor,current,bill.beneficiary_id,h);
  if(vendor.status==='disabled')h.fail('counterparty_disabled','The verified supplier route is disabled',409);
  if(heldSources(w,vendor,current,h).length)h.fail('supplier_route_on_hold','This supplier route has a bank return or invalid-beneficiary rejection; record a verified successor before retrying',409);
  const source=routeRecord(w,vendor,current,h),authority=source??{vendor_id:vendor.id,beneficiary_id:current,...(vendor.external_vendor_id?{external_vendor_id:vendor.external_vendor_id}:{})};
  const retried=(w.billPaymentOutcomes??[]).some((row:any)=>row.bill_id===bill.id)||(w.paymentReturns??[]).some((row:any)=>row.bill_id===bill.id);
  return {beneficiary_id:current,route_source_id:source?.id??null,route_source_fingerprint:fingerprint(authority),requires_independent_approval:!!source||retried};
}
export function validateSupplierPaymentBinding(w:World,bill:any,binding:any,h:SupplierPaymentHooks,accepted=false):SupplierPaymentBinding{
  const current=resolveSupplierPaymentRoute(w,bill,h);
  if(!binding||typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).some(key=>!['beneficiary_id','route_source_id','route_source_fingerprint','requires_independent_approval'].includes(key))||typeof binding.requires_independent_approval!=='boolean'||binding.beneficiary_id!==current.beneficiary_id||binding.route_source_id!==current.route_source_id||binding.route_source_fingerprint!==current.route_source_fingerprint||(!accepted&&current.requires_independent_approval&&!binding.requires_independent_approval))h.fail('supplier_payment_source_changed','The accepted supplier route or retry authority has changed; request a fresh independently reviewed payment',409);
  return current;
}
export function holdSupplierPaymentRoute(w:World,operation:any,source:SupplierRouteHoldSource,h:SupplierPaymentHooks){
  const route=supplierPaymentOperationRoute(w,operation,h),bill=lookup(w.bills,operation.target_id,'Bill',h),vendor=billVendor(w,bill,h);
  if(!['return','rejection'].includes(source.kind))h.fail('invalid_supplier_route_hold','Unsupported supplier route hold source',400);
  const record=lookup(source.kind==='return'?(w.paymentReturns??[]):(w.billPaymentOutcomes??[]),source.source_id,'Bank outcome source',h);
  if((source.kind==='return'?record.original_operation_id:record.operation_id)!==operation.id||(source.kind==='rejection'&&(record.kind!=='rejected'||record.rejection_code!=='invalid_beneficiary')))h.fail('invalid_supplier_route_hold','Hold must cite the exact original payment return or invalid-beneficiary rejection',409);
  const previous=(w.supplierRouteHolds??[]).find((row:any)=>row.source_kind===source.kind&&row.source_id===source.source_id);
  if(previous){if(previous.route_id!==route||previous.vendor_id!==vendor.id||previous.operation_id!==operation.id)h.fail('invalid_supplier_route_hold','Existing hold cannot be reassigned to another route',409);return previous;}
  const hold:any={id:h.id('supplier-hold'),vendor_id:vendor.id,route_id:route,operation_id:operation.id,bill_id:bill.id,source_kind:source.kind,source_id:source.source_id,reason:text(source.reason,'reason',h,2000),recorded_at:w.now,external_event_id:record.external_event_id};
  const document=h.document('supplier-route-hold',`Supplier route suspended: ${vendor.name}`,`Bank ${source.kind} source ${record.id} suspends the exact accepted supplier route ${route}. Existing accepted payments keep their reservations until a bank-confirmed terminal outcome; no payment has been redirected or cancelled by this hold. A verified successor is separate controller evidence.`,{vendor_id:vendor.id,route_id:route,hold_id:hold.id,source_id:record.id,operation_id:operation.id});hold.document_id=document.id;
  (w.supplierRouteHolds??=[]).push(hold);h.emit('supplier.route_held',{hold_id:hold.id,vendor_id:vendor.id,route_id:route,operation_id:operation.id,source_kind:source.kind,source_id:source.source_id,document_id:document.id});return hold;
}
const allowed={record_supplier_route:['vendor_id','previous_route_id','verification_reference','verified_at','verification_method','destination_reference','reason','external_event_id'],cancel_bill_payment:['operation_id','bank_reference','reason','external_event_id'],reject_bill_payment:['operation_id','rejection_code','bank_reference','reason','external_event_id']} as const;
export function supplierPaymentAction(w:World,action:Action,actor:Actor,h:SupplierPaymentHooks):{handled:boolean;result?:any}{
  const type=action.type??action.action;if(!type||!Object.hasOwn(supplierPaymentRequirements,type))return {handled:false};
  if(actor.role!=='controller')h.fail('controller_required','Supplier route verification and bank outcomes require a controller source',403);
  if(Object.keys(action).some(key=>!['type','action',...allowed[type as keyof typeof allowed]].includes(key))||(action.type&&action.action&&action.type!==action.action))h.fail('invalid_supplier_payment_field','Unsupported supplier payment source field',400);
  text(action.external_event_id,'external_event_id',h);const reason=text(action.reason,'reason',h,2000);
  if(type==='record_supplier_route'){
    const vendor=lookup(w.vendors,text(action.vendor_id,'vendor_id',h),'Vendor',h),previous=text(action.previous_route_id,'previous_route_id',h);
    if(previous!==vendor.verified_bank_account)h.fail('supplier_route_version_conflict','The predecessor must be the vendor current verified route',409);
    const predecessor=routeRecord(w,vendor,previous,h),at=action.verified_at;
    if(typeof at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at||at>w.now||at<(predecessor?.recorded_at??vendor.recorded_at??w.bankTransactions.find(row=>row.id==='bank-opening')?.posted_at??w.now)||heldSources(w,vendor,previous,h).some(row=>row.at>at))h.fail('invalid_supplier_verification_time','Verification must be exact UTC, no earlier than its predecessor and observed holds, and no later than simulation time',400);
    if(!['callback_on_file','bank_portal'].includes(action.verification_method))h.fail('invalid_supplier_verification_method','Use an independent callback on file or bank portal source',400);
    const verification=text(action.verification_reference,'verification_reference',h),destination=text(action.destination_reference,'destination_reference',h);
    if((w.supplierRoutes??[]).some((row:any)=>row.vendor_id===vendor.id&&row.verification_reference===verification))h.fail('duplicate_supplier_verification','A new successor requires a new independent verification source reference',409);
    const route:any={id:h.id('supplier-route'),vendor_id:vendor.id,previous_route_id:previous,verification_reference:verification,verified_at:at,verification_method:action.verification_method,destination_reference:destination,reason,contact_snapshot:{vendor_id:vendor.id,email:vendor.email??null},recorded_at:w.now,recorded_by:actor.id,external_event_id:action.external_event_id};
    const document=h.document('verified-supplier-route',`Verified successor route: ${vendor.name}`,`Controller ${actor.id} records independent ${route.verification_method} verification ${verification} at ${at}, using original vendor contact ${vendor.email??'(no email on file)'}. Synthetic destination reference ${destination}; the host route ${route.id} succeeds ${previous}. Original bill and contract beneficiary fields are preserved. No accepted payment is redirected; new payments require independent review. ${reason}`,{route_id:route.id,vendor_id:vendor.id,previous_route_id:previous,external_event_id:action.external_event_id});route.document_id=document.id;
    (w.supplierRoutes??=[]).push(route);vendor.verified_bank_account=route.id;h.emit('supplier.route_verified',{route_id:route.id,vendor_id:vendor.id,previous_route_id:previous,document_id:document.id});return {handled:true,result:{route,vendor,document}};
  }
  const operation=lookup(w.operations,text(action.operation_id,'operation_id',h),'Bill payment operation',h),beneficiary=supplierPaymentOperationRoute(w,operation,h),bill=lookup(w.bills,operation.target_id,'Bill',h);
  if(operation.status!=='pending'||operation.receipt_id||operation.journal_id||w.bankTransactions.some(row=>row.source_id===operation.id)||w.journals.some(row=>row.source_id===operation.id))h.fail('bill_payment_not_pending','Only an accepted pending payment without settlement evidence can receive this bank outcome',409);
  const bankReference=text(action.bank_reference,'bank_reference',h),kind=type==='cancel_bill_payment'?'cancelled':'rejected';
  if(kind==='rejected'&&!['invalid_beneficiary','insufficient_funds','bank_rejected'].includes(action.rejection_code))h.fail('invalid_bill_payment_rejection','Unsupported bank rejection code',400);
  if((w.billPaymentOutcomes??[]).some((row:any)=>row.bank_reference===bankReference))h.fail('duplicate_bill_payment_outcome','Bank outcome reference already identifies another terminal source',409);
  const outcome:any={id:h.id('bill-payment-outcome'),kind,operation_id:operation.id,bill_id:bill.id,vendor_id:bill.vendor_id,beneficiary_id:beneficiary,amount_minor:operation.amount_minor,currency:'USD',bank_reference:bankReference,reason,...(kind==='rejected'?{rejection_code:action.rejection_code}:{}),recorded_at:w.now,recorded_by:actor.id,external_event_id:action.external_event_id};
  const document=h.document('bill-payment-outcome',`Bill payment ${kind}: ${bill.id}`,`Bank source ${bankReference} confirms payment ${operation.id} to original accepted route ${beneficiary} was ${kind} before settlement. Amount ${operation.amount_minor} USD cents is released from reservation only; cash, payable and original payment approvals are unchanged. Any retry is a new independently reviewed request. ${reason}`,{outcome_id:outcome.id,operation_id:operation.id,bill_id:bill.id,vendor_id:bill.vendor_id,external_event_id:action.external_event_id});outcome.document_id=document.id;
  (w.billPaymentOutcomes??=[]).push(outcome);operation.status=kind;operation.outcome_id=outcome.id;operation[`${kind}_at`]=w.now;delete operation.last_error;
  const hold=kind==='rejected'&&action.rejection_code==='invalid_beneficiary'?holdSupplierPaymentRoute(w,operation,{kind:'rejection',source_id:outcome.id,reason},h):undefined;
  h.emit(`supplier.payment_${kind}`,{outcome_id:outcome.id,operation_id:operation.id,bill_id:bill.id,vendor_id:bill.vendor_id,beneficiary_id:beneficiary,amount_minor:operation.amount_minor,document_id:document.id});return {handled:true,result:{outcome,operation,bill,document,...(hold?{hold}:{})}};
}

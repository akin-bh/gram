/** Selected Mercury v1 contracts, checked against official documentation on
 * 2026-10-24. Approval requests are not transactions. Accepted instructions
 * are not bank receipts; only canonical cash rows prove settlement.
 * No real bank, recipient routing details, fee, approval or cancellation API
 * is simulated by this adapter. Controller source actions retain authority.
 */
import {DomainError,summarize} from './world.ts';
import type {World} from './world.ts';
import type {ProviderRequest,ProviderResponse} from './provider-adapters.ts';
import {formatMinor,parseMajor} from './money.ts';
import {resolveSupplierPaymentRoute,supplierPaymentOperationRoute,validateSupplierPaymentBinding} from './supplier-payments.ts';
import type {SupplierPaymentHooks} from './supplier-payments.ts';

const DOC='https://docs.mercury.com/reference/';
const limitations=[
 'Canonical synthetic IDs are retained; no external Mercury UUID, ACH tracking number or real account details are invented.',
 'Creation supports only source-linked USD ACH requests from cash-bank, with mandatory independent controller approval. A successful request is not cash settlement.',
 'Controller source actions record route verification, cancellation and bank rejection; no native approval or cancellation write is implemented.',
 'Legacy plural transaction paths are compatibility aliases. Unspecified transaction dates include all canonical history; supported explicit filters are applied, never ignored.',
 'Fields without source evidence, including bank delivery estimates, receipt-policy compliance and external accounting sync status, are omitted explicitly.',
];
const read=(id:string,path:string,description:string,reference:string)=>({id:`mercury.${id}`,system:'mercury',method:'GET' as const,path,access:'read' as const,description,documentation:[DOC+reference],limitations});
export const providerMercuryRoutes=[
 read('accounts.list','/api/v1/accounts','Read actual native balances and shared reservations. Supports limit and start_after.','getaccounts'),
 read('transactions.list','/api/v1/accounts/:account_id/transactions','Compatibility plural alias for account transaction reads, including pending accepted instructions without cash receipts. Supports limit,offset,order,status,search,start,end,requestId.','listaccounttransactions'),
 read('transactions.get','/api/v1/transaction/:id','Read an actual bank transaction or accepted instruction by its stable transaction ID. No receipt is implied before settlement.','gettransactionbyid'),
 read('account.transactions.list','/api/v1/account/:account_id/transactions','Read account transactions and accepted instructions. Supports limit1..1000(default1000),offset,order=asc|desc(defaultdesc),status,search,start,end,requestId. Date filters use createdAt; omitted dates retain all canonical history.','listaccounttransactions'),
 read('transactions.detail','/api/v1/transactions/:id','Compatibility plural alias for transaction detail; pending, cancelled and rejected instructions do not create cash rows.','gettransactionbyid'),
 read('account.transactions.get','/api/v1/account/:account_id/transaction/:id','Read one transaction with exact source-account ownership.','gettransaction'),
 read('approval_requests.list','/api/v1/request-send-money','List actual bill-payment approvals. Supports accountId,status=pendingApproval|approved|rejected|cancelled,limit1..1000(default1000),and mutually exclusive start_after/end_before.','listsendmoneyapprovalrequests'),
 read('approval_requests.get','/api/v1/request-send-money/:request_id','Read actual approval history, frozen bill/route authority and separate accepted-instruction state. requestId is the canonical approval ID.','getsendmoneyapprovalrequest'),
 {id:'mercury.approval_requests.create',system:'mercury',method:'POST' as const,path:'/api/v1/account/:account_id/request-send-money',access:'write' as const,description:'Request a source-backed USD ACH bill payment. Body requires recipientId (vendor ID), amount (exact USD number), paymentMethod:"ach", idempotencyKey and finance_world:{bill_id}; note is optional. Always requires independent controller approval. No raw routing or fees.',documentation:[DOC+'requestsendmoney','https://docs.mercury.com/docs/send-money'],limitations},
] as const;
const fail=(code:string,message:string,status=400):never=>{throw new DomainError(status,code,message);};
const find=(rows:any[],id:string,label:string)=>rows.find(row=>row.id===id)??fail('resource_missing',`${label} does not exist in this world`,404);
function decode(raw:string){try{const id=decodeURIComponent(raw);if(!id||id.length>200||/[\u0000-\u001f\u007f/\\]/.test(id))fail('invalid_parameter','Invalid resource identifier');return id;}catch(error){if(error instanceof DomainError)throw error;return fail('invalid_parameter','Malformed resource identifier');}}
function query(url:URL,allowed:string[]){for(const key of url.searchParams.keys()){if(!allowed.includes(key))fail('unsupported_filter',`Unsupported Mercury subset query: ${key}`,501);if(url.searchParams.getAll(key).length!==1)fail('duplicate_parameter',`Repeated query: ${key}`);}}
function fields(value:any,allowed:string[]){if(!value||typeof value!=='object'||Array.isArray(value))fail('invalid_body','Expected an object body');for(const key of Object.keys(value))if(!allowed.includes(key))fail('unsupported_field',`Unsupported Mercury subset field: ${key}`,501);}
function text(value:any,label:string,max=200){if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))fail('invalid_parameter',`${label} must be nonempty bounded text without surrounding whitespace or control characters`);return value as string;}
function integer(raw:string|null,label:string,fallback:number,max:number,min=1){if(raw===null)return fallback;if(!/^(0|[1-9]\d*)$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<min||Number(raw)>max)fail('invalid_parameter',`${label} must be an integer in ${min}..${max}`);return Number(raw);}
function amount(value:any){if(typeof value!=='number'||!Number.isFinite(value)||value<=0)fail('invalid_amount','amount must be a positive exact USD number');try{return parseMajor(String(value),'USD');}catch{ return fail('invalid_amount','amount must contain exact USD cents and be at most 10000000000 USD');}}
function major(minor:number,currency:string){try{const result=Number(formatMinor(minor,currency));if(parseMajor(String(result),currency,Number.MAX_SAFE_INTEGER)!==minor)fail('unrepresentable_native_amount','Amount cannot be represented exactly as a native numeric amount',409);return result;}catch(error){if(error instanceof DomainError)throw error;return fail('invalid_monetary_record','Stored native amount is not exact',409);}}
function date(raw:string|null,label:string,end=false){if(raw===null)return undefined;const day=/^\d{4}-\d{2}-\d{2}$/.test(raw);if(!day&&!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw))fail('invalid_parameter',`${label} must be a real ISO date or timestamp`);const time=Date.parse(raw),calendar=Date.parse(raw.slice(0,10));if(!Number.isFinite(time)||!Number.isFinite(calendar)||new Date(calendar).toISOString().slice(0,10)!==raw.slice(0,10))fail('invalid_parameter',`${label} is not a real date`);return time+(day&&end?86400000-1:0);}
const billApprovals=(w:World)=>(w.approvals??[]).filter(a=>a.action?.type==='pay_bill');
function approvalFor(w:World,operation:any){return billApprovals(w).find(a=>a.id===operation?.approval_id||a.operation_id===operation?.id);}
function operationFor(w:World,approval:any){return w.operations.find(op=>op.type==='pay_bill'&&(op.id===approval.operation_id||op.approval_id===approval.id));}
const readOnlyHooks:SupplierPaymentHooks={fail,id:()=>fail('read_only_projection','A native read cannot allocate source records',500),emit:()=>fail('read_only_projection','A native read cannot emit events',500),document:()=>fail('read_only_projection','A native read cannot create source documents',500)};
/** Re-evaluate source eligibility without advancing an instruction or filling
 * migration arrays. last_error is historical; current_blocker is observed now. */
function currentBlocker(w:World,bill:any,binding:any,operation?:any){
 try{
  if(w.bankAccounts.find((a:any)=>a.id==='cash-bank')?.status==='disabled')fail('bank_route_disabled','The operating bank account is disabled',409);
  const current=resolveSupplierPaymentRoute(w,bill,readOnlyHooks);
  if(operation){
   const id=operation.bank_transaction_id??`banktx-${operation.id}`;
   if(w.bankTransactions.some(row=>[row.id,row.source_id,row.source_transaction_id,row.receipt_id,row.external_event_id].includes(id)))fail('bank_transaction_identity_conflict','The accepted transaction identity collides with an existing source',409);
   if(supplierPaymentOperationRoute(w,operation,readOnlyHooks)!==current.beneficiary_id)fail('counterparty_route_unavailable','The accepted supplier route is no longer current; obtain a bank-confirmed terminal outcome before replacement',409);
   if(binding)validateSupplierPaymentBinding(w,bill,binding,readOnlyHooks,true);
   else if(current.route_source_id)fail('supplier_payment_source_changed','A historical instruction cannot adopt a successor without new source-bound review',409);
  }else if(binding)validateSupplierPaymentBinding(w,bill,binding,readOnlyHooks);
  else if(current.requires_independent_approval)fail('supplier_payment_source_changed','The historical approval has no binding to the current route or recovery source',409);
  for(const system of ['bank','mercury']){const mode=w.faults?.[system]?.mode??'healthy';if(mode!=='healthy')return {code:'connection_unavailable',message:`${system} connection is ${mode}`,system,mode};}
  return null;
 }catch(error){if(!(error instanceof DomainError))throw error;return {code:error.code,message:error.message};}
}
function supplierEvidence(w:World,bill:any,acceptedRoute?:string){
 const vendor=find(w.vendors,bill.vendor_id,'Supplier'),routes=new Set<string>([acceptedRoute,bill.beneficiary_id,vendor.verified_bank_account].filter(Boolean));
 for(const id of routes){const source=(w.supplierRoutes??[]).find((r:any)=>r.id===id&&r.vendor_id===vendor.id);if(source?.previous_route_id)routes.add(source.previous_route_id);}
 const sources=new Set<string>(),holds=(w.supplierRouteHolds??[]).filter((h:any)=>h.vendor_id===vendor.id&&routes.has(h.route_id));
 for(const hold of holds)sources.add(hold.source_id);
 for(const returned of w.paymentReturns??[]){const original=w.operations.find(op=>op.id===returned.original_operation_id),sourceBill=w.bills.find(b=>b.id===returned.bill_id);if(!original||sourceBill?.vendor_id!==vendor.id)continue;const route=original.supplier_route?.beneficiary_id??original.verified_counterparty_route??sourceBill.beneficiary_id;if(routes.has(route))sources.add(returned.id);}
 for(const outcome of w.billPaymentOutcomes??[])if(outcome.vendor_id===vendor.id&&routes.has(outcome.beneficiary_id)&&outcome.kind==='rejected'&&outcome.rejection_code==='invalid_beneficiary')sources.add(outcome.id);
 const holdIds=new Set(holds.map((h:any)=>h.id));
 const documents=w.documents.filter(doc=>doc.id===bill.document_id||doc.bill_id===bill.id||routes.has(doc.route_id)||holdIds.has(doc.hold_id)||sources.has(doc.return_id)||sources.has(doc.outcome_id)||sources.has(doc.source_id));
 return {route_hold_ids:[...holdIds],route_hold_source_ids:[...sources],source_document_ids:[...new Set(documents.map(doc=>doc.id))]};
}
function instruction(w:World,operation:any,bank?:any){
 const bill=find(w.bills,operation.target_id,'Payment bill'),vendor=find(w.vendors,bill.vendor_id,'Supplier'),approval=approvalFor(w,operation),outcome=(w.billPaymentOutcomes??[]).find((row:any)=>row.id===operation.outcome_id),route=operation.supplier_route?.beneficiary_id??operation.verified_counterparty_route??bill.beneficiary_id;
 const returns=(w.paymentReturns??[]).filter((row:any)=>row.original_operation_id===operation.id),evidence=supplierEvidence(w,bill,route);
 if(outcome?.document_id&&!evidence.source_document_ids.includes(outcome.document_id))evidence.source_document_ids.push(outcome.document_id);
 return {canonical_status:operation.status,bill_id:bill.id,vendor_id:vendor.id,operation_id:operation.id,approval_id:approval?.id??null,bank_transaction_id:bank?.id??null,planned_bank_transaction_id:operation.bank_transaction_id??`banktx-${operation.id}`,receipt_id:bank?.receipt_id??null,journal_id:operation.journal_id??null,amount_minor:operation.amount_minor,currency:operation.currency,bank_cash_effect_minor:bank?.amount_minor??0,beneficiary_id:route,supplier_route:structuredClone(operation.supplier_route??null),...evidence,current_supplier_route_id:vendor.verified_bank_account,current_supplier_enabled:vendor.status!=='disabled',current_blocker:operation.status==='pending'?currentBlocker(w,bill,operation.supplier_route,operation):null,last_error:operation.last_error??null,outcome:structuredClone(outcome??null),return_ids:returns.map((row:any)=>row.id),amount_returned_minor:operation.amount_returned_minor??0,status_semantics:'Pending/terminal instructions carry planned amounts, not cash. Only bank_transaction_id and receipt_id identify actual settlement; a return is a separate cash event. current_blocker checks current source and provider eligibility without predicting settlement or changing the historical last_error.'};
}
function requestShape(w:World,approval:any){
 const bill=find(w.bills,approval.action.bill_id,'Approval bill'),vendor=find(w.vendors,bill.vendor_id,'Supplier'),operation=operationFor(w,approval),request=(w.billPaymentRequests??[]).find((row:any)=>row.approval_id===approval.id),paymentMethod=request?.payment_method??approval.action.payment_method??operation?.payment_method;
 const bank=operation?w.bankTransactions.find(row=>row.source_id===operation.id):undefined;
 if(!['pending','approved','rejected','cancelled'].includes(approval.status))fail('invalid_approval_record','Unknown bill approval status',409);
 const reviews=approval.decided_at&&['approved','rejected'].includes(approval.status)?[{reviewerUserId:approval.decided_by,status:approval.status,reviewedAt:approval.decided_at}]:[];
 return {accountId:'cash-bank',requestId:approval.id,recipientId:vendor.id,...(paymentMethod?{paymentMethod}:{}),amount:major(approval.amount_minor,'USD'),status:approval.status==='pending'?'pendingApproval':approval.status,requestedByUserId:approval.requested_by,reviews,createdAt:approval.created_at,memo:request?.note??approval.action.note??null,numberOfApproversRequired:1,requesterMayApprove:false,scheduledSendDate:null,finance_world:{approval_id:approval.id,bill_id:bill.id,vendor_id:vendor.id,currency:'USD',amount_minor:approval.amount_minor,request_id:request?.id??null,payment_method:paymentMethod??null,operation_id:operation?.id??null,instruction:operation?instruction(w,operation,bank):null,supplier_route:structuredClone(approval.action.supplier_route??null),current_blocker:approval.status==='pending'?currentBlocker(w,bill,approval.action.supplier_route):null,...supplierEvidence(w,bill,approval.action.supplier_route?.beneficiary_id??approval.action.beneficiary_id),unsupported_fields:paymentMethod?[]:['paymentMethod: legacy approval has no recorded payment rail'],scope:limitations}};
}
function transactionShape(w:World,bank:any|undefined,operation:any|undefined){
 const bill=operation?.type==='pay_bill'?find(w.bills,operation.target_id,'Payment bill'):undefined,vendor=bill?find(w.vendors,bill.vendor_id,'Supplier'):undefined,outcome=operation?(w.billPaymentOutcomes??[]).find((row:any)=>row.id===operation.outcome_id):undefined,approval=operation?approvalFor(w,operation):undefined;
 if(!bank&&!operation)fail('invalid_transaction_record','Transaction has neither cash source nor accepted instruction',409);
 const status=bank?'sent':operation.status==='pending'?'pending':operation.status==='cancelled'?'cancelled':operation.status==='rejected'?'failed':fail('invalid_transaction_record','Unsettled instruction has no valid bank state',409);
 const request=(w.billPaymentRequests??[]).find((row:any)=>row.approval_id===approval?.id),note=request?.note??operation?.note;
 const rowId=bank?.id??operation.bank_transaction_id??`banktx-${operation.id}`,currency=bank?.currency??operation.currency,description=bank?.description??note??bill?.description??'Supplier payment instruction';
 const returned=(w.paymentReturns??[]).filter((r:any)=>r.original_operation_id===operation?.id),originalReturn=(w.paymentReturns??[]).find((r:any)=>r.operation_id===bank?.source_id);
 const related=returned.flatMap((r:any)=>{const row=w.bankTransactions.find(t=>t.source_id===r.operation_id);return row?[{id:row.id,accountId:row.account_id,amount:major(row.amount_minor,row.currency),relationKind:'OriginalTransactionToReturn'}]:[];});
 if(originalReturn){const row=w.bankTransactions.find(t=>t.source_id===originalReturn.original_operation_id);if(row)related.push({id:row.id,accountId:row.account_id,amount:major(row.amount_minor,row.currency),relationKind:'ReturnToOriginalTransaction'});}
 const activity=(w.bankActivities??[]).find((a:any)=>a.bank_transaction_id===bank?.id);
 return {id:rowId,accountId:bank?.account_id??'cash-bank',amount:major(bank?.amount_minor??-operation.amount_minor,currency),currency,status,createdAt:operation?.created_at??bank.posted_at,postedAt:bank?.posted_at??null,failedAt:status==='failed'?(operation.rejected_at??outcome?.recorded_at??null):null,reasonForFailure:status==='failed'?(outcome?.reason??null):null,kind:bill?'outgoingPayment':activity?.kind==='interest'?'interestPayment':(bank.amount_minor<0?'outgoingPayment':'other'),...(vendor?{counterpartyId:vendor.id}:{}),counterpartyName:vendor?.name??description,note:note??description,externalMemo:bank?.source_id??operation.id,hasGeneratedReceipt:!!bank?.receipt_id,requestId:approval?.id??null,attachments:[],relatedTransactions:related,finance_world:bill?instruction(w,operation,bank):{bank_transaction_id:bank.id,receipt_id:bank.receipt_id??null,operation_id:operation?.id??null,source_id:bank.source_id,amount_minor:bank.amount_minor,currency,bank_cash_effect_minor:bank.amount_minor,canonical_status:bank.status,unsupported_fields:['external bank delivery estimates','receipt policy compliance','external accounting sync status']}};
}
function transactions(w:World){
 const rows=w.bankTransactions.map(bank=>transactionShape(w,bank,w.operations.find(op=>op.id===bank.source_id)));
 for(const operation of w.operations.filter(op=>op.type==='pay_bill'&&op.status!=='settled')){
  if(!['pending','cancelled','rejected'].includes(operation.status))continue;
  if(w.bankTransactions.some(bank=>bank.source_id===operation.id))fail('invalid_transaction_record','Unsettled instruction unexpectedly has a cash receipt',409);
  const row=transactionShape(w,undefined,operation);if(rows.some(existing=>existing.id===row.id))fail('invalid_transaction_record','Pending transaction identity collides with an existing cash row',409);rows.push(row);
 }
 return rows;
}
function requestPage(rows:any[],url:URL){
 const limit=integer(url.searchParams.get('limit'),'limit',1000,1000),after=url.searchParams.get('start_after'),before=url.searchParams.get('end_before');if(after!==null&&before!==null)fail('invalid_cursor','start_after and end_before are mutually exclusive');
 let start=0,end=rows.length;
 if(after!==null){const index=rows.findIndex(row=>row.requestId===after);if(index<0)fail('invalid_cursor','Unknown approval cursor');start=index+1;end=Math.min(rows.length,start+limit);}
 else if(before!==null){end=rows.findIndex(row=>row.requestId===before);if(end<0)fail('invalid_cursor','Unknown approval cursor');start=Math.max(0,end-limit);}
 else end=Math.min(rows.length,limit);
 const selected=rows.slice(start,end);return {requests:selected,page:{...(selected.length&&end<rows.length?{nextPage:selected.at(-1).requestId}:{}),...(selected.length&&start>0?{previousPage:selected[0].requestId}:{})}};
}
export async function providerMercury(ctx:ProviderRequest):Promise<ProviderResponse|undefined>{
 if(ctx.system!=='mercury')return undefined;const w=ctx.world,url=typeof ctx.url==='string'?new URL(ctx.url):ctx.url,method=ctx.method.toUpperCase(),route=ctx.route.replace(/\/$/,'');
 const approval=/^\/api\/v1\/request-send-money(?:\/([^/]+))?$/.exec(route),create=/^\/api\/v1\/account\/([^/]+)\/request-send-money$/.exec(route),account=/^\/api\/v1\/accounts?\/([^/]+)\/transactions$/.exec(route),detail=/^\/api\/v1\/transactions?\/([^/]+)$/.exec(route),accountDetail=/^\/api\/v1\/account\/([^/]+)\/transaction\/([^/]+)$/.exec(route);
 if(create){
  if(method!=='POST')return undefined;query(url,[]);const bankId=decode(create[1]!);find(w.bankAccounts,bankId,'Source account');if(bankId!=='cash-bank')fail('unsupported_payment_account','Only the recorded USD cash-bank payment route is supported',501);
  const input=ctx.input;fields(input,['recipientId','amount','paymentMethod','idempotencyKey','note','finance_world']);fields(input.finance_world,['bill_id']);
  const billId=text(input.finance_world.bill_id,'finance_world.bill_id'),recipient=text(input.recipientId,'recipientId'),bill=find(w.bills,billId,'Bill');if(bill.vendor_id!==recipient)fail('supplier_payment_recipient_mismatch','recipientId must match the source bill supplier',409);
  if(input.paymentMethod!=='ach')fail('unsupported_payment_method','This subset supports only recorded USD ACH instructions',501);const minor=amount(input.amount),key=text(input.idempotencyKey,'idempotencyKey');if(input.note!==undefined)text(input.note,'note',1000);
  const result=await ctx.execute({type:'request_bill_payment',bill_id:billId,recipient_id:recipient,amount_minor:minor,payment_method:'ach',idempotency_key:key,...(input.note===undefined?{}:{note:input.note})});const actual=find(w.approvals,result.approval_id,'Created bill approval');if(actual.action?.type!=='pay_bill')fail('invalid_approval_record','Created request must reference a real bill approval',409);
  return {status:200,body:requestShape(w,actual)};
 }
 if(approval){
  if(method!=='GET')return undefined;query(url,approval[1]?[]:['accountId','status','limit','start_after','end_before']);let rows=billApprovals(w);
  if(approval[1])return {body:requestShape(w,find(rows,decode(approval[1]),'Bill approval'))};
  if(url.searchParams.has('accountId')){const id=url.searchParams.get('accountId')!;find(w.bankAccounts,id,'Source account');if(id!=='cash-bank')rows=[];}
  const status=url.searchParams.get('status');if(status!==null){if(!['pendingApproval','approved','rejected','cancelled'].includes(status))fail('invalid_parameter','Unsupported approval status');rows=rows.filter(a=>(a.status==='pending'?'pendingApproval':a.status)===status);}
  return {body:requestPage(rows.map(a=>requestShape(w,a)),url)};
 }
 if(method!=='GET')return undefined;
 if(route==='/api/v1/accounts'){
  query(url,['limit','start_after']);const summary=summarize(structuredClone(w)),rows=summary.bank_accounts.map((a:any)=>({id:a.id,name:a.name,nickname:w.name,legalBusinessName:w.name,status:a.status,kind:'checking',type:'mercury',currency:a.currency,currentBalance:major(a.current_balance_minor,a.currency),availableBalance:major(a.available_balance_minor,a.currency),canReceiveTransactions:a.status==='active',createdAt:a.created_at,finance_world:{current_balance_minor:a.current_balance_minor,available_balance_minor:a.available_balance_minor,reserved_minor:a.reserved_minor??0,currency:a.currency,scope:limitations}}));
  const limit=integer(url.searchParams.get('limit'),'limit',10,1000),after=url.searchParams.get('start_after'),index=after===null?-1:rows.findIndex((r:any)=>r.id===after);if(after!==null&&index<0)fail('invalid_cursor','Unknown account cursor');return {body:{accounts:rows.slice(index+1,index+1+limit),total:rows.length}};
 }
 if(account||detail||accountDetail){
  query(url,account?['limit','offset','order','status','search','start','end','requestId']:[]);const bankId=account?decode(account[1]!):accountDetail?decode(accountDetail[1]!):undefined;if(bankId)find(w.bankAccounts,bankId,'Source account');
  let rows=transactions(w).filter(row=>!bankId||row.accountId===bankId);
  if(detail||accountDetail)return {body:find(rows,decode((detail?.[1]??accountDetail?.[2])!),'Transaction')};
  const status=url.searchParams.get('status');if(status!==null){if(!['pending','sent','cancelled','failed','reversed','blocked'].includes(status))fail('invalid_parameter','Unsupported transaction status');rows=rows.filter(t=>t.status===status);}
  if(url.searchParams.has('search')){const term=url.searchParams.get('search')!.toLowerCase();rows=rows.filter(t=>[t.note,t.externalMemo,t.counterpartyName].some(value=>typeof value==='string'&&value.toLowerCase().includes(term)));}
  if(url.searchParams.has('requestId'))rows=rows.filter(t=>t.requestId===url.searchParams.get('requestId'));
  const start=date(url.searchParams.get('start'),'start'),end=date(url.searchParams.get('end'),'end',true);if(start!==undefined&&end!==undefined&&start>end)fail('invalid_parameter','start cannot follow end');rows=rows.filter(t=>(start===undefined||Date.parse(t.createdAt)>=start)&&(end===undefined||Date.parse(t.createdAt)<=end));
  const order=url.searchParams.get('order')??'desc';if(!['asc','desc'].includes(order))fail('invalid_parameter','order must be asc or desc');rows.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));if(order==='desc')rows.reverse();
  const limit=integer(url.searchParams.get('limit'),'limit',1000,1000),offset=integer(url.searchParams.get('offset'),'offset',0,Number.MAX_SAFE_INTEGER,0);if(offset>rows.length)fail('invalid_cursor','Offset exceeds collection');return {body:{total:rows.length,transactions:rows.slice(offset,offset+limit)}};
 }
 return undefined;
}

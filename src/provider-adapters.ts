import {providerMercury} from './provider-mercury.ts';
import {providerStripe} from './provider-stripe.ts';
import {providerSap} from './provider-sap.ts';
import {providerZoho} from './provider-zoho.ts';
import {providerIntacct} from './provider-intacct.ts';
/** Selected vendor-shaped contracts over the canonical simulation world.
 * Authentication belongs to the world gateway. Unknown operations are never
 * acknowledged as successful; supported query subsets reject unknown filters.
 */
import {DomainError,summarize,normalizeWorld} from './world.ts';
import {currencyScale} from './money.ts';
import {providerDocuments} from './provider-documents.ts';
import {providerPayroll} from './provider-payroll.ts';
import type {World,Action} from './world.ts';
import {parseMimeMessage,rawMailBytes,mailHeaders,gmailMimePayload} from './mail.ts';
import {providerXero} from './provider-xero.ts';
export type ProviderRequest = {system:string;world:World;route:string;url:URL|string;method:string;input?:any;headers?:Headers;execute:(action:Action)=>any|Promise<any>};
export type ProviderResponse = {body?:any;rawBody?:string|Uint8Array;headers?:Record<string,string>;status?:number};
type Response=ProviderResponse;
const fail=(code:string,message:string,status=400):never=>{throw new DomainError(status,code,message);};
const found=(rows:any[],id:string)=>rows.find(x=>x.id===id)??fail('resource_missing',`Resource ${id} not found`,404);
const count=(value:any,name:string,def:number,max=1000,min=1)=>{const n=value===undefined||value===null?def:Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)fail('invalid_parameter',`${name} must be an integer in ${min}..${max}`);return n;};
const seconds=(iso:string)=>Math.floor(Date.parse(iso)/1000);
function queries(url:URL,allowed:string[],repeated:string[]=[]){for(const key of url.searchParams.keys()){if(!allowed.includes(key))fail('unsupported_filter',`Unsupported query parameter: ${key}`,501);if(!repeated.includes(key)&&url.searchParams.getAll(key).length>1)fail('duplicate_parameter',`Repeated query parameter: ${key}`);}}
function fields(input:any,allowed:string[]){if(!input||typeof input!=='object'||Array.isArray(input))fail('invalid_body','Expected an object body');for(const key of Object.keys(input))if(!allowed.includes(key))fail('unsupported_field',`Unsupported body field: ${key}`,501);}
function cursorPage(rows:any[],url:URL,size='limit',cursor='starting_after',max=100){const limit=count(url.searchParams.get(size),size,10,max);const after=url.searchParams.get(cursor);let start=0;if(after){const index=rows.findIndex(row=>row.id===after);if(index<0)fail('invalid_cursor','Unknown pagination cursor');start=index+1;}return {data:rows.slice(start,start+limit),has_more:start+limit<rows.length};}
function offsetPage(rows:any[],url:URL,limitName='limit',offsetName='offset',def=100){const limit=count(url.searchParams.get(limitName),limitName,def,1000),offset=count(url.searchParams.get(offsetName),offsetName,0,Number.MAX_SAFE_INTEGER,0);if(offset>rows.length)fail('invalid_cursor','Offset exceeds collection');return {rows:rows.slice(offset,offset+limit),offset,limit,hasMore:offset+limit<rows.length,total:rows.length};}
const chargeId=(payment:any)=>payment.charge_id??`ch_${payment.id}`;
const paymentCreated=(w:World,p:any)=>p.created_at??w.orders.find(order=>order.id===p.order_id)?.created_at??p.captured_at;
const refundShape=(w:World,r:any)=>({id:r.id,object:'refund',amount:r.amount_minor,currency:'usd',payment_intent:r.payment_id,charge:chargeId(found(w.payments,r.payment_id)),balance_transaction:(w.processorTransactions??[]).find((row:any)=>row.type==='refund'&&row.refund_id===r.id)?.id??null,status:r.status,created:seconds(r.created_at),metadata:{world_operation_id:r.operation_id,...(r.credit_note_id?{finance_world_credit_note_id:r.credit_note_id}:{})}});
function intentShape(w:World,p:any){return {id:p.id,object:'payment_intent',amount:p.amount_minor,amount_received:p.status==='succeeded'?p.amount_minor:0,amount_capturable:0,currency:'usd',status:p.status==='voided'?'canceled':p.status,customer:p.customer_id,created:seconds(paymentCreated(w,p)),latest_charge:p.status==='succeeded'?chargeId(p):null,metadata:{order_id:p.order_id??'',invoice_id:p.invoice_id??''}};}
function chargeShape(w:World,p:any){return {id:chargeId(p),object:'charge',amount:p.amount_minor,amount_refunded:p.amount_refunded_minor,currency:'usd',payment_intent:p.id,customer:p.customer_id,paid:true,captured:true,refunded:p.amount_refunded_minor===p.amount_minor,disputed:w.disputes.some((d:any)=>d.payment_id===p.id),status:'succeeded',created:seconds(p.captured_at??paymentCreated(w,p)),balance_transaction:(w.processorTransactions??[]).find((row:any)=>row.type==='charge'&&row.payment_id===p.id)?.id??null,refunds:{object:'list',data:w.refunds.filter(r=>r.payment_id===p.id).map(r=>refundShape(w,r)),has_more:false,url:'/v1/refunds'}};}
const invoiceShape=(i:any)=>({id:i.id,object:'invoice',customer:i.customer_id,currency:'usd',status:i.status==='paid'?'paid':'open',total:i.amount_minor,amount_due:i.amount_minor,amount_paid:i.amount_paid_minor,amount_remaining:i.amount_minor-i.amount_paid_minor,post_payment_credit_notes_amount:i.amount_credited_minor??0,pre_payment_credit_notes_amount:0,created:seconds(i.issued_at),due_date:seconds(i.due_at),description:i.description});
function disputeShape(w:World,d:any){
  const status=d.status==='open'?'needs_response':d.status==='evidence_submitted'?'under_review':d.status;
  const knownReasons=['bank_cannot_process','credit_not_processed','customer_initiated','debit_not_authorized','duplicate','fraudulent','general','incorrect_account_details','insufficient_funds','product_not_received','product_unacceptable','subscription_canceled','unrecognized'];
  const evidence=d.evidence??[],last=evidence.at(-1);
  return {id:d.id,object:'dispute',amount:d.amount_minor,currency:'usd',charge:chargeId(found(w.payments,d.payment_id)),payment_intent:d.payment_id,created:seconds(d.created_at),status,reason:knownReasons.includes(d.reason)?d.reason:'general',evidence:{uncategorized_text:last?.statement??null},evidence_details:{due_by:seconds(d.evidence_due_at),has_evidence:evidence.length>0,past_due:w.now>d.evidence_due_at,submission_count:evidence.length},metadata:{finance_world_reason:d.reason,finance_world_document_id:d.document_id,finance_world_hold_operation_id:d.hold_operation_id,...(d.resolution_operation_id?{finance_world_resolution_operation_id:d.resolution_operation_id}:{})},finance_world_evidence:{document_ids:last?.document_ids??[],evidence_id:last?.id??null,submitted_at:last?.submitted_at??null}};
}
function creditNoteShape(w:World,n:any){return {id:n.id,object:'credit_note',invoice:n.invoice_id,customer:n.customer_id,amount:n.amount_minor,total:n.amount_minor,subtotal:n.amount_minor,currency:'usd',status:'issued',created:seconds(n.issued_at),effective_at:seconds(n.issued_at),memo:n.reason,post_payment_amount:n.amount_minor,pre_payment_amount:0,refunds:w.refunds.filter(r=>r.credit_note_id===n.id).map(r=>({amount:r.amount_minor,refund:r.id})),metadata:{finance_world_status:n.status,finance_world_payment_intent:n.payment_id,finance_world_document_id:n.document_id,finance_world_refunded_minor:String(n.amount_refunded_minor),finance_world_disputed_minor:String(n.amount_disputed_minor)}};}
async function stripe(ctx:ProviderRequest,url:URL):Promise<Response|undefined>{
  const {world:w,route,method}=ctx;
  const processor=await providerStripe(ctx,url);if(processor)return processor;
  const match=/^\/v1\/(payment_intents|charges|refunds|customers|invoices|disputes|credit_notes)(?:\/([^/]+))?$/.exec(route);
  if(!match)return undefined;const [,kind,id]=match;
  if(method==='POST'&&kind==='refunds'&&!id){
    queries(url,[]);const input=ctx.input??{};fields(input,['payment_intent','charge','amount','reason','credit_note_id']);
    if((!input.payment_intent&&!input.charge)||(input.payment_intent&&input.charge))fail('invalid_parameter','Specify exactly one payment_intent or charge');
    if(input.reason!==undefined&&!['requested_by_customer','duplicate','fraudulent'].includes(input.reason))fail('invalid_parameter','Invalid refund reason');
    if(input.credit_note_id!==undefined&&(typeof input.credit_note_id!=='string'||!input.credit_note_id||input.credit_note_id.length>200))fail('invalid_parameter','credit_note_id must name a gram credit note');
    const paymentId=input.payment_intent??w.payments.find(p=>p.status==='succeeded'&&chargeId(p)===input.charge)?.id;
    if(input.charge&&!paymentId)fail('resource_missing','Unknown charge',404);
    const result=await ctx.execute({type:'refund',payment_id:paymentId,...(input.amount!==undefined?{amount_minor:count(input.amount,'amount',0,1e12)}:{}),...(input.reason?{reason:input.reason}:{}),...(input.credit_note_id?{credit_note_id:input.credit_note_id}:{})});
    if(result.status==='awaiting_approval')return {status:202,body:{object:'finance_world.approval_required',...result}};
    return {body:refundShape(w,result.refund)};
  }
  if(method==='POST'&&kind==='disputes'&&id){
    queries(url,[]);const input=ctx.input??{};fields(input,['finance_world_evidence','submit']);
    if(input.submit!==undefined&&input.submit!==true)fail('unsupported_field','Only immediate evidence submission is implemented; submit must be true',501);
    fields(input.finance_world_evidence,['document_ids','statement']);
    const evidence=input.finance_world_evidence;
    if(!Array.isArray(evidence.document_ids)||evidence.document_ids.some((value:any)=>typeof value!=='string')||typeof evidence.statement!=='string')fail('invalid_parameter','finance_world_evidence requires document_ids and statement');
    found(w.disputes,decodeURIComponent(id));
    const result=await ctx.execute({type:'submit_dispute_evidence',dispute_id:decodeURIComponent(id),document_ids:evidence.document_ids,statement:evidence.statement});
    return {body:disputeShape(w,result.dispute)};
  }
  if(method!=='GET')return undefined;
  queries(url,id?[]:['limit','starting_after',...(['refunds','disputes'].includes(kind)?['payment_intent','charge']:kind==='credit_notes'?['invoice','customer']:kind==='payment_intents'||kind==='charges'||kind==='invoices'?['customer']:[])]);
  let rows:any[]=kind==='payment_intents'?w.payments.map(p=>intentShape(w,p)):kind==='charges'?w.payments.filter(p=>p.status==='succeeded').map(p=>chargeShape(w,p)):kind==='refunds'?w.refunds.map(r=>refundShape(w,r)):kind==='customers'?w.customers.map((c:any)=>({id:c.id,object:'customer',name:c.name,email:c.email,currency:'usd',metadata:{}})):kind==='disputes'?w.disputes.map((d:any)=>disputeShape(w,d)):kind==='credit_notes'?w.creditNotes.map((n:any)=>creditNoteShape(w,n)):w.invoices.map(invoiceShape);
  if(id)return {body:found(rows,decodeURIComponent(id))};
  for(const field of ['customer','payment_intent','charge','invoice'])if(url.searchParams.has(field))rows=rows.filter(row=>row[field]===url.searchParams.get(field));
  return {body:{object:'list',url:route,...cursorPage(rows,url)}};
}

function gmailMessage(message:any,format='full',metadataHeaders:string[]=[]){
  const raw=rawMailBytes(message),base={id:message.id,threadId:message.thread_id,labelIds:message.labelIds};if(format==='minimal')return base;
  const headers=mailHeaders(message),full={...base,snippet:message.body.replace(/\s+/g,' ').slice(0,160),historyId:'1',internalDate:String(Date.parse(message.created_at)),sizeEstimate:raw.length};
  if(format==='raw')return {...full,raw:raw.toString('base64url')};
  if(format==='metadata')return {...full,payload:{partId:'',mimeType:(headers.find(h=>h.name.toLowerCase()==='content-type')?.value||'text/plain').split(';')[0],filename:'',headers:metadataHeaders.length?headers.filter(h=>metadataHeaders.some(name=>name.toLowerCase()===h.name.toLowerCase())):headers}};
  return {...full,payload:gmailMimePayload(message)};
}
function filteredMail(w:World,url:URL){
  const include=url.searchParams.get('includeSpamTrash');if(include!==null&&!['true','false'].includes(include))fail('invalid_parameter','includeSpamTrash must be true or false');
  let messages=w.messages.filter(m=>include==='true'||(!m.labelIds.includes('TRASH')&&!m.labelIds.includes('SPAM')));
  for(const label of url.searchParams.getAll('labelIds'))messages=messages.filter(m=>m.labelIds.includes(label));
  const query=url.searchParams.get('q');if(query){
    const terms=query.match(/(?:[^\s"]+|"[^"]*")+/g)??[];
    for(const term of terms){const [prefix,...rest]=term.split(':');if(rest.length){const value=rest.join(':').replace(/^"|"$/g,'').toLowerCase();if(prefix==='from')messages=messages.filter(m=>m.from.toLowerCase().includes(value));else if(prefix==='to')messages=messages.filter(m=>m.to.some((to:string)=>to.toLowerCase().includes(value)));else if(prefix==='cc')messages=messages.filter(m=>(m.cc??[]).some((cc:string)=>cc.toLowerCase().includes(value)));else if(prefix==='subject')messages=messages.filter(m=>m.subject.toLowerCase().includes(value));else if(prefix==='has'&&value==='attachment')messages=messages.filter(m=>m.attachments?.length);else if(prefix==='filename')messages=messages.filter(m=>m.attachments?.some((a:any)=>a.filename.toLowerCase().includes(value)));else if(prefix==='is'&&value==='unread')messages=messages.filter(m=>m.labelIds.includes('UNREAD'));else if(prefix==='label')messages=messages.filter(m=>m.labelIds.some((label:string)=>label.toLowerCase()===value));else fail('unsupported_filter',`Unsupported Gmail search term: ${term}`,501);}else{const value=term.replace(/^"|"$/g,'').toLowerCase();messages=messages.filter(m=>(m.subject+' '+m.body).toLowerCase().includes(value));}}
  }
  return messages;
}
async function gmail(ctx:ProviderRequest,url:URL):Promise<Response|undefined>{
  const attachment=/^\/gmail\/v1\/users\/([^/]+)\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(ctx.route);
  if(attachment){
    if(ctx.method!=='GET')return undefined;
    if(!['me','finance@simulation.test'].includes(decodeURIComponent(attachment[1])))fail('resource_missing','Unknown simulated mailbox',404);
    queries(url,[]);const message=found(ctx.world.messages,decodeURIComponent(attachment[2]));
    const file=found(message.attachments??[],decodeURIComponent(attachment[3]));return {body:{size:file.size,data:file.data}};
  }
  const match=/^\/gmail\/v1\/users\/([^/]+)\/(messages|threads)(?:\/([^/]+))?$/.exec(ctx.route);if(!match)return undefined;
  const [,user,kind,id]=match;if(!['me','finance@simulation.test'].includes(decodeURIComponent(user)))fail('resource_missing','Unknown simulated mailbox',404);
  if(kind==='messages'&&id==='send'&&ctx.method==='POST'){
    queries(url,[]);fields(ctx.input??{},['raw','threadId']);const parsed=await parseMimeMessage(ctx.input.raw,'outbound');
    if(ctx.input.threadId!==undefined&&(typeof ctx.input.threadId!=='string'||!ctx.world.messages.some(m=>m.thread_id===ctx.input.threadId)))fail('resource_missing','Unknown message thread',404);
    const references=[...(parsed.in_reply_to?[parsed.in_reply_to]:[]),...(parsed.references??[]).slice().reverse()];
    const repliedTo=references.map(id=>ctx.world.messages.find(m=>id===(m.message_id??`<${m.id}@simulation.test>`))).find(Boolean);
    if(ctx.input.threadId&&repliedTo&&ctx.input.threadId!==repliedTo.thread_id)fail('thread_conflict','Thread ID conflicts with reply references',409);
    const thread=ctx.input.threadId??repliedTo?.thread_id;
    const message=await ctx.execute({type:'send_email',...parsed,...(thread?{thread_id:thread}:{})});return {body:gmailMessage(message)};
  }
  if(ctx.method!=='GET')return undefined;
  if(id){
    queries(url,['format','metadataHeaders'],['metadataHeaders']);const format=url.searchParams.get('format')??'full';
    if(!['minimal','metadata','full','raw'].includes(format)||(kind==='threads'&&format==='raw'))fail('invalid_parameter','Unsupported message format');
    if(kind==='messages')return {body:gmailMessage(found(ctx.world.messages,decodeURIComponent(id)),format,url.searchParams.getAll('metadataHeaders'))};
    const messages=ctx.world.messages.filter(m=>m.thread_id===decodeURIComponent(id));if(!messages.length)fail('resource_missing','Unknown thread',404);
    return {body:{id:decodeURIComponent(id),historyId:'1',messages:messages.map(m=>gmailMessage(m,format,url.searchParams.getAll('metadataHeaders')))}};
  }
  queries(url,['maxResults','pageToken','q','labelIds','includeSpamTrash'],['labelIds']);
  const filtered=filteredMail(ctx.world,url),rows=kind==='messages'?filtered.map(m=>({id:m.id,threadId:m.thread_id})):Array.from(new Set(filtered.map(m=>m.thread_id))).map(id=>({id,snippet:filtered.find(m=>m.thread_id===id).body.slice(0,160),historyId:'1'}));
  const limit=count(url.searchParams.get('maxResults'),'maxResults',100,100),token=url.searchParams.get('pageToken');if(token&&!/^offset-\d+$/.test(token))fail('invalid_cursor','Unknown Gmail page token');
  const offset=token?count(token.slice(7),'pageToken',0,rows.length,0):0;
  return {body:{[kind]:rows.slice(offset,offset+limit),resultSizeEstimate:rows.length,...(offset+limit<rows.length?{nextPageToken:`offset-${offset+limit}`}:{})}};
}

function plaid(ctx:ProviderRequest,url:URL):Response|undefined{
  if(ctx.method!=='POST'||!['/accounts/get','/transactions/sync'].includes(ctx.route))return undefined;
  queries(url,[]);const input=ctx.input??{};fields(input,['access_token','client_id','secret',...(ctx.route==='/accounts/get'?['options']:['cursor','count'])]);
  const summary=summarize(ctx.world),accounts=summary.bank_accounts.map((account:any)=>({account_id:account.id,name:account.name,official_name:ctx.world.name,type:'depository',subtype:'checking',mask:'0001',balances:{current:account.current_balance_minor/currencyScale(account.currency),available:account.available_balance_minor/currencyScale(account.currency),iso_currency_code:account.currency,unofficial_currency_code:null,limit:null}}));
  const request_id=`sim-${ctx.world.id}-${ctx.world.revision}`;
  if(ctx.route==='/accounts/get'){
    if(input.options){fields(input.options,['account_ids']);if(!Array.isArray(input.options.account_ids)||input.options.account_ids.some((id:any)=>!accounts.some((account:any)=>account.account_id===id)))fail('invalid_parameter','Unknown account IDs');}
    return {body:{accounts:input.options?accounts.filter((account:any)=>input.options.account_ids.includes(account.account_id)):accounts,item:{item_id:ctx.world.id,institution_id:'ins_simulated',products:['transactions'],error:null},request_id}};
  }
  const cursor=input.cursor??'';if(typeof cursor!=='string'||(cursor&&!/^world-\d+$/.test(cursor)))fail('invalid_cursor','Unknown transaction cursor');
  const offset=cursor?count(cursor.slice(6),'cursor',0,ctx.world.bankTransactions.length,0):0,limit=count(input.count,'count',100,500),rows=ctx.world.bankTransactions.slice(offset,offset+limit);
  return {body:{accounts,added:rows.map(t=>({transaction_id:t.id,account_id:t.account_id,amount:-t.amount_minor/currencyScale(t.currency),iso_currency_code:t.currency,unofficial_currency_code:null,date:t.posted_at.slice(0,10),authorized_date:t.posted_at.slice(0,10),name:t.description,merchant_name:null,pending:false,pending_transaction_id:null,payment_channel:'online'})),modified:[],removed:[],next_cursor:`world-${offset+rows.length}`,has_more:offset+rows.length<ctx.world.bankTransactions.length,transactions_update_status:'HISTORICAL_UPDATE_COMPLETE',request_id}};
}
/** ERP invoice totals use native denomination; journal/account views stay USD.
 * Exact rational source rates and functional carrying are retained as metadata. */
function foreignErpRows(w:World,kind:'invoice'|'bill'){
  return (kind==='invoice'?w.foreignInvoices:w.foreignBills).map((row:any)=>{const party=w.foreignCounterparties.find((p:any)=>p.id===row.counterparty_id),contract=w.foreignContracts.find((c:any)=>c.id===row.contract_id);return {...row,source_type:'foreign-service',amount_paid_minor:row.amount_settled_minor,status:row.status==='settled'?'paid':row.status==='partially_settled'?'partially_paid':'open',description:contract?.description,...(kind==='invoice'?{customer_id:row.counterparty_id}:{vendor_id:row.counterparty_id,beneficiary_id:party?.verified_route_id})};});
}
const erpInvoices=(w:World)=>[...w.invoices,...foreignErpRows(w,'invoice')];
const erpBills=(w:World)=>[...w.bills,...foreignErpRows(w,'bill')];
function foreignErpMetadata(row:any){return row.source_type==='foreign-service'?{native_currency:row.currency,native_amount_minor:row.amount_minor,native_settled_minor:row.amount_settled_minor,functional_currency:'USD',original_functional_minor:row.original_functional_minor,carrying_minor:row.carrying_minor,historical_basis_minor:row.historical_basis_minor,recognition_quote_id:row.recognition_quote_id,recognition_quote:row.recognition_quote_snapshot,contract_id:row.contract_id,source_invoice_id:row.source_invoice_id,service_completed_at:row.service_completed_at,completion_reference:row.completion_reference}:undefined;}
function qbInvoice(i:any){const scale=currencyScale(i.currency??'USD'),foreign=foreignErpMetadata(i);return {Id:i.id,SyncToken:String(i.amount_paid_minor),DocNumber:i.source_invoice_id??i.id,CustomerRef:{value:i.customer_id},TotalAmt:i.amount_minor/scale,Balance:(i.amount_minor-i.amount_paid_minor)/scale,CurrencyRef:{value:i.currency??'USD'},...(foreign?{ExchangeRate:Number(i.recognition_quote_snapshot.numerator)/Number(i.recognition_quote_snapshot.denominator),finance_world:foreign}:{}),TxnDate:i.issued_at.slice(0,10),DueDate:i.due_at.slice(0,10),Line:[{Id:'1',Amount:i.amount_minor/scale,Description:i.description,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:i.source_type==='asset_sale'?'fixed-asset-disposal':'services'},Qty:1,UnitPrice:i.amount_minor/scale}}]};}
const procurementMetadata=(record:any)=>({status:record.status,...(record.purchase_order_id?{purchase_order_id:record.purchase_order_id}:{}),...(record.supplier_invoice_id?{supplier_invoice_id:record.supplier_invoice_id}:{}),...(record.match_status?{match_status:record.match_status}:{}),...(record.receipt_ids?{receipt_ids:record.receipt_ids}:{}),...(record.approval_id?{approval_id:record.approval_id}:{}),...(record.document_ids?{document_ids:record.document_ids}:{}),...(record.document_id?{document_id:record.document_id}:{})});
function supplierInvoiceForBill(w:World,bill:any){return bill.supplier_invoice_id?found(w.supplierInvoices??[],bill.supplier_invoice_id):undefined;}
function qbExpenseLine(line:any,index:number){return {Id:line.id??String(index+1),Amount:line.amount_minor/100,DetailType:'ItemBasedExpenseLineDetail',ItemBasedExpenseLineDetail:{ItemRef:{value:line.item_id},Qty:line.quantity,UnitPrice:line.unit_price_minor/100},finance_world:{...(line.po_line_id?{po_line_id:line.po_line_id}:{}),...(line.received_quantity!==undefined?{received_quantity:line.received_quantity}:{}),...(line.billed_quantity!==undefined?{billed_quantity:line.billed_quantity}:{}),...(line.allocations?{allocations:line.allocations}:{})}};}
function qbBill(w:World,bill:any){
  const source=supplierInvoiceForBill(w,bill),scale=currencyScale(bill.currency??'USD'),foreign=foreignErpMetadata(bill);
  return {Id:bill.id,DocNumber:source?.invoice_number??bill.source_invoice_id??bill.id,VendorRef:{value:bill.vendor_id},TotalAmt:bill.amount_minor/scale,Balance:(bill.amount_minor-bill.amount_paid_minor)/scale,DueDate:bill.due_at.slice(0,10),CurrencyRef:{value:bill.currency??'USD'},...(foreign?{ExchangeRate:Number(bill.recognition_quote_snapshot.numerator)/Number(bill.recognition_quote_snapshot.denominator)}:{}),...(source?{TxnDate:source.received_at.slice(0,10),Line:source.lines.map(qbExpenseLine)}:{}),...(bill.purchase_order_id?{LinkedTxn:[{TxnId:bill.purchase_order_id,TxnType:'PurchaseOrder'}]}:{}),finance_world:{...procurementMetadata(bill),...(foreign??{})}};
}
function qbPurchaseOrder(order:any){return {Id:order.id,DocNumber:order.id,VendorRef:{value:order.vendor_id},TotalAmt:order.amount_minor/100,CurrencyRef:{value:'USD'},TxnDate:order.created_at.slice(0,10),POStatus:['closed','rejected'].includes(order.status)?'Closed':'Open',Line:order.lines.map(qbExpenseLine),finance_world:procurementMetadata(order)};}
function qbItem(item:any){return {Id:item.id,Name:item.name,Sku:item.sku,Type:'Inventory',TrackQtyOnHand:true,QtyOnHand:item.quantity_on_hand,finance_world:{inventory_value_minor:item.inventory_value_minor,currency:item.currency}};}
const qbEntities=['Invoice','Customer','Vendor','Bill','Account','JournalEntry','PurchaseOrder','Item'];
function qbRows(w:World,entity:string):any[]{
  if(entity==='Invoice')return erpInvoices(w).map(qbInvoice);
  if(entity==='Customer')return [...w.customers,...w.foreignCounterparties.filter((p:any)=>p.kind==='customer')].map((c:any)=>({Id:c.id,DisplayName:c.name,PrimaryEmailAddr:{Address:c.email},CurrencyRef:{value:c.currency??'USD'},Active:c.status!=='disabled'&&c.route_enabled!==false}));
  if(entity==='Vendor')return [...w.vendors,...w.foreignCounterparties.filter((p:any)=>p.kind==='vendor')].map((v:any)=>({Id:v.id,DisplayName:v.name,PrimaryEmailAddr:{Address:v.email},CurrencyRef:{value:v.currency??'USD'},Active:v.status!=='disabled'&&v.route_enabled!==false}));
  if(entity==='Bill')return erpBills(w).map(b=>qbBill(w,b));
  if(entity==='Account')return w.accounts.map(a=>({Id:a.id,Name:a.name,AccountType:a.type,CurrentBalance:a.balance_minor/100,Active:true}));
  if(entity==='PurchaseOrder')return (w.purchaseOrders??[]).map(qbPurchaseOrder);
  if(entity==='Item')return (w.inventoryItems??[]).map(qbItem);
  return w.journals.map(j=>({Id:j.id,TxnDate:j.posted_at.slice(0,10),PrivateNote:j.description,Line:j.lines.map((l:any,i:number)=>({Id:String(i+1),Amount:(l.debit_minor||l.credit_minor)/100,DetailType:'JournalEntryLineDetail',JournalEntryLineDetail:{PostingType:l.debit_minor?'Debit':'Credit',AccountRef:{value:l.account_id}}}))}));
}
function quickbooks(ctx:ProviderRequest,url:URL):Response|undefined{
  if(ctx.method!=='GET')return undefined;const match=/^\/v3\/company\/([^/]+)\/(query|invoice|purchaseorder|bill|item)(?:\/([^/]+))?$/.exec(ctx.route);if(!match)return undefined;
  if(decodeURIComponent(match[1])!==ctx.world.id)fail('resource_missing','Realm must match the simulation world ID',404);
  queries(url,match[2]==='query'?['query','minorversion']:['minorversion']);if(url.searchParams.has('minorversion')&&url.searchParams.get('minorversion')!=='75')fail('unsupported_version','This projection implements minorversion 75 fields only',501);
  if(match[2]!=='query'&&match[3]){const entity=qbEntities.find(name=>name.toLowerCase()===match[2])!;const record=qbRows(ctx.world,entity).find(row=>row.Id===decodeURIComponent(match[3]))??fail('resource_missing',`Resource ${decodeURIComponent(match[3])} not found`,404);return {body:{[entity]:record,time:ctx.world.now}};}
  if(match[2]!=='query'||match[3])return undefined;
  const query=/^select\s+\*\s+from\s+(Invoice|Customer|Vendor|Bill|Account|JournalEntry|PurchaseOrder|Item)(?:\s+where\s+Id\s*=\s*'([^']+)')?(?:\s+startposition\s+(\d+))?(?:\s+maxresults\s+(\d+))?\s*$/i.exec(url.searchParams.get('query')??'')??fail('unsupported_query',`Supported: SELECT * FROM ${qbEntities.join('|')} [WHERE Id = 'value'] [STARTPOSITION n] [MAXRESULTS n]`,501);
  const entity=qbEntities.find(name=>name.toLowerCase()===query[1].toLowerCase())!;
  const w=ctx.world;let rows=qbRows(w,entity);
  if(query[2])rows=rows.filter(r=>r.Id===query[2]);const start=count(query[3],'STARTPOSITION',1,Number.MAX_SAFE_INTEGER),limit=count(query[4],'MAXRESULTS',100,1000),page=rows.slice(start-1,start-1+limit);
  return {body:{QueryResponse:{[entity]:page,startPosition:start,maxResults:page.length,totalCount:rows.length},time:w.now}};
}
function nsItemLine(line:any,index:number){return {line:index+1,item:{id:line.item_id},quantity:line.quantity,rate:(line.unit_price_minor??line.unit_cost_minor)/100,amount:line.amount_minor/100,finance_world:{...(line.id?{line_id:line.id}:{}),...(line.po_line_id?{po_line_id:line.po_line_id}:{}),...(line.received_quantity!==undefined?{received_quantity:line.received_quantity}:{}),...(line.billed_quantity!==undefined?{billed_quantity:line.billed_quantity}:{}),...(line.lot_id?{lot_id:line.lot_id}:{}),...(line.allocations?{allocations:line.allocations}:{})}};}
function nsRows(w:World,kind:string):any[]{
  if(kind==='invoice')return erpInvoices(w).map(i=>({id:i.id,tranId:i.source_invoice_id??i.id,entity:{id:i.customer_id},total:i.amount_minor/currencyScale(i.currency),amountRemaining:(i.amount_minor-i.amount_paid_minor)/currencyScale(i.currency),currency:{id:i.currency,refName:i.currency},...(foreignErpMetadata(i)?{exchangeRate:Number(i.recognition_quote_snapshot.numerator)/Number(i.recognition_quote_snapshot.denominator),finance_world:foreignErpMetadata(i)}:{}),status:{id:i.status==='paid'?'PaidInFull':'Open',refName:i.status==='paid'?'Paid In Full':'Open'},tranDate:i.issued_at.slice(0,10),dueDate:i.due_at.slice(0,10)}));
  if(kind==='journalEntry')return w.journals.map(j=>({id:j.id,tranId:j.id,tranDate:j.posted_at.slice(0,10),memo:j.description,currency:{id:'USD'},line:{items:j.lines.map((l:any,i:number)=>({line:i+1,account:{id:l.account_id},debit:l.debit_minor/100,credit:l.credit_minor/100}))}}));
  if(kind==='purchaseOrder')return (w.purchaseOrders??[]).map((order:any)=>({id:order.id,tranId:order.id,entity:{id:order.vendor_id},total:order.amount_minor/100,currency:{id:'USD',refName:'USD'},tranDate:order.created_at.slice(0,10),item:{items:order.lines.map(nsItemLine)},finance_world:procurementMetadata(order)}));
  if(kind==='itemReceipt')return (w.goodsReceipts??[]).map((receipt:any)=>({id:receipt.id,tranId:receipt.id,createdFrom:{id:receipt.purchase_order_id},tranDate:receipt.received_at.slice(0,10),memo:receipt.reference,item:{items:receipt.lines.map(nsItemLine)},finance_world:{...procurementMetadata(receipt),operation_id:receipt.operation_id,received_at:receipt.received_at}}));
  if(kind==='inventoryItem')return (w.inventoryItems??[]).map((item:any)=>({id:item.id,itemId:item.sku,displayName:item.name,totalQuantityOnHand:item.quantity_on_hand,finance_world:{inventory_value_minor:item.inventory_value_minor,currency:item.currency}}));
  return erpBills(w).map(bill=>{const source=supplierInvoiceForBill(w,bill),scale=currencyScale(bill.currency),foreign=foreignErpMetadata(bill);return {id:bill.id,tranId:source?.invoice_number??bill.source_invoice_id??bill.id,entity:{id:bill.vendor_id},total:bill.amount_minor/scale,amountRemaining:(bill.amount_minor-bill.amount_paid_minor)/scale,currency:{id:bill.currency,refName:bill.currency},...(foreign?{exchangeRate:Number(bill.recognition_quote_snapshot.numerator)/Number(bill.recognition_quote_snapshot.denominator)}:{}),dueDate:bill.due_at.slice(0,10),memo:bill.description,...(source?{tranDate:source.received_at.slice(0,10),item:{items:source.lines.map(nsItemLine)}}:{}),...(bill.purchase_order_id?{createdFrom:{id:bill.purchase_order_id}}:{}),finance_world:{...procurementMetadata(bill),...(foreign??{})}};});
}
function netsuite(ctx:ProviderRequest,url:URL):Response|undefined{
  if(ctx.method!=='GET')return undefined;const match=/^\/services\/rest\/record\/v1\/(invoice|journalEntry|purchaseOrder|itemReceipt|vendorBill|inventoryItem)(?:\/([^/]+))?$/.exec(ctx.route);if(!match)return undefined;
  queries(url,match[2]?[]:['limit','offset']);
  const rows=nsRows(ctx.world,match[1]);
  if(match[2])return {body:found(rows,decodeURIComponent(match[2]))};
  const page=offsetPage(rows,url),base=url.origin+url.pathname;return {body:{count:page.rows.length,offset:page.offset,totalResults:page.total,hasMore:page.hasMore,items:page.rows.map(row=>({id:row.id,links:[{rel:'self',href:`${base}/${encodeURIComponent(row.id)}`}]})),links:page.hasMore?[{rel:'next',href:`${base}?offset=${page.offset+page.limit}&limit=${page.limit}`}]:[]}};
}
function ramp(ctx:ProviderRequest,url:URL):Response|undefined{
  if(ctx.method!=='GET')return undefined;const match=/^\/developer\/v1\/bills(?:\/([^/]+))?$/.exec(ctx.route);if(!match)return undefined;
  queries(url,match[1]?[]:['page_size','start','vendor_id','status']);
  let rows=erpBills(ctx.world).map(b=>({id:b.id,entity_id:ctx.world.id,vendor:{id:b.vendor_id},invoice_number:b.id,amount:b.amount_minor,invoice_currency:b.currency,due_at:b.due_at,status:b.status==='paid'?'PAID':b.status==='partially_paid'?'PARTIALLY_PAID':'OPEN',memo:b.description,payment_details:{vendor_account_id:b.beneficiary_id,...(b.source_type==='foreign-service'?{}:{source_bank_account_id:'cash-bank'})},...(foreignErpMetadata(b)?{finance_world:foreignErpMetadata(b)}:{})}));
  if(match[1])return {body:found(rows,decodeURIComponent(match[1]))};
  if(url.searchParams.has('vendor_id'))rows=rows.filter(row=>row.vendor.id===url.searchParams.get('vendor_id'));if(url.searchParams.has('status'))rows=rows.filter(row=>row.status===url.searchParams.get('status'));
  const page=cursorPage(rows,url,'page_size','start',100),next=new URL(url);next.searchParams.set('start',page.data.at(-1)?.id??'');return {body:{data:page.data,page:{next:page.has_more?next.href:null}}};
}
export async function providerRequest(ctx:ProviderRequest):Promise<Response|undefined>{
  const url=typeof ctx.url==='string'?new URL(ctx.url):ctx.url;
  const normalized={...ctx,world:normalizeWorld(ctx.world),method:ctx.method.toUpperCase(),route:ctx.route.replace(/\/$/,'')||'/'};
  if(ctx.system==='gusto')return providerPayroll(normalized);
  if(ctx.system==='xero')return providerXero(normalized);
  if(ctx.system==='zoho-books')return providerZoho(normalized);
  if(ctx.system==='sage-intacct')return providerIntacct(normalized);
  if(ctx.system==='sap-b1')return providerSap(normalized);
  if(ctx.system==='google-drive'||ctx.system==='sharepoint')return providerDocuments(normalized);
  if(ctx.system==='stripe')return stripe(normalized,url);
  if(ctx.system==='gmail'||ctx.system==='google')return gmail(normalized,url);
  if(ctx.system==='mercury')return providerMercury(normalized);
  if(ctx.system==='plaid')return plaid(normalized,url);
  if(ctx.system==='quickbooks')return quickbooks(normalized,url);
  if(ctx.system==='netsuite')return netsuite(normalized,url);
  if(ctx.system==='ramp')return ramp(normalized,url);
  return undefined;
}

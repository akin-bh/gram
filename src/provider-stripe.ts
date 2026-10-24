/** Stripe read subsets checked against the official v1 reference, 2026-10-24.
 * Provider cash comes from immutable processor facts, never deferred GL balances.
 * Historical bank-funded ticket worlds do not acquire invented processor rows.
 */
import {DomainError} from './world.ts';
import type {World} from './world.ts';
import type {ProviderRequest,ProviderResponse} from './provider-adapters.ts';
import {processorBalance} from './ticketing.ts';

const DOC='https://docs.stripe.com/api/';
const limitations=[
 'Read-only USD source projections; canonical synthetic IDs are retained. No capture, payout, top-up, cancellation or reversal write endpoint is implemented.',
 'Legacy bank-funded payments have no fabricated processor balance transaction history. Missing native bank-source details, payment-type balance buckets and payout schedule forecasts are omitted.',
 'The balance_transactions payout filter is unsupported: Stripe defines it for automatic payout allocation, which these source facts do not establish. Expand parameters are unsupported.',
];
const read=(id:string,path:string,description:string,documentation:string[])=>({id:`stripe.${id}`,system:'stripe',method:'GET' as const,path,access:'read' as const,description,documentation:documentation.map(p=>DOC+p),limitations});
export const providerStripeRoutes=[
 read('balance_transactions.list','/v1/balance_transactions','List actual processor movements newest first. Filters: created integer or [gt|gte|lt|lte], currency=usd, source, type=charge|refund|payout|topup|adjustment. Limit1..100(default10), exclusive starting_after/ending_before.',['balance_transactions/list','pagination']),
 read('balance_transactions.get','/v1/balance_transactions/:id','Read signed gross, actual fee, net, availability and canonical source/receipt references.',['balance_transactions/retrieve','balance_transactions/object']),
 read('payouts.list','/v1/payouts','List recorded paid processor-to-bank transfers newest first. Filters: created/arrival_date integer or [gt|gte|lt|lte], destination, status=pending|paid|failed|canceled; standard cursor pagination.',['payouts/list','pagination']),
 read('payouts.get','/v1/payouts/:id','Read a recorded payout and its actual bank receipt. arrival_date is the observed paid date; no forecast or automatic allocation is invented.',['payouts/retrieve','payouts/object']),
 read('topups.list','/v1/topups','List recorded bank-to-processor top-ups newest first. Filters: created/amount integer or [gt|gte|lt|lte], status=canceled|failed|pending|succeeded; standard cursor pagination.',['topups/list','pagination']),
 read('topups.get','/v1/topups/:id','Read an actual top-up, processor balance transaction and source-bank reference. Deprecated native source is null; canonical bank identity is in finance_world.',['topups/retrieve','topups/object']),
] as const;

const fail=(code:string,message:string,status=400):never=>{throw new DomainError(status,code,message);};
function decode(raw:string){try{const id=decodeURIComponent(raw);if(!id||id.length>200||/[\u0000-\u001f\u007f/\\]/.test(id))fail('invalid_parameter','Invalid Stripe resource identifier');return id;}catch(error){if(error instanceof DomainError)throw error;return fail('invalid_parameter','Malformed Stripe resource identifier');}}
function query(url:URL,allowed:string[]){for(const key of url.searchParams.keys()){if(!allowed.includes(key))fail('unsupported_filter',`Unsupported Stripe subset query: ${key}`,501);if(url.searchParams.getAll(key).length!==1)fail('duplicate_parameter',`Repeated query parameter: ${key}`);}}
function text(raw:string,label:string){if(!raw||raw!==raw.trim()||raw.length>200||/[\u0000-\u001f\u007f]/.test(raw))fail('invalid_parameter',`${label} must be nonempty bounded text`);return raw;}
function integer(raw:string,label:string,max=Number.MAX_SAFE_INTEGER,min=0){if(!/^(0|[1-9]\d*)$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<min||Number(raw)>max)fail('invalid_parameter',`${label} must be an integer in ${min}..${max}`);return Number(raw);}
function timestamp(value:any,label:string){const parsed=typeof value==='string'?Date.parse(value):NaN;if(!Number.isFinite(parsed))fail('invalid_processor_record',`Missing or invalid ${label}`,409);return Math.floor(parsed/1000);}
function money(value:any,label:string){if(!Number.isSafeInteger(value))fail('invalid_processor_record',`${label} must be exact integer minor units`,409);return value as number;}
const ranges=['gt','gte','lt','lte'] as const;
const rangeKeys=(name:string)=>[name,...ranges.map(op=>`${name}[${op}]`)];
function range(url:URL,name:string):(value:number)=>boolean{
 const exact=url.searchParams.get(name),limits=ranges.flatMap(op=>{const raw=url.searchParams.get(`${name}[${op}]`);return raw===null?[]:[{op,value:integer(raw,`${name}[${op}]`)}];});
 if(exact!==null&&limits.length)fail('invalid_parameter',`${name} cannot be both an integer and a range`);
 const equal=exact===null?undefined:integer(exact,name);
 return value=>(equal===undefined||value===equal)&&limits.every(({op,value:bound})=>op==='gt'?value>bound:op==='gte'?value>=bound:op==='lt'?value<bound:value<=bound);
}
function enumeration(url:URL,name:string,allowed:string[]){const value=url.searchParams.get(name);if(value!==null&&!allowed.includes(value))fail('invalid_parameter',`Unsupported ${name}; choose ${allowed.join(', ')}`);return value;}
function pagination(url:URL){
 const size=url.searchParams.get('limit'),limit=size===null?10:integer(size,'limit',100,1),after=url.searchParams.get('starting_after'),before=url.searchParams.get('ending_before');
 if(after!==null&&before!==null)fail('invalid_parameter','starting_after and ending_before are mutually exclusive');
 if(after!==null)text(after,'starting_after');if(before!==null)text(before,'ending_before');
 return (rows:any[])=>{let start=0,end=rows.length;if(after!==null||before!==null){const at=rows.findIndex(row=>row.id===(after??before));if(at<0)fail('invalid_cursor','Cursor does not name a record in this filtered collection');if(after!==null)start=at+1;else {end=at;start=Math.max(0,end-limit);}}
  return {data:rows.slice(start,Math.min(end,start+limit)),has_more:before!==null?start>0:start+limit<end};};
}
function chronological(rows:any[]){return rows.map((row,index)=>({row,index})).sort((a,b)=>b.row.created-a.row.created||b.index-a.index).map(({row})=>row);}
const nativeTypes:Record<string,{type:string;category:string}>={charge:{type:'charge',category:'charge'},refund:{type:'refund',category:'refund'},payout:{type:'payout',category:'payout'},topup:{type:'topup',category:'topup'},dispute_hold:{type:'adjustment',category:'dispute'},dispute_release:{type:'adjustment',category:'dispute_reversal'}};
export function stripeBalanceTransaction(w:World,row:any){
 const kind=nativeTypes[row.type]??fail('invalid_processor_record','Unknown processor transaction type',409),amount=money(row.amount_minor,'amount'),fee=money(row.fee_minor,'fee'),net=money(row.net_minor,'net');
 if(row.currency!=='USD'||fee<0||BigInt(amount)-BigInt(fee)!==BigInt(net))fail('invalid_processor_record','Invalid processor currency or gross/fee/net proof',409);
 const availableOn=timestamp(row.available_at,'available_at'),created=timestamp(row.created_at,'created_at');
 return {id:row.id,object:'balance_transaction',amount,currency:'usd',description:row.description??null,fee,fee_details:fee?[{amount:fee,currency:'usd',type:'stripe_fee',description:'Recorded processor fee',application:null}]:[],net,source:row.source_id,status:Date.parse(row.available_at)<=Date.parse(w.now)?'available':'pending',type:kind.type,reporting_category:kind.category,available_on:availableOn,created,exchange_rate:null,finance_world:{canonical_type:row.type,operation_id:row.operation_id,receipt_id:row.receipt_id??null,...(row.payment_id?{payment_id:row.payment_id}:{}),...(row.refund_id?{refund_id:row.refund_id}:{}),...(row.payout_id?{payout_id:row.payout_id}:{}),...(row.topup_id?{topup_id:row.topup_id}:{}),...(row.dispute_id?{dispute_id:row.dispute_id}:{})}};
}
function payout(row:any){if(row.currency!=='USD'||row.status!=='paid')fail('invalid_processor_record','Only recorded paid USD payouts are implemented',409);return {id:row.id,object:'payout',amount:money(row.amount_minor,'amount'),arrival_date:timestamp(row.paid_at,'paid_at'),balance_transaction:row.processor_transaction_id,created:timestamp(row.created_at,'created_at'),currency:'usd',description:row.description??null,destination:row.destination_account_id,status:'paid',type:'bank_account',livemode:false,metadata:{},finance_world:{operation_id:row.operation_id,receipt_id:row.receipt_id,bank_transaction_id:row.bank_transaction_id,document_id:row.document_id,source_payout_id:row.source_payout_id,source_bank_transaction_id:row.source_bank_transaction_id,destination_account_id:row.destination_account_id,arrival_date_source:'observed_paid_at'}};}
function topup(row:any){if(row.currency!=='USD'||row.status!=='succeeded')fail('invalid_processor_record','Only recorded succeeded USD top-ups are implemented',409);return {id:row.id,object:'topup',amount:money(row.amount_minor,'amount'),balance_transaction:row.processor_transaction_id,created:timestamp(row.created_at,'created_at'),currency:'usd',description:row.description??null,expected_availability_date:timestamp(row.posted_at,'posted_at'),source:null,status:'succeeded',livemode:false,metadata:{},finance_world:{operation_id:row.operation_id,receipt_id:row.receipt_id,bank_transaction_id:row.bank_transaction_id,document_id:row.document_id,source_topup_id:row.source_topup_id,source_bank_transaction_id:row.source_bank_transaction_id,source_account_id:row.source_account_id,availability_date_source:'observed_posted_at'}};}

export function stripeBalance(w:World){const balance=processorBalance(w);return {object:'balance',available:[{amount:balance.available_minor,currency:'usd'}],pending:[{amount:balance.pending_minor,currency:'usd'}],livemode:false,finance_world:{cash_account_id:'cash-processor',total_minor:balance.total_minor,reserved_minor:balance.reserved_minor,spendable_minor:balance.spendable_minor,reservation_semantics:'Local accepted refund reservations; reported available/pending are actual processor funds before these reservations.',history_semantics:'Only recorded processor transactions; legacy bank-funded payments do not imply processor history.'}};}

export async function providerStripe(ctx:ProviderRequest,url:URL):Promise<ProviderResponse|undefined>{
 if(ctx.system!=='stripe'||ctx.method!=='GET')return undefined;
 if(ctx.route==='/v1/balance'){query(url,[]);return {body:stripeBalance(ctx.world)};}
 const match=/^\/v1\/(balance_transactions|payouts|topups)(?:\/([^/]+))?$/.exec(ctx.route);if(!match)return undefined;
 const [,kind,rawId]=match;
 const rangeFields=kind==='payouts'?['created','arrival_date']:kind==='topups'?['created','amount']:['created'];
 const filters=kind==='balance_transactions'?['currency','source','type']:kind==='payouts'?['destination','status']:['status'];
 query(url,rawId?[]:['limit','starting_after','ending_before',...filters,...rangeFields.flatMap(rangeKeys)]);
 const page=rawId?undefined:pagination(url),predicates=rawId?[]:rangeFields.map(name=>({name,test:range(url,name)}));
 const type=rawId||kind!=='balance_transactions'?null:enumeration(url,'type',['charge','refund','payout','topup','adjustment']);
 const status=rawId||kind==='balance_transactions'?null:enumeration(url,'status',kind==='payouts'?['pending','paid','failed','canceled']:['canceled','failed','pending','succeeded']);
 const currency=url.searchParams.get('currency');if(currency!==null&&currency!=='usd')fail('unsupported_currency','This processor source subset supports only currency=usd',501);
 for(const field of ['source','destination'])if(url.searchParams.has(field))text(url.searchParams.get(field)!,field);
 const w=ctx.world;let rows=kind==='balance_transactions'?(w.processorTransactions??[]).map((row:any)=>stripeBalanceTransaction(w,row)):kind==='payouts'?(w.processorPayouts??[]).map(payout):(w.processorTopups??[]).map(topup);
 if(rawId){const id=decode(rawId),row=rows.find((row:any)=>row.id===id);if(!row)fail('resource_missing','Stripe resource does not exist in this world',404);return {body:row};}
 rows=rows.filter((row:any)=>predicates.every(({name,test})=>test(row[name]))&&(!type||row.type===type)&&(!status||row.status===status)&&['source','destination'].every(field=>!url.searchParams.has(field)||row[field]===url.searchParams.get(field)));
 return {body:{object:'list',url:ctx.route,...page!(chronological(rows))}};
}

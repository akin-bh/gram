import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createWorld,applyAction,DomainError} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {providerRequest} from './provider-adapters.ts';
import {providerStripeRoutes} from './provider-stripe.ts';
import {providerContracts,resolveProviderOperation} from './provider-contracts.ts';

const controller:Actor={id:'ticket-source-controller',role:'controller'},operator:Actor={id:'refund-operator',role:'operator'};
const epoch=(iso:string)=>Math.floor(Date.parse(iso)/1000);
function fixture(){
 const w=createWorld({kind:'ticket-cancellation',name:'Source tickets',seed:17,orderCount:1,startingCashMinor:1000000,cancelEvent:false,blueprint:{version:1,opening_at:'2026-10-24T09:00:00.000Z',vendors:[{ref:'promoter',name:'Promoter',email:'promoter@event.test'}],customers:[{ref:'fan',name:'Patron',email:'patron@event.test'}]}} as any,'native-stripe-test');
 let sequence=0;const act=(action:Action,actor=controller)=>applyAction(w,{...action,...(action.external_event_id===undefined&&String(action.type).startsWith('record_')?{external_event_id:'source-event-'+(++sequence)}:{})},actor).result;
 const event=act({type:'record_ticket_event',name:'October show',promoter_id:w.vendors[0].id,starts_at:'2026-10-31T19:00:00.000Z',agreement_reference:'SIGNED-OCTOBER-SHOW',agreement_signed_at:w.now}).event;
 const payment=(options:{fee?:number;availableAt?:string;voided?:boolean;face?:number;tax?:number;serviceFee?:number}={})=>{const order=act({type:'record_ticket_order',event_id:event.id,customer_id:w.customers[0].id,source_order_id:'SOURCE-ORDER-'+(++sequence),ordered_at:w.now,quantity:2,face_minor:options.face??10000,tax_minor:options.tax??900,fee_minor:options.serviceFee??1500}).order;return act({type:'record_ticket_payment',order_id:order.id,source_payment_id:'SOURCE-PAYMENT-'+(++sequence),outcome:options.voided?'voided':'captured',amount_minor:order.total_minor,occurred_at:w.now,processor_fee_minor:options.voided?0:options.fee??1000,...(options.voided?{}:{available_at:options.availableAt??w.now})}).payment;};
 const payout=(amount:number)=>act({type:'record_processor_payout',source_payout_id:'SOURCE-PAYOUT-'+(++sequence),source_bank_transaction_id:'BANK-PAYOUT-'+sequence,amount_minor:amount,paid_at:w.now});
 const topup=(amount:number)=>act({type:'record_processor_topup',source_topup_id:'SOURCE-TOPUP-'+(++sequence),source_bank_transaction_id:'BANK-TOPUP-'+sequence,amount_minor:amount,posted_at:w.now});
 const cancel=()=>act({type:'record_ticket_cancellation',event_id:event.id,source_notice_id:'SOURCE-CANCELLATION',cancelled_at:w.now,reason:'Promoter confirms cancellation'});
 return {w,act,event,payment,payout,topup,cancel};
}
async function call(w:World,path:string,method='GET',input?:any){const url=new URL(path,'http://local.test');return providerRequest({system:'stripe',world:w,route:url.pathname,url,method,input,execute:a=>applyAction(w,a,operator).result});}
async function body(w:World,path:string){return (await call(w,path))!.body;}
async function rejects(w:World,path:string,code:string){const before=structuredClone(w);await assert.rejects(()=>call(w,path),(error:any)=>error instanceof DomainError&&error.code===code);assert.deepEqual(w,before);}

test('six source-backed native read contracts expose official docs and no payout/top-up write',async()=>{
 assert.equal(providerStripeRoutes.length,6);for(const route of providerStripeRoutes){assert.equal(route.access,'read');assert.ok(route.documentation.every(url=>url.startsWith('https://docs.stripe.com/api/')));assert.ok(providerContracts.some(r=>r.id===route.id));assert.equal(resolveProviderOperation(route.id,'one',route.path.includes(':id')?{id:'source-id'}:{}).contract.method,'GET');}
 const {w}=fixture();for(const resource of ['payouts','topups','balance_transactions'])assert.equal(await call(w,'/v1/'+resource,'POST',{amount:100}),undefined);
});

test('legacy voided intent timestamp is immutable and reads invent no processor rows',async()=>{
 const w=createWorld({kind:'ticket-cancellation',orderCount:18,cancelEvent:false}),p=w.payments.find(p=>p.status==='voided'),order=w.orders.find(o=>o.id===p.order_id),before=structuredClone(w);
 const first=await body(w,'/v1/payment_intents/'+p.id);assert.equal(first.created,epoch(order.created_at));assert.equal(first.latest_charge,null);assert.equal(first.amount_received,0);assert.deepEqual(w,before);
 applyAction(w,{type:'advance_time',hours:2},controller);const advanced=structuredClone(w);assert.deepEqual(await body(w,'/v1/payment_intents/'+p.id),first);
 for(const resource of ['balance_transactions','payouts','topups'])assert.deepEqual((await body(w,'/v1/'+resource)).data,[]);
 const balance=await body(w,'/v1/balance');assert.equal(balance.available[0].amount,0);assert.equal(balance.pending[0].amount,0);assert.equal(balance.finance_world.reserved_minor,0);assert.equal(w.processorTransactions,undefined);assert.deepEqual(w,advanced);
 assert.equal((await body(w,'/v1/charges/ch_'+w.payments[0].id)).balance_transaction,null);
});

test('capture fee, future availability and native identity remain truthful while GL is offline',async()=>{
 const f=fixture(),{w}=f;f.act({type:'set_fault',system:'ledger',mode:'offline'});const availableAt='2026-10-24T10:00:00.000Z',p=f.payment({availableAt}),before=structuredClone(w);
 const intent=await body(w,'/v1/payment_intents/'+p.id),charge=await body(w,'/v1/charges/'+p.charge_id),txn=await body(w,'/v1/balance_transactions/'+p.processor_transaction_id),balance=await body(w,'/v1/balance');
 assert.equal(intent.latest_charge,p.charge_id);assert.equal(charge.id,p.charge_id);assert.equal(charge.balance_transaction,txn.id);assert.equal(txn.source,p.charge_id);assert.equal(txn.amount,12400);assert.equal(txn.fee,1000);assert.equal(txn.net,11400);assert.equal(txn.status,'pending');assert.equal(txn.available_on,epoch(availableAt));assert.equal(txn.finance_world.receipt_id,p.receipt_id);assert.equal(balance.pending[0].amount,11400);assert.equal(balance.available[0].amount,0);assert.equal(w.accounts.find(a=>a.id==='cash-processor').balance_minor,0);assert.equal(w.bankTransactions.length,1);assert.deepEqual(w,before);
 f.act({type:'advance_time',hours:1});assert.equal((await body(w,'/v1/balance')).available[0].amount,11400);assert.equal((await body(w,'/v1/balance')).pending[0].amount,0);assert.equal((await body(w,'/v1/balance_transactions/'+txn.id)).status,'available');assert.equal((await body(w,'/v1/payment_intents/'+p.id)).created,intent.created);
 f.act({type:'set_fault',system:'ledger',mode:'healthy'});f.act({type:'advance_time',hours:1});assert.equal(w.accounts.find(a=>a.id==='cash-processor').balance_minor,11400);assert.equal(w.operations.find(o=>o.id===p.operation_id).journal_id!==undefined,true);assert.equal((await body(w,'/v1/balance_transactions/'+txn.id)).created,txn.created);
});

test('recorded payout and top-up project actual paired receipts without revenue or forecast invention',async()=>{
 const f=fixture(),{w}=f;f.payment();f.act({type:'set_fault',system:'ledger',mode:'offline'});const payout=f.payout(4000),topup=f.topup(700),bank=structuredClone(w.bankTransactions);
 const p=await body(w,'/v1/payouts/'+payout.payout.id),t=await body(w,'/v1/topups/'+topup.topup.id),debit=await body(w,'/v1/balance_transactions/'+p.balance_transaction),credit=await body(w,'/v1/balance_transactions/'+t.balance_transaction);
 assert.equal(p.status,'paid');assert.equal(p.destination,'cash-bank');assert.equal(p.arrival_date,epoch(payout.payout.paid_at));assert.equal(p.finance_world.bank_transaction_id,payout.bank_transaction.id);assert.equal(p.automatic,undefined);assert.equal(p.method,undefined);assert.equal(debit.type,'payout');assert.equal(debit.source,p.id);assert.equal(debit.amount,-4000);assert.equal(debit.fee,0);
 assert.equal(t.status,'succeeded');assert.equal(t.source,null);assert.equal(t.finance_world.source_account_id,'cash-bank');assert.equal(t.finance_world.receipt_id,topup.operation.receipt_id);assert.equal(credit.type,'topup');assert.equal(credit.source,t.id);assert.equal(credit.net,700);assert.equal((await body(w,'/v1/balance')).available[0].amount,8100);assert.equal(w.accounts.find(a=>a.id==='cash-processor').balance_minor,11400);
 f.act({type:'set_fault',system:'ledger',mode:'healthy'});f.act({type:'advance_time',hours:1});assert.equal(w.accounts.find(a=>a.id==='cash-processor').balance_minor,8100);assert.equal(w.accounts.find(a=>a.id==='revenue').balance_minor,-1500);assert.deepEqual(w.bankTransactions,bank);assert.deepEqual(await body(w,'/v1/payouts/'+p.id),p);assert.deepEqual(await body(w,'/v1/topups/'+t.id),t);
});

test('native refund uses actual charge, discloses reservations separately and links only settled processor movement',async()=>{
 const f=fixture(),{w}=f,p=f.payment();f.cancel();const bank=structuredClone(w.bankTransactions),pending=(await call(w,'/v1/refunds','POST',{charge:p.charge_id,amount:1000}))!.body;
 assert.equal(pending.charge,p.charge_id);assert.equal(pending.balance_transaction,null);const balance=await body(w,'/v1/balance');assert.equal(balance.available[0].amount,11400);assert.equal(balance.finance_world.reserved_minor,1000);assert.equal(balance.finance_world.spendable_minor,10400);assert.equal((await body(w,'/v1/balance_transactions?type=refund')).data.length,0);
 await assert.rejects(()=>call(w,'/v1/refunds','POST',{charge:'ch_'+p.id,amount:1}),(error:any)=>error.code==='resource_missing');
 f.act({type:'set_fault',system:'ledger',mode:'offline'});f.act({type:'advance_time',hours:1});const refund=await body(w,'/v1/refunds/'+pending.id),charge=await body(w,'/v1/charges/'+p.charge_id),txn=await body(w,'/v1/balance_transactions/'+refund.balance_transaction);
 assert.equal(refund.status,'succeeded');assert.equal(refund.charge,p.charge_id);assert.equal(charge.refunds.data[0].balance_transaction,txn.id);assert.equal(charge.amount_refunded,1000);assert.equal(txn.source,refund.id);assert.equal(txn.amount,-1000);assert.equal(txn.net,-1000);assert.equal(txn.fee,0);assert.equal((await body(w,'/v1/balance')).available[0].amount,10400);assert.equal((await body(w,'/v1/balance')).finance_world.reserved_minor,0);assert.deepEqual(w.bankTransactions,bank);assert.equal(w.accounts.find(a=>a.id==='cash-processor').balance_minor,11400);
});

test('processor dispute hold/release are signed adjustment sources with accurate reporting categories',async()=>{
 const f=fixture(),{w}=f,p=f.payment(),bank=structuredClone(w.bankTransactions),opened=f.act({type:'open_dispute',payment_id:p.id,amount_minor:500,reason:'fraudulent',external_event_id:'issuer-case-one'}),id=opened.dispute.id;
 assert.equal((await body(w,'/v1/disputes/'+id)).charge,p.charge_id);assert.equal((await body(w,'/v1/balance')).available[0].amount,10900);f.act({type:'submit_dispute_evidence',dispute_id:id,document_ids:[f.event.document_id],statement:'Read the signed admission agreement'},operator);f.act({type:'resolve_dispute',dispute_id:id,outcome:'won',external_event_id:'issuer-case-one-won'});
 const rows=(await body(w,'/v1/balance_transactions?type=adjustment&source='+id)).data;assert.equal(rows.length,2);assert.deepEqual(rows.map((r:any)=>[r.type,r.reporting_category,r.net]),[['adjustment','dispute_reversal',500],['adjustment','dispute',-500]]);assert.equal((await body(w,'/v1/balance')).available[0].amount,11400);assert.deepEqual(w.bankTransactions,bank);
});

test('newest-first cursor pages preserve ties, reverse traversal and filtered source boundaries',async()=>{
 const f=fixture(),{w}=f;for(let i=1;i<=7;i++)f.topup(i*100);const expected=w.processorTopups.map((r:any)=>r.id).reverse();
 const first=await body(w,'/v1/topups?limit=3'),second=await body(w,'/v1/topups?limit=3&starting_after='+first.data.at(-1).id),last=await body(w,'/v1/topups?limit=3&starting_after='+second.data.at(-1).id);
 assert.deepEqual([...first.data,...second.data,...last.data].map(r=>r.id),expected);assert.equal(first.has_more,true);assert.equal(last.has_more,false);
 const previous=await body(w,'/v1/topups?limit=3&ending_before='+second.data[0].id);assert.deepEqual(previous.data,first.data);assert.equal(previous.has_more,false);
 const near=await body(w,'/v1/topups?limit=2&ending_before='+last.data[0].id);assert.deepEqual(near.data.map((r:any)=>r.id),expected.slice(4,6));assert.equal(near.has_more,true);
 const filtered=await body(w,'/v1/topups?amount[gte]=300&amount[lt]=600');assert.deepEqual(filtered.data.map((r:any)=>r.amount),[500,400,300]);assert.equal((await body(w,'/v1/topups?amount=400')).data.length,1);assert.deepEqual((await body(w,'/v1/topups?status=failed')).data,[]);
 await rejects(w,'/v1/topups?amount=400&starting_after='+expected[0],'invalid_cursor');assert.deepEqual((await body(w,'/v1/topups?ending_before='+expected[0])).data,[]);
});

test('documented time/source/destination filters are exact before pagination',async()=>{
 const f=fixture(),{w}=f,p=f.payment(),at=epoch(w.now);f.payout(1000);f.act({type:'advance_time',hours:1});const later=f.payout(2000).payout;
 assert.deepEqual((await body(w,'/v1/payouts?created='+at)).data.map((r:any)=>r.amount),[1000]);assert.deepEqual((await body(w,'/v1/payouts?arrival_date[gt]='+at+'&destination=cash-bank&status=paid')).data.map((r:any)=>r.id),[later.id]);assert.deepEqual((await body(w,'/v1/payouts?destination=other-source')).data,[]);
 const charge=(await body(w,'/v1/balance_transactions?currency=usd&type=charge&source='+p.charge_id+'&created[lte]='+at)).data;assert.equal(charge.length,1);assert.equal(charge[0].id,p.processor_transaction_id);assert.deepEqual((await body(w,'/v1/balance_transactions?created[gt]='+at+'&created[lt]='+at)).data,[]);
});

test('invalid and unsupported filters reject atomically even on empty collections',async()=>{
 const {w}=fixture();const cases:[string,string][]=[
  ['/v1/topups?limit=0','invalid_parameter'],['/v1/topups?limit=101','invalid_parameter'],['/v1/topups?limit=1e1','invalid_parameter'],['/v1/topups?limit=1&limit=2','duplicate_parameter'],
  ['/v1/topups?starting_after=x&ending_before=y','invalid_parameter'],['/v1/topups?starting_after=','invalid_parameter'],['/v1/topups?created=1&created[gte]=1','invalid_parameter'],['/v1/topups?created[gte]=nan','invalid_parameter'],['/v1/topups?amount[gte]=1.5','invalid_parameter'],['/v1/topups?amount[gte]=9007199254740992','invalid_parameter'],['/v1/topups?status=reversed','invalid_parameter'],
  ['/v1/payouts?status=in_transit','invalid_parameter'],['/v1/payouts?arrival_date=-1','invalid_parameter'],['/v1/payouts?destination=%20','invalid_parameter'],['/v1/payouts/missing?limit=2','unsupported_filter'],
  ['/v1/balance_transactions?available_on=1','unsupported_filter'],['/v1/balance_transactions?payout=payout_1','unsupported_filter'],['/v1/balance_transactions?type=dispute_hold','invalid_parameter'],['/v1/balance_transactions?currency=eur','unsupported_currency'],['/v1/balance_transactions?expand[]=source','unsupported_filter'],['/v1/balance?limit=1','unsupported_filter'],
  ['/v1/topups/missing','resource_missing'],['/v1/topups/%ZZ','invalid_parameter'],
 ];for(const [path,code] of cases)await rejects(w,path,code);
});

test('new void source has a stable native creation time but no charge or balance transaction',async()=>{
 const f=fixture(),{w}=f,p=f.payment({voided:true}),before=structuredClone(w),native=await body(w,'/v1/payment_intents/'+p.id);assert.equal(native.created,epoch(p.created_at));assert.equal(native.status,'canceled');assert.equal(native.latest_charge,null);assert.equal(native.amount_received,0);assert.deepEqual((await body(w,'/v1/charges')).data,[]);assert.deepEqual((await body(w,'/v1/balance_transactions')).data,[]);assert.equal(w.operations.length,0);assert.deepEqual(w,before);f.act({type:'advance_time',hours:1});assert.deepEqual(await body(w,'/v1/payment_intents/'+p.id),native);
});

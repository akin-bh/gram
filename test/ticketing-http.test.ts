import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {start} from './integration-fixture.ts';
import {agentActionSchema} from '../src/agent.ts';

type Fixture=Awaited<ReturnType<typeof start>>;
const controllerActions=['record_ticket_event','record_ticket_order','record_ticket_payment','record_processor_payout','record_processor_topup','record_ticket_cancellation'];
const opening='2026-10-01T09:00:00.000Z',asOf='2026-10-01T12:00:00.000Z';
function configuration({closed=false,threshold=5000,withBill=false}: {closed?:boolean;threshold?:number;withBill?:boolean}={}){
  return {kind:'ticket-cancellation',name:'gram ticket HTTP',seed:83,orderCount:1,startingCashMinor:100000,approvalThresholdMinor:threshold,cancelEvent:false,blueprint:{version:1,opening_at:opening,as_of:asOf,period_closed:closed,
    vendors:[{ref:'promoter',name:'gram source promoter',email:'ops@promoter.test'}],customers:[{ref:'buyer',name:'Source ticket buyer',email:'buyer@audience.test'}],
    ticket_events:[{ref:'show',name:'gram exact-source show',promoter_ref:'promoter',starts_at:'2026-10-03T19:00:00.000Z',agreement_reference:'SIGNED-AGREEMENT-1',agreement_signed_at:'2026-09-25T09:00:00.000Z'}],
    ticket_orders:[{ref:'sale',event_ref:'show',customer_ref:'buyer',source_order_id:'HTTP-ORDER-1',ordered_at:'2026-10-01T09:30:00.000Z',quantity:2,face_minor:10000,tax_minor:900,fee_minor:1500}],
    ticket_payment_outcomes:[{ref:'capture',order_ref:'sale',source_payment_id:'HTTP-CAPTURE-1',outcome:'captured',amount_minor:12400,processor_fee_minor:400,occurred_at:'2026-10-01T10:00:00.000Z',available_at:'2026-10-01T10:30:00.000Z'}],
    processor_payouts:[{ref:'payout',source_payout_id:'HTTP-PAYOUT-1',source_bank_transaction_id:'HTTP-BANK-PAYOUT-1',amount_minor:5000,paid_at:'2026-10-01T11:00:00.000Z'}],
    processor_topups:[{ref:'topup',source_topup_id:'HTTP-TOPUP-1',source_bank_transaction_id:'HTTP-BANK-TOPUP-1',amount_minor:1000,posted_at:'2026-10-01T11:15:00.000Z'}],
    ticket_cancellations:[{ref:'cancellation',event_ref:'show',source_notice_id:'HTTP-NOTICE-1',cancelled_at:'2026-10-01T11:30:00.000Z',reason:'Promoter confirms safety cancellation; refund original admission and tax only.'}],
    bank_statements:[{ref:'statement',source_statement_id:'HTTP-STATEMENT-1',account_ref:'operating',currency:'USD',start_at:opening,end_at:'2026-10-01T11:45:00.000Z',opening_balance_minor:100000,closing_balance_minor:104000,lines:[{ref:'payout-line',source_line_id:'PAYOUT-LINE',posted_at:'2026-10-01T11:00:00.000Z',amount_minor:5000,source_refs:[{kind:'processor_payout',ref:'payout'}]},{ref:'topup-line',source_line_id:'TOPUP-LINE',posted_at:'2026-10-01T11:15:00.000Z',amount_minor:-1000,source_refs:[{kind:'processor_topup',ref:'topup'}]}]}],
    ...(withBill?{service_contracts:[{ref:'supplier-contract',counterparty_kind:'vendor',counterparty_ref:'promoter',amount_minor:100000,description:'Separately completed venue services',signed_at:'2026-09-20T09:00:00.000Z'}],service_bills:[{ref:'supplier-bill',contract_ref:'supplier-contract',invoice_number:'VENUE-SERVICE-1',amount_minor:100000,service_completed_at:'2026-09-28T09:00:00.000Z',completion_reference:'VENUE-COMPLETION-1',issued_at:'2026-09-29T09:00:00.000Z',due_at:'2026-10-02T09:00:00.000Z'}]}:{}),
  }};
}
const okay=(response:any)=>{assert.equal(response.status,200,JSON.stringify(response.data));return response.data.result;};
const state=async(f:Fixture,id:string)=>(await f.call(`/api/worlds/${id}`)).data;
const create=async(f:Fixture,input:any=configuration())=>{const response=await f.call('/api/worlds',input);assert.equal(response.status,201,JSON.stringify(response.data));return response.data.world;};
const raw=(f:Fixture,id:string)=>(f.server.store.db.query('SELECT value FROM worlds WHERE id=?').get(id) as any).value as string;
const balance=(w:any,id:string)=>w.accounts.find((row:any)=>row.id===id).balance_minor;
const idempotencyCount=(f:Fixture,id:string)=>(f.server.store.db.query('SELECT count(*) n FROM idempotency WHERE world=?').get(id) as any).n;
const native=async(f:Fixture,id:string,route:string,token:string,input?:any,key?:string)=>{
  const response=await fetch(`${f.base}/providers/stripe/worlds/${id}${route}`,{method:input===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(input===undefined?{}:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})})},...(input===undefined?{}:{body:JSON.stringify(input)})});
  return {status:response.status,data:await response.json(),headers:response.headers};
};
async function grant(f:Fixture,world:string,system:string,scope='read write'){
  const home=await fetch(f.base),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  const redirect='http://127.0.0.1:9123/ticketing-http-test',client=await f.call('/api/oauth/clients',{name:'Ticket HTTP verification',redirect_uris:[redirect]});assert.equal(client.status,201);
  const verifier=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),form=new URLSearchParams({client_id:client.data.client_id,redirect_uri:redirect,response_type:'code',scope,state:randomUUID(),world_id:world,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
  const authorized=await fetch(`${f.base}/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,Origin:f.base,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});assert.equal(authorized.status,303);await authorized.text();
  const response=await f.call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:client.data.client_id,redirect_uri:redirect,code:new URL(authorized.headers.get('location')!).searchParams.get('code'),code_verifier:verifier},undefined,randomUUID(),true);assert.equal(response.status,200,JSON.stringify(response.data));return response.data.access_token as string;
}

test('ticket source HTTP actions are controller-only, schema-isolated, replayable and atomic under malformed or conflicting facts',async()=>{
  const f=await start(':memory:');
  try{
    const w=await create(f),id=w.id,agent=f.agent(id),write=await grant(f,id,'stripe'),read=await grant(f,id,'stripe','read'),wrong=await grant(f,id,'mercury'),other=await create(f);
    const caps=(await f.call('/api/capabilities')).data,context=(await f.call(`/api/worlds/${id}/context?view=overview`,undefined,agent)).data;
    const actions=w.generationHistory.filter((row:any)=>controllerActions.includes(row.action.type)).map((row:any)=>row.action);
    assert.equal(actions.length,6);
    for(const action of actions){assert.ok(caps.controller_actions.includes(action.type));assert.equal(caps.actions.includes(action.type),false);assert.equal(context.available_actions.includes(action.type),false);assert.equal(agentActionSchema.safeParse(action).success,false);
      const before=raw(f,id),count=idempotencyCount(f,id);for(const token of [agent,write,read])assert.equal((await f.act(id,action,token)).status,403);assert.equal(raw(f,id),before);assert.equal(idempotencyCount(f,id),count);
    }
    assert.equal((await f.call(`/api/worlds/${id}/actions`,actions[0],undefined,randomUUID(),true)).status,401);
    assert.equal((await native(f,other.id,'/v1/balance',write)).status,403);assert.equal((await native(f,id,'/v1/balance',wrong)).status,403);
    assert.equal((await native(f,id,'/v1/refunds',read,{payment_intent:w.payments[0].id,amount:100},'read-cannot-refund')).status,403);
    assert.equal((await native(f,id,'/v1/refunds',write,{payment_intent:w.payments[0].id,amount:100})).status,400,'Native writes require an idempotency key');
    for(const route of ['/v1/payouts','/v1/topups'])assert.equal((await native(f,id,route,write,{amount:100},randomUUID())).status,404);
    const paymentAction=actions.find((row:any)=>row.type==='record_ticket_payment'),externalCount=w.externalEvents.length,history=structuredClone(w.generationHistory),economics=structuredClone({bank:w.bankTransactions,journals:w.journals,processor:w.processorTransactions});
    const result=okay(await f.act(id,paymentAction,undefined,'replay-original-source'));assert.equal(result.replayed,true);assert.deepEqual(result.payment,w.externalEvents.find((row:any)=>row.id===paymentAction.external_event_id).result.payment);
    const after=raw(f,id);assert.equal((await f.act(id,paymentAction,undefined,'replay-original-source')).data.replayed,true);assert.equal(raw(f,id),after);
    const changedFact=await f.act(id,{...paymentAction,amount_minor:12401});assert.equal(changedFact.status,409);assert.equal(changedFact.data.error.code,'external_event_conflict');assert.equal(raw(f,id),after);
    for(const action of [{...paymentAction,external_event_id:'unsupported-ticket-field',force:true},{type:'record_processor_topup',source_topup_id:'BAD-TOPUP',source_bank_transaction_id:'BAD-TOPUP-BANK',amount_minor:0.1,posted_at:w.now,external_event_id:'bad-fractional-topup'},{type:'record_processor_payout',source_payout_id:'HUGE-PAYOUT',source_bank_transaction_id:'HUGE-PAYOUT-BANK',amount_minor:8001,paid_at:w.now,external_event_id:'unfunded-payout'}]){const prior=raw(f,id),count=idempotencyCount(f,id),response=await f.act(id,action);assert.ok(response.status===400||response.status===409,JSON.stringify(response.data));assert.equal(raw(f,id),prior);assert.equal(idempotencyCount(f,id),count);}
    const invalidWorld=configuration(),worldCount=f.server.store.worlds().length;invalidWorld.blueprint.ticket_payment_outcomes[0].amount_minor=12399;const rejected=await f.call('/api/worlds',invalidWorld);assert.equal(rejected.status,400);assert.equal(f.server.store.worlds().length,worldCount);assert.equal(raw(f,id),after);
    const saved=(await state(f,id)).world;assert.equal(saved.externalEvents.length,externalCount);assert.deepEqual(saved.generationHistory,history);assert.deepEqual({bank:saved.bankTransactions,journals:saved.journals,processor:saved.processorTransactions},economics);assert.equal((await f.call(`/api/worlds/${id}/audit/verify`)).data.valid,true);
  }finally{await f.close();}
});

test('native Stripe source reads retain canonical IDs and concurrent refund retries create exactly one accepted operation',async()=>{
  const f=await start(':memory:');
  try{
    const w=await create(f,configuration({threshold:100000})),id=w.id,read=await grant(f,id,'stripe','read'),write=await grant(f,id,'stripe');
    const caps=(await f.call('/api/capabilities')).data,newIds=['balance_transactions.list','balance_transactions.get','payouts.list','payouts.get','topups.list','topups.get'].map(id=>'stripe.'+id);
    for(const id of newIds){const contract=caps.provider_contracts.find((row:any)=>row.id===id);assert.ok(contract);assert.equal(contract.method,'GET');assert.equal(contract.access,'read');}
    const before=raw(f,id),count=idempotencyCount(f,id),seen:any[]=[];let cursor='';
    do{const response=await native(f,id,'/v1/balance_transactions?limit=1'+(cursor?'&starting_after='+cursor:''),read);assert.equal(response.status,200);assert.equal(response.data.object,'list');seen.push(...response.data.data);cursor=response.data.has_more?response.data.data.at(-1).id:'';}while(cursor);
    assert.deepEqual(seen.map(row=>row.id),w.processorTransactions.map((row:any)=>row.id).reverse());assert.equal(new Set(seen.map(row=>row.id)).size,3);
    for(const row of seen){const detail=await native(f,id,`/v1/balance_transactions/${row.id}`,read);assert.equal(detail.status,200);assert.deepEqual(detail.data,row);const canonical=w.processorTransactions.find((item:any)=>item.id===row.id);assert.equal(row.amount,canonical.amount_minor);assert.equal(row.fee,canonical.fee_minor);assert.equal(row.net,canonical.net_minor);assert.equal(row.finance_world.operation_id,canonical.operation_id);}
    for(const [resource,rows] of [['payouts',w.processorPayouts],['topups',w.processorTopups]] as const){const list=await native(f,id,`/v1/${resource}`,read);assert.equal(list.status,200);assert.equal(list.data.data.length,1);const detail=await native(f,id,`/v1/${resource}/${rows[0].id}`,read);assert.equal(detail.status,200);assert.deepEqual(detail.data,list.data.data[0]);assert.equal(detail.data.balance_transaction,rows[0].processor_transaction_id);assert.equal(detail.data.finance_world.bank_transaction_id,rows[0].bank_transaction_id);assert.equal(detail.data.finance_world.receipt_id,rows[0].receipt_id);}
    const charge=await native(f,id,`/v1/charges/${w.payments[0].charge_id}`,read);assert.equal(charge.status,200);assert.equal(charge.data.balance_transaction,w.payments[0].processor_transaction_id);assert.equal(charge.data.payment_intent,w.payments[0].id);
    const balanceResponse=await native(f,id,'/v1/balance',read);assert.equal(balanceResponse.data.available[0].amount,8000);assert.equal(balanceResponse.data.finance_world.spendable_minor,8000);
    assert.equal((await native(f,id,'/v1/balance_transactions?payout='+w.processorPayouts[0].id,read)).status,501);assert.equal(raw(f,id),before);assert.equal(idempotencyCount(f,id),count);
    const input={payment_intent:w.payments[0].id,amount:500},key='one-concurrent-native-refund';const replies=await Promise.all(Array.from({length:8},()=>native(f,id,'/v1/refunds',write,input,key)));
    assert.ok(replies.every(row=>row.status===200),JSON.stringify(replies.map(row=>row.data)));assert.ok(replies.every(row=>JSON.stringify(row.data)===JSON.stringify(replies[0].data)));assert.equal(replies.filter(row=>row.headers.get('Idempotent-Replayed')==='true').length,7);
    const accepted=(await state(f,id)).world;assert.equal(accepted.refunds.length,1);assert.equal(accepted.operations.filter((row:any)=>row.type==='refund').length,1);assert.equal(accepted.refunds[0].status,'pending');assert.equal(accepted.refunds[0].id,replies[0].data.id);assert.equal(replies[0].data.balance_transaction,null);
    const conflicted=await native(f,id,'/v1/refunds',write,{...input,amount:501},key);assert.equal(conflicted.status,409);assert.equal(conflicted.data.error.code,'idempotency_conflict');
    okay(await f.act(id,{type:'advance_time',hours:1}));const settled=(await state(f,id)).world,receipt=await native(f,id,`/v1/refunds/${accepted.refunds[0].id}`,read);assert.equal(receipt.data.status,'succeeded');assert.equal(receipt.data.balance_transaction,settled.processorTransactions.find((row:any)=>row.type==='refund').id);assert.deepEqual(settled.bankTransactions,w.bankTransactions);
    const rawSettled=raw(f,id),replay=await native(f,id,'/v1/refunds',write,input,key);assert.equal(replay.status,200);assert.deepEqual(replay.data,replies[0].data);assert.equal(replay.data.status,'pending','Native replay is the immutable original acknowledgement');assert.equal(raw(f,id),rawSettled);
  }finally{await f.close();}
});

test('processor refunds, bank reservations, historical cutoffs, signed delivery and SQLite restart retain one coherent HTTP history',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'gram-ticketing-http-')),database=join(folder,'world.sqlite');let f=await start(database);
  try{
    const w=await create(f,configuration({closed:true,withBill:true})),id=w.id,prefix=`/api/worlds/${id}`,stripe=await grant(f,id,'stripe'),mercury=await grant(f,id,'mercury');
    const hook=await f.call(prefix+'/webhooks',{events:['*']});assert.equal(hook.status,201);
    const sourceDocs=structuredClone(w.documents),sourceHistory=structuredClone(w.generationHistory),sourcePayouts=structuredClone(w.processorPayouts),sourceTopups=structuredClone(w.processorTopups),statement=w.bankStatements[0];
    assert.equal(balance(w,'cash-bank'),100000);assert.equal(balance(w,'cash-processor'),0);assert.equal(w.settledUnposted.length,4);
    const unpostedNative=await native(f,id,'/v1/balance',stripe);assert.equal(unpostedNative.status,200);assert.equal(unpostedNative.data.available[0].amount,8000,'Provider money is independent of deferred GL');
    for(const line of statement.lines){const bank=w.bankTransactions.find((row:any)=>line.source_refs.includes(row.source_transaction_id));okay(await f.act(id,{type:'match_statement_line',statement_id:statement.id,line_id:line.id,bank_transaction_ids:[bank.id]},mercury));}
    const missing=okay(await f.act(id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;assert.equal(missing.can_close,false);assert.ok(missing.blockers.some((row:any)=>row.code==='missing_cash_journal'));
    okay(await f.act(id,{type:'reopen_period'}));const prepared=okay(await f.act(id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;
    assert.equal(prepared.can_close,true);assert.equal(prepared.bank_closing_minor,104000);assert.equal(prepared.book_closing_minor,100000);assert.equal(prepared.adjusted_difference_minor,0);assert.equal(prepared.timing_items.length,2);assert.ok(prepared.timing_items.every((row:any)=>row.posted_at===asOf&&row.economic_at<asOf));
    const close={type:'close_reconciliation',statement_id:statement.id,report_id:prepared.id,source_fingerprint:prepared.source_fingerprint,acknowledged_timing_item_ids:prepared.timing_items.map((row:any)=>row.id),external_event_id:'ticket-statement-close'};
    assert.equal((await f.act(id,close,mercury)).status,403);okay(await f.act(id,close));
    const request={payment_intent:w.payments[0].id,amount:6000},requestKey='independent-refund-request';
    const requested=await native(f,id,'/v1/refunds',stripe,request,requestKey);assert.equal(requested.status,202);assert.equal(requested.data.object,'finance_world.approval_required');
    assert.equal((await f.act(id,{type:'decide_approval',approval_id:requested.data.approval_id,decision:'approve'},stripe)).status,403);
    const accepted=okay(await f.act(id,{type:'decide_approval',approval_id:requested.data.approval_id,decision:'approve'}));assert.equal(accepted.operation.status,'pending');assert.equal(accepted.operation.cash_account_id,'cash-processor');assert.notEqual(accepted.approval.requested_by,accepted.approval.decided_by);
    const reserved=await native(f,id,'/v1/balance',stripe);assert.equal(reserved.data.available[0].amount,8000);assert.equal(reserved.data.finance_world.reserved_minor,6000);assert.equal(reserved.data.finance_world.spendable_minor,2000);
    let snapshot=await state(f,id);assert.equal(snapshot.summary.reserved_minor,0,'Processor refund does not reserve operating-bank money');
    const billRequested=okay(await f.act(id,{type:'pay_bill',bill_id:w.bills[0].id},mercury));assert.equal(billRequested.status,'awaiting_approval');const billAccepted=okay(await f.act(id,{type:'decide_approval',approval_id:billRequested.approval_id,decision:'approve'}));assert.equal(billAccepted.operation.status,'pending');
    snapshot=await state(f,id);assert.equal(snapshot.summary.reserved_minor,100000);assert.equal(snapshot.summary.available_cash_minor,4000);
    for(const action of [
      {type:'record_processor_payout',source_payout_id:'RESERVED-PAYOUT',source_bank_transaction_id:'RESERVED-PAYOUT-BANK',amount_minor:2001,paid_at:snapshot.world.now,external_event_id:'cannot-spend-refund-reservation'},
      {type:'record_processor_topup',source_topup_id:'RESERVED-TOPUP',source_bank_transaction_id:'RESERVED-TOPUP-BANK',amount_minor:4001,posted_at:snapshot.world.now,external_event_id:'cannot-spend-bill-reservation'},
    ]){const before=raw(f,id),response=await f.act(id,action);assert.equal(response.status,409);assert.equal(raw(f,id),before);}
    const originalBank=structuredClone(snapshot.world.bankTransactions);
    for(const system of ['bank','stripe','ledger','gmail'])okay(await f.act(id,{type:'set_fault',system,mode:'offline'}));
    okay(await f.act(id,{type:'advance_time',hours:1}));snapshot=await state(f,id);let refundOp=snapshot.world.operations.find((row:any)=>row.id===accepted.operation.id);assert.equal(refundOp.status,'pending');assert.equal(refundOp.last_error,'stripe:offline');assert.equal(snapshot.world.refunds[0].status,'pending');assert.deepEqual(snapshot.world.bankTransactions,originalBank);
    okay(await f.act(id,{type:'set_fault',system:'stripe',mode:'healthy'}));okay(await f.act(id,{type:'advance_time',hours:1}));snapshot=await state(f,id);refundOp=snapshot.world.operations.find((row:any)=>row.id===accepted.operation.id);
    assert.equal(snapshot.world.faults.bank.mode,'offline');assert.equal(refundOp.status,'settled','Processor-funded refund settles while the bank provider remains offline');assert.equal(refundOp.accounting_status,'pending_posting');assert.equal(refundOp.journal_id,undefined);assert.equal(snapshot.world.operations.find((row:any)=>row.id===billAccepted.operation.id).status,'pending');assert.equal(snapshot.world.refunds[0].status,'succeeded');assert.deepEqual(snapshot.world.bankTransactions,originalBank);
    assert.equal(balance(snapshot.world,'cash-processor'),8000);assert.equal(balance(snapshot.world,'ticket-liability'),-10900);const nativeAfter=await native(f,id,'/v1/balance',stripe);assert.equal(nativeAfter.status,200);assert.equal(nativeAfter.data.available[0].amount,2000);assert.equal(nativeAfter.data.finance_world.reserved_minor,0);
    const refund=await native(f,id,`/v1/refunds/${accepted.refund.id}`,stripe);assert.equal(refund.status,200);assert.equal(refund.data.status,'succeeded');assert.ok(refund.data.balance_transaction);const cashMovement=await native(f,id,`/v1/balance_transactions/${refund.data.balance_transaction}`,stripe);assert.equal(cashMovement.data.amount,-6000);assert.equal(cashMovement.data.net,-6000);assert.equal(cashMovement.data.source,accepted.refund.id);
    const notices=snapshot.world.messages.filter((row:any)=>row.direction==='outbound'&&row.source_refs.includes(accepted.refund.id));assert.equal(notices.length,1);assert.equal(notices[0].delivery_status,'queued');const noticeId=notices[0].id,settledAt=refundOp.settled_at;
    okay(await f.act(id,{type:'set_fault',system:'ledger',mode:'healthy'}));const postedAt=new Date(Date.parse(settledAt)+1).toISOString();okay(await f.act(id,{type:'advance_to',at:postedAt}));snapshot=await state(f,id);refundOp=snapshot.world.operations.find((row:any)=>row.id===accepted.operation.id);assert.equal(refundOp.accounting_status,'posted');assert.equal(snapshot.world.journals.find((row:any)=>row.id===refundOp.journal_id).posted_at,postedAt);assert.equal(balance(snapshot.world,'cash-processor'),2000);assert.equal(balance(snapshot.world,'ticket-liability'),-4900);assert.equal(snapshot.world.journals.filter((row:any)=>row.source_id===refundOp.id).length,1);
    okay(await f.act(id,{type:'set_fault',system:'gmail',mode:'healthy'}));okay(await f.act(id,{type:'advance_to',at:new Date(Date.parse(postedAt)+1).toISOString()}));snapshot=await state(f,id);assert.equal(snapshot.world.messages.find((row:any)=>row.id===noticeId).delivery_status,'delivered');assert.equal(snapshot.world.messages.filter((row:any)=>row.direction==='outbound'&&row.source_refs.includes(accepted.refund.id)).length,1);assert.deepEqual(snapshot.world.bankTransactions,originalBank);assert.deepEqual(snapshot.world.generationHistory,sourceHistory);assert.deepEqual(snapshot.world.processorPayouts,sourcePayouts);assert.deepEqual(snapshot.world.processorTopups,sourceTopups);for(const doc of sourceDocs)assert.deepEqual(snapshot.world.documents.find((row:any)=>row.id===doc.id),doc);
    const event=f.server.store.db.query('SELECT d.id delivery_id,d.event_id,d.subscription_id,e.body FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.world=? LIMIT 1').get(id) as any;assert.ok(event);const timestamp=String(Math.floor(Date.now()/1000));
    const invalid=await fetch(`${f.base}/receivers/${id}`,{method:'POST',headers:{'Content-Type':'application/json','x-finance-world-subscription-id':event.subscription_id,'x-finance-world-delivery-id':event.delivery_id,'x-finance-world-event-id':event.event_id,'x-finance-world-timestamp':timestamp,'x-finance-world-signature':'v1='+'0'.repeat(64)},body:event.body});assert.equal(invalid.status,401);await invalid.text();
    for(let i=0;i<10;i++){const delivered=await f.call(prefix+'/webhooks/dispatch',{});assert.equal(delivered.status,200);assert.equal(delivered.data.failed,0);if(!delivered.data.attempted)break;}
    snapshot=await state(f,id);const receipts=snapshot.webhooks.receiver.receipts;assert.ok(receipts.length>0);assert.equal(new Set(receipts.map((row:any)=>row.delivery_id)).size,receipts.length);assert.ok(snapshot.webhooks.deliveries.data.every((row:any)=>row.status==='delivered'));assert.equal((f.server.store.db.query('SELECT count(*) n FROM webhook_deliveries WHERE world=? AND status=?').get(id,'delivered') as any).n,receipts.length);
    for(const type of ['processor.transaction_recorded','approval.decided','operation.settled','ledger.posted','email.queued','email.delivered','reconciliation.closed'])assert.ok(receipts.some((row:any)=>row.event.type===type),type);
    assert.equal((await f.call(prefix+'/audit/verify')).data.valid,true);assert.equal(f.server.store.verify('_service').valid,true);
    const durable=structuredClone({world:snapshot.world,connections:snapshot.connections,receipts}),savedRaw=raw(f,id),auditPrefix=f.server.store.db.query('SELECT * FROM audit WHERE world=? ORDER BY seq').all(id),idemRows=f.server.store.db.query('SELECT * FROM idempotency WHERE world=? ORDER BY actor,key').all(id);
    await f.close();f=await start(database);assert.equal(raw(f,id),savedRaw);snapshot=await state(f,id);assert.deepEqual({world:snapshot.world,connections:snapshot.connections,receipts:snapshot.webhooks.receiver.receipts},durable);
    const replay=await native(f,id,'/v1/refunds',stripe,request,requestKey);assert.equal(replay.status,202);assert.deepEqual(replay.data,requested.data);assert.equal(replay.headers.get('Idempotent-Replayed'),'true');assert.equal(raw(f,id),savedRaw);assert.deepEqual(f.server.store.db.query('SELECT * FROM idempotency WHERE world=? ORDER BY actor,key').all(id),idemRows);
    assert.deepEqual(f.server.store.db.query('SELECT * FROM audit WHERE world=? ORDER BY seq').all(id).slice(0,auditPrefix.length),auditPrefix);assert.equal((await f.call(prefix+'/audit/verify')).data.valid,true);assert.equal((await native(f,id,'/v1/balance',stripe)).data.available[0].amount,2000);
    const audit=JSON.stringify(f.server.store.events(id,0,1000));for(const secret of [stripe,mercury,hook.data.secret])if(secret)assert.equal(audit.includes(secret),false);
  }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

test('read-only legacy Stripe projections leave persisted JSON, economic history and idempotency unchanged',async()=>{
  const f=await start(':memory:');
  try{
    const w=await create(f,{kind:'ticket-cancellation',name:'Legacy tickets',seed:7,orderCount:2,startingCashMinor:100000}),id=w.id,read=await grant(f,id,'stripe','read');
    // Model a pre-ticketing persisted snapshot in this isolated test database.
    // Its existing bank-funded captures must never become new processor facts.
    const legacy=JSON.parse(raw(f,id));for(const key of ['processorTransactions','processorPayouts','processorTopups','ticketCancellations'])delete legacy[key];legacy.accounts=legacy.accounts.filter((row:any)=>row.id!=='processor-fees');
    f.server.store.db.query('UPDATE worlds SET value=? WHERE id=?').run(JSON.stringify(legacy),id);
    const before=raw(f,id),count=idempotencyCount(f,id),seq=(f.server.store.db.query('SELECT coalesce(max(seq),0) n FROM audit WHERE world=?').get(id) as any).n;
    const current=await state(f,id);assert.equal(current.world.payments.length,2);assert.equal((await native(f,id,'/v1/balance',read)).data.available[0].amount,0);
    for(const route of ['/v1/balance_transactions','/v1/payouts','/v1/topups'])assert.deepEqual((await native(f,id,route,read)).data.data,[]);
    const charges=(await native(f,id,'/v1/charges',read)).data.data;assert.equal(charges.length,2);assert.ok(charges.every((row:any)=>row.balance_transaction===null));assert.equal(charges[0].id,'ch_'+legacy.payments[0].id);
    for(const feed of ['processor-transaction','processor-payout','processor-topup']){const response=await f.call(`/api/worlds/${id}/records?system=stripe&feed=${feed}`,undefined,read);assert.equal(response.status,200);assert.deepEqual(response.data.data,[]);}
    assert.equal((await native(f,id,'/v1/balance_transactions/txn_999999',read)).status,404);assert.equal(raw(f,id),before);assert.equal(idempotencyCount(f,id),count);
    const later=f.server.store.db.query('SELECT value FROM audit WHERE world=? AND seq>?').all(id,seq) as any[];assert.ok(later.every(row=>JSON.parse(row.value).type==='http.request'));assert.equal((await f.call(`/api/worlds/${id}/audit/verify`)).data.valid,true);
  }finally{await f.close();}
});

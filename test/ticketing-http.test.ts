import {test,expect} from 'bun:test';
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
const okay=(response:any)=>{expect(response.status,JSON.stringify(response.data)).toBe(200);return response.data.result;};
const state=async(f:Fixture,id:string)=>(await f.call(`/api/worlds/${id}`)).data;
const create=async(f:Fixture,input:any=configuration())=>{const response=await f.call('/api/worlds',input);expect(response.status,JSON.stringify(response.data)).toBe(201);return response.data.world;};
const raw=(f:Fixture,id:string)=>(f.server.store.db.query('SELECT value FROM worlds WHERE id=?').get(id) as any).value as string;
const balance=(w:any,id:string)=>w.accounts.find((row:any)=>row.id===id).balance_minor;
const idempotencyCount=(f:Fixture,id:string)=>(f.server.store.db.query('SELECT count(*) n FROM idempotency WHERE world=?').get(id) as any).n;
const native=async(f:Fixture,id:string,route:string,token:string,input?:any,key?:string)=>{
  const response=await fetch(`${f.base}/providers/stripe/worlds/${id}${route}`,{method:input===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(input===undefined?{}:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})})},...(input===undefined?{}:{body:JSON.stringify(input)})});
  return {status:response.status,data:await response.json(),headers:response.headers};
};
async function grant(f:Fixture,world:string,system:string,scope='read write'){
  const home=await fetch(f.base),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  const redirect='http://127.0.0.1:9123/ticketing-http-test',client=await f.call('/api/oauth/clients',{name:'Ticket HTTP verification',redirect_uris:[redirect]});expect(client.status).toBe(201);
  const verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''),form=new URLSearchParams({client_id:client.data.client_id,redirect_uri:redirect,response_type:'code',scope,state:crypto.randomUUID(),world_id:world,code_challenge:new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
  const authorized=await fetch(`${f.base}/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,Origin:f.base,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});expect(authorized.status).toBe(303);await authorized.text();
  const response=await f.call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:client.data.client_id,redirect_uri:redirect,code:new URL(authorized.headers.get('location')!).searchParams.get('code'),code_verifier:verifier},undefined,crypto.randomUUID(),true);expect(response.status,JSON.stringify(response.data)).toBe(200);return response.data.access_token as string;
}

test('ticket source HTTP actions are controller-only, schema-isolated, replayable and atomic under malformed or conflicting facts',async()=>{
  const f=await start(':memory:');
  try{
    const w=await create(f),id=w.id,agent=f.agent(id),write=await grant(f,id,'stripe'),read=await grant(f,id,'stripe','read'),wrong=await grant(f,id,'mercury'),other=await create(f);
    const caps=(await f.call('/api/capabilities')).data,context=(await f.call(`/api/worlds/${id}/context?view=overview`,undefined,agent)).data;
    const actions=w.generationHistory.filter((row:any)=>controllerActions.includes(row.action.type)).map((row:any)=>row.action);
    expect(actions.length).toBe(6);
    for(const action of actions){expect(caps.controller_actions.includes(action.type)).toBeTruthy();expect(caps.actions.includes(action.type)).toBe(false);expect(context.available_actions.includes(action.type)).toBe(false);expect(agentActionSchema.safeParse(action).success).toBe(false);
      const before=raw(f,id),count=idempotencyCount(f,id);for(const token of [agent,write,read])expect((await f.act(id,action,token)).status).toBe(403);expect(raw(f,id)).toBe(before);expect(idempotencyCount(f,id)).toBe(count);
    }
    expect((await f.call(`/api/worlds/${id}/actions`,actions[0],undefined,crypto.randomUUID(),true)).status).toBe(401);
    expect((await native(f,other.id,'/v1/balance',write)).status).toBe(403);expect((await native(f,id,'/v1/balance',wrong)).status).toBe(403);
    expect((await native(f,id,'/v1/refunds',read,{payment_intent:w.payments[0].id,amount:100},'read-cannot-refund')).status).toBe(403);
    expect((await native(f,id,'/v1/refunds',write,{payment_intent:w.payments[0].id,amount:100})).status,'Native writes require an idempotency key').toBe(400);
    for(const route of ['/v1/payouts','/v1/topups'])expect((await native(f,id,route,write,{amount:100},crypto.randomUUID())).status).toBe(404);
    const paymentAction=actions.find((row:any)=>row.type==='record_ticket_payment'),externalCount=w.externalEvents.length,history=structuredClone(w.generationHistory),economics=structuredClone({bank:w.bankTransactions,journals:w.journals,processor:w.processorTransactions});
    const result=okay(await f.act(id,paymentAction,undefined,'replay-original-source'));expect(result.replayed).toBe(true);expect(result.payment).toStrictEqual(w.externalEvents.find((row:any)=>row.id===paymentAction.external_event_id).result.payment);
    const after=raw(f,id);expect((await f.act(id,paymentAction,undefined,'replay-original-source')).data.replayed).toBe(true);expect(raw(f,id)).toBe(after);
    const changedFact=await f.act(id,{...paymentAction,amount_minor:12401});expect(changedFact.status).toBe(409);expect(changedFact.data.error.code).toBe('external_event_conflict');expect(raw(f,id)).toBe(after);
    for(const action of [{...paymentAction,external_event_id:'unsupported-ticket-field',force:true},{type:'record_processor_topup',source_topup_id:'BAD-TOPUP',source_bank_transaction_id:'BAD-TOPUP-BANK',amount_minor:0.1,posted_at:w.now,external_event_id:'bad-fractional-topup'},{type:'record_processor_payout',source_payout_id:'HUGE-PAYOUT',source_bank_transaction_id:'HUGE-PAYOUT-BANK',amount_minor:8001,paid_at:w.now,external_event_id:'unfunded-payout'}]){const prior=raw(f,id),count=idempotencyCount(f,id),response=await f.act(id,action);expect(response.status===400||response.status===409,JSON.stringify(response.data)).toBeTruthy();expect(raw(f,id)).toBe(prior);expect(idempotencyCount(f,id)).toBe(count);}
    const invalidWorld=configuration(),worldCount=f.server.store.worlds().length;invalidWorld.blueprint.ticket_payment_outcomes[0].amount_minor=12399;const rejected=await f.call('/api/worlds',invalidWorld);expect(rejected.status).toBe(400);expect(f.server.store.worlds().length).toBe(worldCount);expect(raw(f,id)).toBe(after);
    const saved=(await state(f,id)).world;expect(saved.externalEvents.length).toBe(externalCount);expect(saved.generationHistory).toStrictEqual(history);expect({bank:saved.bankTransactions,journals:saved.journals,processor:saved.processorTransactions}).toStrictEqual(economics);expect((await f.call(`/api/worlds/${id}/audit/verify`)).data.valid).toBe(true);
  }finally{await f.close();}
});

test('native Stripe source reads retain canonical IDs and concurrent refund retries create exactly one accepted operation',async()=>{
  const f=await start(':memory:');
  try{
    const w=await create(f,configuration({threshold:100000})),id=w.id,read=await grant(f,id,'stripe','read'),write=await grant(f,id,'stripe');
    const caps=(await f.call('/api/capabilities')).data,newIds=['balance_transactions.list','balance_transactions.get','payouts.list','payouts.get','topups.list','topups.get'].map(id=>'stripe.'+id);
    for(const id of newIds){const contract=caps.provider_contracts.find((row:any)=>row.id===id);expect(contract).toBeTruthy();expect(contract.method).toBe('GET');expect(contract.access).toBe('read');}
    const before=raw(f,id),count=idempotencyCount(f,id),seen:any[]=[];let cursor='';
    do{const response=await native(f,id,'/v1/balance_transactions?limit=1'+(cursor?'&starting_after='+cursor:''),read);expect(response.status).toBe(200);expect(response.data.object).toBe('list');seen.push(...response.data.data);cursor=response.data.has_more?response.data.data.at(-1).id:'';}while(cursor);
    expect(seen.map(row=>row.id)).toStrictEqual(w.processorTransactions.map((row:any)=>row.id).reverse());expect(new Set(seen.map(row=>row.id)).size).toBe(3);
    for(const row of seen){const detail=await native(f,id,`/v1/balance_transactions/${row.id}`,read);expect(detail.status).toBe(200);expect(detail.data).toStrictEqual(row);const canonical=w.processorTransactions.find((item:any)=>item.id===row.id);expect(row.amount).toBe(canonical.amount_minor);expect(row.fee).toBe(canonical.fee_minor);expect(row.net).toBe(canonical.net_minor);expect(row.finance_world.operation_id).toBe(canonical.operation_id);}
    for(const [resource,rows] of [['payouts',w.processorPayouts],['topups',w.processorTopups]] as const){const list=await native(f,id,`/v1/${resource}`,read);expect(list.status).toBe(200);expect(list.data.data.length).toBe(1);const detail=await native(f,id,`/v1/${resource}/${rows[0].id}`,read);expect(detail.status).toBe(200);expect(detail.data).toStrictEqual(list.data.data[0]);expect(detail.data.balance_transaction).toBe(rows[0].processor_transaction_id);expect(detail.data.finance_world.bank_transaction_id).toBe(rows[0].bank_transaction_id);expect(detail.data.finance_world.receipt_id).toBe(rows[0].receipt_id);}
    const charge=await native(f,id,`/v1/charges/${w.payments[0].charge_id}`,read);expect(charge.status).toBe(200);expect(charge.data.balance_transaction).toBe(w.payments[0].processor_transaction_id);expect(charge.data.payment_intent).toBe(w.payments[0].id);
    const balanceResponse=await native(f,id,'/v1/balance',read);expect(balanceResponse.data.available[0].amount).toBe(8000);expect(balanceResponse.data.finance_world.spendable_minor).toBe(8000);
    expect((await native(f,id,'/v1/balance_transactions?payout='+w.processorPayouts[0].id,read)).status).toBe(501);expect(raw(f,id)).toBe(before);expect(idempotencyCount(f,id)).toBe(count);
    const input={payment_intent:w.payments[0].id,amount:500},key='one-concurrent-native-refund';const replies=await Promise.all(Array.from({length:8},()=>native(f,id,'/v1/refunds',write,input,key)));
    expect(replies.every(row=>row.status===200),JSON.stringify(replies.map(row=>row.data))).toBeTruthy();expect(replies.every(row=>JSON.stringify(row.data)===JSON.stringify(replies[0].data))).toBeTruthy();expect(replies.filter(row=>row.headers.get('Idempotent-Replayed')==='true').length).toBe(7);
    const accepted=(await state(f,id)).world;expect(accepted.refunds.length).toBe(1);expect(accepted.operations.filter((row:any)=>row.type==='refund').length).toBe(1);expect(accepted.refunds[0].status).toBe('pending');expect(accepted.refunds[0].id).toBe(replies[0].data.id);expect(replies[0].data.balance_transaction).toBeNull();
    const conflicted=await native(f,id,'/v1/refunds',write,{...input,amount:501},key);expect(conflicted.status).toBe(409);expect(conflicted.data.error.code).toBe('idempotency_conflict');
    okay(await f.act(id,{type:'advance_time',hours:1}));const settled=(await state(f,id)).world,receipt=await native(f,id,`/v1/refunds/${accepted.refunds[0].id}`,read);expect(receipt.data.status).toBe('succeeded');expect(receipt.data.balance_transaction).toBe(settled.processorTransactions.find((row:any)=>row.type==='refund').id);expect(settled.bankTransactions).toStrictEqual(w.bankTransactions);
    const rawSettled=raw(f,id),replay=await native(f,id,'/v1/refunds',write,input,key);expect(replay.status).toBe(200);expect(replay.data).toStrictEqual(replies[0].data);expect(replay.data.status,'Native replay is the immutable original acknowledgement').toBe('pending');expect(raw(f,id)).toBe(rawSettled);
  }finally{await f.close();}
});

test('processor refunds, bank reservations, historical cutoffs, signed delivery and SQLite restart retain one coherent HTTP history',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'gram-ticketing-http-')),database=join(folder,'world.sqlite');let f=await start(database);
  try{
    const w=await create(f,configuration({closed:true,withBill:true})),id=w.id,prefix=`/api/worlds/${id}`,stripe=await grant(f,id,'stripe'),mercury=await grant(f,id,'mercury');
    const hook=await f.call(prefix+'/webhooks',{events:['*']});expect(hook.status).toBe(201);
    const sourceDocs=structuredClone(w.documents),sourceHistory=structuredClone(w.generationHistory),sourcePayouts=structuredClone(w.processorPayouts),sourceTopups=structuredClone(w.processorTopups),statement=w.bankStatements[0];
    expect(balance(w,'cash-bank')).toBe(100000);expect(balance(w,'cash-processor')).toBe(0);expect(w.settledUnposted.length).toBe(4);
    const unpostedNative=await native(f,id,'/v1/balance',stripe);expect(unpostedNative.status).toBe(200);expect(unpostedNative.data.available[0].amount,'Provider money is independent of deferred GL').toBe(8000);
    for(const line of statement.lines){const bank=w.bankTransactions.find((row:any)=>line.source_refs.includes(row.source_transaction_id));okay(await f.act(id,{type:'match_statement_line',statement_id:statement.id,line_id:line.id,bank_transaction_ids:[bank.id]},mercury));}
    const missing=okay(await f.act(id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;expect(missing.can_close).toBe(false);expect(missing.blockers.some((row:any)=>row.code==='missing_cash_journal')).toBeTruthy();
    okay(await f.act(id,{type:'reopen_period'}));const prepared=okay(await f.act(id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;
    expect(prepared.can_close).toBe(true);expect(prepared.bank_closing_minor).toBe(104000);expect(prepared.book_closing_minor).toBe(100000);expect(prepared.adjusted_difference_minor).toBe(0);expect(prepared.timing_items.length).toBe(2);expect(prepared.timing_items.every((row:any)=>row.posted_at===asOf&&row.economic_at<asOf)).toBeTruthy();
    const close={type:'close_reconciliation',statement_id:statement.id,report_id:prepared.id,source_fingerprint:prepared.source_fingerprint,acknowledged_timing_item_ids:prepared.timing_items.map((row:any)=>row.id),external_event_id:'ticket-statement-close'};
    expect((await f.act(id,close,mercury)).status).toBe(403);okay(await f.act(id,close));
    const request={payment_intent:w.payments[0].id,amount:6000},requestKey='independent-refund-request';
    const requested=await native(f,id,'/v1/refunds',stripe,request,requestKey);expect(requested.status).toBe(202);expect(requested.data.object).toBe('finance_world.approval_required');
    expect((await f.act(id,{type:'decide_approval',approval_id:requested.data.approval_id,decision:'approve'},stripe)).status).toBe(403);
    const accepted=okay(await f.act(id,{type:'decide_approval',approval_id:requested.data.approval_id,decision:'approve'}));expect(accepted.operation.status).toBe('pending');expect(accepted.operation.cash_account_id).toBe('cash-processor');expect(accepted.approval.requested_by).not.toBe(accepted.approval.decided_by);
    const reserved=await native(f,id,'/v1/balance',stripe);expect(reserved.data.available[0].amount).toBe(8000);expect(reserved.data.finance_world.reserved_minor).toBe(6000);expect(reserved.data.finance_world.spendable_minor).toBe(2000);
    let snapshot=await state(f,id);expect(snapshot.summary.reserved_minor,'Processor refund does not reserve operating-bank money').toBe(0);
    const billRequested=okay(await f.act(id,{type:'pay_bill',bill_id:w.bills[0].id},mercury));expect(billRequested.status).toBe('awaiting_approval');const billAccepted=okay(await f.act(id,{type:'decide_approval',approval_id:billRequested.approval_id,decision:'approve'}));expect(billAccepted.operation.status).toBe('pending');
    snapshot=await state(f,id);expect(snapshot.summary.reserved_minor).toBe(100000);expect(snapshot.summary.available_cash_minor).toBe(4000);
    for(const action of [
      {type:'record_processor_payout',source_payout_id:'RESERVED-PAYOUT',source_bank_transaction_id:'RESERVED-PAYOUT-BANK',amount_minor:2001,paid_at:snapshot.world.now,external_event_id:'cannot-spend-refund-reservation'},
      {type:'record_processor_topup',source_topup_id:'RESERVED-TOPUP',source_bank_transaction_id:'RESERVED-TOPUP-BANK',amount_minor:4001,posted_at:snapshot.world.now,external_event_id:'cannot-spend-bill-reservation'},
    ]){const before=raw(f,id),response=await f.act(id,action);expect(response.status).toBe(409);expect(raw(f,id)).toBe(before);}
    const originalBank=structuredClone(snapshot.world.bankTransactions);
    for(const system of ['bank','stripe','ledger','gmail'])okay(await f.act(id,{type:'set_fault',system,mode:'offline'}));
    okay(await f.act(id,{type:'advance_time',hours:1}));snapshot=await state(f,id);let refundOp=snapshot.world.operations.find((row:any)=>row.id===accepted.operation.id);expect(refundOp.status).toBe('pending');expect(refundOp.last_error).toBe('stripe:offline');expect(snapshot.world.refunds[0].status).toBe('pending');expect(snapshot.world.bankTransactions).toStrictEqual(originalBank);
    okay(await f.act(id,{type:'set_fault',system:'stripe',mode:'healthy'}));okay(await f.act(id,{type:'advance_time',hours:1}));snapshot=await state(f,id);refundOp=snapshot.world.operations.find((row:any)=>row.id===accepted.operation.id);
    expect(snapshot.world.faults.bank.mode).toBe('offline');expect(refundOp.status,'Processor-funded refund settles while the bank provider remains offline').toBe('settled');expect(refundOp.accounting_status).toBe('pending_posting');expect(refundOp.journal_id).toBeUndefined();expect(snapshot.world.operations.find((row:any)=>row.id===billAccepted.operation.id).status).toBe('pending');expect(snapshot.world.refunds[0].status).toBe('succeeded');expect(snapshot.world.bankTransactions).toStrictEqual(originalBank);
    expect(balance(snapshot.world,'cash-processor')).toBe(8000);expect(balance(snapshot.world,'ticket-liability')).toBe(-10900);const nativeAfter=await native(f,id,'/v1/balance',stripe);expect(nativeAfter.status).toBe(200);expect(nativeAfter.data.available[0].amount).toBe(2000);expect(nativeAfter.data.finance_world.reserved_minor).toBe(0);
    const refund=await native(f,id,`/v1/refunds/${accepted.refund.id}`,stripe);expect(refund.status).toBe(200);expect(refund.data.status).toBe('succeeded');expect(refund.data.balance_transaction).toBeTruthy();const cashMovement=await native(f,id,`/v1/balance_transactions/${refund.data.balance_transaction}`,stripe);expect(cashMovement.data.amount).toBe(-6000);expect(cashMovement.data.net).toBe(-6000);expect(cashMovement.data.source).toBe(accepted.refund.id);
    const notices=snapshot.world.messages.filter((row:any)=>row.direction==='outbound'&&row.source_refs.includes(accepted.refund.id));expect(notices.length).toBe(1);expect(notices[0].delivery_status).toBe('queued');const noticeId=notices[0].id,settledAt=refundOp.settled_at;
    okay(await f.act(id,{type:'set_fault',system:'ledger',mode:'healthy'}));const postedAt=new Date(Date.parse(settledAt)+1).toISOString();okay(await f.act(id,{type:'advance_to',at:postedAt}));snapshot=await state(f,id);refundOp=snapshot.world.operations.find((row:any)=>row.id===accepted.operation.id);expect(refundOp.accounting_status).toBe('posted');expect(snapshot.world.journals.find((row:any)=>row.id===refundOp.journal_id).posted_at).toBe(postedAt);expect(balance(snapshot.world,'cash-processor')).toBe(2000);expect(balance(snapshot.world,'ticket-liability')).toBe(-4900);expect(snapshot.world.journals.filter((row:any)=>row.source_id===refundOp.id).length).toBe(1);
    okay(await f.act(id,{type:'set_fault',system:'gmail',mode:'healthy'}));okay(await f.act(id,{type:'advance_to',at:new Date(Date.parse(postedAt)+1).toISOString()}));snapshot=await state(f,id);expect(snapshot.world.messages.find((row:any)=>row.id===noticeId).delivery_status).toBe('delivered');expect(snapshot.world.messages.filter((row:any)=>row.direction==='outbound'&&row.source_refs.includes(accepted.refund.id)).length).toBe(1);expect(snapshot.world.bankTransactions).toStrictEqual(originalBank);expect(snapshot.world.generationHistory).toStrictEqual(sourceHistory);expect(snapshot.world.processorPayouts).toStrictEqual(sourcePayouts);expect(snapshot.world.processorTopups).toStrictEqual(sourceTopups);for(const doc of sourceDocs)expect(snapshot.world.documents.find((row:any)=>row.id===doc.id)).toStrictEqual(doc);
    const event=f.server.store.db.query('SELECT d.id delivery_id,d.event_id,d.subscription_id,e.body FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.world=? LIMIT 1').get(id) as any;expect(event).toBeTruthy();const timestamp=String(Math.floor(Date.now()/1000));
    const invalid=await fetch(`${f.base}/receivers/${id}`,{method:'POST',headers:{'Content-Type':'application/json','x-finance-world-subscription-id':event.subscription_id,'x-finance-world-delivery-id':event.delivery_id,'x-finance-world-event-id':event.event_id,'x-finance-world-timestamp':timestamp,'x-finance-world-signature':'v1='+'0'.repeat(64)},body:event.body});expect(invalid.status).toBe(401);await invalid.text();
    for(let i=0;i<10;i++){const delivered=await f.call(prefix+'/webhooks/dispatch',{});expect(delivered.status).toBe(200);expect(delivered.data.failed).toBe(0);if(!delivered.data.attempted)break;}
    snapshot=await state(f,id);const receipts=snapshot.webhooks.receiver.receipts;expect(receipts.length>0).toBeTruthy();expect(new Set(receipts.map((row:any)=>row.delivery_id)).size).toBe(receipts.length);expect(snapshot.webhooks.deliveries.data.every((row:any)=>row.status==='delivered')).toBeTruthy();expect((f.server.store.db.query('SELECT count(*) n FROM webhook_deliveries WHERE world=? AND status=?').get(id,'delivered') as any).n).toBe(receipts.length);
    for(const type of ['processor.transaction_recorded','approval.decided','operation.settled','ledger.posted','email.queued','email.delivered','reconciliation.closed'])expect(receipts.some((row:any)=>row.event.type===type),type).toBeTruthy();
    expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);expect(f.server.store.verify('_service').valid).toBe(true);
    const durable=structuredClone({world:snapshot.world,connections:snapshot.connections,receipts}),savedRaw=raw(f,id),auditPrefix=f.server.store.db.query('SELECT * FROM audit WHERE world=? ORDER BY seq').all(id),idemRows=f.server.store.db.query('SELECT * FROM idempotency WHERE world=? ORDER BY actor,key').all(id);
    await f.close();f=await start(database);expect(raw(f,id)).toBe(savedRaw);snapshot=await state(f,id);expect({world:snapshot.world,connections:snapshot.connections,receipts:snapshot.webhooks.receiver.receipts}).toStrictEqual(durable);
    const replay=await native(f,id,'/v1/refunds',stripe,request,requestKey);expect(replay.status).toBe(202);expect(replay.data).toStrictEqual(requested.data);expect(replay.headers.get('Idempotent-Replayed')).toBe('true');expect(raw(f,id)).toBe(savedRaw);expect(f.server.store.db.query('SELECT * FROM idempotency WHERE world=? ORDER BY actor,key').all(id)).toStrictEqual(idemRows);
    expect(f.server.store.db.query('SELECT * FROM audit WHERE world=? ORDER BY seq').all(id).slice(0,auditPrefix.length)).toStrictEqual(auditPrefix);expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);expect((await native(f,id,'/v1/balance',stripe)).data.available[0].amount).toBe(2000);
    const audit=JSON.stringify(f.server.store.events(id,0,1000));for(const secret of [stripe,mercury,hook.data.secret])if(secret)expect(audit.includes(secret)).toBe(false);
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
    const current=await state(f,id);expect(current.world.payments.length).toBe(2);expect((await native(f,id,'/v1/balance',read)).data.available[0].amount).toBe(0);
    for(const route of ['/v1/balance_transactions','/v1/payouts','/v1/topups'])expect((await native(f,id,route,read)).data.data).toStrictEqual([]);
    const charges=(await native(f,id,'/v1/charges',read)).data.data;expect(charges.length).toBe(2);expect(charges.every((row:any)=>row.balance_transaction===null)).toBeTruthy();expect(charges[0].id).toBe('ch_'+legacy.payments[0].id);
    for(const feed of ['processor-transaction','processor-payout','processor-topup']){const response=await f.call(`/api/worlds/${id}/records?system=stripe&feed=${feed}`,undefined,read);expect(response.status).toBe(200);expect(response.data.data).toStrictEqual([]);}
    expect((await native(f,id,'/v1/balance_transactions/txn_999999',read)).status).toBe(404);expect(raw(f,id)).toBe(before);expect(idempotencyCount(f,id)).toBe(count);
    const later=f.server.store.db.query('SELECT value FROM audit WHERE world=? AND seq>?').all(id,seq) as any[];expect(later.every(row=>JSON.parse(row.value).type==='http.request')).toBeTruthy();expect((await f.call(`/api/worlds/${id}/audit/verify`)).data.valid).toBe(true);
  }finally{await f.close();}
});

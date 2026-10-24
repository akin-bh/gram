import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {hash} from '../src/store.ts';

async function start(database=':memory:',port=0){
  const server=await startServer({database,port,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  const home=await fetch(base,{headers:{Connection:'close'}});assert.equal(home.status,200);const cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  const call=async(path:string,input?:any,options:{token?:string;anonymous?:boolean;key?:string}={})=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(options.token?{Authorization:`Bearer ${options.token}`}:(options.anonymous?{}:{Cookie:cookie})),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':options.key??randomUUID()})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const create=async()=>{const response=await call('/api/worlds',{kind:'saas-collections',name:'gram bank activity review',orderCount:1,seed:91,startingCashMinor:100000});assert.equal(response.status,201);return response.data.world;};
  const grant=async(world:string,system:string,scope='read write')=>{
    const redirect='http://127.0.0.1:9123/bank-activity-test',registered=await call('/api/oauth/clients',{name:'gram bank activity operator',redirect_uris:[redirect]});assert.equal(registered.status,201);
    const verifier=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
    const form=new URLSearchParams({client_id:registered.data.client_id,redirect_uri:redirect,response_type:'code',scope,state:randomUUID(),world_id:world,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
    const accepted=await fetch(base+`/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});assert.equal(accepted.status,303);await accepted.text();
    const code=new URL(accepted.headers.get('location')!).searchParams.get('code');
    const token=await call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:registered.data.client_id,redirect_uri:redirect,code,code_verifier:verifier},{anonymous:true});assert.equal(token.status,200,JSON.stringify(token.data));return token.data.access_token as string;
  };
  const agent=(world:string)=>{const token=randomUUID();server.store.put('agent-tokens',hash(token),{world,actor:`agent-world:${world}`,expires_at:Date.now()+60000});return token;};
  const act=(world:string,action:any,token?:string,key?:string)=>call(`/api/worlds/${world}/actions`,action,{token,key});
  const state=async(world:string)=>(await call(`/api/worlds/${world}`)).data;
  return {server,base,call,create,grant,agent,act,state,close:()=>server.close()};
}
const okay=(response:any)=>{assert.equal(response.status,200,JSON.stringify(response.data));return response.data.result;};
const source=(world:any,kind:'fee'|'interest',id:string,amount=250)=>({type:'record_bank_activity',source_transaction_id:id,account_id:'cash-bank',currency:'USD',kind,amount_minor:amount,posted_at:world.now,description:`Independent bank source ${id}`,external_event_id:`event-${id}`});
const sourceFields=(activity:any)=>Object.fromEntries(['id','source_transaction_id','account_id','currency','kind','amount_minor','cash_effect_minor','posted_at','observed_at','description','recorded_by','external_event_id','operation_id','bank_transaction_id','receipt_id','document_id'].map(key=>[key,activity[key]]));
const closeInput=(statement:any,report:any,event:string)=>({type:'close_reconciliation',statement_id:statement.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((item:any)=>item.id),external_event_id:event});
const balance=(world:any,id:string)=>world.accounts.find((account:any)=>account.id===id).balance_minor;
async function statementFor(f:Awaited<ReturnType<typeof start>>,world:any,startAt:string,opening:number,activities:any[],mercury:string){
  const statement=okay(await f.act(world.id,{type:'record_bank_statement',source_statement_id:'gram-fee-interest-source',account_id:'cash-bank',currency:'USD',start_at:startAt,end_at:world.now,opening_balance_minor:opening,closing_balance_minor:opening+activities.reduce((sum:number,activity:any)=>sum+activity.cash_effect_minor,0),lines:activities.map((activity:any,index:number)=>({source_line_id:`bank-source-line-${index}`,posted_at:activity.posted_at,amount_minor:activity.cash_effect_minor,source_refs:[activity.source_transaction_id]})),external_event_id:'bank-source-statement-arrived'})).statement;
  for(const line of statement.lines){const activity=activities.find(item=>line.source_refs.includes(item.source_transaction_id));okay(await f.act(world.id,{type:'match_statement_line',statement_id:statement.id,line_id:line.id,bank_transaction_ids:[activity.bank_transaction_id]},mercury));}
  return statement;
}

test('bank cash observations are controller facts while classification requires NetSuite OAuth scope and immutable source identity',async()=>{
  const f=await start();
  try{
    const world=await f.create(),other=await f.create(),prefix=`/api/worlds/${world.id}`,agent=f.agent(world.id),input=source(world,'fee','gram-original-fee'),before=await f.state(world.id);
    const denied=await f.act(world.id,input,agent);assert.equal(denied.status,403);
    assert.equal((await f.call(prefix+'/actions',input,{anonymous:true})).status,401);
    const created=okay(await f.act(world.id,input,undefined,'one-independent-bank-fact')),activity=created.bank_activity;
    assert.equal(created.bank_transaction.amount_minor,-input.amount_minor);assert.equal(created.bank_transaction.source_transaction_id,input.source_transaction_id);assert.equal(created.bank_transaction.source_id,created.operation.id);assert.equal(activity.operation_id,created.operation.id);
    assert.equal((await f.state(world.id)).summary.cash_minor,before.summary.cash_minor-input.amount_minor);
    const economicAfterRecord=JSON.stringify(f.server.store.world(world.id).bankTransactions);
    assert.equal((await f.act(world.id,input,undefined,'one-independent-bank-fact')).data.replayed,true);
    assert.equal(okay(await f.act(world.id,input,undefined,'same-external-fact-second-http-key')).replayed,true);
    const collision=await f.act(world.id,{...input,external_event_id:'distinct-event-same-bank-source'});assert.equal(collision.status,409);assert.equal(collision.data.error.code,'duplicate_bank_activity_source');
    const keyConflict=await f.act(world.id,{...input,amount_minor:251},undefined,'one-independent-bank-fact');assert.equal(keyConflict.status,409);assert.equal(keyConflict.data.error.code,'idempotency_conflict');
    const classify={type:'classify_bank_activity',bank_activity_id:activity.id,account_id:'bank-fee-expense'};
    assert.equal((await f.act(world.id,classify,agent)).status,401,'Agent has no NetSuite connection');
    const read=await f.grant(world.id,'netsuite','read'),write=await f.grant(world.id,'netsuite'),mercury=await f.grant(world.id,'mercury');
    const listed=await f.call(prefix+'/records?system=netsuite&feed=bank-activity',undefined,{token:read});assert.equal(listed.status,200);assert.equal(listed.data.data[0].id,activity.id);
    assert.equal((await f.act(world.id,classify,read)).status,403);assert.equal((await f.act(world.id,classify,mercury)).status,403);
    assert.equal((await f.call(`/api/worlds/${other.id}/records?system=netsuite&feed=bank-activity`,undefined,{token:write})).status,403);
    assert.equal((await f.call(prefix+'/records?system=bank&feed=bank-activity',undefined,{token:write})).status,403);
    assert.equal((await f.act(world.id,{...input,source_transaction_id:'operator-cannot-mint-cash',external_event_id:'operator-fact'},write)).status,403);
    const mismatch=await f.act(world.id,{...classify,account_id:'interest-income'},write);assert.equal(mismatch.status,409);assert.equal(mismatch.data.error.code,'bank_activity_classification_mismatch');
    okay(await f.act(world.id,{type:'set_fault',system:'netsuite',mode:'offline'}));assert.equal((await f.act(world.id,classify,write,'classification-after-recovery')).status,503);okay(await f.act(world.id,{type:'set_fault',system:'netsuite',mode:'healthy'}));
    const classified=okay(await f.act(world.id,classify,write,'classification-after-recovery'));assert.equal(classified.bank_activity.status,'classified');assert.equal(classified.bank_activity.classification_account_id,'bank-fee-expense');assert.deepEqual(sourceFields(classified.bank_activity),sourceFields(activity));
    const repeat=okay(await f.act(world.id,classify,write));assert.equal(repeat.replayed,true);assert.equal(repeat.operation.id,classified.operation.id);
    const replayedSource=okay(await f.act(world.id,input));assert.equal(replayedSource.replayed,true);assert.equal(replayedSource.bank_activity.status,'unclassified','Original source acknowledgment remains an immutable receipt');
    const state=await f.state(world.id);assert.equal(state.world.bankActivities.length,1);assert.equal(state.world.bankActivities[0].status,'classified');assert.equal(JSON.stringify(state.world.bankTransactions),economicAfterRecord);assert.equal(state.world.operations.length,2);assert.equal(balance(state.world,'bank-suspense'),0);assert.equal(balance(state.world,'bank-fee-expense'),250);
    assert.equal(state.summary.reconciliation.bank_ledger_difference_minor,0);assert.equal(state.summary.reconciliation.balanced,true);
    const protectedPost=await f.act(world.id,{type:'post_journal',lines:[{account_id:'bank-suspense',debit_minor:250,credit_minor:0},{account_id:'bank-fee-expense',debit_minor:0,credit_minor:250}]},write);assert.equal(protectedPost.status,409);assert.equal(protectedPost.data.error.code,'control_account_locked');assert.equal(JSON.stringify((await f.state(world.id)).world.bankTransactions),economicAfterRecord);
    assert.equal((await f.call(prefix+'/audit/verify')).data.valid,true);const audit=JSON.stringify(f.server.store.events(world.id,0,1000));for(const token of [agent,read,write,mercury])assert.ok(!audit.includes(token));
  }finally{await f.close();}
});

test('external bank source references reconcile only after classification, invalidate old proof and retain signed receipts and source metadata across restart',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'gram-bank-activity-http-')),database=join(folder,'world.sqlite');let f=await start(database);
  try{
    const world=await f.create(),prefix=`/api/worlds/${world.id}`,opening=(await f.state(world.id)).summary.cash_minor,mercury=await f.grant(world.id,'mercury'),netsuite=await f.grant(world.id,'netsuite');
    assert.equal((await f.call(prefix+'/webhooks',{events:['bank_activity.*','reconciliation.*','ledger.*']})).status,201);
    okay(await f.act(world.id,{type:'advance_time',hours:1}));const advanced=(await f.state(world.id)).world;
    const fee=okay(await f.act(world.id,source(advanced,'fee','gram-source-fee',250))).bank_activity,interest=okay(await f.act(world.id,source(advanced,'interest','gram-source-interest',75))).bank_activity,activities=[fee,interest],sourceFacts=activities.map(sourceFields);
    let state=await f.state(world.id);const cashAfterSources=JSON.stringify(state.world.bankTransactions),documents=state.world.documents.filter((document:any)=>activities.some(activity=>activity.document_id===document.id));
    assert.equal(state.summary.cash_minor,opening-175);assert.equal(balance(state.world,'bank-suspense'),175);assert.equal(state.summary.reconciliation.bank_ledger_difference_minor,0);
    const statement=await statementFor(f,state.world,world.now,opening,activities,mercury);
    const blocked=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;assert.equal(blocked.can_close,false);assert.equal(blocked.unmatched_statement_line_ids.length,0);assert.equal(blocked.unmatched_bank_transaction_ids.length,0);assert.equal(blocked.blockers.filter((blocker:any)=>blocker.code==='unclassified_bank_activity').length,2);
    const feeClass=okay(await f.act(world.id,{type:'classify_bank_activity',bank_activity_id:fee.id,account_id:'bank-fee-expense'},netsuite));
    const stale=await f.act(world.id,closeInput(statement,blocked,'cannot-close-old-unclassified-report'));assert.equal(stale.status,409);assert.equal(stale.data.error.code,'stale_reconciliation');
    const interestClass=okay(await f.act(world.id,{type:'classify_bank_activity',bank_activity_id:interest.id,account_id:'interest-income'},netsuite));
    state=await f.state(world.id);assert.equal(JSON.stringify(state.world.bankTransactions),cashAfterSources);assert.deepEqual(state.world.bankActivities.map(sourceFields),sourceFacts);assert.deepEqual(state.world.documents.filter((document:any)=>documents.some((old:any)=>old.id===document.id)),documents);
    assert.equal(balance(state.world,'bank-suspense'),0);assert.equal(balance(state.world,'bank-fee-expense'),250);assert.equal(balance(state.world,'interest-income'),-75);assert.equal(state.summary.cash_minor,opening-175);
    for(const operation of [feeClass.operation,interestClass.operation]){const journal=state.world.journals.find((row:any)=>row.id===operation.journal_id);assert.ok(journal);assert.ok(journal.lines.every((line:any)=>line.account_id!=='cash-bank'),'Classification has no cash line');}
    const prepared=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;assert.equal(prepared.can_close,true);assert.notEqual(prepared.source_fingerprint,blocked.source_fingerprint);assert.deepEqual(prepared.timing_items,[]);assert.deepEqual(prepared.blockers,[]);
    assert.equal(okay(await f.act(world.id,closeInput(statement,prepared,'independent-bank-classification-close'))).closed,true);
    const tooLate=await f.act(world.id,source(advanced,'fee','cannot-rewrite-closed-cutoff',1));assert.equal(tooLate.status,409);assert.equal(tooLate.data.error.code,'bank_activity_closed_statement');assert.equal(JSON.stringify((await f.state(world.id)).world.bankTransactions),cashAfterSources);
    for(let attempt=0;attempt<10;attempt++){const dispatch=await f.call(prefix+'/webhooks/dispatch',{});assert.equal(dispatch.status,200);assert.equal(dispatch.data.failed,0);if(dispatch.data.attempted===0)break;}
    state=await f.state(world.id);const receipts=state.webhooks.receiver.receipts;assert.ok(receipts.length>0);assert.equal(receipts.length,state.webhooks.deliveries.data.length);assert.ok(state.webhooks.deliveries.data.every((delivery:any)=>delivery.status==='delivered'));
    assert.equal(receipts.filter((receipt:any)=>receipt.event.type==='bank_activity.recorded').length,2);assert.equal(receipts.filter((receipt:any)=>receipt.event.type==='bank_activity.classified').length,2);assert.ok(receipts.some((receipt:any)=>receipt.event.type==='reconciliation.closed'));assert.equal(new Set(receipts.map((receipt:any)=>receipt.delivery_id)).size,receipts.length);
    const durable={world:state.world,connections:state.connections,receipts},port=Number(new URL(f.base).port);assert.equal((await f.call(prefix+'/audit/verify')).data.valid,true);
    await f.close();f=await start(database,port);state=await f.state(world.id);assert.deepEqual({world:state.world,connections:state.connections,receipts:state.webhooks.receiver.receipts},durable);
    const persisted=await f.call(prefix+'/records?system=netsuite&feed=bank-activity',undefined,{token:netsuite});assert.equal(persisted.status,200);assert.deepEqual(persisted.data.data.map(sourceFields),sourceFacts);assert.equal((await f.call(prefix+'/audit/verify')).data.valid,true);
  }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

test('period locks and ledger outages preserve external cash facts and defer cash-neutral classifications with exact later-posting acknowledgments',async()=>{
  const f=await start();
  try{
    const world=await f.create(),prefix=`/api/worlds/${world.id}`,mercury=await f.grant(world.id,'mercury'),netsuite=await f.grant(world.id,'netsuite'),opening=(await f.state(world.id)).summary.cash_minor;
    okay(await f.act(world.id,{type:'close_period'}));okay(await f.act(world.id,{type:'set_fault',system:'ledger',mode:'offline'}));okay(await f.act(world.id,{type:'set_fault',system:'mercury',mode:'offline'}));okay(await f.act(world.id,{type:'advance_time',hours:1}));
    const observed=(await f.state(world.id)).world,fee=okay(await f.act(world.id,source(observed,'fee','gram-deferred-fee',400))).bank_activity,interest=okay(await f.act(world.id,source(observed,'interest','gram-deferred-interest',100))).bank_activity,activities=[fee,interest];
    let state=await f.state(world.id);assert.equal(state.summary.cash_minor,opening-300);assert.equal(state.summary.reconciliation.bank_ledger_difference_minor,-300);assert.ok(state.world.operations.every((operation:any)=>operation.status==='settled'&&!operation.journal_id));
    const bankAfterFacts=JSON.stringify(state.world.bankTransactions),sourceFacts=activities.map(sourceFields),journalsBefore=state.world.journals.length;
    for(const activity of activities){const classified=okay(await f.act(world.id,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:activity.kind==='fee'?'bank-fee-expense':'interest-income'},netsuite));assert.equal(classified.bank_activity.status,'classified');assert.equal(classified.operation.journal_id,undefined);}
    state=await f.state(world.id);assert.equal(state.world.operations.length,4);assert.equal(state.world.journals.length,journalsBefore);assert.equal(JSON.stringify(state.world.bankTransactions),bankAfterFacts);assert.deepEqual(state.world.bankActivities.map(sourceFields),sourceFacts);
    okay(await f.act(world.id,{type:'set_fault',system:'mercury',mode:'healthy'}));const statement=await statementFor(f,state.world,world.now,opening,activities,mercury);
    const blocked=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;assert.equal(blocked.can_close,false);assert.ok(blocked.blockers.some((blocker:any)=>blocker.code==='missing_cash_journal'));assert.ok(blocked.blockers.some((blocker:any)=>blocker.code==='unposted_bank_classification'));
    okay(await f.act(world.id,{type:'advance_time',hours:1}));okay(await f.act(world.id,{type:'reopen_period'}));state=await f.state(world.id);assert.equal(state.world.journals.length,journalsBefore,'Reopening does not bypass the ledger outage');assert.equal(JSON.stringify(state.world.bankTransactions),bankAfterFacts);
    okay(await f.act(world.id,{type:'set_fault',system:'ledger',mode:'healthy'}));okay(await f.act(world.id,{type:'advance_time',hours:1}));state=await f.state(world.id);
    assert.equal(state.world.journals.length,journalsBefore+4);assert.ok(state.world.operations.every((operation:any)=>operation.status==='settled'&&operation.journal_id));assert.equal(JSON.stringify(state.world.bankTransactions),bankAfterFacts);assert.deepEqual(state.world.bankActivities.map(sourceFields),sourceFacts);assert.equal(balance(state.world,'bank-suspense'),0);assert.equal(state.summary.cash_minor,opening-300);assert.equal(state.summary.reconciliation.bank_ledger_difference_minor,0);assert.equal(state.summary.reconciliation.balanced,true);
    const stale=await f.act(world.id,closeInput(statement,blocked,'cannot-close-before-deferred-posting'));assert.equal(stale.status,409);assert.equal(stale.data.error.code,'stale_reconciliation');
    const fresh=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;assert.equal(fresh.can_close,true);assert.equal(fresh.bank_book_difference_minor,-300);assert.equal(fresh.later_posted_cash_minor,-300);assert.equal(fresh.adjusted_difference_minor,0);
    assert.equal(fresh.timing_items.filter((item:any)=>item.kind==='posted_after_cutoff').length,2);const classifications=fresh.timing_items.filter((item:any)=>item.kind==='classification_posted_after_cutoff');assert.equal(classifications.length,2);assert.ok(classifications.every((item:any)=>item.cash_effect_minor===0&&item.amount_minor>0&&item.posted_at>statement.end_at));
    const withoutClassification={...closeInput(statement,fresh,'cannot-ignore-late-classification'),acknowledged_timing_item_ids:fresh.timing_items.filter((item:any)=>item.kind==='posted_after_cutoff').map((item:any)=>item.id)};const missingAck=await f.act(world.id,withoutClassification);assert.equal(missingAck.status,409);assert.equal(missingAck.data.error.code,'timing_acknowledgment_required');
    assert.equal(okay(await f.act(world.id,closeInput(statement,fresh,'controller-acknowledges-all-posting-dates'))).closed,true);
    const posted=JSON.stringify(state.world.journals);okay(await f.act(world.id,{type:'advance_time',hours:1}));state=await f.state(world.id);assert.equal(JSON.stringify(state.world.bankTransactions),bankAfterFacts);assert.equal(JSON.stringify(state.world.journals),posted);assert.equal((await f.call(prefix+'/audit/verify')).data.valid,true);
  }finally{await f.close();}
});

import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {hash} from '../src/store.ts';

async function start(database=':memory:',port=0){
  const server=await startServer({database,port,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  const home=await fetch(base,{headers:{Connection:'close'}});expect(home.status).toBe(200);const cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  const call=async(path:string,input?:any,options:{token?:string;anonymous?:boolean;key?:string}={})=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(options.token?{Authorization:`Bearer ${options.token}`}:(options.anonymous?{}:{Cookie:cookie})),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':options.key??crypto.randomUUID()})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const create=async()=>{const response=await call('/api/worlds',{kind:'saas-collections',name:'gram bank activity review',orderCount:1,seed:91,startingCashMinor:100000});expect(response.status).toBe(201);return response.data.world;};
  const grant=async(world:string,system:string,scope='read write')=>{
    const redirect='http://127.0.0.1:9123/bank-activity-test',registered=await call('/api/oauth/clients',{name:'gram bank activity operator',redirect_uris:[redirect]});expect(registered.status).toBe(201);
    const verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    const form=new URLSearchParams({client_id:registered.data.client_id,redirect_uri:redirect,response_type:'code',scope,state:crypto.randomUUID(),world_id:world,code_challenge:new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
    const accepted=await fetch(base+`/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});expect(accepted.status).toBe(303);await accepted.text();
    const code=new URL(accepted.headers.get('location')!).searchParams.get('code');
    const token=await call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:registered.data.client_id,redirect_uri:redirect,code,code_verifier:verifier},{anonymous:true});expect(token.status,JSON.stringify(token.data)).toBe(200);return token.data.access_token as string;
  };
  const agent=(world:string)=>{const token=crypto.randomUUID();server.store.put('agent-tokens',hash(token),{world,actor:`agent-world:${world}`,expires_at:Date.now()+60000});return token;};
  const act=(world:string,action:any,token?:string,key?:string)=>call(`/api/worlds/${world}/actions`,action,{token,key});
  const state=async(world:string)=>(await call(`/api/worlds/${world}`)).data;
  return {server,base,call,create,grant,agent,act,state,close:()=>server.close()};
}
const okay=(response:any)=>{expect(response.status,JSON.stringify(response.data)).toBe(200);return response.data.result;};
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
    const denied=await f.act(world.id,input,agent);expect(denied.status).toBe(403);
    expect((await f.call(prefix+'/actions',input,{anonymous:true})).status).toBe(401);
    const created=okay(await f.act(world.id,input,undefined,'one-independent-bank-fact')),activity=created.bank_activity;
    expect(created.bank_transaction.amount_minor).toBe(-input.amount_minor);expect(created.bank_transaction.source_transaction_id).toBe(input.source_transaction_id);expect(created.bank_transaction.source_id).toBe(created.operation.id);expect(activity.operation_id).toBe(created.operation.id);
    expect((await f.state(world.id)).summary.cash_minor).toBe(before.summary.cash_minor-input.amount_minor);
    const economicAfterRecord=JSON.stringify(f.server.store.world(world.id).bankTransactions);
    expect((await f.act(world.id,input,undefined,'one-independent-bank-fact')).data.replayed).toBe(true);
    expect(okay(await f.act(world.id,input,undefined,'same-external-fact-second-http-key')).replayed).toBe(true);
    const collision=await f.act(world.id,{...input,external_event_id:'distinct-event-same-bank-source'});expect(collision.status).toBe(409);expect(collision.data.error.code).toBe('duplicate_bank_activity_source');
    const keyConflict=await f.act(world.id,{...input,amount_minor:251},undefined,'one-independent-bank-fact');expect(keyConflict.status).toBe(409);expect(keyConflict.data.error.code).toBe('idempotency_conflict');
    const classify={type:'classify_bank_activity',bank_activity_id:activity.id,account_id:'bank-fee-expense'};
    expect((await f.act(world.id,classify,agent)).status,'Agent has no NetSuite connection').toBe(401);
    const read=await f.grant(world.id,'netsuite','read'),write=await f.grant(world.id,'netsuite'),mercury=await f.grant(world.id,'mercury');
    const listed=await f.call(prefix+'/records?system=netsuite&feed=bank-activity',undefined,{token:read});expect(listed.status).toBe(200);expect(listed.data.data[0].id).toBe(activity.id);
    expect((await f.act(world.id,classify,read)).status).toBe(403);expect((await f.act(world.id,classify,mercury)).status).toBe(403);
    expect((await f.call(`/api/worlds/${other.id}/records?system=netsuite&feed=bank-activity`,undefined,{token:write})).status).toBe(403);
    expect((await f.call(prefix+'/records?system=bank&feed=bank-activity',undefined,{token:write})).status).toBe(403);
    expect((await f.act(world.id,{...input,source_transaction_id:'operator-cannot-mint-cash',external_event_id:'operator-fact'},write)).status).toBe(403);
    const mismatch=await f.act(world.id,{...classify,account_id:'interest-income'},write);expect(mismatch.status).toBe(409);expect(mismatch.data.error.code).toBe('bank_activity_classification_mismatch');
    okay(await f.act(world.id,{type:'set_fault',system:'netsuite',mode:'offline'}));expect((await f.act(world.id,classify,write,'classification-after-recovery')).status).toBe(503);okay(await f.act(world.id,{type:'set_fault',system:'netsuite',mode:'healthy'}));
    const classified=okay(await f.act(world.id,classify,write,'classification-after-recovery'));expect(classified.bank_activity.status).toBe('classified');expect(classified.bank_activity.classification_account_id).toBe('bank-fee-expense');expect(sourceFields(classified.bank_activity)).toStrictEqual(sourceFields(activity));
    const repeat=okay(await f.act(world.id,classify,write));expect(repeat.replayed).toBe(true);expect(repeat.operation.id).toBe(classified.operation.id);
    const replayedSource=okay(await f.act(world.id,input));expect(replayedSource.replayed).toBe(true);expect(replayedSource.bank_activity.status,'Original source acknowledgment remains an immutable receipt').toBe('unclassified');
    const state=await f.state(world.id);expect(state.world.bankActivities.length).toBe(1);expect(state.world.bankActivities[0].status).toBe('classified');expect(JSON.stringify(state.world.bankTransactions)).toBe(economicAfterRecord);expect(state.world.operations.length).toBe(2);expect(balance(state.world,'bank-suspense')).toBe(0);expect(balance(state.world,'bank-fee-expense')).toBe(250);
    expect(state.summary.reconciliation.bank_ledger_difference_minor).toBe(0);expect(state.summary.reconciliation.balanced).toBe(true);
    const protectedPost=await f.act(world.id,{type:'post_journal',lines:[{account_id:'bank-suspense',debit_minor:250,credit_minor:0},{account_id:'bank-fee-expense',debit_minor:0,credit_minor:250}]},write);expect(protectedPost.status).toBe(409);expect(protectedPost.data.error.code).toBe('control_account_locked');expect(JSON.stringify((await f.state(world.id)).world.bankTransactions)).toBe(economicAfterRecord);
    expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);const audit=JSON.stringify(f.server.store.events(world.id,0,1000));for(const token of [agent,read,write,mercury])expect(!audit.includes(token)).toBeTruthy();
  }finally{await f.close();}
});

test('external bank source references reconcile only after classification, invalidate old proof and retain signed receipts and source metadata across restart',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'gram-bank-activity-http-')),database=join(folder,'world.sqlite');let f=await start(database);
  try{
    const world=await f.create(),prefix=`/api/worlds/${world.id}`,opening=(await f.state(world.id)).summary.cash_minor,mercury=await f.grant(world.id,'mercury'),netsuite=await f.grant(world.id,'netsuite');
    expect((await f.call(prefix+'/webhooks',{events:['bank_activity.*','reconciliation.*','ledger.*']})).status).toBe(201);
    okay(await f.act(world.id,{type:'advance_time',hours:1}));const advanced=(await f.state(world.id)).world;
    const fee=okay(await f.act(world.id,source(advanced,'fee','gram-source-fee',250))).bank_activity,interest=okay(await f.act(world.id,source(advanced,'interest','gram-source-interest',75))).bank_activity,activities=[fee,interest],sourceFacts=activities.map(sourceFields);
    let state=await f.state(world.id);const cashAfterSources=JSON.stringify(state.world.bankTransactions),documents=state.world.documents.filter((document:any)=>activities.some(activity=>activity.document_id===document.id));
    expect(state.summary.cash_minor).toBe(opening-175);expect(balance(state.world,'bank-suspense')).toBe(175);expect(state.summary.reconciliation.bank_ledger_difference_minor).toBe(0);
    const statement=await statementFor(f,state.world,world.now,opening,activities,mercury);
    const blocked=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;expect(blocked.can_close).toBe(false);expect(blocked.unmatched_statement_line_ids.length).toBe(0);expect(blocked.unmatched_bank_transaction_ids.length).toBe(0);expect(blocked.blockers.filter((blocker:any)=>blocker.code==='unclassified_bank_activity').length).toBe(2);
    const feeClass=okay(await f.act(world.id,{type:'classify_bank_activity',bank_activity_id:fee.id,account_id:'bank-fee-expense'},netsuite));
    const stale=await f.act(world.id,closeInput(statement,blocked,'cannot-close-old-unclassified-report'));expect(stale.status).toBe(409);expect(stale.data.error.code).toBe('stale_reconciliation');
    const interestClass=okay(await f.act(world.id,{type:'classify_bank_activity',bank_activity_id:interest.id,account_id:'interest-income'},netsuite));
    state=await f.state(world.id);expect(JSON.stringify(state.world.bankTransactions)).toBe(cashAfterSources);expect(state.world.bankActivities.map(sourceFields)).toStrictEqual(sourceFacts);expect(state.world.documents.filter((document:any)=>documents.some((old:any)=>old.id===document.id))).toStrictEqual(documents);
    expect(balance(state.world,'bank-suspense')).toBe(0);expect(balance(state.world,'bank-fee-expense')).toBe(250);expect(balance(state.world,'interest-income')).toBe(-75);expect(state.summary.cash_minor).toBe(opening-175);
    for(const operation of [feeClass.operation,interestClass.operation]){const journal=state.world.journals.find((row:any)=>row.id===operation.journal_id);expect(journal).toBeTruthy();expect(journal.lines.every((line:any)=>line.account_id!=='cash-bank'),'Classification has no cash line').toBeTruthy();}
    const prepared=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;expect(prepared.can_close).toBe(true);expect(prepared.source_fingerprint).not.toBe(blocked.source_fingerprint);expect(prepared.timing_items).toStrictEqual([]);expect(prepared.blockers).toStrictEqual([]);
    expect(okay(await f.act(world.id,closeInput(statement,prepared,'independent-bank-classification-close'))).closed).toBe(true);
    const tooLate=await f.act(world.id,source(advanced,'fee','cannot-rewrite-closed-cutoff',1));expect(tooLate.status).toBe(409);expect(tooLate.data.error.code).toBe('bank_activity_closed_statement');expect(JSON.stringify((await f.state(world.id)).world.bankTransactions)).toBe(cashAfterSources);
    for(let attempt=0;attempt<10;attempt++){const dispatch=await f.call(prefix+'/webhooks/dispatch',{});expect(dispatch.status).toBe(200);expect(dispatch.data.failed).toBe(0);if(dispatch.data.attempted===0)break;}
    state=await f.state(world.id);const receipts=state.webhooks.receiver.receipts;expect(receipts.length>0).toBeTruthy();expect(receipts.length).toBe(state.webhooks.deliveries.data.length);expect(state.webhooks.deliveries.data.every((delivery:any)=>delivery.status==='delivered')).toBeTruthy();
    expect(receipts.filter((receipt:any)=>receipt.event.type==='bank_activity.recorded').length).toBe(2);expect(receipts.filter((receipt:any)=>receipt.event.type==='bank_activity.classified').length).toBe(2);expect(receipts.some((receipt:any)=>receipt.event.type==='reconciliation.closed')).toBeTruthy();expect(new Set(receipts.map((receipt:any)=>receipt.delivery_id)).size).toBe(receipts.length);
    const durable={world:state.world,connections:state.connections,receipts},port=Number(new URL(f.base).port);expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);
    await f.close();f=await start(database,port);state=await f.state(world.id);expect({world:state.world,connections:state.connections,receipts:state.webhooks.receiver.receipts}).toStrictEqual(durable);
    const persisted=await f.call(prefix+'/records?system=netsuite&feed=bank-activity',undefined,{token:netsuite});expect(persisted.status).toBe(200);expect(persisted.data.data.map(sourceFields)).toStrictEqual(sourceFacts);expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);
  }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

test('period locks and ledger outages preserve external cash facts and defer cash-neutral classifications with exact later-posting acknowledgments',async()=>{
  const f=await start();
  try{
    const world=await f.create(),prefix=`/api/worlds/${world.id}`,mercury=await f.grant(world.id,'mercury'),netsuite=await f.grant(world.id,'netsuite'),opening=(await f.state(world.id)).summary.cash_minor;
    okay(await f.act(world.id,{type:'close_period'}));okay(await f.act(world.id,{type:'set_fault',system:'ledger',mode:'offline'}));okay(await f.act(world.id,{type:'set_fault',system:'mercury',mode:'offline'}));okay(await f.act(world.id,{type:'advance_time',hours:1}));
    const observed=(await f.state(world.id)).world,fee=okay(await f.act(world.id,source(observed,'fee','gram-deferred-fee',400))).bank_activity,interest=okay(await f.act(world.id,source(observed,'interest','gram-deferred-interest',100))).bank_activity,activities=[fee,interest];
    let state=await f.state(world.id);expect(state.summary.cash_minor).toBe(opening-300);expect(state.summary.reconciliation.bank_ledger_difference_minor).toBe(-300);expect(state.world.operations.every((operation:any)=>operation.status==='settled'&&!operation.journal_id)).toBeTruthy();
    const bankAfterFacts=JSON.stringify(state.world.bankTransactions),sourceFacts=activities.map(sourceFields),journalsBefore=state.world.journals.length;
    for(const activity of activities){const classified=okay(await f.act(world.id,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:activity.kind==='fee'?'bank-fee-expense':'interest-income'},netsuite));expect(classified.bank_activity.status).toBe('classified');expect(classified.operation.journal_id).toBeUndefined();}
    state=await f.state(world.id);expect(state.world.operations.length).toBe(4);expect(state.world.journals.length).toBe(journalsBefore);expect(JSON.stringify(state.world.bankTransactions)).toBe(bankAfterFacts);expect(state.world.bankActivities.map(sourceFields)).toStrictEqual(sourceFacts);
    okay(await f.act(world.id,{type:'set_fault',system:'mercury',mode:'healthy'}));const statement=await statementFor(f,state.world,world.now,opening,activities,mercury);
    const blocked=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;expect(blocked.can_close).toBe(false);expect(blocked.blockers.some((blocker:any)=>blocker.code==='missing_cash_journal')).toBeTruthy();expect(blocked.blockers.some((blocker:any)=>blocker.code==='unposted_bank_classification')).toBeTruthy();
    okay(await f.act(world.id,{type:'advance_time',hours:1}));okay(await f.act(world.id,{type:'reopen_period'}));state=await f.state(world.id);expect(state.world.journals.length,'Reopening does not bypass the ledger outage').toBe(journalsBefore);expect(JSON.stringify(state.world.bankTransactions)).toBe(bankAfterFacts);
    okay(await f.act(world.id,{type:'set_fault',system:'ledger',mode:'healthy'}));okay(await f.act(world.id,{type:'advance_time',hours:1}));state=await f.state(world.id);
    expect(state.world.journals.length).toBe(journalsBefore+4);expect(state.world.operations.every((operation:any)=>operation.status==='settled'&&operation.journal_id)).toBeTruthy();expect(JSON.stringify(state.world.bankTransactions)).toBe(bankAfterFacts);expect(state.world.bankActivities.map(sourceFields)).toStrictEqual(sourceFacts);expect(balance(state.world,'bank-suspense')).toBe(0);expect(state.summary.cash_minor).toBe(opening-300);expect(state.summary.reconciliation.bank_ledger_difference_minor).toBe(0);expect(state.summary.reconciliation.balanced).toBe(true);
    const stale=await f.act(world.id,closeInput(statement,blocked,'cannot-close-before-deferred-posting'));expect(stale.status).toBe(409);expect(stale.data.error.code).toBe('stale_reconciliation');
    const fresh=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;expect(fresh.can_close).toBe(true);expect(fresh.bank_book_difference_minor).toBe(-300);expect(fresh.later_posted_cash_minor).toBe(-300);expect(fresh.adjusted_difference_minor).toBe(0);
    expect(fresh.timing_items.filter((item:any)=>item.kind==='posted_after_cutoff').length).toBe(2);const classifications=fresh.timing_items.filter((item:any)=>item.kind==='classification_posted_after_cutoff');expect(classifications.length).toBe(2);expect(classifications.every((item:any)=>item.cash_effect_minor===0&&item.amount_minor>0&&item.posted_at>statement.end_at)).toBeTruthy();
    const withoutClassification={...closeInput(statement,fresh,'cannot-ignore-late-classification'),acknowledged_timing_item_ids:fresh.timing_items.filter((item:any)=>item.kind==='posted_after_cutoff').map((item:any)=>item.id)};const missingAck=await f.act(world.id,withoutClassification);expect(missingAck.status).toBe(409);expect(missingAck.data.error.code).toBe('timing_acknowledgment_required');
    expect(okay(await f.act(world.id,closeInput(statement,fresh,'controller-acknowledges-all-posting-dates'))).closed).toBe(true);
    const posted=JSON.stringify(state.world.journals);okay(await f.act(world.id,{type:'advance_time',hours:1}));state=await f.state(world.id);expect(JSON.stringify(state.world.bankTransactions)).toBe(bankAfterFacts);expect(JSON.stringify(state.world.journals)).toBe(posted);expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);
  }finally{await f.close();}
});

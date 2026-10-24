import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {hash} from '../src/store.ts';
import {agentActionSchema} from '../src/agent.ts';

async function start(database:string,port=0){
  const server=await startServer({database,port,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  const page=await fetch(base,{headers:{Connection:'close'}});assert.equal(page.status,200);const cookie=page.headers.get('set-cookie')!.split(';')[0];await page.text();
  const call=async(path:string,input?:any,options:{token?:string;anonymous?:boolean;key?:string;revision?:number}={})=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(options.token?{Authorization:`Bearer ${options.token}`}:(options.anonymous?{}:{Cookie:cookie})),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':options.key??randomUUID()}),...(options.revision===undefined?{}:{'If-Match':String(options.revision)})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const create=async()=>{const result=await call('/api/worlds',{name:'gram prior treasury',seed:729,orderCount:2});assert.equal(result.status,201);return result.data.world;};
  const operator=async(world:string)=>{
    const redirect='http://127.0.0.1:9123/company-metadata-test',client=await call('/api/oauth/clients',{name:'gram metadata authority check',redirect_uris:[redirect]});assert.equal(client.status,201);
    const verifier=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
    const form=new URLSearchParams({client_id:client.data.client_id,redirect_uri:redirect,response_type:'code',scope:'read write',state:randomUUID(),world_id:world,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
    const consent=await fetch(base+'/oauth/mercury/authorize',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});assert.equal(consent.status,303);await consent.text();
    const code=new URL(consent.headers.get('location')!).searchParams.get('code');
    const token=await call('/oauth/mercury/token',{grant_type:'authorization_code',client_id:client.data.client_id,redirect_uri:redirect,code,code_verifier:verifier},{anonymous:true});assert.equal(token.status,200);return token.data.access_token as string;
  };
  return {server,base,call,create,operator,close:()=>server.close()};
}
const withoutMetadata=(world:any)=>{const {name,revision,...rest}=structuredClone(world);return rest;};

test('controller company rename changes only canonical name and revision, with one durable signed event and normal concurrency checks',async()=>{
  const f=await start(':memory:');
  try{
    const world=await f.create(),prefix=`/api/worlds/${world.id}`,before=f.server.store.world(world.id);
    assert.equal((await f.call(prefix)).data.connections.filter((row:any)=>row.oauth_status==='connected').length,0,'Metadata correction requires no financial provider grant');
    assert.equal((await f.call(prefix+'/webhooks',{events:['company.renamed']})).status,201);
    const auditBefore=f.server.store.events(world.id,0,1000),input={type:'rename_company',name:'  gram treasury review  '},key='one-canonical-company-rename';
    const attempts=await Promise.all(Array.from({length:4},()=>f.call(prefix+'/actions',input,{key,revision:world.revision})));
    attempts.forEach(result=>assert.equal(result.status,200,JSON.stringify(result.data)));assert.equal(attempts.filter(result=>!result.data.replayed).length,1);
    assert.deepEqual(attempts[0].data.result,{name:'gram treasury review',previous_name:world.name,renamed:true});
    const after=f.server.store.world(world.id);assert.equal(after.name,'gram treasury review');assert.equal(after.revision,before.revision+1);assert.deepEqual(withoutMetadata(after),withoutMetadata(before));
    assert.deepEqual(f.server.store.events(world.id,0,1000).slice(0,auditBefore.length),auditBefore,'Previously audited history is unchanged');
    const renamed=f.server.store.events(world.id,0,1000).filter(row=>row.type==='company.renamed');assert.equal(renamed.length,1);assert.equal(renamed[0].data.name,after.name);assert.equal(renamed[0].data.previous_name,before.name);
    const conflict=await f.call(prefix+'/actions',{...input,name:'gram conflicting edit'},{key});assert.equal(conflict.status,409);assert.equal(conflict.data.error.code,'idempotency_conflict');
    const stale=await f.call(prefix+'/actions',{...input,name:'gram stale edit'},{revision:before.revision});assert.equal(stale.status,409);assert.equal(stale.data.error.code,'stale_revision');assert.deepEqual(f.server.store.world(world.id),after);
    const noChange=await f.call(prefix+'/actions',{type:'rename_company',name:after.name},{revision:after.revision});assert.equal(noChange.status,200);assert.deepEqual(noChange.data.result,{name:after.name,previous_name:after.name,renamed:false});
    assert.deepEqual(withoutMetadata(f.server.store.world(world.id)),withoutMetadata(before));assert.equal(f.server.store.events(world.id,0,1000).filter(row=>row.type==='company.renamed').length,1);
    const pending=(await f.call(prefix+'/webhooks/deliveries')).data.data;assert.equal(pending.length,1);assert.equal(pending[0].event.type,'company.renamed');assert.equal(pending[0].event.data.object.name,after.name);
    assert.equal((await f.call(prefix+'/webhooks/dispatch',{})).data.delivered,1);
    const snapshot=(await f.call(prefix)).data;assert.equal(snapshot.summary.name,after.name);assert.equal(snapshot.webhooks.receiver.receipts.length,1);assert.equal(snapshot.webhooks.receiver.receipts[0].event.type,'company.renamed');assert.equal((await f.call(prefix+'/audit/verify')).data.valid,true);
    const later=await f.call(prefix+'/actions',{type:'rename_company',name:'gram current treasury'});assert.equal(later.status,200);const latest=f.server.store.world(world.id);
    const oldReplay=await f.call(prefix+'/actions',input,{key,revision:before.revision});assert.equal(oldReplay.status,200);assert.equal(oldReplay.data.replayed,true);assert.equal(oldReplay.data.result.name,after.name);assert.deepEqual(f.server.store.world(world.id),latest,'Replaying an older success returns its receipt without restoring an obsolete company name');
    assert.equal(f.server.store.verify(world.id).valid,true);
  }finally{await f.close();}
});

test('company metadata rejects noncontrollers, malformed names and unrelated writes without changing world state',async()=>{
  const f=await start(':memory:');
  try{
    const world=await f.create(),prefix=`/api/worlds/${world.id}`,agent=randomUUID(),operator=await f.operator(world.id),input={type:'rename_company',name:'gram treasury review'};
    f.server.store.put('agent-tokens',hash(agent),{world:world.id,actor:'agent-world:'+world.id,expires_at:Date.now()+60000});
    for(const token of [agent,operator]){const denied=await f.call(prefix+'/actions',input,{token});assert.equal(denied.status,403);assert.equal(denied.data.error.code,'controller_required');}
    assert.equal((await f.call(prefix+'/actions',input,{anonymous:true})).status,401);assert.equal(agentActionSchema.safeParse(input).success,false);
    const before=f.server.store.world(world.id);
    for(const name of ['', '   ', 'g'.repeat(201), null, 42, {}, 'gram\nnew', 'gram\rnew', 'gram\tnew', 'gram\0new', 'gram\u007fnew', 'gram\u0085new', 'gram\u2028new', 'gram\u2029new', '\ngram\n', '\tgram\t']){
      const result=await f.call(prefix+'/actions',{type:'rename_company',name});assert.equal(result.status,400,`Name ${JSON.stringify(name)} must reject: ${JSON.stringify(result.data)}`);assert.deepEqual(f.server.store.world(world.id),before);
    }
    for(const extra of [{aliases:['old-name']},{previous_name:'other-company'},{revision:999},{accounts:[]},{action:'rename_company'},{external_event_id:'unneeded-source'}]){
      const result=await f.call(prefix+'/actions',{...input,...extra});assert.equal(result.status,400);assert.equal(result.data.error.code,'invalid_company_metadata');assert.deepEqual(f.server.store.world(world.id),before);
    }
    const boundary=await f.call(prefix+'/actions',{type:'rename_company',name:'  '+'g'.repeat(200)+'  '});assert.equal(boundary.status,200);assert.equal(boundary.data.result.name.length,200);assert.deepEqual(withoutMetadata(f.server.store.world(world.id)),withoutMetadata(before));
    assert.equal(f.server.store.verify(world.id).valid,true);
  }finally{await f.close();}
});

test('renaming an older persisted world never performs an unrelated migration and survives restart exactly',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'gram-company-metadata-')),database=join(folder,'world.sqlite');let f=await start(database);
  try{
    const world=await f.create(),prefix=`/api/worlds/${world.id}`,legacy=f.server.store.world(world.id);
    for(const key of ['bankStatements','reconciliationMatches','reconciliationReports','employees','payrollPolicies','payrollTimeRecords','payrollRuns','payrollTaxRemittances','payslips','creditNotes','disputes','paymentReturns','externalEvents','settledUnposted','purchaseOrders','purchaseRequisitions','goodsReceipts','supplierInvoices','supplierInvoiceDeliveries','inventoryItems','inventoryLots','inventoryMovements','inventoryAuthorizations'])delete legacy[key];
    legacy.accounts=legacy.accounts.filter((account:any)=>!['wages-payable','employer-payroll-tax-expense','refunds-payable','dispute-suspense','inventory','grni'].includes(account.id));
    for(const payment of legacy.payments){delete payment.amount_disputed_lost_minor;delete payment.amount_ticket_liability_discharged_minor;}
    f.server.store.save(legacy);const before=structuredClone(legacy);
    const input={type:'rename_company',name:'gram restored treasury'},key='old-shape-metadata-only';
    const renamed=await f.call(prefix+'/actions',input,{key,revision:before.revision});assert.equal(renamed.status,200,JSON.stringify(renamed.data));
    const expected={...before,name:input.name,revision:before.revision+1};assert.deepEqual(f.server.store.world(world.id),expected,'Persisted record retains absent fields, original accounts and original payment shape');
    const auditPrefix=f.server.store.events(world.id,0,1000);assert.equal(f.server.store.verify(world.id).valid,true);const port=Number(new URL(f.base).port);
    await f.close();f=await start(database,port);assert.deepEqual(f.server.store.world(world.id),expected);
    assert.deepEqual(f.server.store.events(world.id,0,1000).slice(0,auditPrefix.length),auditPrefix);
    const replay=await f.call(prefix+'/actions',input,{key,revision:before.revision});assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);assert.equal(replay.data.revision,expected.revision);assert.deepEqual(f.server.store.world(world.id),expected);
    const presented=await f.call(prefix);assert.equal(presented.status,200);assert.equal(presented.data.world.name,input.name);assert.equal(presented.data.summary.name,input.name);assert.deepEqual(f.server.store.world(world.id),expected,'Read-time summaries must not persist migrations during metadata verification');
    assert.equal((await f.call(prefix+'/audit/verify')).data.valid,true);
  }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

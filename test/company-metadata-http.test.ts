import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {hash} from '../src/store.ts';
import {agentActionSchema} from '../src/agent.ts';

async function start(database:string,port=0){
  const server=await startServer({database,port,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  const page=await fetch(base,{headers:{Connection:'close'}});expect(page.status).toBe(200);const cookie=page.headers.get('set-cookie')!.split(';')[0];await page.text();
  const call=async(path:string,input?:any,options:{token?:string;anonymous?:boolean;key?:string;revision?:number}={})=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(options.token?{Authorization:`Bearer ${options.token}`}:(options.anonymous?{}:{Cookie:cookie})),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':options.key??crypto.randomUUID()}),...(options.revision===undefined?{}:{'If-Match':String(options.revision)})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const create=async()=>{const result=await call('/api/worlds',{name:'gram prior treasury',seed:729,orderCount:2});expect(result.status).toBe(201);return result.data.world;};
  const operator=async(world:string)=>{
    const redirect='http://127.0.0.1:9123/company-metadata-test',client=await call('/api/oauth/clients',{name:'gram metadata authority check',redirect_uris:[redirect]});expect(client.status).toBe(201);
    const verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    const form=new URLSearchParams({client_id:client.data.client_id,redirect_uri:redirect,response_type:'code',scope:'read write',state:crypto.randomUUID(),world_id:world,code_challenge:new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
    const consent=await fetch(base+'/oauth/mercury/authorize',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});expect(consent.status).toBe(303);await consent.text();
    const code=new URL(consent.headers.get('location')!).searchParams.get('code');
    const token=await call('/oauth/mercury/token',{grant_type:'authorization_code',client_id:client.data.client_id,redirect_uri:redirect,code,code_verifier:verifier},{anonymous:true});expect(token.status).toBe(200);return token.data.access_token as string;
  };
  return {server,base,call,create,operator,close:()=>server.close()};
}
const withoutMetadata=(world:any)=>{const {name,revision,...rest}=structuredClone(world);return rest;};

test('controller company rename changes only canonical name and revision, with one durable signed event and normal concurrency checks',async()=>{
  const f=await start(':memory:');
  try{
    const world=await f.create(),prefix=`/api/worlds/${world.id}`,before=f.server.store.world(world.id);
    expect((await f.call(prefix)).data.connections.filter((row:any)=>row.oauth_status==='connected').length,'Metadata correction requires no financial provider grant').toBe(0);
    expect((await f.call(prefix+'/webhooks',{events:['company.renamed']})).status).toBe(201);
    const auditBefore=f.server.store.events(world.id,0,1000),input={type:'rename_company',name:'  gram treasury review  '},key='one-canonical-company-rename';
    const attempts=await Promise.all(Array.from({length:4},()=>f.call(prefix+'/actions',input,{key,revision:world.revision})));
    attempts.forEach(result=>expect(result.status,JSON.stringify(result.data)).toBe(200));expect(attempts.filter(result=>!result.data.replayed).length).toBe(1);
    expect(attempts[0].data.result).toStrictEqual({name:'gram treasury review',previous_name:world.name,renamed:true});
    const after=f.server.store.world(world.id);expect(after.name).toBe('gram treasury review');expect(after.revision).toBe(before.revision+1);expect(withoutMetadata(after)).toStrictEqual(withoutMetadata(before));
    expect(f.server.store.events(world.id,0,1000).slice(0,auditBefore.length),'Previously audited history is unchanged').toStrictEqual(auditBefore);
    const renamed=f.server.store.events(world.id,0,1000).filter(row=>row.type==='company.renamed');expect(renamed.length).toBe(1);expect(renamed[0].data.name).toBe(after.name);expect(renamed[0].data.previous_name).toBe(before.name);
    const conflict=await f.call(prefix+'/actions',{...input,name:'gram conflicting edit'},{key});expect(conflict.status).toBe(409);expect(conflict.data.error.code).toBe('idempotency_conflict');
    const stale=await f.call(prefix+'/actions',{...input,name:'gram stale edit'},{revision:before.revision});expect(stale.status).toBe(409);expect(stale.data.error.code).toBe('stale_revision');expect(f.server.store.world(world.id)).toStrictEqual(after);
    const noChange=await f.call(prefix+'/actions',{type:'rename_company',name:after.name},{revision:after.revision});expect(noChange.status).toBe(200);expect(noChange.data.result).toStrictEqual({name:after.name,previous_name:after.name,renamed:false});
    expect(withoutMetadata(f.server.store.world(world.id))).toStrictEqual(withoutMetadata(before));expect(f.server.store.events(world.id,0,1000).filter(row=>row.type==='company.renamed').length).toBe(1);
    const pending=(await f.call(prefix+'/webhooks/deliveries')).data.data;expect(pending.length).toBe(1);expect(pending[0].event.type).toBe('company.renamed');expect(pending[0].event.data.object.name).toBe(after.name);
    expect((await f.call(prefix+'/webhooks/dispatch',{})).data.delivered).toBe(1);
    const snapshot=(await f.call(prefix)).data;expect(snapshot.summary.name).toBe(after.name);expect(snapshot.webhooks.receiver.receipts.length).toBe(1);expect(snapshot.webhooks.receiver.receipts[0].event.type).toBe('company.renamed');expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);
    const later=await f.call(prefix+'/actions',{type:'rename_company',name:'gram current treasury'});expect(later.status).toBe(200);const latest=f.server.store.world(world.id);
    const oldReplay=await f.call(prefix+'/actions',input,{key,revision:before.revision});expect(oldReplay.status).toBe(200);expect(oldReplay.data.replayed).toBe(true);expect(oldReplay.data.result.name).toBe(after.name);expect(f.server.store.world(world.id),'Replaying an older success returns its receipt without restoring an obsolete company name').toStrictEqual(latest);
    expect(f.server.store.verify(world.id).valid).toBe(true);
  }finally{await f.close();}
});

test('company metadata rejects noncontrollers, malformed names and unrelated writes without changing world state',async()=>{
  const f=await start(':memory:');
  try{
    const world=await f.create(),prefix=`/api/worlds/${world.id}`,agent=crypto.randomUUID(),operator=await f.operator(world.id),input={type:'rename_company',name:'gram treasury review'};
    f.server.store.put('agent-tokens',hash(agent),{world:world.id,actor:'agent-world:'+world.id,expires_at:Date.now()+60000});
    for(const token of [agent,operator]){const denied=await f.call(prefix+'/actions',input,{token});expect(denied.status).toBe(403);expect(denied.data.error.code).toBe('controller_required');}
    expect((await f.call(prefix+'/actions',input,{anonymous:true})).status).toBe(401);expect(agentActionSchema.safeParse(input).success).toBe(false);
    const before=f.server.store.world(world.id);
    for(const name of ['', '   ', 'g'.repeat(201), null, 42, {}, 'gram\nnew', 'gram\rnew', 'gram\tnew', 'gram\0new', 'gram\u007fnew', 'gram\u0085new', 'gram\u2028new', 'gram\u2029new', '\ngram\n', '\tgram\t']){
      const result=await f.call(prefix+'/actions',{type:'rename_company',name});expect(result.status,`Name ${JSON.stringify(name)} must reject: ${JSON.stringify(result.data)}`).toBe(400);expect(f.server.store.world(world.id)).toStrictEqual(before);
    }
    for(const extra of [{aliases:['old-name']},{previous_name:'other-company'},{revision:999},{accounts:[]},{action:'rename_company'},{external_event_id:'unneeded-source'}]){
      const result=await f.call(prefix+'/actions',{...input,...extra});expect(result.status).toBe(400);expect(result.data.error.code).toBe('invalid_company_metadata');expect(f.server.store.world(world.id)).toStrictEqual(before);
    }
    const boundary=await f.call(prefix+'/actions',{type:'rename_company',name:'  '+'g'.repeat(200)+'  '});expect(boundary.status).toBe(200);expect(boundary.data.result.name.length).toBe(200);expect(withoutMetadata(f.server.store.world(world.id))).toStrictEqual(withoutMetadata(before));
    expect(f.server.store.verify(world.id).valid).toBe(true);
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
    const renamed=await f.call(prefix+'/actions',input,{key,revision:before.revision});expect(renamed.status,JSON.stringify(renamed.data)).toBe(200);
    const expected={...before,name:input.name,revision:before.revision+1};expect(f.server.store.world(world.id),'Persisted record retains absent fields, original accounts and original payment shape').toStrictEqual(expected);
    const auditPrefix=f.server.store.events(world.id,0,1000);expect(f.server.store.verify(world.id).valid).toBe(true);const port=Number(new URL(f.base).port);
    await f.close();f=await start(database,port);expect(f.server.store.world(world.id)).toStrictEqual(expected);
    expect(f.server.store.events(world.id,0,1000).slice(0,auditPrefix.length)).toStrictEqual(auditPrefix);
    const replay=await f.call(prefix+'/actions',input,{key,revision:before.revision});expect(replay.status).toBe(200);expect(replay.data.replayed).toBe(true);expect(replay.data.revision).toBe(expected.revision);expect(f.server.store.world(world.id)).toStrictEqual(expected);
    const presented=await f.call(prefix);expect(presented.status).toBe(200);expect(presented.data.world.name).toBe(input.name);expect(presented.data.summary.name).toBe(input.name);expect(f.server.store.world(world.id),'Read-time summaries must not persist migrations during metadata verification').toStrictEqual(expected);
    expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);
  }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

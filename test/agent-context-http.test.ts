import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {start} from './integration-fixture.ts';
import {providerContracts} from '../src/provider-contracts.ts';
import {systemCatalog} from '../src/world.ts';
import {hash} from '../src/store.ts';

type Fixture=Awaited<ReturnType<typeof start>>;
const okay=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r.data));return r.data.result;};
async function get(f:Fixture,world:string,query:string,token?:string){
 const response=await fetch(`${f.base}/api/worlds/${world}/context${query}`,{headers:token?{Authorization:`Bearer ${token}`}:{}}),raw=await response.text();return {status:response.status,data:JSON.parse(raw),raw,bytes:Buffer.byteLength(raw)};
}
function snapshot(f:Fixture,world:string){return {raw:(f.server.store.db.query('SELECT value FROM worlds WHERE id=?').get(world) as any).value,seq:(f.server.store.db.query('SELECT COALESCE(MAX(seq),0) AS seq FROM audit WHERE world=?').get(world) as any).seq,idempotency:(f.server.store.db.query('SELECT COUNT(*) AS n FROM idempotency').get() as any).n,grants:f.server.store.all('grants'),connections:f.server.store.all('connections')};}
function preserved(f:Fixture,world:string,before:ReturnType<typeof snapshot>){
 const after=snapshot(f,world);assert.equal(after.raw,before.raw,'A context GET must not normalize or save world bytes');assert.equal(after.idempotency,before.idempotency);assert.deepEqual(after.grants,before.grants);assert.deepEqual(after.connections,before.connections);
 const appended=(f.server.store.db.query('SELECT value FROM audit WHERE world=? AND seq>? ORDER BY seq').all(world,before.seq) as any[]).map(row=>JSON.parse(row.value));assert.ok(appended.every(row=>row.type==='http.request'),'Context may audit HTTP reads but must emit no domain/action events');assert.equal(f.server.store.verify(world).valid,true);assert.equal(f.server.store.verify('_service').valid,true);
}
function noSecrets(value:any,secretValues:string[]){const raw=JSON.stringify(value);for(const secret of secretValues)assert.equal(raw.includes(secret),false,'Context leaked a credential or source payload');const visit=(item:any)=>{if(Array.isArray(item))item.forEach(visit);else if(item&&typeof item==='object')for(const [key,v] of Object.entries(item)){assert.ok(!/^(?:access_token|refresh_token|client_secret|code_verifier|access_hash|refresh_hash|api_key|authorization|cookie|secret)$/i.test(key),`Forbidden context metadata key ${key}`);visit(v);}};visit(value);}
async function grant(f:Fixture,world:string,system='mercury',scope='read'){
 const home=await fetch(f.base),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();const redirect='http://127.0.0.1:9123/context-test',registered=await f.call('/api/oauth/clients',{name:'Context metadata reader',redirect_uris:[redirect]});assert.equal(registered.status,201);const client=registered.data.client_id,verifier=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
 const params=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope,state:randomUUID(),world_id:world,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'}),consent=await fetch(`${f.base}/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,Origin:f.base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});assert.equal(consent.status,303);await consent.text();
 const token=await f.call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:client,redirect_uri:redirect,code:new URL(consent.headers.get('location')!).searchParams.get('code'),code_verifier:verifier},undefined,randomUUID(),true);assert.equal(token.status,200);const index=f.server.store.get('access',hash(token.data.access_token))!;
 return {...token.data,grant_id:index.grant,verifier,cookie};
}
async function world(f:Fixture){return f.create({kind:'supplier-fraud',name:'Context metadata',orderCount:2,payrollControls:undefined});}

test('overview remains below SDK file thresholds, advertises all systems and excludes source records and credentials',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),token=f.agent(w.id),sentinel='PRIVATE-SOURCE-CONTENT-'+randomUUID();okay(await f.act(w.id,{type:'receive_email',from:'supplier@simulation.test',to:['finance@simulation.test'],subject:'Private source attachment discussion',body:sentinel.repeat(100)}));
  const credentials=await grant(f,w.id),before=snapshot(f,w.id),r=await get(f,w.id,'?view=overview',token);assert.equal(r.status,200,r.raw);assert.ok(r.bytes<=16000,`Overview was ${r.bytes} bytes`);assert.equal(r.data.view,'overview');assert.equal(r.data.world.id,w.id);assert.equal(r.data.systems.length,49);assert.deepEqual(r.data.systems.map((s:any)=>s.id),systemCatalog.map(s=>s.id));
  for(const row of r.data.systems){const source=systemCatalog.find(s=>s.id===row.id)!;assert.equal(row.name,source.name);assert.equal(row.category,source.category);assert.equal(row.feed_count,source.feeds.length);assert.equal(row.native_count,providerContracts.filter(c=>c.system===row.id).length);assert.equal(Object.hasOwn(row,'feeds'),false);assert.ok(row.connection&&Array.isArray(row.connection.scopes));}
  for(const key of ['provider_contracts','documents','messages','bills','bankTransactions','operations','approvals','records','data'])assert.equal(Object.hasOwn(r.data,key),false,key);
  for(const action of ['record_supplier_route','decide_approval','advance_to','cancel_bill_payment'])assert.equal(r.data.available_actions.includes(action),false);assert.ok(r.data.available_actions.includes('request_bill_payment'));assert.ok(r.data.records_endpoint.includes(w.id));assert.ok(r.data.provider_context_endpoint.includes(w.id));
  noSecrets(r.data,[token,credentials.access_token,credentials.refresh_token,credentials.verifier,credentials.cookie,credentials.grant_id,sentinel]);preserved(f,w.id,before);
 }finally{await f.close();}
});

test('provider context paginates every complete native contract exactly once, with full feeds and no financial reads',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),token=f.agent(w.id),before=snapshot(f,w.id),seen:string[]=[];
  for(const system of [...new Set(providerContracts.map(c=>c.system))]){
   const expected=providerContracts.filter(c=>c.system===system);let cursor=0,received:any[]=[];
   do{const r=await get(f,w.id,`?view=provider&system=${system}&cursor=${cursor}&limit=5`,token);assert.equal(r.status,200,r.raw);assert.ok(r.bytes<=16000,`${system} page was ${r.bytes} bytes`);assert.equal(r.data.view,'provider');assert.equal(r.data.world_id,w.id);assert.equal(r.data.system.id,system);assert.deepEqual(r.data.system.feeds,systemCatalog.find(s=>s.id===system)!.feeds);assert.equal(r.data.total,expected.length);assert.equal(r.data.cursor,cursor);assert.ok(r.data.provider_contracts.length>0&&r.data.provider_contracts.length<=5);assert.deepEqual(r.data.provider_contracts,expected.slice(cursor,cursor+r.data.provider_contracts.length));assert.equal(r.data.connection.system,system);assert.equal(Object.hasOwn(r.data,'records'),false);
    received.push(...r.data.provider_contracts);if(r.data.next_cursor===null)break;const next=Number(r.data.next_cursor);assert.equal(next,cursor+r.data.provider_contracts.length);assert.ok(next>cursor);cursor=next;
   }while(true);
   assert.deepEqual(received,expected);seen.push(...received.map(r=>r.id));
   const terminal=await get(f,w.id,`?view=provider&system=${system}&cursor=${expected.length}&limit=5`,token);assert.equal(terminal.status,200,terminal.raw);assert.deepEqual(terminal.data.provider_contracts,[]);assert.equal(terminal.data.next_cursor,null);
  }
  assert.equal(new Set(seen).size,providerContracts.length);assert.deepEqual([...seen].sort(),providerContracts.map(c=>c.id).sort());
  const dense=await get(f,w.id,'?view=provider&system=sap-b1&cursor=0&limit=10',token);assert.equal(dense.status,200,dense.raw);assert.ok(dense.bytes<=16000);assert.ok(dense.data.provider_contracts.length>0&&dense.data.provider_contracts.length<10,'Byte-aware paging must shrink a real large SAP contract page without truncating rows');assert.deepEqual(dense.data.provider_contracts,providerContracts.filter(c=>c.system==='sap-b1').slice(0,dense.data.provider_contracts.length));assert.equal(dense.data.next_cursor,dense.data.provider_contracts.length);
  const noNative=systemCatalog.find(s=>!providerContracts.some(c=>c.system===s.id))!,empty=await get(f,w.id,`?view=provider&system=${noNative.id}`,token);assert.equal(empty.status,200,empty.raw);assert.equal(empty.data.total,0);assert.deepEqual(empty.data.provider_contracts,[]);assert.equal(empty.data.next_cursor,null);assert.deepEqual(empty.data.system.feeds,noNative.feeds);
  preserved(f,w.id,before);
 }finally{await f.close();}
});

test('context query validation is strict and malformed pages have no persisted domain effect',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),token=f.agent(w.id),before=snapshot(f,w.id);
  for(const query of ['?view=unknown','?view=overview&view=provider','?view=overview&system=mercury','?view=overview&cursor=0','?view=overview&limit=5','?view=provider','?view=provider&system=mercury&system=gmail','?view=provider&system=mercury&cursor=-1','?view=provider&system=mercury&cursor=1.5','?view=provider&system=mercury&cursor=','?view=provider&system=mercury&cursor=1e2','?view=provider&system=mercury&cursor=9007199254740992','?view=provider&system=mercury&limit=0','?view=provider&system=mercury&limit=11','?view=provider&system=mercury&limit=1&limit=2','?view=provider&system=mercury&limit=','?view=provider&system=mercury&limit=5.5','?view=provider&system=mercury&feed=bank-transaction','?view=provider&system=mercury&extra=ignored']){const r=await get(f,w.id,query,token);assert.equal(r.status,400,`${query}: ${r.raw}`);}
  const beyond=await get(f,w.id,'?view=provider&system=mercury&cursor=999&limit=5',token);assert.equal(beyond.status,400);assert.equal(beyond.data.error.code,'invalid_context_cursor');
  const unknown=await get(f,w.id,'?view=provider&system=not-a-system',token);assert.equal(unknown.status,404);assert.equal(unknown.data.error.code,'unknown_context_system');preserved(f,w.id,before);
 }finally{await f.close();}
});

test('context discovery remains world scoped but provider-independent metadata does not grant financial access',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),other=await world(f),agent=f.agent(w.id),credentials=await grant(f,w.id,'gusto','read'),before=snapshot(f,w.id),otherBefore=snapshot(f,other.id);
  for(const query of ['?view=overview','?view=provider&system=mercury&cursor=0&limit=5']){assert.equal((await get(f,w.id,query)).status,401);assert.equal((await get(f,other.id,query,agent)).status,403);assert.equal((await get(f,other.id,query,credentials.access_token)).status,403);const scoped=await get(f,w.id,query,credentials.access_token);assert.equal(scoped.status,200,scoped.raw);assert.ok(scoped.bytes<=16000);noSecrets(scoped.data,[agent,credentials.access_token,credentials.refresh_token,credentials.verifier]);}
  assert.equal((await f.call(`/api/worlds/${w.id}/records?system=mercury&feed=bank-transaction`,undefined,credentials.access_token)).status,403);
  preserved(f,w.id,before);preserved(f,other.id,otherBefore);
 }finally{await f.close();}
});

test('compact connection metadata distinguishes read scopes, expiry, revocation and independent provider faults',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),agent=f.agent(w.id),path='?view=provider&system=mercury&cursor=0&limit=5';
  let r=await get(f,w.id,path,agent);assert.equal(r.status,200,r.raw);assert.equal(r.data.connection.oauth_status,'disconnected');assert.deepEqual(r.data.connection.scopes,[]);assert.equal(r.data.connection.provider_status,'healthy');
  const credentials=await grant(f,w.id),connectedBefore=snapshot(f,w.id);r=await get(f,w.id,path,agent);assert.equal(r.data.connection.oauth_status,'connected');assert.deepEqual(r.data.connection.scopes,['read']);assert.equal(r.data.connection.expires_at_clock,'wall');assert.ok(r.data.connection.expires_at);assert.ok(r.data.connection.connected_at);noSecrets(r.data,[credentials.access_token,credentials.refresh_token,credentials.grant_id]);preserved(f,w.id,connectedBefore);
  okay(await f.act(w.id,{type:'set_fault',system:'mercury',mode:'offline'}));let before=snapshot(f,w.id);r=await get(f,w.id,path,agent);assert.equal(r.data.connection.oauth_status,'connected');assert.equal(r.data.connection.provider_status,'offline');preserved(f,w.id,before);
  // Wall-clock expiry is source-independent metadata; no simulated time advance
  // or financial world edit is needed to exercise it in this isolated fixture.
  const stored=f.server.store.get('grants',credentials.grant_id)!;stored.expires_at=Date.now()-1;f.server.store.put('grants',stored.id,stored);before=snapshot(f,w.id);r=await get(f,w.id,path,agent);assert.equal(r.data.connection.oauth_status,'expired');assert.equal(r.data.connection.provider_status,'offline');assert.equal((await get(f,w.id,path,credentials.access_token)).status,401);preserved(f,w.id,before);
  assert.equal((await f.call(`/api/worlds/${w.id}/connections/mercury/revoke`,{})).status,200);before=snapshot(f,w.id);r=await get(f,w.id,path,agent);assert.equal(r.data.connection.oauth_status,'disconnected');assert.equal(r.data.connection.provider_status,'offline');assert.equal((await get(f,w.id,path,credentials.access_token)).status,401);preserved(f,w.id,before);
 }finally{await f.close();}
});

test('unqualified context preserves the existing full response for API clients',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),token=f.agent(w.id),before=snapshot(f,w.id),legacy=await get(f,w.id,'',token);assert.equal(legacy.status,200,legacy.raw);assert.deepEqual(legacy.data.systems,systemCatalog);assert.deepEqual(legacy.data.provider_contracts,providerContracts);assert.equal(legacy.data.connections.length,49);assert.ok(legacy.data.mandate);assert.ok(legacy.data.available_actions.includes('request_bill_payment'));assert.equal(Object.hasOwn(legacy.data,'view'),false);assert.ok(legacy.bytes>16000,'The preserved full catalog remains distinct from the compact SDK overview');preserved(f,w.id,before);
 }finally{await f.close();}
});

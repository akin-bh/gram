import {test,expect} from 'bun:test';
import {start} from './integration-fixture.ts';
import {providerContracts} from '../src/provider-contracts.ts';
import {systemCatalog} from '../src/world.ts';
import {hash} from '../src/store.ts';

type Fixture=Awaited<ReturnType<typeof start>>;
const okay=(r:any)=>{expect(r.status,JSON.stringify(r.data)).toBe(200);return r.data.result;};
async function get(f:Fixture,world:string,query:string,token?:string){
 const response=await fetch(`${f.base}/api/worlds/${world}/context${query}`,{headers:token?{Authorization:`Bearer ${token}`}:{}}),raw=await response.text();return {status:response.status,data:JSON.parse(raw),raw,bytes:Buffer.byteLength(raw)};
}
function snapshot(f:Fixture,world:string){return {raw:(f.server.store.db.query('SELECT value FROM worlds WHERE id=?').get(world) as any).value,seq:(f.server.store.db.query('SELECT COALESCE(MAX(seq),0) AS seq FROM audit WHERE world=?').get(world) as any).seq,idempotency:(f.server.store.db.query('SELECT COUNT(*) AS n FROM idempotency').get() as any).n,grants:f.server.store.all('grants'),connections:f.server.store.all('connections')};}
function preserved(f:Fixture,world:string,before:ReturnType<typeof snapshot>){
 const after=snapshot(f,world);expect(after.raw,'A context GET must not normalize or save world bytes').toBe(before.raw);expect(after.idempotency).toBe(before.idempotency);expect(after.grants).toStrictEqual(before.grants);expect(after.connections).toStrictEqual(before.connections);
 const appended=(f.server.store.db.query('SELECT value FROM audit WHERE world=? AND seq>? ORDER BY seq').all(world,before.seq) as any[]).map(row=>JSON.parse(row.value));expect(appended.every(row=>row.type==='http.request'),'Context may audit HTTP reads but must emit no domain/action events').toBeTruthy();expect(f.server.store.verify(world).valid).toBe(true);expect(f.server.store.verify('_service').valid).toBe(true);
}
function noSecrets(value:any,secretValues:string[]){const raw=JSON.stringify(value);for(const secret of secretValues)expect(raw.includes(secret),'Context leaked a credential or source payload').toBe(false);const visit=(item:any)=>{if(Array.isArray(item))item.forEach(visit);else if(item&&typeof item==='object')for(const [key,v] of Object.entries(item)){expect(!/^(?:access_token|refresh_token|client_secret|code_verifier|access_hash|refresh_hash|api_key|authorization|cookie|secret)$/i.test(key),`Forbidden context metadata key ${key}`).toBeTruthy();visit(v);}};visit(value);}
async function grant(f:Fixture,world:string,system='mercury',scope='read'){
 const home=await fetch(f.base),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();const redirect='http://127.0.0.1:9123/context-test',registered=await f.call('/api/oauth/clients',{name:'Context metadata reader',redirect_uris:[redirect]});expect(registered.status).toBe(201);const client=registered.data.client_id,verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 const params=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope,state:crypto.randomUUID(),world_id:world,code_challenge:new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'}),consent=await fetch(`${f.base}/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,Origin:f.base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});expect(consent.status).toBe(303);await consent.text();
 const token=await f.call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:client,redirect_uri:redirect,code:new URL(consent.headers.get('location')!).searchParams.get('code'),code_verifier:verifier},undefined,crypto.randomUUID(),true);expect(token.status).toBe(200);const index=f.server.store.get('access',hash(token.data.access_token))!;
 return {...token.data,grant_id:index.grant,verifier,cookie};
}
async function world(f:Fixture){return f.create({kind:'supplier-fraud',name:'Context metadata',orderCount:2,payrollControls:undefined});}

test('overview remains below SDK file thresholds, advertises all systems and excludes source records and credentials',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),token=f.agent(w.id),sentinel='PRIVATE-SOURCE-CONTENT-'+crypto.randomUUID();okay(await f.act(w.id,{type:'receive_email',from:'supplier@simulation.test',to:['finance@simulation.test'],subject:'Private source attachment discussion',body:sentinel.repeat(100)}));
  const credentials=await grant(f,w.id),before=snapshot(f,w.id),r=await get(f,w.id,'?view=overview',token);expect(r.status,r.raw).toBe(200);expect(r.bytes<=16000,`Overview was ${r.bytes} bytes`).toBeTruthy();expect(r.data.view).toBe('overview');expect(r.data.world.id).toBe(w.id);expect(r.data.systems.length).toBe(49);expect(r.data.systems.map((s:any)=>s.id)).toStrictEqual(systemCatalog.map(s=>s.id));
  for(const row of r.data.systems){const source=systemCatalog.find(s=>s.id===row.id)!;expect(row.name).toBe(source.name);expect(row.category).toBe(source.category);expect(row.feed_count).toBe(source.feeds.length);expect(row.native_count).toBe(providerContracts.filter(c=>c.system===row.id).length);expect(Object.hasOwn(row,'feeds')).toBe(false);expect(row.connection&&Array.isArray(row.connection.scopes)).toBeTruthy();}
  for(const key of ['provider_contracts','documents','messages','bills','bankTransactions','operations','approvals','records','data'])expect(Object.hasOwn(r.data,key),key).toBe(false);
  for(const action of ['record_supplier_route','decide_approval','advance_to','cancel_bill_payment'])expect(r.data.available_actions.includes(action)).toBe(false);expect(r.data.available_actions.includes('request_bill_payment')).toBeTruthy();expect(r.data.records_endpoint.includes(w.id)).toBeTruthy();expect(r.data.provider_context_endpoint.includes(w.id)).toBeTruthy();
  noSecrets(r.data,[token,credentials.access_token,credentials.refresh_token,credentials.verifier,credentials.cookie,credentials.grant_id,sentinel]);preserved(f,w.id,before);
 }finally{await f.close();}
});

test('provider context paginates every complete native contract exactly once, with full feeds and no financial reads',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),token=f.agent(w.id),before=snapshot(f,w.id),seen:string[]=[];
  for(const system of [...new Set(providerContracts.map(c=>c.system))]){
   const expected=providerContracts.filter(c=>c.system===system);let cursor=0,received:any[]=[];
   do{const r=await get(f,w.id,`?view=provider&system=${system}&cursor=${cursor}&limit=5`,token);expect(r.status,r.raw).toBe(200);expect(r.bytes<=16000,`${system} page was ${r.bytes} bytes`).toBeTruthy();expect(r.data.view).toBe('provider');expect(r.data.world_id).toBe(w.id);expect(r.data.system.id).toBe(system);expect(r.data.system.feeds).toStrictEqual(systemCatalog.find(s=>s.id===system)!.feeds);expect(r.data.total).toBe(expected.length);expect(r.data.cursor).toBe(cursor);expect(r.data.provider_contracts.length>0&&r.data.provider_contracts.length<=5).toBeTruthy();expect(r.data.provider_contracts).toStrictEqual(expected.slice(cursor,cursor+r.data.provider_contracts.length));expect(r.data.connection.system).toBe(system);expect(Object.hasOwn(r.data,'records')).toBe(false);
    received.push(...r.data.provider_contracts);if(r.data.next_cursor===null)break;const next=Number(r.data.next_cursor);expect(next).toBe(cursor+r.data.provider_contracts.length);expect(next>cursor).toBeTruthy();cursor=next;
   }while(true);
   expect(received).toStrictEqual(expected);seen.push(...received.map(r=>r.id));
   const terminal=await get(f,w.id,`?view=provider&system=${system}&cursor=${expected.length}&limit=5`,token);expect(terminal.status,terminal.raw).toBe(200);expect(terminal.data.provider_contracts).toStrictEqual([]);expect(terminal.data.next_cursor).toBeNull();
  }
  expect(new Set(seen).size).toBe(providerContracts.length);expect([...seen].sort()).toStrictEqual(providerContracts.map(c=>c.id).sort());
  const dense=await get(f,w.id,'?view=provider&system=sap-b1&cursor=0&limit=10',token);expect(dense.status,dense.raw).toBe(200);expect(dense.bytes<=16000).toBeTruthy();expect(dense.data.provider_contracts.length>0&&dense.data.provider_contracts.length<10,'Byte-aware paging must shrink a real large SAP contract page without truncating rows').toBeTruthy();expect(dense.data.provider_contracts).toStrictEqual(providerContracts.filter(c=>c.system==='sap-b1').slice(0,dense.data.provider_contracts.length));expect(dense.data.next_cursor).toBe(dense.data.provider_contracts.length);
  const noNative=systemCatalog.find(s=>!providerContracts.some(c=>c.system===s.id))!,empty=await get(f,w.id,`?view=provider&system=${noNative.id}`,token);expect(empty.status,empty.raw).toBe(200);expect(empty.data.total).toBe(0);expect(empty.data.provider_contracts).toStrictEqual([]);expect(empty.data.next_cursor).toBeNull();expect(empty.data.system.feeds).toStrictEqual(noNative.feeds);
  preserved(f,w.id,before);
 }finally{await f.close();}
});

test('context query validation is strict and malformed pages have no persisted domain effect',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),token=f.agent(w.id),before=snapshot(f,w.id);
  for(const query of ['?view=unknown','?view=overview&view=provider','?view=overview&system=mercury','?view=overview&cursor=0','?view=overview&limit=5','?view=provider','?view=provider&system=mercury&system=gmail','?view=provider&system=mercury&cursor=-1','?view=provider&system=mercury&cursor=1.5','?view=provider&system=mercury&cursor=','?view=provider&system=mercury&cursor=1e2','?view=provider&system=mercury&cursor=9007199254740992','?view=provider&system=mercury&limit=0','?view=provider&system=mercury&limit=11','?view=provider&system=mercury&limit=1&limit=2','?view=provider&system=mercury&limit=','?view=provider&system=mercury&limit=5.5','?view=provider&system=mercury&feed=bank-transaction','?view=provider&system=mercury&extra=ignored']){const r=await get(f,w.id,query,token);expect(r.status,`${query}: ${r.raw}`).toBe(400);}
  const beyond=await get(f,w.id,'?view=provider&system=mercury&cursor=999&limit=5',token);expect(beyond.status).toBe(400);expect(beyond.data.error.code).toBe('invalid_context_cursor');
  const unknown=await get(f,w.id,'?view=provider&system=not-a-system',token);expect(unknown.status).toBe(404);expect(unknown.data.error.code).toBe('unknown_context_system');preserved(f,w.id,before);
 }finally{await f.close();}
});

test('context discovery remains world scoped but provider-independent metadata does not grant financial access',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),other=await world(f),agent=f.agent(w.id),credentials=await grant(f,w.id,'gusto','read'),before=snapshot(f,w.id),otherBefore=snapshot(f,other.id);
  for(const query of ['?view=overview','?view=provider&system=mercury&cursor=0&limit=5']){expect((await get(f,w.id,query)).status).toBe(401);expect((await get(f,other.id,query,agent)).status).toBe(403);expect((await get(f,other.id,query,credentials.access_token)).status).toBe(403);const scoped=await get(f,w.id,query,credentials.access_token);expect(scoped.status,scoped.raw).toBe(200);expect(scoped.bytes<=16000).toBeTruthy();noSecrets(scoped.data,[agent,credentials.access_token,credentials.refresh_token,credentials.verifier]);}
  expect((await f.call(`/api/worlds/${w.id}/records?system=mercury&feed=bank-transaction`,undefined,credentials.access_token)).status).toBe(403);
  preserved(f,w.id,before);preserved(f,other.id,otherBefore);
 }finally{await f.close();}
});

test('compact connection metadata distinguishes read scopes, expiry, revocation and independent provider faults',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),agent=f.agent(w.id),path='?view=provider&system=mercury&cursor=0&limit=5';
  let r=await get(f,w.id,path,agent);expect(r.status,r.raw).toBe(200);expect(r.data.connection.oauth_status).toBe('disconnected');expect(r.data.connection.scopes).toStrictEqual([]);expect(r.data.connection.provider_status).toBe('healthy');
  const credentials=await grant(f,w.id),connectedBefore=snapshot(f,w.id);r=await get(f,w.id,path,agent);expect(r.data.connection.oauth_status).toBe('connected');expect(r.data.connection.scopes).toStrictEqual(['read']);expect(r.data.connection.expires_at_clock).toBe('wall');expect(r.data.connection.expires_at).toBeTruthy();expect(r.data.connection.connected_at).toBeTruthy();noSecrets(r.data,[credentials.access_token,credentials.refresh_token,credentials.grant_id]);preserved(f,w.id,connectedBefore);
  okay(await f.act(w.id,{type:'set_fault',system:'mercury',mode:'offline'}));let before=snapshot(f,w.id);r=await get(f,w.id,path,agent);expect(r.data.connection.oauth_status).toBe('connected');expect(r.data.connection.provider_status).toBe('offline');preserved(f,w.id,before);
  // Wall-clock expiry is source-independent metadata; no simulated time advance
  // or financial world edit is needed to exercise it in this isolated fixture.
  const stored=f.server.store.get('grants',credentials.grant_id)!;stored.expires_at=Date.now()-1;f.server.store.put('grants',stored.id,stored);before=snapshot(f,w.id);r=await get(f,w.id,path,agent);expect(r.data.connection.oauth_status).toBe('expired');expect(r.data.connection.provider_status).toBe('offline');expect((await get(f,w.id,path,credentials.access_token)).status).toBe(401);preserved(f,w.id,before);
  expect((await f.call(`/api/worlds/${w.id}/connections/mercury/revoke`,{})).status).toBe(200);before=snapshot(f,w.id);r=await get(f,w.id,path,agent);expect(r.data.connection.oauth_status).toBe('disconnected');expect(r.data.connection.provider_status).toBe('offline');expect((await get(f,w.id,path,credentials.access_token)).status).toBe(401);preserved(f,w.id,before);
 }finally{await f.close();}
});

test('unqualified context preserves the existing full response for API clients',async()=>{
 const f=await start(':memory:');try{
  const w=await world(f),token=f.agent(w.id),before=snapshot(f,w.id),legacy=await get(f,w.id,'',token);expect(legacy.status,legacy.raw).toBe(200);expect(legacy.data.systems).toStrictEqual(systemCatalog);expect(legacy.data.provider_contracts).toStrictEqual(providerContracts);expect(legacy.data.connections.length).toBe(49);expect(legacy.data.mandate).toBeTruthy();expect(legacy.data.available_actions.includes('request_bill_payment')).toBeTruthy();expect(Object.hasOwn(legacy.data,'view')).toBe(false);expect(legacy.bytes>16000,'The preserved full catalog remains distinct from the compact SDK overview').toBeTruthy();preserved(f,w.id,before);
 }finally{await f.close();}
});

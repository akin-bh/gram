import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {hash} from '../src/store.ts';

async function fixture(database=':memory:') {
  const server=await startServer({database,port:0,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  const index=await fetch(base),cookie=index.headers.get('set-cookie')!.split(';')[0];await index.text();
  const call=async(path:string,input?:any,token?:string,anonymous=false)=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:anonymous?{}:{Cookie:cookie}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const create=async(name='Audit example')=>{const result=await call('/api/worlds',{name,kind:'saas-collections',orderCount:1});expect(result.status).toBe(201);return result.data.world;};
  return {server,base,cookie,call,create,close:()=>server.close()};
}

test('recent audit pages keep a stable snapshot across new events, read observations and global sequence gaps',async()=>{
  const f=await fixture();
  try {
    const world=await f.create(),other=await f.create('Other company'),prefix=`/api/worlds/${world.id}/audit`;
    for(let n=0;n<8;n++) {
      f.server.store.audit(world.id,'action.completed',{action:{type:'example'},ordinal:n},'controller-local',`request-${n}`);
      f.server.store.audit(other.id,'operation.created',{ordinal:n});
    }
    const originalWorld=f.server.store.world(world.id),before=f.server.store.events(world.id,0,1000),expected=[...before].reverse();
    const first=await f.call(prefix+'?order=desc&scope=all&limit=3');expect(first.status).toBe(200);
    expect(first.data.data).toStrictEqual(expected.slice(0,3));expect(first.data.snapshot_seq).toBe(before.at(-1).seq);expect(first.data.head_seq).toBe(first.data.snapshot_seq);
    const later=f.server.store.audit(world.id,'operation.created',{later:true});
    let cursor=first.data.next_cursor,seen=[...first.data.data],pages=0;
    while(cursor) {
      const page=await f.call(prefix+`?order=desc&scope=all&limit=3&before=${cursor}&snapshot=${first.data.snapshot_seq}`);
      expect(page.status).toBe(200);expect(page.data.snapshot_seq).toBe(first.data.snapshot_seq);expect(page.data.head_seq>=later.seq).toBeTruthy();
      seen.push(...page.data.data);cursor=page.data.next_cursor;expect(++pages<8,'Reading the log must not create endless pages').toBeTruthy();
    }
    expect(seen).toStrictEqual(expected);expect(new Set(seen.map(row=>row.seq)).size).toBe(seen.length);
    const fresh=await f.call(prefix+'?order=desc&scope=activity&limit=1');expect(fresh.data.data[0].seq).toBe(later.seq);
    const legacy=await f.call(prefix+'?after=0&limit=2');expect(Object.keys(legacy.data).sort()).toStrictEqual(['data','next_cursor']);expect(legacy.data.data).toStrictEqual(before.slice(0,2));
    const legacyNext=await f.call(prefix+`?after=${legacy.data.next_cursor}&limit=2`);expect(legacyNext.data.data).toStrictEqual(before.slice(2,4));
    expect(f.server.store.world(world.id)).toStrictEqual(originalWorld);expect(f.server.store.events(world.id,0,1000).slice(0,before.length)).toStrictEqual(before);expect(f.server.store.verify(world.id).valid).toBe(true);
  } finally {await f.close();}
});

test('audit scopes and literal Unicode search filter before pagination while retaining raw technical evidence and errors',async()=>{
  const f=await fixture();
  try {
    const world=await f.create(),prefix=`/api/worlds/${world.id}/audit`,label='Needle Café';
    const emit=(type:string,data:any)=>f.server.store.audit(world.id,type,{label,...data});
    const hidden=[
      emit('http.request',{method:'GET',path:'/example',status:200,response:{large:'x'.repeat(10000)}}),
      emit('http.request',{method:'HEAD',status:304}),
      emit('agent.trace',{type:'agent.message',content:[{text:'routine progress'}]}),
      emit('agent.trace',{type:'agent.tool.response',method:'GET',status:200}),
    ];
    const activity=[emit('action.completed',{action:{type:'pay_bill'},run_id:'run-a'}),emit('http.request',{method:'POST',status:200})];
    for(let n=0;n<130;n++)f.server.store.audit(world.id,'http.request',{method:'GET',status:200,path:'/poll',response:{ordinal:n}});
    const errors=[
      emit('http.request',{method:'GET',status:403}),emit('http.request',{method:'POST',status:503}),
      emit('agent.trace',{type:'agent.tool.response',status:503}),emit('agent.trace',{type:'agent.tool.failure',error:'Connection lost'}),
      emit('agent.trace',{type:'agent.capability.denied',tool:'outside-scope'}),
      emit('supplier_invoice.match_blocked',{issues:['missing receipt']}),emit('operation.blocked',{reason:'bank:offline'}),
      emit('approval.decided',{decision:'rejected'}),emit('oauth.denied',{system:'stripe'}),emit('webhook.delivery_failed',{status_code:503}),
    ];
    const literal=emit('action.completed',{reference:'literal %_ marker',password:'secret-for-redaction-check'});
    const before=f.server.store.events(world.id,0,1000),snapshot=before.at(-1).seq;
    const query=async(scope:string,q:string,limit=100)=>f.call(prefix+'?'+new URLSearchParams({order:'desc',scope,q,limit:String(limit),snapshot:String(snapshot)}));
    const all=await query('all','NEEDLE CAFÉ');expect(all.status).toBe(200);expect(all.data.data.map((row:any)=>row.seq)).toStrictEqual([...hidden,...activity,...errors,literal].reverse().map(row=>row.seq));
    const meaningful=await query('activity','needle');expect(meaningful.data.data.map((row:any)=>row.seq)).toStrictEqual([...activity,...errors,literal].reverse().map(row=>row.seq));
    const failed=await query('errors','needle');expect(failed.data.data.map((row:any)=>row.seq)).toStrictEqual([...errors].reverse().map(row=>row.seq));
    const bounded=await query('errors','needle',1);expect(bounded.data.data[0].seq).toBe(errors.at(-1)!.seq);expect(bounded.data.next_cursor).toBe(String(errors.at(-1)!.seq));
    const exact=await query('all','%_');expect(exact.data.data.map((row:any)=>row.seq)).toStrictEqual([literal.seq]);expect(exact.data.next_cursor).toBeNull();
    expect((await query('all',"' OR 1=1 --")).data.data.length).toBe(0);
    expect((await query('all','secret-for-redaction-check')).data.data.length).toBe(0);
    expect((await f.call(prefix+'/events/'+literal.seq)).data.data.password).toBe('[REDACTED]');
    expect(f.server.store.events(world.id,0,1000).slice(0,before.length)).toStrictEqual(before);expect(f.server.store.verify(world.id).valid).toBe(true);
  } finally {await f.close();}
});

test('audit detail is controller-only and world-scoped; verify and full chronological export remain intact',async()=>{
  const f=await fixture();
  try {
    const world=await f.create(),other=await f.create('Private other'),prefix=`/api/worlds/${world.id}/audit`;
    const record=f.server.store.audit(world.id,'agent.trace',{type:'agent.tool.request',run_id:'run-one',body:{secret:'hidden',reference:'source-one'}},'agent:run-one');
    const foreign=f.server.store.audit(other.id,'operation.created',{reference:'other-world-secret'});
    const detail=await f.call(prefix+'/events/'+record.seq);expect(detail.status).toBe(200);expect(detail.data).toStrictEqual(record);expect(detail.data.data.body.secret).toBe('[REDACTED]');
    expect((await f.call(prefix+'/events/'+foreign.seq)).status).toBe(404);expect((await f.call(prefix+'/events/999999')).status).toBe(404);
    const token=crypto.randomUUID();f.server.store.put('agent-tokens',hash(token),{world:world.id,actor:'agent-world:'+world.id,runId:'run-one',expires_at:Date.now()+60000});
    for(const route of [prefix+'?order=desc&scope=all',prefix+'/events/'+record.seq,prefix+'/verify',prefix+'/export']) {
      expect((await f.call(route,undefined,token)).status).toBe(403);expect((await f.call(route,undefined,undefined,true)).status).toBe(401);
    }
    const prior=f.server.store.events(world.id,0,1000),exported=await fetch(f.base+prefix+'/export',{headers:{Cookie:f.cookie}});
    expect(exported.status).toBe(200);expect(exported.headers.get('content-type')!).toMatch(/application\/x-ndjson/);
    const rows=(await exported.text()).trim().split('\n').map(line=>JSON.parse(line));expect(rows).toStrictEqual(prior);expect(rows.find(row=>row.seq===record.seq)).toStrictEqual(record);
    const observed=f.server.store.events(world.id,0,1000).at(-1);expect(observed.type).toBe('http.request');expect(observed.data.response).toStrictEqual({audit_read:true});
    const verification=await f.call(prefix+'/verify');expect(verification.status).toBe(200);expect(verification.data.valid).toBe(true);expect(verification.data.head).toBe(observed.hash);
    expect(f.server.store.events(world.id,0,1000).slice(0,prior.length)).toStrictEqual(prior);
  } finally {await f.close();}
});

test('audit query validation and durable sequence lookups survive restart without changing saved worlds',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'gram-audit-')),database=join(directory,'world.sqlite');let f=await fixture(database);
  try {
    const world=await f.create(),prefix=`/api/worlds/${world.id}/audit`,original=f.server.store.world(world.id);
    const record=f.server.store.audit(world.id,'company.renamed',{name:'Example',previous_name:'Earlier'},'controller-local','durable-request');
    for(const query of ['order=sideways','scope=unknown','order=desc&before=-1','order=desc&before=1.5','order=desc&after=1','order=asc&before=2','snapshot=-1','snapshot=NaN','order=desc&limit=0','order=desc&limit=1001','q='+ 'x'.repeat(501)]) {
      const result=await f.call(prefix+'?'+query);expect(result.status,query).toBe(400);
    }
    for(const seq of ['0','-1','1.5','NaN'])expect((await f.call(prefix+'/events/'+seq)).status).toBe(400);
    const empty=await f.call(prefix+'?order=desc&snapshot=0');expect(empty.status).toBe(200);expect(empty.data.data).toStrictEqual([]);expect(empty.data.next_cursor).toBeNull();
    const before=f.server.store.events(world.id,0,1000);await f.close();f=await fixture(database);
    expect((await f.call(prefix+'/events/'+record.seq)).data).toStrictEqual(record);expect(f.server.store.world(world.id)).toStrictEqual(original);
    expect(f.server.store.events(world.id,0,1000).slice(0,before.length)).toStrictEqual(before);expect(f.server.store.verify(world.id).valid).toBe(true);
  } finally {await f.close();rmSync(directory,{recursive:true,force:true});}
});

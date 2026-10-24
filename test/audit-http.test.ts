import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
  const create=async(name='Audit example')=>{const result=await call('/api/worlds',{name,kind:'saas-collections',orderCount:1});assert.equal(result.status,201);return result.data.world;};
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
    const first=await f.call(prefix+'?order=desc&scope=all&limit=3');assert.equal(first.status,200);
    assert.deepEqual(first.data.data,expected.slice(0,3));assert.equal(first.data.snapshot_seq,before.at(-1).seq);assert.equal(first.data.head_seq,first.data.snapshot_seq);
    const later=f.server.store.audit(world.id,'operation.created',{later:true});
    let cursor=first.data.next_cursor,seen=[...first.data.data],pages=0;
    while(cursor) {
      const page=await f.call(prefix+`?order=desc&scope=all&limit=3&before=${cursor}&snapshot=${first.data.snapshot_seq}`);
      assert.equal(page.status,200);assert.equal(page.data.snapshot_seq,first.data.snapshot_seq);assert.ok(page.data.head_seq>=later.seq);
      seen.push(...page.data.data);cursor=page.data.next_cursor;assert.ok(++pages<8,'Reading the log must not create endless pages');
    }
    assert.deepEqual(seen,expected);assert.equal(new Set(seen.map(row=>row.seq)).size,seen.length);
    const fresh=await f.call(prefix+'?order=desc&scope=activity&limit=1');assert.equal(fresh.data.data[0].seq,later.seq);
    const legacy=await f.call(prefix+'?after=0&limit=2');assert.deepEqual(Object.keys(legacy.data).sort(),['data','next_cursor']);assert.deepEqual(legacy.data.data,before.slice(0,2));
    const legacyNext=await f.call(prefix+`?after=${legacy.data.next_cursor}&limit=2`);assert.deepEqual(legacyNext.data.data,before.slice(2,4));
    assert.deepEqual(f.server.store.world(world.id),originalWorld);assert.deepEqual(f.server.store.events(world.id,0,1000).slice(0,before.length),before);assert.equal(f.server.store.verify(world.id).valid,true);
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
    const all=await query('all','NEEDLE CAFÉ');assert.equal(all.status,200);assert.deepEqual(all.data.data.map((row:any)=>row.seq),[...hidden,...activity,...errors,literal].reverse().map(row=>row.seq));
    const meaningful=await query('activity','needle');assert.deepEqual(meaningful.data.data.map((row:any)=>row.seq),[...activity,...errors,literal].reverse().map(row=>row.seq));
    const failed=await query('errors','needle');assert.deepEqual(failed.data.data.map((row:any)=>row.seq),[...errors].reverse().map(row=>row.seq));
    const bounded=await query('errors','needle',1);assert.equal(bounded.data.data[0].seq,errors.at(-1)!.seq);assert.equal(bounded.data.next_cursor,String(errors.at(-1)!.seq));
    const exact=await query('all','%_');assert.deepEqual(exact.data.data.map((row:any)=>row.seq),[literal.seq]);assert.equal(exact.data.next_cursor,null);
    assert.equal((await query('all',"' OR 1=1 --")).data.data.length,0);
    assert.equal((await query('all','secret-for-redaction-check')).data.data.length,0);
    assert.equal((await f.call(prefix+'/events/'+literal.seq)).data.data.password,'[REDACTED]');
    assert.deepEqual(f.server.store.events(world.id,0,1000).slice(0,before.length),before);assert.equal(f.server.store.verify(world.id).valid,true);
  } finally {await f.close();}
});

test('audit detail is controller-only and world-scoped; verify and full chronological export remain intact',async()=>{
  const f=await fixture();
  try {
    const world=await f.create(),other=await f.create('Private other'),prefix=`/api/worlds/${world.id}/audit`;
    const record=f.server.store.audit(world.id,'agent.trace',{type:'agent.tool.request',run_id:'run-one',body:{secret:'hidden',reference:'source-one'}},'agent:run-one');
    const foreign=f.server.store.audit(other.id,'operation.created',{reference:'other-world-secret'});
    const detail=await f.call(prefix+'/events/'+record.seq);assert.equal(detail.status,200);assert.deepEqual(detail.data,record);assert.equal(detail.data.data.body.secret,'[REDACTED]');
    assert.equal((await f.call(prefix+'/events/'+foreign.seq)).status,404);assert.equal((await f.call(prefix+'/events/999999')).status,404);
    const token=randomUUID();f.server.store.put('agent-tokens',hash(token),{world:world.id,actor:'agent-world:'+world.id,runId:'run-one',expires_at:Date.now()+60000});
    for(const route of [prefix+'?order=desc&scope=all',prefix+'/events/'+record.seq,prefix+'/verify',prefix+'/export']) {
      assert.equal((await f.call(route,undefined,token)).status,403);assert.equal((await f.call(route,undefined,undefined,true)).status,401);
    }
    const prior=f.server.store.events(world.id,0,1000),exported=await fetch(f.base+prefix+'/export',{headers:{Cookie:f.cookie}});
    assert.equal(exported.status,200);assert.match(exported.headers.get('content-type')!,/application\/x-ndjson/);
    const rows=(await exported.text()).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(rows,prior);assert.deepEqual(rows.find(row=>row.seq===record.seq),record);
    const observed=f.server.store.events(world.id,0,1000).at(-1);assert.equal(observed.type,'http.request');assert.deepEqual(observed.data.response,{audit_read:true});
    const verification=await f.call(prefix+'/verify');assert.equal(verification.status,200);assert.equal(verification.data.valid,true);assert.equal(verification.data.head,observed.hash);
    assert.deepEqual(f.server.store.events(world.id,0,1000).slice(0,prior.length),prior);
  } finally {await f.close();}
});

test('audit query validation and durable sequence lookups survive restart without changing saved worlds',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'gram-audit-')),database=join(directory,'world.sqlite');let f=await fixture(database);
  try {
    const world=await f.create(),prefix=`/api/worlds/${world.id}/audit`,original=f.server.store.world(world.id);
    const record=f.server.store.audit(world.id,'company.renamed',{name:'Example',previous_name:'Earlier'},'controller-local','durable-request');
    for(const query of ['order=sideways','scope=unknown','order=desc&before=-1','order=desc&before=1.5','order=desc&after=1','order=asc&before=2','snapshot=-1','snapshot=NaN','order=desc&limit=0','order=desc&limit=1001','q='+ 'x'.repeat(501)]) {
      const result=await f.call(prefix+'?'+query);assert.equal(result.status,400,query);
    }
    for(const seq of ['0','-1','1.5','NaN'])assert.equal((await f.call(prefix+'/events/'+seq)).status,400);
    const empty=await f.call(prefix+'?order=desc&snapshot=0');assert.equal(empty.status,200);assert.deepEqual(empty.data.data,[]);assert.equal(empty.data.next_cursor,null);
    const before=f.server.store.events(world.id,0,1000);await f.close();f=await fixture(database);
    assert.deepEqual((await f.call(prefix+'/events/'+record.seq)).data,record);assert.deepEqual(f.server.store.world(world.id),original);
    assert.deepEqual(f.server.store.events(world.id,0,1000).slice(0,before.length),before);assert.equal(f.server.store.verify(world.id).valid,true);
  } finally {await f.close();rmSync(directory,{recursive:true,force:true});}
});

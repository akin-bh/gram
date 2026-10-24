import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hash} from '../src/store.ts';
import {start} from './integration-fixture.ts';

type Credential = 'oauth-revoked' | 'oauth-expired' | 'agent-deleted' | 'agent-expired' | 'session-deleted' | 'session-expired';
type Phase = 'initial-body' | 'dispatch-body';
type Mutation = 'action' | 'world-create' | 'client-register';

async function rejectedAfterBody(credential:Credential,phase:Phase,mutation:Mutation='action'){
  const f=await start(':memory:'),store=f.server.store,originalGet=store.get;
  try{
    const world=await f.create(),isOAuth=credential.startsWith('oauth'),isSession=credential.startsWith('session');
    if(!isOAuth)await f.connect(world.id,'gusto');
    let namespace:string,credentialId:string,actorId:string,headers:Record<string,string>,token:string|undefined;
    if(isSession){
      const home=await fetch(f.base),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
      namespace='sessions';credentialId=hash(cookie.slice(cookie.indexOf('=')+1));actorId='controller-local';headers={Cookie:cookie};
    }else{
      token=isOAuth?await f.grant(world.id,'read write'):f.agent(world.id);
      namespace=isOAuth?'grants':'agent-tokens';
      credentialId=isOAuth?store.get('access',hash(token)).grant:hash(token);
      actorId=isOAuth?`oauth:${store.get('grants',credentialId).client_id}`:`agent-world:${world.id}`;
      headers={Authorization:`Bearer ${token}`};
    }
    const originalCredential=store.get(namespace,credentialId),key=`auth-${randomUUID()}`;
    if(mutation==='action'){
      const subscription=await f.call(`/api/worlds/${world.id}/webhooks`,{events:['payroll.*']});
      assert.equal(subscription.status,201,JSON.stringify(subscription.data));
    }
    const input=mutation==='action'?{type:'prepare_payroll',policy_id:world.payrollPolicies[0].id,time_record_ids:world.payrollTimeRecords.map((row:any)=>row.id),employee_ids:world.employees.map((row:any)=>row.id)}
      :mutation==='world-create'?{kind:'saas-collections',name:'Expired session must not create this world',orderCount:1}
      :{name:'Expired session must not register this client',redirect_uris:['http://127.0.0.1:9123/liveness-callback']};
    const path=mutation==='action'?`/api/worlds/${world.id}/actions`:mutation==='world-create'?'/api/worlds':'/api/oauth/clients';
    const beforeWorlds=JSON.stringify(store.worlds()),beforeClients=JSON.stringify(store.all('clients'));
    const beforeIdempotency=store.db.prepare('SELECT * FROM idempotency ORDER BY world,actor,key').all();
    const beforeAudit=Number((store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM audit').get() as any).seq);
    const beforeDeliveries=store.db.prepare('SELECT * FROM webhook_deliveries ORDER BY seq').all();
    const beforeWebhookEvents=store.db.prepare('SELECT * FROM webhook_events ORDER BY rowid').all();
    let reads=0,scheduled=false,invalidated=false;
    const targetRead=phase==='initial-body'?1:2;
    const invalidate=()=>{
      if(credential==='oauth-revoked'){
        f.server.oauth.revokeToken('gusto',{token:token!,client_id:originalCredential.client_id});
      }else if(credential.endsWith('deleted'))store.delete(namespace,credentialId);
      else store.put(namespace,credentialId,{...originalCredential,expires_at:Date.now()-1000});
      invalidated=true;
    };
    store.get=function(ns:string,id:string){
      const value=originalGet.call(store,ns,id);
      if(ns===namespace&&id===credentialId&&value&&++reads===targetRead&&!scheduled){
        scheduled=true;
        // The captured credential remains valid for this synchronous auth read.
        // Invalidation runs at the following awaited body boundary, without a
        // sleep or a race against network timing. Read 2 targets dispatch's
        // second body parse after the handler already refreshed the actor.
        queueMicrotask(invalidate);
      }
      return value;
    } as typeof store.get;
    const request=()=>fetch(f.base+path,{method:'POST',headers:{...headers,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(input)});
    const response=await request(),payload=await response.json();
    assert.equal(scheduled,true,'The intended body-read authorization boundary must be exercised');
    assert.equal(invalidated,true,'Invalidation must complete before the response');
    assert.equal(response.status,401,JSON.stringify(payload));
    assert.equal(payload.error.code,'authentication_required');
    assert.equal(JSON.stringify(store.worlds()),beforeWorlds,'Expired/revoked credentials must not mutate any world');
    assert.equal(JSON.stringify(store.all('clients')),beforeClients,'Rejected client registration must not persist a client');
    assert.deepEqual(store.db.prepare('SELECT * FROM idempotency ORDER BY world,actor,key').all(),beforeIdempotency,'Failed authorization cannot cache a success or consume a key');
    assert.deepEqual(store.db.prepare('SELECT * FROM webhook_deliveries ORDER BY seq').all(),beforeDeliveries,'Denied effects must not create webhook outbox work');
    assert.deepEqual(store.db.prepare('SELECT * FROM webhook_events ORDER BY rowid').all(),beforeWebhookEvents,'Denied effects must not publish domain events');
    const newAudit=(store.db.prepare('SELECT value FROM audit WHERE seq>? ORDER BY seq').all(beforeAudit) as any[]).map(row=>JSON.parse(row.value));
    assert.equal(newAudit.filter(event=>!['http.request','oauth.revoked'].includes(event.type)).length,0,'Only the denied HTTP request and explicit token revocation may be audited');
    assert.equal(newAudit.filter(event=>event.type==='action.completed').length,0);
    assert.equal(store.verify(world.id).valid,true);
    assert.equal(store.verify('_service').valid,true);

    // Restore this isolated credential and repeat the exact key/body. Success
    // proves the rejected request did not reserve the key or conceal bad input.
    store.get=originalGet;store.put(namespace,credentialId,originalCredential);
    const retry=await request(),result=await retry.json();
    assert.equal(retry.status,mutation==='action'?200:201,JSON.stringify(result));
    if(mutation==='action'){
      assert.equal(store.world(world.id).payrollRuns.length,1);
      assert.ok(store.db.prepare('SELECT value FROM idempotency WHERE world=? AND actor=? AND key=?').get(world.id,actorId,key));
      assert.equal(store.events(world.id,0,1000).filter(event=>event.type==='action.completed').length,1);
    }
  }finally{store.get=originalGet;await f.close();}
}

// Before the fix, the dispatch-body/agent-deleted case returned 200 and
// changed revision 1 -> 2 despite deletion completing before execution.
for(const phase of ['initial-body','dispatch-body'] as const){
  for(const credential of ['oauth-revoked','oauth-expired','agent-deleted','agent-expired','session-deleted','session-expired'] as const){
    test(`normalized action rejects ${credential} during ${phase} without effects or key consumption`,()=>rejectedAfterBody(credential,phase));
  }
  for(const mutation of ['world-create','client-register'] as const)for(const credential of ['session-deleted','session-expired'] as const){
    test(`${mutation} rejects ${credential} during ${phase} without source writes`,()=>rejectedAfterBody(credential,phase,mutation));
  }
}

test('Zoho native authorization cannot be changed by repeated path separators',async()=>{
  const f=await start(':memory:');try{
    const world=await f.create();await f.connect(world.id,'zoho-books');
    const token=f.agent(world.id),before=JSON.stringify(f.server.store.world(world.id));
    const canonical=`/providers/zoho-books/worlds/${world.id}/books/v3/journals?organization_id=${world.id}`;
    const request=async(path:string,scheme:string)=>{
      const response=await fetch(f.base+path,{headers:{Authorization:`${scheme} ${token}`}});
      return {status:response.status,data:await response.json()};
    };
    const wrong=await request(canonical,'Bearer');assert.equal(wrong.status,401);assert.equal(wrong.data.error.code,'authentication_required');
    const valid=await request(canonical,'Zoho-oauthtoken');assert.equal(valid.status,200,JSON.stringify(valid.data));assert.deepEqual(valid.data.journals,[]);
    // The first alias previously returned 200 with Bearer while the canonical
    // path required Zoho-oauthtoken. Every separator is rejected before auth.
    for(const alias of [canonical.replace('/providers/','/providers//'),canonical.replace('/worlds/','//worlds/'),canonical.replace(`/worlds/${world.id}`,`/worlds//${world.id}`),canonical.replace('/books/v3/','/books//v3/')]){
      for(const scheme of ['Bearer','Zoho-oauthtoken']){
        const result=await request(alias,scheme);assert.equal(result.status,400,JSON.stringify(result.data));assert.equal(result.data.error.code,'invalid_path');
      }
    }
    assert.equal(JSON.stringify(f.server.store.world(world.id)),before);
    assert.equal(f.server.store.events(world.id,0,1000).filter(event=>event.type==='action.completed').length,0);
    assert.equal(f.server.store.verify(world.id).valid,true);
  }finally{await f.close();}
});

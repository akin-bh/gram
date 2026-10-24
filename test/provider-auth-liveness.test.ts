import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from '../src/store.ts';
import {start} from './integration-fixture.ts';

for(const phase of ['body','commit'] as const)for(const credential of ['oauth-revoked','oauth-expired','agent-deleted','agent-expired'] as const){
  test(`native preparation cannot commit when ${credential} between authorization and ${phase}`,async()=>{
    const folder=mkdtempSync(join(tmpdir(),'gram-provider-auth-')),f=await start(join(folder,'world.sqlite'));
    const store=f.server.store,oauth=f.server.oauth,originalGet=store.get,originalRequire=oauth.require;
    try{
      const w=await f.create(),isOAuth=credential.startsWith('oauth');
      if(!isOAuth)await f.connect(w.id,'gusto');
      const token=isOAuth?await f.grant(w.id,'read write'):f.agent(w.id),tokenHash=hash(token);
      const grantId=isOAuth?store.get('access',tokenHash).grant:undefined;
      const initialGrant=isOAuth?store.get('grants',grantId):undefined;
      const actorId=isOAuth?`oauth:${initialGrant.client_id}`:`agent-world:${w.id}`;
      const before=JSON.stringify(store.world(w.id)),key=`auth-${phase}-${credential}-${randomUUID()}`;
      let scheduled=false,invalidated=false,requires=0;
      const invalidate=()=>{
        if(credential==='oauth-revoked')oauth.revokeToken('gusto',{token,client_id:initialGrant.client_id});
        else if(credential==='oauth-expired'){const grant:any=originalGet.call(store,'grants',grantId);grant.expires_at=Date.now()-1;store.put('grants',grantId,grant);}
        else if(credential==='agent-deleted')store.delete('agent-tokens',tokenHash);
        else{const entry:any=originalGet.call(store,'agent-tokens',tokenHash);entry.expires_at=Date.now()-1;store.put('agent-tokens',tokenHash,entry);}
        invalidated=true;
      };
      const schedule=()=>{if(!scheduled){scheduled=true;queueMicrotask(invalidate);}};
      if(phase==='body'){
        // Return the still-valid actor source, then invalidate it before the
        // handler resumes from its request-body read. No sleeps or timing race.
        store.get=function(namespace:string,id:string){const result=originalGet.call(store,namespace,id);if(namespace===(isOAuth?'grants':'agent-tokens')&&id===(isOAuth?grantId:tokenHash)&&result)schedule();return result;} as typeof store.get;
      }else{
        // First check admits the provider request. The second authorizes the
        // canonical action on a private world copy; its awaited adapter result
        // supplies the exact boundary before Store.once commits anything.
        oauth.require=function(world:string,system:string,scope:string,actor:any){const result=originalRequire.call(oauth,world,system,scope,actor);if(world===w.id&&system==='gusto'&&scope==='write'&&actor.id===actorId&&++requires===2)schedule();return result;};
      }
      const input={off_cycle:true,off_cycle_reason:'Adhoc',start_date:w.payrollTimeRecords[0].period_start,end_date:w.payrollTimeRecords[0].period_end,employee_uuids:w.employees.map((row:any)=>row.id),finance_world:{policy_id:w.payrollPolicies[0].id,time_record_ids:w.payrollTimeRecords.map((row:any)=>row.id)}};
      const response=await fetch(`${f.base}/providers/gusto/worlds/${w.id}/v1/companies/${w.id}/payrolls`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(input)}),payload=await response.json();
      assert.equal(scheduled,true,'The requested asynchronous boundary must be exercised');assert.equal(invalidated,true,'Credential invalidation must finish before the response');
      assert.equal(response.status,401,JSON.stringify(payload));assert.ok(['authentication_required','authentication_changed'].includes(payload.error.code));
      const after=store.world(w.id);assert.equal(JSON.stringify(after),before,'Rejected authorization must preserve the entire canonical world');
      assert.equal(after.payrollRuns.length,0);assert.deepEqual(after.bankTransactions,w.bankTransactions);assert.deepEqual(after.journals,w.journals);
      const entry=store.db.prepare('SELECT value FROM idempotency WHERE world=? AND actor=? AND key=?').get(w.id,actorId,key);assert.equal(entry,null,'Failed authorization cannot cache a success or reserve the key');
      assert.equal(store.events(w.id,0,1000).filter(row=>row.type==='action.completed').length,0);assert.equal(store.verify(w.id).valid,true);
    }finally{store.get=originalGet;oauth.require=originalRequire;await f.close();rmSync(folder,{recursive:true,force:true});}
  });
}

import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {compactRunProgress,withRunProgress,finishRun} from './agent-progress.ts';
import {Store} from './store.ts';

const first='2026-10-24T10:00:00.000Z',later='2026-10-24T10:00:01.000Z',done='2026-10-24T10:00:02.000Z';

test('agent progress exposes only current operational metadata and never credentials or raw payloads',()=>{
  const progress=compactRunProgress({type:'agent.tool.request',at:'untrusted-time',method:'POST',path:'/api/worlds/world-example/actions?access_token=private-query#private-fragment',headers:{Authorization:'Bearer private-header'},body:{type:'pay_bill',bank_account:'private-bank',token:'private-body'},response:{secret:'private-response'},error:'private-error',content:[{text:'private-text'}]},first);
  assert.deepEqual(progress,{type:'agent.tool.request',at:first,method:'POST',path:'/api/worlds/world-example/actions',action_type:'pay_bill'});
  assert.equal(JSON.stringify(progress).includes('private'),false);
  assert.deepEqual(compactRunProgress({type:'agent.tool.response',method:'GET',path:'/api/worlds/world-example/records?system=gmail&feed=message',status:503,response:{error:{message:'private details'}}},later),{type:'agent.tool.response',at:later,method:'GET',path:'/api/worlds/world-example/records',status:503});
});

test('progress changes phases without carrying a prior action or response status into thinking',()=>{
  const original={id:'run-one',status:'running',progress:{type:'agent.tool.response',at:first,method:'POST',path:'/api/worlds/world-example/actions',status:200,action_type:'pay_bill'},saved:'keep'};
  const thinking=withRunProgress(original,{type:'agent.message',content:[{text:'private'}],status:503,body:{type:'refund'}},later);
  assert.deepEqual(thinking.progress,{type:'agent.message',at:later});assert.equal(thinking.saved,'keep');assert.equal(original.progress.status,200);
  assert.equal(withRunProgress(original,{type:'unrecognized',secret:'private'},later),original);
  assert.equal(compactRunProgress({type:'agent.message'},'not-a-time'),undefined);
  for(const path of ['https://user:password@example.test/actions','//example.test/actions','/api/worlds/world-example/actions\nsecret','/api/worlds/world-example/sk-ant-secret/actions','/api/worlds/world-example/records%0a']) {
    assert.equal(compactRunProgress({type:'agent.tool.request',method:'POST',path,body:{type:'pay_bill'}},later)?.path,undefined);
  }
  assert.deepEqual(compactRunProgress({type:'agent.tool.response',method:'private-method',path:'/api/worlds/world-example/context',status:'private-status'},later),{type:'agent.tool.response',at:later,path:'/api/worlds/world-example/context'});
});

test('completion merges the latest stored run and retains its sanitized terminal progress durably',()=>{
  const store=new Store(':memory:');
  try {
    const original={id:'run-one',status:'running',started_at:first,output:''};store.put('runs',original.id,original);
    store.put('runs',original.id,withRunProgress({...store.get('runs',original.id),retained:'latest-state'},{type:'agent.tool.request',method:'GET',path:'/api/worlds/world-example/context'},later));
    store.put('runs',original.id,withRunProgress(store.get('runs',original.id)!,{type:'agent.completed'},done));
    const final=finishRun(store.get('runs',original.id)!,'completed','2026-10-24T10:00:03.000Z',{output:'Finished',usage:{tokens:12},status:'running',progress:{secret:'private'}});
    store.put('runs',original.id,final);const saved=store.get('runs',original.id);
    assert.equal(saved.retained,'latest-state');assert.equal(saved.status,'completed');assert.equal(saved.started_at,first);assert.equal(saved.output,'Finished');assert.deepEqual(saved.progress,{type:'agent.completed',at:done});assert.deepEqual(saved.usage,{tokens:12});
  } finally {store.close();}
});

test('failed, cancelled and interrupted runs have truthful terminal progress without stale tool metadata',()=>{
  const running={id:'run-one',status:'running',progress:{type:'agent.tool.request',at:first,method:'POST',path:'/api/worlds/world-example/actions',action_type:'refund'},retained:'latest'};
  for(const status of ['failed','cancelled','interrupted'] as const) {
    const final=finishRun(running,status,later,{error:'Sanitized failure'});
    assert.equal(final.status,status);assert.equal(final.retained,'latest');assert.equal(final.error,'Sanitized failure');assert.deepEqual(final.progress,{type:status==='interrupted'?'agent.interrupted':'agent.failed',at:later});
  }
  const observed=withRunProgress(running,{type:'agent.failed',error:'private'},later);
  assert.deepEqual(finishRun(observed,'failed',done,{error:'Safe failure'}).progress,{type:'agent.failed',at:later});
});

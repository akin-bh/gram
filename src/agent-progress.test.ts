import {test,expect} from 'bun:test';
import {compactRunProgress,withRunProgress,finishRun} from './agent-progress.ts';
import {Store} from './store.ts';

const first='2026-10-24T10:00:00.000Z',later='2026-10-24T10:00:01.000Z',done='2026-10-24T10:00:02.000Z';

test('agent progress exposes only current operational metadata and never credentials or raw payloads',()=>{
  const progress=compactRunProgress({type:'agent.tool.request',at:'untrusted-time',method:'POST',path:'/api/worlds/world-example/actions?access_token=private-query#private-fragment',headers:{Authorization:'Bearer private-header'},body:{type:'pay_bill',bank_account:'private-bank',token:'private-body'},response:{secret:'private-response'},error:'private-error',content:[{text:'private-text'}]},first);
  expect(progress).toStrictEqual({type:'agent.tool.request',at:first,method:'POST',path:'/api/worlds/world-example/actions',action_type:'pay_bill'});
  expect(JSON.stringify(progress).includes('private')).toBe(false);
  expect(compactRunProgress({type:'agent.tool.response',method:'GET',path:'/api/worlds/world-example/records?system=gmail&feed=message',status:503,response:{error:{message:'private details'}}},later)).toStrictEqual({type:'agent.tool.response',at:later,method:'GET',path:'/api/worlds/world-example/records',status:503});
});

test('progress changes phases without carrying a prior action or response status into thinking',()=>{
  const original={id:'run-one',status:'running',progress:{type:'agent.tool.response',at:first,method:'POST',path:'/api/worlds/world-example/actions',status:200,action_type:'pay_bill'},saved:'keep'};
  const thinking=withRunProgress(original,{type:'agent.message',content:[{text:'private'}],status:503,body:{type:'refund'}},later);
  expect(thinking.progress).toStrictEqual({type:'agent.message',at:later});expect(thinking.saved).toBe('keep');expect(original.progress.status).toBe(200);
  expect(withRunProgress(original,{type:'unrecognized',secret:'private'},later)).toBe(original);
  expect(compactRunProgress({type:'agent.message'},'not-a-time')).toBeUndefined();
  for(const path of ['https://user:password@example.test/actions','//example.test/actions','/api/worlds/world-example/actions\nsecret','/api/worlds/world-example/sk-ant-secret/actions','/api/worlds/world-example/records%0a']) {
    expect(compactRunProgress({type:'agent.tool.request',method:'POST',path,body:{type:'pay_bill'}},later)?.path).toBeUndefined();
  }
  expect(compactRunProgress({type:'agent.tool.response',method:'private-method',path:'/api/worlds/world-example/context',status:'private-status'},later)).toStrictEqual({type:'agent.tool.response',at:later,path:'/api/worlds/world-example/context'});
});

test('completion merges the latest stored run and retains its sanitized terminal progress durably',()=>{
  const store=new Store(':memory:');
  try {
    const original={id:'run-one',status:'running',started_at:first,output:''};store.put('runs',original.id,original);
    store.put('runs',original.id,withRunProgress({...store.get('runs',original.id),retained:'latest-state'},{type:'agent.tool.request',method:'GET',path:'/api/worlds/world-example/context'},later));
    store.put('runs',original.id,withRunProgress(store.get('runs',original.id)!,{type:'agent.completed'},done));
    const final=finishRun(store.get('runs',original.id)!,'completed','2026-10-24T10:00:03.000Z',{output:'Finished',usage:{tokens:12},status:'running',progress:{secret:'private'}});
    store.put('runs',original.id,final);const saved=store.get('runs',original.id);
    expect(saved.retained).toBe('latest-state');expect(saved.status).toBe('completed');expect(saved.started_at).toBe(first);expect(saved.output).toBe('Finished');expect(saved.progress).toStrictEqual({type:'agent.completed',at:done});expect(saved.usage).toStrictEqual({tokens:12});
  } finally {store.close();}
});

test('failed, cancelled and interrupted runs have truthful terminal progress without stale tool metadata',()=>{
  const running={id:'run-one',status:'running',progress:{type:'agent.tool.request',at:first,method:'POST',path:'/api/worlds/world-example/actions',action_type:'refund'},retained:'latest'};
  for(const status of ['failed','cancelled','interrupted'] as const) {
    const final=finishRun(running,status,later,{error:'Sanitized failure'});
    expect(final.status).toBe(status);expect(final.retained).toBe('latest');expect(final.error).toBe('Sanitized failure');expect(final.progress).toStrictEqual({type:status==='interrupted'?'agent.interrupted':'agent.failed',at:later});
  }
  const observed=withRunProgress(running,{type:'agent.failed',error:'private'},later);
  expect(finishRun(observed,'failed',done,{error:'Safe failure'}).progress).toStrictEqual({type:'agent.failed',at:later});
});

import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {agentActionSchema,createNativeProviderRequester,nativeProviderRequestSchema} from './agent.ts';
import {providerContracts} from './provider-contracts.ts';
import {start} from '../test/integration-fixture.ts';

const token='scoped-test-bearer-private',baseUrl='http://127.0.0.1:9191',worldId='native-test-world';
type Requester=ReturnType<typeof createNativeProviderRequester>;
const decode=(result:Awaited<ReturnType<Requester>>)=>JSON.parse(result.content[0]!.text);
function mock(handler:(url:string,init:RequestInit)=>Response|Promise<Response>,options:{signal?:AbortSignal;timeoutMs?:number;onEvent?:(event:any)=>void}={}){
  const events:any[]=[],requests:{url:string;init:RequestInit}[]=[];
  const request=createNativeProviderRequester({worldId,baseUrl,token,signal:options.signal,timeoutMs:options.timeoutMs,onEvent:event=>{events.push(event);options.onEvent?.(event);},transport:(async(url:any,init:any)=>{requests.push({url:String(url),init});return handler(String(url),init);}) as typeof fetch});
  return {request,events,requests};
}
const json=(body:any,status=200,headers:Record<string,string>={})=>Response.json(body,{status,headers});

test('native tool uses the registry for company identity, method, query encoding and documented operation schema',async()=>{
  const f=mock(()=>json({QueryResponse:{Invoice:[]}},200,{'X-Request-Id':'request-1','X-Total-Count':'0','Set-Cookie':'private-cookie'}));
  const result=decode(await f.request({operation_id:'quickbooks.query',query:{query:"SELECT * FROM Invoice WHERE Id = 'inv-a'",minorversion:['75','76']}}));
  const sent=f.requests[0]!,url=new URL(sent.url);assert.equal(url.origin,baseUrl);assert.equal(url.pathname,`/providers/quickbooks/worlds/${worldId}/v3/company/${worldId}/query`);
  assert.deepEqual(url.searchParams.getAll('minorversion'),['75','76']);assert.equal(sent.init.method,'GET');assert.equal(new Headers(sent.init.headers).get('authorization'),'Bearer '+token);assert.equal(sent.init.redirect,'manual');
  assert.deepEqual(result.body,{QueryResponse:{Invoice:[]}});assert.equal(result.request_id,'request-1');assert.equal(result.headers['x-total-count'],'0');assert.equal(result.headers['set-cookie'],undefined);
  assert.deepEqual(f.events.map(e=>e.type),['agent.tool.request','agent.tool.response']);
  const schema=z.toJSONSchema(nativeProviderRequestSchema,{target:'draft-7'});assert.equal(schema.additionalProperties,false);assert.ok((schema.properties!.operation_id as any).enum.includes('gusto.payroll.calculate'));
  assert.equal(providerContracts.find(c=>c.id==='gusto.payroll.calculate')!.access,'write');
});

test('native tool rejects authority, credentials, traversal and malformed payloads before any I/O',async()=>{
  const f=mock(()=>json({unexpected:true}));
  const cycle:any={};cycle.nested=cycle;
  const bad:any[]=[
    {operation_id:'unlisted.admin.approve'},
    {operation_id:'stripe.invoices.list',url:'http://external.test'},
    {operation_id:'stripe.invoices.list',headers:{Authorization:'supplied'}},
    {operation_id:'stripe.invoices.get',path_params:{id:'../approvals'}},
    {operation_id:'stripe.invoices.get',path_params:{id:'%2fadmin'}},
    {operation_id:'quickbooks.query',path_params:{company_id:'other-world'}},
    {operation_id:'stripe.invoices.list',path_params:{world_id:'other-world'}},
    {operation_id:'plaid.transactions.sync',body:{options:{accessToken:'foreign'}}},
    {operation_id:'plaid.transactions.sync',query:{client_secret:'foreign'}},
    {operation_id:'plaid.transactions.sync',body:{nested:{headers:{Cookie:'foreign'}}}},
    {operation_id:'plaid.transactions.sync',body:{nested:()=>true}},
    {operation_id:'plaid.transactions.sync',body:cycle},
    {operation_id:'stripe.invoices.list',body:{}},
    {operation_id:'plaid.transactions.sync',body:{unbounded:'a'.repeat(256*1024)}},
  ];
  for(const input of bad){const result=await f.request(input);assert.equal(result.isError,true);assert.ok(decode(result).error.code);}
  assert.equal(f.requests.length,0);assert.equal(f.events.length,bad.length);assert.ok(f.events.every(e=>e.type==='agent.tool.denied'));
});

test('POST reads need no write key and transport failures do not invent a financial outcome',async()=>{
  const f=mock(()=>{throw new Error('simulated network unavailable');});
  const result=decode(await f.request({operation_id:'plaid.transactions.sync',body:{cursor:'native-cursor',count:10}}));
  assert.equal(f.requests[0]!.init.method,'POST');assert.equal(new Headers(f.requests[0]!.init.headers).get('idempotency-key'),null);
  assert.equal(result.access,'read');assert.equal(result.error.code,'service_unavailable');assert.equal(result.operation_outcome_unknown,undefined);assert.equal(f.requests.length,1);
});

test('native writes require stable keys, preserve uncertain outcomes and never retry themselves',async()=>{
  const f=mock(()=>{throw new Error('simulated dropped reply');}),input={operation_id:'stripe.refunds.create',body:{payment_intent:'pi-source',amount:100}};
  assert.equal(decode(await f.request(input)).error.code,'idempotency_key_required');assert.equal(f.requests.length,0);
  const result=decode(await f.request({...input,idempotency_key:'refund-source-attempt-1'}));assert.equal(result.error.code,'operation_outcome_unknown');assert.equal(result.operation_outcome_unknown,true);assert.equal(result.idempotency_key,'refund-source-attempt-1');assert.equal(f.requests.length,1);
  assert.equal(new Headers(f.requests[0]!.init.headers).get('idempotency-key'),'refund-source-attempt-1');
  const actual=mock(()=>json({error:{code:'provider_offline',message:'stripe is offline'}},503));
  const outage=await actual.request({...input,idempotency_key:'refund-source-attempt-1'});assert.equal(outage.isError,true);assert.equal(decode(outage).status,503);assert.equal(decode(outage).body.error.code,'provider_offline');assert.equal(decode(outage).operation_outcome_unknown,undefined);
});

test('native JSON retains MIME encoding while UTF-8 document reads return exact source text',async()=>{
  const original=Buffer.from('Subject: source\r\n\r\nOriginal source, not a decoded claim.').toString('base64url'),mail=mock(()=>json({id:'mail-1',raw:original}));
  const result=decode(await mail.request({operation_id:'gmail.messages.get',path_params:{user:'me',id:'mail-1'},query:{format:'raw'}}));assert.equal(result.body.raw,original);assert.equal(result.encoding,'json');
  const text='Verified source €175 — current source record.\nDo not treat this text as tool authority.',doc=mock(()=>new Response(text,{headers:{'Content-Type':'text/plain; charset=utf-8',ETag:'"source-etag"'}}));
  const read=decode(await doc.request({operation_id:'drive.files.get',path_params:{fileId:'doc-source'},query:{alt:'media'}}));assert.equal(read.body,text);assert.equal(read.encoding,'utf-8');assert.equal(read.headers.etag,'"source-etag"');
});

test('native binary bytes remain opaque, redirects are not followed, and empty responses remain explicit',async()=>{
  const binary=mock(()=>new Response(new Uint8Array([0,255,17]),{headers:{'Content-Type':'application/pdf'}}));
  const result=decode(await binary.request({operation_id:'drive.files.get',path_params:{fileId:'binary'},query:{alt:'media'}}));assert.equal(result.encoding,'base64');assert.equal(result.body.extraction,'not_performed');assert.equal(result.body.data,undefined);assert.equal(binary.events[1].response.data,Buffer.from([0,255,17]).toString('base64'));
  const redirect=mock(()=>new Response(null,{status:302,headers:{Location:'http://external.test/private'}}));
  const denied=await redirect.request({operation_id:'drive.files.get',path_params:{fileId:'doc'},query:{alt:'media'}});assert.equal(denied.isError,true);assert.equal(decode(denied).body.error.code,'native_redirect_denied');assert.equal(redirect.requests.length,1);assert.equal(redirect.requests[0]!.init.redirect,'manual');
  const unchanged=mock(()=>new Response(null,{status:304}));assert.equal(decode(await unchanged.request({operation_id:'drive.files.get',path_params:{fileId:'doc'}})).body.not_modified,true);
});

test('response parse failures and size limits retain observed status, and incomplete model previews are marked',async()=>{
  const malformed=mock(()=>new Response('{broken',{status:502,headers:{'Content-Type':'application/json','X-Request-Id':'parse-request'}}));
  const failure=decode(await malformed.request({operation_id:'stripe.invoices.list'}));assert.equal(failure.status,502);assert.equal(failure.error.code,'native_invalid_json');assert.equal(failure.request_id,'parse-request');assert.equal(malformed.events[1].status,502);
  const invalid=mock(()=>new Response(new Uint8Array([255]),{headers:{'Content-Type':'text/plain'}}));assert.equal(decode(await invalid.request({operation_id:'drive.files.get',path_params:{fileId:'doc'}})).error.code,'native_invalid_encoding');
  let cancelled=false;const huge=mock(()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/plain'}}));
  const tooBig=decode(await huge.request({operation_id:'drive.files.get',path_params:{fileId:'doc'}}));assert.equal(tooBig.status,200);assert.equal(tooBig.error.code,'native_response_too_large');assert.equal(cancelled,true);
  const preview=mock(()=>json({data:'a'.repeat(80000)})),partial=decode(await preview.request({operation_id:'stripe.invoices.list'}));assert.equal(partial.truncated,true);assert.equal(partial.body,undefined);assert.equal(partial.body_preview.length,16000);assert.equal(preview.events[1].response.data.length,80000);
});

test('native cancellation prevents dispatch after awaited audit and cancels stalled response streams',async()=>{
  const controller=new AbortController(),cancelled=mock(()=>json({unexpected:true}),{signal:controller.signal,onEvent:event=>{if(event.type==='agent.tool.request')controller.abort(new Error('cancelled after durable audit'));}});
  await assert.rejects(()=>cancelled.request({operation_id:'stripe.invoices.list'}),/cancelled after durable audit/);assert.equal(cancelled.requests.length,0);
  let streamCancelled=false;const stalled=mock(()=>new Response(new ReadableStream({cancel(){streamCancelled=true;}}),{headers:{'Content-Type':'text/plain'}}),{timeoutMs:10});
  const result=decode(await stalled.request({operation_id:'drive.files.get',path_params:{fileId:'doc'}}));assert.equal(result.error.code,'service_unavailable');assert.equal(streamCancelled,true);assert.equal(result.status,200);
});

test('echoed credentials are removed from both model payloads and durable native metadata',async()=>{
  const f=mock(()=>json({raw:'Bearer '+token,access_token:'other-private'},200,{'X-Request-Id':token,ETag:'"'+token+'"'}));
  const result=await f.request({operation_id:'stripe.invoices.list'}),combined=JSON.stringify({result,events:f.events});assert.ok(!combined.includes(token));assert.ok(!combined.includes('other-private'));assert.ok(combined.includes('[REDACTED]'));assert.equal(decode(result).request_id,'[REDACTED]');
});

test('source-backed payroll preparation schemas require observed version and reject controller impersonation',()=>{
  const prepare={type:'prepare_payroll',policy_id:'policy-1',time_record_ids:['time-1']},calculate={type:'calculate_prepared_payroll',payroll_run_id:'payroll-1',version:'a'.repeat(64)};
  for(const action of [prepare,calculate]){assert.equal(agentActionSchema.safeParse(action).success,true);assert.equal(agentActionSchema.safeParse({...action,actor:'controller'}).success,false);}
  for(const version of ['',undefined,'A'.repeat(64),'a'.repeat(63),'g'.repeat(64)])assert.equal(agentActionSchema.safeParse({...calculate,version}).success,false);
  assert.equal(agentActionSchema.safeParse({type:'cancel_payroll',payroll_run_id:'payroll-1',reason:'self-approval bypass',external_event_id:'fake'}).success,false);
});

test('native tool crosses real OAuth HTTP for stable Gusto create/calculate/submit replay and read-only denial',async()=>{
  const f=await start(':memory:');
  try{
    const world=await f.create(),readToken=await f.grant(world.id,'read'),writeToken=await f.grant(world.id,'read write'),events:any[]=[];
    const requester=(bearer:string)=>createNativeProviderRequester({worldId:world.id,baseUrl:f.base,token:bearer,onEvent:event=>{events.push(event);}}),read=requester(readToken),write=requester(writeToken);
    const source={off_cycle:true,off_cycle_reason:'Adhoc',start_date:world.payrollTimeRecords[0].period_start,end_date:world.payrollTimeRecords[0].period_end,employee_uuids:world.employees.map((e:any)=>e.id),finance_world:{policy_id:world.payrollPolicies[0].id,time_record_ids:world.payrollTimeRecords.map((t:any)=>t.id)}};
    const before=structuredClone({bank:world.bankTransactions,journals:world.journals,accounts:world.accounts,operations:world.operations});
    assert.equal(decode(await read({operation_id:'gusto.payrolls.list'})).status,200);
    const create={operation_id:'gusto.payroll.create',body:source,idempotency_key:'native-payroll-create-1'};
    assert.equal(decode(await read(create)).status,403);assert.equal(f.server.store.world(world.id).payrollRuns.length,0);
    const draft=decode(await write(create));assert.equal(draft.status,200);assert.equal(draft.body.finance_world.canonical_status,'draft');const id=draft.body.uuid;
    const calculate={operation_id:'gusto.payroll.calculate',path_params:{payroll_id:id},body:{finance_world:{version:draft.body.finance_world.version}},idempotency_key:'native-payroll-calculate-1'};
    const calculated=decode(await write(calculate));assert.equal(calculated.status,202);assert.equal(calculated.body.uuid,id);assert.equal(calculated.body.finance_world.canonical_status,'calculated');assert.equal(calculated.body.processed,false);
    const replay=decode(await write(calculate));assert.equal(replay.status,202);assert.equal(replay.headers['idempotent-replayed'],'true');assert.deepEqual(replay.body,calculated.body);
    assert.equal(decode(await write({...calculate,body:{finance_world:{version:'b'.repeat(64)}}})).status,409);
    const submit={operation_id:'gusto.payroll.submit',path_params:{payroll_id:id},body:{finance_world:{version:calculated.body.finance_world.version}},idempotency_key:'native-payroll-submit-1'};
    const requested=decode(await write(submit));assert.equal(requested.status,202);assert.equal(requested.body.finance_world.canonical_status,'awaiting_approval');assert.equal(requested.body.processed,false);
    const again=decode(await write(submit));assert.equal(again.headers['idempotent-replayed'],'true');assert.deepEqual(again.body,requested.body);
    const after=f.server.store.world(world.id);assert.equal(after.payrollRuns.length,1);assert.equal(after.approvals.length,1);assert.deepEqual({bank:after.bankTransactions,journals:after.journals,accounts:after.accounts,operations:after.operations},before);
    assert.equal(f.server.store.verify(world.id).valid,true);assert.ok(!JSON.stringify(events).includes(writeToken));assert.ok(events.some(e=>e.type==='agent.tool.response'&&e.operation_id==='gusto.payroll.calculate'&&e.status===202));
  }finally{await f.close();}
});

test('native scoped worker reads actual Drive text after consent and retains outage failures without mirror substitution',async()=>{
  const f=await start(':memory:');
  try{
    const world=await f.create(),events:any[]=[],request=createNativeProviderRequester({worldId:world.id,baseUrl:f.base,token:f.agent(world.id),onEvent:event=>{events.push(event);}}),input={operation_id:'drive.files.get',path_params:{fileId:world.documents[0].id},query:{alt:'media'}};
    assert.equal(decode(await request(input)).status,401);await f.connect(world.id,'google-drive');
    const source=decode(await request(input));assert.equal(source.status,200);assert.equal(source.encoding,'utf-8');assert.equal(source.body,world.documents[0].body);assert.ok(source.headers.etag);
    await f.act(world.id,{type:'set_fault',system:'google-drive',mode:'offline'});
    const outage=decode(await request(input));assert.equal(outage.status,503);assert.equal(outage.body.error.code,'provider_offline');assert.equal(events.filter(e=>e.type==='agent.tool.request').length,3);
  }finally{await f.close();}
});

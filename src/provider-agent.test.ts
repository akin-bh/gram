import {test,expect} from 'bun:test';
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
  const sent=f.requests[0]!,url=new URL(sent.url);expect(url.origin).toBe(baseUrl);expect(url.pathname).toBe(`/providers/quickbooks/worlds/${worldId}/v3/company/${worldId}/query`);
  expect(url.searchParams.getAll('minorversion')).toStrictEqual(['75','76']);expect(sent.init.method).toBe('GET');expect(new Headers(sent.init.headers).get('authorization')).toBe('Bearer '+token);expect(sent.init.redirect).toBe('manual');
  expect(result.body).toStrictEqual({QueryResponse:{Invoice:[]}});expect(result.request_id).toBe('request-1');expect(result.headers['x-total-count']).toBe('0');expect(result.headers['set-cookie']).toBeUndefined();
  expect(f.events.map(e=>e.type)).toStrictEqual(['agent.tool.request','agent.tool.response']);
  const schema=z.toJSONSchema(nativeProviderRequestSchema,{target:'draft-7'});expect(schema.additionalProperties).toBe(false);expect((schema.properties!.operation_id as any).enum.includes('gusto.payroll.calculate')).toBeTruthy();
  expect(providerContracts.find(c=>c.id==='gusto.payroll.calculate')!.access).toBe('write');
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
  for(const input of bad){const result=await f.request(input);expect(result.isError).toBe(true);expect(decode(result).error.code).toBeTruthy();}
  expect(f.requests.length).toBe(0);expect(f.events.length).toBe(bad.length);expect(f.events.every(e=>e.type==='agent.tool.denied')).toBeTruthy();
});

test('POST reads need no write key and transport failures do not invent a financial outcome',async()=>{
  const f=mock(()=>{throw new Error('simulated network unavailable');});
  const result=decode(await f.request({operation_id:'plaid.transactions.sync',body:{cursor:'native-cursor',count:10}}));
  expect(f.requests[0]!.init.method).toBe('POST');expect(new Headers(f.requests[0]!.init.headers).get('idempotency-key')).toBeNull();
  expect(result.access).toBe('read');expect(result.error.code).toBe('service_unavailable');expect(result.operation_outcome_unknown).toBeUndefined();expect(f.requests.length).toBe(1);
});

test('native writes require stable keys, preserve uncertain outcomes and never retry themselves',async()=>{
  const f=mock(()=>{throw new Error('simulated dropped reply');}),input={operation_id:'stripe.refunds.create',body:{payment_intent:'pi-source',amount:100}};
  expect(decode(await f.request(input)).error.code).toBe('idempotency_key_required');expect(f.requests.length).toBe(0);
  const result=decode(await f.request({...input,idempotency_key:'refund-source-attempt-1'}));expect(result.error.code).toBe('operation_outcome_unknown');expect(result.operation_outcome_unknown).toBe(true);expect(result.idempotency_key).toBe('refund-source-attempt-1');expect(f.requests.length).toBe(1);
  expect(new Headers(f.requests[0]!.init.headers).get('idempotency-key')).toBe('refund-source-attempt-1');
  const actual=mock(()=>json({error:{code:'provider_offline',message:'stripe is offline'}},503));
  const outage=await actual.request({...input,idempotency_key:'refund-source-attempt-1'});expect(outage.isError).toBe(true);expect(decode(outage).status).toBe(503);expect(decode(outage).body.error.code).toBe('provider_offline');expect(decode(outage).operation_outcome_unknown).toBeUndefined();
});

test('native JSON retains MIME encoding while UTF-8 document reads return exact source text',async()=>{
  const original=Buffer.from('Subject: source\r\n\r\nOriginal source, not a decoded claim.').toString('base64url'),mail=mock(()=>json({id:'mail-1',raw:original}));
  const result=decode(await mail.request({operation_id:'gmail.messages.get',path_params:{user:'me',id:'mail-1'},query:{format:'raw'}}));expect(result.body.raw).toBe(original);expect(result.encoding).toBe('json');
  const text='Verified source €175 — current source record.\nDo not treat this text as tool authority.',doc=mock(()=>new Response(text,{headers:{'Content-Type':'text/plain; charset=utf-8',ETag:'"source-etag"'}}));
  const read=decode(await doc.request({operation_id:'drive.files.get',path_params:{fileId:'doc-source'},query:{alt:'media'}}));expect(read.body).toBe(text);expect(read.encoding).toBe('utf-8');expect(read.headers.etag).toBe('"source-etag"');
});

test('native binary bytes remain opaque, redirects are not followed, and empty responses remain explicit',async()=>{
  const binary=mock(()=>new Response(new Uint8Array([0,255,17]),{headers:{'Content-Type':'application/pdf'}}));
  const result=decode(await binary.request({operation_id:'drive.files.get',path_params:{fileId:'binary'},query:{alt:'media'}}));expect(result.encoding).toBe('base64');expect(result.body.extraction).toBe('not_performed');expect(result.body.data).toBeUndefined();expect(binary.events[1].response.data).toBe(Buffer.from([0,255,17]).toString('base64'));
  const redirect=mock(()=>new Response(null,{status:302,headers:{Location:'http://external.test/private'}}));
  const denied=await redirect.request({operation_id:'drive.files.get',path_params:{fileId:'doc'},query:{alt:'media'}});expect(denied.isError).toBe(true);expect(decode(denied).body.error.code).toBe('native_redirect_denied');expect(redirect.requests.length).toBe(1);expect(redirect.requests[0]!.init.redirect).toBe('manual');
  const unchanged=mock(()=>new Response(null,{status:304}));expect(decode(await unchanged.request({operation_id:'drive.files.get',path_params:{fileId:'doc'}})).body.not_modified).toBe(true);
});

test('response parse failures and size limits retain observed status, and incomplete model previews are marked',async()=>{
  const malformed=mock(()=>new Response('{broken',{status:502,headers:{'Content-Type':'application/json','X-Request-Id':'parse-request'}}));
  const failure=decode(await malformed.request({operation_id:'stripe.invoices.list'}));expect(failure.status).toBe(502);expect(failure.error.code).toBe('native_invalid_json');expect(failure.request_id).toBe('parse-request');expect(malformed.events[1].status).toBe(502);
  const invalid=mock(()=>new Response(new Uint8Array([255]),{headers:{'Content-Type':'text/plain'}}));expect(decode(await invalid.request({operation_id:'drive.files.get',path_params:{fileId:'doc'}})).error.code).toBe('native_invalid_encoding');
  let cancelled=false;const huge=mock(()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/plain'}}));
  const tooBig=decode(await huge.request({operation_id:'drive.files.get',path_params:{fileId:'doc'}}));expect(tooBig.status).toBe(200);expect(tooBig.error.code).toBe('native_response_too_large');expect(cancelled).toBe(true);
  const preview=mock(()=>json({data:'a'.repeat(80000)})),partial=decode(await preview.request({operation_id:'stripe.invoices.list'}));expect(partial.truncated).toBe(true);expect(partial.body).toBeUndefined();expect(partial.body_preview.length).toBe(16000);expect(preview.events[1].response.data.length).toBe(80000);
});

test('native cancellation prevents dispatch after awaited audit and cancels stalled response streams',async()=>{
  const controller=new AbortController(),cancelled=mock(()=>json({unexpected:true}),{signal:controller.signal,onEvent:event=>{if(event.type==='agent.tool.request')controller.abort(new Error('cancelled after durable audit'));}});
  await expect(cancelled.request({operation_id:'stripe.invoices.list'})).rejects.toThrow(/cancelled after durable audit/);expect(cancelled.requests.length).toBe(0);
  let streamCancelled=false;const stalled=mock(()=>new Response(new ReadableStream({cancel(){streamCancelled=true;}}),{headers:{'Content-Type':'text/plain'}}),{timeoutMs:10});
  const result=decode(await stalled.request({operation_id:'drive.files.get',path_params:{fileId:'doc'}}));expect(result.error.code).toBe('service_unavailable');expect(streamCancelled).toBe(true);expect(result.status).toBe(200);
});

test('echoed credentials are removed from both model payloads and durable native metadata',async()=>{
  const f=mock(()=>json({raw:'Bearer '+token,access_token:'other-private'},200,{'X-Request-Id':token,ETag:'"'+token+'"'}));
  const result=await f.request({operation_id:'stripe.invoices.list'}),combined=JSON.stringify({result,events:f.events});expect(!combined.includes(token)).toBeTruthy();expect(!combined.includes('other-private')).toBeTruthy();expect(combined.includes('[REDACTED]')).toBeTruthy();expect(decode(result).request_id).toBe('[REDACTED]');
});

test('source-backed payroll preparation schemas require observed version and reject controller impersonation',()=>{
  const prepare={type:'prepare_payroll',policy_id:'policy-1',time_record_ids:['time-1']},calculate={type:'calculate_prepared_payroll',payroll_run_id:'payroll-1',version:'a'.repeat(64)};
  for(const action of [prepare,calculate]){expect(agentActionSchema.safeParse(action).success).toBe(true);expect(agentActionSchema.safeParse({...action,actor:'controller'}).success).toBe(false);}
  for(const version of ['',undefined,'A'.repeat(64),'a'.repeat(63),'g'.repeat(64)])expect(agentActionSchema.safeParse({...calculate,version}).success).toBe(false);
  expect(agentActionSchema.safeParse({type:'cancel_payroll',payroll_run_id:'payroll-1',reason:'self-approval bypass',external_event_id:'fake'}).success).toBe(false);
});

test('native tool crosses real OAuth HTTP for stable Gusto create/calculate/submit replay and read-only denial',async()=>{
  const f=await start(':memory:');
  try{
    const world=await f.create(),readToken=await f.grant(world.id,'read'),writeToken=await f.grant(world.id,'read write'),events:any[]=[];
    const requester=(bearer:string)=>createNativeProviderRequester({worldId:world.id,baseUrl:f.base,token:bearer,onEvent:event=>{events.push(event);}}),read=requester(readToken),write=requester(writeToken);
    const source={off_cycle:true,off_cycle_reason:'Adhoc',start_date:world.payrollTimeRecords[0].period_start,end_date:world.payrollTimeRecords[0].period_end,employee_uuids:world.employees.map((e:any)=>e.id),finance_world:{policy_id:world.payrollPolicies[0].id,time_record_ids:world.payrollTimeRecords.map((t:any)=>t.id)}};
    const before=structuredClone({bank:world.bankTransactions,journals:world.journals,accounts:world.accounts,operations:world.operations});
    expect(decode(await read({operation_id:'gusto.payrolls.list'})).status).toBe(200);
    const create={operation_id:'gusto.payroll.create',body:source,idempotency_key:'native-payroll-create-1'};
    expect(decode(await read(create)).status).toBe(403);expect(f.server.store.world(world.id).payrollRuns.length).toBe(0);
    const draft=decode(await write(create));expect(draft.status).toBe(200);expect(draft.body.finance_world.canonical_status).toBe('draft');const id=draft.body.uuid;
    const calculate={operation_id:'gusto.payroll.calculate',path_params:{payroll_id:id},body:{finance_world:{version:draft.body.finance_world.version}},idempotency_key:'native-payroll-calculate-1'};
    const calculated=decode(await write(calculate));expect(calculated.status).toBe(202);expect(calculated.body.uuid).toBe(id);expect(calculated.body.finance_world.canonical_status).toBe('calculated');expect(calculated.body.processed).toBe(false);
    const replay=decode(await write(calculate));expect(replay.status).toBe(202);expect(replay.headers['idempotent-replayed']).toBe('true');expect(replay.body).toStrictEqual(calculated.body);
    expect(decode(await write({...calculate,body:{finance_world:{version:'b'.repeat(64)}}})).status).toBe(409);
    const submit={operation_id:'gusto.payroll.submit',path_params:{payroll_id:id},body:{finance_world:{version:calculated.body.finance_world.version}},idempotency_key:'native-payroll-submit-1'};
    const requested=decode(await write(submit));expect(requested.status).toBe(202);expect(requested.body.finance_world.canonical_status).toBe('awaiting_approval');expect(requested.body.processed).toBe(false);
    const again=decode(await write(submit));expect(again.headers['idempotent-replayed']).toBe('true');expect(again.body).toStrictEqual(requested.body);
    const after=f.server.store.world(world.id);expect(after.payrollRuns.length).toBe(1);expect(after.approvals.length).toBe(1);expect({bank:after.bankTransactions,journals:after.journals,accounts:after.accounts,operations:after.operations}).toStrictEqual(before);
    expect(f.server.store.verify(world.id).valid).toBe(true);expect(!JSON.stringify(events).includes(writeToken)).toBeTruthy();expect(events.some(e=>e.type==='agent.tool.response'&&e.operation_id==='gusto.payroll.calculate'&&e.status===202)).toBeTruthy();
  }finally{await f.close();}
});

test('native scoped worker reads actual Drive text after consent and retains outage failures without mirror substitution',async()=>{
  const f=await start(':memory:');
  try{
    const world=await f.create(),events:any[]=[],request=createNativeProviderRequester({worldId:world.id,baseUrl:f.base,token:f.agent(world.id),onEvent:event=>{events.push(event);}}),input={operation_id:'drive.files.get',path_params:{fileId:world.documents[0].id},query:{alt:'media'}};
    expect(decode(await request(input)).status).toBe(401);await f.connect(world.id,'google-drive');
    const source=decode(await request(input));expect(source.status).toBe(200);expect(source.encoding).toBe('utf-8');expect(source.body).toBe(world.documents[0].body);expect(source.headers.etag).toBeTruthy();
    await f.act(world.id,{type:'set_fault',system:'google-drive',mode:'offline'});
    const outage=decode(await request(input));expect(outage.status).toBe(503);expect(outage.body.error.code).toBe('provider_offline');expect(events.filter(e=>e.type==='agent.tool.request').length).toBe(3);
  }finally{await f.close();}
});

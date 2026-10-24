import {test} from 'bun:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {argonResponseSchema,argonUsageCost,defaultGeneratorProvider,generateArgon,generateWorldDraft,GeneratorError,loadGeneratorConfig,sanitizeGenerationEvent} from './generator.ts';
import {createWorld} from './world.ts';
import {createService} from './server.ts';
import {scenarioSchema} from './agent.ts';
import {sourceContextSchema} from './source-context.ts';

const schema=z.object({name:z.string().min(1),amount_minor:z.number().int().positive(),limitations:z.array(z.string())}).strict();
const value={name:'Payroll',amount_minor:2500,limitations:['Synthetic source records.']};
const reply=(output:any=value,patch:any={})=>Response.json({modelVersion:'gemini-4-argon-verified-version',usageMetadata:{promptTokenCount:1000,cachedContentTokenCount:200,candidatesTokenCount:300,thoughtsTokenCount:500,totalTokenCount:1800},candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'PRIVATE_REASONING_NOT_FOR_AUDIT',thoughtSignature:'PRIVATE_SIGNATURE'},{text:JSON.stringify(output)}]}}],...patch});
async function configured(fn:()=>Promise<void>|void){
  const folder=mkdtempSync(join(tmpdir(),'generator-test-')),file=join(folder,'credentials.env'),names=['FINANCE_WORLD_ENV_FILE','GEMINI_API_KEY','GOOGLE_CLOUD_PROJECT','FINANCE_WORLD_ARGON_PRICING'],before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  writeFileSync(file,"GEMINI_API_KEY='test-gemini-private-key'\nGOOGLE_CLOUD_PROJECT='test-private-project'\nGOOGLE_CLOUD_LOCATION='not-the-authoritative-location'\n",{mode:0o600});
  for(const name of names)delete process.env[name];process.env.FINANCE_WORLD_ENV_FILE=file;
  try{await fn();}finally{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}rmSync(folder,{recursive:true,force:true});}
}
const transport=(fn:(url:string,init:RequestInit)=>Promise<Response>|Response)=>((url:RequestInfo|URL,init?:RequestInit)=>Promise.resolve(fn(String(url),init!))) as typeof fetch;
const options=(fetcher:typeof fetch)=>({prompt:'Generate source-grounded payroll facts.',systemPrompt:'Return validated synthetic records only.',schema,transport:fetcher});
const strictHash=(schema:z.ZodType)=>createHash('sha256').update(JSON.stringify(z.toJSONSchema(schema,{target:'draft-7'}))).digest('hex');

test('Argon configuration uses existing private credentials while exposing only availability and verified transport metadata',async()=>configured(()=>{
  const config=loadGeneratorConfig();assert.equal(config.available,true);assert.equal(config.model,'gemini-4-argon');assert.equal(config.location,'global');assert.equal(config.pricing,'unknown');
  const text=JSON.stringify(config);assert.ok(!text.includes('test-gemini-private-key'));assert.ok(!text.includes('test-private-project'));
  process.env.GEMINI_API_KEY='';assert.equal(loadGeneratorConfig().available,false);delete process.env.GEMINI_API_KEY;
  process.env.GOOGLE_CLOUD_PROJECT='malicious/project?query';assert.equal(loadGeneratorConfig().available,false);delete process.env.GOOGLE_CLOUD_PROJECT;
  process.env.FINANCE_WORLD_ARGON_PRICING='{"inputUsdPerMillion":2}';assert.equal(loadGeneratorConfig().available,false);
}));

test('Argon sends the authoritative Vertex request and returns strictly validated visible output without thoughts or secrets',async()=>configured(async()=>{
  const events:any[]=[];let calls=0;
  const result=await generateArgon({...options(transport((url,init)=>{
    calls++;assert.equal(url,'https://aiplatform.googleapis.com/v1/projects/test-private-project/locations/global/publishers/google/models/gemini-4-argon:generateContent');assert.equal(new Headers(init.headers).get('x-goog-api-key'),'test-gemini-private-key');assert.equal(init.redirect,'manual');
    const body=JSON.parse(String(init.body));assert.equal(body.generationConfig.responseMimeType,'application/json');assert.equal(body.generationConfig.maxOutputTokens,16384);assert.deepEqual(body.generationConfig.thinkingConfig,{thinkingLevel:'MEDIUM'});assert.equal(body.generationConfig.responseSchema.type,'OBJECT');assert.equal(body.generationConfig.responseSchema.properties.amount_minor.type,'INTEGER');
    for(const forbidden of ['candidateCount','temperature','tools','thinkingBudget'])assert.equal(body[forbidden]??body.generationConfig[forbidden],undefined);
    return reply();
  })),onEvent:event=>{events.push(event);},validate:input=>({...input,name:'Validated '+input.name})});
  assert.equal(calls,1);assert.equal(result.value.name,'Validated Payroll');assert.equal(result.model,'gemini-4-argon');assert.equal(result.cost_usd,null);assert.equal(result.pricing_status,'unknown');assert.equal(result.usage.thoughtsTokenCount,500);assert.equal(result.attempts.length,1);
  assert.equal(result.output_mode,'schema');assert.equal(result.strict_schema_sha256,strictHash(schema));assert.ok(events.every(event=>event.output_mode==='schema'&&event.strict_schema_sha256===strictHash(schema)));
  const retained=JSON.stringify({result,events});for(const secret of ['test-gemini-private-key','test-private-project','PRIVATE_REASONING_NOT_FOR_AUDIT','PRIVATE_SIGNATURE'])assert.ok(!retained.includes(secret));assert.ok(events.some(event=>event.type==='generation.provider.completed'));
}));

test('explicit JSON mode sends the complete original strict schema only in the prompt and retains identical host validation and audit metadata',async()=>configured(async()=>{
 const events:any[]=[];let calls=0,validated=0;
 const result=await generateArgon({...options(transport((_url,init)=>{calls++;const body=JSON.parse(String(init.body));assert.equal(body.generationConfig.responseMimeType,'application/json');assert.equal(Object.hasOwn(body.generationConfig,'responseSchema'),false);assert.deepEqual(body.generationConfig.thinkingConfig,{thinkingLevel:'MEDIUM'});const embedded=JSON.parse(body.systemInstruction.parts[0].text.split('JSON Schema:\n')[1]);assert.deepEqual(embedded,z.toJSONSchema(schema,{target:'draft-7'}));assert.equal(embedded.additionalProperties,false);assert.equal((embedded as any).properties.amount_minor.type,'integer');assert.equal((embedded as any).properties.amount_minor.exclusiveMinimum,0);return reply();})),outputMode:'json',validate:input=>{validated++;return {...input,name:'Validated '+input.name};},onEvent:event=>{events.push(event);}});
 assert.equal(calls,1);assert.equal(validated,1);assert.equal(result.value.name,'Validated Payroll');assert.equal(result.output_mode,'json');assert.equal(result.strict_schema_sha256,strictHash(schema));assert.ok(events.length>0);assert.ok(events.every(event=>event.output_mode==='json'&&event.strict_schema_sha256===strictHash(schema)));assert.equal(result.cost_usd,null);
 let invalidCalls=0;await assert.rejects(generateArgon({...options(transport(()=>{invalidCalls++;return reply();})),outputMode:'auto' as any}),(e:any)=>e.code==='invalid_generation_options');assert.equal(invalidCalls,0);
}));

test('JSON mode rejects malformed JSON, unknown fields, numeric bounds and domain failures with one call and no fallback',async()=>configured(async()=>{
 for(const text of ['{"name":','```json\n'+JSON.stringify(value)+'\n```',JSON.stringify({...value,untrustedAuthority:true}),JSON.stringify({...value,amount_minor:-1}),JSON.stringify({...value,amount_minor:1.5})]){let calls=0,validation=0;const events:any[]=[];await assert.rejects(generateArgon({...options(transport((_url,init)=>{calls++;assert.equal(JSON.parse(String(init.body)).generationConfig.responseSchema,undefined);return reply(undefined,{candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});})),outputMode:'json',validate:input=>{validation++;return input;},onEvent:event=>{events.push(event);}}),(e:any)=>e.code==='invalid_generated_bundle'&&['json','schema'].includes(e.details.phase));assert.equal(calls,1);assert.equal(validation,0);assert.ok(events.every(event=>event.output_mode==='json'&&event.strict_schema_sha256===strictHash(schema)));assert.ok(!events.some(event=>event.type==='generation.provider.completed'));}
 let calls=0;await assert.rejects(generateArgon({...options(transport(()=>{calls++;return reply();})),outputMode:'json',validate:()=>{throw Object.assign(new Error('Source references cannot materialize'),{code:'source_missing'});}}),(e:any)=>e.code==='invalid_generated_bundle'&&e.details.phase==='domain'&&e.details.code==='source_missing');assert.equal(calls,1);
}));

test('cost accounting preserves cached input and billed thinking and never invents dollar pricing',()=>{
  const usage={promptTokenCount:1000,cachedContentTokenCount:200,candidatesTokenCount:300,thoughtsTokenCount:500},pricing={inputUsdPerMillion:2,cachedInputUsdPerMillion:0.1,outputUsdPerMillion:8,source:'verified-test-tariff'};
  assert.equal(argonUsageCost(usage).cost_usd,null);const cost=argonUsageCost(usage,pricing);assert.equal(cost.cost_usd,0.00802);assert.equal(cost.pricing_status,'estimated');assert.equal(cost.billable_output_tokens,800);assert.equal(cost.cached_input_tokens,200);
  assert.equal(argonUsageCost({promptTokenCount:2,candidatesTokenCount:1,cachedContentTokenCount:3},pricing).cost_usd,null);assert.equal(argonUsageCost({},pricing).cost_usd,null);
});

test('explicit rate-limit or unavailable responses retry the exact body at most twice while redirects and other errors never retry',async()=>configured(async()=>{
  const requests:string[]=[],waits:number[]=[];let calls=0;
  const result=await generateArgon({...options(transport((_url,init)=>{requests.push(String(init.body));calls++;return calls<3?new Response('temporary rejection',{status:calls===1?429:503,headers:{'Retry-After':'0'}}):reply();})),sleep:async ms=>{waits.push(ms);}});
  assert.equal(calls,3);assert.equal(new Set(requests).size,1);assert.deepEqual(waits,[0,0]);assert.deepEqual(result.attempts.map(attempt=>attempt.status),[429,503,200]);
  for(const status of [302,400,401,403,500]){let count=0;await assert.rejects(generateArgon(options(transport(()=>{count++;return new Response('Echo test-gemini-private-key test-private-project',{status,headers:{Location:'https://attacker.invalid'}});}))),error=>error instanceof GeneratorError&&error.code==='generation_provider_rejected'&&!JSON.stringify(error.details).includes('test-gemini-private-key')&&!JSON.stringify(error.details).includes('test-private-project'));assert.equal(count,1);}
  let exhausted=0;await assert.rejects(generateArgon({...options(transport(()=>{exhausted++;return new Response('busy',{status:503});})),sleep:async()=>{}}),error=>error instanceof GeneratorError&&error.code==='generation_provider_rejected');assert.equal(exhausted,3);
}));

test('transport uncertainty, request timeout and cancellation cannot create an automatic second paid call',async()=>configured(async()=>{
  let calls=0;await assert.rejects(generateArgon(options(transport(()=>{calls++;throw new TypeError('network lost test-gemini-private-key');}))),error=>error instanceof GeneratorError&&error.code==='generation_transport_uncertain'&&(error.details as any).remote_completion_uncertain);assert.equal(calls,1);
  calls=0;const hanging=transport((_url,init)=>{calls++;return new Promise((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});});
  await assert.rejects(generateArgon({...options(hanging),timeoutMs:5}),error=>error instanceof GeneratorError&&error.code==='generation_timeout');assert.equal(calls,1);
  const abort=new AbortController();abort.abort();await assert.rejects(generateArgon({...options(hanging),signal:abort.signal}),error=>error instanceof GeneratorError&&error.code==='generation_cancelled');assert.equal(calls,1);
}));

test('strict schema, engine rejection, truncated output and oversized bodies fail without replacement output or extra requests',async()=>configured(async()=>{
  for(const output of [{...value,untrustedAuthority:true},{...value,amount_minor:-1}]){let calls=0;await assert.rejects(generateArgon(options(transport(()=>{calls++;return reply(output);}))),error=>error instanceof GeneratorError&&error.code==='invalid_generated_bundle'&&(error.details as any).phase==='schema');assert.equal(calls,1);}
  await assert.rejects(generateArgon({...options(transport(()=>reply())),validate:()=>{throw Object.assign(new Error('Amounts cannot materialize'),{code:'domain-constraint'});}}),error=>error instanceof GeneratorError&&(error.details as any).phase==='domain'&&(error.details as any).code==='domain-constraint');
  for(const finishReason of ['MAX_TOKENS','CONTINUATION','SAFETY'])await assert.rejects(generateArgon(options(transport(()=>reply(value,{candidates:[{finishReason,content:{parts:[{text:JSON.stringify(value)}]}}]})))),error=>error instanceof GeneratorError&&error.code==='incomplete_generation');
  await assert.rejects(generateArgon(options(transport(()=>new Response('x'.repeat(4*1024*1024+1))))),error=>error instanceof GeneratorError&&error.code==='generation_response_too_large');
}));

test('transport schema supports nullable objects while local strict parsing retains omitted provider restrictions',()=>{
  const converted=argonResponseSchema(z.object({note:z.string().nullable(),mode:z.literal('synthetic'),entries:z.array(z.object({id:z.string()}).strict()).max(5)}).strict()) as any;
  assert.equal(converted.properties.note.type,'STRING');assert.equal(converted.properties.note.nullable,true);assert.deepEqual(converted.properties.mode.enum,['synthetic']);assert.equal(converted.properties.entries.maxItems,undefined);assert.deepEqual(converted.propertyOrdering,['note','mode','entries']);assert.equal(converted.additionalProperties,undefined);
  assert.deepEqual(sanitizeGenerationEvent({parts:[{thought:true,text:'hidden'},{text:'visible'}],thoughtSignature:'hidden',usage:{thoughtsTokenCount:12},'x-goog-api-key':'hidden'}),{parts:[{text:'visible'}],usage:{thoughtsTokenCount:12},'x-goog-api-key':'[REDACTED]'});
  const literals=z.object({version:z.literal(1),tax_year:z.literal(2026),flag:z.literal(false)}).strict(),wire=argonResponseSchema(literals) as any;
  assert.equal(wire.properties.version.type,'NUMBER');assert.equal(wire.properties.version.enum,undefined);assert.equal(wire.properties.tax_year.enum,undefined);assert.equal(wire.properties.flag.type,'BOOLEAN');assert.equal(wire.properties.flag.enum,undefined);assert.equal(literals.safeParse({version:2,tax_year:2026,flag:false}).success,false);
  const scenarioWire=argonResponseSchema(scenarioSchema.omit({sourceContext:true})) as any,policy=scenarioWire.properties.blueprint.properties.payroll_policy;
  assert.equal(policy.anyOf.length,2);assert.deepEqual(policy.anyOf.map((branch:any)=>branch.properties.mode.enum),[['synthetic'],['us-federal-2026']]);assert.ok(policy.anyOf.every((branch:any)=>branch.required.includes('mode')));assert.ok(policy.anyOf[0].required.includes('employee_withholding_bps'));assert.ok(policy.anyOf[1].required.includes('tax_year'));assert.equal(policy.oneOf,undefined);
});

test('rejected completed candidates retain bounded sanitized evidence without a replacement paid request',async()=>configured(async()=>{
  const events:any[]=[];let calls=0;
  await assert.rejects(generateArgon({...options(transport(()=>{calls++;return reply({...value,name:'test-gemini-private-key',amount_minor:-1});})),onEvent:event=>{events.push(event);}}),error=>error instanceof GeneratorError&&error.code==='invalid_generated_bundle');
  assert.equal(calls,1);const rejection=events.find(event=>event.type==='generation.provider.candidate_rejected');assert.equal(rejection.phase,'schema');assert.equal(rejection.candidate.amount_minor,-1);assert.equal(rejection.candidate.name,'[REDACTED]');assert.match(rejection.candidate_sha256,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(events).includes('test-gemini-private-key'));
  events.length=0;await assert.rejects(generateArgon({...options(transport(()=>reply({...value,name:'x'.repeat(300*1024),amount_minor:-1}))),onEvent:event=>{events.push(event);}}));const bounded=events.find(event=>event.type==='generation.provider.candidate_rejected');assert.equal(bounded.candidate,undefined);assert.match(bounded.candidate_omitted,/256 KiB/);assert.ok(bounded.candidate_bytes>256*1024);
}));

const payroll={kind:'payroll-close',name:'Payroll',description:'Prepare two employees using recorded time and an explicit synthetic policy.',seed:42,orderCount:2,currency:'USD',cancelEvent:false,initialFaults:[],limitations:['Synthetic normalized provider subsets; not statutory payroll.'],payrollControls:{missingTime:false,disabledRoute:false,employeeWithholdingBps:2000,employerTaxBps:765,periodClosed:false}};
function contextFromRequest(init:RequestInit){
  const request=JSON.parse(String(init.body)),grounding=JSON.parse(request.contents[0].parts[0].text).canonical;
  assert.equal(grounding.summary.id,undefined);assert.equal(grounding.collections.generationHistory,undefined);assert.equal(grounding.collections.employees.length,2);
  const employees=grounding.collections.employees,policy=grounding.collections.payrollPolicies[0],times=grounding.collections.payrollTimeRecords;
  return {parties:employees.map((employee:any,index:number)=>({collection:'employees',id:employee.id,name:`Colleague ${index+1}`,email:employee.email})),documents:[{id:'context-payroll-review',name:'Payroll source review',body:`Prepare the two recorded employees using policy ${policy.id}. Wage execution and tax remittance still need separate approval.`,source_refs:[policy.id,...times.map((row:any)=>row.id)]}],messages:[{from:'hr@company.simulation.test',to:['finance@simulation.test'],subject:'Prepare recorded payroll',body:'Please calculate payroll from the linked time and policy records, then request independent wage approval. No wage payment has been completed.',source_refs:['context-payroll-review',...employees.map((row:any)=>row.id)]}]};
}
test('two Argon stages ground context in actual deterministic records and return a portable materializable scenario',async()=>configured(async()=>{
  let calls=0;const events:any[]=[];
  const result=await generateWorldDraft('Generate payroll for two employees with complete time and enabled payment routes.',{provider:'gemini-argon',transport:transport((_url,init)=>{calls++;const request=JSON.parse(String(init.body));if(calls===1){assert.equal(Object.hasOwn(request.generationConfig,'responseSchema'),false);const embedded=JSON.parse(request.systemInstruction.parts[0].text.split('JSON Schema:\n')[1]);assert.deepEqual(embedded,z.toJSONSchema(scenarioSchema.omit({sourceContext:true}),{target:'draft-7'}));assert.equal((embedded as any).properties.sourceContext,undefined);assert.equal((embedded as any).properties.blueprint.properties.erp_configurations.items.properties.system.const,'sap-b1');assert.equal((embedded as any).properties.blueprint.properties.journal_registers.items.properties.accounting_system.const,'sage-intacct');}else{assert.deepEqual(request.generationConfig.responseSchema,argonResponseSchema(sourceContextSchema));assert.equal(request.systemInstruction.parts[0].text.includes('JSON Schema:\n'),false);}return reply(calls===1?payroll:contextFromRequest(init));}),onEvent:event=>{events.push(event);}});
  assert.equal(calls,2);assert.equal(result.provider,'gemini-argon');assert.equal(result.context_enriched,true);assert.equal(result.cost_usd,null);assert.equal((result.usage as any).promptTokenCount,2000);assert.equal(result.raw_usage.configuration.thoughtsTokenCount,500);
  const materialized=createWorld(result.scenario,'different-persisted-world'),plain=createWorld(payroll,'different-persisted-world');
  for(const field of ['bankTransactions','journals','accounts','payrollPolicies','payrollTimeRecords','operations','approvals'])assert.deepEqual(materialized[field],plain[field]);
  assert.equal(materialized.employees[0].display_name,'Colleague 1');assert.equal(materialized.employees[0].email,plain.employees[0].email);assert.equal(materialized.documents.at(-1).authority,'context-only');assert.equal(materialized.messages.at(-1).authority,'context-only');assert.equal(materialized.messages.at(-1).source_refs[0],'context-payroll-review');
  assert.ok(events.some(event=>event.type==='scenario.grounding.validated'&&event.saved_world_created===false));assert.ok(events.some(event=>event.type==='scenario.generation.completed'&&event.context.portable));
  if(!('stages' in result))assert.fail('Expected Argon stages');assert.deepEqual(result.stages.map(stage=>({name:stage.name,output_mode:stage.output_mode,strict_schema_sha256:stage.strict_schema_sha256})),[{name:'configuration',output_mode:'json',strict_schema_sha256:strictHash(scenarioSchema.omit({sourceContext:true}))},{name:'source_context',output_mode:'schema',strict_schema_sha256:strictHash(sourceContextSchema)}]);for(const stage of result.stages){const traces=events.filter(event=>event.stage===stage.name);assert.ok(traces.length>0);assert.ok(traces.every(event=>event.output_mode===stage.output_mode&&event.strict_schema_sha256===stage.strict_schema_sha256));}assert.deepEqual(events.find(event=>event.type==='scenario.generation.completed').stages,result.stages);
}));

test('Argon custom blueprint stage creates requested source payroll, preserves names and returns portable materialization metadata',async()=>configured(async()=>{
  const custom={...payroll,payrollControls:undefined,startingCashMinor:123456,blueprint:{version:1,opening_at:'2026-10-24T09:00:00.000Z',payroll_policy:{ref:'custom-policy',mode:'synthetic',name:'Custom explicit policy',employee_withholding_bps:1500,employer_tax_bps:500},employees:[{ref:'ava',name:'Ava Lin',hourly_rate_minor:3200,route_enabled:true,time_records:[{ref:'ava-time',period_start:'2026-10-01',period_end:'2026-10-15',minutes:2400}]},{ref:'eli',name:'Eli Shah',hourly_rate_minor:2700,route_enabled:true,time_records:[{ref:'eli-time',period_start:'2026-10-01',period_end:'2026-10-15',minutes:1800}]}]}};
  let calls=0;const result=await generateWorldDraft('Create explicit custom payroll for Ava and Eli, with source hourly rates and approved time.',{provider:'gemini-argon',transport:transport((_url,init)=>{calls++;if(calls===1)return reply(custom);const request=JSON.parse(String(init.body)),grounding=JSON.parse(request.contents[0].parts[0].text).canonical;assert.equal(grounding.blueprint_manifest.refs.ava.id,'bp-employee-ava');assert.equal(grounding.collections.employees[0].hourly_rate_minor,3200);assert.equal(grounding.collections.payrollTimeRecords[1].minutes,1800);const context=contextFromRequest(init);context.parties=[];return reply(context);})});
  assert.equal(calls,2);assert.equal(result.provider,'gemini-argon');if(!('materialization' in result))assert.fail('Expected Argon materialization metadata');assert.equal(result.materialization.source_mode,'blueprint');assert.equal(result.materialization.source_counts.employees,2);assert.match(result.materialization.canonical_state_sha256,/^[a-f0-9]{64}$/);
  const world=createWorld(result.scenario,'saved-custom-world');assert.equal(world.employees[0].display_name,'Ava Lin');assert.equal(world.employees[1].display_name,'Eli Shah');assert.equal(world.payrollRuns.length,0);assert.equal(world.operations.length,0);assert.equal(world.bankTransactions[0].amount_minor,123456);assert.equal(world.messages.at(-1).authority,'context-only');
  let invalidCalls=0;await assert.rejects(generateWorldDraft('Create exact custom source employees.',{transport:transport((_url,init)=>{invalidCalls++;return reply(invalidCalls===1?custom:contextFromRequest(init));})}),error=>error instanceof GeneratorError&&error.code==='invalid_generated_bundle'&&/cannot rename/.test(error.message));assert.equal(invalidCalls,2);
  let missingCashCalls=0;await assert.rejects(generateWorldDraft('Create an explicit custom source payroll.',{transport:transport(()=>{missingCashCalls++;return reply({...custom,startingCashMinor:undefined});})}));assert.equal(missingCashCalls,1,'Invalid economic source config stops before second paid context call');
}));

test('invalid configuration stops before context and hallucinated source references cannot become an accepted generated world',async()=>configured(async()=>{
  let calls=0;await assert.rejects(generateWorldDraft('Create a payroll company.',{provider:'gemini-argon',transport:transport(()=>{calls++;return reply({...payroll,orderCount:101});})}));assert.equal(calls,1);
  const at='2026-10-24T09:00:00.000Z';
  for(const [invalid,phase] of [[{...payroll,sourceContext:{parties:[],documents:[],messages:[]}},'schema'],[{...payroll,payrollControls:undefined,startingCashMinor:0,blueprint:{version:1,opening_at:at,service_bills:[{ref:'missing-contract-bill',contract_ref:'missing-contract',invoice_number:'BILL-1',amount_minor:100,issued_at:at,due_at:at,service_completed_at:at,completion_reference:'recorded-service'}]}},'domain']] as const){let count=0;const events:any[]=[];await assert.rejects(generateWorldDraft('Create exact source facts.',{transport:transport((_url,init)=>{count++;assert.equal(JSON.parse(String(init.body)).generationConfig.responseSchema,undefined);return reply(invalid);}),onEvent:event=>{events.push(event);}}),(e:any)=>e.code==='invalid_generated_bundle'&&e.details.phase===phase);assert.equal(count,1);assert.ok(!events.some(event=>event.stage==='source_context'||event.type==='scenario.grounding.validated'));}
  calls=0;await assert.rejects(generateWorldDraft('Create a payroll company.',{provider:'gemini-argon',transport:transport((_url,init)=>{calls++;const context=calls===2?contextFromRequest(init):undefined;if(context)context.documents[0]!.source_refs=['invented-payroll-time'];return reply(calls===1?payroll:context);})}),error=>error instanceof GeneratorError&&error.code==='invalid_generated_bundle'&&(error.details as any).phase==='domain');assert.equal(calls,2);
}));

test('HTTP generation exposes separate provider availability, keeps drafts unsaved and persists sanitized generation audit',async()=>configured(async()=>{
  const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=transport((_url,init)=>{calls++;return reply(calls===1?payroll:contextFromRequest(init));});
  const base='http://127.0.0.1:51891',service=await createService({database:':memory:',baseUrl:base,agentEnabled:false,deliveryIntervalMs:0});
  try{
    const home=await service.fetch(new Request(base)),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
    const call=(path:string,input?:any,authenticated=true)=>service.fetch(new Request(base+path,{method:input?'POST':'GET',headers:{...(authenticated?{Cookie:cookie}:{}),...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})}));
    const bootstrap=await (await call('/api/bootstrap')).json();assert.equal(bootstrap.agent.available,false);assert.equal(bootstrap.generator.available,true);assert.equal(bootstrap.generator.defaultProvider,'gemini-argon');
    const capabilities=await (await call('/api/capabilities')).json();assert.equal(capabilities.coverage.scenario_family_count,13);assert.equal(capabilities.coverage.shared_projection_count,49);assert.equal(capabilities.coverage.rest_subset_providers.length,14);assert.ok(capabilities.coverage.rest_subset_providers.includes('xero'));assert.equal(capabilities.treasury_fx.minor_unit_scales.KWD,3);assert.equal(capabilities.statutory_payroll.tax_year,2026);assert.ok(capabilities.statutory_payroll.excluded.includes('tax return filing'));assert.match(capabilities.generation.cost,/null/);
    assert.equal((await call('/api/generate',{prompt:'Create a payroll company.'},false)).status,403);assert.equal((await call('/api/generate',{prompt:'Create a payroll company.',provider:'invented-model'})).status,400);
    const response=await call('/api/generate',{prompt:'Create payroll; accidental credential AIza'+'g'.repeat(35)+' test-gemini-private-key.',provider:'gemini-argon'});assert.equal(response.status,200);const result=await response.json();assert.equal(result.provider,'gemini-argon');assert.equal(result.scenario.sourceContext.messages.length,1);assert.equal(calls,2);assert.equal(service.store.worlds().length,0);
    const saved=await call('/api/worlds',result.scenario);assert.equal(saved.status,201);const world=(await saved.json()).world;assert.equal(world.messages.at(-1).authority,'context-only');assert.equal(service.store.worlds().length,1);
    const log=JSON.stringify(service.store.events('_service',0,1000));assert.ok(log.includes('scenario.generation_trace'));for(const secret of ['test-gemini-private-key','test-private-project','PRIVATE_REASONING_NOT_FOR_AUDIT','AIza'+'g'.repeat(35)])assert.ok(!log.includes(secret));assert.ok(!log.includes('accidental credential'));assert.ok(log.includes('prompt_sha256'));assert.equal(service.store.verify('_service').valid,true);
  }finally{await service.close();globalThis.fetch=originalFetch;}
}));

test('closing the candidate service cancels an active generation and waits for its final audit before closing storage',async()=>configured(async()=>{
  const originalFetch=globalThis.fetch;let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});let calls=0;
  globalThis.fetch=transport((_url,init)=>{calls++;started();return new Promise((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});});
  const base='http://127.0.0.1:51892',service=await createService({database:':memory:',baseUrl:base,agentEnabled:false,deliveryIntervalMs:0});
  let auditAtClose:any[]=[];const closeStore=service.store.close.bind(service.store);service.store.close=()=>{auditAtClose=service.store.events('_service',0,1000);closeStore();};
  try{
    const home=await service.fetch(new Request(base)),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();const request=()=>new Request(base+'/api/generate',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({prompt:'Create a payroll company.',provider:'gemini-argon'})});
    const running=service.fetch(request()).then(async response=>({status:response.status,data:await response.json()})).catch(error=>({aborted:error?.name==='AbortError'}));await began;assert.equal((await service.fetch(request())).status,409);await service.close();const response=await running;
    // Closing the router may cancel its response stream, but provider shutdown
    // must finish and retain its terminal audit before storage is disposed.
    if('status' in response){assert.equal(response.status,409);assert.equal(response.data.error.code,'generation_cancelled');}else assert.equal(response.aborted,true);
    assert.equal(calls,1);assert.ok(auditAtClose.some(row=>row.type==='scenario.generation_trace'&&row.data.type==='generation.provider.failed'&&row.data.code==='generation_cancelled'));
  }finally{globalThis.fetch=originalFetch;}
}));


test('present but invalid Argon configuration cannot silently select Anthropic',async()=>configured(async()=>{
  assert.equal(defaultGeneratorProvider(),'gemini-argon');
  for(const [key,invalid] of [['GOOGLE_CLOUD_PROJECT','invalid/project'],['FINANCE_WORLD_ARGON_PRICING','{}']]){
    const before=process.env[key!];process.env[key!]=invalid;
    assert.equal(loadGeneratorConfig().configured,true);assert.equal(loadGeneratorConfig().available,false);assert.equal(defaultGeneratorProvider(),'gemini-argon');
    let calls=0;await assert.rejects(generateWorldDraft('Create a payroll company.',{transport:transport(()=>{calls++;return reply();})}),error=>error instanceof GeneratorError&&error.code==='generator_unavailable');assert.equal(calls,0);
    if(before===undefined)delete process.env[key!];else process.env[key!]=before;
  }
  process.env.GEMINI_API_KEY='';process.env.GOOGLE_CLOUD_PROJECT='';assert.equal(loadGeneratorConfig().configured,false);assert.equal(defaultGeneratorProvider(),'anthropic');
}));

test('cancellation after response callbacks, validation or completion cannot return an accepted Argon result',async()=>configured(async()=>{
  for(const boundary of ['generation.provider.request','generation.provider.response','validation','generation.provider.completed']){
    const abort=new AbortController(),events:any[]=[];let calls=0;
    await assert.rejects(generateArgon({...options(transport(()=>{calls++;return reply();})),signal:abort.signal,validate:input=>{if(boundary==='validation')abort.abort();return input;},onEvent:async event=>{events.push(event);await Promise.resolve();if(event.type===boundary)abort.abort();}}),error=>error instanceof GeneratorError&&error.code==='generation_cancelled');
    assert.equal(calls,boundary==='generation.provider.request'?0:1);assert.ok(events.some(event=>event.type==='generation.provider.failed'&&event.code==='generation_cancelled'));
    if(boundary==='generation.provider.response')assert.ok(!events.some(event=>event.type==='generation.provider.completed'));
  }
}));

test('world draft traces omit raw prompt credentials and final callback cancellation rejects the draft',async()=>configured(async()=>{
  const secret='AIza'+'x'.repeat(35),prompt='Create payroll; '+secret+' test-gemini-private-key',events:any[]=[];let calls=0;
  const abort=new AbortController();await assert.rejects(generateWorldDraft(prompt,{signal:abort.signal,transport:transport((_url,init)=>{calls++;return reply(calls===1?payroll:contextFromRequest(init));}),onEvent:async event=>{events.push(event);if(event.type==='scenario.generation.completed'){await Promise.resolve();abort.abort();}}}),error=>error instanceof GeneratorError&&error.code==='generation_cancelled');
  assert.equal(calls,2);const text=JSON.stringify(events);assert.ok(!text.includes(secret));assert.ok(!text.includes('test-gemini-private-key'));assert.ok(!text.includes('Create payroll;'));assert.equal(events[0].prompt_chars,prompt.length);assert.match(events[0].prompt_sha256,/^[a-f0-9]{64}$/);assert.equal(events.at(-1).type,'scenario.generation.failed');
}));


test('HTTP generation checks the explicitly selected provider even when the configured default is invalid',async()=>configured(async()=>{
  process.env.GOOGLE_CLOUD_PROJECT='invalid/project';const before=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='fake-offline-anthropic-key';
  const base='http://127.0.0.1:51893',service=await createService({database:':memory:',baseUrl:base,agentEnabled:false,deliveryIntervalMs:0});
  try{
    const home=await service.fetch(new Request(base)),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
    const bootstrap=await (await service.fetch(new Request(base+'/api/bootstrap',{headers:{Cookie:cookie}}))).json();assert.equal(bootstrap.generator.defaultProvider,'gemini-argon');assert.equal(bootstrap.generator.available,false);assert.equal(bootstrap.generator.providers.anthropic.available,true);
    const call=(provider?:string,signal?:AbortSignal)=>service.fetch(new Request(base+'/api/generate',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({prompt:'Generate a payroll company.',provider}),signal}));
    const missing=await call();assert.equal(missing.status,503);assert.match((await missing.json()).error.message,/GOOGLE_CLOUD_PROJECT/);
    // An already-cancelled request proves explicit Anthropic passes provider
    // selection, while preventing all SDK submission and provider billing.
    const abort=new AbortController();abort.abort();const explicit=await call('anthropic',abort.signal);assert.equal(explicit.status,409);assert.equal((await explicit.json()).error.code,'agent_cancelled');
  }finally{await service.close();if(before===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=before;}
}));

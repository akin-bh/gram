import {test,expect} from 'bun:test';
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
const strictHash=(schema:z.ZodType)=>new Bun.CryptoHasher('sha256').update(JSON.stringify(z.toJSONSchema(schema,{target:'draft-7'}))).digest('hex');

test('Argon configuration uses existing private credentials while exposing only availability and verified transport metadata',async()=>configured(()=>{
  const config=loadGeneratorConfig();expect(config.available).toBe(true);expect(config.model).toBe('gemini-4-argon');expect(config.location).toBe('global');expect(config.pricing).toBe('unknown');
  const text=JSON.stringify(config);expect(!text.includes('test-gemini-private-key')).toBeTruthy();expect(!text.includes('test-private-project')).toBeTruthy();
  process.env.GEMINI_API_KEY='';expect(loadGeneratorConfig().available).toBe(false);delete process.env.GEMINI_API_KEY;
  process.env.GOOGLE_CLOUD_PROJECT='malicious/project?query';expect(loadGeneratorConfig().available).toBe(false);delete process.env.GOOGLE_CLOUD_PROJECT;
  process.env.FINANCE_WORLD_ARGON_PRICING='{"inputUsdPerMillion":2}';expect(loadGeneratorConfig().available).toBe(false);
}));

test('Argon sends the authoritative Vertex request and returns strictly validated visible output without thoughts or secrets',async()=>configured(async()=>{
  const events:any[]=[];let calls=0;
  const result=await generateArgon({...options(transport((url,init)=>{
    calls++;expect(url).toBe('https://aiplatform.googleapis.com/v1/projects/test-private-project/locations/global/publishers/google/models/gemini-4-argon:generateContent');expect(new Headers(init.headers).get('x-goog-api-key')).toBe('test-gemini-private-key');expect(init.redirect).toBe('manual');
    const body=JSON.parse(String(init.body));expect(body.generationConfig.responseMimeType).toBe('application/json');expect(body.generationConfig.maxOutputTokens).toBe(16384);expect(body.generationConfig.thinkingConfig).toStrictEqual({thinkingLevel:'MEDIUM'});expect(body.generationConfig.responseSchema.type).toBe('OBJECT');expect(body.generationConfig.responseSchema.properties.amount_minor.type).toBe('INTEGER');
    for(const forbidden of ['candidateCount','temperature','tools','thinkingBudget'])expect(body[forbidden]??body.generationConfig[forbidden]).toBeUndefined();
    return reply();
  })),onEvent:event=>{events.push(event);},validate:input=>({...input,name:'Validated '+input.name})});
  expect(calls).toBe(1);expect(result.value.name).toBe('Validated Payroll');expect(result.model).toBe('gemini-4-argon');expect(result.cost_usd).toBeNull();expect(result.pricing_status).toBe('unknown');expect(result.usage.thoughtsTokenCount).toBe(500);expect(result.attempts.length).toBe(1);
  expect(result.output_mode).toBe('schema');expect(result.strict_schema_sha256).toBe(strictHash(schema));expect(events.every(event=>event.output_mode==='schema'&&event.strict_schema_sha256===strictHash(schema))).toBeTruthy();
  const retained=JSON.stringify({result,events});for(const secret of ['test-gemini-private-key','test-private-project','PRIVATE_REASONING_NOT_FOR_AUDIT','PRIVATE_SIGNATURE'])expect(!retained.includes(secret)).toBeTruthy();expect(events.some(event=>event.type==='generation.provider.completed')).toBeTruthy();
}));

test('explicit JSON mode sends the complete original strict schema only in the prompt and retains identical host validation and audit metadata',async()=>configured(async()=>{
 const events:any[]=[];let calls=0,validated=0;
 const result=await generateArgon({...options(transport((_url,init)=>{calls++;const body=JSON.parse(String(init.body));expect(body.generationConfig.responseMimeType).toBe('application/json');expect(Object.hasOwn(body.generationConfig,'responseSchema')).toBe(false);expect(body.generationConfig.thinkingConfig).toStrictEqual({thinkingLevel:'MEDIUM'});const embedded=JSON.parse(body.systemInstruction.parts[0].text.split('JSON Schema:\n')[1]);expect(embedded).toStrictEqual(z.toJSONSchema(schema,{target:'draft-7'}));expect(embedded.additionalProperties).toBe(false);expect((embedded as any).properties.amount_minor.type).toBe('integer');expect((embedded as any).properties.amount_minor.exclusiveMinimum).toBe(0);return reply();})),outputMode:'json',validate:input=>{validated++;return {...input,name:'Validated '+input.name};},onEvent:event=>{events.push(event);}});
 expect(calls).toBe(1);expect(validated).toBe(1);expect(result.value.name).toBe('Validated Payroll');expect(result.output_mode).toBe('json');expect(result.strict_schema_sha256).toBe(strictHash(schema));expect(events.length>0).toBeTruthy();expect(events.every(event=>event.output_mode==='json'&&event.strict_schema_sha256===strictHash(schema))).toBeTruthy();expect(result.cost_usd).toBeNull();
 let invalidCalls=0;await expect(generateArgon({...options(transport(()=>{invalidCalls++;return reply();})),outputMode:'auto' as any})).rejects.toThrowSatisfying((e:any)=>e.code==='invalid_generation_options');expect(invalidCalls).toBe(0);
}));

test('JSON mode rejects malformed JSON, unknown fields, numeric bounds and domain failures with one call and no fallback',async()=>configured(async()=>{
 for(const text of ['{"name":','```json\n'+JSON.stringify(value)+'\n```',JSON.stringify({...value,untrustedAuthority:true}),JSON.stringify({...value,amount_minor:-1}),JSON.stringify({...value,amount_minor:1.5})]){let calls=0,validation=0;const events:any[]=[];await expect(generateArgon({...options(transport((_url,init)=>{calls++;expect(JSON.parse(String(init.body)).generationConfig.responseSchema).toBeUndefined();return reply(undefined,{candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]});})),outputMode:'json',validate:input=>{validation++;return input;},onEvent:event=>{events.push(event);}})).rejects.toThrowSatisfying((e:any)=>e.code==='invalid_generated_bundle'&&['json','schema'].includes(e.details.phase));expect(calls).toBe(1);expect(validation).toBe(0);expect(events.every(event=>event.output_mode==='json'&&event.strict_schema_sha256===strictHash(schema))).toBeTruthy();expect(!events.some(event=>event.type==='generation.provider.completed')).toBeTruthy();}
 let calls=0;await expect(generateArgon({...options(transport(()=>{calls++;return reply();})),outputMode:'json',validate:()=>{throw Object.assign(new Error('Source references cannot materialize'),{code:'source_missing'});}})).rejects.toThrowSatisfying((e:any)=>e.code==='invalid_generated_bundle'&&e.details.phase==='domain'&&e.details.code==='source_missing');expect(calls).toBe(1);
}));

test('cost accounting preserves cached input and billed thinking and never invents dollar pricing',()=>{
  const usage={promptTokenCount:1000,cachedContentTokenCount:200,candidatesTokenCount:300,thoughtsTokenCount:500},pricing={inputUsdPerMillion:2,cachedInputUsdPerMillion:0.1,outputUsdPerMillion:8,source:'verified-test-tariff'};
  expect(argonUsageCost(usage).cost_usd).toBeNull();const cost=argonUsageCost(usage,pricing);expect(cost.cost_usd).toBe(0.00802);expect(cost.pricing_status).toBe('estimated');expect(cost.billable_output_tokens).toBe(800);expect(cost.cached_input_tokens).toBe(200);
  expect(argonUsageCost({promptTokenCount:2,candidatesTokenCount:1,cachedContentTokenCount:3},pricing).cost_usd).toBeNull();expect(argonUsageCost({},pricing).cost_usd).toBeNull();
});

test('explicit rate-limit or unavailable responses retry the exact body at most twice while redirects and other errors never retry',async()=>configured(async()=>{
  const requests:string[]=[],waits:number[]=[];let calls=0;
  const result=await generateArgon({...options(transport((_url,init)=>{requests.push(String(init.body));calls++;return calls<3?new Response('temporary rejection',{status:calls===1?429:503,headers:{'Retry-After':'0'}}):reply();})),sleep:async ms=>{waits.push(ms);}});
  expect(calls).toBe(3);expect(new Set(requests).size).toBe(1);expect(waits).toStrictEqual([0,0]);expect(result.attempts.map(attempt=>attempt.status)).toStrictEqual([429,503,200]);
  for(const status of [302,400,401,403,500]){let count=0;await expect(generateArgon(options(transport(()=>{count++;return new Response('Echo test-gemini-private-key test-private-project',{status,headers:{Location:'https://attacker.invalid'}});})))).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='generation_provider_rejected'&&!JSON.stringify(error.details).includes('test-gemini-private-key')&&!JSON.stringify(error.details).includes('test-private-project'));expect(count).toBe(1);}
  let exhausted=0;await expect(generateArgon({...options(transport(()=>{exhausted++;return new Response('busy',{status:503});})),sleep:async()=>{}})).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='generation_provider_rejected');expect(exhausted).toBe(3);
}));

test('transport uncertainty, request timeout and cancellation cannot create an automatic second paid call',async()=>configured(async()=>{
  let calls=0;await expect(generateArgon(options(transport(()=>{calls++;throw new TypeError('network lost test-gemini-private-key');})))).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='generation_transport_uncertain'&&(error.details as any).remote_completion_uncertain);expect(calls).toBe(1);
  calls=0;const hanging=transport((_url,init)=>{calls++;return new Promise((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});});
  await expect(generateArgon({...options(hanging),timeoutMs:5})).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='generation_timeout');expect(calls).toBe(1);
  const abort=new AbortController();abort.abort();await expect(generateArgon({...options(hanging),signal:abort.signal})).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='generation_cancelled');expect(calls).toBe(1);
}));

test('strict schema, engine rejection, truncated output and oversized bodies fail without replacement output or extra requests',async()=>configured(async()=>{
  for(const output of [{...value,untrustedAuthority:true},{...value,amount_minor:-1}]){let calls=0;await expect(generateArgon(options(transport(()=>{calls++;return reply(output);})))).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='invalid_generated_bundle'&&(error.details as any).phase==='schema');expect(calls).toBe(1);}
  await expect(generateArgon({...options(transport(()=>reply())),validate:()=>{throw Object.assign(new Error('Amounts cannot materialize'),{code:'domain-constraint'});}})).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&(error.details as any).phase==='domain'&&(error.details as any).code==='domain-constraint');
  for(const finishReason of ['MAX_TOKENS','CONTINUATION','SAFETY'])await expect(generateArgon(options(transport(()=>reply(value,{candidates:[{finishReason,content:{parts:[{text:JSON.stringify(value)}]}}]}))))).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='incomplete_generation');
  await expect(generateArgon(options(transport(()=>new Response('x'.repeat(4*1024*1024+1)))))).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='generation_response_too_large');
}));

test('transport schema supports nullable objects while local strict parsing retains omitted provider restrictions',()=>{
  const converted=argonResponseSchema(z.object({note:z.string().nullable(),mode:z.literal('synthetic'),entries:z.array(z.object({id:z.string()}).strict()).max(5)}).strict()) as any;
  expect(converted.properties.note.type).toBe('STRING');expect(converted.properties.note.nullable).toBe(true);expect(converted.properties.mode.enum).toStrictEqual(['synthetic']);expect(converted.properties.entries.maxItems).toBeUndefined();expect(converted.propertyOrdering).toStrictEqual(['note','mode','entries']);expect(converted.additionalProperties).toBeUndefined();
  expect(sanitizeGenerationEvent({parts:[{thought:true,text:'hidden'},{text:'visible'}],thoughtSignature:'hidden',usage:{thoughtsTokenCount:12},'x-goog-api-key':'hidden'})).toStrictEqual({parts:[{text:'visible'}],usage:{thoughtsTokenCount:12},'x-goog-api-key':'[REDACTED]'});
  const literals=z.object({version:z.literal(1),tax_year:z.literal(2026),flag:z.literal(false)}).strict(),wire=argonResponseSchema(literals) as any;
  expect(wire.properties.version.type).toBe('NUMBER');expect(wire.properties.version.enum).toBeUndefined();expect(wire.properties.tax_year.enum).toBeUndefined();expect(wire.properties.flag.type).toBe('BOOLEAN');expect(wire.properties.flag.enum).toBeUndefined();expect(literals.safeParse({version:2,tax_year:2026,flag:false}).success).toBe(false);
  const scenarioWire=argonResponseSchema(scenarioSchema.omit({sourceContext:true})) as any,policy=scenarioWire.properties.blueprint.properties.payroll_policy;
  expect(policy.anyOf.length).toBe(2);expect(policy.anyOf.map((branch:any)=>branch.properties.mode.enum)).toStrictEqual([['synthetic'],['us-federal-2026']]);expect(policy.anyOf.every((branch:any)=>branch.required.includes('mode'))).toBeTruthy();expect(policy.anyOf[0].required.includes('employee_withholding_bps')).toBeTruthy();expect(policy.anyOf[1].required.includes('tax_year')).toBeTruthy();expect(policy.oneOf).toBeUndefined();
});

test('rejected completed candidates retain bounded sanitized evidence without a replacement paid request',async()=>configured(async()=>{
  const events:any[]=[];let calls=0;
  await expect(generateArgon({...options(transport(()=>{calls++;return reply({...value,name:'test-gemini-private-key',amount_minor:-1});})),onEvent:event=>{events.push(event);}})).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='invalid_generated_bundle');
  expect(calls).toBe(1);const rejection=events.find(event=>event.type==='generation.provider.candidate_rejected');expect(rejection.phase).toBe('schema');expect(rejection.candidate.amount_minor).toBe(-1);expect(rejection.candidate.name).toBe('[REDACTED]');expect(rejection.candidate_sha256).toMatch(/^[a-f0-9]{64}$/);expect(!JSON.stringify(events).includes('test-gemini-private-key')).toBeTruthy();
  events.length=0;await expect(generateArgon({...options(transport(()=>reply({...value,name:'x'.repeat(300*1024),amount_minor:-1}))),onEvent:event=>{events.push(event);}})).rejects.toThrow();const bounded=events.find(event=>event.type==='generation.provider.candidate_rejected');expect(bounded.candidate).toBeUndefined();expect(bounded.candidate_omitted).toMatch(/256 KiB/);expect(bounded.candidate_bytes>256*1024).toBeTruthy();
}));

const payroll={kind:'payroll-close',name:'Payroll',description:'Prepare two employees using recorded time and an explicit synthetic policy.',seed:42,orderCount:2,currency:'USD',cancelEvent:false,initialFaults:[],limitations:['Synthetic normalized provider subsets; not statutory payroll.'],payrollControls:{missingTime:false,disabledRoute:false,employeeWithholdingBps:2000,employerTaxBps:765,periodClosed:false}};
function contextFromRequest(init:RequestInit){
  const request=JSON.parse(String(init.body)),grounding=JSON.parse(request.contents[0].parts[0].text).canonical;
  expect(grounding.summary.id).toBeUndefined();expect(grounding.collections.generationHistory).toBeUndefined();expect(grounding.collections.employees.length).toBe(2);
  const employees=grounding.collections.employees,policy=grounding.collections.payrollPolicies[0],times=grounding.collections.payrollTimeRecords;
  return {parties:employees.map((employee:any,index:number)=>({collection:'employees',id:employee.id,name:`Colleague ${index+1}`,email:employee.email})),documents:[{id:'context-payroll-review',name:'Payroll source review',body:`Prepare the two recorded employees using policy ${policy.id}. Wage execution and tax remittance still need separate approval.`,source_refs:[policy.id,...times.map((row:any)=>row.id)]}],messages:[{from:'hr@company.simulation.test',to:['finance@simulation.test'],subject:'Prepare recorded payroll',body:'Please calculate payroll from the linked time and policy records, then request independent wage approval. No wage payment has been completed.',source_refs:['context-payroll-review',...employees.map((row:any)=>row.id)]}]};
}
test('two Argon stages ground context in actual deterministic records and return a portable materializable scenario',async()=>configured(async()=>{
  let calls=0;const events:any[]=[];
  const result=await generateWorldDraft('Generate payroll for two employees with complete time and enabled payment routes.',{provider:'gemini-argon',transport:transport((_url,init)=>{calls++;const request=JSON.parse(String(init.body));if(calls===1){expect(Object.hasOwn(request.generationConfig,'responseSchema')).toBe(false);const embedded=JSON.parse(request.systemInstruction.parts[0].text.split('JSON Schema:\n')[1]);expect(embedded).toStrictEqual(z.toJSONSchema(scenarioSchema.omit({sourceContext:true}),{target:'draft-7'}));expect((embedded as any).properties.sourceContext).toBeUndefined();expect((embedded as any).properties.blueprint.properties.erp_configurations.items.properties.system.const).toBe('sap-b1');expect((embedded as any).properties.blueprint.properties.journal_registers.items.properties.accounting_system.const).toBe('sage-intacct');}else{expect(request.generationConfig.responseSchema).toStrictEqual(argonResponseSchema(sourceContextSchema));expect(request.systemInstruction.parts[0].text.includes('JSON Schema:\n')).toBe(false);}return reply(calls===1?payroll:contextFromRequest(init));}),onEvent:event=>{events.push(event);}});
  expect(calls).toBe(2);expect(result.provider).toBe('gemini-argon');expect(result.context_enriched).toBe(true);expect(result.cost_usd).toBeNull();expect((result.usage as any).promptTokenCount).toBe(2000);expect((result.raw_usage as any).configuration.thoughtsTokenCount).toBe(500);
  const materialized=createWorld(result.scenario,'different-persisted-world'),plain=createWorld(payroll,'different-persisted-world');
  for(const field of ['bankTransactions','journals','accounts','payrollPolicies','payrollTimeRecords','operations','approvals'])expect(materialized[field]).toStrictEqual(plain[field]);
  expect(materialized.employees[0].display_name).toBe('Colleague 1');expect(materialized.employees[0].email).toBe(plain.employees[0].email);expect(materialized.documents.at(-1).authority).toBe('context-only');expect(materialized.messages.at(-1).authority).toBe('context-only');expect(materialized.messages.at(-1).source_refs[0]).toBe('context-payroll-review');
  expect(events.some(event=>event.type==='scenario.grounding.validated'&&event.saved_world_created===false)).toBeTruthy();expect(events.some(event=>event.type==='scenario.generation.completed'&&event.context.portable)).toBeTruthy();
  if(!('stages' in result))expect.unreachable('Expected Argon stages');expect(result.stages.map(stage=>({name:stage.name,output_mode:stage.output_mode,strict_schema_sha256:stage.strict_schema_sha256}))).toStrictEqual([{name:'configuration',output_mode:'json',strict_schema_sha256:strictHash(scenarioSchema.omit({sourceContext:true}))},{name:'source_context',output_mode:'schema',strict_schema_sha256:strictHash(sourceContextSchema)}]);for(const stage of result.stages){const traces=events.filter(event=>event.stage===stage.name);expect(traces.length>0).toBeTruthy();expect(traces.every(event=>event.output_mode===stage.output_mode&&event.strict_schema_sha256===stage.strict_schema_sha256)).toBeTruthy();}expect(events.find(event=>event.type==='scenario.generation.completed').stages).toStrictEqual(result.stages);
}));

test('Argon custom blueprint stage creates requested source payroll, preserves names and returns portable materialization metadata',async()=>configured(async()=>{
  const custom={...payroll,payrollControls:undefined,startingCashMinor:123456,blueprint:{version:1,opening_at:'2026-10-24T09:00:00.000Z',payroll_policy:{ref:'custom-policy',mode:'synthetic',name:'Custom explicit policy',employee_withholding_bps:1500,employer_tax_bps:500},employees:[{ref:'ava',name:'Ava Lin',hourly_rate_minor:3200,route_enabled:true,time_records:[{ref:'ava-time',period_start:'2026-10-01',period_end:'2026-10-15',minutes:2400}]},{ref:'eli',name:'Eli Shah',hourly_rate_minor:2700,route_enabled:true,time_records:[{ref:'eli-time',period_start:'2026-10-01',period_end:'2026-10-15',minutes:1800}]}]}};
  let calls=0;const result=await generateWorldDraft('Create explicit custom payroll for Ava and Eli, with source hourly rates and approved time.',{provider:'gemini-argon',transport:transport((_url,init)=>{calls++;if(calls===1)return reply(custom);const request=JSON.parse(String(init.body)),grounding=JSON.parse(request.contents[0].parts[0].text).canonical;expect(grounding.blueprint_manifest.refs.ava.id).toBe('bp-employee-ava');expect(grounding.collections.employees[0].hourly_rate_minor).toBe(3200);expect(grounding.collections.payrollTimeRecords[1].minutes).toBe(1800);const context=contextFromRequest(init);context.parties=[];return reply(context);})});
  expect(calls).toBe(2);expect(result.provider).toBe('gemini-argon');if(!('materialization' in result))expect.unreachable('Expected Argon materialization metadata');expect(result.materialization.source_mode).toBe('blueprint');expect(result.materialization.source_counts.employees).toBe(2);expect(result.materialization.canonical_state_sha256).toMatch(/^[a-f0-9]{64}$/);
  const world=createWorld(result.scenario,'saved-custom-world');expect(world.employees[0].display_name).toBe('Ava Lin');expect(world.employees[1].display_name).toBe('Eli Shah');expect(world.payrollRuns.length).toBe(0);expect(world.operations.length).toBe(0);expect(world.bankTransactions[0].amount_minor).toBe(123456);expect(world.messages.at(-1).authority).toBe('context-only');
  let invalidCalls=0;await expect(generateWorldDraft('Create exact custom source employees.',{transport:transport((_url,init)=>{invalidCalls++;return reply(invalidCalls===1?custom:contextFromRequest(init));})})).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='invalid_generated_bundle'&&/cannot rename/.test(error.message));expect(invalidCalls).toBe(2);
  let missingCashCalls=0;await expect(generateWorldDraft('Create an explicit custom source payroll.',{transport:transport(()=>{missingCashCalls++;return reply({...custom,startingCashMinor:undefined});})})).rejects.toThrow();expect(missingCashCalls,'Invalid economic source config stops before second paid context call').toBe(1);
}));

test('invalid configuration stops before context and hallucinated source references cannot become an accepted generated world',async()=>configured(async()=>{
  let calls=0;await expect(generateWorldDraft('Create a payroll company.',{provider:'gemini-argon',transport:transport(()=>{calls++;return reply({...payroll,orderCount:101});})})).rejects.toThrow();expect(calls).toBe(1);
  const at='2026-10-24T09:00:00.000Z';
  for(const [invalid,phase] of [[{...payroll,sourceContext:{parties:[],documents:[],messages:[]}},'schema'],[{...payroll,payrollControls:undefined,startingCashMinor:0,blueprint:{version:1,opening_at:at,service_bills:[{ref:'missing-contract-bill',contract_ref:'missing-contract',invoice_number:'BILL-1',amount_minor:100,issued_at:at,due_at:at,service_completed_at:at,completion_reference:'recorded-service'}]}},'domain']] as const){let count=0;const events:any[]=[];await expect(generateWorldDraft('Create exact source facts.',{transport:transport((_url,init)=>{count++;expect(JSON.parse(String(init.body)).generationConfig.responseSchema).toBeUndefined();return reply(invalid);}),onEvent:event=>{events.push(event);}})).rejects.toThrowSatisfying((e:any)=>e.code==='invalid_generated_bundle'&&e.details.phase===phase);expect(count).toBe(1);expect(!events.some(event=>event.stage==='source_context'||event.type==='scenario.grounding.validated')).toBeTruthy();}
  calls=0;await expect(generateWorldDraft('Create a payroll company.',{provider:'gemini-argon',transport:transport((_url,init)=>{calls++;const context=calls===2?contextFromRequest(init):undefined;if(context)context.documents[0]!.source_refs=['invented-payroll-time'];return reply(calls===1?payroll:context);})})).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='invalid_generated_bundle'&&(error.details as any).phase==='domain');expect(calls).toBe(2);
}));

test('HTTP generation exposes separate provider availability, keeps drafts unsaved and persists sanitized generation audit',async()=>configured(async()=>{
  const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=transport((_url,init)=>{calls++;return reply(calls===1?payroll:contextFromRequest(init));});
  const base='http://127.0.0.1:51891',service=await createService({database:':memory:',baseUrl:base,agentEnabled:false,deliveryIntervalMs:0});
  try{
    const home=await service.fetch(new Request(base)),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
    const call=(path:string,input?:any,authenticated=true)=>service.fetch(new Request(base+path,{method:input?'POST':'GET',headers:{...(authenticated?{Cookie:cookie}:{}),...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})}));
    const bootstrap=await (await call('/api/bootstrap')).json();expect(bootstrap.agent.available).toBe(false);expect(bootstrap.generator.available).toBe(true);expect(bootstrap.generator.defaultProvider).toBe('gemini-argon');
    const capabilities=await (await call('/api/capabilities')).json();expect(capabilities.coverage.scenario_family_count).toBe(15);expect(capabilities.coverage.shared_projection_count).toBe(49);expect(capabilities.coverage.rest_subset_providers.length).toBe(14);expect(capabilities.coverage.rest_subset_providers.includes('xero')).toBeTruthy();expect(capabilities.treasury_fx.minor_unit_scales.KWD).toBe(3);expect(capabilities.statutory_payroll.tax_year).toBe(2026);expect(capabilities.statutory_payroll.excluded.includes('tax return filing')).toBeTruthy();expect(capabilities.generation.cost).toMatch(/null/);
    expect((await call('/api/generate',{prompt:'Create a payroll company.'},false)).status).toBe(403);expect((await call('/api/generate',{prompt:'Create a payroll company.',provider:'invented-model'})).status).toBe(400);
    const response=await call('/api/generate',{prompt:'Create payroll; accidental credential AIza'+'g'.repeat(35)+' test-gemini-private-key.',provider:'gemini-argon'});expect(response.status).toBe(200);const result=await response.json();expect(result.provider).toBe('gemini-argon');expect(result.scenario.sourceContext.messages.length).toBe(1);expect(calls).toBe(2);expect(service.store.worlds().length).toBe(0);
    const saved=await call('/api/worlds',result.scenario);expect(saved.status).toBe(201);const world=(await saved.json()).world;expect(world.messages.at(-1).authority).toBe('context-only');expect(service.store.worlds().length).toBe(1);
    const log=JSON.stringify(service.store.events('_service',0,1000));expect(log.includes('scenario.generation_trace')).toBeTruthy();for(const secret of ['test-gemini-private-key','test-private-project','PRIVATE_REASONING_NOT_FOR_AUDIT','AIza'+'g'.repeat(35)])expect(!log.includes(secret)).toBeTruthy();expect(!log.includes('accidental credential')).toBeTruthy();expect(log.includes('prompt_sha256')).toBeTruthy();expect(service.store.verify('_service').valid).toBe(true);
  }finally{await service.close();globalThis.fetch=originalFetch;}
}));

test('closing the candidate service cancels an active generation and waits for its final audit before closing storage',async()=>configured(async()=>{
  const originalFetch=globalThis.fetch;let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});let calls=0;
  globalThis.fetch=transport((_url,init)=>{calls++;started();return new Promise((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});});
  const base='http://127.0.0.1:51892',service=await createService({database:':memory:',baseUrl:base,agentEnabled:false,deliveryIntervalMs:0});
  let auditAtClose:any[]=[];const closeStore=service.store.close.bind(service.store);service.store.close=()=>{auditAtClose=service.store.events('_service',0,1000);closeStore();};
  try{
    const home=await service.fetch(new Request(base)),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();const request=()=>new Request(base+'/api/generate',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({prompt:'Create a payroll company.',provider:'gemini-argon'})});
    const running=service.fetch(request()).then(async response=>({status:response.status,data:await response.json()})).catch(error=>({aborted:error?.name==='AbortError'}));await began;expect((await service.fetch(request())).status).toBe(409);await service.close();const response=await running;
    // Closing the router may cancel its response stream, but provider shutdown
    // must finish and retain its terminal audit before storage is disposed.
    if('status' in response){expect(response.status).toBe(409);expect(response.data.error.code).toBe('generation_cancelled');}else expect(response.aborted).toBe(true);
    expect(calls).toBe(1);expect(auditAtClose.some(row=>row.type==='scenario.generation_trace'&&row.data.type==='generation.provider.failed'&&row.data.code==='generation_cancelled')).toBeTruthy();
  }finally{globalThis.fetch=originalFetch;}
}));


test('present but invalid Argon configuration cannot silently select Anthropic',async()=>configured(async()=>{
  expect(defaultGeneratorProvider()).toBe('gemini-argon');
  for(const [key,invalid] of [['GOOGLE_CLOUD_PROJECT','invalid/project'],['FINANCE_WORLD_ARGON_PRICING','{}']]){
    const before=process.env[key!];process.env[key!]=invalid;
    expect(loadGeneratorConfig().configured).toBe(true);expect(loadGeneratorConfig().available).toBe(false);expect(defaultGeneratorProvider()).toBe('gemini-argon');
    let calls=0;await expect(generateWorldDraft('Create a payroll company.',{transport:transport(()=>{calls++;return reply();})})).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='generator_unavailable');expect(calls).toBe(0);
    if(before===undefined)delete process.env[key!];else process.env[key!]=before;
  }
  process.env.GEMINI_API_KEY='';process.env.GOOGLE_CLOUD_PROJECT='';expect(loadGeneratorConfig().configured).toBe(false);expect(defaultGeneratorProvider()).toBe('anthropic');
}));

test('cancellation after response callbacks, validation or completion cannot return an accepted Argon result',async()=>configured(async()=>{
  for(const boundary of ['generation.provider.request','generation.provider.response','validation','generation.provider.completed']){
    const abort=new AbortController(),events:any[]=[];let calls=0;
    await expect(generateArgon({...options(transport(()=>{calls++;return reply();})),signal:abort.signal,validate:input=>{if(boundary==='validation')abort.abort();return input;},onEvent:async event=>{events.push(event);await Promise.resolve();if(event.type===boundary)abort.abort();}})).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='generation_cancelled');
    expect(calls).toBe(boundary==='generation.provider.request'?0:1);expect(events.some(event=>event.type==='generation.provider.failed'&&event.code==='generation_cancelled')).toBeTruthy();
    if(boundary==='generation.provider.response')expect(!events.some(event=>event.type==='generation.provider.completed')).toBeTruthy();
  }
}));

test('world draft traces omit raw prompt credentials and final callback cancellation rejects the draft',async()=>configured(async()=>{
  const secret='AIza'+'x'.repeat(35),prompt='Create payroll; '+secret+' test-gemini-private-key',events:any[]=[];let calls=0;
  const abort=new AbortController();await expect(generateWorldDraft(prompt,{signal:abort.signal,transport:transport((_url,init)=>{calls++;return reply(calls===1?payroll:contextFromRequest(init));}),onEvent:async event=>{events.push(event);if(event.type==='scenario.generation.completed'){await Promise.resolve();abort.abort();}}})).rejects.toThrowSatisfying(error=>error instanceof GeneratorError&&error.code==='generation_cancelled');
  expect(calls).toBe(2);const text=JSON.stringify(events);expect(!text.includes(secret)).toBeTruthy();expect(!text.includes('test-gemini-private-key')).toBeTruthy();expect(!text.includes('Create payroll;')).toBeTruthy();expect(events[0].prompt_chars).toBe(prompt.length);expect(events[0].prompt_sha256).toMatch(/^[a-f0-9]{64}$/);expect(events.at(-1).type).toBe('scenario.generation.failed');
}));


test('HTTP generation checks the explicitly selected provider even when the configured default is invalid',async()=>configured(async()=>{
  process.env.GOOGLE_CLOUD_PROJECT='invalid/project';const before=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='fake-offline-anthropic-key';
  const base='http://127.0.0.1:51893',service=await createService({database:':memory:',baseUrl:base,agentEnabled:false,deliveryIntervalMs:0});
  try{
    const home=await service.fetch(new Request(base)),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
    const bootstrap=await (await service.fetch(new Request(base+'/api/bootstrap',{headers:{Cookie:cookie}}))).json();expect(bootstrap.generator.defaultProvider).toBe('gemini-argon');expect(bootstrap.generator.available).toBe(false);expect(bootstrap.generator.providers.anthropic.available).toBe(true);
    const call=(provider?:string,signal?:AbortSignal)=>service.fetch(new Request(base+'/api/generate',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({prompt:'Generate a payroll company.',provider}),signal}));
    const missing=await call();expect(missing.status).toBe(503);expect((await missing.json()).error.message).toMatch(/GOOGLE_CLOUD_PROJECT/);
    // An already-cancelled request proves explicit Anthropic passes provider
    // selection, while preventing all SDK submission and provider billing.
    const abort=new AbortController();abort.abort();const explicit=await call('anthropic',abort.signal);expect(explicit.status).toBe(409);expect((await explicit.json()).error.code).toBe('agent_cancelled');
  }finally{await service.close();if(before===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=before;}
}));

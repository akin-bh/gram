import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {Store,redact,hash} from './store.ts';
import {createService} from './server.ts';

const google='AIzaSYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL_123',anthropic='sk-ant-SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL';
test('audit redacts Google and Anthropic key-shaped strings at every depth and provider-labelled credential fields',()=>{
  const payload={prompt:`Use a synthetic world. Google ${google}; Anthropic ${anthropic}`,nested:[{message:`prefix ${google} suffix`,GEMINI_API_KEY:'arbitrary-provider-secret',ANTHROPIC_API_KEY:'arbitrary-anthropic-secret','x-goog-api-key':'arbitrary-header-secret',apiKey:'camel-case-secret',clientSecret:'client-secret-value',accessToken:'access-token-value',refresh_token:'refresh-token-value'}],ordinary:{seed:1234,amount_minor:9876,company:'Inventory'}};
  const result=redact(payload),encoded=JSON.stringify(result);for(const secret of [google,anthropic,'arbitrary-provider-secret','arbitrary-anthropic-secret','arbitrary-header-secret','camel-case-secret','client-secret-value','access-token-value','refresh-token-value'])assert.ok(!encoded.includes(secret));assert.equal(result.ordinary.amount_minor,9876);assert.equal(result.ordinary.company,'Inventory');assert.ok(payload.prompt.includes(google));
  const store=new Store(':memory:');try{store.audit('redaction-world','generation.prompt',payload);const event=store.events('redaction-world',0,100)[0];assert.deepEqual(event.data,result);assert.equal(store.verify('redaction-world').valid,true);assert.ok(!JSON.stringify(event).includes(google));}finally{store.close();}
});

test('HTTP generation request auditing retains only prompt digest and length before provider submission',async()=>{
  const names=['FINANCE_WORLD_ENV_FILE','GEMINI_API_KEY','GOOGLE_CLOUD_PROJECT','FINANCE_WORLD_ARGON_PRICING','ANTHROPIC_API_KEY'],before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  // Explicit synthetic environment prevents this test from reading real keys.
  process.env.FINANCE_WORLD_ENV_FILE='/nonexistent/synthetic-redaction-test.env';process.env.GEMINI_API_KEY=google;process.env.GOOGLE_CLOUD_PROJECT='synthetic-redaction-project';process.env.ANTHROPIC_API_KEY='';delete process.env.FINANCE_WORLD_ARGON_PRICING;
  const base='http://127.0.0.1:51973',prompt=`Prepare synthetic payroll with ${google} and ${anthropic}`;let service:Awaited<ReturnType<typeof createService>>|undefined;
  try{service=await createService({database:':memory:',baseUrl:base,agentEnabled:false,deliveryIntervalMs:0});const home=await service.fetch(new Request(base)),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();const response=await service.fetch(new Request(base+'/api/generate',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({provider:'unsupported-no-network',prompt})}));assert.equal(response.status,400);await response.text();const records=service.store.events('_service',0,1000),http=records.find(row=>row.type==='http.request'&&row.data.path==='/api/generate');assert.ok(http);assert.equal(http.data.body.prompt,undefined);assert.equal(http.data.body.prompt_sha256,hash(prompt));assert.equal(http.data.body.prompt_chars,prompt.length);assert.ok(!JSON.stringify(records).includes(prompt));assert.ok(!JSON.stringify(records).includes(google));assert.ok(!JSON.stringify(records).includes(anthropic));assert.equal(service.store.verify('_service').valid,true);
  }finally{await service?.close();for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}}
});

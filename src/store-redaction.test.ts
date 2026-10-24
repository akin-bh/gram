import {test,expect} from 'bun:test';
import {Store,redact,hash} from './store.ts';
import {createService} from './server.ts';

const google='AIzaSYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL_123',anthropic='sk-ant-SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL';
test('audit redacts Google and Anthropic key-shaped strings at every depth and provider-labelled credential fields',()=>{
  const payload={prompt:`Use a synthetic world. Google ${google}; Anthropic ${anthropic}`,nested:[{message:`prefix ${google} suffix`,GEMINI_API_KEY:'arbitrary-provider-secret',ANTHROPIC_API_KEY:'arbitrary-anthropic-secret','x-goog-api-key':'arbitrary-header-secret',apiKey:'camel-case-secret',clientSecret:'client-secret-value',accessToken:'access-token-value',refresh_token:'refresh-token-value'}],ordinary:{seed:1234,amount_minor:9876,company:'Inventory'}};
  const result=redact(payload),encoded=JSON.stringify(result);for(const secret of [google,anthropic,'arbitrary-provider-secret','arbitrary-anthropic-secret','arbitrary-header-secret','camel-case-secret','client-secret-value','access-token-value','refresh-token-value'])expect(!encoded.includes(secret)).toBeTruthy();expect(result.ordinary.amount_minor).toBe(9876);expect(result.ordinary.company).toBe('Inventory');expect(payload.prompt.includes(google)).toBeTruthy();
  const store=new Store(':memory:');try{store.audit('redaction-world','generation.prompt',payload);const event=store.events('redaction-world',0,100)[0];expect(event.data).toStrictEqual(result);expect(store.verify('redaction-world').valid).toBe(true);expect(!JSON.stringify(event).includes(google)).toBeTruthy();}finally{store.close();}
});

test('HTTP generation request auditing retains only prompt digest and length before provider submission',async()=>{
  const names=['FINANCE_WORLD_ENV_FILE','GEMINI_API_KEY','GOOGLE_CLOUD_PROJECT','FINANCE_WORLD_ARGON_PRICING','ANTHROPIC_API_KEY'],before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  // Explicit synthetic environment prevents this test from reading real keys.
  process.env.FINANCE_WORLD_ENV_FILE='/nonexistent/synthetic-redaction-test.env';process.env.GEMINI_API_KEY=google;process.env.GOOGLE_CLOUD_PROJECT='synthetic-redaction-project';process.env.ANTHROPIC_API_KEY='';delete process.env.FINANCE_WORLD_ARGON_PRICING;
  const base='http://127.0.0.1:51973',prompt=`Prepare synthetic payroll with ${google} and ${anthropic}`;let service:Awaited<ReturnType<typeof createService>>|undefined;
  try{service=await createService({database:':memory:',baseUrl:base,agentEnabled:false,deliveryIntervalMs:0});const home=await service.fetch(new Request(base)),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();const response=await service.fetch(new Request(base+'/api/generate',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({provider:'unsupported-no-network',prompt})}));expect(response.status).toBe(400);await response.text();const records=service.store.events('_service',0,1000),http=records.find(row=>row.type==='http.request'&&row.data.path==='/api/generate');expect(http).toBeTruthy();expect(http.data.body.prompt).toBeUndefined();expect(http.data.body.prompt_sha256).toBe(hash(prompt));expect(http.data.body.prompt_chars).toBe(prompt.length);expect(!JSON.stringify(records).includes(prompt)).toBeTruthy();expect(!JSON.stringify(records).includes(google)).toBeTruthy();expect(!JSON.stringify(records).includes(anthropic)).toBeTruthy();expect(service.store.verify('_service').valid).toBe(true);
  }finally{await service?.close();for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}}
});

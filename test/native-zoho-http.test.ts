import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {start} from './integration-fixture.ts';
type Fixture=Awaited<ReturnType<typeof start>>;
async function grant(f:Fixture,world:string,system='zoho-books',scope='read write'){
  const home=await fetch(f.base),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();const redirect='http://127.0.0.1:9123/zoho-test-callback',registered=await f.call('/api/oauth/clients',{name:'Zoho native HTTP verification',redirect_uris:[redirect]});assert.equal(registered.status,201);
  const client=registered.data.client_id,verifier=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),params=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope,state:randomUUID(),world_id:world,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
  const consent=await fetch(`${f.base}/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,Origin:f.base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});assert.equal(consent.status,303);await consent.text();const code=new URL(consent.headers.get('location')!).searchParams.get('code');
  const response=await f.call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:client,redirect_uri:redirect,code,code_verifier:verifier},undefined,randomUUID(),true);assert.equal(response.status,200);return response.data.access_token as string;
}
function client(get:()=>Fixture,world:string,token:string){return {async request(method:string,route:string,input?:any,key?:string,organization:string|false=world,scheme='Zoho-oauthtoken'){
  const url=new URL(`/providers/zoho-books/worlds/${world}/books/v3${route}`,get().base);if(organization!==false)url.searchParams.append('organization_id',organization);const result=await fetch(url,{method,headers:{Authorization:`${scheme} ${token}`,...(input===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:result.status,data:await result.json(),headers:result.headers};
}};}
const okay=(response:any)=>{assert.equal(response.status,200,JSON.stringify(response.data));return response.data.result;};
const financial=(w:any)=>structuredClone({accounts:w.accounts,bank:w.bankTransactions,journals:w.journals,operations:w.operations,invoices:w.invoices,bills:w.bills});
async function expenseWorld(f:Fixture){const world=await f.create({kind:'saas-collections',payrollControls:undefined,name:'Native accounting verification',orderCount:1}),at=world.now;
  const vendor=okay(await f.act(world.id,{type:'record_vendor',external_vendor_id:'zoho-service-source',name:'Accounting service',email:'finance@accounting-service.test',external_event_id:'zoho-vendor-source'})).vendor;
  const contract=okay(await f.act(world.id,{type:'record_service_contract',external_contract_id:'zoho-service-contract',counterparty_kind:'vendor',counterparty_id:vendor.id,amount_minor:12525,description:'Completed treasury service',signed_at:at,external_event_id:'zoho-contract-source'})).contract;
  okay(await f.act(world.id,{type:'record_service_bill',contract_id:contract.id,source_invoice_id:'SERVICE-1',amount_minor:12525,issued_at:at,due_at:at,service_completed_at:at,completion_reference:'service-delivered',external_event_id:'zoho-bill-source'}));return f.server.store.world(world.id);
}
const draft=(world:any)=>({journal_date:world.now.slice(0,10),notes:'Reclassify completed treasury service expense',status:'draft',line_items:[{account_id:'bank-fee-expense',debit_or_credit:'debit',amount:'125.25',description:'Treasury service expense'},{account_id:'expenses',debit_or_credit:'credit',amount:'125.25',description:'Reclassify generic expense'}],finance_world:{source_document_ids:[world.bills.find((row:any)=>row.source_invoice_id==='SERVICE-1').document_id]}});
const submit=(row:any)=>({finance_world:{version:row.finance_world.version}});

test('Zoho native scheme, OAuth scope and mandatory single organization are enforced before replay',async()=>{
  const f=await start(':memory:');try{
    const world=await expenseWorld(f),other=await f.create(),readToken=await grant(f,world.id,'zoho-books','read'),writeToken=await grant(f,world.id),read=client(()=>f,world.id,readToken),write=client(()=>f,world.id,writeToken),exact=JSON.stringify(f.server.store.world(world.id));
    for(const resource of ['contacts','invoices','bills','chartofaccounts','journals']){const response=await read.request('GET','/'+resource);assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.code,0);assert.ok(Array.isArray(response.data[resource]));}
    assert.equal((await read.request('POST','/journals',draft(world),'read-cannot-create')).status,403);assert.equal((await write.request('POST','/journals',draft(world))).status,400);
    for(const org of [false,other.id] as const)assert.equal((await write.request('POST','/journals',draft(world),'invalid-organization',org)).status,org===false?400:403);
    assert.equal((await write.request('GET','/contacts?organization_id='+world.id)).status,400);assert.equal((await client(()=>f,other.id,writeToken).request('GET','/contacts')).status,403);const wrongProvider=await grant(f,world.id,'xero');assert.equal((await client(()=>f,world.id,wrongProvider).request('GET','/contacts')).status,403);assert.equal(JSON.stringify(f.server.store.world(world.id)),exact);
    const created=await write.request('POST','/journals',draft(world),'native-zoho-create');assert.equal(created.status,201,JSON.stringify(created.data));assert.equal(created.data.journal.status,'draft');const after=JSON.stringify(f.server.store.world(world.id));for(const org of [false,other.id] as const)assert.equal((await write.request('POST','/journals',draft(world),'native-zoho-create',org)).status,org===false?400:403);assert.equal(JSON.stringify(f.server.store.world(world.id)),after);
    const replay=await write.request('POST','/journals',draft(world),'native-zoho-create');assert.deepEqual(replay.data,created.data);assert.equal(replay.headers.get('idempotent-replayed'),'true');assert.equal(f.server.store.verify(world.id).valid,true);
    assert.equal((await write.request('GET','/contacts',undefined,undefined,world.id,'Bearer')).status,401);
    const wrongScheme=await fetch(`${f.base}/providers/xero/worlds/${world.id}/api.xro/2.0/Accounts`,{headers:{Authorization:`Zoho-oauthtoken ${wrongProvider}`}});assert.equal(wrongScheme.status,401);await wrongScheme.text();
  }finally{await f.close();}
});

test('Zoho native review posts one cash-neutral source adjustment, keeps approval pending on origin outage and survives replay/restart',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'gram-native-zoho-')),database=join(folder,'world.sqlite');let f=await start(database);try{
    const world=await expenseWorld(f),id=world.id,token=await grant(f,id),native=client(()=>f,id,token),before=financial(world);for(const system of ['zoho-books','ledger','netsuite','xero'])await f.connect(id,system);
    const subscription=await f.call(`/api/worlds/${id}/webhooks`,{events:['manual_journal.*','approval.*','ledger.*']});assert.equal(subscription.status,201);
    const created=await native.request('POST','/journals',draft(world),'zoho-native-draft'),row=created.data.journal;assert.equal(created.status,201,JSON.stringify(created.data));assert.deepEqual(financial(f.server.store.world(id)),before);
    const route='/journals/'+row.journal_id,body=submit(row),attempts=await Promise.all([native.request('POST',route+'/submit',body,'zoho-native-submit'),native.request('POST',route+'/submit',body,'zoho-native-submit')]);assert.deepEqual(attempts.map(r=>r.status),[202,202]);assert.deepEqual(attempts[0].data,attempts[1].data);assert.ok(attempts.some(r=>r.headers.get('idempotent-replayed')==='true'));
    const pending=attempts[0].data.journal,approval=pending.finance_world.approval_id;assert.equal(pending.status,'submitted');assert.equal(pending.finance_world.accounting_system,'zoho-books');assert.equal(f.server.store.world(id).approvals.length,1);assert.deepEqual(financial(f.server.store.world(id)),before);
    okay(await f.act(id,{type:'set_fault',system:'zoho-books',mode:'offline'}));const frozen=JSON.stringify(f.server.store.world(id));const denied=await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'});assert.equal(denied.status,503);assert.equal(JSON.stringify(f.server.store.world(id)),frozen,'healthy Xero cannot substitute for the disconnected originating Zoho grant');
    okay(await f.act(id,{type:'set_fault',system:'zoho-books',mode:'healthy'}));okay(await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'}));const posted=await native.request('GET',route),published=posted.data.journal,state=f.server.store.world(id);assert.equal(published.status,'published');assert.equal(published.finance_world.journal_lines_verified,true);assert.equal(published.journal_id,row.journal_id);assert.deepEqual(published.line_items,row.line_items);assert.equal(state.journals.length,before.journals.length+1);assert.deepEqual(state.bankTransactions,before.bank);assert.deepEqual(state.operations,before.operations);assert.deepEqual(state.bills,before.bills);assert.deepEqual(state.invoices,before.invoices);
    assert.equal(state.accounts.find((r:any)=>r.id==='expenses').balance_minor,0);assert.equal(state.accounts.find((r:any)=>r.id==='bank-fee-expense').balance_minor,12525);assert.equal(state.approvals[0].decided_by,'controller-local');assert.notEqual(state.approvals[0].requested_by,state.approvals[0].decided_by);
    const source=world.bills.find((r:any)=>r.source_invoice_id==='SERVICE-1'),bill=(await native.request('GET','/bills/'+source.id)).data.bill;assert.equal(bill.balance,125.25);assert.equal(bill.finance_world.native_settled_minor,0);assert.equal(bill.finance_world.source_document_id,source.document_id);
    const replay=await native.request('POST',route+'/submit',body,'zoho-native-submit');assert.deepEqual(replay.data,attempts[0].data);assert.equal(replay.data.journal.status,'submitted');assert.equal(replay.headers.get('idempotent-replayed'),'true');const dispatch=await f.call(`/api/worlds/${id}/webhooks/dispatch`,{});assert.equal(dispatch.data.failed,0);assert.ok(dispatch.data.delivered>0);
    const snapshot=(await f.call(`/api/worlds/${id}`)).data,receipts=snapshot.webhooks.receiver.receipts;assert.ok(receipts.some((r:any)=>r.event.type==='ledger.posted'));assert.equal(f.server.store.verify(id).valid,true);const persisted=JSON.stringify(snapshot.world);await f.close();f=await start(database);
    assert.equal(JSON.stringify(f.server.store.world(id)),persisted);assert.deepEqual((await native.request('GET',route)).data,posted.data);assert.deepEqual((await native.request('POST',route+'/submit',body,'zoho-native-submit')).data,attempts[0].data);assert.equal(f.server.store.verify(id).valid,true);const audit=JSON.stringify(f.server.store.events(id,0,1000));assert.ok(!audit.includes(token));assert.ok(!audit.includes(subscription.data.secret));
  }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

test('Zoho native writes reject tax/control-account/bypass fields and cannot adopt another provider proposal',async()=>{
  const f=await start(':memory:');try{
    const world=await expenseWorld(f),id=world.id,token=await grant(f,id),native=client(()=>f,id,token);for(const system of ['xero','ledger','zoho-books'])await f.connect(id,system);
    const invalid=[{...draft(world),status:'published'},{...draft(world),currency_id:'EUR'},{...draft(world),line_items:[{account_id:'cash-bank',amount:'125.25',debit_or_credit:'debit'},{account_id:'expenses',amount:'125.25',debit_or_credit:'credit'}]},{...draft(world),line_items:draft(world).line_items.map(line=>({...line,tax_id:'NONE'}))}];const exact=JSON.stringify(f.server.store.world(id));for(let i=0;i<invalid.length;i++){assert.ok((await native.request('POST','/journals',invalid[i],'bad-zoho-'+i)).status>=400);assert.equal(JSON.stringify(f.server.store.world(id)),exact);}
    const other=okay(await f.act(id,{type:'prepare_manual_journal',accounting_system:'xero',description:'Xero-origin source adjustment',source_document_ids:draft(world).finance_world.source_document_ids,lines:[{account_id:'bank-fee-expense',debit_minor:12525},{account_id:'expenses',credit_minor:12525}]},f.agent(id))),path='/journals/'+other.manual_journal.id;
    assert.equal((await native.request('GET',path)).status,404);assert.equal((await native.request('POST',path+'/submit',{finance_world:{version:other.version}},'cannot-adopt')).status,403);assert.equal((await native.request('GET','/journals')).data.journals.length,0);assert.equal(f.server.store.verify(id).valid,true);
  }finally{await f.close();}
});

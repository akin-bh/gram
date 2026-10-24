import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {start} from './integration-fixture.ts';

type Fixture=Awaited<ReturnType<typeof start>>;
const okay=(result:any)=>{assert.equal(result.status,200,JSON.stringify(result.data));return result.data.result;};
const financial=(world:any)=>structuredClone({accounts:world.accounts,bank:world.bankTransactions,journals:world.journals,operations:world.operations,invoices:world.invoices,bills:world.bills,payrollRuns:world.payrollRuns});
const nativeRow=(result:any)=>result.data.ManualJournals[0];
async function expenseWorld(f:Fixture){
 const world=await f.create({name:'Treasury fee review'}),id=world.id,at=world.now;
 const vendor=okay(await f.act(id,{type:'record_vendor',external_vendor_id:'treasury-service-provider',name:'Treasury service provider',email:'billing@treasury-service.test',external_event_id:'source-treasury-vendor'})).vendor;
 const contract=okay(await f.act(id,{type:'record_service_contract',external_contract_id:'treasury-service-contract',counterparty_kind:'vendor',counterparty_id:vendor.id,amount_minor:12525,description:'Completed bank treasury service fee requiring expense classification',signed_at:at,external_event_id:'source-treasury-contract'})).contract;
 const bill=okay(await f.act(id,{type:'record_service_bill',contract_id:contract.id,source_invoice_id:'TREASURY-SERVICE-1',amount_minor:12525,issued_at:at,due_at:at,service_completed_at:at,completion_reference:'treasury-service-completed',external_event_id:'source-treasury-bill'})).bill;
 const result=(await f.call(`/api/worlds/${id}`)).data.world;assert.equal(result.accounts.find((row:any)=>row.id==='expenses').balance_minor,12525);assert.equal(result.accounts.find((row:any)=>row.id==='payables').balance_minor,-12525);assert.equal(result.bankTransactions.length,world.bankTransactions.length);assert.equal(bill.amount_paid_minor,0);return result;
}
async function grant(f:Fixture,world:string,system:string,scope:string){
 const home=await fetch(f.base),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
 const redirect='http://127.0.0.1:9123/xero-test-callback',registered=await f.call('/api/oauth/clients',{name:'Xero HTTP verification',redirect_uris:[redirect]});assert.equal(registered.status,201);
 const client=registered.data.client_id,verifier=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
 const params=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope,state:randomUUID(),world_id:world,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
 const consent=await fetch(`${f.base}/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,Origin:f.base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});assert.equal(consent.status,303);await consent.text();const code=new URL(consent.headers.get('location')!).searchParams.get('code');
 const response=await f.call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:client,redirect_uri:redirect,code,code_verifier:verifier},undefined,randomUUID(),true);assert.equal(response.status,200);return response.data.access_token as string;
}
function client(getFixture:()=>Fixture,world:string,token:string){
 const prefix=`/providers/xero/worlds/${world}/api.xro/2.0`;
 return {prefix,async request(method:string,route:string,input?:any,key?:string,headers:Record<string,string>={}){const response=await fetch(getFixture().base+prefix+route,{method,headers:{Authorization:`Bearer ${token}`,...(input===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{}),...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,data:await response.json(),headers:response.headers};}};
}
const draft=(world:any,patch:any={})=>({ManualJournals:[{Narration:'Reclassify completed treasury service bill TREASURY-SERVICE-1 from generic expense to bank fee expense',Date:world.now.slice(0,10),Status:'DRAFT',LineAmountTypes:'NoTax',JournalLines:[{AccountCode:'bank-fee-expense',LineAmount:'125.25',Description:'Reclassify existing completed treasury service expense',TaxType:'NONE'},{AccountCode:'expenses',LineAmount:'-125.25',TaxType:'NONE'}],finance_world:{source_document_ids:[world.bills.find((row:any)=>row.source_invoice_id==='TREASURY-SERVICE-1').document_id]},...patch}]});
const submit=(row:any)=>({ManualJournals:[{ManualJournalID:row.ManualJournalID,Status:'POSTED',finance_world:{version:row.finance_world.version}}]});

test('Xero native reads and writes enforce real OAuth scope, current tenant, world and provider boundaries',async()=>{
 const f=await start(':memory:');
 try{
  const world=await expenseWorld(f),other=await f.create({name:'Other'}),readToken=await grant(f,world.id,'xero','read'),writeToken=await grant(f,world.id,'xero','read write'),read=client(()=>f,world.id,readToken),write=client(()=>f,world.id,writeToken);
  const accounts=await read.request('GET','/Accounts');assert.equal(accounts.status,200);assert.ok(accounts.data.Accounts.some((row:any)=>row.Code==='bank-fee-expense'));
  assert.equal((await read.request('GET','/Organisation')).status,200);assert.equal((await read.request('GET','/Contacts')).status,200);assert.equal((await read.request('GET','/Invoices')).status,200);
  const before=JSON.stringify(f.server.store.world(world.id));assert.equal((await read.request('PUT','/ManualJournals',draft(world),'read-cannot-create')).status,403);
  assert.equal((await write.request('PUT','/ManualJournals',draft(world))).status,400);assert.equal((await write.request('PUT','/ManualJournals',draft(world),'wrong-tenant',{'xero-tenant-id':other.id})).status,403);
  assert.equal((await client(()=>f,other.id,writeToken).request('GET','/Accounts')).status,403);
  const wrongProvider=await grant(f,world.id,'gusto','read write');assert.equal((await client(()=>f,world.id,wrongProvider).request('GET','/Accounts')).status,403);
  assert.equal(JSON.stringify(f.server.store.world(world.id)),before);
  const created=await write.request('PUT','/ManualJournals',draft(world),'source-draft',{'xero-tenant-id':world.id});assert.equal(created.status,200);assert.equal(nativeRow(created).Status,'DRAFT');
  const exact=JSON.stringify(f.server.store.world(world.id));assert.equal((await write.request('PUT','/ManualJournals',draft(world),'source-draft',{'xero-tenant-id':other.id})).status,403,'tenant validation must run before original-response cache replay');assert.equal(JSON.stringify(f.server.store.world(world.id)),exact);
  const replay=await write.request('PUT','/ManualJournals',draft(world),'source-draft');assert.equal(replay.headers.get('idempotent-replayed'),'true');assert.deepEqual(replay.data,created.data);
  assert.equal(f.server.store.verify(world.id).valid,true);
 }finally{await f.close();}
});

test('Xero manual draft, immutable submit and distinct review post one cash-neutral journal after outages, then survive replay and restart',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'gram-xero-native-')),database=join(folder,'world.sqlite');let f=await start(database);
 try{
  const world=await expenseWorld(f),id=world.id,token=await grant(f,id,'xero','read write'),native=client(()=>f,id,token),prefix=`/api/worlds/${id}`,before=financial(world);
  for(const system of ['xero','ledger','netsuite'])await f.connect(id,system);
  const subscription=await f.call(prefix+'/webhooks',{events:['manual_journal.*','approval.*','ledger.*']});assert.equal(subscription.status,201);
  okay(await f.act(id,{type:'close_period'}));okay(await f.act(id,{type:'set_fault',system:'ledger',mode:'offline'}));
  const created=await native.request('PUT','/ManualJournals',draft(world),'native-draft'),prepared=nativeRow(created);assert.equal(created.status,200);assert.equal(prepared.Status,'DRAFT');assert.equal(prepared.finance_world.canonical_status,'draft');assert.deepEqual(financial(f.server.store.world(id)),before);
  const route='/ManualJournals/'+prepared.ManualJournalID,body=submit(prepared);
  assert.equal((await native.request('POST',route,body,'blocked-submit')).status,503);okay(await f.act(id,{type:'set_fault',system:'ledger',mode:'healthy'}));
  assert.equal((await native.request('POST',route,body,'blocked-submit-closed')).status,409);okay(await f.act(id,{type:'reopen_period'}));
  const simultaneous=await Promise.all([native.request('POST',route,body,'native-submit'),native.request('POST',route,body,'native-submit')]);assert.deepEqual(simultaneous.map(row=>row.status),[202,202]);assert.deepEqual(simultaneous[0].data,simultaneous[1].data);assert.ok(simultaneous.some(row=>row.headers.get('idempotent-replayed')==='true'));
  const submitted=nativeRow(simultaneous[0]),approval=submitted.finance_world.approval_id;assert.equal(submitted.Status,'DRAFT');assert.equal(submitted.finance_world.canonical_status,'awaiting_approval');assert.ok(approval);assert.equal(f.server.store.world(id).approvals.length,1);assert.deepEqual(financial(f.server.store.world(id)),before);
  assert.equal((await native.request('POST',route,submit(submitted),'native-submit')).status,409,'changed request body cannot reuse the original key');assert.equal((await native.request('POST',route,body,'new-stale-version')).status,409);
  assert.equal((await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'},token)).status,403);
  okay(await f.act(id,{type:'set_fault',system:'ledger',mode:'offline'}));let exact=JSON.stringify(f.server.store.world(id));assert.equal((await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'})).status,503);assert.equal(JSON.stringify(f.server.store.world(id)),exact);
  okay(await f.act(id,{type:'set_fault',system:'ledger',mode:'healthy'}));okay(await f.act(id,{type:'close_period'}));exact=JSON.stringify(f.server.store.world(id));assert.equal((await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'})).status,409);assert.equal(JSON.stringify(f.server.store.world(id)),exact);
  okay(await f.act(id,{type:'reopen_period'}));okay(await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'},undefined,'independent-journal-review'));
  const posted=await native.request('GET',route),entry=nativeRow(posted),state=f.server.store.world(id);assert.equal(entry.Status,'POSTED');assert.equal(entry.finance_world.canonical_status,'posted');assert.ok(entry.finance_world.journal_id);assert.equal(entry.ManualJournalID,prepared.ManualJournalID);assert.deepEqual(entry.JournalLines,prepared.JournalLines);
  assert.equal(state.journals.length,before.journals.length+1);assert.deepEqual(state.bankTransactions,before.bank);assert.deepEqual(state.operations,before.operations);assert.deepEqual(state.invoices,before.invoices);assert.deepEqual(state.bills,before.bills);assert.deepEqual(state.payrollRuns,before.payrollRuns);
  for(const account of state.accounts){const old=before.accounts.find((row:any)=>row.id===account.id);assert.equal(account.balance_minor,old.balance_minor+(account.id==='bank-fee-expense'?12525:account.id==='expenses'?-12525:0));}
  const postedJournal=state.journals.find((row:any)=>row.id===entry.finance_world.journal_id)!;assert.equal(postedJournal.lines.reduce((sum:number,row:any)=>sum+row.debit_minor-row.credit_minor,0),0);assert.equal(state.approvals[0].decided_by,'controller-local');assert.notEqual(state.approvals[0].requested_by,state.approvals[0].decided_by);
  const nativeProof=await native.request('GET','/Journals/'+postedJournal.id);assert.equal(nativeProof.status,200);const proof=nativeProof.data.Journals[0];assert.equal(proof.JournalID,postedJournal.id);assert.equal(proof.finance_world.source_type,'manual_journal');assert.equal(proof.finance_world.source_id,prepared.ManualJournalID);assert.equal(proof.finance_world.posted_at,postedJournal.posted_at);assert.deepEqual(proof.JournalLines.map((row:any)=>({account:row.AccountCode,debit:row.finance_world.debit_minor,credit:row.finance_world.credit_minor})),postedJournal.lines.map((row:any)=>({account:row.account_id,debit:row.debit_minor,credit:row.credit_minor})));
  const sourceBill=world.bills.find((row:any)=>row.source_invoice_id==='TREASURY-SERVICE-1'),nativeBill=(await native.request('GET','/Invoices/'+sourceBill.id)).data.Invoices[0];assert.equal(nativeBill.Type,'ACCPAY');assert.equal(nativeBill.AmountDue,125.25);assert.equal(nativeBill.AmountPaid,0);assert.equal(nativeBill.finance_world.source_document_id,sourceBill.document_id);assert.equal(state.accounts.find((row:any)=>row.id==='expenses').balance_minor,0);assert.equal(state.accounts.find((row:any)=>row.id==='bank-fee-expense').balance_minor,12525);
  const cached=await native.request('POST',route,body,'native-submit');assert.equal(cached.status,202);assert.equal(nativeRow(cached).Status,'DRAFT');assert.deepEqual(cached.data,simultaneous[0].data);assert.equal(cached.headers.get('idempotent-replayed'),'true');assert.equal(f.server.store.world(id).journals.length,state.journals.length);
  const delivered=await f.call(prefix+'/webhooks/dispatch',{});assert.equal(delivered.status,200);assert.equal(delivered.data.failed,0);assert.ok(delivered.data.delivered>0);
  const snapshot=(await f.call(prefix)).data,receipts=snapshot.webhooks.receiver.receipts;assert.ok(receipts.some((row:any)=>row.event.type==='ledger.posted'));assert.equal(receipts.length,new Set(receipts.map((row:any)=>row.delivery_id)).size);assert.equal(f.server.store.verify(id).valid,true);
  const persisted=JSON.stringify({world:snapshot.world,connections:snapshot.connections,receipts}),port=Number(new URL(f.base).port);await f.close();f=await start(database,port);
  const restored=(await f.call(prefix)).data;assert.equal(JSON.stringify({world:restored.world,connections:restored.connections,receipts:restored.webhooks.receiver.receipts}),persisted);
  const nativeAfter=await native.request('GET',route);assert.deepEqual(nativeAfter.data,posted.data);const durableReplay=await native.request('POST',route,body,'native-submit');assert.deepEqual(durableReplay.data,simultaneous[0].data);assert.equal(durableReplay.headers.get('idempotent-replayed'),'true');assert.equal(f.server.store.world(id).journals.length,state.journals.length);assert.equal(f.server.store.verify(id).valid,true);
  const audit=JSON.stringify(f.server.store.events(id,0,1000));assert.ok(!audit.includes(token));assert.ok(!audit.includes(subscription.data.secret));
 }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

test('Xero rejects unsupported financial fields, batches and control accounts atomically before draft or journal persistence',async()=>{
 const f=await start(':memory:');
 try{
  const world=await expenseWorld(f),token=await grant(f,world.id,'xero','read write'),native=client(()=>f,world.id,token),valid=draft(world),bad=[
   {ManualJournals:[valid.ManualJournals[0],valid.ManualJournals[0]]},
   draft(world,{JournalLines:[{AccountCode:'cash-bank',LineAmount:'125.25'},{AccountCode:'expenses',LineAmount:'-125.25'}]}),
   draft(world,{JournalLines:[{AccountCode:'wages-payable',LineAmount:'125.25'},{AccountCode:'expenses',LineAmount:'-125.25'}]}),
   draft(world,{JournalLines:[{AccountCode:'bank-fee-expense',LineAmount:'125.25'},{AccountCode:'expenses',LineAmount:'-125.24'}]}),
   draft(world,{JournalLines:[{AccountCode:'bank-fee-expense',LineAmount:'0.001'},{AccountCode:'expenses',LineAmount:'-0.001'}]}),
   draft(world,{JournalLines:[{AccountCode:'bank-fee-expense',LineAmount:125.25,TaxType:'OUTPUT'},{AccountCode:'expenses',LineAmount:-125.25}]}),
   draft(world,{JournalLines:[{AccountCode:'bank-fee-expense',LineAmount:125.25,Tracking:[{Name:'Invented',Option:'Fake'}]},{AccountCode:'expenses',LineAmount:-125.25}]}),
   draft(world,{LineAmountTypes:'Inclusive'}),draft(world,{CurrencyCode:'EUR'}),draft(world,{Status:'DELETED'}),draft(world,{finance_world:{source_document_ids:[]}}),draft(world,{finance_world:{source_document_ids:['missing-source-document']}}),
   draft(world,{finance_world:{source_document_ids:[world.documents[0].id,world.documents[0].id]}}),draft(world,{finance_world:{source_document_ids:[world.documents[0].id],approved:true}}),
  ];
  const exact=JSON.stringify(f.server.store.world(world.id));for(let i=0;i<bad.length;i++){const rejected=await native.request('PUT','/ManualJournals',bad[i],'malformed-journal-'+i);assert.ok(rejected.status>=400,JSON.stringify(rejected.data));assert.equal(JSON.stringify(f.server.store.world(world.id)),exact,`rejected input ${i} must be atomic`);}
  const requested=await native.request('PUT','/ManualJournals',draft(world,{Status:'POSTED'}),'direct-posted-request');assert.equal(requested.status,202);assert.equal(nativeRow(requested).Status,'DRAFT');assert.equal(nativeRow(requested).finance_world.canonical_status,'awaiting_approval');assert.deepEqual(financial(f.server.store.world(world.id)),financial(world));
  assert.equal(f.server.store.verify(world.id).valid,true);
 }finally{await f.close();}
});

test('Xero review cannot silently backdate a stale prepared journal and rejection never claims native deletion or posting',async()=>{
 const f=await start(':memory:');
 try{
  const world=await expenseWorld(f),id=world.id,token=await grant(f,id,'xero','read write'),native=client(()=>f,id,token);for(const system of ['xero','ledger','netsuite'])await f.connect(id,system);
  const requested=await native.request('PUT','/ManualJournals',draft(world,{Status:'POSTED'}),'review-current-day'),entry=nativeRow(requested),route='/ManualJournals/'+entry.ManualJournalID;assert.equal(requested.status,202);
  okay(await f.act(id,{type:'advance_time',hours:24}));const exact=JSON.stringify(f.server.store.world(id));const stale=await f.act(id,{type:'decide_approval',approval_id:entry.finance_world.approval_id,decision:'approve'});assert.equal(stale.status,409);assert.equal(stale.data.error.code,'manual_journal_date_changed');assert.equal(JSON.stringify(f.server.store.world(id)),exact);
  okay(await f.act(id,{type:'decide_approval',approval_id:entry.finance_world.approval_id,decision:'reject'}));const rejected=nativeRow(await native.request('GET',route));assert.equal(rejected.Status,'DRAFT');assert.equal(rejected.finance_world.canonical_status,'rejected');assert.equal(rejected.finance_world.journal_id,null);assert.deepEqual(rejected.JournalLines,entry.JournalLines);
  const beforeRetry=JSON.stringify(f.server.store.world(id));assert.equal((await native.request('POST',route,submit(rejected),'cannot-revive-rejection')).status,409);assert.equal(JSON.stringify(f.server.store.world(id)),beforeRetry);assert.deepEqual(financial(f.server.store.world(id)),financial(world));assert.equal(f.server.store.verify(id).valid,true);
 }finally{await f.close();}
});

test('a controller who prepared a Xero draft cannot approve it after another operator submits it',async()=>{
 const f=await start(':memory:');
 try{
  const world=await expenseWorld(f),id=world.id;for(const system of ['xero','ledger','netsuite'])await f.connect(id,system);
  const token=await grant(f,id,'xero','read write'),native=client(()=>f,id,token),home=await fetch(f.base),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  const response=await fetch(f.base+native.prefix+'/ManualJournals',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json','Idempotency-Key':'controller-prepared-source'},body:JSON.stringify(draft(world))});assert.equal(response.status,200);const created=(await response.json()).ManualJournals[0];
  const submitted=await native.request('POST','/ManualJournals/'+created.ManualJournalID,submit(created),'operator-submitted-source');assert.equal(submitted.status,202);
  const exact=JSON.stringify(f.server.store.world(id)),denied=await f.act(id,{type:'decide_approval',approval_id:nativeRow(submitted).finance_world.approval_id,decision:'approve'});assert.equal(denied.status,403);assert.equal(denied.data.error.code,'separate_controller_required');assert.equal(JSON.stringify(f.server.store.world(id)),exact);assert.deepEqual(financial(f.server.store.world(id)),financial(world));assert.equal(f.server.store.verify(id).valid,true);
 }finally{await f.close();}
});

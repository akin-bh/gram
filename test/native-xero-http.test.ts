import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {start} from './integration-fixture.ts';

type Fixture=Awaited<ReturnType<typeof start>>;
const okay=(result:any)=>{expect(result.status,JSON.stringify(result.data)).toBe(200);return result.data.result;};
const financial=(world:any)=>structuredClone({accounts:world.accounts,bank:world.bankTransactions,journals:world.journals,operations:world.operations,invoices:world.invoices,bills:world.bills,payrollRuns:world.payrollRuns});
const nativeRow=(result:any)=>result.data.ManualJournals[0];
async function expenseWorld(f:Fixture){
 const world=await f.create({name:'Treasury fee review'}),id=world.id,at=world.now;
 const vendor=okay(await f.act(id,{type:'record_vendor',external_vendor_id:'treasury-service-provider',name:'Treasury service provider',email:'billing@treasury-service.test',external_event_id:'source-treasury-vendor'})).vendor;
 const contract=okay(await f.act(id,{type:'record_service_contract',external_contract_id:'treasury-service-contract',counterparty_kind:'vendor',counterparty_id:vendor.id,amount_minor:12525,description:'Completed bank treasury service fee requiring expense classification',signed_at:at,external_event_id:'source-treasury-contract'})).contract;
 const bill=okay(await f.act(id,{type:'record_service_bill',contract_id:contract.id,source_invoice_id:'TREASURY-SERVICE-1',amount_minor:12525,issued_at:at,due_at:at,service_completed_at:at,completion_reference:'treasury-service-completed',external_event_id:'source-treasury-bill'})).bill;
 const result=(await f.call(`/api/worlds/${id}`)).data.world;expect(result.accounts.find((row:any)=>row.id==='expenses').balance_minor).toBe(12525);expect(result.accounts.find((row:any)=>row.id==='payables').balance_minor).toBe(-12525);expect(result.bankTransactions.length).toBe(world.bankTransactions.length);expect(bill.amount_paid_minor).toBe(0);return result;
}
async function grant(f:Fixture,world:string,system:string,scope:string){
 const home=await fetch(f.base),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
 const redirect='http://127.0.0.1:9123/xero-test-callback',registered=await f.call('/api/oauth/clients',{name:'Xero HTTP verification',redirect_uris:[redirect]});expect(registered.status).toBe(201);
 const client=registered.data.client_id,verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 const params=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope,state:crypto.randomUUID(),world_id:world,code_challenge:new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
 const consent=await fetch(`${f.base}/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,Origin:f.base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});expect(consent.status).toBe(303);await consent.text();const code=new URL(consent.headers.get('location')!).searchParams.get('code');
 const response=await f.call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:client,redirect_uri:redirect,code,code_verifier:verifier},undefined,crypto.randomUUID(),true);expect(response.status).toBe(200);return response.data.access_token as string;
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
  const accounts=await read.request('GET','/Accounts');expect(accounts.status).toBe(200);expect(accounts.data.Accounts.some((row:any)=>row.Code==='bank-fee-expense')).toBeTruthy();
  expect((await read.request('GET','/Organisation')).status).toBe(200);expect((await read.request('GET','/Contacts')).status).toBe(200);expect((await read.request('GET','/Invoices')).status).toBe(200);
  const before=JSON.stringify(f.server.store.world(world.id));expect((await read.request('PUT','/ManualJournals',draft(world),'read-cannot-create')).status).toBe(403);
  expect((await write.request('PUT','/ManualJournals',draft(world))).status).toBe(400);expect((await write.request('PUT','/ManualJournals',draft(world),'wrong-tenant',{'xero-tenant-id':other.id})).status).toBe(403);
  expect((await client(()=>f,other.id,writeToken).request('GET','/Accounts')).status).toBe(403);
  const wrongProvider=await grant(f,world.id,'gusto','read write');expect((await client(()=>f,world.id,wrongProvider).request('GET','/Accounts')).status).toBe(403);
  expect(JSON.stringify(f.server.store.world(world.id))).toBe(before);
  const created=await write.request('PUT','/ManualJournals',draft(world),'source-draft',{'xero-tenant-id':world.id});expect(created.status).toBe(200);expect(nativeRow(created).Status).toBe('DRAFT');
  const exact=JSON.stringify(f.server.store.world(world.id));expect((await write.request('PUT','/ManualJournals',draft(world),'source-draft',{'xero-tenant-id':other.id})).status,'tenant validation must run before original-response cache replay').toBe(403);expect(JSON.stringify(f.server.store.world(world.id))).toBe(exact);
  const replay=await write.request('PUT','/ManualJournals',draft(world),'source-draft');expect(replay.headers.get('idempotent-replayed')).toBe('true');expect(replay.data).toStrictEqual(created.data);
  expect(f.server.store.verify(world.id).valid).toBe(true);
 }finally{await f.close();}
});

test('Xero manual draft, immutable submit and distinct review post one cash-neutral journal after outages, then survive replay and restart',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'gram-xero-native-')),database=join(folder,'world.sqlite');let f=await start(database);
 try{
  const world=await expenseWorld(f),id=world.id,token=await grant(f,id,'xero','read write'),native=client(()=>f,id,token),prefix=`/api/worlds/${id}`,before=financial(world);
  for(const system of ['xero','ledger','netsuite'])await f.connect(id,system);
  const subscription=await f.call(prefix+'/webhooks',{events:['manual_journal.*','approval.*','ledger.*']});expect(subscription.status).toBe(201);
  okay(await f.act(id,{type:'close_period'}));okay(await f.act(id,{type:'set_fault',system:'ledger',mode:'offline'}));
  const created=await native.request('PUT','/ManualJournals',draft(world),'native-draft'),prepared=nativeRow(created);expect(created.status).toBe(200);expect(prepared.Status).toBe('DRAFT');expect(prepared.finance_world.canonical_status).toBe('draft');expect(financial(f.server.store.world(id))).toStrictEqual(before);
  const route='/ManualJournals/'+prepared.ManualJournalID,body=submit(prepared);
  expect((await native.request('POST',route,body,'blocked-submit')).status).toBe(503);okay(await f.act(id,{type:'set_fault',system:'ledger',mode:'healthy'}));
  expect((await native.request('POST',route,body,'blocked-submit-closed')).status).toBe(409);okay(await f.act(id,{type:'reopen_period'}));
  const simultaneous=await Promise.all([native.request('POST',route,body,'native-submit'),native.request('POST',route,body,'native-submit')]);expect(simultaneous.map(row=>row.status)).toStrictEqual([202,202]);expect(simultaneous[0].data).toStrictEqual(simultaneous[1].data);expect(simultaneous.some(row=>row.headers.get('idempotent-replayed')==='true')).toBeTruthy();
  const submitted=nativeRow(simultaneous[0]),approval=submitted.finance_world.approval_id;expect(submitted.Status).toBe('DRAFT');expect(submitted.finance_world.canonical_status).toBe('awaiting_approval');expect(approval).toBeTruthy();expect(f.server.store.world(id).approvals.length).toBe(1);expect(financial(f.server.store.world(id))).toStrictEqual(before);
  expect((await native.request('POST',route,submit(submitted),'native-submit')).status,'changed request body cannot reuse the original key').toBe(409);expect((await native.request('POST',route,body,'new-stale-version')).status).toBe(409);
  expect((await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'},token)).status).toBe(403);
  okay(await f.act(id,{type:'set_fault',system:'ledger',mode:'offline'}));let exact=JSON.stringify(f.server.store.world(id));expect((await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'})).status).toBe(503);expect(JSON.stringify(f.server.store.world(id))).toBe(exact);
  okay(await f.act(id,{type:'set_fault',system:'ledger',mode:'healthy'}));okay(await f.act(id,{type:'close_period'}));exact=JSON.stringify(f.server.store.world(id));expect((await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'})).status).toBe(409);expect(JSON.stringify(f.server.store.world(id))).toBe(exact);
  okay(await f.act(id,{type:'reopen_period'}));okay(await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'},undefined,'independent-journal-review'));
  const posted=await native.request('GET',route),entry=nativeRow(posted),state=f.server.store.world(id);expect(entry.Status).toBe('POSTED');expect(entry.finance_world.canonical_status).toBe('posted');expect(entry.finance_world.journal_id).toBeTruthy();expect(entry.ManualJournalID).toBe(prepared.ManualJournalID);expect(entry.JournalLines).toStrictEqual(prepared.JournalLines);
  expect(state.journals.length).toBe(before.journals.length+1);expect(state.bankTransactions).toStrictEqual(before.bank);expect(state.operations).toStrictEqual(before.operations);expect(state.invoices).toStrictEqual(before.invoices);expect(state.bills).toStrictEqual(before.bills);expect(state.payrollRuns).toStrictEqual(before.payrollRuns);
  for(const account of state.accounts){const old=before.accounts.find((row:any)=>row.id===account.id);expect(account.balance_minor).toBe(old.balance_minor+(account.id==='bank-fee-expense'?12525:account.id==='expenses'?-12525:0));}
  const postedJournal=state.journals.find((row:any)=>row.id===entry.finance_world.journal_id)!;expect(postedJournal.lines.reduce((sum:number,row:any)=>sum+row.debit_minor-row.credit_minor,0)).toBe(0);expect(state.approvals[0].decided_by).toBe('controller-local');expect(state.approvals[0].requested_by).not.toBe(state.approvals[0].decided_by);
  const nativeProof=await native.request('GET','/Journals/'+postedJournal.id);expect(nativeProof.status).toBe(200);const proof=nativeProof.data.Journals[0];expect(proof.JournalID).toBe(postedJournal.id);expect(proof.finance_world.source_type).toBe('manual_journal');expect(proof.finance_world.source_id).toBe(prepared.ManualJournalID);expect(proof.finance_world.posted_at).toBe(postedJournal.posted_at);expect(proof.JournalLines.map((row:any)=>({account:row.AccountCode,debit:row.finance_world.debit_minor,credit:row.finance_world.credit_minor}))).toStrictEqual(postedJournal.lines.map((row:any)=>({account:row.account_id,debit:row.debit_minor,credit:row.credit_minor})));
  const sourceBill=world.bills.find((row:any)=>row.source_invoice_id==='TREASURY-SERVICE-1'),nativeBill=(await native.request('GET','/Invoices/'+sourceBill.id)).data.Invoices[0];expect(nativeBill.Type).toBe('ACCPAY');expect(nativeBill.AmountDue).toBe(125.25);expect(nativeBill.AmountPaid).toBe(0);expect(nativeBill.finance_world.source_document_id).toBe(sourceBill.document_id);expect(state.accounts.find((row:any)=>row.id==='expenses').balance_minor).toBe(0);expect(state.accounts.find((row:any)=>row.id==='bank-fee-expense').balance_minor).toBe(12525);
  const cached=await native.request('POST',route,body,'native-submit');expect(cached.status).toBe(202);expect(nativeRow(cached).Status).toBe('DRAFT');expect(cached.data).toStrictEqual(simultaneous[0].data);expect(cached.headers.get('idempotent-replayed')).toBe('true');expect(f.server.store.world(id).journals.length).toBe(state.journals.length);
  const delivered=await f.call(prefix+'/webhooks/dispatch',{});expect(delivered.status).toBe(200);expect(delivered.data.failed).toBe(0);expect(delivered.data.delivered>0).toBeTruthy();
  const snapshot=(await f.call(prefix)).data,receipts=snapshot.webhooks.receiver.receipts;expect(receipts.some((row:any)=>row.event.type==='ledger.posted')).toBeTruthy();expect(receipts.length).toBe(new Set(receipts.map((row:any)=>row.delivery_id)).size);expect(f.server.store.verify(id).valid).toBe(true);
  const persisted=JSON.stringify({world:snapshot.world,connections:snapshot.connections,receipts}),port=Number(new URL(f.base).port);await f.close();f=await start(database,port);
  const restored=(await f.call(prefix)).data;expect(JSON.stringify({world:restored.world,connections:restored.connections,receipts:restored.webhooks.receiver.receipts})).toBe(persisted);
  const nativeAfter=await native.request('GET',route);expect(nativeAfter.data).toStrictEqual(posted.data);const durableReplay=await native.request('POST',route,body,'native-submit');expect(durableReplay.data).toStrictEqual(simultaneous[0].data);expect(durableReplay.headers.get('idempotent-replayed')).toBe('true');expect(f.server.store.world(id).journals.length).toBe(state.journals.length);expect(f.server.store.verify(id).valid).toBe(true);
  const audit=JSON.stringify(f.server.store.events(id,0,1000));expect(!audit.includes(token)).toBeTruthy();expect(!audit.includes(subscription.data.secret)).toBeTruthy();
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
  const exact=JSON.stringify(f.server.store.world(world.id));for(let i=0;i<bad.length;i++){const rejected=await native.request('PUT','/ManualJournals',bad[i],'malformed-journal-'+i);expect(rejected.status>=400,JSON.stringify(rejected.data)).toBeTruthy();expect(JSON.stringify(f.server.store.world(world.id)),`rejected input ${i} must be atomic`).toBe(exact);}
  const requested=await native.request('PUT','/ManualJournals',draft(world,{Status:'POSTED'}),'direct-posted-request');expect(requested.status).toBe(202);expect(nativeRow(requested).Status).toBe('DRAFT');expect(nativeRow(requested).finance_world.canonical_status).toBe('awaiting_approval');expect(financial(f.server.store.world(world.id))).toStrictEqual(financial(world));
  expect(f.server.store.verify(world.id).valid).toBe(true);
 }finally{await f.close();}
});

test('Xero review cannot silently backdate a stale prepared journal and rejection never claims native deletion or posting',async()=>{
 const f=await start(':memory:');
 try{
  const world=await expenseWorld(f),id=world.id,token=await grant(f,id,'xero','read write'),native=client(()=>f,id,token);for(const system of ['xero','ledger','netsuite'])await f.connect(id,system);
  const requested=await native.request('PUT','/ManualJournals',draft(world,{Status:'POSTED'}),'review-current-day'),entry=nativeRow(requested),route='/ManualJournals/'+entry.ManualJournalID;expect(requested.status).toBe(202);
  okay(await f.act(id,{type:'advance_time',hours:24}));const exact=JSON.stringify(f.server.store.world(id));const stale=await f.act(id,{type:'decide_approval',approval_id:entry.finance_world.approval_id,decision:'approve'});expect(stale.status).toBe(409);expect(stale.data.error.code).toBe('manual_journal_date_changed');expect(JSON.stringify(f.server.store.world(id))).toBe(exact);
  okay(await f.act(id,{type:'decide_approval',approval_id:entry.finance_world.approval_id,decision:'reject'}));const rejected=nativeRow(await native.request('GET',route));expect(rejected.Status).toBe('DRAFT');expect(rejected.finance_world.canonical_status).toBe('rejected');expect(rejected.finance_world.journal_id).toBeNull();expect(rejected.JournalLines).toStrictEqual(entry.JournalLines);
  const beforeRetry=JSON.stringify(f.server.store.world(id));expect((await native.request('POST',route,submit(rejected),'cannot-revive-rejection')).status).toBe(409);expect(JSON.stringify(f.server.store.world(id))).toBe(beforeRetry);expect(financial(f.server.store.world(id))).toStrictEqual(financial(world));expect(f.server.store.verify(id).valid).toBe(true);
 }finally{await f.close();}
});

test('a controller who prepared a Xero draft cannot approve it after another operator submits it',async()=>{
 const f=await start(':memory:');
 try{
  const world=await expenseWorld(f),id=world.id;for(const system of ['xero','ledger','netsuite'])await f.connect(id,system);
  const token=await grant(f,id,'xero','read write'),native=client(()=>f,id,token),home=await fetch(f.base),cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  const response=await fetch(f.base+native.prefix+'/ManualJournals',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json','Idempotency-Key':'controller-prepared-source'},body:JSON.stringify(draft(world))});expect(response.status).toBe(200);const created=(await response.json()).ManualJournals[0];
  const submitted=await native.request('POST','/ManualJournals/'+created.ManualJournalID,submit(created),'operator-submitted-source');expect(submitted.status).toBe(202);
  const exact=JSON.stringify(f.server.store.world(id)),denied=await f.act(id,{type:'decide_approval',approval_id:nativeRow(submitted).finance_world.approval_id,decision:'approve'});expect(denied.status).toBe(403);expect(denied.data.error.code).toBe('separate_controller_required');expect(JSON.stringify(f.server.store.world(id))).toBe(exact);expect(financial(f.server.store.world(id))).toStrictEqual(financial(world));expect(f.server.store.verify(id).valid).toBe(true);
 }finally{await f.close();}
});

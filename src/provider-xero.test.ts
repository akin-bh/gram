import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createWorld,applyAction,DomainError} from './world.ts';
import type {World} from './world.ts';
import {providerXero,providerXeroRoutes} from './provider-xero.ts';
import {parseMajor} from './money.ts';
const operator={id:'xero-operator',role:'operator'} as const,controller={id:'independent-controller',role:'controller'} as const;
const fresh=()=>createWorld({kind:'saas-collections',orderCount:3});
function request(w:World,path:string,method='GET',input?:any,headers?:Headers){const url=new URL('/api.xro/2.0'+path,'http://local.test');return providerXero({system:'xero',world:w,route:url.pathname,url,method,input,headers,execute:action=>applyAction(w,action,operator).result});}
const native=(status='DRAFT',value:any='1.01')=>({ManualJournals:[{Narration:'Source-backed adjustment',Date:'2026-10-24',Status:status,LineAmountTypes:'NoTax',JournalLines:[{AccountCode:'expenses',LineAmount:value,Description:'Actual operating cost',TaxType:'NONE'},{AccountCode:'equity',LineAmount:typeof value==='number'?-value:'-'+value,Description:'Offset',TaxType:'NONE'}],finance_world:{source_document_ids:['policy-payments']}}]});
function submit(row:any){return {ManualJournals:[{ManualJournalID:row.ManualJournalID,Status:'POSTED',finance_world:{version:row.finance_world.version}}]};}
async function denied(w:World,path:string,method:string,input:any,code?:string){const before=JSON.stringify(w);await assert.rejects(()=>request(w,path,method,input),(error:any)=>error instanceof DomainError&&(!code||error.code===code));assert.equal(JSON.stringify(w),before);}

test('Xero organisation/accounts/contacts preserve actual identity without fabricating legal, tax or disabled-route archive state',async()=>{
  const w=fresh(),before=JSON.stringify(w),organisation=(await request(w,'/Organisation'))!.body.Organisations[0];
  assert.equal(organisation.OrganisationID,w.id);assert.equal(organisation.Name,w.name);assert.equal(organisation.BaseCurrency,'USD');for(const key of ['LegalName','TaxNumber','PaysTax','CountryCode','FinancialYearEndDay'])assert.equal(organisation[key],undefined);
  const accounts=(await request(w,'/Accounts?where=Type%3D%3D%22BANK%22'))!.body.Accounts;assert.equal(accounts.length,1);assert.equal(accounts[0].Code,'cash-bank');assert.equal(accounts[0].CurrencyCode,'USD');assert.equal(accounts[0].TaxType,undefined);assert.equal(accounts[0].finance_world.balance_decimal,(w.accounts.find(a=>a.id==='cash-bank').balance_minor/100).toFixed(2));
  const customer=(await request(w,'/Contacts/'+w.customers[0].id))!.body.Contacts[0];assert.equal(customer.IsCustomer,true);assert.equal(customer.IsSupplier,false);assert.equal(customer.EmailAddress,w.customers[0].email);for(const key of ['TaxNumber','BankAccountDetails','Addresses','UpdatedDateUTC'])assert.equal(customer[key],undefined);
  assert.equal(JSON.stringify(w),before);
  const foreign=createWorld({kind:'foreign-service-close',orderCount:1});foreign.foreignCounterparties[0].route_enabled=false;const disabled=(await request(foreign,'/Contacts/'+foreign.foreignCounterparties[0].id))!.body.Contacts[0];assert.equal(disabled.ContactStatus,'ACTIVE');assert.equal(disabled.finance_world.route_enabled,false);
});

test('Xero receivables and payables use native denomination and retain exact foreign source/functional metadata',async()=>{
  for(const currency of ['EUR','JPY','KWD'] as const){const w=createWorld({kind:'foreign-service-close',orderCount:1,foreignControls:{currency}}),source=w.foreignInvoices[0];source.amount_minor=999999999999;source.amount_settled_minor=123;
    const out=(await request(w,'/Invoices/'+source.id))!.body.Invoices[0];assert.equal(out.Type,'ACCREC');assert.equal(out.CurrencyCode,currency);assert.equal(parseMajor(String(out.Total),currency),source.amount_minor);assert.equal(out.finance_world.native_amount_minor,source.amount_minor);assert.equal(parseMajor(out.finance_world.total_decimal,currency),source.amount_minor);assert.deepEqual(out.finance_world.recognition_quote,source.recognition_quote_snapshot);assert.equal(out.finance_world.carrying_minor,source.carrying_minor);
    for(const key of ['LineItems','TotalTax','SubTotal','CurrencyRate','LineAmountTypes'])assert.equal(out[key],undefined);
    const bill=(await request(w,'/Invoices/'+w.foreignBills[0].id))!.body.Invoices[0];assert.equal(bill.Type,'ACCPAY');assert.equal(bill.CurrencyCode,currency);assert.equal(bill.Contact.ContactID,w.foreignBills[0].counterparty_id);
    const ar=(await request(w,'/Invoices?where='+encodeURIComponent('Type=="ACCREC" AND AmountDue>0.5')) )!.body.Invoices;assert.equal(ar.length,1);
  }
});

test('Xero procurement bill detail includes only the actual matched supplier invoice lines',async()=>{
  const w=createWorld({kind:'procurement-matching',orderCount:4}),source=w.supplierInvoices[0];applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:source.id},operator);const bill=w.bills.find(b=>b.supplier_invoice_id===source.id),row=(await request(w,'/Invoices/'+bill.id))!.body.Invoices[0];
  assert.equal(row.Type,'ACCPAY');assert.equal(row.InvoiceNumber,source.invoice_number);assert.equal(row.LineItems.length,source.lines.length);assert.equal(row.finance_world.source_line_items_available,true);
  for(let i=0;i<source.lines.length;i++){const line=source.lines[i],native=row.LineItems[i];assert.equal(native.Quantity,line.quantity);assert.equal(native.UnitAmount,line.unit_price_minor/100);assert.equal(native.LineAmount,line.quantity*line.unit_price_minor/100);for(const key of ['TaxType','TaxAmount','AccountCode'])assert.equal(native[key],undefined);}
  const list=(await request(w,'/Invoices'))!.body.Invoices;assert.equal(list.find((r:any)=>r.InvoiceID===bill.id).LineItems,undefined);assert.ok((await request(w,'/Invoices?page=1'))!.body.Invoices.find((r:any)=>r.InvoiceID===bill.id).LineItems);
  assert.equal((await request(w,'/Invoices?summaryOnly=true&page=1'))!.body.Invoices.find((r:any)=>r.InvoiceID===bill.id).LineItems,undefined);
});

test('Xero lists apply typed exact filters, stable ordering and real page boundaries',async()=>{
  const w=fresh(),ids:string[]=[];for(let page=1;page<=3;page++){const result=(await request(w,`/Invoices?page=${page}&pageSize=1&order=InvoiceID%20DESC`))!.body;ids.push(result.Invoices[0].InvoiceID);assert.equal(result.pagination.itemCount,3);assert.equal(result.pagination.pageCount,3);}assert.deepEqual(ids,w.invoices.map(r=>r.id).reverse());assert.deepEqual((await request(w,'/Invoices?page=4&pageSize=1'))!.body.Invoices,[]);
  const source=w.invoices[0],filter=`Type=="ACCREC" AND Contact.ContactID==guid("${source.customer_id}") AND AmountDue>=${source.amount_minor/100}`;assert.equal((await request(w,'/Invoices?where='+encodeURIComponent(filter)))!.body.Invoices[0].InvoiceID,source.id);
  assert.equal((await request(w,'/Invoices?IDs='+source.id+'&Statuses=AUTHORISED&ContactIDs='+source.customer_id))!.body.Invoices.length,1);
  w.customers[0].name='Café Studio';assert.equal((await request(w,'/Contacts?where='+encodeURIComponent('Name=="CAFE STUDIO" AND IsCustomer==true')))!.body.Contacts[0].ContactID,source.customer_id);
  assert.equal((await request(w,'/Contacts?summaryOnly=true'))!.body.Contacts[0].IsCustomer,undefined);
});

test('invalid filters fail explicitly without 500s, coercion, ignored conditions or source changes',async()=>{
  const w=fresh();for(const [resource,where] of [['Contacts','Name==true'],['Contacts','IsCustomer=="true"'],['Contacts','Name==DateTime(2026,1,1)'],['Invoices','Date==DateTime(2026,99,1)'],['Invoices','DueDate==DateTime(2026,2,30)'],['Invoices','AmountDue>"0"'],['Invoices','Status=="PAID" OR Type=="ACCREC"'],['Accounts','Code.Contains("cash")'],['Invoices','Type=="ACCREC" AND']]){const before=JSON.stringify(w);await assert.rejects(()=>request(w,'/'+resource+'?where='+encodeURIComponent(where)),(error:any)=>error instanceof DomainError&&error.status>=400&&error.status<500||error instanceof DomainError&&error.status===501);assert.equal(JSON.stringify(w),before);}
  for(const path of ['/Invoices?pageSize=10','/Invoices?page=0','/Invoices?pageSize=1001&page=1','/Invoices?Statuses=FAKE','/Invoices?order=Date%20DOWN','/Invoices?createdByMyApp=true','/Accounts?page=1','/Contacts?IDs=a,a','/Invoices?where=Type%3D%3D%22ACCREC%22&where=Status%3D%3D%22PAID%22'])await denied(w,path,'GET',undefined);
  await assert.rejects(()=>request(w,'/Invoices','GET',undefined,new Headers({'If-Modified-Since':'2026-01-01T00:00:00'})),(e:any)=>e.code==='unsupported_header');
});

test('native draft, submit, approval and actual journal read retain one-cent precision and independent status',async()=>{
  const w=fresh(),financial=JSON.stringify({bank:w.bankTransactions,accounts:w.accounts,journals:w.journals});const created=await request(w,'/ManualJournals','PUT',native()),row=created!.body.ManualJournals[0];assert.equal(created!.status,200);assert.equal(row.Status,'DRAFT');assert.equal(row.JournalLines[0].LineAmount,1.01);assert.equal(row.JournalLines[1].LineAmount,-1.01);assert.equal(row.finance_world.total_debit_minor,101);assert.equal(row.finance_world.source_documents,undefined);assert.deepEqual(row.finance_world.source_document_ids,['policy-payments']);assert.equal(JSON.stringify({bank:w.bankTransactions,accounts:w.accounts,journals:w.journals}),financial);
  const accepted=await request(w,'/ManualJournals/'+row.ManualJournalID,'POST',submit(row)),pending=accepted!.body.ManualJournals[0];assert.equal(accepted!.status,202);assert.equal(pending.Status,'DRAFT');assert.equal(pending.finance_world.canonical_status,'awaiting_approval');assert.equal(pending.finance_world.journal_id,null);
  applyAction(w,{type:'decide_approval',approval_id:pending.finance_world.approval_id,decision:'approve'},controller);
  const posted=(await request(w,'/ManualJournals/'+row.ManualJournalID))!.body.ManualJournals[0];assert.equal(posted.Status,'POSTED');assert.equal(posted.finance_world.canonical_status,'posted');const proof=(await request(w,'/Journals/'+posted.finance_world.journal_id))!.body.Journals[0];assert.equal(proof.finance_world.source_id,row.ManualJournalID);assert.equal(proof.finance_world.source_type,'manual_journal');assert.equal(proof.JournalLines[0].NetAmount,1.01);assert.equal(proof.JournalLines[0].Description,'Actual operating cost');assert.equal(proof.SourceID,undefined);assert.equal(proof.SourceType,undefined);assert.equal(proof.JournalLines[0].TaxAmount,undefined);
  assert.equal((await request(w,'/ManualJournals'))!.body.ManualJournals[0].JournalLines,undefined);assert.equal((await request(w,'/ManualJournals?page=1'))!.body.ManualJournals[0].JournalLines.length,2);
});

test('requested native POSTED creates one approval request, never an immediate posted journal or editable replacement',async()=>{
  const w=fresh(),original=w.journals.length,res=await request(w,'/ManualJournals','PUT',native('POSTED','0.01')),row=res!.body.ManualJournals[0];assert.equal(res!.status,202);assert.equal(row.Status,'DRAFT');assert.equal(w.journals.length,original);assert.equal(w.manualJournals.length,1);assert.equal(w.approvals.length,1);
  await denied(w,'/ManualJournals/'+row.ManualJournalID,'POST',{ManualJournals:[{...submit(row).ManualJournals[0],Narration:'Rewrite'}]},'unsupported_field');
  applyAction(w,{type:'decide_approval',approval_id:row.finance_world.approval_id,decision:'reject'},controller);const rejected=(await request(w,'/ManualJournals/'+row.ManualJournalID))!.body.ManualJournals[0];assert.equal(rejected.Status,'DRAFT');assert.equal(rejected.finance_world.canonical_status,'rejected');assert.equal(rejected.finance_world.journal_id,null);
});

test('unsupported tax, decimal fractions, oversize amounts, bulk writes and fabricated source fields cannot mutate the world',async()=>{
  const w=fresh();for(const value of ['0.001',0.1+0.2,'1e2','NaN','10000000000.01',0,'-1'])await denied(w,'/ManualJournals','PUT',native('DRAFT',value));
  for(const mutation of [(body:any)=>body.ManualJournals.push(body.ManualJournals[0]),(body:any)=>body.ManualJournals[0].LineAmountTypes='Inclusive',(body:any)=>body.ManualJournals[0].JournalLines[0].TaxType='OUTPUT',(body:any)=>body.ManualJournals[0].JournalLines[0].TaxAmount=0,(body:any)=>body.ManualJournals[0].JournalLines[0].Tracking=[],(body:any)=>body.ManualJournals[0].finance_world.source_documents=[],(body:any)=>body.ManualJournals[0].Status='VOIDED',(body:any)=>body.ManualJournals[0].JournalLines[0].AccountCode='cash-bank']){const body=native();mutation(body);await denied(w,'/ManualJournals','PUT',body);}
  const cap=await request(w,'/ManualJournals','PUT',native('DRAFT','10000000000.00'));assert.equal(cap!.body.ManualJournals[0].finance_world.total_debit_minor,1e12);assert.equal(cap!.body.ManualJournals[0].JournalLines[0].LineAmount,1e10);
});

test('posted status requires actual matching GL proof and approved independent source decision',async()=>{
  const w=fresh(),pending=(await request(w,'/ManualJournals','PUT',native('POSTED')))!.body.ManualJournals[0];applyAction(w,{type:'decide_approval',approval_id:pending.finance_world.approval_id,decision:'approve'},controller);const record=w.manualJournals[0],id=record.id;
  const mutations=[(x:World)=>x.journals.find(j=>j.id===record.journal_id).source_type='manual',(x:World)=>x.journals.find(j=>j.id===record.journal_id).currency='EUR',(x:World)=>x.journals.find(j=>j.id===record.journal_id).lines[0].debit_minor++,(x:World)=>x.approvals.find(a=>a.id===record.approval_id).status='pending',(x:World)=>x.approvals.find(a=>a.id===record.approval_id).decided_by=record.created_by];
  for(const mutate of mutations){const corrupt=structuredClone(w);mutate(corrupt);await assert.rejects(()=>request(corrupt,'/ManualJournals/'+id),(e:any)=>e.code==='manual_journal_proof_missing');}
});

test('tenant, source IDs, method boundaries and raw journal reads preserve the exact scoped world',async()=>{
  const w=fresh(),before=JSON.stringify(w);await assert.rejects(()=>request(w,'/Organisation','GET',undefined,new Headers({'Xero-Tenant-Id':'another-world'})),(e:any)=>e.status===403);assert.equal((await request(w,'/Organisation','GET',undefined,new Headers({'Xero-Tenant-Id':w.id})))!.body.Organisations[0].OrganisationID,w.id);
  await denied(w,'/ManualJournals','PUT',{ManualJournals:[{...native().ManualJournals[0],finance_world:{source_document_ids:['nonexistent']}}]});for(const path of ['/Invoices','/Contacts','/Accounts'])await denied(w,path,'POST',{});await denied(w,'/ManualJournals','POST',native());assert.equal(await request(w,'/Journals'),undefined);assert.equal((await request(w,'/ManualJournals'))!.body.ManualJournals.length,0);
  const journal=(await request(w,'/Journals/'+w.journals[0].id))!.body.Journals[0];assert.equal(journal.finance_world.functional_currency,'USD');assert.equal(JSON.stringify(w),before);assert.equal(providerXeroRoutes.length,12);assert.equal(providerXeroRoutes.filter(route=>route.access==='write').length,2);
});

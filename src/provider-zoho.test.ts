import {test,expect} from 'bun:test';
import {createWorld,applyAction,DomainError} from './world.ts';
import type {World} from './world.ts';
import {providerZoho,providerZohoRoutes} from './provider-zoho.ts';
import {parseMajor} from './money.ts';
import {manualJournalVersion} from './manual-journals.ts';
const operator={id:'zoho-operator',role:'operator'} as const,controller={id:'independent-reviewer',role:'controller'} as const;
const fresh=()=>createWorld({kind:'saas-collections',orderCount:3});
function request(w:World,path:string,method='GET',input?:any,organization=true){const url=new URL('/books/v3'+path,'http://local.test');if(organization)url.searchParams.set('organization_id',w.id);return providerZoho({world:w,system:'zoho-books',route:url.pathname,url,method,input,execute:action=>applyAction(w,action,operator).result});}
const draft=(value:any='1.01')=>({journal_date:'2026-10-24',notes:'Source-backed adjustment',status:'draft',line_items:[{account_id:'expenses',debit_or_credit:'debit',amount:value,description:'Recorded cost'},{account_id:'equity',debit_or_credit:'credit',amount:value,description:'Offset'}],finance_world:{source_document_ids:['policy-payments']}});
const submit=(row:any)=>({finance_world:{version:row.finance_world.version}});
const finances=(w:World)=>JSON.stringify({bank:w.bankTransactions,accounts:w.accounts,journals:w.journals,operations:w.operations,invoices:w.invoices,bills:w.bills});
async function denied(w:World,path:string,method='GET',input?:any,code?:string,organization=true){const before=JSON.stringify(w);await expect(request(w,path,method,input,organization)).rejects.toThrowSatisfying((error:any)=>error instanceof DomainError&&(!code||error.code===code));expect(JSON.stringify(w)).toBe(before);}

test('Zoho scope is required exactly once, routes are explicit, and reads do not migrate existing worlds',async()=>{
  const w=fresh();delete w.manualJournals;const exact=JSON.stringify(w);await denied(w,'/contacts','GET',undefined,'organization_required',false);await denied(w,'/contacts?organization_id=another','GET',undefined,'organization_mismatch',false);await denied(w,`/contacts?organization_id=${w.id}&organization_id=${w.id}`,'GET',undefined,'organization_required',false);
  expect((await request(w,'/journals'))!.body.journals.length).toBe(0);expect(JSON.stringify(w)).toBe(exact);expect(providerZohoRoutes.length).toBe(12);expect(providerZohoRoutes.filter(route=>route.access==='write').length).toBe(2);
  expect(await request(w,'/payments')).toBeUndefined();expect(await request(w,'/journals/missing/approve','POST',{})).toBeUndefined();for(const resource of ['invoices','bills','contacts','chartofaccounts'])await denied(w,'/'+resource,'POST',{},'unsupported_operation');await denied(w,'/journals/id','PUT',{},'unsupported_operation');await denied(w,'/contacts/foreign-world-id','GET',undefined,'resource_missing');
});

test('Zoho contact/account reads preserve actual facts and separate native cash from USD functional balances',async()=>{
  const w=createWorld({kind:'treasury-fx',orderCount:2}),exact=JSON.stringify(w),list=(await request(w,'/chartofaccounts?showbalance=true'))!.body.chartofaccounts;
  for(const row of list){const account=w.accounts.find(a=>a.id===row.account_id);expect(row.finance_world.functional_balance_minor).toBe(account.balance_minor);expect(row.finance_world.functional_currency).toBe('USD');for(const field of ['tax_id','parent_account_id','created_time','last_modified_time'])expect(row[field]).toBeUndefined();}
  const bank=list.find((row:any)=>row.currency_code!=='USD');expect(bank).toBeTruthy();expect(parseMajor(String(bank.current_balance),bank.currency_code)).toBe(bank.finance_world.native_balance_minor);expect(bank.finance_world.native_balance_minor).not.toBe(bank.finance_world.functional_balance_minor);expect((await request(w,'/chartofaccounts/'+bank.account_id))!.body.chart_of_account.current_balance).toBeUndefined();
  const customers=fresh(),customer=(await request(customers,'/contacts/'+customers.customers[0].id))!.body.contact;expect(customer.contact_name).toBe(customers.customers[0].name);expect(customer.contact_type).toBe('customer');expect(customer.email).toMatch(/\.test$/);for(const field of ['company_name','billing_address','tax_id','first_name','created_time'])expect(customer[field]).toBeUndefined();expect(JSON.stringify(w)).toBe(exact);
  const foreign=createWorld({kind:'foreign-service-close',orderCount:1});foreign.foreignCounterparties[0].route_enabled=false;const disabled=(await request(foreign,'/contacts/'+foreign.foreignCounterparties[0].id))!.body.contact;expect(disabled.status).toBe('active');expect(disabled.finance_world.route_enabled).toBe(false);
});

test('Zoho AR/AP reads use exact source denominations, genuine dates and no fabricated tax or service lines',async()=>{
  for(const currency of ['EUR','JPY','KWD'] as const){const w=createWorld({kind:'foreign-service-close',orderCount:1,foreignControls:{currency}}),source=w.foreignInvoices[0],bill=w.foreignBills[0];source.amount_minor=999999999999;source.amount_settled_minor=123;
    const row=(await request(w,'/invoices/'+source.id))!.body.invoice;expect(row.status).toBe('partially_paid');expect(row.currency_code).toBe(currency);expect(parseMajor(String(row.total),currency)).toBe(source.amount_minor);expect(row.finance_world.native_due_minor).toBe(source.amount_minor-123);expect(row.date).toBe(source.issued_at.slice(0,10));expect(row.finance_world.recognition_quote).toStrictEqual(source.recognition_quote_snapshot);expect(row.finance_world.carrying_minor).toBe(source.carrying_minor);for(const key of ['line_items','tax_total','sub_total','exchange_rate','currency_id','sent_date','created_time'])expect(row[key]).toBeUndefined();
    const payable=(await request(w,'/bills/'+bill.id))!.body.bill;expect(payable.currency_code).toBe(currency);expect(payable.vendor_id).toBe(bill.counterparty_id);expect(payable.finance_world.native_amount_minor).toBe(bill.amount_minor);expect(payable.finance_world.canonical_kind).toBe('bill');
    expect((await request(w,'/invoices?total='+row.finance_world.total_decimal))!.body.invoices.length).toBe(1);
  }
  const legacy=createWorld({kind:'supplier-fraud',orderCount:1}),bill=legacy.bills[0];expect(bill.issued_at).toBeUndefined();expect((await request(legacy,'/bills/'+bill.id))!.body.bill.date).toBeUndefined();
});

test('Zoho procurement bills expose only matched source lines and preserve invoice identity',async()=>{
  const w=createWorld({kind:'procurement-matching',orderCount:4}),source=w.supplierInvoices[0];applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:source.id},operator);const bill=w.bills.find(row=>row.supplier_invoice_id===source.id),out=(await request(w,'/bills/'+bill.id))!.body.bill;
  expect(out.bill_number).toBe(source.invoice_number);expect(out.date).toBe(source.received_at.slice(0,10));expect(out.line_items.length).toBe(source.lines.length);expect(out.finance_world.source_line_items_available).toBe(true);
  for(let i=0;i<source.lines.length;i++){expect(out.line_items[i].quantity).toBe(source.lines[i].quantity);expect(out.line_items[i].rate).toBe(source.lines[i].unit_price_minor/100);expect(out.line_items[i].item_total).toBe(source.lines[i].quantity*source.lines[i].unit_price_minor/100);for(const key of ['tax_id','tax_percentage','tax_amount','account_id'])expect(out.line_items[i][key]).toBeUndefined();}
  expect((await request(w,'/bills'))!.body.bills.find((row:any)=>row.bill_id===bill.id).line_items).toBeUndefined();
});

test('Zoho documented filter subset is exact, deterministic and paginated',async()=>{
  const w=fresh(),ids:string[]=[];for(let page=1;page<=3;page++){const res=(await request(w,`/invoices?page=${page}&per_page=1&sort_column=invoice_number&sort_order=D`))!.body;ids.push(res.invoices[0].invoice_id);expect(res.page_context.has_more_page).toBe(page<3);expect(res.page_context.per_page).toBe(1);}expect(ids).toStrictEqual(w.invoices.map(row=>row.id).reverse());expect((await request(w,'/invoices?page=4&per_page=1'))!.body.invoices).toStrictEqual([]);
  const source=w.invoices[0];expect((await request(w,'/invoices?customer_id='+source.customer_id+'&total='+source.amount_minor/100))!.body.invoices[0].invoice_id).toBe(source.id);expect((await request(w,'/invoices?date_after=2026-10-24'))!.body.invoices.length).toBe(0);
  w.customers[0].name='Notebook Studio';expect((await request(w,'/contacts?contact_name_contains=BOOK&contact_type=customer'))!.body.contacts[0].contact_id).toBe(w.customers[0].id);expect((await request(w,'/contacts?filter_by=Status.Inactive'))!.body.contacts.length).toBe(0);
  const accounts=(await request(w,'/chartofaccounts?account_code_starts_with=cash&filter_by=AccountType.Asset'))!.body.chartofaccounts;expect(accounts.map((row:any)=>row.account_id)).toStrictEqual(w.accounts.filter(row=>row.id.startsWith('cash')&&row.type==='asset').toSorted((a,b)=>a.name.localeCompare(b.name)).map(row=>row.id));expect((await request(w,'/chartofaccounts?account_id_not_equal=cash-bank'))!.body.chartofaccounts.every((row:any)=>row.account_id!=='cash-bank')).toBeTruthy();
});

test('Zoho malformed/unsupported filters fail before empty collection iteration or mutation',async()=>{
  const w=fresh();for(const path of ['/invoices?page=0','/bills?per_page=201','/contacts?page=1&page=2','/invoices?date=2026-02-30','/invoices?date=2026-99-01','/invoices?total=1e2','/journals?total=not-money','/journals?date_before=bad','/contacts?contact_type=both','/contacts?filter_by=Status.PortalEnabled','/invoices?status=invalid','/invoices?sort_order=DESC','/invoices?sort_column=created_time','/invoices?tax_id=NONE','/invoices?response_option=3','/chartofaccounts?showbalance=yes','/contacts?email=','/journals?journal_ids=x,x','/contacts?last_modified_time=2026-10-24'])await denied(w,path);
  await denied(w,'/invoices/'+w.invoices[0].id+'?fields=total');
});

test('Zoho native draft/submit/controller/published sequence preserves source and actual GL proof without cash writes',async()=>{
  const w=fresh(),financial=finances(w),created=await request(w,'/journals','POST',draft()),row=created!.body.journal;expect(created!.status).toBe(201);expect(row.status).toBe('draft');expect(row.finance_world.accounting_system).toBe('zoho-books');expect(row.finance_world.read_only).toBe(false);expect(row.line_items[0].amount).toBe(1.01);expect(row.finance_world.source_documents).toBeUndefined();expect(row.finance_world.source_document_ids).toStrictEqual(['policy-payments']);expect(finances(w)).toBe(financial);
  const pending=await request(w,'/journals/'+row.journal_id+'/submit','POST',submit(row)),accepted=pending!.body.journal;expect(pending!.status).toBe(202);expect(accepted.status).toBe('submitted');expect(accepted.finance_world.canonical_status).toBe('awaiting_approval');expect(accepted.finance_world.journal_id).toBeNull();expect(finances(w)).toBe(financial);expect(w.approvals.length).toBe(1);
  await denied(w,'/journals/'+row.journal_id+'/submit','POST',submit(row),'manual_journal_version_conflict');
  applyAction(w,{type:'decide_approval',approval_id:accepted.finance_world.approval_id,decision:'approve'},controller);const published=(await request(w,'/journals/'+row.journal_id))!.body.journal;expect(published.status).toBe('published');expect(published.finance_world.journal_lines_verified).toBe(true);const journal=w.journals.find(j=>j.id===published.finance_world.journal_id);expect(journal.source_type).toBe('manual_journal');expect(journal.source_id).toBe(row.journal_id);expect(journal.lines[0].debit_minor).toBe(101);expect(journal.lines[0].description).toBe('Recorded cost');expect(published.line_items).toStrictEqual(row.line_items);
  const list=(await request(w,'/journals?status=published&account_id=expenses&total_greater_equals=1.01&filter_by=JournalDate.Today'))!.body.journals;expect(list.length).toBe(1);expect(list[0].line_items).toBeUndefined();expect(list[0].finance_world.source_documents).toBeUndefined();
});

test('Zoho cannot read or adopt other-provider drafts, but mirrors genuinely posted proposals read-only',async()=>{
  const w=fresh(),foreign=applyAction(w,{type:'prepare_manual_journal',description:'Xero source proposal',source_document_ids:['policy-payments'],lines:[{account_id:'expenses',debit_minor:101},{account_id:'equity',credit_minor:101}]},operator).result.manual_journal;
  await denied(w,'/journals/'+foreign.id,'GET',undefined,'resource_missing');await denied(w,'/journals/'+foreign.id+'/submit','POST',{finance_world:{version:manualJournalVersion(foreign)}},'manual_journal_origin_mismatch');expect((await request(w,'/journals'))!.body.journals).toStrictEqual([]);
  const submitted=applyAction(w,{type:'submit_manual_journal',manual_journal_id:foreign.id,version:manualJournalVersion(foreign)},operator).result;await denied(w,'/journals/'+foreign.id,'GET',undefined,'resource_missing');applyAction(w,{type:'decide_approval',approval_id:submitted.approval_id,decision:'approve'},controller);
  const mirror=(await request(w,'/journals/'+foreign.id))!.body.journal;expect(mirror.status).toBe('published');expect(mirror.finance_world.read_only).toBe(true);expect(mirror.finance_world.accounting_system).toBe('xero');await denied(w,'/journals/'+foreign.id+'/submit','POST',submit(mirror),'manual_journal_origin_mismatch');expect((await request(w,'/journals'))!.body.journals.length).toBe(1);expect(w.journals.length>1).toBeTruthy();
});

test('Zoho rejected, stale and unavailable drafts never claim publication; only originating provider faults apply',async()=>{
  const w=fresh();applyAction(w,{type:'set_fault',system:'xero',mode:'offline'},controller);const row=(await request(w,'/journals','POST',draft('0.01')))!.body.journal,pending=(await request(w,'/journals/'+row.journal_id+'/submit','POST',submit(row)))!.body.journal;
  applyAction(w,{type:'decide_approval',approval_id:pending.finance_world.approval_id,decision:'reject'},controller);const rejected=(await request(w,'/journals/'+row.journal_id))!.body.journal;expect(rejected.status).toBe('rejected');expect(rejected.finance_world.journal_id).toBeNull();await denied(w,'/journals/'+row.journal_id+'/submit','POST',submit(rejected),'manual_journal_not_draft');
  applyAction(w,{type:'set_fault',system:'zoho-books',mode:'offline'},controller);await denied(w,'/journals','POST',draft());applyAction(w,{type:'set_fault',system:'zoho-books',mode:'healthy'},controller);const stale=(await request(w,'/journals','POST',draft()))!.body.journal;applyAction(w,{type:'advance_time',hours:24},controller);await denied(w,'/journals/'+stale.journal_id+'/submit','POST',submit(stale),'manual_journal_date_changed');
});

test('Zoho draft validation rejects fictitious tax, precision loss, bulk writes, posting bypass and source changes atomically',async()=>{
  const w=fresh();for(const value of ['0.001',0.1+0.2,'1e2','NaN','10000000000.01','-1',0])await denied(w,'/journals','POST',draft(value));
  for(const mutate of [(b:any)=>b.status='published',(b:any)=>b.currency_id='USD',(b:any)=>b.exchange_rate=1,(b:any)=>b.reference_number='invented',(b:any)=>b.line_items[0].tax_id='NONE',(b:any)=>b.line_items[0].tax_percentage=0,(b:any)=>b.line_items[0].debit_or_credit='both',(b:any)=>b.line_items[0].account_id='cash-bank',(b:any)=>b.finance_world.approved=true,(b:any)=>b.finance_world.source_document_ids=['missing'],(b:any)=>b.journal_date='2026-02-30']){const body=draft();mutate(body);await denied(w,'/journals','POST',body);}
  await denied(w,'/journals','POST',[draft()]);const cap=(await request(w,'/journals','POST',draft('10000000000.00')))!.body.journal;expect(cap.finance_world.total_debit_minor).toBe(1e12);expect(cap.total).toBe(1e10);
});

test('Zoho published status fails closed on forged GL, currency, provider, source or approval proof',async()=>{
  const w=fresh(),draftRow=(await request(w,'/journals','POST',draft()))!.body.journal,pending=(await request(w,'/journals/'+draftRow.journal_id+'/submit','POST',submit(draftRow)))!.body.journal;applyAction(w,{type:'decide_approval',approval_id:pending.finance_world.approval_id,decision:'approve'},controller);const record=w.manualJournals[0];
  const mutations=[(x:World)=>x.journals.find(j=>j.id===record.journal_id).source_type='manual',(x:World)=>x.journals.find(j=>j.id===record.journal_id).currency='EUR',(x:World)=>x.journals.find(j=>j.id===record.journal_id).lines[0].debit_minor++,(x:World)=>x.journals.find(j=>j.id===record.journal_id).lines[0].description='forged',(x:World)=>x.approvals.find(a=>a.id===record.approval_id).status='pending',(x:World)=>x.approvals.find(a=>a.id===record.approval_id).decided_by=record.created_by,(x:World)=>x.approvals.find(a=>a.id===record.approval_id).action.accounting_system='xero',(x:World)=>x.approvals.find(a=>a.id===record.approval_id).action.source_version='wrong'];
  for(const mutate of mutations){const corrupt=structuredClone(w);mutate(corrupt);await denied(corrupt,'/journals/'+record.id,'GET',undefined,'manual_journal_proof_missing');}
});

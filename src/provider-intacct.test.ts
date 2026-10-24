import {test,expect} from 'bun:test';
import {createWorld,applyAction,DomainError} from './world.ts';
import type {World,Action} from './world.ts';
import {providerIntacct,providerIntacctRoutes} from './provider-intacct.ts';
import {manualJournalVersion} from './manual-journals.ts';
const operator={id:'sage-accountant',role:'operator'} as const,controller={id:'sage-source-controller',role:'controller'} as const,reviewer={id:'sage-independent-reviewer',role:'controller'} as const;
const BASE='/ia/api/v1';
function request(w:World,path:string,method='GET',input?:any){const url=new URL(BASE+path,'http://local.test');return providerIntacct({system:'sage-intacct',world:w,route:url.pathname,url,method,input,execute:action=>applyAction(w,action,operator).result});}
const fresh=()=>createWorld({kind:'period-close',orderCount:3});
const ledgerOpen=(w:World)=>applyAction(w,{type:'reopen_period'},controller);
const register=(w:World)=>applyAction(w,{type:'record_journal_register',accounting_system:'sage-intacct',code:'GJ',name:'Recorded general adjustment register',external_event_id:'sage-register-source'},controller).result.journal_register;
const native=(state:any='draft',amount:any='0.01')=>({glJournal:{id:'GJ'},postingDate:'2026-10-24',description:'Controller-source operating adjustment',...(state===undefined?{}:{state}),lines:[{txnType:'debit',txnAmount:amount,glAccount:{id:'expenses'},description:'Expense supported by attached source'},{txnType:'credit',txnAmount:amount,glAccount:{id:'equity'},description:'Reviewed source offset'}],finance_world:{source_document_ids:['policy-payments']}});
const result=(res:any)=>res!.body['ia::result'];
const query=(w:World,input:any)=>request(w,'/services/core/query','POST',input);
async function denied(w:World,path:string,method:string,input:any,code?:string){const before=structuredClone(w);await expect(request(w,path,method,input)).rejects.toThrowSatisfying((error:any)=>error instanceof DomainError&&(!code||error.code===code));expect(w).toStrictEqual(before);}
const financial=(w:World)=>structuredClone({bank:w.bankTransactions,journals:w.journals,operations:w.operations,accounts:w.accounts});
function submit(w:World,id:string){const row=w.manualJournals.find((r:any)=>r.id===id);return applyAction(w,{type:'submit_manual_journal',manual_journal_id:id,version:manualJournalVersion(row),accounting_system:'sage-intacct'},operator).result;}
function decide(w:World,approval_id:string,decision='approve'){return applyAction(w,{type:'decide_approval',approval_id,decision},reviewer).result;}

test('Sage object references and account/contact reads retain source identity without inventing registers, books or legal/tax facts',async()=>{
 const w=fresh(),before=structuredClone(w);expect(result(await request(w,'/objects/general-ledger/journal'))).toStrictEqual([]);
 const refs=result(await request(w,'/objects/general-ledger/account'));expect(refs.length).toBe(w.accounts.length);expect(Object.keys(refs[0]).sort()).toStrictEqual(['href','id','key']);
 const a=result(await request(w,'/objects/general-ledger/account/expenses'));expect(a.key).toBe('expenses');expect(a.id).toBe('expenses');expect(a.accountType).toBe('incomeStatement');expect(a.normalBalance).toBe('debit');expect(a.finance_world.balance_minor).toBe(w.accounts.find(r=>r.id==='expenses').balance_minor);for(const key of ['entity','bookId','taxCode','isTaxable','requireDimensions','audit'])expect(a[key]).toBeUndefined();
 const customer=result(await request(w,'/objects/accounts-receivable/customer/'+w.customers[0].id));expect(customer.name).toBe(w.customers[0].name);expect(customer.contacts.default.email1).toBe(w.customers[0].email);expect(customer.contacts.default.key).toBeUndefined();expect(customer.totalDue).toBeUndefined();expect(customer.entity).toBeUndefined();
 const vendor=result(await request(w,'/objects/accounts-payable/vendor/'+w.vendors[0].id));expect(vendor.name).toBe(w.vendors[0].name);expect(w).toStrictEqual(before);
 const r=register(w),registered=result(await request(w,'/objects/general-ledger/journal/'+r.id));expect(registered.key).toBe(r.id);expect(registered.id).toBe('GJ');expect(registered.enableApproval).toBe(true);expect(registered.bookId).toBeUndefined();expect(registered.bookType).toBeUndefined();expect(registered.entity).toBeUndefined();
});

test('Sage USD AR/AP details use real recognition and settlement history, not invented invoice lines or tax totals',async()=>{
 const w=fresh();ledgerOpen(w);const invoice=w.invoices[0],bill=w.bills[0];
 let ar=result(await request(w,'/objects/accounts-receivable/invoice/'+invoice.id));expect(ar.totalTxnAmount).toBe((invoice.amount_minor/100).toFixed(2));expect(ar.totalBaseAmount).toBe(ar.totalTxnAmount);expect(ar.state).toBe('posted');expect(ar.customer.key).toBe(invoice.customer_id);expect(ar.lines).toBeUndefined();expect(ar.taxSolution).toBeUndefined();expect(ar.invoiceDate).toBe(invoice.issued_at.slice(0,10));expect(ar.finance_world.recognition_journal_id).toBe(w.journals.find(j=>j.source_id===invoice.id).id);
 const partial=123;applyAction(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:partial},operator);applyAction(w,{type:'advance_time',hours:1},controller);ar=result(await request(w,'/objects/accounts-receivable/invoice/'+invoice.id));expect(ar.state).toBe('partiallyPaid');expect(ar.paymentInformation.totalTxnAmountPaid).toBe('1.23');expect(ar.totalTxnAmountDue).toBe(((invoice.amount_minor-partial)/100).toFixed(2));
 const ap=result(await request(w,'/objects/accounts-payable/bill/'+bill.id));expect(ap.state).toBe('posted');expect(ap.vendor.key).toBe(bill.vendor_id);expect(ap.totalTxnAmount).toBe((bill.amount_minor/100).toFixed(2));expect(ap.createdDate).toBeUndefined();expect(ap.postingDate).toBe(w.journals.find(j=>j.source_id===bill.id).posted_at.slice(0,10));
});

test('Sage procurement bills expose only recognized invoices and their actual matched source line allocations',async()=>{
 const w=createWorld({kind:'procurement-matching',orderCount:2}),source=w.supplierInvoices[0];expect(result(await request(w,'/objects/accounts-payable/bill'))).toStrictEqual([]);
 const matched=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:source.id},operator).result,row=result(await request(w,'/objects/accounts-payable/bill/'+matched.bill.id));expect(row.state).toBe('posted');expect(row.lines.length).toBe(source.lines.length);expect(row.billNumber).toBe(source.invoice_number);
 for(let i=0;i<source.lines.length;i++){expect(row.lines[i].txnAmount).toBe((source.lines[i].amount_minor/100).toFixed(2));expect(row.lines[i].lineNumber).toBe(String(i+1));expect(row.lines[i].finance_world.source_allocations).toStrictEqual(w.supplierInvoices.find((s:any)=>s.id===source.id).lines[i].allocations);for(const key of ['taxEntries','hasForm1099','glAccount','key','id'])expect(row.lines[i][key]).toBeUndefined();}
});

test('Sage foreign values retain native/functional separation and reject unsupported third-decimal precision',async()=>{
 for(const currency of ['EUR','JPY'] as const){const w=createWorld({kind:'foreign-service-close',orderCount:1,foreignControls:{currency}}),invoice=w.foreignInvoices[0],row=result(await request(w,'/objects/accounts-receivable/invoice/'+invoice.id));expect(row.currency.txnCurrency).toBe(currency);expect(row.finance_world.amount_minor).toBe(invoice.amount_minor);expect(row.finance_world.carrying_minor).toBe(invoice.carrying_minor);expect(row.totalBaseAmount).toBeUndefined();expect(row.currency.exchangeRate).toBeUndefined();expect(row.finance_world.recognition_quote).toStrictEqual(invoice.recognition_quote_snapshot);expect(row.lines).toBeUndefined();}
 const w=createWorld({kind:'foreign-service-close',orderCount:1,foreignControls:{currency:'KWD'}});w.foreignInvoices[0].amount_minor=1001;await denied(w,'/objects/accounts-receivable/invoice/'+w.foreignInvoices[0].id,'GET',undefined,'unsupported_amount_precision');expect(result(await request(w,'/objects/accounts-receivable/invoice')).some((row:any)=>row.key===w.foreignInvoices[0].id),'Reference listing never rounds or hides the source').toBeTruthy();
});

test('Sage query is read-only with exact decimal/date predicates, flattened related fields, stable order and 1-based paging',async()=>{
 const w=fresh(),before=structuredClone(w),fields=['id','invoiceNumber','customer.id','totalTxnAmountDue','invoiceDate'];const q={object:'accounts-receivable/invoice',fields,filters:[{$eq:{state:'posted'}},{$gte:{totalTxnAmountDue:'0.01'}},{$lt:{invoiceDate:'2026-11-01'}}],orderBy:[{id:'desc'}],size:1};
 const ids=[];for(let start=1;start<=3;start++){const res=(await query(w,{...q,start}))!.body;ids.push(res['ia::result'][0].id);expect(res['ia::meta'].totalCount).toBe(3);expect(res['ia::meta'].next).toBe(start<3?start+1:null);expect(res['ia::meta'].previous).toBe(start>1?start-1:null);expect(res['ia::result'][0].customer).toBeUndefined();expect(res['ia::result'][0]['customer.id']).toBeTruthy();}expect(ids).toStrictEqual(w.invoices.map(row=>row.id).reverse());expect(result(await query(w,{...q,start:4}))).toStrictEqual([]);
 const one=result(await query(w,{object:'accounts-receivable/invoice',fields:['id'],filters:[{$in:{id:[w.invoices[1].id]}}]}));expect(one).toStrictEqual([{id:w.invoices[1].id}]);expect(w).toStrictEqual(before);
});

test('Sage query rejects unsupported clauses and invalid field types even for an empty object collection',async()=>{
 const w=fresh(),q={object:'general-ledger/journal',fields:['key']};for(const [patch,code] of [
  [{fields:['*']},'unsupported_field'],[{fields:['key','key']},'unsupported_field'],[{fields:['lines']},'unsupported_field'],[{filters:[{$eq:{enableApproval:'true'}}]},'invalid_filter'],[{filters:[{$eq:{name:true}}]},'invalid_filter'],[{filters:[{$contains:{name:'G'}}]},'unsupported_field'],[{filters:[{$eq:{unknown:'x'}}]},'unsupported_filter'],[{filterExpression:'or'},'unsupported_filter'],[{filterParameters:{includePrivate:true}},'unsupported_field'],[{orderBy:[{href:'asc'}]},'unsupported_filter'],[{orderBy:[{name:'ASC'}]},'unsupported_filter'],[{start:0},'invalid_parameter'],[{size:4001},'invalid_parameter'],[{size:null},'invalid_parameter'],[{fields:['sum:key']},'unsupported_field'],
 ] as [any,string][])await denied(w,'/services/core/query','POST',{...q,...patch},code);
 await denied(w,'/services/core/query','POST',{object:'general-ledger/journal-entry',fields:['id'],filters:[{$eq:{postingDate:'2026-02-30'}}]},'invalid_filter');await denied(w,'/services/core/query','POST',{object:'accounts-payable/bill',fields:['id'],filters:[{$gt:{totalTxnAmount:'0.001'}}]},'invalid_filter');await denied(w,'/services/core/query','POST',[q],'invalid_body');await denied(w,'/objects/accounts-payable/bill?where=state','GET',undefined,'unsupported_filter');
});

test('Sage native draft and canonical submit use one stable source proposal; only independent posting becomes posted',async()=>{
 const w=fresh(),r=register(w),before=financial(w),created=await request(w,'/objects/general-ledger/journal-entry','POST',native()),reference=result(created);expect(created!.status).toBe(201);expect(reference.key).toBe(reference.id);expect(reference.finance_world.canonical_status).toBe('draft');expect(financial(w)).toStrictEqual(before);expect(w.approvals.length).toBe(0);
 let detail=result(await request(w,'/objects/general-ledger/journal-entry/'+reference.key));expect(detail.state).toBe('draft');expect(detail.glJournal.key).toBe(r.id);expect(detail.glJournal.id).toBe(r.code);expect(detail.lines[0].txnAmount).toBe('0.01');expect(detail.lines[0].txnType).toBe('debit');expect(detail.lines[1].txnType).toBe('credit');expect(detail.finance_world.source_documents).toBeUndefined();expect(detail.finance_world.source_document_ids).toStrictEqual(['policy-payments']);expect(detail.finance_world.draft_submit_action.accounting_system).toBe('sage-intacct');
 await denied(w,'/objects/general-ledger/journal-entry/'+reference.key,'PATCH',{state:'posted'},'unsupported_operation');ledgerOpen(w);const pending=submit(w,reference.key);expect(pending.status).toBe('awaiting_approval');expect(financial(w)).toStrictEqual(before);
 decide(w,pending.approval_id);detail=result(await request(w,'/objects/general-ledger/journal-entry/'+reference.key));expect(detail.state).toBe('posted');expect(detail.finance_world.canonical_status).toBe('posted');expect(w.journals.length).toBe(before.journals.length+1);expect(detail.finance_world.journal_id).toBe(w.manualJournals[0].journal_id);expect(detail.lines[0].description).toBe('Expense supported by attached source');expect(w.bankTransactions).toStrictEqual(before.bank);expect(w.operations).toStrictEqual(before.operations);
 const refs=result(await request(w,'/objects/general-ledger/journal-entry'));expect(refs.filter((x:any)=>x.key===reference.key).length).toBe(1);expect(refs.some((x:any)=>x.key===detail.finance_world.journal_id),'Actual manual posting must not appear twice under a second Sage identity').toBe(false);
});

test('Sage default posted intent queues local review with202 and keeps controller authority distinct from payment execution',async()=>{
 const w=fresh();ledgerOpen(w);register(w);const input=native();delete (input as any).state;const before=financial(w),created=await request(w,'/objects/general-ledger/journal-entry','POST',input),ref=result(created);expect(created!.status).toBe(202);expect(ref.finance_world.posting_pending_local_review).toBe(true);expect(financial(w)).toStrictEqual(before);expect(w.approvals.length).toBe(1);
 expect(()=>applyAction(w,{type:'decide_approval',approval_id:ref.finance_world.approval_id,decision:'approve'},{...operator,role:'controller'})).toThrowSatisfying((e:any)=>e.code==='separate_controller_required');decide(w,ref.finance_world.approval_id,'reject');const detail=result(await request(w,'/objects/general-ledger/journal-entry/'+ref.key));expect(detail.state).toBe('declined');expect(detail.finance_world.canonical_status).toBe('rejected');expect(detail.finance_world.journal_id).toBeNull();expect(financial(w)).toStrictEqual(before);
});

test('Sage rejects unsupported tax/dimensions, fractional/overflow amounts, false register identities and stale native write fields atomically',async()=>{
 const w=fresh();ledgerOpen(w);await denied(w,'/objects/general-ledger/journal-entry','POST',native(),'resource_missing');register(w);
 for(const value of [null,1,'0','-1.00','0.001','10000000000.01','NaN','1e2'])await denied(w,'/objects/general-ledger/journal-entry','POST',native('draft',value));
 for(const mutate of [(p:any)=>p.state='posted',(p:any)=>delete p.postingDate,(p:any)=>p.postingDate=null,(p:any)=>p.tax={taxImplication:'none'},(p:any)=>p.entity={id:'fake'},(p:any)=>p.glJournal={id:'GJ',key:'unknown'},(p:any)=>p.lines[0].dimensions={department:{key:'1'}},(p:any)=>p.lines[0].documentId='unbound-source',(p:any)=>p.lines[0].currency={txnCurrency:'USD'},(p:any)=>p.finance_world={source_document_ids:['unknown']},(p:any)=>p.lines[0].glAccount={id:'cash-bank'},(p:any)=>p.lines[0].txnType='Credit']){const body=native();mutate(body);await denied(w,'/objects/general-ledger/journal-entry','POST',body);}
 const max=result(await request(w,'/objects/general-ledger/journal-entry','POST',native('draft','10000000000.00')));expect(w.manualJournals.find((r:any)=>r.id===max.key).total_minor).toBe(1e12);
});

test('Sage origin is immutable and approval is held by its own connector, ledger and period locks',async()=>{
 const w=fresh();ledgerOpen(w);register(w);const r=result(await request(w,'/objects/general-ledger/journal-entry','POST',native()));
 expect(()=>applyAction(w,{type:'submit_manual_journal',manual_journal_id:r.key,version:r.finance_world.version,accounting_system:'xero'},operator)).toThrowSatisfying((e:any)=>e.code==='manual_journal_provider_mismatch');
 applyAction(w,{type:'set_fault',system:'xero',mode:'offline'},controller);const pending=submit(w,r.key);expect(pending.status).toBe('awaiting_approval');
 for(const system of ['sage-intacct','ledger']){applyAction(w,{type:'set_fault',system,mode:'offline'},controller);const before=structuredClone(w);expect(()=>decide(w,pending.approval_id)).toThrowSatisfying((e:any)=>e.code==='connection_unavailable');expect(w).toStrictEqual(before);applyAction(w,{type:'set_fault',system,mode:'healthy'},controller);}
 applyAction(w,{type:'close_period'},controller);expect(()=>decide(w,pending.approval_id)).toThrowSatisfying((e:any)=>e.code==='period_closed');applyAction(w,{type:'reopen_period'},controller);decide(w,pending.approval_id);expect(w.manualJournals[0].status).toBe('posted');
});

test('Sage posted native state requires matching canonical GL and independent approval evidence',async()=>{
 const w=fresh();ledgerOpen(w);register(w);const created=result(await request(w,'/objects/general-ledger/journal-entry','POST',native()));const pending=submit(w,created.key);decide(w,pending.approval_id);const record=w.manualJournals[0];
 for(const mutation of [(copy:World)=>copy.journals.find(j=>j.id===record.journal_id).lines[0].debit_minor++,(copy:World)=>copy.journals.find(j=>j.id===record.journal_id).currency='EUR',(copy:World)=>copy.approvals.find(a=>a.id===record.approval_id).decided_by=record.created_by,(copy:World)=>copy.approvals.find(a=>a.id===record.approval_id).action.accounting_system='xero',(copy:World)=>copy.journals.splice(copy.journals.findIndex(j=>j.id===record.journal_id),1)]){const copy=structuredClone(w);mutation(copy);await denied(copy,'/objects/general-ledger/journal-entry/'+created.key,'GET',undefined,'manual_journal_proof_missing');}
 const original=w.journals.find(j=>j.source_type==='invoice'),nativeGL=result(await request(w,'/objects/general-ledger/journal-entry/'+original.id));expect(nativeGL.finance_world.source_id).toBe(original.source_id);expect(nativeGL.glJournal).toBeUndefined();expect(nativeGL.entity).toBeUndefined();expect(nativeGL.lines[0].key).toBeUndefined();expect(nativeGL.lines[0].currency.baseCurrency).toBe('USD');
});

test('Sage read manifest distinguishes query POST from mutation and unsupported resource writes never succeed',async()=>{
 const w=fresh(),before=structuredClone(w);expect(providerIntacctRoutes.length).toBe(16);expect(providerIntacctRoutes.filter(row=>row.access==='write').length).toBe(1);expect(providerIntacctRoutes.find(row=>row.id==='sage-intacct.query')!.method).toBe('POST');expect(providerIntacctRoutes.find(row=>row.id==='sage-intacct.query')!.access).toBe('read');
 for(const object of ['accounts-payable/bill','accounts-receivable/invoice','accounts-payable/vendor','general-ledger/account'])await denied(w,'/objects/'+object,'POST',{},'unsupported_operation');expect(await request(w,'/objects/general-ledger/journal-entry-line')).toBeUndefined();await denied(w,'/objects/accounts-payable/bill/other-world-id','GET',undefined,'resource_missing');expect(w).toStrictEqual(before);
});


test('Sage records deferred supplier recognition explicitly without falsely claiming a posted bill',async()=>{
 const w=createWorld({kind:'procurement-matching',orderCount:1}),source=w.supplierInvoices[0];applyAction(w,{type:'close_period'},controller);const bill=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:source.id},operator).result.bill;const before=financial(w),deferred=result(await request(w,'/objects/accounts-payable/bill/'+bill.id));expect(deferred.state).toBeUndefined();expect(deferred.postingDate).toBeUndefined();expect(deferred.finance_world.accounting_status).toBe('pending_posting');expect(deferred.finance_world.recognition_journal_id).toBeNull();expect(deferred.totalTxnAmountDue).toBe((bill.amount_minor/100).toFixed(2));expect(financial(w)).toStrictEqual(before);applyAction(w,{type:'advance_time',hours:1},controller);applyAction(w,{type:'reopen_period'},controller);const posted=result(await request(w,'/objects/accounts-payable/bill/'+bill.id));expect(posted.state).toBe('posted');expect(posted.finance_world.accounting_status).toBe('posted');expect(posted.postingDate).toBe(w.now.slice(0,10));expect(posted.totalTxnAmountDue).toBe(deferred.totalTxnAmountDue);expect(w.bankTransactions).toStrictEqual(before.bank);
});

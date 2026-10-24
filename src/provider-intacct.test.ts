import {test} from 'bun:test';
import assert from 'node:assert/strict';
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
async function denied(w:World,path:string,method:string,input:any,code?:string){const before=structuredClone(w);await assert.rejects(()=>request(w,path,method,input),(error:any)=>error instanceof DomainError&&(!code||error.code===code));assert.deepEqual(w,before);}
const financial=(w:World)=>structuredClone({bank:w.bankTransactions,journals:w.journals,operations:w.operations,accounts:w.accounts});
function submit(w:World,id:string){const row=w.manualJournals.find((r:any)=>r.id===id);return applyAction(w,{type:'submit_manual_journal',manual_journal_id:id,version:manualJournalVersion(row),accounting_system:'sage-intacct'},operator).result;}
function decide(w:World,approval_id:string,decision='approve'){return applyAction(w,{type:'decide_approval',approval_id,decision},reviewer).result;}

test('Sage object references and account/contact reads retain source identity without inventing registers, books or legal/tax facts',async()=>{
 const w=fresh(),before=structuredClone(w);assert.deepEqual(result(await request(w,'/objects/general-ledger/journal')),[]);
 const refs=result(await request(w,'/objects/general-ledger/account'));assert.equal(refs.length,w.accounts.length);assert.deepEqual(Object.keys(refs[0]).sort(),['href','id','key']);
 const a=result(await request(w,'/objects/general-ledger/account/expenses'));assert.equal(a.key,'expenses');assert.equal(a.id,'expenses');assert.equal(a.accountType,'incomeStatement');assert.equal(a.normalBalance,'debit');assert.equal(a.finance_world.balance_minor,w.accounts.find(r=>r.id==='expenses').balance_minor);for(const key of ['entity','bookId','taxCode','isTaxable','requireDimensions','audit'])assert.equal(a[key],undefined);
 const customer=result(await request(w,'/objects/accounts-receivable/customer/'+w.customers[0].id));assert.equal(customer.name,w.customers[0].name);assert.equal(customer.contacts.default.email1,w.customers[0].email);assert.equal(customer.contacts.default.key,undefined);assert.equal(customer.totalDue,undefined);assert.equal(customer.entity,undefined);
 const vendor=result(await request(w,'/objects/accounts-payable/vendor/'+w.vendors[0].id));assert.equal(vendor.name,w.vendors[0].name);assert.deepEqual(w,before);
 const r=register(w),registered=result(await request(w,'/objects/general-ledger/journal/'+r.id));assert.equal(registered.key,r.id);assert.equal(registered.id,'GJ');assert.equal(registered.enableApproval,true);assert.equal(registered.bookId,undefined);assert.equal(registered.bookType,undefined);assert.equal(registered.entity,undefined);
});

test('Sage USD AR/AP details use real recognition and settlement history, not invented invoice lines or tax totals',async()=>{
 const w=fresh();ledgerOpen(w);const invoice=w.invoices[0],bill=w.bills[0];
 let ar=result(await request(w,'/objects/accounts-receivable/invoice/'+invoice.id));assert.equal(ar.totalTxnAmount,(invoice.amount_minor/100).toFixed(2));assert.equal(ar.totalBaseAmount,ar.totalTxnAmount);assert.equal(ar.state,'posted');assert.equal(ar.customer.key,invoice.customer_id);assert.equal(ar.lines,undefined);assert.equal(ar.taxSolution,undefined);assert.equal(ar.invoiceDate,invoice.issued_at.slice(0,10));assert.equal(ar.finance_world.recognition_journal_id,w.journals.find(j=>j.source_id===invoice.id).id);
 const partial=123;applyAction(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:partial},operator);applyAction(w,{type:'advance_time',hours:1},controller);ar=result(await request(w,'/objects/accounts-receivable/invoice/'+invoice.id));assert.equal(ar.state,'partiallyPaid');assert.equal(ar.paymentInformation.totalTxnAmountPaid,'1.23');assert.equal(ar.totalTxnAmountDue,((invoice.amount_minor-partial)/100).toFixed(2));
 const ap=result(await request(w,'/objects/accounts-payable/bill/'+bill.id));assert.equal(ap.state,'posted');assert.equal(ap.vendor.key,bill.vendor_id);assert.equal(ap.totalTxnAmount,(bill.amount_minor/100).toFixed(2));assert.equal(ap.createdDate,undefined);assert.equal(ap.postingDate,w.journals.find(j=>j.source_id===bill.id).posted_at.slice(0,10));
});

test('Sage procurement bills expose only recognized invoices and their actual matched source line allocations',async()=>{
 const w=createWorld({kind:'procurement-matching',orderCount:2}),source=w.supplierInvoices[0];assert.deepEqual(result(await request(w,'/objects/accounts-payable/bill')),[]);
 const matched=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:source.id},operator).result,row=result(await request(w,'/objects/accounts-payable/bill/'+matched.bill.id));assert.equal(row.state,'posted');assert.equal(row.lines.length,source.lines.length);assert.equal(row.billNumber,source.invoice_number);
 for(let i=0;i<source.lines.length;i++){assert.equal(row.lines[i].txnAmount,(source.lines[i].amount_minor/100).toFixed(2));assert.equal(row.lines[i].lineNumber,String(i+1));assert.deepEqual(row.lines[i].finance_world.source_allocations,w.supplierInvoices.find((s:any)=>s.id===source.id).lines[i].allocations);for(const key of ['taxEntries','hasForm1099','glAccount','key','id'])assert.equal(row.lines[i][key],undefined);}
});

test('Sage foreign values retain native/functional separation and reject unsupported third-decimal precision',async()=>{
 for(const currency of ['EUR','JPY'] as const){const w=createWorld({kind:'foreign-service-close',orderCount:1,foreignControls:{currency}}),invoice=w.foreignInvoices[0],row=result(await request(w,'/objects/accounts-receivable/invoice/'+invoice.id));assert.equal(row.currency.txnCurrency,currency);assert.equal(row.finance_world.amount_minor,invoice.amount_minor);assert.equal(row.finance_world.carrying_minor,invoice.carrying_minor);assert.equal(row.totalBaseAmount,undefined);assert.equal(row.currency.exchangeRate,undefined);assert.deepEqual(row.finance_world.recognition_quote,invoice.recognition_quote_snapshot);assert.equal(row.lines,undefined);}
 const w=createWorld({kind:'foreign-service-close',orderCount:1,foreignControls:{currency:'KWD'}});w.foreignInvoices[0].amount_minor=1001;await denied(w,'/objects/accounts-receivable/invoice/'+w.foreignInvoices[0].id,'GET',undefined,'unsupported_amount_precision');assert.ok(result(await request(w,'/objects/accounts-receivable/invoice')).some((row:any)=>row.key===w.foreignInvoices[0].id),'Reference listing never rounds or hides the source');
});

test('Sage query is read-only with exact decimal/date predicates, flattened related fields, stable order and 1-based paging',async()=>{
 const w=fresh(),before=structuredClone(w),fields=['id','invoiceNumber','customer.id','totalTxnAmountDue','invoiceDate'];const q={object:'accounts-receivable/invoice',fields,filters:[{$eq:{state:'posted'}},{$gte:{totalTxnAmountDue:'0.01'}},{$lt:{invoiceDate:'2026-11-01'}}],orderBy:[{id:'desc'}],size:1};
 const ids=[];for(let start=1;start<=3;start++){const res=(await query(w,{...q,start}))!.body;ids.push(res['ia::result'][0].id);assert.equal(res['ia::meta'].totalCount,3);assert.equal(res['ia::meta'].next,start<3?start+1:null);assert.equal(res['ia::meta'].previous,start>1?start-1:null);assert.equal(res['ia::result'][0].customer,undefined);assert.ok(res['ia::result'][0]['customer.id']);}assert.deepEqual(ids,w.invoices.map(row=>row.id).reverse());assert.deepEqual(result(await query(w,{...q,start:4})),[]);
 const one=result(await query(w,{object:'accounts-receivable/invoice',fields:['id'],filters:[{$in:{id:[w.invoices[1].id]}}]}));assert.deepEqual(one,[{id:w.invoices[1].id}]);assert.deepEqual(w,before);
});

test('Sage query rejects unsupported clauses and invalid field types even for an empty object collection',async()=>{
 const w=fresh(),q={object:'general-ledger/journal',fields:['key']};for(const [patch,code] of [
  [{fields:['*']},'unsupported_field'],[{fields:['key','key']},'unsupported_field'],[{fields:['lines']},'unsupported_field'],[{filters:[{$eq:{enableApproval:'true'}}]},'invalid_filter'],[{filters:[{$eq:{name:true}}]},'invalid_filter'],[{filters:[{$contains:{name:'G'}}]},'unsupported_field'],[{filters:[{$eq:{unknown:'x'}}]},'unsupported_filter'],[{filterExpression:'or'},'unsupported_filter'],[{filterParameters:{includePrivate:true}},'unsupported_field'],[{orderBy:[{href:'asc'}]},'unsupported_filter'],[{orderBy:[{name:'ASC'}]},'unsupported_filter'],[{start:0},'invalid_parameter'],[{size:4001},'invalid_parameter'],[{size:null},'invalid_parameter'],[{fields:['sum:key']},'unsupported_field'],
 ] as [any,string][])await denied(w,'/services/core/query','POST',{...q,...patch},code);
 await denied(w,'/services/core/query','POST',{object:'general-ledger/journal-entry',fields:['id'],filters:[{$eq:{postingDate:'2026-02-30'}}]},'invalid_filter');await denied(w,'/services/core/query','POST',{object:'accounts-payable/bill',fields:['id'],filters:[{$gt:{totalTxnAmount:'0.001'}}]},'invalid_filter');await denied(w,'/services/core/query','POST',[q],'invalid_body');await denied(w,'/objects/accounts-payable/bill?where=state','GET',undefined,'unsupported_filter');
});

test('Sage native draft and canonical submit use one stable source proposal; only independent posting becomes posted',async()=>{
 const w=fresh(),r=register(w),before=financial(w),created=await request(w,'/objects/general-ledger/journal-entry','POST',native()),reference=result(created);assert.equal(created!.status,201);assert.equal(reference.key,reference.id);assert.equal(reference.finance_world.canonical_status,'draft');assert.deepEqual(financial(w),before);assert.equal(w.approvals.length,0);
 let detail=result(await request(w,'/objects/general-ledger/journal-entry/'+reference.key));assert.equal(detail.state,'draft');assert.equal(detail.glJournal.key,r.id);assert.equal(detail.glJournal.id,r.code);assert.equal(detail.lines[0].txnAmount,'0.01');assert.equal(detail.lines[0].txnType,'debit');assert.equal(detail.lines[1].txnType,'credit');assert.equal(detail.finance_world.source_documents,undefined);assert.deepEqual(detail.finance_world.source_document_ids,['policy-payments']);assert.equal(detail.finance_world.draft_submit_action.accounting_system,'sage-intacct');
 await denied(w,'/objects/general-ledger/journal-entry/'+reference.key,'PATCH',{state:'posted'},'unsupported_operation');ledgerOpen(w);const pending=submit(w,reference.key);assert.equal(pending.status,'awaiting_approval');assert.deepEqual(financial(w),before);
 decide(w,pending.approval_id);detail=result(await request(w,'/objects/general-ledger/journal-entry/'+reference.key));assert.equal(detail.state,'posted');assert.equal(detail.finance_world.canonical_status,'posted');assert.equal(w.journals.length,before.journals.length+1);assert.equal(detail.finance_world.journal_id,w.manualJournals[0].journal_id);assert.equal(detail.lines[0].description,'Expense supported by attached source');assert.deepEqual(w.bankTransactions,before.bank);assert.deepEqual(w.operations,before.operations);
 const refs=result(await request(w,'/objects/general-ledger/journal-entry'));assert.equal(refs.filter((x:any)=>x.key===reference.key).length,1);assert.equal(refs.some((x:any)=>x.key===detail.finance_world.journal_id),false,'Actual manual posting must not appear twice under a second Sage identity');
});

test('Sage default posted intent queues local review with202 and keeps controller authority distinct from payment execution',async()=>{
 const w=fresh();ledgerOpen(w);register(w);const input=native();delete (input as any).state;const before=financial(w),created=await request(w,'/objects/general-ledger/journal-entry','POST',input),ref=result(created);assert.equal(created!.status,202);assert.equal(ref.finance_world.posting_pending_local_review,true);assert.deepEqual(financial(w),before);assert.equal(w.approvals.length,1);
 assert.throws(()=>applyAction(w,{type:'decide_approval',approval_id:ref.finance_world.approval_id,decision:'approve'},{...operator,role:'controller'}),(e:any)=>e.code==='separate_controller_required');decide(w,ref.finance_world.approval_id,'reject');const detail=result(await request(w,'/objects/general-ledger/journal-entry/'+ref.key));assert.equal(detail.state,'declined');assert.equal(detail.finance_world.canonical_status,'rejected');assert.equal(detail.finance_world.journal_id,null);assert.deepEqual(financial(w),before);
});

test('Sage rejects unsupported tax/dimensions, fractional/overflow amounts, false register identities and stale native write fields atomically',async()=>{
 const w=fresh();ledgerOpen(w);await denied(w,'/objects/general-ledger/journal-entry','POST',native(),'resource_missing');register(w);
 for(const value of [null,1,'0','-1.00','0.001','10000000000.01','NaN','1e2'])await denied(w,'/objects/general-ledger/journal-entry','POST',native('draft',value));
 for(const mutate of [(p:any)=>p.state='posted',(p:any)=>delete p.postingDate,(p:any)=>p.postingDate=null,(p:any)=>p.tax={taxImplication:'none'},(p:any)=>p.entity={id:'fake'},(p:any)=>p.glJournal={id:'GJ',key:'unknown'},(p:any)=>p.lines[0].dimensions={department:{key:'1'}},(p:any)=>p.lines[0].documentId='unbound-source',(p:any)=>p.lines[0].currency={txnCurrency:'USD'},(p:any)=>p.finance_world={source_document_ids:['unknown']},(p:any)=>p.lines[0].glAccount={id:'cash-bank'},(p:any)=>p.lines[0].txnType='Credit']){const body=native();mutate(body);await denied(w,'/objects/general-ledger/journal-entry','POST',body);}
 const max=result(await request(w,'/objects/general-ledger/journal-entry','POST',native('draft','10000000000.00')));assert.equal(w.manualJournals.find((r:any)=>r.id===max.key).total_minor,1e12);
});

test('Sage origin is immutable and approval is held by its own connector, ledger and period locks',async()=>{
 const w=fresh();ledgerOpen(w);register(w);const r=result(await request(w,'/objects/general-ledger/journal-entry','POST',native()));
 assert.throws(()=>applyAction(w,{type:'submit_manual_journal',manual_journal_id:r.key,version:r.finance_world.version,accounting_system:'xero'},operator),(e:any)=>e.code==='manual_journal_provider_mismatch');
 applyAction(w,{type:'set_fault',system:'xero',mode:'offline'},controller);const pending=submit(w,r.key);assert.equal(pending.status,'awaiting_approval');
 for(const system of ['sage-intacct','ledger']){applyAction(w,{type:'set_fault',system,mode:'offline'},controller);const before=structuredClone(w);assert.throws(()=>decide(w,pending.approval_id),(e:any)=>e.code==='connection_unavailable');assert.deepEqual(w,before);applyAction(w,{type:'set_fault',system,mode:'healthy'},controller);}
 applyAction(w,{type:'close_period'},controller);assert.throws(()=>decide(w,pending.approval_id),(e:any)=>e.code==='period_closed');applyAction(w,{type:'reopen_period'},controller);decide(w,pending.approval_id);assert.equal(w.manualJournals[0].status,'posted');
});

test('Sage posted native state requires matching canonical GL and independent approval evidence',async()=>{
 const w=fresh();ledgerOpen(w);register(w);const created=result(await request(w,'/objects/general-ledger/journal-entry','POST',native()));const pending=submit(w,created.key);decide(w,pending.approval_id);const record=w.manualJournals[0];
 for(const mutation of [(copy:World)=>copy.journals.find(j=>j.id===record.journal_id).lines[0].debit_minor++,(copy:World)=>copy.journals.find(j=>j.id===record.journal_id).currency='EUR',(copy:World)=>copy.approvals.find(a=>a.id===record.approval_id).decided_by=record.created_by,(copy:World)=>copy.approvals.find(a=>a.id===record.approval_id).action.accounting_system='xero',(copy:World)=>copy.journals.splice(copy.journals.findIndex(j=>j.id===record.journal_id),1)]){const copy=structuredClone(w);mutation(copy);await denied(copy,'/objects/general-ledger/journal-entry/'+created.key,'GET',undefined,'manual_journal_proof_missing');}
 const original=w.journals.find(j=>j.source_type==='invoice'),nativeGL=result(await request(w,'/objects/general-ledger/journal-entry/'+original.id));assert.equal(nativeGL.finance_world.source_id,original.source_id);assert.equal(nativeGL.glJournal,undefined);assert.equal(nativeGL.entity,undefined);assert.equal(nativeGL.lines[0].key,undefined);assert.equal(nativeGL.lines[0].currency.baseCurrency,'USD');
});

test('Sage read manifest distinguishes query POST from mutation and unsupported resource writes never succeed',async()=>{
 const w=fresh(),before=structuredClone(w);assert.equal(providerIntacctRoutes.length,16);assert.equal(providerIntacctRoutes.filter(row=>row.access==='write').length,1);assert.equal(providerIntacctRoutes.find(row=>row.id==='sage-intacct.query')!.method,'POST');assert.equal(providerIntacctRoutes.find(row=>row.id==='sage-intacct.query')!.access,'read');
 for(const object of ['accounts-payable/bill','accounts-receivable/invoice','accounts-payable/vendor','general-ledger/account'])await denied(w,'/objects/'+object,'POST',{},'unsupported_operation');assert.equal(await request(w,'/objects/general-ledger/journal-entry-line'),undefined);await denied(w,'/objects/accounts-payable/bill/other-world-id','GET',undefined,'resource_missing');assert.deepEqual(w,before);
});


test('Sage records deferred supplier recognition explicitly without falsely claiming a posted bill',async()=>{
 const w=createWorld({kind:'procurement-matching',orderCount:1}),source=w.supplierInvoices[0];applyAction(w,{type:'close_period'},controller);const bill=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:source.id},operator).result.bill;const before=financial(w),deferred=result(await request(w,'/objects/accounts-payable/bill/'+bill.id));assert.equal(deferred.state,undefined);assert.equal(deferred.postingDate,undefined);assert.equal(deferred.finance_world.accounting_status,'pending_posting');assert.equal(deferred.finance_world.recognition_journal_id,null);assert.equal(deferred.totalTxnAmountDue,(bill.amount_minor/100).toFixed(2));assert.deepEqual(financial(w),before);applyAction(w,{type:'advance_time',hours:1},controller);applyAction(w,{type:'reopen_period'},controller);const posted=result(await request(w,'/objects/accounts-payable/bill/'+bill.id));assert.equal(posted.state,'posted');assert.equal(posted.finance_world.accounting_status,'posted');assert.equal(posted.postingDate,w.now.slice(0,10));assert.equal(posted.totalTxnAmountDue,deferred.totalTxnAmountDue);assert.deepEqual(w.bankTransactions,before.bank);
});

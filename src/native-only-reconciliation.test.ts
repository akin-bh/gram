import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {applyAction,createWorld,DomainError} from './world.ts';
import type {Action,Actor,World} from './world.ts';
import {functionalBankBalance,nativeBankBalance,treasuryValuationProof} from './treasury.ts';
import {foreignSettlementCashProof} from './foreign-obligations.ts';
const operator:Actor={id:'native-only-operator',role:'agent'},controller:Actor={id:'native-only-controller',role:'controller'},reviewer:Actor={id:'native-only-reviewer',role:'controller'};
let next=0;const id=()=>`native-only-source-${++next}`;
const act=(w:World,a:Action,actor=operator)=>applyAction(w,a,actor).result;
const tick=(w:World)=>act(w,{type:'advance_time',hours:1},controller);
function fixture(){
  const w=createWorld({kind:'saas-collections',orderCount:1}),start=w.now,bank=act(w,{type:'record_bank_account',name:'KWD receipts',currency:'KWD',external_account_id:id(),external_event_id:id()},controller).bank_account;
  const quote=act(w,{type:'record_fx_quote',source_quote_id:id(),base_currency:'KWD',quote_currency:'USD',numerator:'13',denominator:'4',observed_at:w.now,expires_at:new Date(Date.parse(w.now)+86400000).toISOString(),external_event_id:id()},controller).quote;
  function source(kind:'invoice'|'bill',amount=4){const party=act(w,{type:'record_foreign_counterparty',external_counterparty_id:id(),kind:kind==='invoice'?'customer':'vendor',name:'Native-only counterparty',email:'source@native.test',currency:'KWD',external_event_id:id()},controller).counterparty,contract=act(w,{type:'record_foreign_contract',external_contract_id:id(),counterparty_id:party.id,amount_minor:amount,description:'Completed native-priced services',signed_at:w.now,external_event_id:id()},controller).contract;return act(w,{type:kind==='invoice'?'record_foreign_invoice':'record_foreign_bill',contract_id:contract.id,source_invoice_id:id(),amount_minor:amount,issued_at:w.now,due_at:w.now,service_completed_at:w.now,completion_reference:id(),quote_id:quote.id,external_event_id:id()},controller).obligation;}
  function settle(obligation:any,amount=1){const requested=act(w,{type:obligation.kind==='invoice'?'collect_foreign_invoice':'pay_foreign_bill',[obligation.kind==='invoice'?'invoice_id':'bill_id']:obligation.id,bank_account_id:bank.id,amount_minor:amount,quote_id:quote.id});act(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},reviewer);tick(w);const settlement=w.foreignSettlements.find((row:any)=>row.id===requested.settlement.id);assert.equal(settlement.status,'settled');return settlement;}
  return {w,start,bank,quote,source,settle};
}
function statement(w:World,bank:any,start:string){const rows=w.bankTransactions.filter(row=>row.account_id===bank.id&&row.status==='posted'&&row.posted_at>start&&row.amount_minor!==0),opening=w.bankTransactions.filter(row=>row.account_id===bank.id&&row.status==='posted'&&row.posted_at<=start).reduce((sum,row)=>sum+row.amount_minor,0),s=act(w,{type:'record_bank_statement',source_statement_id:id(),account_id:bank.id,currency:bank.currency,start_at:start,end_at:w.now,opening_balance_minor:opening,closing_balance_minor:opening+rows.reduce((sum,row)=>sum+row.amount_minor,0),lines:rows.map(row=>({source_line_id:id(),posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.id]})),external_event_id:id()},controller).statement;for(let i=0;i<rows.length;i++)act(w,{type:'match_statement_line',statement_id:s.id,line_id:s.lines[i].id,bank_transaction_ids:[rows[i].id]});return s;}
const prepare=(w:World,s:any)=>act(w,{type:'prepare_reconciliation',statement_id:s.id}).report;
function close(w:World,s:any,r:any){return act(w,{type:'close_reconciliation',statement_id:s.id,report_id:r.id,source_fingerprint:r.source_fingerprint,acknowledged_timing_item_ids:r.timing_items.map((item:any)=>item.id),external_event_id:id()},reviewer);}
function exact(w:World){for(const j of w.journals)assert.equal(j.lines.reduce((sum:bigint,l:any)=>sum+BigInt(l.debit_minor??0)-BigInt(l.credit_minor??0),0n),0n);assert.equal(w.accounts.reduce((sum,a)=>sum+BigInt(a.balance_minor),0n),0n);}

test('sub-cent native receipts account exactly with no fabricated USD journal even during a closed period',()=>{
  const f=fixture(),invoice=f.source('invoice'),before=f.w.journals.length;act(f.w,{type:'close_period'},controller);const receipts=[f.settle(invoice),f.settle(invoice),f.settle(invoice)];
  for(const receipt of receipts){const op=f.w.operations.find(row=>row.id===receipt.operation_id);assert.equal(receipt.settlement_functional_minor,0);assert.deepEqual(op.journal_lines,[]);assert.equal(op.accounting_status,'no_functional_effect');assert.equal(op.accounted_at,op.settled_at);assert.equal(op.journal_id,undefined);assert.equal(foreignSettlementCashProof(f.w,op.id,f.bank.id)?.functional_minor,0);}
  assert.equal(f.w.journals.length,before);assert.equal(f.w.settledUnposted.length,0);assert.equal(nativeBankBalance(f.w,f.bank.id),3);assert.equal(functionalBankBalance(f.w,f.bank.id),0);const s=statement(f.w,f.bank,f.start),report=prepare(f.w,s);assert.equal(report.can_close,true,JSON.stringify(report.blockers));assert.equal(report.book_closing_minor,3);assert.equal(report.functional_book_closing_minor,0);assert.equal(report.native_only_operation_ids.length,3);assert.equal(report.timing_items.length,0);close(f.w,s,report);exact(f.w);
});

test('final native unit releases residual AR basis through a noncash journal without a bank GL line',()=>{
  const f=fixture(),invoice=f.source('invoice');for(let i=0;i<3;i++)f.settle(invoice);const receipt=f.settle(invoice),op=f.w.operations.find(row=>row.id===receipt.operation_id),journal=f.w.journals.find(row=>row.id===op.journal_id);assert.equal(receipt.amount_minor,1);assert.equal(receipt.settlement_functional_minor,0);assert.equal(receipt.released_historical_minor,1);assert.equal(op.accounting_status,'posted');assert.ok(journal.lines.length>=2);assert.ok(journal.lines.every((line:any)=>line.account_id!==f.bank.gl_account_id));assert.equal(f.w.foreignInvoices[0].carrying_minor,0);assert.equal(f.w.foreignInvoices[0].historical_basis_minor,0);assert.equal(nativeBankBalance(f.w,f.bank.id),4);assert.equal(functionalBankBalance(f.w,f.bank.id),0);
  const s=statement(f.w,f.bank,f.start),report=prepare(f.w,s);assert.equal(report.can_close,true,JSON.stringify(report.blockers));assert.equal(report.book_closing_minor,4);assert.equal(report.functional_book_closing_minor,0);close(f.w,s,report);exact(f.w);
});

test('zero-carrying foreign cash can pay AP without a cash GL line and drain every native unit',()=>{
  const f=fixture(),invoice=f.source('invoice');for(let i=0;i<4;i++)f.settle(invoice);const bill=f.source('bill'),receipt=f.settle(bill,4),op=f.w.operations.find(row=>row.id===receipt.operation_id);assert.equal(op.external_cash_plan.cash_effect_functional_minor,0);assert.equal(op.external_cash_plan.historical_change_minor,0);assert.ok(op.journal_lines.length>=2);assert.ok(op.journal_lines.every((line:any)=>line.account_id!==f.bank.gl_account_id));assert.equal(nativeBankBalance(f.w,f.bank.id),0);assert.equal(functionalBankBalance(f.w,f.bank.id),0);assert.equal(f.w.foreignBills[0].historical_basis_minor,0);assert.equal(f.w.foreignBills[0].carrying_minor,0);
  const s=statement(f.w,f.bank,f.start),report=prepare(f.w,s);assert.equal(report.can_close,true,JSON.stringify(report.blockers));assert.equal(report.book_closing_minor,0);assert.equal(report.adjusted_functional_difference_minor,0);close(f.w,s,report);exact(f.w);
});

test('genuine sub-cent cash can revalue to zero without a fictitious valuation journal',()=>{
  const f=fixture(),invoice=f.source('invoice');f.settle(invoice);const journals=f.w.journals.length,banks=structuredClone(f.w.bankTransactions),result=act(f.w,{type:'revalue_bank_account',bank_account_id:f.bank.id,quote_id:f.quote.id});assert.equal(result.valuation.native_balance_minor,1);assert.equal(result.valuation.after_functional_minor,0);assert.equal(result.valuation.status,'unchanged');assert.equal(result.operation,undefined);assert.equal(treasuryValuationProof(f.w,result.valuation.id).functional_minor,0);assert.equal(f.w.journals.length,journals);assert.deepEqual(f.w.bankTransactions,banks);exact(f.w);
});

test('zero-accounting metadata cannot conceal a real journal or invent a posting timestamp',()=>{
  const f=fixture(),invoice=f.source('invoice'),receipt=f.settle(invoice),s=statement(f.w,f.bank,f.start),opId=receipt.operation_id;
  const edits=[(op:any)=>{delete op.accounted_at;},(op:any)=>{op.accounted_at=op.settled_at.replace('.000Z','Z');},(op:any)=>{op.accounted_at=new Date(Date.parse(op.settled_at)-1).toISOString();},(op:any)=>{op.accounting_status='posted';},(op:any)=>{op.journal_id='invented-journal';},(op:any)=>{op.journal_lines=[{account_id:'equity',debit_minor:0,credit_minor:0}];}];
  for(const edit of edits){const copy=structuredClone(f.w);edit(copy.operations.find(row=>row.id===opId));const report=prepare(copy,s);assert.equal(report.can_close,false);assert.ok(report.blockers.some((row:any)=>row.code==='invalid_native_only_accounting'));}
  const injected=structuredClone(f.w);injected.journals.push({id:'forged-zero-journal',source_id:opId,source_type:'operation',posted_at:injected.now,lines:[]});assert.ok(prepare(injected,s).blockers.some((row:any)=>row.code==='invalid_native_only_accounting'));
});

test('future native accounting is blocked and clock eligibility changes require a fresh prepared fingerprint',()=>{
  const f=fixture(),invoice=f.source('invoice'),receipt=f.settle(invoice),s=statement(f.w,f.bank,f.start),op=f.w.operations.find(row=>row.id===receipt.operation_id);op.accounted_at=new Date(Date.parse(f.w.now)+3600000).toISOString();const old=prepare(f.w,s);assert.equal(old.can_close,false);assert.ok(old.blockers.some((row:any)=>row.code==='future_native_only_accounting'));tick(f.w);
  assert.throws(()=>close(f.w,s,old),(error:any)=>error instanceof DomainError&&error.code==='stale_reconciliation');const report=prepare(f.w,s);assert.equal(report.can_close,true,JSON.stringify(report.blockers));assert.equal(report.book_closing_minor,0);assert.equal(report.later_posted_cash_minor,1);assert.equal(report.later_posted_functional_minor,0);assert.equal(report.timing_items[0].kind,'native_accounted_after_cutoff');assert.equal(report.timing_items[0].operation_id,receipt.operation_id);close(f.w,s,report);
});

test('native receipt with nonzero deferred AR journal remains blocked until actual posting, even with USD cash zero',()=>{
  const f=fixture(),invoice=f.source('invoice');for(let i=0;i<3;i++)f.settle(invoice);act(f.w,{type:'close_period'},controller);const receipt=f.settle(invoice),s=statement(f.w,f.bank,f.start),blocked=prepare(f.w,s);assert.equal(blocked.can_close,false);assert.ok(blocked.blockers.some((row:any)=>row.code==='missing_cash_journal'));const op=f.w.operations.find(row=>row.id===receipt.operation_id);assert.ok(op.journal_lines.length>=2);assert.equal(op.accounting_status,'pending_posting');
  tick(f.w);act(f.w,{type:'reopen_period'},controller);const report=prepare(f.w,s);assert.equal(report.can_close,true,JSON.stringify(report.blockers));assert.equal(report.book_closing_minor,3);assert.equal(report.later_posted_cash_minor,1);assert.equal(report.later_posted_functional_minor,0);assert.equal(report.timing_items[0].kind,'posted_after_cutoff');close(f.w,s,report);exact(f.w);
});

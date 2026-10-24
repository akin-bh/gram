import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError} from './world.ts';
import type {Action,Actor,World} from './world.ts';
import {bankReserved,functionalBankBalance,nativeBankBalance,treasuryValuationProof} from './treasury.ts';
import {foreignSettlementCashProof} from './foreign-obligations.ts';
const operator:Actor={id:'foreign-reconciliation-operator',role:'agent'},controller:Actor={id:'foreign-source-controller',role:'controller'},reviewer:Actor={id:'foreign-independent-reviewer',role:'controller'};
let serial=0;const source=()=>`foreign-cash-source-${++serial}`;
const act=(w:World,a:Action,actor=operator)=>applyAction(w,a,actor).result;
const tick=(w:World,hours=1)=>act(w,{type:'advance_time',hours},controller);
function quote(w:World,n='11',d='10'){return act(w,{type:'record_fx_quote',source_quote_id:source(),base_currency:'EUR',quote_currency:'USD',numerator:n,denominator:d,observed_at:w.now,expires_at:new Date(Date.parse(w.now)+7*86400000).toISOString(),external_event_id:source()},controller).quote;}
function setup(kind:'invoice'|'bill'='invoice'){
  const w=createWorld({kind:'saas-collections',orderCount:1}),start=w.now,bank=act(w,{type:'record_bank_account',name:'EUR service account',currency:'EUR',external_account_id:source(),external_event_id:source()},controller).bank_account,q=quote(w);
  if(kind==='bill'){const request=act(w,{type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:bank.id,amount_minor:11000,quote_id:q.id,reason:'Fund verified supplier account'});act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},reviewer);tick(w);}
  const party=act(w,{type:'record_foreign_counterparty',external_counterparty_id:source(),kind:kind==='invoice'?'customer':'vendor',name:'Foreign service counterparty',email:'service@counterparty.test',currency:'EUR',external_event_id:source()},controller).counterparty;
  const contract=act(w,{type:'record_foreign_contract',external_contract_id:source(),counterparty_id:party.id,amount_minor:10000,description:'Signed delivered service',signed_at:w.now,external_event_id:source()},controller).contract;
  const obligation=act(w,{type:kind==='invoice'?'record_foreign_invoice':'record_foreign_bill',contract_id:contract.id,source_invoice_id:source(),amount_minor:10000,issued_at:w.now,due_at:new Date(Date.parse(w.now)+30*86400000).toISOString(),quote_id:q.id,service_completed_at:w.now,completion_reference:source(),external_event_id:source()},controller).obligation;
  return {w,start,bank,party,contract,obligation};
}
function settlement(w:World,bank:any,obligation:any,q:any,amount=10000,finish=true){const request=act(w,{type:obligation.kind==='invoice'?'collect_foreign_invoice':'pay_foreign_bill',[obligation.kind==='invoice'?'invoice_id':'bill_id']:obligation.id,bank_account_id:bank.id,amount_minor:amount,quote_id:q.id});act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},reviewer);if(finish)tick(w);return w.foreignSettlements.find((row:any)=>row.id===request.settlement.id);}
function statement(w:World,bank:any,start:string,end=w.now){const rows=w.bankTransactions.filter(row=>row.account_id===bank.id&&row.status==='posted'&&row.posted_at<=end),window=rows.filter(row=>row.amount_minor&&row.posted_at>start),opening=rows.filter(row=>row.posted_at<=start).reduce((sum,row)=>sum+row.amount_minor,0),closing=rows.reduce((sum,row)=>sum+row.amount_minor,0);const s=act(w,{type:'record_bank_statement',source_statement_id:source(),account_id:bank.id,currency:'EUR',start_at:start,end_at:end,opening_balance_minor:opening,closing_balance_minor:closing,lines:window.map(row=>({source_line_id:source(),posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.id]})),external_event_id:source()},controller).statement;for(let i=0;i<window.length;i++)act(w,{type:'match_statement_line',statement_id:s.id,line_id:s.lines[i].id,bank_transaction_ids:[window[i].id]});return s;}
const prepare=(w:World,s:any)=>act(w,{type:'prepare_reconciliation',statement_id:s.id}).report;
function close(w:World,s:any,report:any){return act(w,{type:'close_reconciliation',statement_id:s.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((item:any)=>item.id),external_event_id:source()},reviewer);}
function reject(w:World,a:Action,code:string,actor=operator){const before=structuredClone(w);expect(()=>act(w,a,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);}

test('foreign customer receipt proves one external native leg and its functional carrying value',()=>{
  const {w,start,bank,obligation}=setup(),s=settlement(w,bank,obligation,quote(w,'13','10'));expect(s.obligation_realized_gain_minor).toBe(2000);expect(s.cash_realized_gain_minor).toBe(0);expect(nativeBankBalance(w,bank.id)).toBe(10000);expect(functionalBankBalance(w,bank.id)).toBe(13000);expect(w.bankAccounts.find((row:any)=>row.id===bank.id).historical_cost_minor).toBe(13000);
  const proof=foreignSettlementCashProof(w,s.operation_id,bank.id)!;expect(proof.native_minor).toBe(10000);expect(proof.functional_minor).toBe(13000);expect(proof.bank_transaction_ids.length).toBe(1);const stmt=statement(w,bank,start),report=prepare(w,stmt);expect(report.can_close,JSON.stringify(report.blockers)).toBe(true);expect(report.book_closing_minor).toBe(10000);expect(report.functional_book_closing_minor).toBe(13000);close(w,stmt,report);
});

test('supplier payment separates cash and liability FX despite cancellation in the net USD journal',()=>{
  const {w,start,bank,obligation}=setup('bill');act(w,{type:'revalue_bank_account',bank_account_id:bank.id,quote_id:quote(w,'6','5').id});act(w,{type:'revalue_foreign_obligation',kind:'bill',obligation_id:obligation.id,quote_id:quote(w,'13','10').id});const s=settlement(w,bank,obligation,quote(w,'7','5'));
  expect(s.cash_realized_gain_minor).toBe(3000);expect(s.obligation_realized_gain_minor).toBe(-3000);expect(s.cash_recycled_unrealized_minor).toBe(1000);expect(s.obligation_recycled_unrealized_minor).toBe(-2000);expect(nativeBankBalance(w,bank.id)).toBe(0);expect(functionalBankBalance(w,bank.id)).toBe(0);expect(w.bankAccounts.find((row:any)=>row.id===bank.id).historical_cost_minor).toBe(0);expect(w.accounts.find(row=>row.id==='fx-unrealized-gain-loss').balance_minor).toBe(0);
  const proof=foreignSettlementCashProof(w,s.operation_id,bank.id)!;expect(proof.native_minor).toBe(-10000);expect(proof.functional_minor).toBe(-12000);const stmt=statement(w,bank,start),report=prepare(w,stmt);expect(report.can_close,JSON.stringify(report.blockers)).toBe(true);expect(report.source_functional_closing_minor).toBe(0);close(w,stmt,report);
});

test('subsequent cash revaluation uses foreign collection receipts as native and USD basis sources',()=>{
  const {w,start,bank,obligation}=setup();const s=settlement(w,bank,obligation,quote(w,'13','10'));const valuation=act(w,{type:'revalue_bank_account',bank_account_id:bank.id,quote_id:quote(w,'7','5').id}).valuation;expect(valuation.adjustment_minor).toBe(1000);expect(valuation.functional_source_operation_ids.includes(s.operation_id)).toBeTruthy();expect(treasuryValuationProof(w,valuation.id).functional_minor).toBe(1000);
  const stmt=statement(w,bank,start),report=prepare(w,stmt);expect(report.can_close,JSON.stringify(report.blockers)).toBe(true);expect(report.bank_closing_minor).toBe(10000);expect(report.functional_book_closing_minor).toBe(14000);
});

test('closed-period foreign receipts and valuation recover once with separate native and functional timing',()=>{
  const {w,start,bank,obligation}=setup();act(w,{type:'close_period'},controller);settlement(w,bank,obligation,quote(w,'13','10'));act(w,{type:'revalue_bank_account',bank_account_id:bank.id,quote_id:quote(w,'7','5').id});const cutoff=w.now,stmt=statement(w,bank,start,cutoff),blocked=prepare(w,stmt);expect(blocked.can_close).toBe(false);expect(blocked.blockers.some((row:any)=>row.code==='missing_cash_journal')).toBeTruthy();const rows=structuredClone(w.bankTransactions);
  tick(w,2);act(w,{type:'reopen_period'},controller);const report=prepare(w,stmt);expect(report.can_close,JSON.stringify(report.blockers)).toBe(true);expect(report.book_closing_minor).toBe(0);expect(report.functional_book_closing_minor).toBe(0);expect(report.later_posted_cash_minor).toBe(10000);expect(report.later_posted_functional_minor).toBe(14000);expect(report.adjusted_functional_difference_minor).toBe(0);close(w,stmt,report);expect(w.bankTransactions).toStrictEqual(rows);
});

test('later partial settlement, future revaluation and route disable do not stale prior cash evidence',()=>{
  const {w,start,bank,party,obligation}=setup();settlement(w,bank,obligation,quote(w,'13','10'),5000);const stmt=statement(w,bank,start),first=prepare(w,stmt);tick(w);act(w,{type:'revalue_foreign_obligation',kind:'invoice',obligation_id:obligation.id,quote_id:quote(w,'7','5').id});settlement(w,bank,obligation,quote(w,'3','2'),5000);act(w,{type:'set_foreign_counterparty_status',counterparty_id:party.id,enabled:false,reason:'Future collections suspended',external_event_id:source()},controller);
  const second=prepare(w,stmt);expect(second.can_close,JSON.stringify(second.blockers)).toBe(true);expect(second.source_fingerprint).toBe(first.source_fingerprint);expect(second.bank_closing_minor).toBe(5000);expect(second.functional_book_closing_minor).toBe(6500);close(w,stmt,second);
});

test('native AP cash reservation blocks a competing treasury transfer before any bank effect',()=>{
  const {w,bank,obligation}=setup('bill'),q=quote(w);settlement(w,bank,obligation,q,8000,false);expect(bankReserved(w,bank.id)).toBe(8000);reject(w,{type:'request_treasury_transfer',from_account_id:bank.id,to_account_id:'cash-bank',amount_minor:2001,quote_id:q.id,reason:'Competing transfer'},'insufficient_funds');expect(nativeBankBalance(w,bank.id)).toBe(10000);
});

test('foreign receipt reconciliation rejects missing approval, repriced quote and changed cash or obligation basis',()=>{
  const {w,start,bank,obligation}=setup(),s=settlement(w,bank,obligation,quote(w,'13','10')),stmt=statement(w,bank,start);
  for(const edit of [(copy:World)=>{copy.approvals.find(row=>row.id===s.approval_id).decided_by=s.requested_by;},(copy:World)=>{copy.fxQuotes.find((row:any)=>row.id===s.quote_id).numerator='14';},(copy:World)=>{copy.foreignSettlements[0].released_historical_minor++;},(copy:World)=>{copy.bankTransactions.find(row=>row.id===s.bank_transaction_id).functional_amount_minor++;}]){const copy=structuredClone(w);edit(copy);const report=prepare(copy,stmt);expect(report.can_close).toBe(false);expect(report.blockers.some((row:any)=>row.code==='invalid_foreign_cash_proof')).toBeTruthy();}
  const wrongJournal=structuredClone(w),op=wrongJournal.operations.find(row=>row.id===s.operation_id);wrongJournal.journals.find(row=>row.id===op.journal_id).lines.find((line:any)=>line.account_id==='fx-realized-gain-loss').account_id='equity';expect(prepare(wrongJournal,stmt).blockers.some((row:any)=>row.code==='foreign_settlement_journal_mismatch')).toBeTruthy();
});

test('immutable source recognition facts participate in the prepared fingerprint',()=>{
  const {w,start,bank,obligation}=setup();settlement(w,bank,obligation,quote(w));const stmt=statement(w,bank,start),report=prepare(w,stmt);w.foreignContracts[0].amount_minor++;reject(w,{type:'close_reconciliation',statement_id:stmt.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:source()},'stale_reconciliation',reviewer);
});

test('a receipt on another account must retain its native cash proof before it can reduce later obligation basis',()=>{
  const {w,bank,obligation}=setup();const valuationQuote=quote(w,'6','5');act(w,{type:'revalue_foreign_obligation',kind:'invoice',obligation_id:obligation.id,quote_id:valuationQuote.id});const first=settlement(w,bank,obligation,quote(w,'13','10'),5000),start=w.now;
  const secondBank=act(w,{type:'record_bank_account',name:'Second EUR account',currency:'EUR',external_account_id:source(),external_event_id:source()},controller).bank_account;settlement(w,secondBank,obligation,quote(w,'7','5'),5000);const stmt=statement(w,secondBank,start),report=prepare(w,stmt);expect(report.can_close,JSON.stringify(report.blockers)).toBe(true);
  const missing=structuredClone(w);missing.bankTransactions=missing.bankTransactions.filter(row=>row.id!==first.bank_transaction_id);const blocked=prepare(missing,stmt);expect(blocked.can_close).toBe(false);expect(blocked.blockers.some((row:any)=>row.code==='invalid_foreign_cash_proof')).toBeTruthy();
  const repriced=structuredClone(w);repriced.fxQuotes.find((row:any)=>row.id===valuationQuote.id).numerator='7';reject(repriced,{type:'close_reconciliation',statement_id:stmt.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:source()},'stale_reconciliation',reviewer);
});

test('disabled USD operating route does not disable a separate verified foreign settlement account',()=>{
  for(const kind of ['invoice','bill'] as const){const {w,bank,obligation}=setup(kind),q=quote(w);act(w,{type:'set_bank_account_status',bank_account_id:'cash-bank',enabled:false,reason:'USD route only suspended',external_event_id:source()},controller);const receipt=settlement(w,bank,obligation,q);expect(receipt.status).toBe('settled');expect(nativeBankBalance(w,bank.id)).toBe(kind==='invoice'?10000:0);expect(foreignSettlementCashProof(w,receipt.operation_id,bank.id)).toBeTruthy();}
});

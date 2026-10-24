import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError} from './world.ts';
import type {Action,Actor,World} from './world.ts';
import {nativeBankBalance,treasuryValuationProof} from './treasury.ts';
const operator:Actor={id:'cash-preparer',role:'agent'},controller:Actor={id:'cash-source-controller',role:'controller'},reviewer:Actor={id:'cash-independent-closer',role:'controller'};
let serial=0;const source=()=>`native-cash-source-${++serial}`;
const act=(w:World,action:Action,actor=operator)=>applyAction(w,action,actor).result;
const tick=(w:World,hours=1)=>act(w,{type:'advance_time',hours},controller);
function setup(){const w=createWorld({kind:'saas-collections',orderCount:1}),start=w.now,eur=act(w,{type:'record_bank_account',name:'Euro account',currency:'EUR',external_account_id:source(),external_event_id:source()},controller).bank_account;return {w,start,eur};}
function quote(w:World,n='11',d='10'){return act(w,{type:'record_fx_quote',source_quote_id:source(),base_currency:'EUR',quote_currency:'USD',numerator:n,denominator:d,observed_at:w.now,expires_at:new Date(Date.parse(w.now)+86400000).toISOString(),external_event_id:source()},controller).quote;}
function buy(w:World,eur:any){const q=quote(w),request=act(w,{type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:eur.id,amount_minor:11000,quote_id:q.id,reason:'Fund EUR operations'});act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},reviewer);tick(w);return w.treasuryTransfers.find((row:any)=>row.id===request.transfer.id);}
function statement(w:World,accountId:string,start:string,end=w.now){
  const owner=w.bankAccounts.find((row:any)=>row.id===accountId),rows=w.bankTransactions.filter(row=>row.account_id===accountId&&row.status==='posted'&&row.posted_at<=end),window=rows.filter(row=>row.posted_at>start&&row.amount_minor!==0),opening=rows.filter(row=>row.posted_at<=start).reduce((sum,row)=>sum+row.amount_minor,0),closing=rows.reduce((sum,row)=>sum+row.amount_minor,0);
  const result=act(w,{type:'record_bank_statement',source_statement_id:source(),account_id:accountId,currency:owner.currency,start_at:start,end_at:end,opening_balance_minor:opening,closing_balance_minor:closing,lines:window.map(row=>({source_line_id:source(),posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.id]})),external_event_id:source()},controller).statement;
  for(let index=0;index<window.length;index++)act(w,{type:'match_statement_line',statement_id:result.id,line_id:result.lines[index].id,bank_transaction_ids:[window[index].id]});return result;
}
const prepare=(w:World,s:any)=>act(w,{type:'prepare_reconciliation',statement_id:s.id}).report;
const close=(w:World,s:any,r:any,ids=r.timing_items.map((item:any)=>item.id))=>act(w,{type:'close_reconciliation',statement_id:s.id,report_id:r.id,source_fingerprint:r.source_fingerprint,acknowledged_timing_item_ids:ids,external_event_id:source()},reviewer);
function rejects(w:World,action:Action,code:string,actor=operator){const before=structuredClone(w);expect(()=>act(w,action,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);}

test('each side of one atomic transfer reconciles its own bank account in native units',()=>{
  const {w,start,eur}=setup(),transfer=buy(w,eur),usd=statement(w,'cash-bank',start),foreign=statement(w,eur.id,start),before=structuredClone({bank:w.bankTransactions,journals:w.journals});
  const usdReport=prepare(w,usd),eurReport=prepare(w,foreign);expect(usdReport.can_close).toBe(true);expect(eurReport.can_close).toBe(true);expect(eurReport.bank_closing_minor).toBe(10000);expect(eurReport.book_closing_minor).toBe(10000);expect(eurReport.functional_book_closing_minor).toBe(11000);expect(eurReport.currency).toBe('EUR');expect(eurReport.adjusted_functional_difference_minor).toBe(0);
  expect(w.reconciliationMatches.filter((row:any)=>row.status==='active').length).toBe(2);expect(new Set(w.bankTransactions.filter(row=>row.treasury_transfer_id===transfer.id).map(row=>row.source_id)).size).toBe(1);close(w,usd,usdReport);close(w,foreign,eurReport);expect({bank:w.bankTransactions,journals:w.journals}).toStrictEqual(before);
});

test('noncash revaluation changes the functional USD bridge without changing native reconciliation',()=>{
  const {w,start,eur}=setup();buy(w,eur);const q=quote(w,'6','5'),valuation=act(w,{type:'revalue_bank_account',bank_account_id:eur.id,quote_id:q.id}).valuation;expect(treasuryValuationProof(w,valuation.id).native_minor).toBe(0);
  const s=statement(w,eur.id,start),report=prepare(w,s);expect(report.can_close).toBe(true);expect(report.bank_closing_minor).toBe(10000);expect(report.book_closing_minor).toBe(10000);expect(report.functional_book_closing_minor).toBe(12000);expect(report.source_functional_closing_minor).toBe(12000);expect(report.timing_items.length).toBe(0);close(w,s,report);expect(nativeBankBalance(w,eur.id)).toBe(10000);
});

test('deferred native settlement and FX valuation require distinct cutoff timing acknowledgments',()=>{
  const {w,start,eur}=setup();act(w,{type:'close_period'},controller);buy(w,eur);act(w,{type:'revalue_bank_account',bank_account_id:eur.id,quote_id:quote(w,'6','5').id});const cutoff=w.now,s=statement(w,eur.id,start,cutoff),blocked=prepare(w,s);expect(blocked.can_close).toBe(false);expect(blocked.blockers.some((item:any)=>item.code==='missing_cash_journal')).toBeTruthy();expect(blocked.blockers.some((item:any)=>item.code==='unposted_fx_valuation')).toBeTruthy();
  tick(w,2);act(w,{type:'reopen_period'},controller);const report=prepare(w,s);expect(report.can_close).toBe(true);expect(report.book_closing_minor).toBe(0);expect(report.functional_book_closing_minor).toBe(0);expect(report.later_posted_cash_minor).toBe(10000);expect(report.later_posted_functional_minor).toBe(12000);expect(report.adjusted_difference_minor).toBe(0);expect(report.adjusted_functional_difference_minor).toBe(0);
  const valuation=report.timing_items.find((item:any)=>item.kind==='fx_valuation_posted_after_cutoff');expect(valuation.cash_effect_minor).toBe(0);expect(valuation.functional_cash_effect_minor).toBe(1000);
  rejects(w,{type:'close_reconciliation',statement_id:s.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.filter((item:any)=>item.id!==valuation.id).map((item:any)=>item.id),external_event_id:source()},'timing_acknowledgment_required',reviewer);close(w,s,report);
});

test('future-period revaluation does not stale a prepared historical cutoff',()=>{
  const {w,start,eur}=setup();buy(w,eur);const s=statement(w,eur.id,start),report=prepare(w,s);tick(w);act(w,{type:'revalue_bank_account',bank_account_id:eur.id,quote_id:quote(w,'6','5').id});const unchanged=prepare(w,s);expect(unchanged.source_fingerprint).toBe(report.source_fingerprint);expect(unchanged.functional_book_closing_minor).toBe(11000);expect(unchanged.source_functional_closing_minor).toBe(11000);close(w,s,unchanged);
});

test('revaluation at an already closed cutoff requires explicit reopening',()=>{
  const {w,start,eur}=setup();buy(w,eur);const s=statement(w,eur.id,start);close(w,s,prepare(w,s));const q=quote(w,'6','5');rejects(w,{type:'revalue_bank_account',bank_account_id:eur.id,quote_id:q.id},'treasury_closed_statement');act(w,{type:'reopen_reconciliation',statement_id:s.id,reason:'Record source valuation at this cutoff',external_event_id:source()},controller);act(w,{type:'revalue_bank_account',bank_account_id:eur.id,quote_id:q.id});expect(prepare(w,s).functional_book_closing_minor).toBe(12000);
});

test('bank identities cannot cross account or currency boundaries even when both legs share a receipt',()=>{
  const {w,start,eur}=setup(),transfer=buy(w,eur),s=statement(w,eur.id,start);act(w,{type:'unmatch_statement_line',statement_id:s.id,line_id:s.lines[0].id,reason:'Test source binding'});const wrong=w.bankTransactions.find(row=>row.treasury_transfer_id===transfer.id&&row.account_id==='cash-bank');rejects(w,{type:'match_statement_line',statement_id:s.id,line_id:s.lines[0].id,bank_transaction_ids:[wrong.id]},'invalid_statement_match');
  rejects(w,{type:'record_bank_statement',source_statement_id:source(),account_id:eur.id,currency:'USD',start_at:start,end_at:w.now,opening_balance_minor:0,closing_balance_minor:0,lines:[],external_event_id:source()},'unsupported_statement_account',controller);
});

test('missing counterpart legs or forged native-to-functional journal proof block closure',()=>{
  const {w,start,eur}=setup(),transfer=buy(w,eur),s=statement(w,eur.id,start),operation=w.operations.find(row=>row.id===transfer.operation_id);
  for(const corrupt of [
    (copy:World)=>{copy.bankTransactions=copy.bankTransactions.filter(row=>!(row.source_id===operation.id&&row.account_id==='cash-bank'));},
    (copy:World)=>{copy.treasuryTransfers[0].released_historical_minor++;},
    (copy:World)=>{copy.fxQuotes[0].numerator='2';},
    (copy:World)=>{copy.journals.find(row=>row.id===operation.journal_id).lines.find((line:any)=>line.account_id===eur.gl_account_id).debit_minor++;},
  ]){const copy=structuredClone(w);corrupt(copy);const report=prepare(copy,s);expect(report.can_close).toBe(false);expect(report.blockers.some((item:any)=>['invalid_treasury_cash_proof','treasury_journal_mismatch'].includes(item.code))).toBeTruthy();}
});

test('valuation quote and exact functional journal are source-bound and relevant edits stale prepared reports',()=>{
  const {w,start,eur}=setup();buy(w,eur);const valuation=act(w,{type:'revalue_bank_account',bank_account_id:eur.id,quote_id:quote(w,'6','5').id}).valuation,s=statement(w,eur.id,start),report=prepare(w,s);
  const forged=structuredClone(w);forged.fxValuations[0].native_balance_minor++;const invalid=prepare(forged,s);expect(invalid.can_close).toBe(false);expect(invalid.blockers.some((item:any)=>item.code==='invalid_fx_valuation_proof')).toBeTruthy();
  const changed=structuredClone(w),operation=changed.operations.find(row=>row.id===valuation.operation_id),journal=changed.journals.find(row=>row.id===operation.journal_id);journal.lines.find((line:any)=>line.account_id==='fx-unrealized-gain-loss').account_id='equity';expect(prepare(changed,s).blockers.some((item:any)=>item.code==='fx_valuation_journal_mismatch')).toBeTruthy();
  const stale=structuredClone(w);stale.fxQuotes.find((row:any)=>row.id===valuation.quote_id).numerator='7';rejects(stale,{type:'close_reconciliation',statement_id:s.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:[],external_event_id:source()},'stale_reconciliation',reviewer);
});

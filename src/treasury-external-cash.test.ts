import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError} from './world.ts';
import type {Action,Actor,World} from './world.ts';
import {bankReserved,commitExternalCash,externalCashProof,externalCashReserved,functionalBankBalance,nativeBankBalance,planExternalCash,treasuryAccountRows} from './treasury.ts';
import type {ExternalCashPlan} from './treasury.ts';
const controller:Actor={id:'external-cash-controller',role:'controller'},operator:Actor={id:'external-cash-operator',role:'agent'};
let serial=0;const source=()=>`external-cash-test-${++serial}`;
const act=(w:World,a:Action,actor=operator)=>applyAction(w,a,actor).result;
function setup(funded=false){
  const w=createWorld({kind:'saas-collections',orderCount:1}),owner=act(w,{type:'record_bank_account',name:'EUR',currency:'EUR',external_account_id:source(),external_event_id:source()},controller).bank_account;
  if(funded){const q=quote(w,'11','10'),request=act(w,{type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:owner.id,amount_minor:11000,quote_id:q.id,reason:'Source funded account'});act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},controller);act(w,{type:'advance_time',hours:1},controller);}
  return {w,owner};
}
function quote(w:World,n:string,d:string){return act(w,{type:'record_fx_quote',source_quote_id:source(),base_currency:'EUR',quote_currency:'USD',numerator:n,denominator:d,observed_at:w.now,expires_at:new Date(Date.parse(w.now)+86400000).toISOString(),external_event_id:source()},controller).quote;}
/** Contract-level fixture: AR/AP source validation belongs to the foreign
 * module. This supplies its complete balanced journal to the cash-only bridge. */
function operation(w:World,plan:ExternalCashPlan){const deltas=[...plan.journal_deltas,['payables',plan.direction==='out'?plan.settlement_functional_minor:-plan.settlement_functional_minor] as [string,number]],op:any={id:source(),target_id:source(),type:plan.direction==='out'?'pay_foreign_bill':'collect_foreign_invoice',amount_minor:plan.amount_minor,currency:plan.currency,status:'pending',settled_at:w.now,journal_lines:deltas.filter(([,value])=>value!==0).map(([account_id,value])=>({account_id,...(value>0?{debit_minor:value}:{credit_minor:-value}),currency:'USD'}))};expect(deltas.reduce((sum,[,value])=>sum+value,0)).toBe(0);w.operations.push(op);return op;}
function commit(w:World,op:any,plan:ExternalCashPlan){const result=commitExternalCash(w,op,plan,{id:()=>source(),description:'Observed external settlement'});op.status='settled';op.accounting_status='pending_posting';return result;}
function unchanged(w:World,run:()=>unknown,code:string){const before=structuredClone(w);expect(run).toThrowSatisfying((error:any)=>error.code===code);expect(w).toStrictEqual(before);}

test('external collection adds actual native cash and equal quoted historical/carrying USD basis once',()=>{
  const {w,owner}=setup(),plan=planExternalCash(w,{bank_account_id:owner.id,direction:'in',amount_minor:5000,settlement_functional_minor:6000});expect(plan.cash_effect_native_minor).toBe(5000);expect(plan.cash_effect_functional_minor).toBe(6000);expect(plan.historical_change_minor).toBe(6000);expect(plan.cash_realized_gain_minor).toBe(0);
  const op=operation(w,plan),result=commit(w,op,plan);expect(nativeBankBalance(w,owner.id)).toBe(5000);expect(functionalBankBalance(w,owner.id)).toBe(6000);expect(w.bankAccounts.find((row:any)=>row.id===owner.id).historical_cost_minor).toBe(6000);expect(op.cash_legs.length).toBe(1);expect(result.bank_transaction.functional_amount_minor).toBe(6000);
  const before=structuredClone(w),replay=commitExternalCash(w,op,plan,{id:()=>{throw new Error('Replay allocated an ID');},description:'Same source'});expect(replay.replayed).toBe(true);expect(replay.bank_transaction.id).toBe(result.bank_transaction.id);expect(w).toStrictEqual(before);expect(externalCashProof(w,op.id,owner.id)?.native_minor).toBe(5000);
  const next=planExternalCash(w,{bank_account_id:owner.id,direction:'in',amount_minor:5000,settlement_functional_minor:7000});commit(w,operation(w,next),next);expect(nativeBankBalance(w,owner.id)).toBe(10000);expect(functionalBankBalance(w,owner.id)).toBe(13000);expect(w.bankAccounts.find((row:any)=>row.id===owner.id).historical_cost_minor).toBe(13000);
});

test('external payment releases pooled cash basis and recycles cash FX independently of payable FX',()=>{
  const {w,owner}=setup(true);act(w,{type:'revalue_bank_account',bank_account_id:owner.id,quote_id:quote(w,'6','5').id});
  const plan=planExternalCash(w,{bank_account_id:owner.id,direction:'out',amount_minor:5000,settlement_functional_minor:6500});expect(plan.cash_effect_native_minor).toBe(-5000);expect(plan.cash_effect_functional_minor).toBe(-6000);expect(plan.historical_change_minor).toBe(-5500);expect(plan.cash_realized_gain_minor).toBe(1000);expect(plan.cash_recycled_unrealized_minor).toBe(500);expect(plan.journal_deltas.reduce((sum,[,amount])=>sum+amount,0)).toBe(-6500);
  const op=operation(w,plan);commit(w,op,plan);expect(nativeBankBalance(w,owner.id)).toBe(5000);expect(functionalBankBalance(w,owner.id)).toBe(6000);expect(w.bankAccounts.find((row:any)=>row.id===owner.id).historical_cost_minor).toBe(5500);
  const last=planExternalCash(w,{bank_account_id:owner.id,direction:'out',amount_minor:5000,settlement_functional_minor:6000});commit(w,operation(w,last),last);expect(last.cash_realized_gain_minor).toBe(500);expect(last.cash_recycled_unrealized_minor).toBe(500);expect(nativeBankBalance(w,owner.id)).toBe(0);expect(functionalBankBalance(w,owner.id)).toBe(0);expect(w.bankAccounts.find((row:any)=>row.id===owner.id).historical_cost_minor).toBe(0);
});

test('marked native AP reservations block treasury spending without callbacks or cross-account netting',()=>{
  const {w,owner}=setup(true),q=quote(w,'11','10');w.operations.push({id:source(),type:'pay_foreign_bill',status:'pending',amount_minor:8000,currency:'EUR',cash_reservation:{bank_account_id:owner.id,currency:'EUR',amount_minor:8000}});
  expect(externalCashReserved(w,owner.id)).toBe(8000);expect(bankReserved(w,owner.id)).toBe(8000);expect(bankReserved(w,'cash-bank',123)).toBe(123);expect(treasuryAccountRows(w).find((row:any)=>row.id===owner.id).available_balance_minor).toBe(2000);
  const before=structuredClone(w);expect(()=>act(w,{type:'request_treasury_transfer',from_account_id:owner.id,to_account_id:'cash-bank',amount_minor:2001,quote_id:q.id,reason:'Must respect existing AP cash'})).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='insufficient_funds');expect(w).toStrictEqual(before);
  w.operations.at(-1)!.status='cancelled';expect(bankReserved(w,owner.id)).toBe(0);w.operations.at(-1)!.status='pending';w.operations.at(-1)!.cash_reservation.currency='USD';expect(()=>externalCashReserved(w,owner.id)).toThrowSatisfying((error:any)=>error.code==='invalid_cash_reservation');
});

test('cash plan validation is pure and commit rejects stale basis or mismatched operation before mutation',()=>{
  const {w,owner}=setup(true),input={bank_account_id:owner.id,direction:'out' as const,amount_minor:10001,settlement_functional_minor:11001};unchanged(w,()=>planExternalCash(w,input),'insufficient_cash_after_external_event');
  const plan=planExternalCash(w,{...input,amount_minor:5000,settlement_functional_minor:5500}),op=operation(w,plan);op.journal_lines[0].credit_minor++;unchanged(w,()=>commitExternalCash(w,op,plan,{id:()=>source(),description:'Mismatch'}),'invalid_external_cash_proof');op.journal_lines[0].credit_minor--;
  act(w,{type:'revalue_bank_account',bank_account_id:owner.id,quote_id:quote(w,'6','5').id});const current=w.operations.find(row=>row.id===op.id);unchanged(w,()=>commitExternalCash(w,current,plan,{id:()=>source(),description:'Stale'}),'stale_external_cash_plan');
});

test('external one-leg proof rejects forged direction, basis, receipts, duplicate rows and functional cash',()=>{
  const {w,owner}=setup(true),plan=planExternalCash(w,{bank_account_id:owner.id,direction:'out',amount_minor:5000,settlement_functional_minor:6000}),op=operation(w,plan);commit(w,op,plan);
  const edits=[(copy:World)=>{copy.operations.find(row=>row.id===op.id).external_cash_plan.cash_realized_gain_minor++;},(copy:World)=>{copy.bankTransactions.find(row=>row.source_id===op.id).receipt_id='wrong';},(copy:World)=>{copy.bankTransactions.push({...copy.bankTransactions.find(row=>row.source_id===op.id),id:source()});},(copy:World)=>{copy.operations.find(row=>row.id===op.id).cash_legs[0].currency='USD';},(copy:World)=>{copy.operations.find(row=>row.id===op.id).journal_lines[0].credit_minor++;}];
  for(const edit of edits){const copy=structuredClone(w);edit(copy);expect(()=>externalCashProof(copy,op.id,owner.id)).toThrowSatisfying((error:any)=>error.code==='invalid_external_cash_proof');}
});

test('commit excludes its own just-settled deferred journal and never posts or invents a second leg',()=>{
  const {w,owner}=setup(),plan=planExternalCash(w,{bank_account_id:owner.id,direction:'in',amount_minor:100,settlement_functional_minor:110}),op=operation(w,plan);op.status='settled';const journals=w.journals.length;commit(w,op,plan);expect(w.journals.length).toBe(journals);expect(w.bankTransactions.filter(row=>row.source_id===op.id).length).toBe(1);expect(functionalBankBalance(w,owner.id)).toBe(110);expect(nativeBankBalance(w,owner.id)).toBe(100);
  unchanged(w,()=>commitExternalCash(w,op,{...plan,settlement_functional_minor:111},{id:()=>source(),description:'Repriced replay'}),'external_cash_replay_conflict');
});

test('disabled accounts, USD mismatches and unsafe aggregate basis reject without financial effects',()=>{
  const {w,owner}=setup(),input={bank_account_id:owner.id,direction:'in' as const,amount_minor:100,settlement_functional_minor:110};act(w,{type:'set_bank_account_status',bank_account_id:owner.id,enabled:false,reason:'External route unverified',external_event_id:source()},controller);unchanged(w,()=>planExternalCash(w,input),'bank_account_disabled');
  unchanged(w,()=>planExternalCash(w,{...input,bank_account_id:'cash-bank'}),'external_cash_currency_mismatch');act(w,{type:'set_bank_account_status',bank_account_id:owner.id,enabled:true,reason:'External route verified',external_event_id:source()},controller);
  w.accounts.find(row=>row.id===owner.gl_account_id).balance_minor=Number.MAX_SAFE_INTEGER-10;w.bankAccounts.find((row:any)=>row.id===owner.id).historical_cost_minor=Number.MAX_SAFE_INTEGER-10;unchanged(w,()=>planExternalCash(w,input),'treasury_balance_overflow');
});

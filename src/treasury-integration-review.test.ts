import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError,summarize} from './world.ts';
import type {Action,Actor,World} from './world.ts';
import {functionalBankBalance,nativeBankBalance,treasuryReserved} from './treasury.ts';
import {providerRequest} from './provider-adapters.ts';
import {currencyScale} from './money.ts';
const operator:Actor={id:'integration-treasurer',role:'agent'},controller:Actor={id:'integration-controller',role:'controller'};
let seq=0;const source=()=>`integration-source-${++seq}`;
const act=(w:World,a:Action,actor=operator)=>applyAction(w,a,actor).result;
const tick=(w:World,hours=1)=>act(w,{type:'advance_time',hours},controller);
const approve=(w:World,result:any)=>act(w,{type:'decide_approval',approval_id:result.approval_id,decision:'approve'},controller);
function status(w:World,enabled:boolean){return act(w,{type:'set_bank_account_status',bank_account_id:'cash-bank',enabled,reason:enabled?'Verified source route restored':'Observed operating route unavailable',external_event_id:source()},controller);}
function pending(type:string){
  let w:World,result:any;
  if(type==='refund'){w=createWorld({kind:'ticket-cancellation',orderCount:1,cancelEvent:true,approvalThresholdMinor:1e12});result=act(w,{type,payment_id:w.payments[0].id,amount_minor:100});}
  else if(type==='pay_bill'){w=createWorld({kind:'supplier-fraud',orderCount:1,approvalThresholdMinor:1e12});result=act(w,{type,bill_id:w.bills[0].id,amount_minor:100});}
  else if(type==='collect_invoice'){w=createWorld({kind:'saas-collections',orderCount:1});result=act(w,{type,invoice_id:w.invoices[0].id,amount_minor:100});}
  else{w=createWorld({kind:'payroll-close',orderCount:1,payrollControls:{missingTime:false,disabledRoute:false}});const run=act(w,{type:'calculate_payroll',policy_id:w.payrollPolicies[0].id,time_record_ids:w.payrollTimeRecords.map((row:any)=>row.id)}).payroll_run;result=approve(w,act(w,{type:'execute_payroll',payroll_run_id:run.id}));if(type==='remit_payroll_taxes'){tick(w);result=approve(w,act(w,{type,payroll_run_id:run.id}));}}
  return {w,operationId:result.operation.id};
}
function foreign(w:World){return act(w,{type:'record_bank_account',name:'EUR',currency:'EUR',external_account_id:source(),external_event_id:source()},controller).bank_account;}
function quote(w:World){return act(w,{type:'record_fx_quote',source_quote_id:source(),base_currency:'EUR',quote_currency:'USD',numerator:'11',denominator:'10',observed_at:w.now,expires_at:new Date(Date.parse(w.now)+86400000).toISOString(),external_event_id:source()},controller).quote;}
function reject(w:World,input:Action,code:string,actor=operator){const before=structuredClone(w);expect(()=>act(w,input,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);}
async function provider(w:World,system:string,path:string,input?:any){const url=new URL(path,'http://local.test');return providerRequest({world:w,system,route:url.pathname,url,method:input?'POST':'GET',input,execute:action=>act(w,action)});}

test('disabled legacy bank account holds every accepted settlement rail without duplicate recovery',()=>{
  for(const type of ['refund','pay_bill','collect_invoice','execute_payroll','remit_payroll_taxes']){
    const {w,operationId}=pending(type);status(w,false);const before=structuredClone({bank:w.bankTransactions,journals:w.journals});tick(w);expect({bank:w.bankTransactions,journals:w.journals},type).toStrictEqual(before);expect(w.operations.find(row=>row.id===operationId).status,type).toBe('pending');expect(w.operations.find(row=>row.id===operationId).last_error,type).toMatch(/disabled/);
    status(w,true);tick(w);expect(w.operations.find(row=>row.id===operationId).status,type).toBe('settled');expect(w.bankTransactions.filter(row=>row.source_id===operationId).length,type).toBe(1);const count=w.bankTransactions.length,journals=w.journals.length;tick(w);expect(w.bankTransactions.length,type).toBe(count);expect(w.journals.length,type).toBe(journals);
  }
});

test('legacy default journal lines are frozen before deferral and effective functional balance remains true',()=>{
  for(const type of ['refund','pay_bill','collect_invoice']){
    const {w,operationId}=pending(type),cash=nativeBankBalance(w,'cash-bank');act(w,{type:'close_period'},controller);tick(w);const operation=w.operations.find(row=>row.id===operationId);expect(operation.status).toBe('settled');expect(operation.accounting_status).toBe('pending_posting');expect(operation.journal_lines.length).toBe(2);expect(w.accounts.find(row=>row.id==='cash-bank').balance_minor).toBe(cash);expect(functionalBankBalance(w,'cash-bank')).toBe(nativeBankBalance(w,'cash-bank'));
    const lines=structuredClone(operation.journal_lines),bank=structuredClone(w.bankTransactions);tick(w,2);act(w,{type:'reopen_period'},controller);expect(w.operations.find(row=>row.id===operationId).journal_lines).toStrictEqual(lines);expect(w.bankTransactions).toStrictEqual(bank);expect(w.accounts.find(row=>row.id==='cash-bank').balance_minor).toBe(nativeBankBalance(w,'cash-bank'));
  }
});

test('every legacy outgoing obligation consumes the same USD liquidity before FX approval',()=>{
  for(const type of ['refund','pay_bill','execute_payroll','remit_payroll_taxes']){
    const {w,operationId}=pending(type),eur=foreign(w),q=quote(w),reserved=w.operations.find(row=>row.id===operationId).amount_minor,amount=nativeBankBalance(w,'cash-bank')-reserved+1;
    reject(w,{type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:eur.id,amount_minor:amount,quote_id:q.id,reason:'Cannot spend committed payroll or supplier money'},'insufficient_funds');expect(treasuryReserved(w,'cash-bank')).toBe(0);expect(nativeBankBalance(w,eur.id)).toBe(0);
  }
});

test('pending FX source debit and fee reduce legacy refund capacity without summing foreign accounts',()=>{
  const w=createWorld({kind:'ticket-cancellation',orderCount:1,cancelEvent:true,approvalThresholdMinor:1e12}),eur=foreign(w),q=quote(w),cash=nativeBankBalance(w,'cash-bank'),request=act(w,{type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:eur.id,amount_minor:cash-100,fee_minor:50,quote_id:q.id,reason:'Fund account and reserve exact fee'});approve(w,request);expect(summarize(w).available_cash_minor).toBe(50);expect(treasuryReserved(w,'cash-bank')).toBe(cash-50);
  reject(w,{type:'refund',payment_id:w.payments[0].id,amount_minor:51},'insufficient_funds');tick(w);expect(summarize(w).cash_minor).toBe(50);expect(nativeBankBalance(w,eur.id)>0).toBeTruthy();reject(w,{type:'refund',payment_id:w.payments[0].id,amount_minor:51},'insufficient_funds');
});

test('provider account and transaction projections retain real native currency scales and account filters',async()=>{
  for(const currency of ['EUR','GBP','JPY','KWD']){
    const w=createWorld({kind:'treasury-fx',treasuryControls:{foreignCurrency:currency as any}}),id=w.treasurySources.bank_account_id,owner=w.bankAccounts.find((row:any)=>row.id===id),native=nativeBankBalance(w,id),scale=currencyScale(currency),mercury=await provider(w,'mercury','/api/v1/accounts'),foreignAccount=mercury!.body.accounts.find((row:any)=>row.id===id);expect(foreignAccount.currency).toBe(currency);expect(foreignAccount.currentBalance).toBe(native/scale);expect(id).not.toBe('cash-bank');
    const transactions=await provider(w,'mercury',`/api/v1/account/${encodeURIComponent(id)}/transactions`);expect(transactions!.body.transactions.every((row:any)=>row.accountId===id&&row.currency===currency)).toBeTruthy();expect(transactions!.body.transactions.reduce((sum:number,row:any)=>sum+Math.round(row.amount*scale),0)).toBe(native);
    const plaid=await provider(w,'plaid','/accounts/get',{options:{account_ids:[id]}});expect(plaid!.body.accounts.length).toBe(1);expect(plaid!.body.accounts[0].balances.iso_currency_code).toBe(currency);expect(plaid!.body.accounts[0].balances.current).toBe(native/scale);
    const sync=await provider(w,'plaid','/transactions/sync',{count:500});expect(sync!.body.added.some((row:any)=>row.account_id===id&&row.iso_currency_code===currency&&Math.round(-row.amount*scale)===native)).toBeTruthy();expect(summarize(w).cash_minor).toBe(nativeBankBalance(w,'cash-bank'));expect(owner.historical_cost_minor).toBe(w.treasuryControls.fundingMinor);
  }
});

test('small scenario mandates remain executable or fail explicitly before returning a broken world',()=>{
  for(const [currency,funding,expected] of [['EUR',2,1],['KWD',1,3],['JPY',2,3]] as const){const w=createWorld({kind:'treasury-fx',treasuryControls:{foreignCurrency:currency,fundingMinor:funding,feeMinor:0}}),sources=w.treasurySources;expect(sources.requested_repatriation_minor).toBe(expected);const result=act(w,{type:'request_treasury_transfer',from_account_id:sources.bank_account_id,to_account_id:'cash-bank',amount_minor:sources.requested_repatriation_minor,quote_id:sources.closing_quote_id,reason:'Complete the minimum-sized mandate'});expect(result.transfer.destination_amount_minor>=1).toBeTruthy();}
  expect(()=>createWorld({kind:'treasury-fx',treasuryControls:{foreignCurrency:'JPY',fundingMinor:1,feeMinor:0}})).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='insufficient_treasury_seed_cash');
});

test('scenario FX quote expiry follows simulated UTC across a month boundary',()=>{
  const w=createWorld({kind:'treasury-fx'}),sources=w.treasurySources;tick(w,8*24);expect(w.now).toMatch(/^2026-11-01T/);reject(w,{type:'revalue_bank_account',bank_account_id:sources.bank_account_id,quote_id:sources.closing_quote_id},'fx_quote_expired');expect(w.fxValuations.length).toBe(0);expect(w.treasuryTransfers.length).toBe(1);
});

import {test,expect} from 'bun:test';
import {applyAction,createWorld,summarize} from './world.ts';
import {providerRequest} from './provider-adapters.ts';
const controller={id:'controller',role:'controller'} as const;
async function request(w:any,system:string,path:string,input?:any){return (await providerRequest({world:w,system,route:path,url:new URL(path,'http://test'),method:input?'POST':'GET',input,execute:()=>{throw Error('read only');}}))!.body;}
test('native currency bank adapters expose scoped balances and correct JPY/KWD exponents',async()=>{
 for(const [currency,divisor] of [['JPY',1],['KWD',1000]] as const){
  const w=createWorld({kind:'treasury-fx',initialCashMinor:200000,treasuryControls:{foreignCurrency:currency,fundingMinor:100000,feeMinor:25}});
  const owner=w.bankAccounts.find((a:any)=>a.currency===currency),native=w.bankTransactions.filter((t:any)=>t.account_id===owner.id).reduce((n:number,t:any)=>n+t.amount_minor,0);
  const before=JSON.stringify(w),accounts=await request(w,'mercury','/api/v1/accounts');
  expect(accounts.accounts.find((a:any)=>a.id===owner.id).currentBalance).toBe(native/divisor);
  expect(accounts.accounts.find((a:any)=>a.id==='cash-bank').currentBalance).toBe(999.75);
  const foreign=await request(w,'mercury',`/api/v1/accounts/${owner.id}/transactions`);
  expect(foreign.transactions.every((t:any)=>t.accountId===owner.id&&t.currency===currency)).toBe(true);
  expect(foreign.transactions.find((t:any)=>t.amount>0).amount).toBe(native/divisor);
  const usd=await request(w,'mercury','/api/v1/accounts/cash-bank/transactions');expect(usd.transactions.every((t:any)=>t.currency==='USD')).toBe(true);
  const plaid=await request(w,'plaid','/accounts/get',{options:{account_ids:[owner.id]}});expect(plaid.accounts).toHaveLength(1);expect(plaid.accounts[0].balances.iso_currency_code).toBe(currency);expect(plaid.accounts[0].balances.current).toBe(native/divisor);
  const sync=await request(w,'plaid','/transactions/sync',{});expect(sync.added.find((t:any)=>t.account_id===owner.id&&t.amount<0).amount).toBe(-native/divisor);
  expect(JSON.stringify(w)).toBe(before);expect(summarize(w).reconciliation.balanced).toBe(true);
  applyAction(w,{type:'set_bank_account_status',bank_account_id:owner.id,enabled:false,reason:'Source bank disabled route',external_event_id:'disable'},controller);
  const disabled=await request(w,'mercury','/api/v1/accounts');expect(disabled.accounts.find((a:any)=>a.id===owner.id).canReceiveTransactions).toBe(false);
 }
});
test('treasury scenario preserves actual receipts and deferred journals until controller reopening',()=>{
 const w=createWorld({kind:'treasury-fx',treasuryControls:{deferredPosting:true}});const ids=w.bankTransactions.map((row:any)=>row.id),receipts=w.operations.map((row:any)=>row.receipt_id);expect(w.settledUnposted.length).toBe(1);expect(w.fxValuations).toHaveLength(0);
 applyAction(w,{type:'reopen_period'},controller);expect(w.settledUnposted).toHaveLength(0);expect(w.bankTransactions.map((row:any)=>row.id)).toEqual(ids);expect(w.operations.map((row:any)=>row.receipt_id)).toEqual(receipts);
});

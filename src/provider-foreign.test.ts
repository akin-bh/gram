import {test,expect} from 'bun:test';
import {applyAction,createWorld,summarize} from './world.ts';
import {providerRequest} from './provider-adapters.ts';
import {currencyScale} from './money.ts';
const worker={id:'foreign-worker',role:'operator'} as const,judge={id:'reviewer',role:'controller'} as const;
async function get(w:any,system:string,path:string){const url=new URL(path,'http://projection.test');const result=await providerRequest({world:w,system,route:url.pathname,url,method:'GET',execute:()=>{throw Error('read-only projection');}});return result!.body;}
function settle(w:any,action:any){const requested=applyAction(w,action,worker).result;applyAction(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},judge);applyAction(w,{type:'advance_time',hours:1},judge);}
test('foreign ERP projections preserve native invoice/bill units, exact source FX and separate USD books across JPY and KWD',async()=>{
 for(const currency of ['JPY','KWD'] as const){
  const w=createWorld({kind:'foreign-service-close',orderCount:1,foreignControls:{currency}}),source=w.foreignSources,invoice=w.foreignInvoices[0],bill=w.foreignBills[0],scale=currencyScale(currency);
  settle(w,{type:'collect_foreign_invoice',invoice_id:invoice.id,bank_account_id:source.bank_account_id,amount_minor:invoice.amount_minor/2,quote_id:source.closing_quote_id});
  settle(w,{type:'pay_foreign_bill',bill_id:bill.id,bank_account_id:source.bank_account_id,amount_minor:250*scale,quote_id:source.closing_quote_id});
  const before=JSON.stringify(w),qb=await get(w,'quickbooks',`/v3/company/${w.id}/invoice/${invoice.id}`),ns=await get(w,'netsuite',`/services/rest/record/v1/invoice/${invoice.id}`);
  expect(qb.Invoice.TotalAmt).toBe(1000);expect(qb.Invoice.Balance).toBe(500);expect(qb.Invoice.CurrencyRef.value).toBe(currency);expect(qb.Invoice.finance_world.native_amount_minor).toBe(1000*scale);expect(qb.Invoice.finance_world.functional_currency).toBe('USD');expect(qb.Invoice.finance_world.recognition_quote.numerator).toBe(invoice.recognition_quote_snapshot.numerator);
  expect(ns.total).toBe(1000);expect(ns.amountRemaining).toBe(500);expect(ns.currency.id).toBe(currency);expect(ns.finance_world.carrying_minor).toBe(w.foreignInvoices[0].carrying_minor);
  const qbb=await get(w,'quickbooks',`/v3/company/${w.id}/bill/${bill.id}`),nsb=await get(w,'netsuite',`/services/rest/record/v1/vendorBill/${bill.id}`),ramp=await get(w,'ramp',`/developer/v1/bills/${bill.id}`);
  expect(qbb.Bill.TotalAmt).toBe(600);expect(qbb.Bill.Balance).toBe(350);expect(nsb.amountRemaining).toBe(350);expect(nsb.currency.id).toBe(currency);expect(ramp.amount).toBe(600*scale);expect(ramp.invoice_currency).toBe(currency);expect(ramp.payment_details.source_bank_account_id).toBeUndefined();expect(ramp.finance_world.native_settled_minor).toBe(250*scale);
  const customerQuery=await get(w,'quickbooks',`/v3/company/${w.id}/query?query=${encodeURIComponent('SELECT * FROM Customer')}`);expect(customerQuery.QueryResponse.Customer.find((row:any)=>row.Id===invoice.counterparty_id).CurrencyRef.value).toBe(currency);
  expect(w.journals.every((j:any)=>j.currency==='USD'&&j.lines.every((line:any)=>line.currency==='USD'))).toBe(true);expect(summarize(w).reconciliation.balanced).toBe(true);expect(w.foreignInvoices[0].amount_settled_minor).toBe(invoice.amount_minor/2);expect(JSON.stringify(w)).toBe(before);
 }
});
test('foreign document projections cannot cross worlds or silently use USD scaling for native fields',async()=>{
 const first=createWorld({kind:'foreign-service-close',orderCount:1,foreignControls:{currency:'EUR'}},'world-first'),second=createWorld({kind:'saas-collections',orderCount:1},'world-second');
 await expect(get(second,'quickbooks',`/v3/company/world-first/invoice/${first.foreignInvoices[0].id}`)).rejects.toThrow(/Realm/);
 await expect(get(second,'netsuite',`/services/rest/record/v1/invoice/${first.foreignInvoices[0].id}`)).rejects.toThrow(/not found/);
 const original=await get(second,'quickbooks',`/v3/company/world-second/invoice/${second.invoices[0].id}`);expect(original.Invoice.CurrencyRef.value).toBe('USD');expect(original.Invoice.TotalAmt).toBe(second.invoices[0].amount_minor/100);expect(original.Invoice.finance_world).toBeUndefined();
});

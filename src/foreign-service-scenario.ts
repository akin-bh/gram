import {z} from 'zod';
import {currencyScale} from './money.ts';
import type {World,Action,Actor} from './world.ts';
export const foreignControlsSchema=z.object({currency:z.enum(['EUR','GBP','JPY','KWD']).optional(),periodClosed:z.boolean().optional()}).strict();
export type ForeignControls=z.infer<typeof foreignControlsSchema>;
type Hooks={perform:(action:Action,actor:Actor)=>{result:any;events:any[]};document:(type:string,name:string,body:string,refs:any)=>any;mail:(message:any)=>any;fail:(code:string,message:string,status?:number)=>never};
/** Two completed service sides share a genuine same-currency bank account.
 * No opening foreign money is injected; collections must fund supplier payment.
 */
export function seedForeignServiceScenario(w:World,count:number,raw:ForeignControls|undefined,h:Hooks){
 const parsed=foreignControlsSchema.safeParse(raw??{});if(!parsed.success)h.fail('invalid_scenario','Invalid foreign service controls');const currency=parsed.data?.currency??'EUR',closed=parsed.data?.periodClosed??false;
 const actor={id:'seed-trade-controller',role:'controller'} as const;let step=0;w.generationHistory??=[];
 const perform=(action:Action)=>{const input={...action,...(['close_period','advance_time'].includes(action.type!)?{}:{external_event_id:`seed-trade-${++step}`})};const applied=h.perform(input,actor);w.generationHistory.push({index:w.generationHistory.length+1,actor:structuredClone(actor),action:structuredClone(input),result:structuredClone(applied.result),events:structuredClone(applied.events)});return applied.result;};
 const before=(days:number)=>new Date(Date.parse(w.now)-days*86400000).toISOString(),expires=new Date(Date.parse(w.now)+7*86400000).toISOString();
 const owner=perform({type:'record_bank_account',name:currency,currency,external_account_id:`trade-${currency.toLowerCase()}`}).bank_account;
 const [n,d]=({EUR:['11','10'],GBP:['13','10'],JPY:['1','150'],KWD:['13','4']} as const)[currency];
 const original=perform({type:'record_fx_quote',source_quote_id:'trade-recognition',base_currency:currency,quote_currency:'USD',numerator:n,denominator:d,observed_at:before(2),expires_at:expires}).quote;
 const current=perform({type:'record_fx_quote',source_quote_id:'trade-close',base_currency:currency,quote_currency:'USD',numerator:String(BigInt(n)*11n),denominator:String(BigInt(d)*10n),observed_at:w.now,expires_at:expires}).quote;
 const customer=perform({type:'record_foreign_counterparty',external_counterparty_id:'trade-customer',kind:'customer',name:'Studio',email:'billing@studio.test',currency}).counterparty,vendor=perform({type:'record_foreign_counterparty',external_counterparty_id:'trade-supplier',kind:'vendor',name:'Supply',email:'ap@supply.test',currency}).counterparty;
 if(closed)perform({type:'close_period'});
 const invoices:string[]=[],bills:string[]=[];
 for(let i=0;i<count;i++){
  const face=(1000+i*100)*currencyScale(currency),cost=Math.floor(face*3/5);
  for(const [party,kind,amount] of [[customer,'invoice',face],[vendor,'bill',cost]] as const){
   const contract=perform({type:'record_foreign_contract',external_contract_id:`trade-${kind}-contract-${i+1}`,counterparty_id:party.id,amount_minor:amount,description:`Completed ${kind==='invoice'?'client delivery':'supplier service'} ${i+1}`,signed_at:before(7)}).contract;
   const record=perform({type:kind==='invoice'?'record_foreign_invoice':'record_foreign_bill',contract_id:contract.id,source_invoice_id:`trade-${kind}-${i+1}`,amount_minor:amount,issued_at:before(1),due_at:before(0),service_completed_at:before(2),completion_reference:`accepted-${kind}-${i+1}`,quote_id:original.id})[kind];(kind==='invoice'?invoices:bills).push(record.id);
  }
 }
 w.foreignControls={currency,periodClosed:closed};w.foreignSources={bank_account_id:owner.id,recognition_quote_id:original.id,closing_quote_id:current.id,invoice_ids:invoices,bill_ids:bills};
 const doc=h.document('foreign-service-mandate','Trade close',`Review completed ${currency} services and the exact signed contract, completion and invoice sources. Revalue outstanding receivables and payables using closing quote ${current.id}. The verified ${currency} account starts at zero: request customer collections first, wait for independent approval and actual receipts, then request supplier payments from that same account. Never use USD operating cash as if it were ${currency}. Keep native obligations, original functional basis, current USD carrying value and realized/unrealized FX separate. ${closed?'The accounting period is closed; retain deferred journals until controller reopening.':''} Quotes are synthetic exercise facts, not live market prices.`,w.foreignSources);w.foreignSources.brief_document_id=doc.id;h.mail({from:'controller@simulation.test',subject:'Trade close',body:doc.body,source_refs:[doc.id,owner.id,original.id,current.id]});
}

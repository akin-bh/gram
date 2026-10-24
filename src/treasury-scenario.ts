import {z} from 'zod';
import type {World,Action,Actor} from './world.ts';
import {convertMinor} from './money.ts';
import {nativeBankBalance} from './treasury.ts';
export const treasuryControlsSchema=z.object({foreignCurrency:z.enum(['EUR','GBP','JPY','KWD']).optional(),fundingMinor:z.number().int().min(1).max(1e12).optional(),feeMinor:z.number().int().min(0).max(1e9).optional(),deferredPosting:z.boolean().optional()}).strict();
export type TreasuryControls=z.infer<typeof treasuryControlsSchema>;
type Hooks={perform:(action:Action,actor:Actor)=>any;document:(type:string,name:string,body:string,refs:any)=>any;mail:(message:any)=>any;fail:(code:string,message:string,status?:number)=>never};
/** Source quotes are explicitly synthetic scenario facts, never market prices.
 * The opening foreign balance is earned by an actual approved paired transfer.
 */
export function seedTreasuryScenario(w:World,raw:TreasuryControls|undefined,h:Hooks){
 const checked=treasuryControlsSchema.safeParse(raw??{});if(!checked.success)h.fail('invalid_scenario','Invalid treasury controls');const input=checked.data!;
 const controller={id:'seed-treasury-controller',role:'controller'} as const,operator={id:'seed-treasury-operator',role:'operator'} as const;
 const currency=input.foreignCurrency??'EUR',fee=input.feeMinor??25,balance=nativeBankBalance(w,'cash-bank'),funding=input.fundingMinor??Math.min(100000,Math.floor(balance/2));
 if(funding<1||funding+fee>balance)h.fail('insufficient_treasury_seed_cash','FX scenario requires enough opening USD cash to cover its funding and fee');
 const owner=h.perform({type:'record_bank_account',name:currency,currency,external_account_id:`synthetic-${currency.toLowerCase()}-treasury`,external_event_id:'seed-foreign-account'},controller).bank_account;
 const [numerator,denominator]=({EUR:['11','10'],GBP:['13','10'],JPY:['1','150'],KWD:['13','4']} as const)[currency];
 const quote=(key:string,n:string,d:string)=>h.perform({type:'record_fx_quote',source_quote_id:`synthetic-${key}`,base_currency:currency,quote_currency:'USD',numerator:n,denominator:d,observed_at:w.now,expires_at:new Date(Date.parse(w.now)+7*86400000).toISOString(),external_event_id:`seed-quote-${key}`},controller).quote;
 const acquisition=quote('acquisition',numerator,denominator);
 const requested=h.perform({type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:owner.id,amount_minor:funding,fee_minor:fee,quote_id:acquisition.id,reason:'Controller scenario mandate: fund the verified foreign operating account'},operator);
 h.perform({type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},controller);
 if(input.deferredPosting)h.perform({type:'close_period'},controller);
 h.perform({type:'advance_time',hours:1},controller);
 const closing=quote('closing',String(BigInt(numerator)*11n),String(BigInt(denominator)*10n));
 w.treasuryControls={foreignCurrency:currency,fundingMinor:funding,feeMinor:fee,deferredPosting:input.deferredPosting??false};
 const native=nativeBankBalance(w,owner.id);let repatriation=Math.floor(native/2);if(!repatriation||convertMinor(repatriation,closing,{rounding:'toward_zero'}).amount_minor<1)repatriation=native;if(!repatriation||convertMinor(repatriation,closing,{rounding:'toward_zero'}).amount_minor<1)h.fail('insufficient_treasury_seed_cash','Funding must support at least one USD cent of eventual repatriation at the closing quote');
 w.treasurySources={bank_account_id:owner.id,acquisition_quote_id:acquisition.id,closing_quote_id:closing.id,funding_transfer_id:requested.transfer.id,requested_repatriation_minor:repatriation};
 const doc=h.document('treasury-mandate','Foreign cash close',`Controller mandate: reconcile the actual funded ${currency} account ${owner.id}; revalue its native balance at closing source ${closing.id}; request a transfer of ${w.treasurySources.requested_repatriation_minor} ${currency} minor units to cash-bank with zero fee using that quote. Wait for independent approval and provider settlement. Source quotes are synthetic exercise facts, not live market data. Keep historical cost, current USD carrying value and native balance separate. ${input.deferredPosting?'The accounting period is closed; controller reopening is required for actual posting.':''}`,{...w.treasurySources});
 w.treasurySources.brief_document_id=doc.id;h.mail({from:'controller@simulation.test',subject:'Foreign cash close',body:doc.body,source_refs:[doc.id,owner.id,acquisition.id,closing.id,requested.transfer.id]});
}

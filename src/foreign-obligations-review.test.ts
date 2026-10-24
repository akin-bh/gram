import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {applyAction,createWorld,DomainError} from './world.ts';
import type {Action,Actor,World} from './world.ts';
import {foreignObligationReport,foreignSettlementCashProof} from './foreign-obligations.ts';
import {functionalBankBalance,nativeBankBalance} from './treasury.ts';

const controller:Actor={id:'precision-source',role:'controller'},operator:Actor={id:'precision-operator',role:'operator'},reviewer:Actor={id:'precision-reviewer',role:'controller'};
const act=(w:World,a:Action,actor=controller)=>applyAction(w,a,actor).result;
function fixture(currency:string,numerator:string,denominator:string){
  const w=createWorld({kind:'saas-collections',orderCount:1});let serial=0;
  const event=()=>`precision-review-${++serial}`;
  const bank=act(w,{type:'record_bank_account',external_account_id:event(),name:`${currency} source receipts`,currency,external_event_id:event()}).bank_account;
  const quote=act(w,{type:'record_fx_quote',source_quote_id:event(),base_currency:currency,quote_currency:'USD',numerator,denominator,observed_at:w.now,expires_at:new Date(Date.parse(w.now)+720*3600000).toISOString(),external_event_id:event()}).quote;
  const source=(kind:'invoice'|'bill',amount:number)=>{
    const party=act(w,{type:'record_foreign_counterparty',external_counterparty_id:event(),kind:kind==='invoice'?'customer':'vendor',name:`Source ${kind} party`,email:'accounts@precision.test',currency,external_event_id:event()}).counterparty;
    const contract=act(w,{type:'record_foreign_contract',external_contract_id:event(),counterparty_id:party.id,amount_minor:amount,description:'Completed services with exact original native source amount',signed_at:w.now,external_event_id:event()}).contract;
    return act(w,{type:kind==='invoice'?'record_foreign_invoice':'record_foreign_bill',contract_id:contract.id,source_invoice_id:event(),amount_minor:amount,issued_at:w.now,due_at:w.now,service_completed_at:w.now,completion_reference:event(),quote_id:quote.id,external_event_id:event()}).obligation;
  };
  const request=(obligation:any,amount:number)=>act(w,{type:obligation.kind==='invoice'?'collect_foreign_invoice':'pay_foreign_bill',[obligation.kind==='invoice'?'invoice_id':'bill_id']:obligation.id,bank_account_id:bank.id,amount_minor:amount,quote_id:quote.id},operator);
  const complete=(requested:any)=>{act(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},reviewer);act(w,{type:'advance_time',hours:1});const receipt=w.foreignSettlements.find((row:any)=>row.id===requested.settlement.id);assert.equal(receipt.status,'settled');return receipt;};
  return {w,bank,quote,source,request,complete,settle:(obligation:any,amount:number)=>complete(request(obligation,amount))};
}
const balance=(w:World,id:string)=>w.accounts.find(row=>row.id===id).balance_minor;
function verify(w:World){
  for(const journal of w.journals)assert.equal(journal.lines.reduce((sum:bigint,line:any)=>sum+BigInt(line.debit_minor??0)-BigInt(line.credit_minor??0),0n),0n);
  assert.equal(w.accounts.reduce((sum:bigint,row:any)=>sum+BigInt(row.balance_minor),0n),0n);
  assert.equal(foreignObligationReport(w).register_balanced,true);
}

for(const [currency,n,d,total,part] of [['JPY','1','150',150,1],['KWD','13','4',200,2]] as const)test(`many small ${currency} receipts preserve native principal, exact final basis and explicit rounded USD cash`,()=>{
  const f=fixture(currency,n,d),invoice=f.source('invoice',total);
  for(let paid=0;paid<total;paid+=part)f.settle(invoice,part);
  const actual=f.w.foreignInvoices[0],receipts=f.w.foreignSettlements;
  assert.equal(actual.amount_settled_minor,total);assert.equal(actual.carrying_minor,0);assert.equal(actual.historical_basis_minor,0);
  assert.equal(nativeBankBalance(f.w,f.bank.id),total);
  assert.equal(receipts.reduce((sum:number,row:any)=>sum+row.released_historical_minor,0),invoice.original_functional_minor);
  assert.equal(functionalBankBalance(f.w,f.bank.id),receipts.reduce((sum:number,row:any)=>sum+row.settlement_functional_minor,0));
  for(const receipt of receipts){assert.equal(receipt.obligation_realized_gain_minor,0,'Unchanged quotes must not create obligation exchange gain');assert.ok(foreignSettlementCashProof(f.w,receipt.operation_id,f.bank.id));}
  const immutable=structuredClone(receipts),banks=structuredClone(f.w.bankTransactions);
  act(f.w,{type:'revalue_bank_account',bank_account_id:f.bank.id,quote_id:f.quote.id},operator);
  assert.equal(functionalBankBalance(f.w,f.bank.id),invoice.original_functional_minor);
  assert.equal(balance(f.w,'fx-realized-gain-loss')+balance(f.w,'foreign-rounding-gain-loss')+balance(f.w,'fx-unrealized-gain-loss'),0,'At the unchanged source rate only receipt rounding remains, offset by current bank valuation');
  assert.deepEqual(f.w.foreignSettlements,immutable);assert.deepEqual(f.w.bankTransactions,banks);verify(f.w);
});

for(const kind of ['invoice','bill'] as const)test(`many partial KWD ${kind} settlements cannot strand a valid final native unit below USD cent precision`,()=>{
  const f=fixture('KWD','13','4');
  if(kind==='bill')f.settle(f.source('invoice',1001),1001);
  const obligation=f.source(kind,1001);
  for(let i=0;i<99;i++)f.settle(obligation,10);
  const before=structuredClone(f.w);let finalPartial:any;
  try{finalPartial=f.request(obligation,10);}catch(error){
    // Either reject the unsafe split while it is reversible, or support the
    // remaining native-only receipt. Both are valid; permanently stranded debt is not.
    assert.ok(error instanceof DomainError);assert.deepEqual(f.w,before);
  }
  if(finalPartial){f.complete(finalPartial);f.settle(obligation,1);}else f.settle(obligation,11);
  const actual=f.w[kind==='invoice'?'foreignInvoices':'foreignBills'].find((row:any)=>row.id===obligation.id);
  assert.equal(actual.amount_settled_minor,1001);assert.equal(actual.status,'settled');assert.equal(actual.carrying_minor,0);assert.equal(actual.historical_basis_minor,0);
  assert.equal(nativeBankBalance(f.w,f.bank.id),kind==='invoice'?1001:0);verify(f.w);
});

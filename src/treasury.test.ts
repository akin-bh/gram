import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {applyAction,createWorld,DomainError,recordsFor,summarize} from './world.ts';
import type {Action,Actor,World} from './world.ts';
import {functionalBankBalance,nativeBankBalance,treasuryAccountRows,treasuryCashProof,treasuryReserved} from './treasury.ts';
const operator:Actor={id:'treasury-operator',role:'agent'},controller:Actor={id:'treasury-source-controller',role:'controller'},reviewer:Actor={id:'independent-treasury-reviewer',role:'controller'};
let serial=0;const event=()=>`treasury-source-${++serial}`;
const act=(w:World,input:Action,actor=operator)=>applyAction(w,input,actor).result;
const world=()=>createWorld({kind:'saas-collections',orderCount:1});
const balance=(w:World,id:string)=>w.accounts.find(row=>row.id===id).balance_minor;
const bank=(w:World,currency='EUR')=>act(w,{type:'record_bank_account',name:`${currency} treasury`,currency,external_account_id:event(),external_event_id:event()},controller).bank_account;
const quote=(w:World,n='11',d='10',currency='EUR',hours=24)=>act(w,{type:'record_fx_quote',source_quote_id:event(),base_currency:currency,quote_currency:'USD',numerator:n,denominator:d,observed_at:w.now,expires_at:new Date(Date.parse(w.now)+hours*3600000).toISOString(),external_event_id:event()},controller).quote;
function request(w:World,from:string,to:string,amount:number,q?:any,fee=0,actor=operator){return act(w,{type:'request_treasury_transfer',from_account_id:from,to_account_id:to,amount_minor:amount,fee_minor:fee,...(q?{quote_id:q.id}:{}),reason:'Move approved company liquidity'},actor);}
function approve(w:World,pending:any,actor=reviewer){return act(w,{type:'decide_approval',approval_id:pending.approval_id??pending.transfer.approval_id,decision:'approve'},actor);}
function tick(w:World,hours=1){return act(w,{type:'advance_time',hours},controller);}
function transfer(w:World,from:string,to:string,amount:number,q?:any,fee=0){const pending=request(w,from,to,amount,q,fee);approve(w,pending);tick(w);return w.treasuryTransfers.find((row:any)=>row.id===pending.transfer.id);}
function rejects(w:World,action:Action,code:string,actor=operator){const before=structuredClone(w);assert.throws(()=>act(w,action,actor),(error:any)=>error instanceof DomainError&&error.code===code);assert.deepEqual(w,before);}
function exact(w:World){for(const entry of w.journals)assert.equal(entry.lines.reduce((sum:bigint,line:any)=>sum+BigInt(line.debit_minor)-BigInt(line.credit_minor),0n),0n);assert.equal(w.accounts.reduce((sum,account)=>sum+BigInt(account.balance_minor),0n),0n);}

test('new verified accounts start at zero and foreign funding needs distinct independent approval',()=>{
  const w=world(),before=summarize(w).cash_minor,eur=bank(w),q=quote(w);assert.equal(nativeBankBalance(w,eur.id),0);assert.equal(balance(w,eur.gl_account_id),0);
  const pending=request(w,'cash-bank',eur.id,11000,q,100,controller);assert.equal(pending.status,'awaiting_approval');assert.equal(nativeBankBalance(w,'cash-bank'),before);
  rejects(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'approve'},'separate_controller_required',controller);
  approve(w,pending);assert.equal(treasuryReserved(w,'cash-bank'),11100);tick(w);assert.equal(nativeBankBalance(w,'cash-bank'),before-11100);assert.equal(nativeBankBalance(w,eur.id),10000);assert.equal(balance(w,eur.gl_account_id),11000);assert.equal(balance(w,'treasury-fee-expense'),100);assert.equal(treasuryReserved(w,'cash-bank'),0);
  const settled=w.treasuryTransfers[0],op=w.operations.find(row=>row.id===settled.operation_id);assert.equal(op.cash_legs.length,2);assert.equal(w.bankTransactions.filter(row=>row.source_id===op.id).length,2);assert.equal(treasuryCashProof(w,op.id,eur.id)?.functional_minor,11000);assert.equal(treasuryCashProof(w,op.id,'cash-bank')?.native_minor,-11100);exact(w);
});

test('revaluation and partial then final foreign disposal recycle unrealized gains without double counting',()=>{
  const w=world(),opening=nativeBankBalance(w,'cash-bank'),eur=bank(w);transfer(w,'cash-bank',eur.id,11000,quote(w),100);const q12=quote(w,'6','5'),beforeBank=structuredClone(w.bankTransactions);
  const valuation=act(w,{type:'revalue_bank_account',bank_account_id:eur.id,quote_id:q12.id}).valuation;assert.equal(valuation.adjustment_minor,1000);assert.deepEqual(w.bankTransactions,beforeBank);assert.equal(balance(w,'fx-unrealized-gain-loss'),-1000);
  const q13=quote(w,'13','10'),partial=transfer(w,eur.id,'cash-bank',5000,q13,100);assert.equal(partial.released_functional_minor,6120);assert.equal(partial.released_historical_minor,5610);assert.equal(partial.realized_fx_gain_minor,1020);assert.equal(partial.recycled_unrealized_gain_minor,510);assert.equal(nativeBankBalance(w,eur.id),4900);assert.equal(functionalBankBalance(w,eur.id),5880);
  const last=transfer(w,eur.id,'cash-bank',4900,q13);assert.equal(last.realized_fx_gain_minor,980);assert.equal(nativeBankBalance(w,eur.id),0);assert.equal(functionalBankBalance(w,eur.id),0);assert.equal(w.bankAccounts.find((row:any)=>row.id===eur.id).historical_cost_minor,0);assert.equal(balance(w,'fx-unrealized-gain-loss'),0);assert.equal(balance(w,'fx-realized-gain-loss'),-2000);assert.equal(balance(w,'treasury-fee-expense'),230);assert.equal(nativeBankBalance(w,'cash-bank')-opening,1770);exact(w);
});

test('same-foreign internal transfers retain basis and realize only fees',()=>{
  const w=world(),from=bank(w),to=bank(w);transfer(w,'cash-bank',from.id,11000,quote(w));act(w,{type:'revalue_bank_account',bank_account_id:from.id,quote_id:quote(w,'6','5').id});
  const moved=transfer(w,from.id,to.id,5000,quote(w,'13','10'),100);assert.equal(moved.destination_functional_minor,6000);assert.equal(moved.destination_historical_minor,5500);assert.equal(moved.realized_fx_gain_minor,20);assert.equal(moved.recycled_unrealized_gain_minor,10);assert.equal(nativeBankBalance(w,to.id),5000);assert.equal(functionalBankBalance(w,from.id),5880);assert.equal(balance(w,'fx-unrealized-gain-loss'),-990);
  const noFee=transfer(w,to.id,from.id,5000);assert.equal(noFee.realized_fx_gain_minor,0);assert.equal(noFee.recycled_unrealized_gain_minor,0);assert.equal(functionalBankBalance(w,to.id),0);assert.equal(balance(w,'fx-unrealized-gain-loss'),-990);exact(w);
});

test('JPY and KWD use native minor scales and destination truncation has explicit exact loss',()=>{
  const w=world(),jpy=bank(w,'JPY'),kwd=bank(w,'KWD');const yen=transfer(w,'cash-bank',jpy.id,101,quote(w,'1','150','JPY'));assert.equal(yen.destination_amount_minor,151);assert.deepEqual(yen.conversion_proof.rounding_delta_minor,{numerator:'-1',denominator:'2'});assert.equal(functionalBankBalance(w,jpy.id),101);
  const dinar=transfer(w,'cash-bank',kwd.id,325,quote(w,'13','4','KWD'));assert.equal(dinar.destination_amount_minor,1000);assert.equal(nativeBankBalance(w,kwd.id),1000);
  rejects(w,{type:'request_treasury_transfer',from_account_id:jpy.id,to_account_id:kwd.id,amount_minor:1,reason:'Unsupported cross'},'unsupported_fx_pair');exact(w);
});

test('quote expiry before approval is atomic while an accepted quote survives a delayed rail',()=>{
  const w=world(),eur=bank(w),q=quote(w,'11','10','EUR',1),pending=request(w,'cash-bank',eur.id,11000,q);tick(w,1);
  rejects(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'approve'},'fx_quote_expired',reviewer);assert.equal(w.approvals.find(row=>row.id===pending.approval_id).status,'pending');
  act(w,{type:'cancel_treasury_transfer',transfer_id:pending.transfer.id,reason:'Source quote expired'},controller);const fresh=request(w,'cash-bank',eur.id,11000,quote(w,'11','10','EUR',1));approve(w,fresh);act(w,{type:'set_fault',system:'bank',mode:'offline'},controller);const bankBefore=structuredClone(w.bankTransactions);tick(w,3);assert.deepEqual(w.bankTransactions,bankBefore);assert.equal(treasuryReserved(w,'cash-bank'),11000);
  act(w,{type:'set_fault',system:'bank',mode:'healthy'},controller);tick(w);assert.equal(nativeBankBalance(w,eur.id),10000);const count=w.journals.length,transactions=w.bankTransactions.length;tick(w);assert.equal(w.journals.length,count);assert.equal(w.bankTransactions.length,transactions);exact(w);
});

test('disabled routes hold accepted transfers and controller cancellation releases reservations',()=>{
  const w=world(),usd=bank(w,'USD'),pending=request(w,'cash-bank',usd.id,10000);approve(w,pending);act(w,{type:'set_bank_account_status',bank_account_id:usd.id,enabled:false,reason:'Verification suspended',external_event_id:event()},controller);const rows=structuredClone(w.bankTransactions);tick(w);assert.deepEqual(w.bankTransactions,rows);assert.equal(treasuryReserved(w,'cash-bank'),10000);
  act(w,{type:'cancel_treasury_transfer',transfer_id:pending.transfer.id,reason:'Route unavailable'},controller);assert.equal(treasuryReserved(w,'cash-bank'),0);assert.equal(w.operations.find(row=>row.target_id===pending.transfer.id).status,'cancelled');act(w,{type:'set_bank_account_status',bank_account_id:usd.id,enabled:true,reason:'Verified',external_event_id:event()},controller);tick(w);assert.deepEqual(w.bankTransactions,rows);exact(w);
});

test('native reserves isolate bank accounts and never spend foreign currency as USD',()=>{
  const w=world(),eur=bank(w),usd=bank(w,'USD');transfer(w,'cash-bank',eur.id,11000,quote(w));const pending=request(w,eur.id,'cash-bank',9000,quote(w));approve(w,pending);assert.equal(treasuryReserved(w,'cash-bank'),0);assert.equal(treasuryReserved(w,eur.id),9000);
  rejects(w,{type:'request_treasury_transfer',from_account_id:eur.id,to_account_id:'cash-bank',amount_minor:1001,quote_id:quote(w).id,reason:'Over-reservation'},'insufficient_funds');rejects(w,{type:'request_treasury_transfer',from_account_id:usd.id,to_account_id:'cash-bank',amount_minor:1,reason:'No native cash'},'insufficient_funds');
  const rows=treasuryAccountRows(w);assert.equal(rows.find((row:any)=>row.id===eur.id).available_balance_minor,1000);assert.equal(rows.find((row:any)=>row.id===usd.id).available_balance_minor,0);exact(w);
});

test('deferred transfers and valuation preserve native cash once and recover exact functional journals',()=>{
  const w=world(),eur=bank(w),q=quote(w);act(w,{type:'close_period'},controller);transfer(w,'cash-bank',eur.id,11000,q);assert.equal(balance(w,eur.gl_account_id),0);assert.equal(functionalBankBalance(w,eur.id),11000);act(w,{type:'revalue_bank_account',bank_account_id:eur.id,quote_id:quote(w,'6','5').id});assert.equal(functionalBankBalance(w,eur.id),12000);
  transfer(w,eur.id,'cash-bank',10000,quote(w,'13','10'));assert.equal(functionalBankBalance(w,eur.id),0);assert.equal(w.settledUnposted.length,3);const rows=structuredClone(w.bankTransactions);act(w,{type:'reopen_period'},controller);assert.equal(w.settledUnposted.length,0);assert.deepEqual(w.bankTransactions,rows);assert.equal(balance(w,'fx-realized-gain-loss'),-2000);assert.equal(balance(w,'fx-unrealized-gain-loss'),0);const count=w.journals.length;tick(w);assert.equal(w.journals.length,count);exact(w);
});

test('strict source evidence and dynamic control accounts reject forged funding or edits',()=>{
  const w=world(),eur=bank(w),q=quote(w);for(const extra of [{opening_balance_minor:100},{balance_minor:100},{verified_route_id:'external-attacker'}])rejects(w,{type:'record_bank_account',name:'Forged',currency:'EUR',external_account_id:event(),external_event_id:event(),...extra},'invalid_treasury_field',controller);
  rejects(w,{type:'record_fx_quote',source_quote_id:event(),base_currency:'EUR',quote_currency:'USD',numerator:'1',denominator:'0',observed_at:w.now,expires_at:w.now,external_event_id:event()},'invalid_rational',controller);
  rejects(w,{type:'post_journal',lines:[{account_id:eur.gl_account_id,debit_minor:100},{account_id:'equity',credit_minor:100}]},'control_account_locked');
  transfer(w,'cash-bank',eur.id,11000,q);const operation=w.operations.find(row=>row.id===w.treasuryTransfers[0].operation_id),copy=structuredClone(w);copy.bankTransactions.find(row=>row.source_id===operation.id&&row.account_id===eur.id).amount_minor++;assert.throws(()=>treasuryCashProof(copy,operation.id,eur.id),(error:any)=>error.code==='invalid_treasury_cash_proof');exact(w);
});

test('rejection keeps history and new requests require fresh approval',()=>{
  const w=world(),eur=bank(w),q=quote(w),pending=request(w,'cash-bank',eur.id,11000,q);act(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'reject'},reviewer);assert.equal(w.treasuryTransfers[0].status,'rejected');assert.equal(treasuryReserved(w,'cash-bank'),0);const again=request(w,'cash-bank',eur.id,11000,q);assert.notEqual(again.approval_id,pending.approval_id);assert.equal(w.treasuryTransfers.length,2);assert.equal(recordsFor(w,'mercury','bank-account').length,2);exact(w);
});

test('legacy bill payments and treasury transfers share only the operating USD reservation pool',()=>{
  for(const treasuryFirst of [true,false]){
    const w=createWorld({kind:'supplier-fraud',orderCount:1,initialCashMinor:1_000_000,approvalThresholdMinor:1e12}),usd=bank(w,'USD'),bill=w.bills[0],cash=nativeBankBalance(w,'cash-bank'),amount=cash-bill.amount_minor+1;
    const billAction={type:'pay_bill',bill_id:bill.id,amount_minor:bill.amount_minor};
    if(treasuryFirst){approve(w,request(w,'cash-bank',usd.id,amount));rejects(w,billAction,'insufficient_funds');}
    else{act(w,billAction);rejects(w,{type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:usd.id,amount_minor:amount,reason:'Competing liquidity'},'insufficient_funds');}
    assert.equal(nativeBankBalance(w,usd.id),0);exact(w);
  }
});

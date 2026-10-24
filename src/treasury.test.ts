import {test,expect} from 'bun:test';
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
function rejects(w:World,action:Action,code:string,actor=operator){const before=structuredClone(w);expect(()=>act(w,action,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);}
function exact(w:World){for(const entry of w.journals)expect(entry.lines.reduce((sum:bigint,line:any)=>sum+BigInt(line.debit_minor)-BigInt(line.credit_minor),0n)).toBe(0n);expect(w.accounts.reduce((sum,account)=>sum+BigInt(account.balance_minor),0n)).toBe(0n);}

test('new verified accounts start at zero and foreign funding needs distinct independent approval',()=>{
  const w=world(),before=summarize(w).cash_minor,eur=bank(w),q=quote(w);expect(nativeBankBalance(w,eur.id)).toBe(0);expect(balance(w,eur.gl_account_id)).toBe(0);
  const pending=request(w,'cash-bank',eur.id,11000,q,100,controller);expect(pending.status).toBe('awaiting_approval');expect(nativeBankBalance(w,'cash-bank')).toBe(before);
  rejects(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'approve'},'separate_controller_required',controller);
  approve(w,pending);expect(treasuryReserved(w,'cash-bank')).toBe(11100);tick(w);expect(nativeBankBalance(w,'cash-bank')).toBe(before-11100);expect(nativeBankBalance(w,eur.id)).toBe(10000);expect(balance(w,eur.gl_account_id)).toBe(11000);expect(balance(w,'treasury-fee-expense')).toBe(100);expect(treasuryReserved(w,'cash-bank')).toBe(0);
  const settled=w.treasuryTransfers[0],op=w.operations.find(row=>row.id===settled.operation_id);expect(op.cash_legs.length).toBe(2);expect(w.bankTransactions.filter(row=>row.source_id===op.id).length).toBe(2);expect(treasuryCashProof(w,op.id,eur.id)?.functional_minor).toBe(11000);expect(treasuryCashProof(w,op.id,'cash-bank')?.native_minor).toBe(-11100);exact(w);
});

test('revaluation and partial then final foreign disposal recycle unrealized gains without double counting',()=>{
  const w=world(),opening=nativeBankBalance(w,'cash-bank'),eur=bank(w);transfer(w,'cash-bank',eur.id,11000,quote(w),100);const q12=quote(w,'6','5'),beforeBank=structuredClone(w.bankTransactions);
  const valuation=act(w,{type:'revalue_bank_account',bank_account_id:eur.id,quote_id:q12.id}).valuation;expect(valuation.adjustment_minor).toBe(1000);expect(w.bankTransactions).toStrictEqual(beforeBank);expect(balance(w,'fx-unrealized-gain-loss')).toBe(-1000);
  const q13=quote(w,'13','10'),partial=transfer(w,eur.id,'cash-bank',5000,q13,100);expect(partial.released_functional_minor).toBe(6120);expect(partial.released_historical_minor).toBe(5610);expect(partial.realized_fx_gain_minor).toBe(1020);expect(partial.recycled_unrealized_gain_minor).toBe(510);expect(nativeBankBalance(w,eur.id)).toBe(4900);expect(functionalBankBalance(w,eur.id)).toBe(5880);
  const last=transfer(w,eur.id,'cash-bank',4900,q13);expect(last.realized_fx_gain_minor).toBe(980);expect(nativeBankBalance(w,eur.id)).toBe(0);expect(functionalBankBalance(w,eur.id)).toBe(0);expect(w.bankAccounts.find((row:any)=>row.id===eur.id).historical_cost_minor).toBe(0);expect(balance(w,'fx-unrealized-gain-loss')).toBe(0);expect(balance(w,'fx-realized-gain-loss')).toBe(-2000);expect(balance(w,'treasury-fee-expense')).toBe(230);expect(nativeBankBalance(w,'cash-bank')-opening).toBe(1770);exact(w);
});

test('same-foreign internal transfers retain basis and realize only fees',()=>{
  const w=world(),from=bank(w),to=bank(w);transfer(w,'cash-bank',from.id,11000,quote(w));act(w,{type:'revalue_bank_account',bank_account_id:from.id,quote_id:quote(w,'6','5').id});
  const moved=transfer(w,from.id,to.id,5000,quote(w,'13','10'),100);expect(moved.destination_functional_minor).toBe(6000);expect(moved.destination_historical_minor).toBe(5500);expect(moved.realized_fx_gain_minor).toBe(20);expect(moved.recycled_unrealized_gain_minor).toBe(10);expect(nativeBankBalance(w,to.id)).toBe(5000);expect(functionalBankBalance(w,from.id)).toBe(5880);expect(balance(w,'fx-unrealized-gain-loss')).toBe(-990);
  const noFee=transfer(w,to.id,from.id,5000);expect(noFee.realized_fx_gain_minor).toBe(0);expect(noFee.recycled_unrealized_gain_minor).toBe(0);expect(functionalBankBalance(w,to.id)).toBe(0);expect(balance(w,'fx-unrealized-gain-loss')).toBe(-990);exact(w);
});

test('JPY and KWD use native minor scales and destination truncation has explicit exact loss',()=>{
  const w=world(),jpy=bank(w,'JPY'),kwd=bank(w,'KWD');const yen=transfer(w,'cash-bank',jpy.id,101,quote(w,'1','150','JPY'));expect(yen.destination_amount_minor).toBe(151);expect(yen.conversion_proof.rounding_delta_minor).toStrictEqual({numerator:'-1',denominator:'2'});expect(functionalBankBalance(w,jpy.id)).toBe(101);
  const dinar=transfer(w,'cash-bank',kwd.id,325,quote(w,'13','4','KWD'));expect(dinar.destination_amount_minor).toBe(1000);expect(nativeBankBalance(w,kwd.id)).toBe(1000);
  rejects(w,{type:'request_treasury_transfer',from_account_id:jpy.id,to_account_id:kwd.id,amount_minor:1,reason:'Unsupported cross'},'unsupported_fx_pair');exact(w);
});

test('quote expiry before approval is atomic while an accepted quote survives a delayed rail',()=>{
  const w=world(),eur=bank(w),q=quote(w,'11','10','EUR',1),pending=request(w,'cash-bank',eur.id,11000,q);tick(w,1);
  rejects(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'approve'},'fx_quote_expired',reviewer);expect(w.approvals.find(row=>row.id===pending.approval_id).status).toBe('pending');
  act(w,{type:'cancel_treasury_transfer',transfer_id:pending.transfer.id,reason:'Source quote expired'},controller);const fresh=request(w,'cash-bank',eur.id,11000,quote(w,'11','10','EUR',1));approve(w,fresh);act(w,{type:'set_fault',system:'bank',mode:'offline'},controller);const bankBefore=structuredClone(w.bankTransactions);tick(w,3);expect(w.bankTransactions).toStrictEqual(bankBefore);expect(treasuryReserved(w,'cash-bank')).toBe(11000);
  act(w,{type:'set_fault',system:'bank',mode:'healthy'},controller);tick(w);expect(nativeBankBalance(w,eur.id)).toBe(10000);const count=w.journals.length,transactions=w.bankTransactions.length;tick(w);expect(w.journals.length).toBe(count);expect(w.bankTransactions.length).toBe(transactions);exact(w);
});

test('disabled routes hold accepted transfers and controller cancellation releases reservations',()=>{
  const w=world(),usd=bank(w,'USD'),pending=request(w,'cash-bank',usd.id,10000);approve(w,pending);act(w,{type:'set_bank_account_status',bank_account_id:usd.id,enabled:false,reason:'Verification suspended',external_event_id:event()},controller);const rows=structuredClone(w.bankTransactions);tick(w);expect(w.bankTransactions).toStrictEqual(rows);expect(treasuryReserved(w,'cash-bank')).toBe(10000);
  act(w,{type:'cancel_treasury_transfer',transfer_id:pending.transfer.id,reason:'Route unavailable'},controller);expect(treasuryReserved(w,'cash-bank')).toBe(0);expect(w.operations.find(row=>row.target_id===pending.transfer.id).status).toBe('cancelled');act(w,{type:'set_bank_account_status',bank_account_id:usd.id,enabled:true,reason:'Verified',external_event_id:event()},controller);tick(w);expect(w.bankTransactions).toStrictEqual(rows);exact(w);
});

test('native reserves isolate bank accounts and never spend foreign currency as USD',()=>{
  const w=world(),eur=bank(w),usd=bank(w,'USD');transfer(w,'cash-bank',eur.id,11000,quote(w));const pending=request(w,eur.id,'cash-bank',9000,quote(w));approve(w,pending);expect(treasuryReserved(w,'cash-bank')).toBe(0);expect(treasuryReserved(w,eur.id)).toBe(9000);
  rejects(w,{type:'request_treasury_transfer',from_account_id:eur.id,to_account_id:'cash-bank',amount_minor:1001,quote_id:quote(w).id,reason:'Over-reservation'},'insufficient_funds');rejects(w,{type:'request_treasury_transfer',from_account_id:usd.id,to_account_id:'cash-bank',amount_minor:1,reason:'No native cash'},'insufficient_funds');
  const rows=treasuryAccountRows(w);expect(rows.find((row:any)=>row.id===eur.id).available_balance_minor).toBe(1000);expect(rows.find((row:any)=>row.id===usd.id).available_balance_minor).toBe(0);exact(w);
});

test('deferred transfers and valuation preserve native cash once and recover exact functional journals',()=>{
  const w=world(),eur=bank(w),q=quote(w);act(w,{type:'close_period'},controller);transfer(w,'cash-bank',eur.id,11000,q);expect(balance(w,eur.gl_account_id)).toBe(0);expect(functionalBankBalance(w,eur.id)).toBe(11000);act(w,{type:'revalue_bank_account',bank_account_id:eur.id,quote_id:quote(w,'6','5').id});expect(functionalBankBalance(w,eur.id)).toBe(12000);
  transfer(w,eur.id,'cash-bank',10000,quote(w,'13','10'));expect(functionalBankBalance(w,eur.id)).toBe(0);expect(w.settledUnposted.length).toBe(3);const rows=structuredClone(w.bankTransactions);act(w,{type:'reopen_period'},controller);expect(w.settledUnposted.length).toBe(0);expect(w.bankTransactions).toStrictEqual(rows);expect(balance(w,'fx-realized-gain-loss')).toBe(-2000);expect(balance(w,'fx-unrealized-gain-loss')).toBe(0);const count=w.journals.length;tick(w);expect(w.journals.length).toBe(count);exact(w);
});

test('strict source evidence and dynamic control accounts reject forged funding or edits',()=>{
  const w=world(),eur=bank(w),q=quote(w);for(const extra of [{opening_balance_minor:100},{balance_minor:100},{verified_route_id:'external-attacker'}])rejects(w,{type:'record_bank_account',name:'Forged',currency:'EUR',external_account_id:event(),external_event_id:event(),...extra},'invalid_treasury_field',controller);
  rejects(w,{type:'record_fx_quote',source_quote_id:event(),base_currency:'EUR',quote_currency:'USD',numerator:'1',denominator:'0',observed_at:w.now,expires_at:w.now,external_event_id:event()},'invalid_rational',controller);
  rejects(w,{type:'post_journal',lines:[{account_id:eur.gl_account_id,debit_minor:100},{account_id:'equity',credit_minor:100}]},'control_account_locked');
  transfer(w,'cash-bank',eur.id,11000,q);const operation=w.operations.find(row=>row.id===w.treasuryTransfers[0].operation_id),copy=structuredClone(w);copy.bankTransactions.find(row=>row.source_id===operation.id&&row.account_id===eur.id).amount_minor++;expect(()=>treasuryCashProof(copy,operation.id,eur.id)).toThrowSatisfying((error:any)=>error.code==='invalid_treasury_cash_proof');exact(w);
});

test('rejection keeps history and new requests require fresh approval',()=>{
  const w=world(),eur=bank(w),q=quote(w),pending=request(w,'cash-bank',eur.id,11000,q);act(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'reject'},reviewer);expect(w.treasuryTransfers[0].status).toBe('rejected');expect(treasuryReserved(w,'cash-bank')).toBe(0);const again=request(w,'cash-bank',eur.id,11000,q);expect(again.approval_id).not.toBe(pending.approval_id);expect(w.treasuryTransfers.length).toBe(2);expect(recordsFor(w,'mercury','bank-account').length).toBe(2);exact(w);
});

test('legacy bill payments and treasury transfers share only the operating USD reservation pool',()=>{
  for(const treasuryFirst of [true,false]){
    const w=createWorld({kind:'supplier-fraud',orderCount:1,initialCashMinor:1_000_000,approvalThresholdMinor:1e12}),usd=bank(w,'USD'),bill=w.bills[0],cash=nativeBankBalance(w,'cash-bank'),amount=cash-bill.amount_minor+1;
    const billAction={type:'pay_bill',bill_id:bill.id,amount_minor:bill.amount_minor};
    if(treasuryFirst){approve(w,request(w,'cash-bank',usd.id,amount));rejects(w,billAction,'insufficient_funds');}
    else{act(w,billAction);rejects(w,{type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:usd.id,amount_minor:amount,reason:'Competing liquidity'},'insufficient_funds');}
    expect(nativeBankBalance(w,usd.id)).toBe(0);exact(w);
  }
});

import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError} from './world.ts';
import type {Action,Actor} from './world.ts';

test('deferred completed-service recognition reserves exact aggregate GL capacity before accepting another source',()=>{
  const controller:Actor={id:'capacity-source-controller',role:'controller'},operator:Actor={id:'capacity-accountant',role:'operator'},reviewer:Actor={id:'capacity-reviewer',role:'controller'};
  const w=createWorld({kind:'saas-collections',initialCashMinor:0,blueprint:{version:1,opening_at:'2026-10-24T09:00:00.000Z',vendors:[{ref:'supplier',name:'Source supplier',email:'ap@supplier.test'}]} as any});
  const act=(action:Action,actor=controller)=>applyAction(w,action,actor).result;
  const openingExpense=BigInt(Number.MAX_SAFE_INTEGER)-1500000000000n;let remaining=openingExpense,sequence=0;
  // Reach the supported boundary through legal, independently approved journals;
  // never fabricate account balances or edit the serialized world in this test.
  while(remaining>0n){
    const lines:any[]=[];
    for(let count=0;count<50&&remaining>0n;count++){
      const amount=Number(remaining>1000000000000n?1000000000000n:remaining);
      lines.push({account_id:'expenses',debit_minor:amount},{account_id:'equity',credit_minor:amount});remaining-=BigInt(amount);
    }
    const requested=act({type:'post_journal',lines,description:`Independent historical adjustment ${++sequence}`},operator);
    act({type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},reviewer);
  }
  expect(BigInt(w.accounts.find(row=>row.id==='expenses').balance_minor)).toBe(openingExpense);
  act({type:'close_period'});
  const source=(index:number)=>{
    const contract=act({type:'record_service_contract',external_contract_id:`capacity-contract-${index}`,counterparty_kind:'vendor',counterparty_id:w.vendors[0].id,amount_minor:1e12,description:'Completed services under independent supplier authority',signed_at:w.now,external_event_id:`capacity-contract-event-${index}`}).contract;
    return {type:'record_service_bill',contract_id:contract.id,source_invoice_id:`capacity-invoice-${index}`,amount_minor:1e12,issued_at:w.now,due_at:w.now,service_completed_at:w.now,completion_reference:`capacity-completed-${index}`,external_event_id:`capacity-invoice-event-${index}`};
  };
  act(source(1));const second=source(2),before=structuredClone(w);
  expect(w.operations.filter(row=>row.status==='settled'&&!row.journal_id).length).toBe(1);
  expect(()=>act(second)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='money_overflow');
  expect(w,'Rejected recognition must not consume its invoice identity, create a payable or append a deferred operation').toStrictEqual(before);
  act({type:'set_fault',system:'ledger',mode:'offline'});act({type:'reopen_period'});act({type:'set_fault',system:'ledger',mode:'healthy'});
  const beforeManual=structuredClone(w);
  expect(()=>act({type:'post_journal',lines:[{account_id:'expenses',debit_minor:1e12},{account_id:'equity',credit_minor:1e12}],description:'Cannot consume capacity already committed to the accepted service source'},operator)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='money_overflow');
  expect(w,'Manual journal admission must preserve pending source posting capacity').toStrictEqual(beforeManual);
  act({type:'advance_time',hours:1});
  expect(w.periodClosed).toBe(false);expect(w.bills.length).toBe(1);
  expect(BigInt(w.accounts.find(row=>row.id==='expenses').balance_minor)).toBe(openingExpense+1000000000000n);
  expect(w.accounts.find(row=>row.id==='payables').balance_minor).toBe(-1e12);
  expect(w.operations.filter(row=>row.status==='settled'&&!row.journal_id).length).toBe(0);
  expect(w.accounts.reduce((sum:bigint,row:any)=>sum+BigInt(row.balance_minor),0n)).toBe(0n);
},30000);

test('manual journal admission preserves every deferred posting prefix even when an issue and return net to zero',()=>{
  const controller:Actor={id:'prefix-source-controller',role:'controller'},operator:Actor={id:'prefix-accountant',role:'operator'},reviewer:Actor={id:'prefix-reviewer',role:'controller'};
  const w=createWorld({kind:'procurement-matching',orderCount:1,initialCashMinor:0});
  const act=(action:Action,actor=controller)=>applyAction(w,action,actor).result;
  const lot=w.inventoryLots[0],itemId=lot.item_id,value=lot.unit_cost_minor;
  const openingExpense=BigInt(Number.MAX_SAFE_INTEGER)-2n*BigInt(value);let remaining=openingExpense,sequence=0;
  while(remaining>0n){
    const lines:any[]=[];
    for(let count=0;count<50&&remaining>0n;count++){
      const amount=Number(remaining>1000000000000n?1000000000000n:remaining);
      lines.push({account_id:'inventory-expense',debit_minor:amount},{account_id:'equity',credit_minor:amount});remaining-=BigInt(amount);
    }
    const requested=act({type:'post_journal',lines,description:`Independent posting-prefix history ${++sequence}`},operator);
    act({type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},reviewer);
  }
  const initialStock=structuredClone(w.inventoryItems),initialBank=structuredClone(w.bankTransactions);
  act({type:'close_period'});
  const authority=act({type:'authorize_inventory_issue',lines:[{item_id:itemId,quantity:1}],purpose:'Authorized field use',external_event_id:'prefix-inventory-authority'}).authorization;
  const issue=act({type:'issue_inventory',authorization_id:authority.id,lines:[{item_id:itemId,quantity:1}]},operator).movement;
  const returned=act({type:'return_inventory',issue_id:issue.id,lines:[{item_id:itemId,quantity:1}],reason:'Unused original-cost unit returned',external_event_id:'prefix-inventory-return'}).movement;
  const deferred=w.operations.filter(row=>row.status==='settled'&&!row.journal_id);
  expect(deferred.map(row=>row.id)).toStrictEqual([issue.operation_id,returned.operation_id]);
  expect(deferred.flatMap(row=>row.journal_lines).filter((line:any)=>line.account_id==='inventory-expense').reduce((sum:number,line:any)=>sum+(line.debit_minor??0)-(line.credit_minor??0),0),'The final aggregate hides the earlier debit that still must post').toBe(0);
  act({type:'set_fault',system:'ledger',mode:'offline'});act({type:'reopen_period'});act({type:'set_fault',system:'ledger',mode:'healthy'});
  const adjustment=Math.floor(value*1.5),before=structuredClone(w);
  expect(openingExpense+BigInt(adjustment)<=BigInt(Number.MAX_SAFE_INTEGER),'The immediate and final net balances alone are safe').toBeTruthy();
  expect(openingExpense+BigInt(adjustment)+BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER),'The first deferred posting would overflow').toBeTruthy();
  expect(()=>act({type:'post_journal',lines:[{account_id:'inventory-expense',debit_minor:adjustment},{account_id:'equity',credit_minor:adjustment}],description:'Do not consume the pending issue posting headroom'},operator)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='money_overflow');
  expect(w,'Rejected journal admission must leave approvals, journal history and source operations unchanged').toStrictEqual(before);
  const priorJournals=w.journals.length;act({type:'advance_time',hours:1});
  expect(w.journals.slice(priorJournals).map(row=>row.source_id)).toStrictEqual([issue.operation_id,returned.operation_id]);
  expect(BigInt(w.accounts.find(row=>row.id==='inventory-expense').balance_minor)).toBe(openingExpense);
  expect(w.operations.filter(row=>row.status==='settled'&&!row.journal_id).length).toBe(0);
  expect(w.inventoryItems).toStrictEqual(initialStock);expect(w.bankTransactions).toStrictEqual(initialBank);
  expect(w.accounts.reduce((sum:bigint,row:any)=>sum+BigInt(row.balance_minor),0n)).toBe(0n);
  const recovered=structuredClone(w.journals);act({type:'advance_time',hours:1});expect(w.journals,'Recovery posts each original journal once').toStrictEqual(recovered);
},30000);

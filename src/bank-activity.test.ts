import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {applyAction,createWorld,DomainError,normalizeWorld,recordsFor,summarize} from './world.ts';
import type {Action,Actor,World} from './world.ts';
const controller:Actor={id:'bank-fact-controller',role:'controller'},operator:Actor={id:'bank-classifier',role:'agent'};
const act=(w:World,action:Action,actor=controller)=>applyAction(w,action,actor).result;
const world=()=>createWorld({kind:'saas-collections',orderCount:1});
const input=(w:World,kind='fee',amount=275,source='external-bank-source')=>({type:'record_bank_activity',source_transaction_id:source,account_id:'cash-bank',currency:'USD',kind,amount_minor:amount,posted_at:w.now,description:'Observed synthetic bank posting',external_event_id:`event-${source}`});
const classify=(w:World,activity:any)=>act(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:activity.kind==='fee'?'bank-fee-expense':'interest-income'},operator);
function rejects(w:World,action:Action,code:string,actor=operator){const before=structuredClone(w);assert.throws(()=>act(w,action,actor),(error:any)=>error instanceof DomainError&&error.code===code);assert.deepEqual(w,before);}
function balance(w:World,id:string){return w.accounts.find(account=>account.id===id).balance_minor;}
function exact(w:World){for(const journal of w.journals)assert.equal(journal.lines.reduce((sum:number,line:any)=>sum+line.debit_minor-line.credit_minor,0),0);assert.equal(w.accounts.reduce((sum,account)=>sum+account.balance_minor,0),0);assert.ok(w.accounts.every(account=>Number.isSafeInteger(account.balance_minor)));}

test('external bank dates stay distinct from actual posting, and classification is a separate cash-neutral receipt',()=>{
  const w=world(),sourceAt=w.now,cash=summarize(w).cash_minor;act(w,{type:'advance_time',hours:2});const observed=act(w,{...input(w),posted_at:sourceAt});
  assert.equal(observed.bank_transaction.posted_at,sourceAt);assert.equal(observed.bank_activity.observed_at,w.now);assert.equal(w.journals.find(journal=>journal.id===observed.operation.journal_id).posted_at,w.now);assert.equal(summarize(w).cash_minor,cash-275);assert.equal(balance(w,'bank-suspense'),275);
  const bank=structuredClone(w.bankTransactions),receipt=observed.bank_activity.receipt_id,result=classify(w,observed.bank_activity);assert.equal(result.operation.cash_effect_minor,0);assert.equal(result.bank_activity.receipt_id,receipt);assert.equal(balance(w,'bank-fee-expense'),275);assert.equal(balance(w,'bank-suspense'),0);assert.deepEqual(w.bankTransactions,bank);assert.ok(result.operation.journal_lines.every((line:any)=>line.account_id!=='cash-bank'));assert.ok(w.documents.some(doc=>doc.original_receipt_id===receipt));
  const operations=w.operations.length,docs=w.documents.length;assert.equal(classify(w,result.bank_activity).replayed,true);assert.equal(w.operations.length,operations);assert.equal(w.documents.length,docs);exact(w);
});

test('strict activity actions reject unsupported overrides and reserved future identity namespaces',()=>{
  const w=world();rejects(w,input(w),'controller_required');
  for(const extra of [{force:true},{approved:true},{beneficiary_id:'invented'},{receipt_id:'invented'},{role:'controller'}])rejects(w,{...input(w),...extra},'invalid_bank_activity_field',controller);
  for(const source of ['op_999999999','receipt_900001','banktx_900002','banktx-op_900002','bank-activity_900003','pi_900004','bank-opening','bank-sale-900005'])rejects(w,input(w,'fee',1,source),'duplicate_bank_activity_source',controller);
  const activity=act(w,input(w)).bank_activity;for(const extra of [{amount_minor:1},{posted_at:w.now},{force:true},{classification_operation_id:'fake'}])rejects(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:'bank-fee-expense',...extra},'invalid_bank_activity_field');
  rejects(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:'interest-income'},'bank_activity_classification_mismatch');exact(w);
});

test('original event replay never erases later classification and new transport IDs cannot duplicate a business cash fact',()=>{
  const w=world(),action=input(w),observed=act(w,action),result=classify(w,observed.bank_activity),bank=structuredClone(w.bankTransactions),operations=w.operations.length;
  const replay=act(w,action);assert.equal(replay.replayed,true);assert.equal(replay.bank_activity.status,'unclassified');assert.equal(w.bankActivities[0].status,'classified');assert.equal(w.bankActivities[0].classification_operation_id,result.operation.id);assert.equal(w.operations.length,operations);assert.deepEqual(w.bankTransactions,bank);
  rejects(w,{...action,external_event_id:'same-source-new-envelope'},'duplicate_bank_activity_source',controller);rejects(w,{...action,amount_minor:1},'external_event_conflict',controller);
});

test('classification independently verifies date, account, currency, signed source amount and original cash operation',()=>{
  const base=world(),activity=act(base,input(base)).bank_activity;
  const corruptions=[(w:World)=>{w.bankTransactions.at(-1).posted_at='2026-10-24T08:00:00.000Z';},(w:World)=>{w.bankTransactions.at(-1).account_id='cash-processor';},(w:World)=>{w.bankTransactions.at(-1).currency='EUR';},(w:World)=>{w.bankTransactions.at(-1).amount_minor=275;},(w:World)=>{w.bankActivities[0].amount_minor=1;},(w:World)=>{w.operations.find(operation=>operation.id===activity.operation_id).cash_effect_minor=0;},(w:World)=>{w.operations.find(operation=>operation.id===activity.operation_id).source_posted_at='2026-10-24T08:00:00.000Z';}];
  for(const corrupt of corruptions){const w=structuredClone(base);corrupt(w);rejects(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:'bank-fee-expense'},'bank_activity_evidence_mismatch');}
});

test('deferred observation and classification retain exactly two postings and do not replay the bank movement during recovery',()=>{
  const w=world(),cash=summarize(w).cash_minor;act(w,{type:'close_period'});act(w,{type:'set_fault',system:'ledger',mode:'offline'});const activity=act(w,input(w,'interest',1250)).bank_activity;classify(w,activity);
  assert.equal(summarize(w).cash_minor,cash+1250);assert.equal(w.settledUnposted.length,2);assert.equal(balance(w,'bank-suspense'),0);assert.equal(balance(w,'interest-income'),0);const bank=structuredClone(w.bankTransactions);
  act(w,{type:'reopen_period'});assert.equal(w.settledUnposted.length,2);act(w,{type:'set_fault',system:'ledger',mode:'healthy'});act(w,{type:'advance_time',hours:1});assert.equal(w.settledUnposted.length,0);assert.equal(balance(w,'bank-suspense'),0);assert.equal(balance(w,'interest-income'),-1250);assert.deepEqual(w.bankTransactions,bank);
  const journals=w.journals.length;act(w,{type:'advance_time',hours:1});assert.equal(w.journals.length,journals);assert.deepEqual(w.bankTransactions,bank);exact(w);
});

test('aggregate cash and effective deferred expense overflow reject atomically before queuing unpostable accounting',()=>{
  const cashWorld=world();
  // Boundary fixture models accumulated historical cash close to storage's exact
  // integer ceiling. Individual incoming activity is small and otherwise valid.
  const delta=Number.MAX_SAFE_INTEGER-10-balance(cashWorld,'cash-bank');cashWorld.accounts.find(account=>account.id==='cash-bank').balance_minor+=delta;cashWorld.accounts.find(account=>account.id==='equity').balance_minor-=delta;cashWorld.bankTransactions[0].amount_minor+=delta;
  rejects(cashWorld,input(cashWorld,'interest',11),'bank_activity_balance_overflow',controller);
  const w=world(),activity=act(w,input(w,'fee',11)).bank_activity;act(w,{type:'close_period'});const expense=w.accounts.find(account=>account.id==='bank-fee-expense'),equity=w.accounts.find(account=>account.id==='equity');expense.balance_minor=Number.MAX_SAFE_INTEGER-20;equity.balance_minor-=expense.balance_minor;
  // A previously accepted unposted classification consumes ten of the remaining
  // cents of aggregate headroom, even though it is absent from current GL.
  w.operations.push({id:'historical-deferred-expense',status:'settled',journal_lines:[{account_id:'bank-fee-expense',debit_minor:10},{account_id:'equity',credit_minor:10}]});
  rejects(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:'bank-fee-expense'},'bank_activity_balance_overflow');assert.equal(w.bankActivities[0].status,'unclassified');
});

test('configured bank fees and interest are genuine seed facts with independent source references and unresolved classification',()=>{
  const options={kind:'bank-reconciliation',orderCount:1,seed:52,reconciliationControls:{deferredPosting:true,bankFeeMinor:400,interestMinor:125}};const w=createWorld(options);assert.deepEqual(w,createWorld(options));assert.equal(w.bankActivities.length,2);assert.equal(w.bankStatements[0].lines.length,3);
  assert.deepEqual(w.bankStatements[0].lines.slice(1).map((line:any)=>line.source_refs),[['seed-bank-fee'],['seed-bank-interest']]);assert.equal(w.bankStatements[0].closing_balance_minor,w.bankStatements[0].opening_balance_minor+10000-400+125);assert.equal(balance(w,'bank-suspense'),275);assert.equal(summarize(w).unclassified_bank_activities,2);
  assert.ok(w.bankActivities.every((activity:any)=>activity.status==='unclassified'&&activity.posted_at===w.reconciliationSources.end_at));assert.ok(w.bankActivities.every((activity:any)=>w.journals.find(journal=>journal.source_id===activity.operation_id).posted_at>w.reconciliationSources.end_at));
  for(const system of ['bank','mercury','plaid','ledger','netsuite'])assert.deepEqual(recordsFor(w,system,'bank-activity'),w.bankActivities);
  const bank=structuredClone(w.bankTransactions);for(const activity of w.bankActivities)classify(w,activity);assert.deepEqual(w.bankTransactions,bank);assert.equal(balance(w,'bank-suspense'),0);assert.equal(balance(w,'bank-fee-expense'),400);assert.equal(balance(w,'interest-income'),-125);exact(w);
  assert.equal(createWorld({kind:'bank-reconciliation'}).bankActivities.length,0);for(const reconciliationControls of [{bankFeeMinor:-1},{bankFeeMinor:0.5},{interestMinor:1e12+1}])assert.throws(()=>createWorld({kind:'bank-reconciliation',reconciliationControls}),DomainError);
  const maximum=createWorld({kind:'bank-reconciliation',orderCount:1,reconciliationControls:{bankFeeMinor:0,interestMinor:1e12}});assert.equal(maximum.bankActivities[0].amount_minor,1e12);assert.ok(Number.isSafeInteger(maximum.bankStatements[0].closing_balance_minor));
});

test('bank activity normalization is additive and protects suspense from manual clearance',()=>{
  const w=world();rejects(w,{type:'post_journal',lines:[{account_id:'bank-suspense',debit_minor:1},{account_id:'equity',credit_minor:1}]},'control_account_locked');
  const accountIds=['bank-suspense','bank-fee-expense','interest-income'];w.accounts=w.accounts.filter(account=>!accountIds.includes(account.id));delete w.bankActivities;const prior=structuredClone({accounts:w.accounts,bank:w.bankTransactions,journals:w.journals,operations:w.operations});normalizeWorld(w);assert.deepEqual(w.accounts.filter(account=>!accountIds.includes(account.id)),prior.accounts);assert.deepEqual(w.bankTransactions,prior.bank);assert.deepEqual(w.journals,prior.journals);assert.deepEqual(w.operations,prior.operations);assert.deepEqual(w.bankActivities,[]);assert.ok(w.accounts.filter(account=>accountIds.includes(account.id)).every(account=>account.balance_minor===0));
});

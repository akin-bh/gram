import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError,normalizeWorld,recordsFor,summarize} from './world.ts';
import type {Action,Actor,World} from './world.ts';
const controller:Actor={id:'bank-fact-controller',role:'controller'},operator:Actor={id:'bank-classifier',role:'agent'};
const act=(w:World,action:Action,actor=controller)=>applyAction(w,action,actor).result;
const world=()=>createWorld({kind:'saas-collections',orderCount:1});
const input=(w:World,kind='fee',amount=275,source='external-bank-source')=>({type:'record_bank_activity',source_transaction_id:source,account_id:'cash-bank',currency:'USD',kind,amount_minor:amount,posted_at:w.now,description:'Observed synthetic bank posting',external_event_id:`event-${source}`});
const classify=(w:World,activity:any)=>act(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:activity.kind==='fee'?'bank-fee-expense':'interest-income'},operator);
function rejects(w:World,action:Action,code:string,actor=operator){const before=structuredClone(w);expect(()=>act(w,action,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);}
function balance(w:World,id:string){return w.accounts.find(account=>account.id===id).balance_minor;}
function exact(w:World){for(const journal of w.journals)expect(journal.lines.reduce((sum:number,line:any)=>sum+line.debit_minor-line.credit_minor,0)).toBe(0);expect(w.accounts.reduce((sum,account)=>sum+account.balance_minor,0)).toBe(0);expect(w.accounts.every(account=>Number.isSafeInteger(account.balance_minor))).toBeTruthy();}

test('external bank dates stay distinct from actual posting, and classification is a separate cash-neutral receipt',()=>{
  const w=world(),sourceAt=w.now,cash=summarize(w).cash_minor;act(w,{type:'advance_time',hours:2});const observed=act(w,{...input(w),posted_at:sourceAt});
  expect(observed.bank_transaction.posted_at).toBe(sourceAt);expect(observed.bank_activity.observed_at).toBe(w.now);expect(w.journals.find(journal=>journal.id===observed.operation.journal_id).posted_at).toBe(w.now);expect(summarize(w).cash_minor).toBe(cash-275);expect(balance(w,'bank-suspense')).toBe(275);
  const bank=structuredClone(w.bankTransactions),receipt=observed.bank_activity.receipt_id,result=classify(w,observed.bank_activity);expect(result.operation.cash_effect_minor).toBe(0);expect(result.bank_activity.receipt_id).toBe(receipt);expect(balance(w,'bank-fee-expense')).toBe(275);expect(balance(w,'bank-suspense')).toBe(0);expect(w.bankTransactions).toStrictEqual(bank);expect(result.operation.journal_lines.every((line:any)=>line.account_id!=='cash-bank')).toBeTruthy();expect(w.documents.some(doc=>doc.original_receipt_id===receipt)).toBeTruthy();
  const operations=w.operations.length,docs=w.documents.length;expect(classify(w,result.bank_activity).replayed).toBe(true);expect(w.operations.length).toBe(operations);expect(w.documents.length).toBe(docs);exact(w);
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
  const replay=act(w,action);expect(replay.replayed).toBe(true);expect(replay.bank_activity.status).toBe('unclassified');expect(w.bankActivities[0].status).toBe('classified');expect(w.bankActivities[0].classification_operation_id).toBe(result.operation.id);expect(w.operations.length).toBe(operations);expect(w.bankTransactions).toStrictEqual(bank);
  rejects(w,{...action,external_event_id:'same-source-new-envelope'},'duplicate_bank_activity_source',controller);rejects(w,{...action,amount_minor:1},'external_event_conflict',controller);
});

test('classification independently verifies date, account, currency, signed source amount and original cash operation',()=>{
  const base=world(),activity=act(base,input(base)).bank_activity;
  const corruptions=[(w:World)=>{w.bankTransactions.at(-1).posted_at='2026-10-24T08:00:00.000Z';},(w:World)=>{w.bankTransactions.at(-1).account_id='cash-processor';},(w:World)=>{w.bankTransactions.at(-1).currency='EUR';},(w:World)=>{w.bankTransactions.at(-1).amount_minor=275;},(w:World)=>{w.bankActivities[0].amount_minor=1;},(w:World)=>{w.operations.find(operation=>operation.id===activity.operation_id).cash_effect_minor=0;},(w:World)=>{w.operations.find(operation=>operation.id===activity.operation_id).source_posted_at='2026-10-24T08:00:00.000Z';}];
  for(const corrupt of corruptions){const w=structuredClone(base);corrupt(w);rejects(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:'bank-fee-expense'},'bank_activity_evidence_mismatch');}
});

test('deferred observation and classification retain exactly two postings and do not replay the bank movement during recovery',()=>{
  const w=world(),cash=summarize(w).cash_minor;act(w,{type:'close_period'});act(w,{type:'set_fault',system:'ledger',mode:'offline'});const activity=act(w,input(w,'interest',1250)).bank_activity;classify(w,activity);
  expect(summarize(w).cash_minor).toBe(cash+1250);expect(w.settledUnposted.length).toBe(2);expect(balance(w,'bank-suspense')).toBe(0);expect(balance(w,'interest-income')).toBe(0);const bank=structuredClone(w.bankTransactions);
  act(w,{type:'reopen_period'});expect(w.settledUnposted.length).toBe(2);act(w,{type:'set_fault',system:'ledger',mode:'healthy'});act(w,{type:'advance_time',hours:1});expect(w.settledUnposted.length).toBe(0);expect(balance(w,'bank-suspense')).toBe(0);expect(balance(w,'interest-income')).toBe(-1250);expect(w.bankTransactions).toStrictEqual(bank);
  const journals=w.journals.length;act(w,{type:'advance_time',hours:1});expect(w.journals.length).toBe(journals);expect(w.bankTransactions).toStrictEqual(bank);exact(w);
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
  rejects(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:'bank-fee-expense'},'bank_activity_balance_overflow');expect(w.bankActivities[0].status).toBe('unclassified');
});

test('configured bank fees and interest are genuine seed facts with independent source references and unresolved classification',()=>{
  const options={kind:'bank-reconciliation',orderCount:1,seed:52,reconciliationControls:{deferredPosting:true,bankFeeMinor:400,interestMinor:125}};const w=createWorld(options);expect(w).toStrictEqual(createWorld(options));expect(w.bankActivities.length).toBe(2);expect(w.bankStatements[0].lines.length).toBe(3);
  expect(w.bankStatements[0].lines.slice(1).map((line:any)=>line.source_refs)).toStrictEqual([['seed-bank-fee'],['seed-bank-interest']]);expect(w.bankStatements[0].closing_balance_minor).toBe(w.bankStatements[0].opening_balance_minor+10000-400+125);expect(balance(w,'bank-suspense')).toBe(275);expect(summarize(w).unclassified_bank_activities).toBe(2);
  expect(w.bankActivities.every((activity:any)=>activity.status==='unclassified'&&activity.posted_at===w.reconciliationSources.end_at)).toBeTruthy();expect(w.bankActivities.every((activity:any)=>w.journals.find(journal=>journal.source_id===activity.operation_id).posted_at>w.reconciliationSources.end_at)).toBeTruthy();
  for(const system of ['bank','mercury','plaid','ledger','netsuite'])expect(recordsFor(w,system,'bank-activity')).toStrictEqual(w.bankActivities);
  const bank=structuredClone(w.bankTransactions);for(const activity of w.bankActivities)classify(w,activity);expect(w.bankTransactions).toStrictEqual(bank);expect(balance(w,'bank-suspense')).toBe(0);expect(balance(w,'bank-fee-expense')).toBe(400);expect(balance(w,'interest-income')).toBe(-125);exact(w);
  expect(createWorld({kind:'bank-reconciliation'}).bankActivities.length).toBe(0);for(const reconciliationControls of [{bankFeeMinor:-1},{bankFeeMinor:0.5},{interestMinor:1e12+1}])expect(()=>createWorld({kind:'bank-reconciliation',reconciliationControls})).toThrow(DomainError);
  const maximum=createWorld({kind:'bank-reconciliation',orderCount:1,reconciliationControls:{bankFeeMinor:0,interestMinor:1e12}});expect(maximum.bankActivities[0].amount_minor).toBe(1e12);expect(Number.isSafeInteger(maximum.bankStatements[0].closing_balance_minor)).toBeTruthy();
});

test('bank activity normalization is additive and protects suspense from manual clearance',()=>{
  const w=world();rejects(w,{type:'post_journal',lines:[{account_id:'bank-suspense',debit_minor:1},{account_id:'equity',credit_minor:1}]},'control_account_locked');
  const accountIds=['bank-suspense','bank-fee-expense','interest-income'];w.accounts=w.accounts.filter(account=>!accountIds.includes(account.id));delete w.bankActivities;const prior=structuredClone({accounts:w.accounts,bank:w.bankTransactions,journals:w.journals,operations:w.operations});normalizeWorld(w);expect(w.accounts.filter(account=>!accountIds.includes(account.id))).toStrictEqual(prior.accounts);expect(w.bankTransactions).toStrictEqual(prior.bank);expect(w.journals).toStrictEqual(prior.journals);expect(w.operations).toStrictEqual(prior.operations);expect(w.bankActivities).toStrictEqual([]);expect(w.accounts.filter(account=>accountIds.includes(account.id)).every(account=>account.balance_minor===0)).toBeTruthy();
});

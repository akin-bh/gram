import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {createWorld,applyAction,summarize} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {bankBlueprintShape,registerBlueprintBankRefs,validateBlueprintBank,materializeBlueprintClosingQuotes,materializeBlueprintBankActivity,materializeBlueprintBankStatements} from './blueprint-bank.ts';
import type {BlueprintBankInput} from './blueprint-bank.ts';
import type {BlueprintValidationHooks,BlueprintMaterializationHooks} from './blueprint-support.ts';
import {validateBlueprint} from './blueprint.ts';

const opening='2026-10-24T09:00:00.000Z',asOf='2026-10-24T12:00:00.000Z';
const controller:Actor={id:'bank-blueprint-controller',role:'controller'},operator:Actor={id:'bank-blueprint-operator',role:'operator'},reviewer:Actor={id:'bank-blueprint-reviewer',role:'controller'};
const schema=z.object(bankBlueprintShape).strict();
const parse=(input:any)=>schema.parse(input);
const fee=(patch:any={})=>({ref:'observed-fee',source_transaction_id:'BANK-FEE-1',account_ref:'operating',currency:'USD',kind:'fee',amount_minor:250,posted_at:'2026-10-24T10:30:00.000Z',description:'Independent bank service fee',...patch});
const quote=(patch:any={})=>({ref:'closing-eur',base_currency:'EUR',quote_currency:'USD',numerator:'11',denominator:'10',observed_at:'2026-10-24T11:00:00.000Z',expires_at:'2026-10-25T11:00:00.000Z',...patch});
const statement=(patch:any={})=>({ref:'statement',source_statement_id:'OCT-OPERATING-1',account_ref:'operating',currency:'USD',start_at:opening,end_at:'2026-10-24T11:45:00.000Z',opening_balance_minor:100000,closing_balance_minor:99750,lines:[{ref:'fee-line',source_line_id:'L-FEE',posted_at:'2026-10-24T10:31:00.000Z',amount_minor:-250,source_refs:[{kind:'bank_activity',ref:'observed-fee'}]}],...patch});
const fresh=(id='bank-blueprint-fixture')=>createWorld({kind:'period-close',name:'Bank source verification',startingCashMinor:100000,blueprint:{version:1,opening_at:opening,vendors:[{ref:'source-vendor',name:'Source vendor',email:'source@vendor.test'}]}} as any,id);
const financial=(w:World)=>structuredClone({accounts:w.accounts,bank:w.bankTransactions,journals:w.journals,operations:w.operations,transfers:w.treasuryTransfers});
function validation(input:BlueprintBankInput,extra:[string,string,any][]=[],limits={records:200,lines:400}){
  const refs=new Map<string,{kind:string;row:any}>([['operating',{kind:'bank_account',row:{currency:'USD'}}]]);let records=0,lines=0;
  const fail=(code:string,message:string,details?:unknown):never=>{throw Object.assign(new Error(message),{code,details});};
  const h:BlueprintValidationHooks={openingAt:opening,asOf,fail,countLines(count){lines+=count;if(lines>limits.lines)fail('blueprint_too_large','Shared line budget exceeded');},add(row,kind,line=false){if(refs.has(row.ref))fail('duplicate_blueprint_ref',row.ref);refs.set(row.ref,{kind,row});if(line)lines++;else records++;if(records>limits.records||lines>limits.lines)fail('blueprint_too_large','Shared source/line budget exceeded');},use(ref,kind,path){const entry=refs.get(ref);if(!entry||entry.kind!==kind)fail('invalid_blueprint_ref',`${path} needs ${kind}`);return entry!.row;}};
  for(const [ref,kind,row] of extra)h.add({ref,...row},kind);
  registerBlueprintBankRefs(input,h);validateBlueprintBank(input,h);return {h,refs,records,lines};
}
function materialization(w:World){
  const ids:Record<string,{id:string;kind:string}>={operating:{id:'cash-bank',kind:'bank_account'}},history:any[]=[];
  const perform=(ref:string,action:Action,actor=controller)=>{const result=applyAction(w,action,actor);history.push({ref,action:structuredClone(action),actor:structuredClone(actor),result:structuredClone(result.result),events:structuredClone(result.events)});return result.result;};
  const h:BlueprintMaterializationHooks={openingAt:opening,asOf,operator,reviewer,id(ref){assert.ok(ids[ref],`Unknown materialized ref ${ref}`);return ids[ref].id;},bind(ref,row,kind){assert.equal(typeof row?.id,'string');ids[ref]={id:row.id,kind};return row;},source(ref,action){return perform(ref,{...action,external_event_id:`bank-blueprint-${ref}-${action.type}`});},perform,schedule(){throw new Error('Bank facts must not schedule implicit work');}};
  return {h,ids,history,advance:()=>{if(w.now!==asOf)perform('as-of',{type:'advance_time',hours:(Date.parse(asOf)-Date.parse(w.now))/3600000});}};
}

test('bank blueprint fields are optional and reject unsupported authority, imprecise money and malformed timestamps',()=>{
  assert.deepEqual(parse({}),{});assert.doesNotThrow(()=>z.toJSONSchema(schema,{target:'draft-7'}));
  for(const patch of [{force:true},{account_ref:'other-bank'},{currency:'EUR'},{amount_minor:0},{amount_minor:0.5},{amount_minor:1e12+1},{source_transaction_id:'receipt_999999'},{source_transaction_id:'banktx-op_900002'},{posted_at:'2026-10-24T10:30:00Z'},{posted_at:'2026-02-30T10:30:00.000Z'},{classify:true}])assert.equal(schema.safeParse({bank_activities:[fee(patch)]}).success,false,JSON.stringify(patch));
  for(const patch of [{numerator:'1.1'},{denominator:'0'},{quote_currency:'EUR'},{balance_minor:1}])assert.equal(schema.safeParse({closing_fx_quotes:[quote(patch)]}).success,false);
  for(const patch of [{closed:true},{matches:[]},{lines:[{...statement().lines[0],amount_minor:0}]},{lines:[{...statement().lines[0],source_refs:['BANK-FEE-1']}]},{lines:[{...statement().lines[0],source_refs:[{kind:'external',identifier:'op_000123'}]}]}])assert.equal(schema.safeParse({bank_statements:[statement(patch)]}).success,false);
});

test('shared reference/record/line budgets include every bank source and line, with closing quotes unavailable to opening history',()=>{
  const input=parse({closing_fx_quotes:[quote()],bank_activities:[fee()],bank_statements:[statement()]}),v=validation(input);
  assert.equal(v.records,3);assert.equal(v.lines,1);assert.equal(v.refs.get('closing-eur')!.kind,'closing_quote');assert.equal(v.refs.get('fee-line')!.kind,'statement_line');
  assert.throws(()=>v.h.use('closing-eur','quote','opening invoice'),(error:any)=>error.code==='invalid_blueprint_ref');
  assert.throws(()=>validation(input,[['observed-fee','vendor',{}]]),(error:any)=>error.code==='duplicate_blueprint_ref');
  assert.throws(()=>validation(input,[],{records:2,lines:400}),(error:any)=>error.code==='blueprint_too_large');
  assert.throws(()=>validation(input,[],{records:200,lines:0}),(error:any)=>error.code==='blueprint_too_large');
});

test('bank source validation enforces exact chronology and duplicate source identity without assuming bank agreement',()=>{
  for(const row of [fee({posted_at:'2026-10-24T08:59:59.999Z'}),fee({posted_at:'2026-10-24T12:00:00.001Z'})])assert.throws(()=>validation(parse({bank_activities:[row]})),(error:any)=>error.code==='invalid_blueprint_bank_activity_time');
  for(const row of [quote({observed_at:'2026-10-24T12:00:00.001Z'}),quote({expires_at:'2026-10-24T11:00:00.000Z'}),quote({expires_at:'2026-11-25T11:00:00.000Z'})])assert.throws(()=>validation(parse({closing_fx_quotes:[row]})),(error:any)=>error.code==='invalid_blueprint_closing_quote');
  assert.throws(()=>validation(parse({bank_activities:[fee(),fee({ref:'same-source'})]})),(error:any)=>error.code==='duplicate_blueprint_bank_source');
  assert.throws(()=>validation(parse({bank_statements:[statement({lines:[],opening_balance_minor:0,closing_balance_minor:0}),statement({ref:'duplicate-statement',lines:[],opening_balance_minor:0,closing_balance_minor:0})]})),(error:any)=>error.code==='duplicate_blueprint_statement_source');
  const wrongCurrency=statement({account_ref:'euro-bank',lines:[],opening_balance_minor:0,closing_balance_minor:0});assert.throws(()=>validation(parse({bank_statements:[wrongCurrency]}),[['euro-bank','bank_account',{currency:'EUR'}]]),(error:any)=>error.code==='invalid_blueprint_statement_currency');
});

test('statement internal arithmetic uses exact signed integers and preserves arbitrary independent opening values',()=>{
  const line={ref:'unobserved-line',source_line_id:'UNOBSERVED',posted_at:'2026-10-24T10:00:00.000Z',amount_minor:1,source_refs:[{kind:'external',identifier:'EXTERNAL-UNKNOWN'}]};
  const accepted=parse({bank_statements:[statement({opening_balance_minor:Number.MAX_SAFE_INTEGER-1,closing_balance_minor:Number.MAX_SAFE_INTEGER,lines:[line]})]});assert.doesNotThrow(()=>validation(accepted));
  assert.throws(()=>validation(parse({bank_statements:[statement({opening_balance_minor:Number.MAX_SAFE_INTEGER,closing_balance_minor:Number.MAX_SAFE_INTEGER,lines:[line]})]})),(error:any)=>error.code==='blueprint_statement_overflow');
  assert.throws(()=>validation(parse({bank_statements:[statement({opening_balance_minor:0,closing_balance_minor:2,lines:[line]})]})),(error:any)=>error.code==='unbalanced_blueprint_statement');
  for(const posted_at of [opening,'2026-10-24T11:45:00.001Z'])assert.throws(()=>validation(parse({bank_statements:[statement({opening_balance_minor:0,closing_balance_minor:1,lines:[{...line,posted_at}]})]})),(error:any)=>error.code==='invalid_blueprint_statement_line_time');
});

test('statement reference aliases require the correct source kind and reject duplicates including typed/literal activity aliases',()=>{
  const input=(refs:any[])=>parse({bank_activities:[fee()],bank_statements:[statement({lines:[{...statement().lines[0],source_refs:refs}]})]});
  assert.throws(()=>validation(input([{kind:'funding',ref:'observed-fee'}])),(error:any)=>error.code==='invalid_blueprint_ref');
  assert.throws(()=>validation(input([{kind:'bank_activity',ref:'missing-activity'}])),(error:any)=>error.code==='invalid_blueprint_ref');
  for(const refs of [[{kind:'opening'},{kind:'opening'}],[{kind:'external',identifier:'X'},{kind:'external',identifier:'X'}],[{kind:'bank_activity',ref:'observed-fee'},{kind:'external',identifier:'BANK-FEE-1'}]])assert.throws(()=>validation(input(refs)),(error:any)=>error.code==='duplicate_blueprint_statement_reference');
  assert.doesNotThrow(()=>validation(input([{kind:'external',identifier:'GENUINELY-UNMATCHED'}])));
});

test('closing quotes and bank evidence materialize at as_of with original source dates and no implicit work',()=>{
  const w=fresh(),m=materialization(w),input=parse({closing_fx_quotes:[quote()],bank_activities:[fee()],bank_statements:[statement()]});validation(input);
  assert.throws(()=>materializeBlueprintClosingQuotes(w,input,m.h),(error:any)=>error.code==='blueprint_bank_clock_mismatch');
  assert.throws(()=>materializeBlueprintBankActivity(w,input,m.h),(error:any)=>error.code==='blueprint_bank_clock_mismatch');
  assert.throws(()=>materializeBlueprintBankStatements(w,input,m.h),(error:any)=>error.code==='blueprint_bank_clock_mismatch');
  m.advance();const beforeQuotes=financial(w);materializeBlueprintClosingQuotes(w,input,m.h);assert.deepEqual(financial(w),beforeQuotes);assert.equal(w.fxQuotes[0].observed_at,quote().observed_at);assert.equal(w.fxQuotes[0].recorded_at,asOf);assert.equal(w.fxValuations.length,0);
  materializeBlueprintBankActivity(w,input,m.h);const observed=w.bankActivities[0],bank=w.bankTransactions.find((row:any)=>row.id===observed.bank_transaction_id),operation=w.operations.find(row=>row.id===observed.operation_id),journal=w.journals.find(row=>row.id===operation.journal_id);
  assert.equal(observed.status,'unclassified');assert.equal(observed.observed_at,asOf);assert.equal(bank!.posted_at,fee().posted_at);assert.equal(journal!.posted_at,asOf);assert.equal(bank!.amount_minor,-250);assert.equal(w.accounts.find(row=>row.id==='bank-suspense')!.balance_minor,250);
  const beforeStatements=financial(w);materializeBlueprintBankStatements(w,input,m.h);assert.deepEqual(financial(w),beforeStatements);assert.equal(w.bankStatements[0].status,'open');assert.equal(w.bankStatements[0].recorded_at,asOf);assert.deepEqual(w.bankStatements[0].lines[0].source_refs,['BANK-FEE-1']);assert.equal(w.bankStatements[0].lines[0].posted_at,'2026-10-24T10:31:00.000Z');assert.equal(m.ids['fee-line'].id,w.bankStatements[0].lines[0].id);
  assert.equal(w.reconciliationMatches.length,0);assert.equal(w.reconciliationReports.length,0);assert.equal(w.approvals.length,0);assert.deepEqual(m.history.map(row=>row.action.type),['advance_time','record_fx_quote','record_bank_activity','record_bank_statement']);assert.equal(summarize(w).reconciliation.balanced,true);
});

test('unknown, missing and incorrect statement cash remain real unresolved evidence rather than generated balancing entries',()=>{
  const w=fresh(),m=materialization(w);m.advance();const input=parse({bank_statements:[statement({opening_balance_minor:100000,closing_balance_minor:100500,lines:[{ref:'unknown',source_line_id:'L-UNKNOWN',posted_at:'2026-10-24T10:00:00.000Z',amount_minor:500,source_refs:[{kind:'external',identifier:'UNKNOWN-BANK-RECEIPT'}]}]})]});validation(input);
  const before=financial(w);materializeBlueprintBankStatements(w,input,m.h);assert.deepEqual(financial(w),before);const imported=w.bankStatements[0];assert.equal(imported.closing_balance_minor,100500);assert.deepEqual(imported.lines[0].source_refs,['UNKNOWN-BANK-RECEIPT']);const report=applyAction(w,{type:'prepare_reconciliation',statement_id:imported.id},operator).result.report;assert.equal(report.can_close,false);assert.ok(report.blockers.some((row:any)=>row.code==='unmatched_statement_lines'));
  const incorrect=fresh('incorrect'),n=materialization(incorrect);n.advance();const mismatch=parse({bank_activities:[fee()],bank_statements:[statement({closing_balance_minor:99751,lines:[{...statement().lines[0],amount_minor:-249}]})]});validation(mismatch);materializeBlueprintBankActivity(incorrect,mismatch,n.h);materializeBlueprintBankStatements(incorrect,mismatch,n.h);
  assert.equal(incorrect.bankStatements[0].lines[0].amount_minor,-249);assert.equal(incorrect.bankTransactions.at(-1)!.amount_minor,-250);const pristine=structuredClone(incorrect);assert.throws(()=>applyAction(incorrect,{type:'match_statement_line',statement_id:incorrect.bankStatements[0].id,line_id:incorrect.bankStatements[0].lines[0].id,bank_transaction_ids:[incorrect.bankActivities[0].bank_transaction_id]},operator));assert.deepEqual(incorrect,pristine);
});

test('settled funding aliases group exact existing receipts; explicit operator work and independent close reconcile late fee postings',()=>{
  const w=fresh(),m=materialization(w),bank=m.h.source('reserve-bank',{type:'record_bank_account',name:'Internal reserve',currency:'USD',external_account_id:'RESERVE-ACCOUNT'}).bank_account;m.h.bind('reserve-bank',bank,'bank_account');
  for(const [ref,amount_minor] of [['funding-one',2000],['funding-two',1000]] as const){const requested=m.h.perform(ref,{type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:bank.id,amount_minor,fee_minor:0,reason:'Historical liquidity'},operator);m.h.bind(ref,requested.transfer,'funding');m.h.perform(ref,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},reviewer);m.h.perform(ref,{type:'advance_time',hours:1});}
  m.advance();const interest=fee({ref:'observed-interest',source_transaction_id:'BANK-INTEREST-1',kind:'interest',amount_minor:50,posted_at:'2026-10-24T11:30:00.000Z',description:'Bank deposit interest'}),group={ref:'group-line',source_line_id:'GROUP-1',posted_at:'2026-10-24T11:05:00.000Z',amount_minor:-3000,source_refs:[{kind:'funding',ref:'funding-one'},{kind:'funding',ref:'funding-two'}]},input=parse({bank_activities:[fee(),interest],bank_statements:[statement({closing_balance_minor:96800,lines:[group,statement().lines[0],{ref:'interest-line',source_line_id:'L-INTEREST',posted_at:'2026-10-24T11:31:00.000Z',amount_minor:50,source_refs:[{kind:'bank_activity',ref:interest.ref}]}]})]});
  validation(input,[['funding-one','funding',{}],['funding-two','funding',{}]]);materializeBlueprintBankActivity(w,input,m.h);const before=financial(w);materializeBlueprintBankStatements(w,input,m.h);assert.deepEqual(financial(w),before);const imported=w.bankStatements[0];assert.deepEqual(imported.lines[0].source_refs,w.treasuryTransfers.map((row:any)=>row.receipt_id));assert.equal(w.reconciliationMatches.length,0);
  for(const line of imported.lines){const selected=w.bankTransactions.filter(row=>row.account_id==='cash-bank'&&line.source_refs.some((ref:string)=>[row.id,row.receipt_id,row.source_transaction_id].includes(ref)));applyAction(w,{type:'match_statement_line',statement_id:imported.id,line_id:line.id,bank_transaction_ids:selected.map(row=>row.id)},operator);}
  const blocked=applyAction(w,{type:'prepare_reconciliation',statement_id:imported.id},operator).result.report;assert.equal(blocked.can_close,false);assert.ok(blocked.blockers.some((row:any)=>row.code==='unclassified_bank_activity'));
  for(const activity of w.bankActivities)applyAction(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:activity.kind==='fee'?'bank-fee-expense':'interest-income'},operator);
  const report=applyAction(w,{type:'prepare_reconciliation',statement_id:imported.id},operator).result.report;assert.equal(report.can_close,true);assert.equal(report.timing_items.length,4);assert.equal(report.adjusted_difference_minor,0);
  applyAction(w,{type:'close_reconciliation',statement_id:imported.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((row:any)=>row.id),external_event_id:'independent-bank-close'},reviewer);
  assert.equal(w.bankStatements[0].status,'closed');assert.deepEqual(w.bankTransactions,before.bank);assert.equal(summarize(w).reconciliation.balanced,true);
});

test('source bank facts survive a closed period and post once after recovery; the statement never invents a journal',()=>{
  const w=fresh(),m=materialization(w);applyAction(w,{type:'close_period'},controller);m.advance();const input=parse({bank_activities:[fee()],bank_statements:[statement()]});validation(input);materializeBlueprintBankActivity(w,input,m.h);materializeBlueprintBankStatements(w,input,m.h);
  const operation=w.operations.find(row=>row.id===w.bankActivities[0].operation_id)!;assert.equal(operation.accounting_status,'pending_posting');assert.equal(operation.journal_id,undefined);assert.equal(w.bankTransactions.at(-1)!.posted_at,fee().posted_at);assert.equal(w.journals.length,1);assert.equal(w.bankStatements[0].status,'open');
  const bankBefore=structuredClone(w.bankTransactions);applyAction(w,{type:'reopen_period'},controller);const posted=w.operations.find(row=>row.id===operation.id)!;assert.equal(posted.accounting_status,'posted');assert.equal(w.journals.find(row=>row.id===posted.journal_id)!.posted_at,asOf);const count=w.journals.length;applyAction(w,{type:'advance_time',hours:1},controller);assert.equal(w.journals.length,count);assert.deepEqual(w.bankTransactions,bankBefore);
});

test('bank source materialization is portable across world IDs and leaves caller inputs unchanged',()=>{
  const input=parse({closing_fx_quotes:[quote()],bank_activities:[fee()],bank_statements:[statement()]}),original=structuredClone(input);
  const build=(id:string)=>{const w=fresh(id),m=materialization(w);validation(input);m.advance();materializeBlueprintClosingQuotes(w,input,m.h);materializeBlueprintBankActivity(w,input,m.h);materializeBlueprintBankStatements(w,input,m.h);return {...w,id:'portable'};};
  assert.deepEqual(build('bank-first'),build('bank-second'));assert.deepEqual(input,original);
});

test('integrated bank-only blueprints retain exact observation clocks, source history, independent disagreement and final faults',()=>{
  const observation='2026-10-24T12:00:00.123Z',blueprint={version:1,opening_at:opening,as_of:observation,closing_fx_quotes:[quote()],bank_activities:[fee()],bank_statements:[statement({closing_balance_minor:99751,lines:[{...statement().lines[0],amount_minor:-249}]})]},before=structuredClone(blueprint);
  const input:any={kind:'bank-reconciliation',name:'Independent bank source enterprise',startingCashMinor:100000,blueprint,initialFaults:[{system:'netsuite',mode:'offline'}]};
  const w=createWorld(input,'integrated-bank-first'),other=createWorld(input,'integrated-bank-second');assert.deepEqual({...w,id:'portable'},{...other,id:'portable'});assert.deepEqual(blueprint,before);assert.equal(w.now,observation);assert.equal(w.sourceMode,'blueprint');assert.equal(w.events.length,0);assert.equal(w.invoices.length,0);assert.equal(w.treasuryTransfers.length,0);
  assert.equal(w.bankStatements[0].closing_balance_minor,99751);assert.equal(w.bankStatements[0].lines[0].amount_minor,-249);assert.equal(w.bankTransactions.at(-1)!.amount_minor,-250);assert.equal(w.bankStatements[0].status,'open');assert.equal(w.bankActivities[0].status,'unclassified');assert.equal(w.reconciliationMatches.length,0);assert.equal(w.reconciliationReports.length,0);assert.equal(w.fxValuations.length,0);
  const op=w.operations.find(row=>row.id===w.bankActivities[0].operation_id)!;assert.equal(op.accounting_status,'posted','Initial fault injection follows actual construction history');assert.equal(w.journals.find(row=>row.id===op.journal_id)!.posted_at,observation);assert.equal(w.faults.netsuite.mode,'offline');
  assert.equal(w.blueprintManifest.refs['closing-eur'].kind,'closing_quote');assert.equal(w.blueprintManifest.refs['statement'].id,w.bankStatements[0].id);assert.equal(w.blueprintManifest.refs['fee-line'].id,w.bankStatements[0].lines[0].id);assert.equal(w.blueprintManifest.materialized_at,observation);
  const history=JSON.stringify(w.generationHistory);assert.ok(w.generationHistory.some((row:any)=>row.action.type==='advance_to'&&row.action.at===observation));assert.deepEqual(w.generationHistory.filter((row:any)=>row.action.type.startsWith('record_')).map((row:any)=>row.action.type),['record_fx_quote','record_bank_activity','record_bank_statement']);
  assert.throws(()=>applyAction(w,{type:'classify_bank_activity',bank_activity_id:w.bankActivities[0].id,account_id:'bank-fee-expense'},operator));assert.equal(JSON.stringify(w.generationHistory),history);
});

test('integrated native statements resolve real funding receipts while later FX observations neither fund history nor revalue cash',()=>{
  const b:any={version:1,opening_at:opening,as_of:asOf,bank_accounts:[{ref:'euro-bank',name:'EUR operations',currency:'EUR'}],fx_quotes:[quote({ref:'opening-eur',numerator:'1',denominator:'1',observed_at:opening})],closing_fx_quotes:[quote()],historical_funding:[{ref:'euro-funding',from_account_ref:'operating',to_account_ref:'euro-bank',amount_minor:25000,fee_minor:0,quote_ref:'opening-eur',reason:'Explicit historical liquidity'}],bank_statements:[statement({ref:'euro-statement',source_statement_id:'EUR-1',account_ref:'euro-bank',currency:'EUR',opening_balance_minor:0,closing_balance_minor:25000,lines:[{ref:'euro-funding-line',source_line_id:'EUR-FUNDING-1',posted_at:'2026-10-24T10:00:00.000Z',amount_minor:25000,source_refs:[{kind:'funding',ref:'euro-funding'}]}]})]};
  const w=createWorld({kind:'treasury-fx',name:'Native bank sources',startingCashMinor:100000,blueprint:b} as any),transfer=w.treasuryTransfers[0],bank=w.bankAccounts.find((row:any)=>row.id===w.blueprintManifest.refs['euro-bank'].id),quoteId=w.blueprintManifest.refs['closing-eur'].id;
  assert.equal(transfer.status,'settled');assert.equal(transfer.settled_at,'2026-10-24T10:00:00.000Z');assert.equal(transfer.destination_amount_minor,25000);assert.notEqual(transfer.requested_by,transfer.approved_by);assert.deepEqual(w.bankStatements[0].lines[0].source_refs,[transfer.receipt_id]);assert.equal(w.bankStatements[0].currency,'EUR');assert.equal(w.fxQuotes.find((row:any)=>row.id===quoteId).observed_at,quote().observed_at);assert.equal(w.accounts.find(row=>row.id===bank.gl_account_id)!.balance_minor,25000);assert.equal(w.fxValuations.length,0);
  const futureAuthority=structuredClone(b);futureAuthority.historical_funding[0].quote_ref='closing-eur';assert.throws(()=>validateBlueprint(futureAuthority),(error:any)=>error.code==='invalid_blueprint_ref');
  const nativeRow=w.bankTransactions.find(row=>row.account_id===bank.id&&row.amount_minor===25000)!;applyAction(w,{type:'match_statement_line',statement_id:w.bankStatements[0].id,line_id:w.bankStatements[0].lines[0].id,bank_transaction_ids:[nativeRow.id]},operator);const report=applyAction(w,{type:'prepare_reconciliation',statement_id:w.bankStatements[0].id},operator).result.report;assert.equal(report.can_close,true);assert.equal(report.bank_closing_minor,25000);assert.equal(report.adjusted_functional_difference_minor,0);
});

test('integrated bank sources count against the same global source and line budgets as the rest of the blueprint',()=>{
  const activities=Array.from({length:100},(_,i)=>fee({ref:`fee-${i}`,source_transaction_id:`FEE-${i}`})),vendors=Array.from({length:100},(_,i)=>({ref:`vendor-${i}`,name:`Vendor ${i}`,email:`vendor-${i}@simulation.test`}));
  assert.throws(()=>validateBlueprint({version:1,opening_at:opening,as_of:asOf,vendors,bank_activities:activities,closing_fx_quotes:[quote()]}),(error:any)=>error.code==='blueprint_too_large');
  const statements=[200,200,1].map((count,index)=>statement({ref:`statement-${index}`,source_statement_id:`STMT-${index}`,opening_balance_minor:0,closing_balance_minor:count,lines:Array.from({length:count},(_,i)=>({ref:`statement-${index}-line-${i}`,source_line_id:`LINE-${i}`,posted_at:'2026-10-24T10:00:00.000Z',amount_minor:1,source_refs:[{kind:'external',identifier:`UNOBSERVED-${index}-${i}`}]}))}));
  assert.throws(()=>validateBlueprint({version:1,opening_at:opening,as_of:asOf,bank_statements:statements}),(error:any)=>error.code==='blueprint_too_large');
});

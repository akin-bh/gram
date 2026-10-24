import {test,expect} from 'bun:test';
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
  const h:BlueprintMaterializationHooks={openingAt:opening,asOf,operator,reviewer,id(ref){expect(ids[ref],`Unknown materialized ref ${ref}`).toBeTruthy();return ids[ref].id;},bind(ref,row,kind){expect(typeof row?.id).toBe('string');ids[ref]={id:row.id,kind};return row;},source(ref,action){return perform(ref,{...action,external_event_id:`bank-blueprint-${ref}-${action.type}`});},perform,schedule(){throw new Error('Bank facts must not schedule implicit work');}};
  return {h,ids,history,advance:()=>{if(w.now!==asOf)perform('as-of',{type:'advance_time',hours:(Date.parse(asOf)-Date.parse(w.now))/3600000});}};
}

test('bank blueprint fields are optional and reject unsupported authority, imprecise money and malformed timestamps',()=>{
  expect(parse({})).toStrictEqual({});expect(()=>z.toJSONSchema(schema,{target:'draft-7'})).not.toThrow();
  for(const patch of [{force:true},{account_ref:'other-bank'},{currency:'EUR'},{amount_minor:0},{amount_minor:0.5},{amount_minor:1e12+1},{source_transaction_id:'receipt_999999'},{source_transaction_id:'banktx-op_900002'},{posted_at:'2026-10-24T10:30:00Z'},{posted_at:'2026-02-30T10:30:00.000Z'},{classify:true}])expect(schema.safeParse({bank_activities:[fee(patch)]}).success,JSON.stringify(patch)).toBe(false);
  for(const patch of [{numerator:'1.1'},{denominator:'0'},{quote_currency:'EUR'},{balance_minor:1}])expect(schema.safeParse({closing_fx_quotes:[quote(patch)]}).success).toBe(false);
  for(const patch of [{closed:true},{matches:[]},{lines:[{...statement().lines[0],amount_minor:0}]},{lines:[{...statement().lines[0],source_refs:['BANK-FEE-1']}]},{lines:[{...statement().lines[0],source_refs:[{kind:'external',identifier:'op_000123'}]}]}])expect(schema.safeParse({bank_statements:[statement(patch)]}).success).toBe(false);
});

test('shared reference/record/line budgets include every bank source and line, with closing quotes unavailable to opening history',()=>{
  const input=parse({closing_fx_quotes:[quote()],bank_activities:[fee()],bank_statements:[statement()]}),v=validation(input);
  expect(v.records).toBe(3);expect(v.lines).toBe(1);expect(v.refs.get('closing-eur')!.kind).toBe('closing_quote');expect(v.refs.get('fee-line')!.kind).toBe('statement_line');
  expect(()=>v.h.use('closing-eur','quote','opening invoice')).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ref');
  expect(()=>validation(input,[['observed-fee','vendor',{}]])).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_ref');
  expect(()=>validation(input,[],{records:2,lines:400})).toThrowSatisfying((error:any)=>error.code==='blueprint_too_large');
  expect(()=>validation(input,[],{records:200,lines:0})).toThrowSatisfying((error:any)=>error.code==='blueprint_too_large');
});

test('bank source validation enforces exact chronology and duplicate source identity without assuming bank agreement',()=>{
  for(const row of [fee({posted_at:'2026-10-24T08:59:59.999Z'}),fee({posted_at:'2026-10-24T12:00:00.001Z'})])expect(()=>validation(parse({bank_activities:[row]}))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_bank_activity_time');
  for(const row of [quote({observed_at:'2026-10-24T12:00:00.001Z'}),quote({expires_at:'2026-10-24T11:00:00.000Z'}),quote({expires_at:'2026-11-25T11:00:00.000Z'})])expect(()=>validation(parse({closing_fx_quotes:[row]}))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_closing_quote');
  expect(()=>validation(parse({bank_activities:[fee(),fee({ref:'same-source'})]}))).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_bank_source');
  expect(()=>validation(parse({bank_statements:[statement({lines:[],opening_balance_minor:0,closing_balance_minor:0}),statement({ref:'duplicate-statement',lines:[],opening_balance_minor:0,closing_balance_minor:0})]}))).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_statement_source');
  const wrongCurrency=statement({account_ref:'euro-bank',lines:[],opening_balance_minor:0,closing_balance_minor:0});expect(()=>validation(parse({bank_statements:[wrongCurrency]}),[['euro-bank','bank_account',{currency:'EUR'}]])).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_statement_currency');
});

test('statement internal arithmetic uses exact signed integers and preserves arbitrary independent opening values',()=>{
  const line={ref:'unobserved-line',source_line_id:'UNOBSERVED',posted_at:'2026-10-24T10:00:00.000Z',amount_minor:1,source_refs:[{kind:'external',identifier:'EXTERNAL-UNKNOWN'}]};
  const accepted=parse({bank_statements:[statement({opening_balance_minor:Number.MAX_SAFE_INTEGER-1,closing_balance_minor:Number.MAX_SAFE_INTEGER,lines:[line]})]});expect(()=>validation(accepted)).not.toThrow();
  expect(()=>validation(parse({bank_statements:[statement({opening_balance_minor:Number.MAX_SAFE_INTEGER,closing_balance_minor:Number.MAX_SAFE_INTEGER,lines:[line]})]}))).toThrowSatisfying((error:any)=>error.code==='blueprint_statement_overflow');
  expect(()=>validation(parse({bank_statements:[statement({opening_balance_minor:0,closing_balance_minor:2,lines:[line]})]}))).toThrowSatisfying((error:any)=>error.code==='unbalanced_blueprint_statement');
  for(const posted_at of [opening,'2026-10-24T11:45:00.001Z'])expect(()=>validation(parse({bank_statements:[statement({opening_balance_minor:0,closing_balance_minor:1,lines:[{...line,posted_at}]})]}))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_statement_line_time');
});

test('statement reference aliases require the correct source kind and reject duplicates including typed/literal activity aliases',()=>{
  const input=(refs:any[])=>parse({bank_activities:[fee()],bank_statements:[statement({lines:[{...statement().lines[0],source_refs:refs}]})]});
  expect(()=>validation(input([{kind:'funding',ref:'observed-fee'}]))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ref');
  expect(()=>validation(input([{kind:'bank_activity',ref:'missing-activity'}]))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ref');
  for(const refs of [[{kind:'opening'},{kind:'opening'}],[{kind:'external',identifier:'X'},{kind:'external',identifier:'X'}],[{kind:'bank_activity',ref:'observed-fee'},{kind:'external',identifier:'BANK-FEE-1'}]])expect(()=>validation(input(refs))).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_statement_reference');
  expect(()=>validation(input([{kind:'external',identifier:'GENUINELY-UNMATCHED'}]))).not.toThrow();
});

test('closing quotes and bank evidence materialize at as_of with original source dates and no implicit work',()=>{
  const w=fresh(),m=materialization(w),input=parse({closing_fx_quotes:[quote()],bank_activities:[fee()],bank_statements:[statement()]});validation(input);
  expect(()=>materializeBlueprintClosingQuotes(w,input,m.h)).toThrowSatisfying((error:any)=>error.code==='blueprint_bank_clock_mismatch');
  expect(()=>materializeBlueprintBankActivity(w,input,m.h)).toThrowSatisfying((error:any)=>error.code==='blueprint_bank_clock_mismatch');
  expect(()=>materializeBlueprintBankStatements(w,input,m.h)).toThrowSatisfying((error:any)=>error.code==='blueprint_bank_clock_mismatch');
  m.advance();const beforeQuotes=financial(w);materializeBlueprintClosingQuotes(w,input,m.h);expect(financial(w)).toStrictEqual(beforeQuotes);expect(w.fxQuotes[0].observed_at).toBe(quote().observed_at);expect(w.fxQuotes[0].recorded_at).toBe(asOf);expect(w.fxValuations.length).toBe(0);
  materializeBlueprintBankActivity(w,input,m.h);const observed=w.bankActivities[0],bank=w.bankTransactions.find((row:any)=>row.id===observed.bank_transaction_id),operation=w.operations.find(row=>row.id===observed.operation_id),journal=w.journals.find(row=>row.id===operation.journal_id);
  expect(observed.status).toBe('unclassified');expect(observed.observed_at).toBe(asOf);expect(bank!.posted_at).toBe(fee().posted_at);expect(journal!.posted_at).toBe(asOf);expect(bank!.amount_minor).toBe(-250);expect(w.accounts.find(row=>row.id==='bank-suspense')!.balance_minor).toBe(250);
  const beforeStatements=financial(w);materializeBlueprintBankStatements(w,input,m.h);expect(financial(w)).toStrictEqual(beforeStatements);expect(w.bankStatements[0].status).toBe('open');expect(w.bankStatements[0].recorded_at).toBe(asOf);expect(w.bankStatements[0].lines[0].source_refs).toStrictEqual(['BANK-FEE-1']);expect(w.bankStatements[0].lines[0].posted_at).toBe('2026-10-24T10:31:00.000Z');expect(m.ids['fee-line'].id).toBe(w.bankStatements[0].lines[0].id);
  expect(w.reconciliationMatches.length).toBe(0);expect(w.reconciliationReports.length).toBe(0);expect(w.approvals.length).toBe(0);expect(m.history.map(row=>row.action.type)).toStrictEqual(['advance_time','record_fx_quote','record_bank_activity','record_bank_statement']);expect(summarize(w).reconciliation.balanced).toBe(true);
});

test('unknown, missing and incorrect statement cash remain real unresolved evidence rather than generated balancing entries',()=>{
  const w=fresh(),m=materialization(w);m.advance();const input=parse({bank_statements:[statement({opening_balance_minor:100000,closing_balance_minor:100500,lines:[{ref:'unknown',source_line_id:'L-UNKNOWN',posted_at:'2026-10-24T10:00:00.000Z',amount_minor:500,source_refs:[{kind:'external',identifier:'UNKNOWN-BANK-RECEIPT'}]}]})]});validation(input);
  const before=financial(w);materializeBlueprintBankStatements(w,input,m.h);expect(financial(w)).toStrictEqual(before);const imported=w.bankStatements[0];expect(imported.closing_balance_minor).toBe(100500);expect(imported.lines[0].source_refs).toStrictEqual(['UNKNOWN-BANK-RECEIPT']);const report=applyAction(w,{type:'prepare_reconciliation',statement_id:imported.id},operator).result.report;expect(report.can_close).toBe(false);expect(report.blockers.some((row:any)=>row.code==='unmatched_statement_lines')).toBeTruthy();
  const incorrect=fresh('incorrect'),n=materialization(incorrect);n.advance();const mismatch=parse({bank_activities:[fee()],bank_statements:[statement({closing_balance_minor:99751,lines:[{...statement().lines[0],amount_minor:-249}]})]});validation(mismatch);materializeBlueprintBankActivity(incorrect,mismatch,n.h);materializeBlueprintBankStatements(incorrect,mismatch,n.h);
  expect(incorrect.bankStatements[0].lines[0].amount_minor).toBe(-249);expect(incorrect.bankTransactions.at(-1)!.amount_minor).toBe(-250);const pristine=structuredClone(incorrect);expect(()=>applyAction(incorrect,{type:'match_statement_line',statement_id:incorrect.bankStatements[0].id,line_id:incorrect.bankStatements[0].lines[0].id,bank_transaction_ids:[incorrect.bankActivities[0].bank_transaction_id]},operator)).toThrow();expect(incorrect).toStrictEqual(pristine);
});

test('settled funding aliases group exact existing receipts; explicit operator work and independent close reconcile late fee postings',()=>{
  const w=fresh(),m=materialization(w),bank=m.h.source('reserve-bank',{type:'record_bank_account',name:'Internal reserve',currency:'USD',external_account_id:'RESERVE-ACCOUNT'}).bank_account;m.h.bind('reserve-bank',bank,'bank_account');
  for(const [ref,amount_minor] of [['funding-one',2000],['funding-two',1000]] as const){const requested=m.h.perform(ref,{type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:bank.id,amount_minor,fee_minor:0,reason:'Historical liquidity'},operator);m.h.bind(ref,requested.transfer,'funding');m.h.perform(ref,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},reviewer);m.h.perform(ref,{type:'advance_time',hours:1});}
  m.advance();const interest=fee({ref:'observed-interest',source_transaction_id:'BANK-INTEREST-1',kind:'interest',amount_minor:50,posted_at:'2026-10-24T11:30:00.000Z',description:'Bank deposit interest'}),group={ref:'group-line',source_line_id:'GROUP-1',posted_at:'2026-10-24T11:05:00.000Z',amount_minor:-3000,source_refs:[{kind:'funding',ref:'funding-one'},{kind:'funding',ref:'funding-two'}]},input=parse({bank_activities:[fee(),interest],bank_statements:[statement({closing_balance_minor:96800,lines:[group,statement().lines[0],{ref:'interest-line',source_line_id:'L-INTEREST',posted_at:'2026-10-24T11:31:00.000Z',amount_minor:50,source_refs:[{kind:'bank_activity',ref:interest.ref}]}]})]});
  validation(input,[['funding-one','funding',{}],['funding-two','funding',{}]]);materializeBlueprintBankActivity(w,input,m.h);const before=financial(w);materializeBlueprintBankStatements(w,input,m.h);expect(financial(w)).toStrictEqual(before);const imported=w.bankStatements[0];expect(imported.lines[0].source_refs).toStrictEqual(w.treasuryTransfers.map((row:any)=>row.receipt_id));expect(w.reconciliationMatches.length).toBe(0);
  for(const line of imported.lines){const selected=w.bankTransactions.filter(row=>row.account_id==='cash-bank'&&line.source_refs.some((ref:string)=>[row.id,row.receipt_id,row.source_transaction_id].includes(ref)));applyAction(w,{type:'match_statement_line',statement_id:imported.id,line_id:line.id,bank_transaction_ids:selected.map(row=>row.id)},operator);}
  const blocked=applyAction(w,{type:'prepare_reconciliation',statement_id:imported.id},operator).result.report;expect(blocked.can_close).toBe(false);expect(blocked.blockers.some((row:any)=>row.code==='unclassified_bank_activity')).toBeTruthy();
  for(const activity of w.bankActivities)applyAction(w,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:activity.kind==='fee'?'bank-fee-expense':'interest-income'},operator);
  const report=applyAction(w,{type:'prepare_reconciliation',statement_id:imported.id},operator).result.report;expect(report.can_close).toBe(true);expect(report.timing_items.length).toBe(4);expect(report.adjusted_difference_minor).toBe(0);
  applyAction(w,{type:'close_reconciliation',statement_id:imported.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((row:any)=>row.id),external_event_id:'independent-bank-close'},reviewer);
  expect(w.bankStatements[0].status).toBe('closed');expect(w.bankTransactions).toStrictEqual(before.bank);expect(summarize(w).reconciliation.balanced).toBe(true);
});

test('source bank facts survive a closed period and post once after recovery; the statement never invents a journal',()=>{
  const w=fresh(),m=materialization(w);applyAction(w,{type:'close_period'},controller);m.advance();const input=parse({bank_activities:[fee()],bank_statements:[statement()]});validation(input);materializeBlueprintBankActivity(w,input,m.h);materializeBlueprintBankStatements(w,input,m.h);
  const operation=w.operations.find(row=>row.id===w.bankActivities[0].operation_id)!;expect(operation.accounting_status).toBe('pending_posting');expect(operation.journal_id).toBeUndefined();expect(w.bankTransactions.at(-1)!.posted_at).toBe(fee().posted_at);expect(w.journals.length).toBe(1);expect(w.bankStatements[0].status).toBe('open');
  const bankBefore=structuredClone(w.bankTransactions);applyAction(w,{type:'reopen_period'},controller);const posted=w.operations.find(row=>row.id===operation.id)!;expect(posted.accounting_status).toBe('posted');expect(w.journals.find(row=>row.id===posted.journal_id)!.posted_at).toBe(asOf);const count=w.journals.length;applyAction(w,{type:'advance_time',hours:1},controller);expect(w.journals.length).toBe(count);expect(w.bankTransactions).toStrictEqual(bankBefore);
});

test('bank source materialization is portable across world IDs and leaves caller inputs unchanged',()=>{
  const input=parse({closing_fx_quotes:[quote()],bank_activities:[fee()],bank_statements:[statement()]}),original=structuredClone(input);
  const build=(id:string)=>{const w=fresh(id),m=materialization(w);validation(input);m.advance();materializeBlueprintClosingQuotes(w,input,m.h);materializeBlueprintBankActivity(w,input,m.h);materializeBlueprintBankStatements(w,input,m.h);return {...w,id:'portable'};};
  expect(build('bank-first')).toStrictEqual(build('bank-second'));expect(input).toStrictEqual(original);
});

test('integrated bank-only blueprints retain exact observation clocks, source history, independent disagreement and final faults',()=>{
  const observation='2026-10-24T12:00:00.123Z',blueprint={version:1,opening_at:opening,as_of:observation,closing_fx_quotes:[quote()],bank_activities:[fee()],bank_statements:[statement({closing_balance_minor:99751,lines:[{...statement().lines[0],amount_minor:-249}]})]},before=structuredClone(blueprint);
  const input:any={kind:'bank-reconciliation',name:'Independent bank source enterprise',startingCashMinor:100000,blueprint,initialFaults:[{system:'netsuite',mode:'offline'}]};
  const w=createWorld(input,'integrated-bank-first'),other=createWorld(input,'integrated-bank-second');expect({...w,id:'portable'}).toStrictEqual({...other,id:'portable'});expect(blueprint).toStrictEqual(before);expect(w.now).toBe(observation);expect(w.sourceMode).toBe('blueprint');expect(w.events.length).toBe(0);expect(w.invoices.length).toBe(0);expect(w.treasuryTransfers.length).toBe(0);
  expect(w.bankStatements[0].closing_balance_minor).toBe(99751);expect(w.bankStatements[0].lines[0].amount_minor).toBe(-249);expect(w.bankTransactions.at(-1)!.amount_minor).toBe(-250);expect(w.bankStatements[0].status).toBe('open');expect(w.bankActivities[0].status).toBe('unclassified');expect(w.reconciliationMatches.length).toBe(0);expect(w.reconciliationReports.length).toBe(0);expect(w.fxValuations.length).toBe(0);
  const op=w.operations.find(row=>row.id===w.bankActivities[0].operation_id)!;expect(op.accounting_status,'Initial fault injection follows actual construction history').toBe('posted');expect(w.journals.find(row=>row.id===op.journal_id)!.posted_at).toBe(observation);expect(w.faults.netsuite.mode).toBe('offline');
  expect(w.blueprintManifest.refs['closing-eur'].kind).toBe('closing_quote');expect(w.blueprintManifest.refs['statement'].id).toBe(w.bankStatements[0].id);expect(w.blueprintManifest.refs['fee-line'].id).toBe(w.bankStatements[0].lines[0].id);expect(w.blueprintManifest.materialized_at).toBe(observation);
  const history=JSON.stringify(w.generationHistory);expect(w.generationHistory.some((row:any)=>row.action.type==='advance_to'&&row.action.at===observation)).toBeTruthy();expect(w.generationHistory.filter((row:any)=>row.action.type.startsWith('record_')).map((row:any)=>row.action.type)).toStrictEqual(['record_fx_quote','record_bank_activity','record_bank_statement']);
  expect(()=>applyAction(w,{type:'classify_bank_activity',bank_activity_id:w.bankActivities[0].id,account_id:'bank-fee-expense'},operator)).toThrow();expect(JSON.stringify(w.generationHistory)).toBe(history);
});

test('integrated native statements resolve real funding receipts while later FX observations neither fund history nor revalue cash',()=>{
  const b:any={version:1,opening_at:opening,as_of:asOf,bank_accounts:[{ref:'euro-bank',name:'EUR operations',currency:'EUR'}],fx_quotes:[quote({ref:'opening-eur',numerator:'1',denominator:'1',observed_at:opening})],closing_fx_quotes:[quote()],historical_funding:[{ref:'euro-funding',from_account_ref:'operating',to_account_ref:'euro-bank',amount_minor:25000,fee_minor:0,quote_ref:'opening-eur',reason:'Explicit historical liquidity'}],bank_statements:[statement({ref:'euro-statement',source_statement_id:'EUR-1',account_ref:'euro-bank',currency:'EUR',opening_balance_minor:0,closing_balance_minor:25000,lines:[{ref:'euro-funding-line',source_line_id:'EUR-FUNDING-1',posted_at:'2026-10-24T10:00:00.000Z',amount_minor:25000,source_refs:[{kind:'funding',ref:'euro-funding'}]}]})]};
  const w=createWorld({kind:'treasury-fx',name:'Native bank sources',startingCashMinor:100000,blueprint:b} as any),transfer=w.treasuryTransfers[0],bank=w.bankAccounts.find((row:any)=>row.id===w.blueprintManifest.refs['euro-bank'].id),quoteId=w.blueprintManifest.refs['closing-eur'].id;
  expect(transfer.status).toBe('settled');expect(transfer.settled_at).toBe('2026-10-24T10:00:00.000Z');expect(transfer.destination_amount_minor).toBe(25000);expect(transfer.requested_by).not.toBe(transfer.approved_by);expect(w.bankStatements[0].lines[0].source_refs).toStrictEqual([transfer.receipt_id]);expect(w.bankStatements[0].currency).toBe('EUR');expect(w.fxQuotes.find((row:any)=>row.id===quoteId).observed_at).toBe(quote().observed_at);expect(w.accounts.find(row=>row.id===bank.gl_account_id)!.balance_minor).toBe(25000);expect(w.fxValuations.length).toBe(0);
  const futureAuthority=structuredClone(b);futureAuthority.historical_funding[0].quote_ref='closing-eur';expect(()=>validateBlueprint(futureAuthority)).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ref');
  const nativeRow=w.bankTransactions.find(row=>row.account_id===bank.id&&row.amount_minor===25000)!;applyAction(w,{type:'match_statement_line',statement_id:w.bankStatements[0].id,line_id:w.bankStatements[0].lines[0].id,bank_transaction_ids:[nativeRow.id]},operator);const report=applyAction(w,{type:'prepare_reconciliation',statement_id:w.bankStatements[0].id},operator).result.report;expect(report.can_close).toBe(true);expect(report.bank_closing_minor).toBe(25000);expect(report.adjusted_functional_difference_minor).toBe(0);
});

test('integrated bank sources count against the same global source and line budgets as the rest of the blueprint',()=>{
  const activities=Array.from({length:100},(_,i)=>fee({ref:`fee-${i}`,source_transaction_id:`FEE-${i}`})),vendors=Array.from({length:100},(_,i)=>({ref:`vendor-${i}`,name:`Vendor ${i}`,email:`vendor-${i}@simulation.test`}));
  expect(()=>validateBlueprint({version:1,opening_at:opening,as_of:asOf,vendors,bank_activities:activities,closing_fx_quotes:[quote()]})).toThrowSatisfying((error:any)=>error.code==='blueprint_too_large');
  const statements=[200,200,1].map((count,index)=>statement({ref:`statement-${index}`,source_statement_id:`STMT-${index}`,opening_balance_minor:0,closing_balance_minor:count,lines:Array.from({length:count},(_,i)=>({ref:`statement-${index}-line-${i}`,source_line_id:`LINE-${i}`,posted_at:'2026-10-24T10:00:00.000Z',amount_minor:1,source_refs:[{kind:'external',identifier:`UNOBSERVED-${index}-${i}`}]}))}));
  expect(()=>validateBlueprint({version:1,opening_at:opening,as_of:asOf,bank_statements:statements})).toThrowSatisfying((error:any)=>error.code==='blueprint_too_large');
});

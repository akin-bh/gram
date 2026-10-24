import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {createWorld,applyAction,summarize} from './world.ts';
import type {World,Action} from './world.ts';
import {ticketingBlueprintShape,registerBlueprintTicketingRefs,validateBlueprintTicketing,materializeBlueprintTicketing} from './blueprint-ticketing.ts';
import type {BlueprintTicketingInput} from './blueprint-ticketing.ts';
import type {BlueprintValidationHooks,BlueprintMaterializationHooks} from './blueprint-support.ts';

const opening='2026-10-01T09:00:00.000Z',asOf='2026-10-01T12:00:00.000Z',starts='2026-10-03T19:00:00.000Z';
const schema=z.object(ticketingBlueprintShape).strict();
const parse=(value:any)=>schema.parse(value);
const event=(patch:any={})=>({ref:'concert',name:'gram autumn concert',promoter_ref:'promoter',starts_at:starts,agreement_reference:'PROMOTER-AGREEMENT-1',agreement_signed_at:'2026-09-25T09:00:00.000Z',...patch});
const order=(patch:any={})=>({ref:'fan-order',event_ref:'concert',customer_ref:'fan',source_order_id:'ORDER-1',ordered_at:'2026-10-01T09:30:00.000Z',quantity:2,face_minor:10000,tax_minor:900,fee_minor:1500,...patch});
const payment=(patch:any={})=>({ref:'fan-payment',order_ref:'fan-order',source_payment_id:'PROCESSOR-CAPTURE-1',outcome:'captured',amount_minor:12400,processor_fee_minor:400,occurred_at:'2026-10-01T10:00:00.000Z',available_at:'2026-10-01T10:30:00.000Z',...patch});
const payout=(patch:any={})=>({ref:'processor-payout',source_payout_id:'PAYOUT-1',source_bank_transaction_id:'BANK-PAYOUT-1',amount_minor:10000,paid_at:'2026-10-01T11:00:00.000Z',...patch});
const topup=(patch:any={})=>({ref:'processor-topup',source_topup_id:'TOPUP-1',source_bank_transaction_id:'BANK-TOPUP-1',amount_minor:1000,posted_at:'2026-10-01T11:15:00.000Z',...patch});
const cancellation=(patch:any={})=>({ref:'concert-cancellation',event_ref:'concert',source_notice_id:'PROMOTER-NOTICE-1',cancelled_at:'2026-10-01T11:30:00.000Z',reason:'Promoter safety cancellation; refund the original admission and tax.',...patch});
const sources=(patch:any={})=>parse({ticket_events:[event()],ticket_orders:[order()],ticket_payment_outcomes:[payment()],processor_payouts:[payout()],processor_topups:[topup()],ticket_cancellations:[cancellation()],...patch});

function validate(input:BlueprintTicketingInput&{bank_activities?:{ref:string;source_transaction_id:string}[]},extra:{ref:string;kind:string;[key:string]:any}[]=[],recordLimit=200){
  const refs=new Map<string,{kind:string;row:any}>();let records=0,lines=0;
  const fail=(code:string,message:string,details?:unknown):never=>{throw Object.assign(new Error(message),{code,details});};
  const h:BlueprintValidationHooks={openingAt:opening,asOf,fail,countLines(count){lines+=count;},add(row,kind,line=false){if(refs.has(row.ref))fail('duplicate_blueprint_ref',row.ref);refs.set(row.ref,{kind,row});if(line)lines++;else records++;if(records>recordLimit)fail('blueprint_too_large','Shared source budget exceeded');},use(alias,kind,path){const entry=refs.get(alias);if(!entry||entry.kind!==kind)fail('invalid_blueprint_ref',`${path} requires ${kind}`);return entry!.row;}};
  for(const row of [{ref:'promoter',kind:'vendor'},{ref:'fan',kind:'customer'},...extra])h.add(row,row.kind);
  registerBlueprintTicketingRefs(input,h);validateBlueprintTicketing(input,h);return {h,refs,records,lines};
}

test('ticket blueprint shape preserves omitted fields and rejects unsupported economic authority and imprecise sources',()=>{
  assert.deepEqual(parse({}),{});assert.doesNotThrow(()=>z.toJSONSchema(schema,{target:'draft-7'}));
  for(const row of [event({status:'cancelled'}),event({id:'event-arena'}),event({starts_at:'2026-10-03T19:00:00Z'}),event({agreement_signed_at:'2026-02-30T09:00:00.000Z'})])assert.equal(schema.safeParse({ticket_events:[row]}).success,false);
  for(const row of [order({face_minor:0}),order({tax_minor:0.5}),order({fee_minor:-1}),order({quantity:0}),order({quantity:1.5}),order({total_minor:12400}),order({currency:'USD'}),order({beneficiary_id:'evil'})])assert.equal(schema.safeParse({ticket_orders:[row]}).success,false);
  for(const row of [payment({amount_minor:1e12+1}),payment({available_at:undefined}),payment({available_at:null}),payment({original_route:'card-forged'}),payment({outcome:'voided'}),payment({outcome:'voided',processor_fee_minor:0}),payment({processor_fee_minor:undefined})])assert.equal(schema.safeParse({ticket_payment_outcomes:[row]}).success,false);
  assert.equal(schema.safeParse({ticket_payment_outcomes:[{ref:'void',order_ref:'fan-order',source_payment_id:'VOID-1',outcome:'voided',amount_minor:12400,processor_fee_minor:0,occurred_at:payment().occurred_at}]}).success,true);
  for(const row of [payout({amount_minor:0}),payout({capture_refs:['fan-payment']}),payout({bank_balance_minor:10000}),payout({source_bank_transaction_id:'banktx_999999'}),payout({source_bank_transaction_id:'banktx-op_999999'}),payout({source_payout_id:' spaced '})])assert.equal(schema.safeParse({processor_payouts:[row]}).success,false);
  assert.equal(schema.safeParse({processor_topups:[topup({account_id:'another-bank'})]}).success,false);
  assert.equal(schema.safeParse({ticket_cancellations:[cancellation({refunds:true})]}).success,false);
  for(const id of ['order_000999','pi_000999','card_000999','txn_000999','event_000999'])assert.equal(schema.safeParse({ticket_payment_outcomes:[payment({source_payment_id:id})]}).success,false);
});

test('ticket blueprint registration uses global aliases and the shared source budget without inventing line records',()=>{
  const input=sources(),v=validate(input);assert.equal(v.records,8);assert.equal(v.lines,0);
  assert.deepEqual([...v.refs.entries()].filter(([key])=>!['promoter','fan'].includes(key)).map(([key,row])=>[key,row.kind]),[['concert','event'],['fan-order','order'],['fan-payment','ticket_payment'],['processor-payout','processor_payout'],['processor-topup','processor_topup'],['concert-cancellation','ticket_cancellation']]);
  assert.throws(()=>validate(input,[{ref:'fan-payment',kind:'invoice'}]),(error:any)=>error.code==='duplicate_blueprint_ref');
  assert.throws(()=>validate(input,[],7),(error:any)=>error.code==='blueprint_too_large');
  for(const patch of [{ticket_events:[event({promoter_ref:'fan'})]},{ticket_orders:[order({customer_ref:'promoter'})]},{ticket_orders:[order({event_ref:'fan'})]},{ticket_payment_outcomes:[payment({order_ref:'concert'})]},{ticket_cancellations:[cancellation({event_ref:'missing'})]}])assert.throws(()=>validate(sources(patch)),(error:any)=>error.code==='invalid_blueprint_ref');
});

test('ticket blueprint chronology rejects impossible source order while permitting genuinely late outcomes and future availability',()=>{
  for(const row of [event({agreement_signed_at:'2026-10-01T09:00:00.001Z'}),event({starts_at:opening})])assert.throws(()=>validate(sources({ticket_events:[row]})),(error:any)=>error.code==='invalid_blueprint_ticket_time');
  for(const row of [order({ordered_at:'2026-10-01T08:59:59.999Z'}),order({ordered_at:'2026-10-01T12:00:00.001Z'}),order({ordered_at:cancellation().cancelled_at})])assert.throws(()=>validate(sources({ticket_orders:[row]})),(error:any)=>error.code==='invalid_blueprint_ticket_time');
  assert.throws(()=>validate(sources({ticket_events:[event({starts_at:order().ordered_at})]})),(error:any)=>error.code==='invalid_blueprint_ticket_time');
  for(const row of [payment({occurred_at:'2026-10-01T09:29:59.999Z'}),payment({occurred_at:'2026-10-01T12:00:00.001Z',available_at:'2026-10-02T12:00:00.000Z'})])assert.throws(()=>validate(sources({ticket_payment_outcomes:[row]})),(error:any)=>error.code==='invalid_blueprint_ticket_time');
  assert.throws(()=>validate(sources({ticket_payment_outcomes:[payment({available_at:'2026-10-01T09:59:59.999Z'})]})),(error:any)=>error.code==='invalid_blueprint_ticket_capture');
  assert.doesNotThrow(()=>validate(sources({ticket_cancellations:[cancellation({cancelled_at:'2026-10-01T09:45:00.000Z'})],ticket_payment_outcomes:[payment({available_at:'2026-11-01T10:00:00.000Z'})]})));
  for(const patch of [{processor_payouts:[payout({paid_at:'2026-10-01T12:00:00.001Z'})]},{processor_topups:[topup({posted_at:'2026-10-01T08:59:59.999Z'})]},{ticket_cancellations:[cancellation({cancelled_at:'2026-10-01T12:00:00.001Z'})]}])assert.throws(()=>validate(sources(patch)),(error:any)=>error.code==='invalid_blueprint_ticket_time');
});

test('ticket blueprint exact arithmetic treats components as whole-order totals and requires one full payment outcome',()=>{
  assert.doesNotThrow(()=>validate(sources({ticket_orders:[order({quantity:1e6})]})),'Quantity does not multiply the recorded monetary components');
  assert.doesNotThrow(()=>validate(sources({ticket_orders:[order({face_minor:999999999998,tax_minor:1,fee_minor:1})],ticket_payment_outcomes:[payment({amount_minor:1e12,processor_fee_minor:1e12})]})));
  assert.throws(()=>validate(sources({ticket_orders:[order({face_minor:1e12,tax_minor:1,fee_minor:0})]})),(error:any)=>error.code==='blueprint_ticket_amount_exceeded');
  for(const amount_minor of [12401,12399])assert.throws(()=>validate(sources({ticket_payment_outcomes:[payment({amount_minor})]})),(error:any)=>error.code==='blueprint_ticket_payment_mismatch');
  assert.throws(()=>validate(sources({ticket_payment_outcomes:[payment({processor_fee_minor:12401})]})),(error:any)=>error.code==='invalid_blueprint_ticket_capture');
  assert.throws(()=>validate(sources({ticket_payment_outcomes:[payment(),payment({ref:'second-outcome',source_payment_id:'SECOND-CAPTURE'})]})),(error:any)=>error.code==='duplicate_blueprint_ticket_payment');
});

test('ticket blueprint source identities cannot replay different orders, outcomes, cancellations or cross-rail bank cash',()=>{
  assert.throws(()=>validate(sources({ticket_orders:[order(),order({ref:'another-order'})]})),(error:any)=>error.code==='duplicate_blueprint_ticket_source');
  assert.throws(()=>validate(sources({ticket_orders:[order(),order({ref:'another-order',source_order_id:'ORDER-2'})],ticket_payment_outcomes:[payment(),payment({ref:'another-payment',order_ref:'another-order'})]})),(error:any)=>error.code==='duplicate_blueprint_ticket_source');
  assert.throws(()=>validate(sources({ticket_cancellations:[cancellation(),cancellation({ref:'repeat-notice',source_notice_id:'SECOND-NOTICE'})]})),(error:any)=>error.code==='duplicate_blueprint_ticket_cancellation');
  for(const patch of [{processor_payouts:[payout(),payout({ref:'another-payout',source_bank_transaction_id:'BANK-PAYOUT-2'})]},{processor_topups:[topup({source_bank_transaction_id:payout().source_bank_transaction_id})]},{processor_topups:[topup({source_topup_id:payout().source_payout_id})]}])assert.throws(()=>validate(sources(patch)),(error:any)=>error.code==='duplicate_blueprint_ticket_source');
  assert.throws(()=>validate({...sources(),bank_activities:[{ref:'bank-fact',source_transaction_id:payout().source_bank_transaction_id}]}),(error:any)=>error.code==='duplicate_blueprint_ticket_source');
  for(const patch of [{ticket_payment_outcomes:[payment({source_payment_id:order().source_order_id})]},{processor_topups:[topup({source_bank_transaction_id:payment().source_payment_id})]},{processor_payouts:[payout({source_bank_transaction_id:payout().source_payout_id})]},{ticket_cancellations:[cancellation({source_notice_id:topup().source_topup_id})]}])assert.throws(()=>validate(sources(patch)),(error:any)=>error.code==='duplicate_blueprint_ticket_source');
});

test('ticket blueprint materializer schedules only explicit source actions with resolved references and exact source timestamps',()=>{
  const input=sources(),pristine=structuredClone(input);validate(input);
  const w={now:opening} as World,refs:Record<string,{id:string;kind:string}>={promoter:{id:'vendor-canonical',kind:'vendor'},fan:{id:'customer-canonical',kind:'customer'}},calls:{at:string;ref:string;action:Action}[]=[],scheduled:{at:string;ref:string;run:()=>void;priority:number}[]=[];
  const keys:Record<string,string>={record_ticket_event:'event',record_ticket_order:'order',record_ticket_payment:'payment',record_processor_payout:'payout',record_processor_topup:'topup',record_ticket_cancellation:'cancellation'};
  const h:BlueprintMaterializationHooks={openingAt:opening,asOf,operator:{id:'operator',role:'operator'},reviewer:{id:'reviewer',role:'controller'},id(alias){assert.ok(refs[alias]);return refs[alias].id;},bind(alias,row,kind){assert.ok(row.id);refs[alias]={id:row.id,kind};return row;},source(alias,action){calls.push({at:w.now,ref:alias,action:structuredClone(action)});return {[keys[action.type!]]:{id:`canonical-${alias}`}};},perform(){throw Error('No operator work may be invented by ticket source construction');},schedule(at,ref,run,priority=20){scheduled.push({at,ref,run,priority});}};
  materializeBlueprintTicketing(w,input,h);assert.equal(w.now,opening);assert.equal(calls.length,1);assert.equal(calls[0].action.type,'record_ticket_event');assert.equal(calls[0].action.promoter_id,'vendor-canonical');assert.equal(scheduled.length,5);
  for(const step of scheduled.sort((a,b)=>a.at.localeCompare(b.at)||a.priority-b.priority)){w.now=step.at;step.run();}
  assert.deepEqual(calls.map(row=>row.action.type),['record_ticket_event','record_ticket_order','record_ticket_payment','record_processor_payout','record_processor_topup','record_ticket_cancellation']);
  assert.equal(calls[1].action.event_id,'canonical-concert');assert.equal(calls[1].action.customer_id,'customer-canonical');assert.equal(calls[2].action.order_id,'canonical-fan-order');assert.equal(calls[5].action.event_id,'canonical-concert');
  assert.deepEqual(calls.map(row=>row.at),[opening,order().ordered_at,payment().occurred_at,payout().paid_at,topup().posted_at,cancellation().cancelled_at]);
  assert.equal(calls[2].action.available_at,payment().available_at);assert.equal(calls[2].action.processor_fee_minor,400);assert.equal(calls[3].action.source_bank_transaction_id,'BANK-PAYOUT-1');assert.equal(refs['processor-payout'].kind,'processor_payout');assert.equal(refs['fan-payment'].kind,'ticket_payment');
  assert.ok(calls.every(row=>!('ref' in row.action)&&!('external_event_id' in row.action)),'Only the shared source hook supplies external event identities');assert.deepEqual(input,pristine);
  assert.throws(()=>materializeBlueprintTicketing(w,input,h),(error:any)=>error.code==='blueprint_ticket_clock_mismatch');
  w.now=opening;assert.throws(()=>scheduled[0].run(),(error:any)=>error.code==='blueprint_ticket_clock_mismatch');
});

const controller={id:'ticket-review-controller',role:'controller' as const},operator={id:'ticket-finance-operator',role:'operator' as const};
function configuration(sourcePatch:any={},blueprintPatch:any={},scenarioPatch:any={}){
  return {kind:'ticket-cancellation',name:'gram source tickets',startingCashMinor:100000,cancelEvent:false,approvalThresholdMinor:1000,
    blueprint:{version:1,opening_at:opening,as_of:asOf,vendors:[{ref:'promoter',name:'gram promoter',email:'ops@promoter.test'}],customers:[{ref:'fan',name:'Source ticket customer',email:'fan@audience.test'}],...sources(sourcePatch),...blueprintPatch},...scenarioPatch};
}
const build=(sourcePatch:any={},blueprintPatch:any={},scenarioPatch:any={},id='ticket-blueprint-world')=>createWorld(configuration(sourcePatch,blueprintPatch,scenarioPatch) as any,id);
const balance=(w:World,id:string)=>w.accounts.find(row=>row.id===id)!.balance_minor;
const bankCash=(w:World)=>w.bankTransactions.filter(row=>row.account_id==='cash-bank'&&row.status==='posted').reduce((sum,row)=>sum+row.amount_minor,0);

test('integrated ticket sources retain custom economics, genuine processor transfers and portable canonical identities',()=>{
  const input=configuration(),before=structuredClone(input),w=createWorld(input as any,'ticket-first'),other=createWorld(input as any,'ticket-second');
  assert.deepEqual({...w,id:'portable'},{...other,id:'portable'});assert.deepEqual(input,before);assert.equal(w.now,asOf);assert.equal(w.sourceMode,'blueprint');
  assert.equal(w.events.length,1);assert.equal(w.events[0].name,'gram autumn concert');assert.equal(w.events[0].starts_at,starts);assert.equal(w.events[0].status,'cancelled');assert.notEqual(w.events[0].id,'event-arena');
  assert.equal(w.orders.length,1);assert.equal(w.orders[0].quantity,2);assert.equal(w.orders[0].total_minor,12400);assert.equal(w.orders[0].face_minor,10000);assert.equal(w.orders[0].tax_minor,900);assert.equal(w.orders[0].fee_minor,1500);
  const paid=w.payments[0];assert.equal(paid.amount_minor,12400);assert.equal(paid.refundable_minor,10900);assert.equal(paid.processor_fee_minor,400);assert.equal(paid.cash_account_id,'cash-processor');assert.equal(paid.available_at,payment().available_at);assert.equal(paid.captured_at,payment().occurred_at);assert.equal(w.orders[0].payment_id,paid.id);
  assert.equal(bankCash(w),109000);assert.equal(balance(w,'cash-bank'),109000);assert.equal(balance(w,'cash-processor'),3000);assert.equal(balance(w,'ticket-liability'),-10900);assert.equal(balance(w,'revenue'),-1500);assert.equal(summarize(w).reconciliation.balanced,true);
  assert.equal(balance(w,'processor-fees'),400);
  assert.deepEqual(w.bankTransactions.map(row=>row.amount_minor),[100000,10000,-1000]);assert.equal(w.refunds.length,0);assert.equal(w.approvals.length,0);
  const refs=w.blueprintManifest.refs;assert.equal(refs.concert.id,w.events[0].id);assert.equal(refs['fan-order'].id,w.orders[0].id);assert.equal(refs['fan-payment'].id,paid.id);
  for(const alias of ['processor-payout','processor-topup']){const source=w[alias==='processor-payout'?'processorPayouts':'processorTopups'].find((row:any)=>row.id===refs[alias].id);assert.ok(source.receipt_id);const row=w.bankTransactions.find(row=>row.id===source.bank_transaction_id)!;assert.equal(row.receipt_id,source.receipt_id);assert.equal(row.source_transaction_id,source.source_bank_transaction_id);}
  assert.ok(w.documents.some(row=>row.event_id===w.events[0].id&&row.id===w.ticketCancellations[0].document_id));assert.ok(w.messages.some(row=>row.source_refs?.includes(w.ticketCancellations[0].document_id)));
  assert.deepEqual(w.generationHistory.filter((row:any)=>['record_ticket_event','record_ticket_order','record_ticket_payment','record_processor_payout','record_processor_topup','record_ticket_cancellation'].includes(row.action.type)).map((row:any)=>row.at),[opening,order().ordered_at,payment().occurred_at,payout().paid_at,topup().posted_at,cancellation().cancelled_at]);
});

test('integrated impossible processor funding rejects the complete source graph without rewriting amounts or input evidence',()=>{
  for(const [sourcePatch,scenarioPatch] of [
    [{processor_payouts:[payout({amount_minor:12001})]},{}],
    [{processor_topups:[topup({amount_minor:200000})]},{}],
    [{ticket_payment_outcomes:[payment({available_at:'2026-11-01T10:00:00.000Z'})]},{}],
    [{processor_payouts:[]}, {startingCashMinor:0}],
  ]){
    const input=configuration(sourcePatch,{},scenarioPatch),before=structuredClone(input);assert.throws(()=>createWorld(input as any,'impossible-ticket-source'),(error:any)=>error.code==='blueprint_source_rejected');assert.deepEqual(input,before);
  }
});

test('integrated ticket refunds require independent amount approval and settle from actual processor funds without another bank debit',()=>{
  const w=build(),cashBefore=structuredClone(w.bankTransactions),paid=w.payments[0];
  const requested=applyAction(w,{type:'refund',payment_id:paid.id,amount_minor:2000},operator).result;assert.equal(requested.status,'awaiting_approval');assert.equal(w.refunds.length,0);
  const before=structuredClone(w);assert.throws(()=>applyAction(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},{id:operator.id,role:'controller'}));assert.deepEqual(w,before);
  applyAction(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},controller);assert.equal(w.refunds[0].status,'pending');assert.equal(w.refunds[0].cash_account_id,'cash-processor');assert.deepEqual(w.bankTransactions,cashBefore);
  applyAction(w,{type:'advance_time',hours:1},controller);assert.equal(w.refunds[0].status,'succeeded');assert.equal(w.payments[0].amount_refunded_minor,2000);assert.equal(balance(w,'cash-processor'),1000);assert.equal(balance(w,'ticket-liability'),-8900);assert.deepEqual(w.bankTransactions,cashBefore);assert.equal(summarize(w).reconciliation.balanced,true);
  assert.equal(w.messages.filter(row=>row.direction==='outbound'&&row.source_refs?.includes(w.refunds[0].id)).length,1);
});

test('integrated captured or voided late outcomes preserve cancelled orders while unavailable captured funds remain unspendable',()=>{
  const late=build({processor_payouts:[],processor_topups:[],ticket_cancellations:[cancellation({cancelled_at:'2026-10-01T09:45:00.000Z'})]});assert.equal(late.orders[0].status,'cancelled');assert.equal(late.payments[0].status,'succeeded');assert.equal(balance(late,'cash-processor'),12000);assert.equal(bankCash(late),100000);
  const voided=build({processor_payouts:[],processor_topups:[],ticket_cancellations:[cancellation({cancelled_at:'2026-10-01T09:45:00.000Z'})],ticket_payment_outcomes:[{ref:'fan-payment',order_ref:'fan-order',source_payment_id:'VOID-1',outcome:'voided',amount_minor:12400,processor_fee_minor:0,occurred_at:payment().occurred_at}]});assert.equal(voided.orders[0].status,'cancelled');assert.equal(voided.payments[0].status,'voided');assert.equal(balance(voided,'cash-processor'),0);assert.equal(balance(voided,'ticket-liability'),0);assert.equal(voided.journals.length,1);assert.equal(voided.bankTransactions.length,1);
  assert.throws(()=>applyAction(voided,{type:'refund',payment_id:voided.payments[0].id},operator),(error:any)=>error.code==='not_captured');
  const future=build({processor_payouts:[],processor_topups:[],ticket_payment_outcomes:[payment({available_at:'2026-11-01T10:00:00.000Z'})]});assert.equal(future.payments[0].available_at,'2026-11-01T10:00:00.000Z');assert.equal(balance(future,'cash-processor'),12000);const before=structuredClone(future);assert.throws(()=>applyAction(future,{type:'refund',payment_id:future.payments[0].id,amount_minor:100},operator),(error:any)=>error.code==='insufficient_funds');assert.deepEqual(future,before);
});

test('integrated ticket source statements remain independent and closed-period journals recover once at their actual posting time',()=>{
  const statement={ref:'source-statement',source_statement_id:'TICKET-BANK-1',account_ref:'operating',currency:'USD',start_at:opening,end_at:'2026-10-01T11:45:00.000Z',opening_balance_minor:100000,closing_balance_minor:109000,lines:[{ref:'payout-line',source_line_id:'PAYOUT-LINE',posted_at:payout().paid_at,amount_minor:10000,source_refs:[{kind:'processor_payout',ref:'processor-payout'}]},{ref:'topup-line',source_line_id:'TOPUP-LINE',posted_at:topup().posted_at,amount_minor:-1000,source_refs:[{kind:'processor_topup',ref:'processor-topup'}]}]};
  const w=build({},{period_closed:true,bank_statements:[statement]});assert.equal(bankCash(w),109000);assert.equal(balance(w,'cash-bank'),100000);assert.equal(balance(w,'cash-processor'),0);assert.equal(w.journals.length,1);assert.equal(w.settledUnposted.length,3);assert.equal(w.bankStatements[0].status,'open');assert.equal(w.reconciliationMatches.length,0);
  assert.deepEqual(w.bankStatements[0].lines.map((row:any)=>row.source_refs),[['BANK-PAYOUT-1'],['BANK-TOPUP-1']]);
  for(const line of w.bankStatements[0].lines){const selected=w.bankTransactions.find(row=>line.source_refs.includes(row.source_transaction_id))!;applyAction(w,{type:'match_statement_line',statement_id:w.bankStatements[0].id,line_id:line.id,bank_transaction_ids:[selected.id]},operator);}
  assert.equal(applyAction(w,{type:'prepare_reconciliation',statement_id:w.bankStatements[0].id},operator).result.report.can_close,false);
  const cash=structuredClone(w.bankTransactions);applyAction(w,{type:'reopen_period'},controller);assert.equal(w.settledUnposted.length,0);assert.equal(balance(w,'cash-bank'),109000);assert.equal(balance(w,'cash-processor'),3000);assert.equal(w.journals.length,4);assert.ok(w.journals.slice(1).every(row=>row.posted_at===asOf));assert.deepEqual(w.bankTransactions,cash);
  const report=applyAction(w,{type:'prepare_reconciliation',statement_id:w.bankStatements[0].id},operator).result.report;assert.equal(report.can_close,true);assert.equal(report.timing_items.length,2);assert.equal(report.adjusted_difference_minor,0);
  const journalCount=w.journals.length;applyAction(w,{type:'advance_time',hours:1},controller);assert.equal(w.journals.length,journalCount);assert.deepEqual(w.bankTransactions,cash);
  const mismatch=structuredClone(statement);mismatch.closing_balance_minor=109001;mismatch.lines[0].amount_minor=10001;const disagreement=build({},{bank_statements:[mismatch]});assert.equal(disagreement.bankStatements[0].closing_balance_minor,109001);assert.equal(bankCash(disagreement),109000);assert.equal(disagreement.reconciliationReports.length,0);assert.throws(()=>applyAction(disagreement,{type:'match_statement_line',statement_id:disagreement.bankStatements[0].id,line_id:disagreement.bankStatements[0].lines[0].id,bank_transaction_ids:[disagreement.processorPayouts[0].bank_transaction_id]},operator));
});

import {test,expect} from 'bun:test';
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
  expect(parse({})).toStrictEqual({});expect(()=>z.toJSONSchema(schema,{target:'draft-7'})).not.toThrow();
  for(const row of [event({status:'cancelled'}),event({id:'event-arena'}),event({starts_at:'2026-10-03T19:00:00Z'}),event({agreement_signed_at:'2026-02-30T09:00:00.000Z'})])expect(schema.safeParse({ticket_events:[row]}).success).toBe(false);
  for(const row of [order({face_minor:0}),order({tax_minor:0.5}),order({fee_minor:-1}),order({quantity:0}),order({quantity:1.5}),order({total_minor:12400}),order({currency:'USD'}),order({beneficiary_id:'evil'})])expect(schema.safeParse({ticket_orders:[row]}).success).toBe(false);
  for(const row of [payment({amount_minor:1e12+1}),payment({available_at:undefined}),payment({available_at:null}),payment({original_route:'card-forged'}),payment({outcome:'voided'}),payment({outcome:'voided',processor_fee_minor:0}),payment({processor_fee_minor:undefined})])expect(schema.safeParse({ticket_payment_outcomes:[row]}).success).toBe(false);
  expect(schema.safeParse({ticket_payment_outcomes:[{ref:'void',order_ref:'fan-order',source_payment_id:'VOID-1',outcome:'voided',amount_minor:12400,processor_fee_minor:0,occurred_at:payment().occurred_at}]}).success).toBe(true);
  for(const row of [payout({amount_minor:0}),payout({capture_refs:['fan-payment']}),payout({bank_balance_minor:10000}),payout({source_bank_transaction_id:'banktx_999999'}),payout({source_bank_transaction_id:'banktx-op_999999'}),payout({source_payout_id:' spaced '})])expect(schema.safeParse({processor_payouts:[row]}).success).toBe(false);
  expect(schema.safeParse({processor_topups:[topup({account_id:'another-bank'})]}).success).toBe(false);
  expect(schema.safeParse({ticket_cancellations:[cancellation({refunds:true})]}).success).toBe(false);
  for(const id of ['order_000999','pi_000999','card_000999','txn_000999','event_000999'])expect(schema.safeParse({ticket_payment_outcomes:[payment({source_payment_id:id})]}).success).toBe(false);
});

test('ticket blueprint registration uses global aliases and the shared source budget without inventing line records',()=>{
  const input=sources(),v=validate(input);expect(v.records).toBe(8);expect(v.lines).toBe(0);
  expect([...v.refs.entries()].filter(([key])=>!['promoter','fan'].includes(key)).map(([key,row])=>[key,row.kind])).toStrictEqual([['concert','event'],['fan-order','order'],['fan-payment','ticket_payment'],['processor-payout','processor_payout'],['processor-topup','processor_topup'],['concert-cancellation','ticket_cancellation']]);
  expect(()=>validate(input,[{ref:'fan-payment',kind:'invoice'}])).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_ref');
  expect(()=>validate(input,[],7)).toThrowSatisfying((error:any)=>error.code==='blueprint_too_large');
  for(const patch of [{ticket_events:[event({promoter_ref:'fan'})]},{ticket_orders:[order({customer_ref:'promoter'})]},{ticket_orders:[order({event_ref:'fan'})]},{ticket_payment_outcomes:[payment({order_ref:'concert'})]},{ticket_cancellations:[cancellation({event_ref:'missing'})]}])expect(()=>validate(sources(patch))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ref');
});

test('ticket blueprint chronology rejects impossible source order while permitting genuinely late outcomes and future availability',()=>{
  for(const row of [event({agreement_signed_at:'2026-10-01T09:00:00.001Z'}),event({starts_at:opening})])expect(()=>validate(sources({ticket_events:[row]}))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ticket_time');
  for(const row of [order({ordered_at:'2026-10-01T08:59:59.999Z'}),order({ordered_at:'2026-10-01T12:00:00.001Z'}),order({ordered_at:cancellation().cancelled_at})])expect(()=>validate(sources({ticket_orders:[row]}))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ticket_time');
  expect(()=>validate(sources({ticket_events:[event({starts_at:order().ordered_at})]}))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ticket_time');
  for(const row of [payment({occurred_at:'2026-10-01T09:29:59.999Z'}),payment({occurred_at:'2026-10-01T12:00:00.001Z',available_at:'2026-10-02T12:00:00.000Z'})])expect(()=>validate(sources({ticket_payment_outcomes:[row]}))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ticket_time');
  expect(()=>validate(sources({ticket_payment_outcomes:[payment({available_at:'2026-10-01T09:59:59.999Z'})]}))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ticket_capture');
  expect(()=>validate(sources({ticket_cancellations:[cancellation({cancelled_at:'2026-10-01T09:45:00.000Z'})],ticket_payment_outcomes:[payment({available_at:'2026-11-01T10:00:00.000Z'})]}))).not.toThrow();
  for(const patch of [{processor_payouts:[payout({paid_at:'2026-10-01T12:00:00.001Z'})]},{processor_topups:[topup({posted_at:'2026-10-01T08:59:59.999Z'})]},{ticket_cancellations:[cancellation({cancelled_at:'2026-10-01T12:00:00.001Z'})]}])expect(()=>validate(sources(patch))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ticket_time');
});

test('ticket blueprint exact arithmetic treats components as whole-order totals and requires one full payment outcome',()=>{
  expect(()=>validate(sources({ticket_orders:[order({quantity:1e6})]})),'Quantity does not multiply the recorded monetary components').not.toThrow();
  expect(()=>validate(sources({ticket_orders:[order({face_minor:999999999998,tax_minor:1,fee_minor:1})],ticket_payment_outcomes:[payment({amount_minor:1e12,processor_fee_minor:1e12})]}))).not.toThrow();
  expect(()=>validate(sources({ticket_orders:[order({face_minor:1e12,tax_minor:1,fee_minor:0})]}))).toThrowSatisfying((error:any)=>error.code==='blueprint_ticket_amount_exceeded');
  for(const amount_minor of [12401,12399])expect(()=>validate(sources({ticket_payment_outcomes:[payment({amount_minor})]}))).toThrowSatisfying((error:any)=>error.code==='blueprint_ticket_payment_mismatch');
  expect(()=>validate(sources({ticket_payment_outcomes:[payment({processor_fee_minor:12401})]}))).toThrowSatisfying((error:any)=>error.code==='invalid_blueprint_ticket_capture');
  expect(()=>validate(sources({ticket_payment_outcomes:[payment(),payment({ref:'second-outcome',source_payment_id:'SECOND-CAPTURE'})]}))).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_ticket_payment');
});

test('ticket blueprint source identities cannot replay different orders, outcomes, cancellations or cross-rail bank cash',()=>{
  expect(()=>validate(sources({ticket_orders:[order(),order({ref:'another-order'})]}))).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_ticket_source');
  expect(()=>validate(sources({ticket_orders:[order(),order({ref:'another-order',source_order_id:'ORDER-2'})],ticket_payment_outcomes:[payment(),payment({ref:'another-payment',order_ref:'another-order'})]}))).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_ticket_source');
  expect(()=>validate(sources({ticket_cancellations:[cancellation(),cancellation({ref:'repeat-notice',source_notice_id:'SECOND-NOTICE'})]}))).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_ticket_cancellation');
  for(const patch of [{processor_payouts:[payout(),payout({ref:'another-payout',source_bank_transaction_id:'BANK-PAYOUT-2'})]},{processor_topups:[topup({source_bank_transaction_id:payout().source_bank_transaction_id})]},{processor_topups:[topup({source_topup_id:payout().source_payout_id})]}])expect(()=>validate(sources(patch))).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_ticket_source');
  expect(()=>validate({...sources(),bank_activities:[{ref:'bank-fact',source_transaction_id:payout().source_bank_transaction_id}]})).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_ticket_source');
  for(const patch of [{ticket_payment_outcomes:[payment({source_payment_id:order().source_order_id})]},{processor_topups:[topup({source_bank_transaction_id:payment().source_payment_id})]},{processor_payouts:[payout({source_bank_transaction_id:payout().source_payout_id})]},{ticket_cancellations:[cancellation({source_notice_id:topup().source_topup_id})]}])expect(()=>validate(sources(patch))).toThrowSatisfying((error:any)=>error.code==='duplicate_blueprint_ticket_source');
});

test('ticket blueprint materializer schedules only explicit source actions with resolved references and exact source timestamps',()=>{
  const input=sources(),pristine=structuredClone(input);validate(input);
  const w={now:opening} as World,refs:Record<string,{id:string;kind:string}>={promoter:{id:'vendor-canonical',kind:'vendor'},fan:{id:'customer-canonical',kind:'customer'}},calls:{at:string;ref:string;action:Action}[]=[],scheduled:{at:string;ref:string;run:()=>void;priority:number}[]=[];
  const keys:Record<string,string>={record_ticket_event:'event',record_ticket_order:'order',record_ticket_payment:'payment',record_processor_payout:'payout',record_processor_topup:'topup',record_ticket_cancellation:'cancellation'};
  const h:BlueprintMaterializationHooks={openingAt:opening,asOf,operator:{id:'operator',role:'operator'},reviewer:{id:'reviewer',role:'controller'},id(alias){expect(refs[alias]).toBeTruthy();return refs[alias].id;},bind(alias,row,kind){expect(row.id).toBeTruthy();refs[alias]={id:row.id,kind};return row;},source(alias,action){calls.push({at:w.now,ref:alias,action:structuredClone(action)});return {[keys[action.type!]]:{id:`canonical-${alias}`}};},perform(){throw Error('No operator work may be invented by ticket source construction');},schedule(at,ref,run,priority=20){scheduled.push({at,ref,run,priority});}};
  materializeBlueprintTicketing(w,input,h);expect(w.now).toBe(opening);expect(calls.length).toBe(1);expect(calls[0].action.type).toBe('record_ticket_event');expect(calls[0].action.promoter_id).toBe('vendor-canonical');expect(scheduled.length).toBe(5);
  for(const step of scheduled.sort((a,b)=>a.at.localeCompare(b.at)||a.priority-b.priority)){w.now=step.at;step.run();}
  expect(calls.map(row=>row.action.type)).toStrictEqual(['record_ticket_event','record_ticket_order','record_ticket_payment','record_processor_payout','record_processor_topup','record_ticket_cancellation']);
  expect(calls[1].action.event_id).toBe('canonical-concert');expect(calls[1].action.customer_id).toBe('customer-canonical');expect(calls[2].action.order_id).toBe('canonical-fan-order');expect(calls[5].action.event_id).toBe('canonical-concert');
  expect(calls.map(row=>row.at)).toStrictEqual([opening,order().ordered_at,payment().occurred_at,payout().paid_at,topup().posted_at,cancellation().cancelled_at]);
  expect(calls[2].action.available_at).toBe(payment().available_at);expect(calls[2].action.processor_fee_minor).toBe(400);expect(calls[3].action.source_bank_transaction_id).toBe('BANK-PAYOUT-1');expect(refs['processor-payout'].kind).toBe('processor_payout');expect(refs['fan-payment'].kind).toBe('ticket_payment');
  expect(calls.every(row=>!('ref' in row.action)&&!('external_event_id' in row.action)),'Only the shared source hook supplies external event identities').toBeTruthy();expect(input).toStrictEqual(pristine);
  expect(()=>materializeBlueprintTicketing(w,input,h)).toThrowSatisfying((error:any)=>error.code==='blueprint_ticket_clock_mismatch');
  w.now=opening;expect(()=>scheduled[0].run()).toThrowSatisfying((error:any)=>error.code==='blueprint_ticket_clock_mismatch');
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
  expect({...w,id:'portable'}).toStrictEqual({...other,id:'portable'});expect(input).toStrictEqual(before);expect(w.now).toBe(asOf);expect(w.sourceMode).toBe('blueprint');
  expect(w.events.length).toBe(1);expect(w.events[0].name).toBe('gram autumn concert');expect(w.events[0].starts_at).toBe(starts);expect(w.events[0].status).toBe('cancelled');expect(w.events[0].id).not.toBe('event-arena');
  expect(w.orders.length).toBe(1);expect(w.orders[0].quantity).toBe(2);expect(w.orders[0].total_minor).toBe(12400);expect(w.orders[0].face_minor).toBe(10000);expect(w.orders[0].tax_minor).toBe(900);expect(w.orders[0].fee_minor).toBe(1500);
  const paid=w.payments[0];expect(paid.amount_minor).toBe(12400);expect(paid.refundable_minor).toBe(10900);expect(paid.processor_fee_minor).toBe(400);expect(paid.cash_account_id).toBe('cash-processor');expect(paid.available_at).toBe(payment().available_at);expect(paid.captured_at).toBe(payment().occurred_at);expect(w.orders[0].payment_id).toBe(paid.id);
  expect(bankCash(w)).toBe(109000);expect(balance(w,'cash-bank')).toBe(109000);expect(balance(w,'cash-processor')).toBe(3000);expect(balance(w,'ticket-liability')).toBe(-10900);expect(balance(w,'revenue')).toBe(-1500);expect(summarize(w).reconciliation.balanced).toBe(true);
  expect(balance(w,'processor-fees')).toBe(400);
  expect(w.bankTransactions.map(row=>row.amount_minor)).toStrictEqual([100000,10000,-1000]);expect(w.refunds.length).toBe(0);expect(w.approvals.length).toBe(0);
  const refs=w.blueprintManifest.refs;expect(refs.concert.id).toBe(w.events[0].id);expect(refs['fan-order'].id).toBe(w.orders[0].id);expect(refs['fan-payment'].id).toBe(paid.id);
  for(const alias of ['processor-payout','processor-topup']){const source=w[alias==='processor-payout'?'processorPayouts':'processorTopups'].find((row:any)=>row.id===refs[alias].id);expect(source.receipt_id).toBeTruthy();const row=w.bankTransactions.find(row=>row.id===source.bank_transaction_id)!;expect(row.receipt_id).toBe(source.receipt_id);expect(row.source_transaction_id).toBe(source.source_bank_transaction_id);}
  expect(w.documents.some(row=>row.event_id===w.events[0].id&&row.id===w.ticketCancellations[0].document_id)).toBeTruthy();expect(w.messages.some(row=>row.source_refs?.includes(w.ticketCancellations[0].document_id))).toBeTruthy();
  expect(w.generationHistory.filter((row:any)=>['record_ticket_event','record_ticket_order','record_ticket_payment','record_processor_payout','record_processor_topup','record_ticket_cancellation'].includes(row.action.type)).map((row:any)=>row.at)).toStrictEqual([opening,order().ordered_at,payment().occurred_at,payout().paid_at,topup().posted_at,cancellation().cancelled_at]);
});

test('integrated impossible processor funding rejects the complete source graph without rewriting amounts or input evidence',()=>{
  for(const [sourcePatch,scenarioPatch] of [
    [{processor_payouts:[payout({amount_minor:12001})]},{}],
    [{processor_topups:[topup({amount_minor:200000})]},{}],
    [{ticket_payment_outcomes:[payment({available_at:'2026-11-01T10:00:00.000Z'})]},{}],
    [{processor_payouts:[]}, {startingCashMinor:0}],
  ]){
    const input=configuration(sourcePatch,{},scenarioPatch),before=structuredClone(input);expect(()=>createWorld(input as any,'impossible-ticket-source')).toThrowSatisfying((error:any)=>error.code==='blueprint_source_rejected');expect(input).toStrictEqual(before);
  }
});

test('integrated ticket refunds require independent amount approval and settle from actual processor funds without another bank debit',()=>{
  const w=build(),cashBefore=structuredClone(w.bankTransactions),paid=w.payments[0];
  const requested=applyAction(w,{type:'refund',payment_id:paid.id,amount_minor:2000},operator).result;expect(requested.status).toBe('awaiting_approval');expect(w.refunds.length).toBe(0);
  const before=structuredClone(w);expect(()=>applyAction(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},{id:operator.id,role:'controller'})).toThrow();expect(w).toStrictEqual(before);
  applyAction(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},controller);expect(w.refunds[0].status).toBe('pending');expect(w.refunds[0].cash_account_id).toBe('cash-processor');expect(w.bankTransactions).toStrictEqual(cashBefore);
  applyAction(w,{type:'advance_time',hours:1},controller);expect(w.refunds[0].status).toBe('succeeded');expect(w.payments[0].amount_refunded_minor).toBe(2000);expect(balance(w,'cash-processor')).toBe(1000);expect(balance(w,'ticket-liability')).toBe(-8900);expect(w.bankTransactions).toStrictEqual(cashBefore);expect(summarize(w).reconciliation.balanced).toBe(true);
  expect(w.messages.filter(row=>row.direction==='outbound'&&row.source_refs?.includes(w.refunds[0].id)).length).toBe(1);
});

test('integrated captured or voided late outcomes preserve cancelled orders while unavailable captured funds remain unspendable',()=>{
  const late=build({processor_payouts:[],processor_topups:[],ticket_cancellations:[cancellation({cancelled_at:'2026-10-01T09:45:00.000Z'})]});expect(late.orders[0].status).toBe('cancelled');expect(late.payments[0].status).toBe('succeeded');expect(balance(late,'cash-processor')).toBe(12000);expect(bankCash(late)).toBe(100000);
  const voided=build({processor_payouts:[],processor_topups:[],ticket_cancellations:[cancellation({cancelled_at:'2026-10-01T09:45:00.000Z'})],ticket_payment_outcomes:[{ref:'fan-payment',order_ref:'fan-order',source_payment_id:'VOID-1',outcome:'voided',amount_minor:12400,processor_fee_minor:0,occurred_at:payment().occurred_at}]});expect(voided.orders[0].status).toBe('cancelled');expect(voided.payments[0].status).toBe('voided');expect(balance(voided,'cash-processor')).toBe(0);expect(balance(voided,'ticket-liability')).toBe(0);expect(voided.journals.length).toBe(1);expect(voided.bankTransactions.length).toBe(1);
  expect(()=>applyAction(voided,{type:'refund',payment_id:voided.payments[0].id},operator)).toThrowSatisfying((error:any)=>error.code==='not_captured');
  const future=build({processor_payouts:[],processor_topups:[],ticket_payment_outcomes:[payment({available_at:'2026-11-01T10:00:00.000Z'})]});expect(future.payments[0].available_at).toBe('2026-11-01T10:00:00.000Z');expect(balance(future,'cash-processor')).toBe(12000);const before=structuredClone(future);expect(()=>applyAction(future,{type:'refund',payment_id:future.payments[0].id,amount_minor:100},operator)).toThrowSatisfying((error:any)=>error.code==='insufficient_funds');expect(future).toStrictEqual(before);
});

test('integrated ticket source statements remain independent and closed-period journals recover once at their actual posting time',()=>{
  const statement={ref:'source-statement',source_statement_id:'TICKET-BANK-1',account_ref:'operating',currency:'USD',start_at:opening,end_at:'2026-10-01T11:45:00.000Z',opening_balance_minor:100000,closing_balance_minor:109000,lines:[{ref:'payout-line',source_line_id:'PAYOUT-LINE',posted_at:payout().paid_at,amount_minor:10000,source_refs:[{kind:'processor_payout',ref:'processor-payout'}]},{ref:'topup-line',source_line_id:'TOPUP-LINE',posted_at:topup().posted_at,amount_minor:-1000,source_refs:[{kind:'processor_topup',ref:'processor-topup'}]}]};
  const w=build({},{period_closed:true,bank_statements:[statement]});expect(bankCash(w)).toBe(109000);expect(balance(w,'cash-bank')).toBe(100000);expect(balance(w,'cash-processor')).toBe(0);expect(w.journals.length).toBe(1);expect(w.settledUnposted.length).toBe(3);expect(w.bankStatements[0].status).toBe('open');expect(w.reconciliationMatches.length).toBe(0);
  expect(w.bankStatements[0].lines.map((row:any)=>row.source_refs)).toStrictEqual([['BANK-PAYOUT-1'],['BANK-TOPUP-1']]);
  for(const line of w.bankStatements[0].lines){const selected=w.bankTransactions.find(row=>line.source_refs.includes(row.source_transaction_id))!;applyAction(w,{type:'match_statement_line',statement_id:w.bankStatements[0].id,line_id:line.id,bank_transaction_ids:[selected.id]},operator);}
  expect(applyAction(w,{type:'prepare_reconciliation',statement_id:w.bankStatements[0].id},operator).result.report.can_close).toBe(false);
  const cash=structuredClone(w.bankTransactions);applyAction(w,{type:'reopen_period'},controller);expect(w.settledUnposted.length).toBe(0);expect(balance(w,'cash-bank')).toBe(109000);expect(balance(w,'cash-processor')).toBe(3000);expect(w.journals.length).toBe(4);expect(w.journals.slice(1).every(row=>row.posted_at===asOf)).toBeTruthy();expect(w.bankTransactions).toStrictEqual(cash);
  const report=applyAction(w,{type:'prepare_reconciliation',statement_id:w.bankStatements[0].id},operator).result.report;expect(report.can_close).toBe(true);expect(report.timing_items.length).toBe(2);expect(report.adjusted_difference_minor).toBe(0);
  const journalCount=w.journals.length;applyAction(w,{type:'advance_time',hours:1},controller);expect(w.journals.length).toBe(journalCount);expect(w.bankTransactions).toStrictEqual(cash);
  const mismatch=structuredClone(statement);mismatch.closing_balance_minor=109001;mismatch.lines[0].amount_minor=10001;const disagreement=build({},{bank_statements:[mismatch]});expect(disagreement.bankStatements[0].closing_balance_minor).toBe(109001);expect(bankCash(disagreement)).toBe(109000);expect(disagreement.reconciliationReports.length).toBe(0);expect(()=>applyAction(disagreement,{type:'match_statement_line',statement_id:disagreement.bankStatements[0].id,line_id:disagreement.bankStatements[0].lines[0].id,bank_transaction_ids:[disagreement.processorPayouts[0].bank_transaction_id]},operator)).toThrow();
});

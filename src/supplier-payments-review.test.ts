import {test,expect} from 'bun:test';
import {applyAction,createWorld,summarize,type World} from './world.ts';
import {providerMercury} from './provider-mercury.ts';
import {blueprintSchema} from './blueprint.ts';

const operator={id:'first-native-operator',role:'operator'} as const,other={id:'second-native-operator',role:'operator'} as const,controller={id:'independent-review-controller',role:'controller'} as const;
const fresh=()=>createWorld({kind:'supplier-fraud',orderCount:2,startingCashMinor:1000000,approvalThresholdMinor:1e12,seed:97});
const act=(w:World,action:any,actor:any=controller)=>applyAction(w,action,actor).result;
const economics=(w:World)=>structuredClone({bank:w.bankTransactions,accounts:w.accounts,journals:w.journals,bills:w.bills});
const outcome=(id:string,ref:string)=>({type:'cancel_bill_payment',operation_id:id,bank_reference:ref,reason:'Bank confirms cancellation of exactly this unsettled instruction',external_event_id:ref});
const request=(w:World,key:string,amount=1000)=>({type:'request_bill_payment',bill_id:w.bills[0].id,recipient_id:w.vendors[0].id,amount_minor:amount,payment_method:'ach',idempotency_key:key,note:'Pay original approved source'});
const nativeBody=(w:World,key:string,amount=1000)=>({recipientId:w.vendors[0].id,amount:amount/100,paymentMethod:'ach',idempotencyKey:key,note:'Pay original approved source',finance_world:{bill_id:w.bills[0].id}});
async function native(w:World,route:string,method='GET',input?:any,actor:any=operator){const url=new URL(route,'http://local.test');return providerMercury({world:w,system:'mercury',route:url.pathname,url,method,input,execute:action=>act(w,action,actor)});}
const approve=(w:World,id:string)=>act(w,{type:'decide_approval',approval_id:id,decision:'approve'});
function verify(w:World,suffix:string){return act(w,{type:'record_supplier_route',vendor_id:w.vendors[0].id,previous_route_id:w.vendors[0].verified_bank_account,verification_reference:'verified-'+suffix,verified_at:w.now,verification_method:'bank_portal',destination_reference:'synthetic-destination-'+suffix,reason:'Independent bank verification after original route failure',external_event_id:'verified-'+suffix});}
function unchangedFailure(w:World,action:any,code:string,actor:any=controller){const before=structuredClone(w);expect(()=>act(w,action,actor)).toThrowSatisfying((e:any)=>e.code===code);expect(w).toStrictEqual(before);}

test('new accepted payment IDs reserve the real bank namespace without creating cash rows, and external facts cannot impersonate them',()=>{
  const w=fresh(),op=act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:1000},operator).operation;
  expect(op.bank_transaction_id).toMatch(/^banktx_\d+$/);expect(!w.bankTransactions.some(row=>row.id===op.bank_transaction_id)).toBeTruthy();
  for(const source of [op.bank_transaction_id,`banktx-${op.id}`]){
    unchangedFailure(w,{type:'record_bank_activity',source_transaction_id:source,account_id:'cash-bank',currency:'USD',kind:'fee',amount_minor:1,posted_at:w.now,description:'Impersonated pending instruction',external_event_id:'external-'+source},'duplicate_bank_activity_source');
    expect(blueprintSchema.safeParse({version:1,opening_at:w.now,bank_activities:[{ref:'bad-source',source_transaction_id:source,account_ref:'operating',currency:'USD',kind:'fee',amount_minor:1,posted_at:w.now,description:'Reserved source'}]}).success).toBe(false);
  }
  act(w,{type:'advance_time',hours:1});const bank=w.bankTransactions.find(row=>row.source_id===op.id);expect(bank.id).toBe(op.bank_transaction_id);expect(bank.amount_minor).toBe(-1000);expect(w.bankTransactions.filter(row=>row.id===op.bank_transaction_id).length).toBe(1);
});

test('old persisted source-alias collision blocks settlement with reservation retained and recovers only through cancellation and a new unique instruction',async()=>{
  const w=fresh(),payment=act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:1000},operator).operation;
  const observed=act(w,{type:'record_bank_activity',source_transaction_id:'OLD-EXTERNAL-FEE',account_id:'cash-bank',currency:'USD',kind:'fee',amount_minor:1,posted_at:w.now,description:'Original independently observed cash',external_event_id:'legacy-fee'});
  // This exact alias was accepted by the old source guard. Model a persisted
  // pre-upgrade snapshot; no current public source action may create it.
  const fallback=`banktx-${payment.id}`,pending=w.operations.find(row=>row.id===payment.id),activity=w.bankActivities.find((row:any)=>row.id===observed.bank_activity.id),bank=w.bankTransactions.find(row=>row.id===activity.bank_transaction_id),observedOp=w.operations.find(row=>row.id===activity.operation_id);
  delete pending.bank_transaction_id;delete pending.supplier_route;activity.source_transaction_id=fallback;bank.source_transaction_id=fallback;observedOp.source_transaction_id=fallback;
  const before=economics(w);act(w,{type:'advance_time',hours:1});expect(economics(w)).toStrictEqual(before);expect(w.operations.find(row=>row.id===pending.id).last_error).toBe('bank_transaction_identity_conflict');expect(w.operations.find(row=>row.id===pending.id).status).toBe('pending');expect(summarize(w).reserved_minor).toBe(1000);
  const cancelled=act(w,outcome(pending.id,'BANK-LEGACY-CANCELLATION'));expect(cancelled.operation.status).toBe('cancelled');expect(economics(w)).toStrictEqual(before);expect(summarize(w).reserved_minor).toBe(0);
  const replacement=act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:1000},operator);expect(replacement.status).toBe('awaiting_approval');const accepted=approve(w,replacement.approval_id).operation;expect(accepted.bank_transaction_id).not.toBe(fallback);expect(accepted.bank_transaction_id).toMatch(/^banktx_\d+$/);
  act(w,{type:'advance_time',hours:1});expect(w.bills[0].amount_paid_minor).toBe(1000);expect(w.bankTransactions.filter(row=>row.source_id===accepted.id).length).toBe(1);expect(w.bankTransactions.filter(row=>row.source_id===pending.id).length).toBe(0);
  const oldNative=await native(w,`/api/v1/transaction/${fallback}`);expect(oldNative!.body.status).toBe('cancelled');expect(oldNative!.body.finance_world.bank_transaction_id).toBeNull();expect(oldNative!.body.finance_world.receipt_id).toBeNull();
});

test('native body-key identity is world-wide across actors and remains attached to rejected approval history until a genuinely new request',async()=>{
  const w=fresh(),initial=economics(w),body=nativeBody(w,'cross-actor-key'),first=(await native(w,'/api/v1/account/cash-bank/request-send-money','POST',body))!.body;
  expect(first.status).toBe('pendingApproval');expect(first.numberOfApproversRequired).toBe(1);expect(first.requesterMayApprove).toBe(false);expect(w.approvals.length).toBe(1);expect(w.billPaymentRequests.length).toBe(1);expect(economics(w)).toStrictEqual(initial);expect(w.operations.length).toBe(0);
  const replay=(await native(w,'/api/v1/account/cash-bank/request-send-money','POST',body,other))!.body;expect(replay.requestId).toBe(first.requestId);expect(replay.requestedByUserId).toBe(operator.id);expect(w.approvals.length).toBe(1);expect(w.billPaymentRequests.length).toBe(1);
  unchangedFailure(w,{...request(w,'cross-actor-key'),amount_minor:1001},'bank_request_idempotency_conflict',other);
  act(w,{type:'decide_approval',approval_id:first.requestId,decision:'reject'});const rejected=(await native(w,'/api/v1/account/cash-bank/request-send-money','POST',body,other))!.body;expect(rejected.status).toBe('rejected');expect(rejected.requestId).toBe(first.requestId);expect(w.operations.length).toBe(0);expect(w.approvals.length).toBe(1);
  const freshRequest=(await native(w,'/api/v1/account/cash-bank/request-send-money','POST',nativeBody(w,'new-reviewed-key'),other))!.body;expect(freshRequest.requestId).not.toBe(first.requestId);expect(freshRequest.requestedByUserId).toBe(other.id);expect(freshRequest.status).toBe('pendingApproval');expect(w.approvals.length).toBe(2);
  const accepted=approve(w,freshRequest.requestId).operation;const seen=(await native(w,`/api/v1/transaction/${accepted.bank_transaction_id}`))!.body;expect(seen.status).toBe('pending');expect(seen.finance_world.bank_transaction_id).toBeNull();expect(seen.finance_world.bank_cash_effect_minor).toBe(0);expect(summarize(w).reserved_minor).toBe(1000);
});

test('approved native requests retain one stable transaction through outage, deferred posting, and cross-actor body-key replay',async()=>{
  const w=fresh(),body=nativeBody(w,'stable-request'),created=(await native(w,'/api/v1/account/cash-bank/request-send-money','POST',body))!.body,accepted=approve(w,created.requestId).operation,id=accepted.bank_transaction_id,initial=economics(w);
  act(w,{type:'set_fault',system:'bank',mode:'offline'});act(w,{type:'close_period'});act(w,{type:'advance_time',hours:1});expect(economics(w)).toStrictEqual(initial);expect(w.operations.find(row=>row.id===accepted.id).status).toBe('pending');
  const repeated=(await native(w,'/api/v1/account/cash-bank/request-send-money','POST',body,other))!.body;expect(repeated.requestId).toBe(created.requestId);expect(repeated.status).toBe('approved');expect(repeated.finance_world.instruction.canonical_status).toBe('pending');expect(w.operations.filter(row=>row.type==='pay_bill').length).toBe(1);expect(w.approvals.length).toBe(1);
  act(w,{type:'set_fault',system:'bank',mode:'healthy'});act(w,{type:'advance_time',hours:1});const sent=(await native(w,`/api/v1/transaction/${id}`))!.body;expect(sent.id).toBe(id);expect(sent.status).toBe('sent');expect(sent.finance_world.bank_transaction_id).toBe(id);expect(sent.finance_world.receipt_id).toBeTruthy();expect(sent.finance_world.journal_id).toBeNull();expect(sent.finance_world.bank_cash_effect_minor).toBe(-1000);expect(summarize(w).reserved_minor).toBe(0);
  const settledBank=structuredClone(w.bankTransactions);act(w,{type:'reopen_period'});const posted=(await native(w,`/api/v1/transaction/${id}`))!.body;expect(posted.id).toBe(id);expect(posted.finance_world.journal_id).toBeTruthy();expect(w.bankTransactions).toStrictEqual(settledBank);
  await native(w,'/api/v1/account/cash-bank/request-send-money','POST',body,other);act(w,{type:'advance_time',hours:1});expect(w.operations.filter(row=>row.type==='pay_bill').length).toBe(1);expect(w.bankTransactions.filter(row=>row.source_id===accepted.id).length).toBe(1);expect(w.journals.filter(row=>row.source_id===accepted.id).length).toBe(1);
});

test('native request replay preserves stale source binding, and only a new independent approval can accept a verified successor',async()=>{
  const w=fresh(),body=nativeBody(w,'before-successor'),old=(await native(w,'/api/v1/account/cash-bank/request-send-money','POST',body))!.body,oldRoute=old.finance_world.supplier_route.beneficiary_id,sourceBill=structuredClone(w.bills[0]);
  const successor=verify(w,'successor').route;const replay=(await native(w,'/api/v1/account/cash-bank/request-send-money','POST',body,other))!.body;expect(replay.requestId).toBe(old.requestId);expect(replay.finance_world.supplier_route.beneficiary_id).toBe(oldRoute);expect(w.bills[0]).toStrictEqual(sourceBill);
  unchangedFailure(w,{type:'decide_approval',approval_id:old.requestId,decision:'approve'},'unverified_beneficiary');act(w,{type:'decide_approval',approval_id:old.requestId,decision:'reject'});
  const replacement=(await native(w,'/api/v1/account/cash-bank/request-send-money','POST',nativeBody(w,'after-successor'),other))!.body;expect(replacement.requestId).not.toBe(old.requestId);expect(replacement.finance_world.supplier_route.beneficiary_id).toBe(successor.id);expect(replacement.finance_world.supplier_route.requires_independent_approval).toBe(true);
  unchangedFailure(w,{type:'decide_approval',approval_id:replacement.requestId,decision:'approve'},'separate_controller_required',{id:other.id,role:'controller'});const operation=approve(w,replacement.requestId).operation;act(w,{type:'advance_time',hours:1});expect(w.operations.find(row=>row.id===operation.id).status).toBe('settled');expect(w.operations.find(row=>row.id===operation.id).supplier_route.beneficiary_id).toBe(successor.id);expect(w.bills[0].beneficiary_id).toBe(oldRoute);
});

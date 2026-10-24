import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {applyAction,createWorld,DomainError,summarize,type World} from './world.ts';
import {resolveSupplierPaymentRoute,validateSupplierPaymentBinding,supplierPaymentOperationRoute,type SupplierPaymentHooks} from './supplier-payments.ts';

const operator={id:'supplier-operator',role:'operator'} as const;
const controller={id:'supplier-controller',role:'controller'} as const;
const reviewer={id:'supplier-independent-reviewer',role:'controller'} as const;
const fresh=(threshold=1e12)=>createWorld({kind:'supplier-fraud',orderCount:2,startingCashMinor:1000000,approvalThresholdMinor:threshold,seed:37});
const act=(w:World,action:any,actor:any=controller)=>applyAction(w,action,actor).result;
const readHooks:SupplierPaymentHooks={id:()=>{throw new Error('Read must not allocate');},document:()=>{throw new Error('Read must not create documents');},emit:()=>{throw new Error('Read must not emit');},fail:(code,message,status=400)=>{throw new DomainError(status,code,message);}};
const economics=(w:World)=>structuredClone({accounts:w.accounts,bank:w.bankTransactions,journals:w.journals,bills:w.bills,contracts:w.contracts,payments:w.payments});
const heldError=(error:any)=>error.code==='supplier_route_on_hold'||error.code==='supplier_payment_source_changed';
function fails(w:World,action:any,code?:string,actor:any=controller){const before=structuredClone(w);assert.throws(()=>act(w,action,actor),(error:any)=>!code||error.code===code,JSON.stringify(action));assert.deepEqual(w,before);}
function verify(w:World,suffix='one',vendor=w.vendors[0]){return act(w,{type:'record_supplier_route',vendor_id:vendor.id,previous_route_id:vendor.verified_bank_account,verification_reference:`callback-${suffix}`,verified_at:w.now,verification_method:'callback_on_file',destination_reference:`synthetic-account-${suffix}`,reason:'Independent treasury callback using the original contact on file',external_event_id:`verified-route-${suffix}`});}
function pay(w:World,amount=1000,bill=w.bills[0],actor:any=operator){return act(w,{type:'pay_bill',bill_id:bill.id,amount_minor:amount},actor);}
function approve(w:World,result:any,actor:any=reviewer){return act(w,{type:'decide_approval',approval_id:result.approval_id,decision:'approve'},actor);}
const tick=(w:World)=>act(w,{type:'advance_time',hours:1});
function returned(w:World,operation:any,amount=500,event='return-one'){return act(w,{type:'return_bill_payment',operation_id:operation.id,amount_minor:amount,reason:'Bank reports the original beneficiary account is closed',return_code:'R02',external_event_id:event});}

test('legacy route resolution is read-only and ignores mutable supplier names while retaining independent retry evidence',()=>{
  const w=fresh(),before=structuredClone(w),binding=resolveSupplierPaymentRoute(w,w.bills[0],readHooks);assert.deepEqual(w,before);
  assert.equal(binding.beneficiary_id,w.bills[0].beneficiary_id);assert.equal(binding.route_source_id,null);assert.equal(binding.requires_independent_approval,false);assert.match(binding.route_source_fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(w.supplierRoutes,undefined);assert.equal(w.supplierRouteHolds,undefined);assert.equal(w.billPaymentOutcomes,undefined);
  w.vendors[0].name='Updated display name';assert.deepEqual(resolveSupplierPaymentRoute(w,w.bills[0],readHooks),binding);
  act(w,{type:'set_counterparty_status',kind:'vendor',counterparty_id:w.vendors[0].id,enabled:false,reason:'Temporary pause',external_event_id:'paused'});assert.throws(()=>resolveSupplierPaymentRoute(w,w.bills[0],readHooks),(e:any)=>e.code==='counterparty_disabled');
  act(w,{type:'set_counterparty_status',kind:'vendor',counterparty_id:w.vendors[0].id,enabled:true,reason:'Resume',external_event_id:'enabled'});assert.deepEqual(resolveSupplierPaymentRoute(w,w.bills[0],readHooks),binding);
});

test('verified successors retain original commercial sources and every new route payment requires distinct review',()=>{
  const w=fresh(),source=economics(w),old=w.vendors[0].verified_bank_account,result=verify(w),binding=resolveSupplierPaymentRoute(w,w.bills[0],readHooks);
  assert.deepEqual(economics(w),source);assert.equal(result.route.previous_route_id,old);assert.equal(w.vendors[0].verified_bank_account,result.route.id);assert.equal(result.route.contact_snapshot.email,w.vendors[0].email);assert.equal(binding.route_source_id,result.route.id);assert.equal(binding.requires_independent_approval,true);assert.equal(w.bills[0].beneficiary_id,old);
  const request=pay(w,100);assert.equal(request.status,'awaiting_approval');assert.equal(summarize(w).reserved_minor,0);assert.equal(w.operations.length,0);
  fails(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'separate_controller_required',{id:operator.id,role:'controller'});
  const accepted=approve(w,request).operation;assert.equal(accepted.supplier_route.beneficiary_id,result.route.id);assert.equal(accepted.verified_counterparty_route,result.route.id);assert.equal(summarize(w).reserved_minor,100);
  tick(w);assert.equal(w.operations.find(row=>row.id===accepted.id).status,'settled');assert.equal(w.bills[0].amount_paid_minor,100);assert.equal(w.bills[0].beneficiary_id,old);
});

test('pending approval cannot silently adopt a successor and source fingerprint cannot be supplied by a caller',()=>{
  const w=fresh(1),request=pay(w,1000),oldBinding=structuredClone(w.approvals.find(row=>row.id===request.approval_id).action.supplier_route);verify(w);
  fails(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'unverified_beneficiary');assert.equal(w.approvals.find(row=>row.id===request.approval_id).status,'pending');
  assert.throws(()=>validateSupplierPaymentBinding(w,w.bills[0],oldBinding,readHooks),(e:any)=>e.code==='supplier_payment_source_changed');
  fails(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:1000,supplier_route:resolveSupplierPaymentRoute(w,w.bills[0],readHooks)},undefined,operator);
  act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'reject'});const replacement=pay(w,1000);assert.notEqual(replacement.approval_id,request.approval_id);assert.equal(approve(w,replacement).operation.supplier_route.route_source_id,w.supplierRoutes[0].id);
});

test('a return quarantines pending accepted payments without releasing reservations; bank cancellation and verified successor permit a fresh retry',()=>{
  const w=fresh(),original=pay(w,1000).operation;tick(w);const pending=pay(w,1000).operation;const returnedSource=returned(w,original,1000),held=w.supplierRouteHolds[0];
  assert.equal(held.operation_id,original.id);assert.equal(held.source_id,returnedSource.payment_return.id);assert.equal(held.route_id,pending.verified_counterparty_route);assert.equal(summarize(w).reserved_minor,1000);
  const beforeTick=economics(w);tick(w);assert.deepEqual(economics(w),beforeTick);assert.equal(w.operations.find(row=>row.id===pending.id).status,'pending');assert.equal(summarize(w).reserved_minor,1000);
  assert.throws(()=>pay(w,1000),heldError);
  const finance=economics(w),originalApproval=structuredClone(w.approvals),cancel={type:'cancel_bill_payment',operation_id:pending.id,bank_reference:'BANK-CANCEL-PENDING',reason:'Bank confirms cancellation before transfer',external_event_id:'cancel-pending'};
  const cancelled=act(w,cancel);assert.equal(cancelled.outcome.kind,'cancelled');assert.equal(cancelled.operation.status,'cancelled');assert.equal(cancelled.operation.receipt_id,undefined);assert.deepEqual(economics(w),finance);assert.deepEqual(w.approvals,originalApproval);assert.equal(summarize(w).reserved_minor,0);
  const count=w.billPaymentOutcomes.length,docs=w.documents.length;assert.equal(act(w,cancel).replayed,true);assert.equal(w.billPaymentOutcomes.length,count);assert.equal(w.documents.length,docs);
  verify(w);const request=pay(w,2000);assert.equal(request.status,'awaiting_approval');approve(w,request);tick(w);assert.equal(w.bills[0].amount_paid_minor,2000);assert.equal(w.operations.find(row=>row.id===original.id).status,'settled');assert.equal(w.operations.find(row=>row.id===pending.id).status,'cancelled');assert.equal(w.paymentReturns.length,1);assert.equal(w.supplierRouteHolds.length,1);
});

test('all rejection outcomes release only pending reservation, and only invalid-beneficiary rejection quarantines the route',()=>{
  for(const rejection_code of ['invalid_beneficiary','insufficient_funds','bank_rejected']){
    const w=fresh(),pending=pay(w,1000).operation,finance=economics(w),result=act(w,{type:'reject_bill_payment',operation_id:pending.id,rejection_code,bank_reference:'BANK-REJECTION-'+rejection_code,reason:'Observed original bank outcome',external_event_id:'rejection-'+rejection_code});
    assert.equal(result.operation.status,'rejected');assert.equal(result.outcome.rejection_code,rejection_code);assert.equal(result.operation.receipt_id,undefined);assert.equal(summarize(w).reserved_minor,0);assert.deepEqual(economics(w),finance);
    if(rejection_code==='invalid_beneficiary'){assert.equal(w.supplierRouteHolds.length,1);assert.throws(()=>pay(w,1000),heldError);verify(w);}else assert.equal(w.supplierRouteHolds,undefined);
    const retry=pay(w,1000);assert.equal(retry.status,'awaiting_approval');assert.equal(approve(w,retry).operation.status,'pending');
  }
});

test('settled, cancelled, foreign and never-accepted operations cannot be erased by a terminal outcome',()=>{
  const w=fresh(),settled=pay(w,1000).operation;tick(w);
  const cancel={type:'cancel_bill_payment',operation_id:settled.id,bank_reference:'CANCEL',reason:'Bank source',external_event_id:'invalid-cancel'};
  fails(w,cancel,'bill_payment_not_pending');fails(w,{...cancel,type:'reject_bill_payment',rejection_code:'invalid_beneficiary'},'bill_payment_not_pending');
  fails(w,{...cancel,operation_id:'missing'},'not_found');
  const pending=pay(w,1000).operation;act(w,{...cancel,operation_id:pending.id});fails(w,{...cancel,operation_id:pending.id,external_event_id:'second-cancel'},'bill_payment_not_pending');
  const malicious=structuredClone(w);malicious.operations.find(row=>row.id===pending.id).currency='EUR';assert.throws(()=>supplierPaymentOperationRoute(malicious,malicious.operations.find(row=>row.id===pending.id),readHooks),(e:any)=>e.code==='invalid_bill_payment_operation');
  assert.equal(w.operations.find(row=>row.id===settled.id).status,'settled');assert.ok(w.operations.find(row=>row.id===settled.id).receipt_id);
});

test('old persisted return history is a hold even without new arrays, and enabled toggles do not reverify it',()=>{
  const w=fresh(),original=pay(w,1000).operation;tick(w);returned(w,original,500);delete w.supplierRouteHolds;delete w.supplierRoutes;delete w.billPaymentOutcomes;
  const legacy=w.operations.find(row=>row.id===original.id);delete legacy.supplier_route;delete legacy.verified_counterparty_route;
  const before=structuredClone(w);assert.throws(()=>resolveSupplierPaymentRoute(w,w.bills[0],readHooks),heldError);assert.deepEqual(w,before);
  for(const enabled of [false,true])act(w,{type:'set_counterparty_status',kind:'vendor',counterparty_id:w.vendors[0].id,enabled,reason:'Administrative status',external_event_id:'status-'+enabled});assert.throws(()=>pay(w,500),heldError);assert.equal(w.supplierRouteHolds,undefined);
  const route=verify(w).route;assert.equal(route.previous_route_id,w.bills[0].beneficiary_id);assert.equal(pay(w,500).status,'awaiting_approval');
});

test('a late return on an old route does not suspend or retarget a separately verified successor payment',()=>{
  const w=fresh(),original=pay(w,1000).operation;tick(w);const route=verify(w).route,newPayment=approve(w,pay(w,1000)).operation;returned(w,original,500);
  assert.equal(w.supplierRouteHolds[0].route_id,w.bills[0].beneficiary_id);assert.notEqual(w.supplierRouteHolds[0].route_id,route.id);assert.equal(resolveSupplierPaymentRoute(w,w.bills[0],readHooks).beneficiary_id,route.id);
  tick(w);assert.equal(w.operations.find(row=>row.id===newPayment.id).status,'settled');assert.equal(w.operations.find(row=>row.id===newPayment.id).verified_counterparty_route,route.id);assert.equal(w.bills[0].amount_paid_minor,1500);
});

test('legacy pending operations without a route snapshot remain tied to the original bill and can be cancelled after succession',()=>{
  const w=fresh(),pending=pay(w,1000).operation,row=w.operations.find(item=>item.id===pending.id),old=w.bills[0].beneficiary_id;delete row.supplier_route;delete row.verified_counterparty_route;
  verify(w);assert.equal(supplierPaymentOperationRoute(w,row,readHooks),old);const before=economics(w);tick(w);assert.deepEqual(economics(w),before);assert.equal(w.operations.find(item=>item.id===pending.id).status,'pending');assert.equal(summarize(w).reserved_minor,1000);
  const result=act(w,{type:'cancel_bill_payment',operation_id:pending.id,bank_reference:'LEGACY-CANCEL',reason:'Bank confirmed old route cancellation',external_event_id:'legacy-cancel'});assert.equal(result.outcome.beneficiary_id,old);assert.equal(summarize(w).reserved_minor,0);
});

test('verification rejects stale, future, reused and injected source facts atomically and preserves old verification records',()=>{
  const w=fresh(),route=verify(w).route,copy=structuredClone(route),base={type:'record_supplier_route',vendor_id:w.vendors[0].id,previous_route_id:route.id,verification_reference:'second-verification',verified_at:w.now,verification_method:'bank_portal',destination_reference:'second-destination',reason:'Treasury confirmed successor',external_event_id:'second-verification'};
  for(const patch of [{previous_route_id:route.previous_route_id},{vendor_id:w.vendors[1].id},{verified_at:'2026-10-24T09:00:00Z'},{verified_at:'2100-01-01T00:00:00.000Z'},{verification_reference:route.verification_reference},{verification_method:'email_reply'},{beneficiary_id:'untrusted-account'},{approved:true},{destination_reference:'bad\nreference'}])fails(w,{...base,...patch});
  fails(w,base,'controller_required',operator);act(w,base);assert.deepEqual(w.supplierRoutes[0],copy);assert.equal(w.supplierRoutes[1].previous_route_id,route.id);assert.equal(resolveSupplierPaymentRoute(w,w.bills[0],readHooks).route_source_id,w.supplierRoutes[1].id);
  const tampered=structuredClone(w);tampered.supplierRoutes[1].vendor_id=w.vendors[1].id;assert.throws(()=>resolveSupplierPaymentRoute(tampered,tampered.bills[0],readHooks),(e:any)=>e.code==='invalid_supplier_route_source');
});

test('independent re-verification can retain a destination while a successor route never restores the held version',()=>{
  const w=fresh(),first=verify(w).route,payment=approve(w,pay(w,1000)).operation;tick(w);returned(w,payment,500);
  const second=act(w,{type:'record_supplier_route',vendor_id:first.vendor_id,previous_route_id:first.id,verification_reference:'independent-new-verification',verified_at:w.now,verification_method:'bank_portal',destination_reference:first.destination_reference,reason:'Bank independently reconfirms the same destination after transient return',external_event_id:'reverify-same-destination'}).route;
  assert.notEqual(second.id,first.id);assert.equal(second.destination_reference,first.destination_reference);assert.equal(w.supplierRouteHolds[0].route_id,first.id);assert.equal(resolveSupplierPaymentRoute(w,w.bills[0],readHooks).beneficiary_id,second.id);assert.equal(pay(w,500).status,'awaiting_approval');
});

test('cancelling a separate partial instruction requires fresh request review but does not invalidate an accepted unchanged route',()=>{
  const w=fresh(),first=pay(w,1000).operation,second=pay(w,1000).operation,originalBinding=structuredClone(first.supplier_route);
  act(w,{type:'cancel_bill_payment',operation_id:second.id,bank_reference:'CANCEL-OTHER-PARTIAL',reason:'Cancel only the second instruction',external_event_id:'cancel-other-partial'});
  assert.throws(()=>validateSupplierPaymentBinding(w,w.bills[0],originalBinding,readHooks),(e:any)=>e.code==='supplier_payment_source_changed');assert.equal(validateSupplierPaymentBinding(w,w.bills[0],originalBinding,readHooks,true).beneficiary_id,originalBinding.beneficiary_id);
  assert.equal(pay(w,500).status,'awaiting_approval');tick(w);assert.equal(w.operations.find(row=>row.id===first.id).status,'settled');assert.equal(w.operations.find(row=>row.id===second.id).status,'cancelled');assert.equal(w.bills[0].amount_paid_minor,1000);
  const pendingWorld=fresh(1),accepted=approve(pendingWorld,pay(pendingWorld,1000)).operation,undecided=pay(pendingWorld,1000);act(pendingWorld,{type:'cancel_bill_payment',operation_id:accepted.id,bank_reference:'CANCEL-WITH-PENDING-REVIEW',reason:'Bank confirmed original cancellation',external_event_id:'cancel-with-pending-review'});fails(pendingWorld,{type:'decide_approval',approval_id:undecided.approval_id,decision:'approve'},'supplier_payment_source_changed');
});

test('a fresh verification cannot predate a bank return observed after its predecessor',()=>{
  const w=fresh(),original=pay(w,1000).operation,oldTime=w.now;tick(w);returned(w,original,500);
  fails(w,{type:'record_supplier_route',vendor_id:w.vendors[0].id,previous_route_id:w.vendors[0].verified_bank_account,verification_reference:'old-verification',verified_at:oldTime,verification_method:'bank_portal',destination_reference:'verified-but-before-return',reason:'Historical verification cannot clear a newer bank hold',external_event_id:'old-verification'},'invalid_supplier_verification_time');
  verify(w);assert.equal(pay(w,500).status,'awaiting_approval');
});

test('closed-period original payment and return retain their journals and cash while cancelling a different pending acceptance',()=>{
  const w=fresh(),opening=economics(w);act(w,{type:'close_period'});const original=pay(w,1000).operation;tick(w);const pending=pay(w,1000).operation;returned(w,original,500);
  const bank=structuredClone(w.bankTransactions),bill=structuredClone(w.bills),before=w.operations.filter(row=>row.status==='settled'&&!row.journal_id).length;assert.equal(before,2);
  act(w,{type:'set_fault',system:'mercury',mode:'offline'});act(w,{type:'cancel_bill_payment',operation_id:pending.id,bank_reference:'OFFLINE-CONFIRMED-CANCEL',reason:'Independent bank source arrives while API is offline',external_event_id:'offline-cancel'});assert.deepEqual(w.bankTransactions,bank);assert.deepEqual(w.bills,bill);assert.equal(summarize(w).reserved_minor,0);
  act(w,{type:'reopen_period'});assert.equal(w.journals.length,opening.journals.length+2);assert.deepEqual(w.bankTransactions,bank);assert.ok(w.operations.find(row=>row.id===original.id).journal_id);assert.equal(w.operations.find(row=>row.id===pending.id).journal_id,undefined);assert.equal(w.operations.find(row=>row.id===pending.id).receipt_id,undefined);
});

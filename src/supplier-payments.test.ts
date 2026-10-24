import {test,expect} from 'bun:test';
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
function fails(w:World,action:any,code?:string,actor:any=controller){const before=structuredClone(w);expect(()=>act(w,action,actor),JSON.stringify(action)).toThrowSatisfying((error:any)=>!code||error.code===code);expect(w).toStrictEqual(before);}
function verify(w:World,suffix='one',vendor=w.vendors[0]){return act(w,{type:'record_supplier_route',vendor_id:vendor.id,previous_route_id:vendor.verified_bank_account,verification_reference:`callback-${suffix}`,verified_at:w.now,verification_method:'callback_on_file',destination_reference:`synthetic-account-${suffix}`,reason:'Independent treasury callback using the original contact on file',external_event_id:`verified-route-${suffix}`});}
function pay(w:World,amount=1000,bill=w.bills[0],actor:any=operator){return act(w,{type:'pay_bill',bill_id:bill.id,amount_minor:amount},actor);}
function approve(w:World,result:any,actor:any=reviewer){return act(w,{type:'decide_approval',approval_id:result.approval_id,decision:'approve'},actor);}
const tick=(w:World)=>act(w,{type:'advance_time',hours:1});
function returned(w:World,operation:any,amount=500,event='return-one'){return act(w,{type:'return_bill_payment',operation_id:operation.id,amount_minor:amount,reason:'Bank reports the original beneficiary account is closed',return_code:'R02',external_event_id:event});}

test('legacy route resolution is read-only and ignores mutable supplier names while retaining independent retry evidence',()=>{
  const w=fresh(),before=structuredClone(w),binding=resolveSupplierPaymentRoute(w,w.bills[0],readHooks);expect(w).toStrictEqual(before);
  expect(binding.beneficiary_id).toBe(w.bills[0].beneficiary_id);expect(binding.route_source_id).toBeNull();expect(binding.requires_independent_approval).toBe(false);expect(binding.route_source_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(w.supplierRoutes).toBeUndefined();expect(w.supplierRouteHolds).toBeUndefined();expect(w.billPaymentOutcomes).toBeUndefined();
  w.vendors[0].name='Updated display name';expect(resolveSupplierPaymentRoute(w,w.bills[0],readHooks)).toStrictEqual(binding);
  act(w,{type:'set_counterparty_status',kind:'vendor',counterparty_id:w.vendors[0].id,enabled:false,reason:'Temporary pause',external_event_id:'paused'});expect(()=>resolveSupplierPaymentRoute(w,w.bills[0],readHooks)).toThrowSatisfying((e:any)=>e.code==='counterparty_disabled');
  act(w,{type:'set_counterparty_status',kind:'vendor',counterparty_id:w.vendors[0].id,enabled:true,reason:'Resume',external_event_id:'enabled'});expect(resolveSupplierPaymentRoute(w,w.bills[0],readHooks)).toStrictEqual(binding);
});

test('verified successors retain original commercial sources and every new route payment requires distinct review',()=>{
  const w=fresh(),source=economics(w),old=w.vendors[0].verified_bank_account,result=verify(w),binding=resolveSupplierPaymentRoute(w,w.bills[0],readHooks);
  expect(economics(w)).toStrictEqual(source);expect(result.route.previous_route_id).toBe(old);expect(w.vendors[0].verified_bank_account).toBe(result.route.id);expect(result.route.contact_snapshot.email).toBe(w.vendors[0].email);expect(binding.route_source_id).toBe(result.route.id);expect(binding.requires_independent_approval).toBe(true);expect(w.bills[0].beneficiary_id).toBe(old);
  const request=pay(w,100);expect(request.status).toBe('awaiting_approval');expect(summarize(w).reserved_minor).toBe(0);expect(w.operations.length).toBe(0);
  fails(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'separate_controller_required',{id:operator.id,role:'controller'});
  const accepted=approve(w,request).operation;expect(accepted.supplier_route.beneficiary_id).toBe(result.route.id);expect(accepted.verified_counterparty_route).toBe(result.route.id);expect(summarize(w).reserved_minor).toBe(100);
  tick(w);expect(w.operations.find(row=>row.id===accepted.id).status).toBe('settled');expect(w.bills[0].amount_paid_minor).toBe(100);expect(w.bills[0].beneficiary_id).toBe(old);
});

test('pending approval cannot silently adopt a successor and source fingerprint cannot be supplied by a caller',()=>{
  const w=fresh(1),request=pay(w,1000),oldBinding=structuredClone(w.approvals.find(row=>row.id===request.approval_id).action.supplier_route);verify(w);
  fails(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'unverified_beneficiary');expect(w.approvals.find(row=>row.id===request.approval_id).status).toBe('pending');
  expect(()=>validateSupplierPaymentBinding(w,w.bills[0],oldBinding,readHooks)).toThrowSatisfying((e:any)=>e.code==='supplier_payment_source_changed');
  fails(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:1000,supplier_route:resolveSupplierPaymentRoute(w,w.bills[0],readHooks)},undefined,operator);
  act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'reject'});const replacement=pay(w,1000);expect(replacement.approval_id).not.toBe(request.approval_id);expect(approve(w,replacement).operation.supplier_route.route_source_id).toBe(w.supplierRoutes[0].id);
});

test('a return quarantines pending accepted payments without releasing reservations; bank cancellation and verified successor permit a fresh retry',()=>{
  const w=fresh(),original=pay(w,1000).operation;tick(w);const pending=pay(w,1000).operation;const returnedSource=returned(w,original,1000),held=w.supplierRouteHolds[0];
  expect(held.operation_id).toBe(original.id);expect(held.source_id).toBe(returnedSource.payment_return.id);expect(held.route_id).toBe(pending.verified_counterparty_route);expect(summarize(w).reserved_minor).toBe(1000);
  const beforeTick=economics(w);tick(w);expect(economics(w)).toStrictEqual(beforeTick);expect(w.operations.find(row=>row.id===pending.id).status).toBe('pending');expect(summarize(w).reserved_minor).toBe(1000);
  expect(()=>pay(w,1000)).toThrowSatisfying(heldError);
  const finance=economics(w),originalApproval=structuredClone(w.approvals),cancel={type:'cancel_bill_payment',operation_id:pending.id,bank_reference:'BANK-CANCEL-PENDING',reason:'Bank confirms cancellation before transfer',external_event_id:'cancel-pending'};
  const cancelled=act(w,cancel);expect(cancelled.outcome.kind).toBe('cancelled');expect(cancelled.operation.status).toBe('cancelled');expect(cancelled.operation.receipt_id).toBeUndefined();expect(economics(w)).toStrictEqual(finance);expect(w.approvals).toStrictEqual(originalApproval);expect(summarize(w).reserved_minor).toBe(0);
  const count=w.billPaymentOutcomes.length,docs=w.documents.length;expect(act(w,cancel).replayed).toBe(true);expect(w.billPaymentOutcomes.length).toBe(count);expect(w.documents.length).toBe(docs);
  verify(w);const request=pay(w,2000);expect(request.status).toBe('awaiting_approval');approve(w,request);tick(w);expect(w.bills[0].amount_paid_minor).toBe(2000);expect(w.operations.find(row=>row.id===original.id).status).toBe('settled');expect(w.operations.find(row=>row.id===pending.id).status).toBe('cancelled');expect(w.paymentReturns.length).toBe(1);expect(w.supplierRouteHolds.length).toBe(1);
});

test('all rejection outcomes release only pending reservation, and only invalid-beneficiary rejection quarantines the route',()=>{
  for(const rejection_code of ['invalid_beneficiary','insufficient_funds','bank_rejected']){
    const w=fresh(),pending=pay(w,1000).operation,finance=economics(w),result=act(w,{type:'reject_bill_payment',operation_id:pending.id,rejection_code,bank_reference:'BANK-REJECTION-'+rejection_code,reason:'Observed original bank outcome',external_event_id:'rejection-'+rejection_code});
    expect(result.operation.status).toBe('rejected');expect(result.outcome.rejection_code).toBe(rejection_code);expect(result.operation.receipt_id).toBeUndefined();expect(summarize(w).reserved_minor).toBe(0);expect(economics(w)).toStrictEqual(finance);
    if(rejection_code==='invalid_beneficiary'){expect(w.supplierRouteHolds.length).toBe(1);expect(()=>pay(w,1000)).toThrowSatisfying(heldError);verify(w);}else expect(w.supplierRouteHolds).toBeUndefined();
    const retry=pay(w,1000);expect(retry.status).toBe('awaiting_approval');expect(approve(w,retry).operation.status).toBe('pending');
  }
});

test('settled, cancelled, foreign and never-accepted operations cannot be erased by a terminal outcome',()=>{
  const w=fresh(),settled=pay(w,1000).operation;tick(w);
  const cancel={type:'cancel_bill_payment',operation_id:settled.id,bank_reference:'CANCEL',reason:'Bank source',external_event_id:'invalid-cancel'};
  fails(w,cancel,'bill_payment_not_pending');fails(w,{...cancel,type:'reject_bill_payment',rejection_code:'invalid_beneficiary'},'bill_payment_not_pending');
  fails(w,{...cancel,operation_id:'missing'},'not_found');
  const pending=pay(w,1000).operation;act(w,{...cancel,operation_id:pending.id});fails(w,{...cancel,operation_id:pending.id,external_event_id:'second-cancel'},'bill_payment_not_pending');
  const malicious=structuredClone(w);malicious.operations.find(row=>row.id===pending.id).currency='EUR';expect(()=>supplierPaymentOperationRoute(malicious,malicious.operations.find(row=>row.id===pending.id),readHooks)).toThrowSatisfying((e:any)=>e.code==='invalid_bill_payment_operation');
  expect(w.operations.find(row=>row.id===settled.id).status).toBe('settled');expect(w.operations.find(row=>row.id===settled.id).receipt_id).toBeTruthy();
});

test('old persisted return history is a hold even without new arrays, and enabled toggles do not reverify it',()=>{
  const w=fresh(),original=pay(w,1000).operation;tick(w);returned(w,original,500);delete w.supplierRouteHolds;delete w.supplierRoutes;delete w.billPaymentOutcomes;
  const legacy=w.operations.find(row=>row.id===original.id);delete legacy.supplier_route;delete legacy.verified_counterparty_route;
  const before=structuredClone(w);expect(()=>resolveSupplierPaymentRoute(w,w.bills[0],readHooks)).toThrowSatisfying(heldError);expect(w).toStrictEqual(before);
  for(const enabled of [false,true])act(w,{type:'set_counterparty_status',kind:'vendor',counterparty_id:w.vendors[0].id,enabled,reason:'Administrative status',external_event_id:'status-'+enabled});expect(()=>pay(w,500)).toThrowSatisfying(heldError);expect(w.supplierRouteHolds).toBeUndefined();
  const route=verify(w).route;expect(route.previous_route_id).toBe(w.bills[0].beneficiary_id);expect(pay(w,500).status).toBe('awaiting_approval');
});

test('a late return on an old route does not suspend or retarget a separately verified successor payment',()=>{
  const w=fresh(),original=pay(w,1000).operation;tick(w);const route=verify(w).route,newPayment=approve(w,pay(w,1000)).operation;returned(w,original,500);
  expect(w.supplierRouteHolds[0].route_id).toBe(w.bills[0].beneficiary_id);expect(w.supplierRouteHolds[0].route_id).not.toBe(route.id);expect(resolveSupplierPaymentRoute(w,w.bills[0],readHooks).beneficiary_id).toBe(route.id);
  tick(w);expect(w.operations.find(row=>row.id===newPayment.id).status).toBe('settled');expect(w.operations.find(row=>row.id===newPayment.id).verified_counterparty_route).toBe(route.id);expect(w.bills[0].amount_paid_minor).toBe(1500);
});

test('legacy pending operations without a route snapshot remain tied to the original bill and can be cancelled after succession',()=>{
  const w=fresh(),pending=pay(w,1000).operation,row=w.operations.find(item=>item.id===pending.id),old=w.bills[0].beneficiary_id;delete row.supplier_route;delete row.verified_counterparty_route;
  verify(w);expect(supplierPaymentOperationRoute(w,row,readHooks)).toBe(old);const before=economics(w);tick(w);expect(economics(w)).toStrictEqual(before);expect(w.operations.find(item=>item.id===pending.id).status).toBe('pending');expect(summarize(w).reserved_minor).toBe(1000);
  const result=act(w,{type:'cancel_bill_payment',operation_id:pending.id,bank_reference:'LEGACY-CANCEL',reason:'Bank confirmed old route cancellation',external_event_id:'legacy-cancel'});expect(result.outcome.beneficiary_id).toBe(old);expect(summarize(w).reserved_minor).toBe(0);
});

test('verification rejects stale, future, reused and injected source facts atomically and preserves old verification records',()=>{
  const w=fresh(),route=verify(w).route,copy=structuredClone(route),base={type:'record_supplier_route',vendor_id:w.vendors[0].id,previous_route_id:route.id,verification_reference:'second-verification',verified_at:w.now,verification_method:'bank_portal',destination_reference:'second-destination',reason:'Treasury confirmed successor',external_event_id:'second-verification'};
  for(const patch of [{previous_route_id:route.previous_route_id},{vendor_id:w.vendors[1].id},{verified_at:'2026-10-24T09:00:00Z'},{verified_at:'2100-01-01T00:00:00.000Z'},{verification_reference:route.verification_reference},{verification_method:'email_reply'},{beneficiary_id:'untrusted-account'},{approved:true},{destination_reference:'bad\nreference'}])fails(w,{...base,...patch});
  fails(w,base,'controller_required',operator);act(w,base);expect(w.supplierRoutes[0]).toStrictEqual(copy);expect(w.supplierRoutes[1].previous_route_id).toBe(route.id);expect(resolveSupplierPaymentRoute(w,w.bills[0],readHooks).route_source_id).toBe(w.supplierRoutes[1].id);
  const tampered=structuredClone(w);tampered.supplierRoutes[1].vendor_id=w.vendors[1].id;expect(()=>resolveSupplierPaymentRoute(tampered,tampered.bills[0],readHooks)).toThrowSatisfying((e:any)=>e.code==='invalid_supplier_route_source');
});

test('independent re-verification can retain a destination while a successor route never restores the held version',()=>{
  const w=fresh(),first=verify(w).route,payment=approve(w,pay(w,1000)).operation;tick(w);returned(w,payment,500);
  const second=act(w,{type:'record_supplier_route',vendor_id:first.vendor_id,previous_route_id:first.id,verification_reference:'independent-new-verification',verified_at:w.now,verification_method:'bank_portal',destination_reference:first.destination_reference,reason:'Bank independently reconfirms the same destination after transient return',external_event_id:'reverify-same-destination'}).route;
  expect(second.id).not.toBe(first.id);expect(second.destination_reference).toBe(first.destination_reference);expect(w.supplierRouteHolds[0].route_id).toBe(first.id);expect(resolveSupplierPaymentRoute(w,w.bills[0],readHooks).beneficiary_id).toBe(second.id);expect(pay(w,500).status).toBe('awaiting_approval');
});

test('cancelling a separate partial instruction requires fresh request review but does not invalidate an accepted unchanged route',()=>{
  const w=fresh(),first=pay(w,1000).operation,second=pay(w,1000).operation,originalBinding=structuredClone(first.supplier_route);
  act(w,{type:'cancel_bill_payment',operation_id:second.id,bank_reference:'CANCEL-OTHER-PARTIAL',reason:'Cancel only the second instruction',external_event_id:'cancel-other-partial'});
  expect(()=>validateSupplierPaymentBinding(w,w.bills[0],originalBinding,readHooks)).toThrowSatisfying((e:any)=>e.code==='supplier_payment_source_changed');expect(validateSupplierPaymentBinding(w,w.bills[0],originalBinding,readHooks,true).beneficiary_id).toBe(originalBinding.beneficiary_id);
  expect(pay(w,500).status).toBe('awaiting_approval');tick(w);expect(w.operations.find(row=>row.id===first.id).status).toBe('settled');expect(w.operations.find(row=>row.id===second.id).status).toBe('cancelled');expect(w.bills[0].amount_paid_minor).toBe(1000);
  const pendingWorld=fresh(1),accepted=approve(pendingWorld,pay(pendingWorld,1000)).operation,undecided=pay(pendingWorld,1000);act(pendingWorld,{type:'cancel_bill_payment',operation_id:accepted.id,bank_reference:'CANCEL-WITH-PENDING-REVIEW',reason:'Bank confirmed original cancellation',external_event_id:'cancel-with-pending-review'});fails(pendingWorld,{type:'decide_approval',approval_id:undecided.approval_id,decision:'approve'},'supplier_payment_source_changed');
});

test('a fresh verification cannot predate a bank return observed after its predecessor',()=>{
  const w=fresh(),original=pay(w,1000).operation,oldTime=w.now;tick(w);returned(w,original,500);
  fails(w,{type:'record_supplier_route',vendor_id:w.vendors[0].id,previous_route_id:w.vendors[0].verified_bank_account,verification_reference:'old-verification',verified_at:oldTime,verification_method:'bank_portal',destination_reference:'verified-but-before-return',reason:'Historical verification cannot clear a newer bank hold',external_event_id:'old-verification'},'invalid_supplier_verification_time');
  verify(w);expect(pay(w,500).status).toBe('awaiting_approval');
});

test('closed-period original payment and return retain their journals and cash while cancelling a different pending acceptance',()=>{
  const w=fresh(),opening=economics(w);act(w,{type:'close_period'});const original=pay(w,1000).operation;tick(w);const pending=pay(w,1000).operation;returned(w,original,500);
  const bank=structuredClone(w.bankTransactions),bill=structuredClone(w.bills),before=w.operations.filter(row=>row.status==='settled'&&!row.journal_id).length;expect(before).toBe(2);
  act(w,{type:'set_fault',system:'mercury',mode:'offline'});act(w,{type:'cancel_bill_payment',operation_id:pending.id,bank_reference:'OFFLINE-CONFIRMED-CANCEL',reason:'Independent bank source arrives while API is offline',external_event_id:'offline-cancel'});expect(w.bankTransactions).toStrictEqual(bank);expect(w.bills).toStrictEqual(bill);expect(summarize(w).reserved_minor).toBe(0);
  act(w,{type:'reopen_period'});expect(w.journals.length).toBe(opening.journals.length+2);expect(w.bankTransactions).toStrictEqual(bank);expect(w.operations.find(row=>row.id===original.id).journal_id).toBeTruthy();expect(w.operations.find(row=>row.id===pending.id).journal_id).toBeUndefined();expect(w.operations.find(row=>row.id===pending.id).receipt_id).toBeUndefined();
});

import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createWorld,applyAction,DomainError,summarize} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {providerRequest} from './provider-adapters.ts';
import {providerMercury,providerMercuryRoutes} from './provider-mercury.ts';
import {providerContracts,resolveProviderOperation} from './provider-contracts.ts';
const operator:Actor={id:'ap-operator',role:'operator'},controller:Actor={id:'treasury-controller',role:'controller'};
const make=()=>createWorld({kind:'supplier-fraud',orderCount:3,seed:42,initialCashMinor:1_000_000,approvalThresholdMinor:1_000_000},'mercury-test-world');
const act=(w:World,a:Action,actor=controller)=>applyAction(w,a,actor).result;
async function call(w:World,path:string,method='GET',input?:any){const url=new URL(path,'http://local.test');return (await providerRequest({world:w,system:'mercury',route:url.pathname,url,method,input,execute:a=>act(w,a,operator)}));}
const body=(w:World,index=0,key='bank-request-1',amount=2.29)=>({recipientId:w.bills[index].vendor_id,amount,paymentMethod:'ach',idempotencyKey:key,finance_world:{bill_id:w.bills[index].id}});
const create=(w:World,input:any=body(w))=>call(w,'/api/v1/account/cash-bank/request-send-money','POST',input);
const approve=(w:World,id:string)=>act(w,{type:'decide_approval',approval_id:id,decision:'approve'});
const bankState=(w:World)=>structuredClone({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts,bills:w.bills});
async function rejected(w:World,path:string,method:string,input:any,code:string){const before=structuredClone(w);await assert.rejects(()=>call(w,path,method,input),(e:any)=>e instanceof DomainError&&e.code===code);assert.deepEqual(w,before);}

test('Mercury publishes nine explicit contracts with source-backed create and controller-only terminal outcomes',()=>{
 assert.equal(providerMercuryRoutes.length,9);assert.equal(providerContracts.filter(r=>r.system==='mercury').length,9);
 const request=resolveProviderOperation('mercury.approval_requests.create','world-one',{account_id:'cash-bank'});assert.equal(request.contract.access,'write');assert.equal(request.contract.method,'POST');assert.equal(request.path,'/providers/mercury/worlds/world-one/api/v1/account/cash-bank/request-send-money');
 assert.equal(resolveProviderOperation('mercury.approval_requests.list','world-one',{}, {status:'rejected'}).contract.access,'read');assert.ok(providerMercuryRoutes.every(route=>route.documentation.length>0));assert.equal(providerMercuryRoutes.some(r=>/cancel|approve$/.test(r.id)),false);
});

test('native request always creates an actual independent review without a transaction, cash or journal',async()=>{
 const w=make(),financial=bankState(w),r=await create(w,{...body(w),note:'April venue source invoice'}),id=r?.body.requestId;
 assert.equal(r?.status,200);assert.equal(r?.body.status,'pendingApproval');assert.equal(r?.body.paymentMethod,'ach');assert.equal(r?.body.amount,2.29);assert.equal(r?.body.recipientId,w.bills[0].vendor_id);assert.equal(r?.body.numberOfApproversRequired,1);assert.equal(r?.body.requesterMayApprove,false);assert.equal(r?.body.memo,'April venue source invoice');assert.equal(r?.body.finance_world.operation_id,null);assert.deepEqual(r?.body.reviews,[]);
 assert.equal(w.approvals.length,1);assert.equal(w.approvals[0].id,id);assert.equal(w.approvals[0].action.type,'pay_bill');assert.equal(w.billPaymentRequests[0].approval_id,id);assert.equal(w.operations.some(op=>op.type==='pay_bill'),false);assert.deepEqual(bankState(w),financial);
 assert.equal((await call(w,`/api/v1/account/cash-bank/transactions?requestId=${id}`))?.body.transactions.length,0);
 const before=structuredClone(w);assert.throws(()=>act(w,{type:'decide_approval',approval_id:id,decision:'approve'},{id:operator.id,role:'controller'}),(error:any)=>error.code==='separate_controller_required');assert.deepEqual(w,before);
});

test('accepted transaction identity remains unchanged through a real settlement and deferred GL posting',async()=>{
 const w=make(),cash=summarize(w).cash_minor,r=await create(w,{...body(w),note:'Persist this payment note'}),id=r?.body.requestId;
 const accepted=approve(w,id),op=accepted.operation,transactionId=op.bank_transaction_id;
 assert.match(transactionId,/^banktx_\d+$/);assert.equal(w.bankTransactions.some(t=>t.id===transactionId),false);assert.equal(summarize(w).reserved_minor,229);
 const before=structuredClone(w),pending=(await call(w,`/api/v1/transaction/${transactionId}`))?.body;assert.deepEqual(w,before);assert.equal(pending.status,'pending');assert.equal(pending.amount,-2.29);assert.equal(pending.postedAt,null);assert.equal(pending.hasGeneratedReceipt,false);assert.equal(pending.finance_world.bank_transaction_id,null);assert.equal(pending.finance_world.bank_cash_effect_minor,0);assert.equal(pending.note,'Persist this payment note');assert.equal(pending.requestId,id);
 act(w,{type:'close_period'});act(w,{type:'advance_time',hours:1});const settled=(await call(w,`/api/v1/account/cash-bank/transaction/${transactionId}`))?.body;
 assert.equal(settled.id,pending.id);assert.equal(settled.status,'sent');assert.equal(settled.postedAt,w.now);assert.equal(settled.hasGeneratedReceipt,true);assert.equal(settled.finance_world.bank_transaction_id,transactionId);assert.equal(settled.finance_world.journal_id,null);assert.equal(summarize(w).cash_minor,cash-229);assert.equal(summarize(w).reserved_minor,0);
 assert.equal((await call(w,`/api/v1/account/cash-bank/transactions?requestId=${id}`))?.body.transactions.length,1);const bank=structuredClone(w.bankTransactions);act(w,{type:'reopen_period'});assert.deepEqual(w.bankTransactions,bank);assert.ok((await call(w,`/api/v1/transaction/${transactionId}`))?.body.finance_world.journal_id);
 const review=(await call(w,`/api/v1/request-send-money/${id}`))?.body;assert.equal(review.status,'approved');assert.deepEqual(review.reviews,[{reviewerUserId:controller.id,status:'approved',reviewedAt:accepted.approval.decided_at}]);assert.equal(review.finance_world.instruction.canonical_status,'settled');
});

test('durable body-key replay returns the same rejected request without resubmission or fabricated failure cash',async()=>{
 const w=make(),input=body(w),r=await create(w,input),id=r?.body.requestId;
 act(w,{type:'decide_approval',approval_id:id,decision:'reject'});const financial=bankState(w),repeat=await create(w,input);
 assert.equal(repeat?.body.requestId,id);assert.equal(repeat?.body.status,'rejected');assert.equal(repeat?.body.reviews[0].status,'rejected');assert.equal(w.approvals.length,1);assert.equal(w.billPaymentRequests.length,1);assert.deepEqual(bankState(w),financial);assert.equal((await call(w,`/api/v1/account/cash-bank/transactions?requestId=${id}`))?.body.transactions.length,0);
 await rejected(w,'/api/v1/account/cash-bank/request-send-money','POST',{...input,amount:2.30},'bank_request_idempotency_conflict');
 await rejected(w,'/api/v1/account/cash-bank/request-send-money','POST',{...input,note:'Different instructions'},'bank_request_idempotency_conflict');
});

test('bank cancellation and rejection remain terminal instructions, not cash receipts or rewritten approvals',async()=>{
 for(const kind of ['cancelled','rejected'] as const){const w=make(),id=(await create(w))?.body.requestId,op=approve(w,id).operation,financial=bankState(w);
  act(w,kind==='cancelled'?{type:'cancel_bill_payment',operation_id:op.id,bank_reference:'bank-confirmed-cancel',reason:'Bank confirmed instruction stopped before settlement',external_event_id:'cancel-source'}:{type:'reject_bill_payment',operation_id:op.id,rejection_code:'invalid_beneficiary',bank_reference:'bank-confirmed-reject',reason:'Recipient account is closed',external_event_id:'reject-source'});
  const t=(await call(w,`/api/v1/transaction/${op.bank_transaction_id}`))?.body;assert.equal(t.status,kind==='cancelled'?'cancelled':'failed');assert.equal(t.postedAt,null);assert.equal(t.hasGeneratedReceipt,false);assert.equal(t.finance_world.bank_transaction_id,null);assert.equal(t.finance_world.canonical_status,kind);assert.equal(summarize(w).reserved_minor,0);assert.deepEqual(bankState(w),financial);
  const r=(await call(w,`/api/v1/request-send-money/${id}`))?.body;assert.equal(r.status,'approved');assert.equal(r.finance_world.instruction.canonical_status,kind);assert.equal(r.reviews[0].status,'approved');if(kind==='rejected'){assert.equal(t.reasonForFailure,'Recipient account is closed');assert.equal(t.failedAt,w.now);assert.equal(t.finance_world.route_hold_ids.length,1);}
  act(w,{type:'advance_time',hours:2});assert.deepEqual(bankState(w),financial);
 }
});

test('a successor route holds the accepted original instruction until separate terminal evidence',async()=>{
 const w=make(),id=(await create(w))?.body.requestId,op=approve(w,id).operation,old=op.verified_counterparty_route;
 const route=act(w,{type:'record_supplier_route',vendor_id:w.bills[0].vendor_id,previous_route_id:old,verification_reference:'verified-callback-one',verified_at:w.now,verification_method:'callback_on_file',destination_reference:'supplier-new-verified-destination',reason:'Callback using contact on file',external_event_id:'verified-route-one'}).route;
 act(w,{type:'advance_time',hours:1});const t=(await call(w,`/api/v1/transaction/${op.bank_transaction_id}`))?.body;
 assert.equal(t.status,'pending');assert.equal(t.finance_world.beneficiary_id,old);assert.equal(t.finance_world.current_supplier_route_id,route.id);assert.ok(t.finance_world.last_error);assert.equal(t.postedAt,null);assert.equal(t.finance_world.bank_cash_effect_minor,0);assert.equal(summarize(w).reserved_minor,229);
 const a=(await call(w,`/api/v1/request-send-money/${id}`))?.body;assert.equal(a.finance_world.supplier_route.beneficiary_id,old);assert.equal(a.finance_world.instruction.beneficiary_id,old);
});

test('a settled payment and partial bank return retain separate native IDs and exact linked cash amounts',async()=>{
 const w=make(),id=(await create(w))?.body.requestId,op=approve(w,id).operation;act(w,{type:'advance_time',hours:1});const initial=(await call(w,`/api/v1/transaction/${op.bank_transaction_id}`))?.body;
 const returned=act(w,{type:'return_bill_payment',operation_id:op.id,amount_minor:100,return_code:'R02',reason:'Bank returned part of original supplier payment',external_event_id:'actual-return-one'}),row=w.bankTransactions.find(t=>t.source_id===returned.operation.id)!;
 const original=(await call(w,`/api/v1/transaction/${op.bank_transaction_id}`))?.body,credit=(await call(w,`/api/v1/transaction/${row.id}`))?.body;
 assert.equal(original.id,initial.id);assert.equal(original.status,'sent');assert.equal(original.amount,-2.29);assert.equal(original.postedAt,initial.postedAt);assert.equal(original.finance_world.receipt_id,initial.finance_world.receipt_id);assert.equal(original.finance_world.amount_returned_minor,100);assert.equal(credit.amount,1);assert.notEqual(credit.id,original.id);assert.deepEqual(original.relatedTransactions,[{id:credit.id,accountId:'cash-bank',amount:1,relationKind:'OriginalTransactionToReturn'}]);assert.deepEqual(credit.relatedTransactions,[{id:original.id,accountId:'cash-bank',amount:-2.29,relationKind:'ReturnToOriginalTransaction'}]);
});

test('approval cursor pagination and transaction filters cover real records exactly and reject ignored criteria',async()=>{
 const w=make(),ids=[];for(let i=0;i<3;i++)ids.push((await create(w,body(w,i,`request-${i}`)))?.body.requestId);
 const first=(await call(w,'/api/v1/request-send-money?limit=2'))?.body;assert.deepEqual(first.requests.map((r:any)=>r.requestId),ids.slice(0,2));assert.equal(first.page.nextPage,ids[1]);
 const second=(await call(w,`/api/v1/request-send-money?limit=2&start_after=${first.page.nextPage}`))?.body;assert.deepEqual(second.requests.map((r:any)=>r.requestId),ids.slice(2));assert.equal(second.page.previousPage,ids[2]);
 const back=(await call(w,`/api/v1/request-send-money?limit=2&end_before=${ids[2]}`))?.body;assert.deepEqual(back.requests.map((r:any)=>r.requestId),ids.slice(0,2));
 act(w,{type:'decide_approval',approval_id:ids[1],decision:'reject'});assert.deepEqual((await call(w,'/api/v1/request-send-money?status=rejected'))?.body.requests.map((r:any)=>r.requestId),[ids[1]]);
 const op=approve(w,ids[0]).operation;assert.equal((await call(w,`/api/v1/account/cash-bank/transactions?status=pending&requestId=${ids[0]}&search=venue`))?.body.transactions[0].id,op.bank_transaction_id);
 assert.equal((await call(w,'/api/v1/account/cash-bank/transactions?start=2100-01-01'))?.body.total,0);
 for(const path of ['/api/v1/request-send-money?status=failed','/api/v1/request-send-money?limit=0','/api/v1/request-send-money?limit=1&limit=2','/api/v1/request-send-money?start_after=missing','/api/v1/request-send-money?start_after=a&end_before=b','/api/v1/account/cash-bank/transactions?status=approved','/api/v1/account/cash-bank/transactions?start=2026-02-30T09:00:00Z','/api/v1/account/cash-bank/transactions?start=2026-10-02&end=2026-10-01','/api/v1/account/cash-bank/transactions?offset=99999']){const before=structuredClone(w);await assert.rejects(()=>call(w,path));assert.deepEqual(w,before);}
 await rejected(w,'/api/v1/request-send-money?paymentMethod=ach','GET',undefined,'unsupported_filter');await rejected(w,'/api/v1/account/cash-bank/transactions?mercuryCategory=Fees','GET',undefined,'unsupported_filter');
});

test('native writes reject unsupported fields, guessed authorities, invalid cents and alternative rails atomically',async()=>{
 const w=make(),input=body(w),path='/api/v1/account/cash-bank/request-send-money';
 for(const extra of [{purpose:{}},{chargeType:'ours'},{currency:'USD'},{externalMemo:'not-supported'},{force:true},{beneficiary_id:'attacker'}])await rejected(w,path,'POST',{...input,...extra},'unsupported_field');
 await rejected(w,path,'POST',{...input,finance_world:{bill_id:w.bills[0].id,approval_id:'invented'}},'unsupported_field');await rejected(w,path,'POST',{...input,recipientId:w.bills[1].vendor_id},'supplier_payment_recipient_mismatch');
 for(const value of [0,-1,0.001,0.30000000000000004,10_000_000_000.01,'2.29',null])await rejected(w,path,'POST',{...input,amount:value},'invalid_amount');
 for(const method of ['domesticWire','internationalWire','check','realTimePayment',null])await rejected(w,path,'POST',{...input,paymentMethod:method},'unsupported_payment_method');
 for(const key of ['',null,' key-with-spaces ',1])await rejected(w,path,'POST',{...input,idempotencyKey:key},'invalid_parameter');
 await rejected(w,path,'POST',{...input,note:'a'.repeat(1001)},'invalid_parameter');await rejected(w,path,'POST',{...input,note:null},'invalid_parameter');
 const account=act(w,{type:'record_bank_account',name:'Independent EUR bank',currency:'EUR',external_account_id:'controller-eur-account',external_event_id:'euro-account'}).bank_account;
 await rejected(w,`/api/v1/account/${account.id}/request-send-money`,'POST',input,'unsupported_payment_account');
 const id=(await create(w))?.body.requestId,op=approve(w,id).operation;await rejected(w,`/api/v1/account/${account.id}/transaction/${op.bank_transaction_id}`,'GET',undefined,'resource_missing');
 for(const [path,method] of [['/api/v1/request-send-money/missing','DELETE'],['/api/v1/transaction/missing','PATCH'],['/api/v1/account/cash-bank/transactions','POST'],['/api/v1/recipients','GET']])assert.equal(await call(w,path,method,{}),undefined);
});

test('legacy settled transaction IDs and source records remain untouched by native reads',async()=>{
 const w=make(),result=act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:101},operator);act(w,{type:'advance_time',hours:1});
 const op=w.operations.find(row=>row.id===result.operation.id)!,bank=w.bankTransactions.find(row=>row.source_id===op.id)!;bank.id='banktx_legacy_101';delete op.bank_transaction_id;delete op.supplier_route;delete w.supplierRoutes;delete w.supplierRouteHolds;delete w.billPaymentOutcomes;delete w.billPaymentRequests;
 const before=structuredClone(w);const read=async(path:string)=>{const url=new URL(path,'http://local.test');return providerMercury({world:w,system:'mercury',route:url.pathname,url,method:'GET',execute:()=>{throw new Error('Read must never execute')}});};
 const detail=(await read('/api/v1/transaction/banktx_legacy_101'))?.body;assert.equal(detail.id,bank.id);assert.equal(detail.status,'sent');assert.equal(detail.finance_world.bank_transaction_id,bank.id);assert.equal((await read('/api/v1/account/cash-bank/transactions'))?.body.transactions.filter((row:any)=>row.finance_world.operation_id===op.id).length,1);await read('/api/v1/accounts');await read('/api/v1/request-send-money');assert.deepEqual(w,before);
 await assert.rejects(()=>read(`/api/v1/transaction/banktx-${op.id}`),(error:any)=>error.code==='resource_missing');
});

test('legacy approval without a recorded rail omits paymentMethod instead of fabricating ACH evidence',async()=>{
 const w=createWorld({kind:'supplier-fraud',orderCount:1,approvalThresholdMinor:100}),r=act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:101},operator),before=structuredClone(w),read=(await call(w,`/api/v1/request-send-money/${r.approval_id}`))?.body;
 assert.equal(read.status,'pendingApproval');assert.equal(Object.hasOwn(read,'paymentMethod'),false);assert.equal(read.finance_world.payment_method,null);assert.match(read.finance_world.unsupported_fields[0],/no recorded payment rail/);assert.deepEqual(w,before);
});

test('native reads immediately expose legacy return holds on sibling pending instructions and awaiting approvals',async()=>{
 const w=make(),first=(await create(w,body(w,0,'first-source',1)))?.body.requestId,paid=approve(w,first).operation;
 act(w,{type:'advance_time',hours:1});const pendingId=(await create(w,body(w,0,'sibling-source',2)))?.body.requestId,pending=approve(w,pendingId).operation,waitingId=(await create(w,body(w,0,'waiting-source',3)))?.body.requestId;
 const returned=act(w,{type:'return_bill_payment',operation_id:paid.id,amount_minor:50,return_code:'R02',reason:'Supplier account closed at bank',external_event_id:'legacy-return'}).payment_return;
 delete w.supplierRouteHolds;const before=structuredClone(w);const get=async(path:string)=>{const url=new URL(path,'http://local.test');return (await providerMercury({world:w,system:'mercury',route:url.pathname,url,method:'GET',execute:()=>{throw new Error('Read cannot write')}}))?.body;};
 const transaction=await get(`/api/v1/transaction/${pending.bank_transaction_id}`),approval=await get(`/api/v1/request-send-money/${waitingId}`);
 assert.equal(transaction.finance_world.last_error,null);assert.equal(transaction.finance_world.current_blocker.code,'supplier_route_on_hold');assert.deepEqual(transaction.finance_world.route_hold_ids,[]);assert.ok(transaction.finance_world.route_hold_source_ids.includes(returned.id));assert.equal(approval.finance_world.current_blocker.code,'supplier_route_on_hold');
 const evidence=w.documents.find(doc=>doc.return_id===returned.id)!;assert.ok(transaction.finance_world.source_document_ids.includes(evidence.id));assert.ok(approval.finance_world.source_document_ids.includes(evidence.id));assert.deepEqual(w,before);
 const historical=await get(`/api/v1/transaction/${paid.bank_transaction_id}`);assert.equal(historical.finance_world.current_blocker,null);assert.equal(historical.status,'sent');assert.deepEqual(w,before);
});

test('awaiting source binding and live provider blockers are visible before approval or another settlement attempt',async()=>{
 const w=make(),waitingId=(await create(w,body(w,0,'source-waiting',1)))?.body.requestId,otherId=(await create(w,body(w,1,'source-pending',2)))?.body.requestId,pending=approve(w,otherId).operation,vendor=w.vendors.find((v:any)=>v.id===w.bills[0].vendor_id)!;
 const successor=act(w,{type:'record_supplier_route',vendor_id:vendor.id,previous_route_id:vendor.verified_bank_account,verification_reference:'independent-portal-verification',verified_at:w.now,verification_method:'bank_portal',destination_reference:'independent-destination-ref',reason:'Bank portal verified successor',external_event_id:'source-successor'}).route;
 const before=structuredClone(w),waiting=(await call(w,`/api/v1/request-send-money/${waitingId}`))?.body;
 assert.equal(waiting.finance_world.current_blocker.code,'supplier_payment_source_changed');assert.ok(waiting.finance_world.source_document_ids.includes(successor.document_id));assert.deepEqual(w,before);
 act(w,{type:'set_fault',system:'mercury',mode:'offline'});const faultBefore=structuredClone(w),read=(await call(w,`/api/v1/transaction/${pending.bank_transaction_id}`))?.body;assert.equal(read.finance_world.last_error,null);assert.equal(read.finance_world.current_blocker.code,'connection_unavailable');assert.equal(read.finance_world.current_blocker.system,'mercury');assert.deepEqual(w,faultBefore);
 act(w,{type:'set_fault',system:'mercury',mode:'healthy'});act(w,{type:'close_period'});assert.equal((await call(w,`/api/v1/transaction/${pending.bank_transaction_id}`))?.body.finance_world.current_blocker,null);
});

test('an old pending instruction without a preallocated bank ID settles under its stable legacy fallback',async()=>{
 const w=make(),id=(await create(w))?.body.requestId,accepted=approve(w,id).operation,op=w.operations.find(row=>row.id===accepted.id)!;delete op.bank_transaction_id;
 const nativeId=`banktx-${op.id}`,pending=(await call(w,`/api/v1/transaction/${nativeId}`))?.body;assert.equal(pending.status,'pending');assert.equal(w.bankTransactions.some(t=>t.id===nativeId),false);
 act(w,{type:'advance_time',hours:1});const sent=(await call(w,`/api/v1/transaction/${nativeId}`))?.body;assert.equal(sent.id,pending.id);assert.equal(sent.status,'sent');assert.equal(sent.finance_world.bank_transaction_id,nativeId);assert.equal((await call(w,`/api/v1/account/cash-bank/transactions?requestId=${id}`))?.body.transactions.length,1);
});

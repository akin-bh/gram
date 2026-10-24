import {test,expect} from 'bun:test';
import {applyAction,createWorld,summarize,DomainError} from './world.ts';
const controller={id:'source-controller',role:'controller'} as const,operator={id:'finance-worker',role:'operator'} as const,reviewer={id:'reviewer',role:'controller'} as const;
function fixture(){const w=createWorld({kind:'saas-collections',orderCount:1,initialCashMinor:1000000,approvalThresholdMinor:10000});let next=0;const source=(a:any)=>applyAction(w,{...a,external_event_id:`source-${++next}`},controller).result,act=(a:any)=>applyAction(w,a,operator).result;return {w,source,act};}
const facts={issued_at:'2026-10-23T09:00:00.000Z',due_at:'2026-11-23T09:00:00.000Z',service_completed_at:'2026-10-22T09:00:00.000Z',completion_reference:'accepted-delivery-1'};
test('custom commercial sources recognize exact USD obligations only after completed contracted service and settle through verified routes',()=>{
 const {w,source,act}=fixture(),opening=summarize(w).cash_minor;
 const customer=source({type:'record_customer',external_customer_id:'customer-contract-source',name:'Workshop',email:'billing@workshop.test'}).customer;
 const vendor=source({type:'record_vendor',external_vendor_id:'vendor-contract-source',name:'Freight',email:'ap@freight.test'}).vendor;
 const contract=(kind:string,id:string,amount:number)=>source({type:'record_service_contract',external_contract_id:`signed-${kind}`,counterparty_kind:kind,counterparty_id:id,amount_minor:amount,description:'Accepted workshop services',signed_at:'2026-10-20T09:00:00.000Z'}).contract;
 const customerContract=contract('customer',customer.id,50000),vendorContract=contract('vendor',vendor.id,20000),before=w.bankTransactions.length;
 const invoice=source({type:'record_service_invoice',contract_id:customerContract.id,source_invoice_id:'sale-1',amount_minor:50000,...facts}).invoice;
 const bill=source({type:'record_service_bill',contract_id:vendorContract.id,source_invoice_id:'vendor-1',amount_minor:20000,...facts}).bill;
 expect(w.bankTransactions.length).toBe(before);expect(invoice.collection_mandate).toBe(`mandate-${customer.id}`);expect(bill.beneficiary_id).toBe(vendor.verified_bank_account);
 act({type:'collect_invoice',invoice_id:invoice.id});const pay=act({type:'pay_bill',bill_id:bill.id});expect(pay.status).toBe('awaiting_approval');applyAction(w,{type:'decide_approval',approval_id:pay.approval_id,decision:'approve'},reviewer);applyAction(w,{type:'advance_time',hours:1},controller);
 expect(summarize(w).cash_minor).toBe(opening+30000);expect(w.invoices.find(i=>i.id===invoice.id).status).toBe('paid');expect(w.bills.find(i=>i.id===bill.id).status).toBe('paid');expect(summarize(w).reconciliation.balanced).toBe(true);
});
test('source chronology, cumulative contract amount, duplicate invoices and raw route fields fail atomically',()=>{
 const {w,source}=fixture(),customer=source({type:'record_customer',external_customer_id:'unique-customer',name:'Studio',email:'billing@studio.test'}).customer,contract=source({type:'record_service_contract',external_contract_id:'contract-1',counterparty_kind:'customer',counterparty_id:customer.id,amount_minor:10000,description:'Completed design',signed_at:'2026-10-20T09:00:00.000Z'}).contract;
 const action={type:'record_service_invoice',contract_id:contract.id,source_invoice_id:'invoice-1',amount_minor:6000,...facts};source(action);
 for(const patch of [{source_invoice_id:'invoice-2',amount_minor:4001},{source_invoice_id:'invoice-1',amount_minor:1000},{source_invoice_id:'invoice-3',service_completed_at:'2026-10-19T09:00:00.000Z'},{source_invoice_id:'invoice-3',service_completed_at:'2026-10-24T09:00:00.000Z'},{source_invoice_id:'invoice-3',bank_account:'redirect'}]){const before=JSON.stringify(w);expect(()=>source({...action,...patch})).toThrow(DomainError);expect(JSON.stringify(w)).toBe(before);}
 expect(()=>source({type:'record_customer',external_customer_id:'evil',name:'Bad',email:'billing@real-domain.com',verified_collection_mandate:'unverified'})).toThrow();
 const before=JSON.stringify(w);expect(()=>applyAction(w,{type:'record_vendor',external_vendor_id:'forged',name:'Forged',email:'ap@forged.test',external_event_id:'agent-forged'},operator)).toThrow();expect(JSON.stringify(w)).toBe(before);
});
test('disabled route preserves invoice and bill recognition while blocking both approval and later settlement',()=>{
 const {w,source,act}=fixture(),vendor=source({type:'record_vendor',external_vendor_id:'v1',name:'Supply',email:'ap@supply.test'}).vendor;
 source({type:'set_counterparty_status',kind:'vendor',counterparty_id:vendor.id,enabled:false,reason:'Bank verification pending'});
 const contract=source({type:'record_service_contract',external_contract_id:'c1',counterparty_kind:'vendor',counterparty_id:vendor.id,amount_minor:20000,description:'Received service',signed_at:'2026-10-20T09:00:00.000Z'}).contract,bill=source({type:'record_service_bill',contract_id:contract.id,source_invoice_id:'b1',amount_minor:20000,...facts}).bill;
 expect(()=>act({type:'pay_bill',bill_id:bill.id})).toThrow(/disabled/);source({type:'set_counterparty_status',kind:'vendor',counterparty_id:vendor.id,enabled:true,reason:'Verified route recovered'});const requested=act({type:'pay_bill',bill_id:bill.id});applyAction(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},reviewer);
 source({type:'set_counterparty_status',kind:'vendor',counterparty_id:vendor.id,enabled:false,reason:'Bank froze route after approval'});const cash=summarize(w).cash_minor;applyAction(w,{type:'advance_time',hours:1},controller);expect(summarize(w).cash_minor).toBe(cash);expect(w.bills.find(b=>b.id===bill.id).amount_paid_minor).toBe(0);
 source({type:'set_counterparty_status',kind:'vendor',counterparty_id:vendor.id,enabled:true,reason:'Verified bank recovery'});applyAction(w,{type:'advance_time',hours:1},controller);expect(summarize(w).cash_minor).toBe(cash-20000);expect(w.bills.find(b=>b.id===bill.id).status).toBe('paid');
});
test('new inventory master data starts at zero and registered source facts never fabricate stock or balances',()=>{
 const {w,source}=fixture(),cash=summarize(w).cash_minor,journals=w.journals.length;const item=source({type:'record_inventory_item',external_item_id:'inventory-master',sku:'KIT-1',name:'Kit'}).item;
 expect(item.quantity_on_hand).toBe(0);expect(item.inventory_value_minor).toBe(0);expect(summarize(w).cash_minor).toBe(cash);expect(w.journals.length).toBe(journals);
 expect(()=>source({type:'record_inventory_item',external_item_id:'duplicate-sku',sku:'kit-1',name:'Another kit'})).toThrow(/SKU/);
});

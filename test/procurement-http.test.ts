import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.ts';
import { hash } from '../src/store.ts';

const base='http://127.0.0.1:24300';
async function fixture(database=':memory:') {
  const service=await createService({database,baseUrl:base,agentEnabled:false,deliveryIntervalMs:0});
  const home=await service.fetch(new Request(base)),cookie=home.headers.get('set-cookie')!.split(';')[0];
  const call=async(path:string,input?:any,token?:string,key:string=randomUUID())=>{
    const response=await service.fetch(new Request(base+path,{method:input===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:{Cookie:cookie}),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},...(input===undefined?{}:{body:JSON.stringify(input)})}));
    return {status:response.status,data:await response.json()};
  };
  const connect=async(world:string,system:string)=>{
    const started=await call(`/api/worlds/${world}/connect/${system}`,{});assert.equal(started.status,200);
    const url=new URL(started.data.authorization_url),info=await service.fetch(new Request(`${base}/oauth/${system}/consent${url.search}`,{headers:{Cookie:cookie}}));
    assert.equal(info.status,200);const details=await info.json();assert.equal(details.world,world);assert.equal(details.provider.id,system);
    const params=new URLSearchParams(url.search);params.set('decision','allow');
    const allowed=await service.fetch(new Request(base+url.pathname,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:params}));assert.equal(allowed.status,303);
    const callback=await service.fetch(new Request(allowed.headers.get('location')!,{headers:{Cookie:cookie}}));assert.equal(callback.status,303);
  };
  const create=async(input:any={})=>{const created=await call('/api/worlds',{kind:'procurement-matching',seed:82,orderCount:4,...input});assert.equal(created.status,201,JSON.stringify(created.data));return created.data.world;};
  const agent=(world:string)=>{const token=randomUUID();service.store.put('agent-tokens',hash(token),{world,actor:`agent-world:${world}`,expires_at:Date.now()+60000});return token;};
  const act=async(world:string,input:any,token?:string,key?:string)=>call(`/api/worlds/${world}/actions`,input,token,key);
  return {service,call,connect,create,agent,act};
}
const okay=(response:any)=>{assert.equal(response.status,200,JSON.stringify(response.data));return response.data.result;};

test('procurement gateway requires source grants and distinct PO approval; internal approvals are never public actions',async()=>{
  const f=await fixture();
  try{
    const w=await f.create(),token=f.agent(w.id),path=`/api/worlds/${w.id}`;
    const context=(await f.call(path+'/context',undefined,token)).data;
    assert.ok(context.available_actions.includes('create_purchase_order'));assert.ok(!context.available_actions.includes('approve_purchase_order'));
    for(const type of ['authorize_purchase','receive_goods','receive_supplier_invoice','correct_supplier_invoice','authorize_inventory_issue','return_inventory'])assert.equal((await f.act(w.id,{type,external_event_id:'forged'},token)).status,403,type);
    assert.equal((await f.act(w.id,{type:'approve_purchase_order',purchase_order_id:w.purchaseOrders[0].id},token)).status,400);
    assert.equal((await f.call(path+'/records?system=zip&feed=purchase-order',undefined,token)).status,401);
    const item=w.inventoryItems[0],vendor=w.vendors[0];
    const authority=okay(await f.act(w.id,{type:'authorize_purchase',vendor_id:vendor.id,lines:[{item_id:item.id,quantity:3,max_unit_price_minor:200}],purpose:'Authorized replacement equipment',external_event_id:'new-purchase-authority'})).requisition;
    const orderInput={type:'create_purchase_order',vendor_id:vendor.id,lines:[{item_id:item.id,quantity:3,unit_price_minor:200}],document_ids:[authority.document_id],reason:'Replace approved equipment'};
    assert.equal((await f.act(w.id,orderInput,token)).status,401);
    await f.connect(w.id,'zip');
    const requested=okay(await f.act(w.id,orderInput,token,'one-po'));assert.equal(requested.status,'awaiting_approval');
    assert.equal(okay(await f.act(w.id,orderInput,token,'one-po')).purchase_order.id,requested.purchase_order.id);
    assert.equal((await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},token)).status,403);
    okay(await f.act(w.id,{type:'set_fault',system:'zip',mode:'offline'}));
    assert.equal((await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'})).status,503);
    assert.equal(f.service.store.world(w.id).approvals.find((a:any)=>a.id===requested.approval_id).status,'pending');
    okay(await f.act(w.id,{type:'set_fault',system:'zip',mode:'healthy'}));
    okay(await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'}));
    assert.equal(f.service.store.world(w.id).purchaseOrders.find((p:any)=>p.id===requested.purchase_order.id).status,'approved');
    const visible=await f.call(path+'/records?system=zip&feed=purchase-order',undefined,token);assert.equal(visible.status,200);assert.ok(visible.data.data.some((p:any)=>p.id===requested.purchase_order.id));
    assert.equal(f.service.store.verify(w.id).valid,true);
  }finally{await f.service.close();}
});

test('three-way matching holds real exceptions, consumes each receipt once, creates one payable and survives restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'finance-procurement-')),db=join(dir,'world.sqlite');let f=await fixture(db);
  try{
    const w=await f.create(),token=f.agent(w.id),path=`/api/worlds/${w.id}`;
    for(const system of ['netsuite','mercury','gmail','zip'])await f.connect(w.id,system);
    const before=w.bills.length;
    const outputs:any[]=[];for(const invoice of w.supplierInvoices)outputs.push(okay(await f.act(w.id,{type:'match_supplier_invoice',supplier_invoice_id:invoice.id},token)));
    assert.equal(outputs[0].status,'matched');assert.equal(outputs[1].status,'blocked');assert.equal(outputs[2].status,'blocked');assert.equal(outputs[3].status,'blocked');
    assert.ok(outputs[1].issues.some((i:any)=>i.code==='receipt_shortfall'));assert.ok(outputs[2].issues.some((i:any)=>i.code==='price_mismatch'));assert.ok(outputs[3].issues.some((i:any)=>i.code==='receipt_shortfall'));
    assert.equal(f.service.store.world(w.id).bills.length,before+1);
    const first=w.supplierInvoices[0],duplicate=okay(await f.act(w.id,{type:'receive_supplier_invoice',vendor_id:first.vendor_id,purchase_order_id:first.purchase_order_id,invoice_number:first.invoice_number,lines:first.lines.map((l:any)=>({po_line_id:l.po_line_id,quantity:l.quantity,unit_price_minor:l.unit_price_minor})),external_event_id:'another-delivery'}));
    assert.equal(duplicate.duplicate,true);assert.equal(duplicate.supplier_invoice.id,first.id);
    const rematch=okay(await f.act(w.id,{type:'match_supplier_invoice',supplier_invoice_id:first.id},token));assert.equal(rematch.bill.id,outputs[0].bill.id);assert.equal(f.service.store.world(w.id).bills.length,before+1);
    // Correct a physical shortfall by recording the remaining real delivery.
    const partial=w.purchaseOrders.find((p:any)=>p.id===w.supplierInvoices[1].purchase_order_id),line=partial.lines[0];
    const receipt={type:'receive_goods',purchase_order_id:partial.id,lines:[{po_line_id:line.id,quantity:line.quantity-line.received_quantity}],external_event_id:'warehouse-delivery-remaining',reference:'RECEIPT-REMAINING'};
    const received=okay(await f.act(w.id,receipt));const replay=okay(await f.act(w.id,receipt));assert.equal(replay.replayed,true);
    const corrected=okay(await f.act(w.id,{type:'match_supplier_invoice',supplier_invoice_id:w.supplierInvoices[1].id},token));assert.equal(corrected.status,'matched');
    // A supplier correction preserves the old invoice revision instead of overriding match policy.
    const variance=w.supplierInvoices[2],ordered=w.purchaseOrders.find((p:any)=>p.id===variance.purchase_order_id);
    okay(await f.act(w.id,{type:'correct_supplier_invoice',supplier_invoice_id:variance.id,lines:variance.lines.map((l:any)=>({po_line_id:l.po_line_id,quantity:l.quantity,unit_price_minor:ordered.lines.find((p:any)=>p.id===l.po_line_id).unit_price_minor})),reason:'Supplier corrected transcription error',external_event_id:'supplier-correction-1'}));
    assert.equal(okay(await f.act(w.id,{type:'match_supplier_invoice',supplier_invoice_id:variance.id},token)).status,'matched');
    const snapshot=(await f.call(path)).data;assert.equal(snapshot.world.bills.length,before+3);assert.equal(snapshot.world.supplierInvoices[2].revisions.length,1);
    assert.equal(snapshot.summary.reconciliation.balanced,true);assert.equal(snapshot.summary.reconciliation.bank_ledger_difference_minor,0);
    assert.equal((await f.call(`/providers/netsuite/worlds/${w.id}/services/rest/record/v1/vendorBill`)).data.totalResults,before+3);
    const pay=okay(await f.act(w.id,{type:'pay_bill',bill_id:outputs[0].bill.id},token));assert.equal(pay.status,'awaiting_approval');
    okay(await f.act(w.id,{type:'decide_approval',approval_id:pay.approval_id,decision:'approve'}));okay(await f.act(w.id,{type:'advance_time',hours:1}));
    const original=f.service.store.world(w.id);assert.equal(original.bills.find((b:any)=>b.id===outputs[0].bill.id).status,'paid');assert.equal(f.service.store.verify(w.id).valid,true);
    await f.service.close();f=await fixture(db);const persisted=(await f.call(path)).data;
    assert.equal(persisted.world.bills.filter((b:any)=>b.supplier_invoice_id===first.id).length,1);assert.equal(persisted.world.goodsReceipts.length,original.goodsReceipts.length);assert.equal(persisted.world.bills.find((b:any)=>b.id===outputs[0].bill.id).status,'paid');assert.equal(persisted.summary.reconciliation.balanced,true);assert.equal(f.service.store.verify(w.id).valid,true);
  }finally{await f.service.close();rmSync(dir,{recursive:true,force:true});}
});

test('physical receipts and original-cost inventory returns remain facts while ledger posting is unavailable',async()=>{
  const f=await fixture();
  try{
    const w=await f.create(),token=f.agent(w.id),path=`/api/worlds/${w.id}`;await f.connect(w.id,'netsuite');
    const item=w.inventoryItems[0],openingQty=item.quantity_on_hand,openingValue=item.inventory_value_minor;
    const authority=okay(await f.act(w.id,{type:'authorize_inventory_issue',lines:[{item_id:item.id,quantity:2}],purpose:'Approved internal deployment',external_event_id:'stock-authority'})).authorization;
    okay(await f.act(w.id,{type:'close_period'}));
    const issued=okay(await f.act(w.id,{type:'issue_inventory',authorization_id:authority.id,lines:[{item_id:item.id,quantity:2}]},token));
    assert.equal((await f.act(w.id,{type:'issue_inventory',authorization_id:authority.id,lines:[{item_id:item.id,quantity:1}]},token)).status,403);
    okay(await f.act(w.id,{type:'set_fault',system:'netsuite',mode:'offline'}));
    const returned=okay(await f.act(w.id,{type:'return_inventory',issue_id:issued.movement.id,lines:[{item_id:item.id,quantity:1}],reason:'Unused item returned intact',external_event_id:'stock-return-1'}));
    assert.equal(returned.movement.value_minor,issued.movement.value_minor/2);
    let s=(await f.call(path)).data;assert.equal(s.world.inventoryItems[0].quantity_on_hand,openingQty-1);assert.equal(s.world.inventoryItems[0].inventory_value_minor,openingValue-returned.movement.value_minor);assert.equal(s.summary.unposted_settlements,2);
    assert.equal((await f.act(w.id,{type:'return_inventory',issue_id:issued.movement.id,lines:[{item_id:item.id,quantity:2}],reason:'Too much',external_event_id:'excess-return'})).status,409);
    okay(await f.act(w.id,{type:'reopen_period'}));s=(await f.call(path)).data;assert.equal(s.summary.unposted_settlements,2);
    okay(await f.act(w.id,{type:'set_fault',system:'netsuite',mode:'healthy'}));okay(await f.act(w.id,{type:'advance_time',hours:1}));s=(await f.call(path)).data;
    assert.equal(s.summary.unposted_settlements,0);assert.equal(s.world.accounts.find((a:any)=>a.id==='inventory').balance_minor,s.world.inventoryItems.reduce((sum:number,i:any)=>sum+i.inventory_value_minor,0));assert.equal(s.summary.reconciliation.balanced,true);
    assert.equal(s.summary.reconciliation.bank_ledger_difference_minor,0);assert.equal(f.service.store.verify(w.id).valid,true);
  }finally{await f.service.close();}
});

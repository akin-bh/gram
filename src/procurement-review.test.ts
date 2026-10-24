import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,createWorld,summarize} from './world.ts';
import type {Action,World} from './world.ts';

const judge={id:'independent-review-controller',role:'controller'} as const;
const buyer={id:'independent-review-agent',role:'agent'} as const;
const act=(w:World,input:Action,actor:typeof judge|typeof buyer=judge)=>applyAction(w,input,actor).result;
function unchangedOnReject(w:World,input:Action,code:string,actor:typeof judge|typeof buyer=buyer){const before=structuredClone(w);assert.throws(()=>act(w,input,actor),(error:any)=>error.code===code);assert.deepEqual(w,before);}
function order(w:World,itemId:string,quantity:number,price:number,suffix:string){
  const vendor=w.vendors[0],requisition=act(w,{type:'authorize_purchase',vendor_id:vendor.id,lines:[{item_id:itemId,quantity,max_unit_price_minor:price}],purpose:'Adversarial review purchase',external_event_id:`review-authority-${suffix}`}).requisition;
  const pending=act(w,{type:'create_purchase_order',vendor_id:vendor.id,document_ids:[requisition.document_id],reason:requisition.purpose,lines:[{item_id:itemId,quantity,unit_price_minor:price}]},buyer);
  return act(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'approve'}).purchase_order;
}
function receive(w:World,po:any,quantity:number,suffix:string){return act(w,{type:'receive_goods',purchase_order_id:po.id,lines:[{po_line_id:po.lines[0].id,quantity}],reference:`review-${suffix}`,external_event_id:`review-receipt-${suffix}`}).receipt;}
function assertSubledgers(w:World,posted=true){
  for(const item of w.inventoryItems){
    const lots=w.inventoryLots.filter((lot:any)=>lot.item_id===item.id);
    assert.equal(item.quantity_on_hand,lots.reduce((sum:number,lot:any)=>sum+lot.quantity_on_hand,0));
    assert.equal(item.inventory_value_minor,lots.reduce((sum:number,lot:any)=>sum+lot.quantity_on_hand*lot.unit_cost_minor,0));
    assert.ok(Number.isSafeInteger(item.inventory_value_minor)&&item.inventory_value_minor>=0);
    for(const lot of lots)assert.ok(Number.isSafeInteger(lot.quantity_on_hand)&&lot.quantity_on_hand>=0&&lot.quantity_on_hand<=lot.quantity_received);
  }
  for(const po of w.purchaseOrders)for(const line of po.lines){
    const receipts=w.goodsReceipts.filter((row:any)=>row.purchase_order_id===po.id).flatMap((row:any)=>row.lines).filter((row:any)=>row.po_line_id===line.id);
    const invoiced=w.supplierInvoices.filter((row:any)=>row.purchase_order_id===po.id&&row.status==='matched').flatMap((row:any)=>row.lines).filter((row:any)=>row.po_line_id===line.id);
    assert.equal(line.received_quantity,receipts.reduce((sum:number,row:any)=>sum+row.quantity,0));
    assert.equal(line.billed_quantity,invoiced.reduce((sum:number,row:any)=>sum+row.quantity,0));
    assert.equal(line.billed_quantity,receipts.reduce((sum:number,row:any)=>sum+row.billed_quantity,0));
    assert.ok(line.billed_quantity<=line.received_quantity&&line.received_quantity<=line.quantity);
    for(const receipt of receipts)assert.ok(receipt.billed_quantity<=receipt.quantity);
  }
  for(const authorization of w.inventoryAuthorizations)for(const line of authorization.lines){
    const movements=w.inventoryMovements.filter((row:any)=>row.authorization_id===authorization.id);
    const issued=movements.reduce((sum:number,row:any)=>sum+(row.type==='issue'?1:-1)*row.lines.filter((entry:any)=>entry.item_id===line.item_id).reduce((n:number,entry:any)=>n+entry.quantity,0),0);
    assert.equal(line.issued_quantity,issued);assert.ok(issued>=0&&issued<=line.quantity);
  }
  const matched=w.supplierInvoices.filter((invoice:any)=>invoice.status==='matched');
  assert.equal(w.bills.length,matched.length);assert.equal(new Set(w.bills.map(bill=>bill.supplier_invoice_id)).size,w.bills.length);
  if(posted){
    const balances=new Map(w.accounts.map(account=>[account.id,account.balance_minor]));
    assert.equal(balances.get('inventory'),w.inventoryItems.reduce((sum:number,item:any)=>sum+item.inventory_value_minor,0));
    assert.equal(balances.get('grni'),-(w.goodsReceipts.reduce((sum:number,row:any)=>sum+row.amount_minor,0)-matched.reduce((sum:number,row:any)=>sum+row.amount_minor,0))||0);
    assert.equal(balances.get('payables'),-w.bills.reduce((sum,bill)=>sum+bill.amount_minor-bill.amount_paid_minor,0)||0);
    const summary=summarize(w);assert.equal(summary.reconciliation.balanced,true);assert.equal(summary.reconciliation.bank_ledger_difference_minor,0);
  }
}

test('purchase authority reserves cumulative pending orders, releases rejected capacity, and cannot be promoted by supplied fields',()=>{
  const w=createWorld({kind:'procurement-matching',orderCount:1}),item=w.inventoryItems[2],vendor=w.vendors[0];
  const requisition=act(w,{type:'authorize_purchase',vendor_id:vendor.id,lines:[{item_id:item.id,quantity:5,max_unit_price_minor:1234}],purpose:'Five replacements only',external_event_id:'review-five-only'}).requisition;
  const input=(quantity:number)=>({type:'create_purchase_order',vendor_id:vendor.id,document_ids:[requisition.document_id],reason:'Replace five devices',lines:[{item_id:item.id,quantity,unit_price_minor:1234}],status:'approved',approved_by:judge.id,approval_id:'forged'});
  const first=act(w,input(3),buyer);assert.equal(first.purchase_order.status,'awaiting_approval');
  unchangedOnReject(w,input(3),'purchase_authority_required');
  const second=act(w,input(2),buyer);unchangedOnReject(w,input(1),'purchase_authority_required');
  unchangedOnReject(w,{type:'approve_purchase_order',purchase_order_id:first.purchase_order.id,approval_id:first.approval_id,approved:true},'separate_controller_required');
  unchangedOnReject(w,{type:'receive_goods',purchase_order_id:first.purchase_order.id,lines:[{po_line_id:first.purchase_order.lines[0].id,quantity:1}],reference:'Not yet authorized',external_event_id:'review-unapproved-receipt'},'purchase_order_not_approved',judge);
  act(w,{type:'decide_approval',approval_id:first.approval_id,decision:'reject'});
  const replacement=act(w,input(3),buyer);assert.equal(replacement.purchase_order.status,'awaiting_approval');unchangedOnReject(w,input(1),'purchase_authority_required');
  const approved=act(w,{type:'decide_approval',approval_id:second.approval_id,decision:'approve'}).purchase_order;
  const goods=act(w,{type:'receive_goods',purchase_order_id:approved.id,lines:[{po_line_id:approved.lines[0].id,quantity:2,item_id:w.inventoryItems[0].id,unit_cost_minor:1,amount_minor:1}],reference:'Verified delivery',external_event_id:'review-authoritative-cost'}).receipt;
  assert.equal(goods.lines[0].item_id,item.id);assert.equal(goods.lines[0].unit_cost_minor,1234);assert.equal(goods.amount_minor,2468);
  unchangedOnReject(w,{type:'receive_goods',purchase_order_id:approved.id,lines:[{po_line_id:approved.lines[0].id,quantity:1}],reference:'Extra unapproved item',external_event_id:'review-over-receipt'},'over_receipt',judge);
  assertSubledgers(w);
});

test('supplier corrections retain revision identity and replay cannot restore old prices or create a second payable',()=>{
  const w=createWorld({kind:'procurement-matching',orderCount:3,seed:29}),invoice=w.supplierInvoices[2],po=w.purchaseOrders[2];
  const original=w.generationHistory.find((event:any)=>event.action.type==='receive_supplier_invoice'&&event.result.supplier_invoice.id===invoice.id).action;
  const correction={type:'correct_supplier_invoice',supplier_invoice_id:invoice.id,lines:po.lines.map((line:any)=>({po_line_id:line.id,quantity:line.quantity,unit_price_minor:line.unit_price_minor})),reason:'Supplier confirmed approved unit price',external_event_id:'review-corrected-invoice'};
  const corrected=act(w,correction);assert.equal(corrected.supplier_invoice.revision,2);assert.equal(corrected.supplier_invoice.revisions[0].amount_minor,invoice.amount_minor);
  assert.equal(act(w,original).replayed,true);assert.equal(w.supplierInvoices[2].revision,2);assert.equal(w.supplierInvoices[2].amount_minor,po.amount_minor);
  unchangedOnReject(w,{...original,external_event_id:'review-stale-original-delivery'},'duplicate_invoice_conflict',judge);
  unchangedOnReject(w,{...correction,lines:[{...correction.lines[0],unit_price_minor:1}]},'external_event_conflict',judge);
  const matched=act(w,{type:'match_supplier_invoice',supplier_invoice_id:invoice.id},buyer);assert.equal(matched.bill.amount_minor,po.amount_minor);
  const duplicate=act(w,{...original,lines:correction.lines,external_event_id:'review-corrected-resend'});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.supplier_invoice.id,invoice.id);assert.equal(duplicate.delivery.revision,2);
  assert.equal(act(w,{type:'match_supplier_invoice',supplier_invoice_id:invoice.id},buyer).already_matched,true);assert.equal(w.bills.length,1);
  unchangedOnReject(w,{...correction,external_event_id:'review-rewrite-matched'},'matched_invoice_locked',judge);assertSubledgers(w);
});

test('source facts survive close and outage; FIFO issues, returns and authority reuse reconcile across seeds',()=>{
  for(let seed=1;seed<=8;seed++){
    const w=createWorld({kind:'procurement-matching',orderCount:4,seed,procurementControls:{periodClosed:true}}),initialCash=summarize(w).cash_minor;
    act(w,{type:'set_fault',system:'ledger',mode:'offline'});act(w,{type:'set_fault',system:'netsuite',mode:'offline'});
    for(const po of [...w.purchaseOrders]){
      const missing=po.lines[0].quantity-po.lines[0].received_quantity;if(missing)receive(w,po,missing,`${seed}-${po.id}`);
    }
    for(const invoice of [...w.supplierInvoices]){
      const po=w.purchaseOrders.find((row:any)=>row.id===invoice.purchase_order_id);
      if(invoice.lines[0].unit_price_minor!==po.lines[0].unit_price_minor)act(w,{type:'correct_supplier_invoice',supplier_invoice_id:invoice.id,lines:po.lines.map((line:any)=>({po_line_id:line.id,quantity:line.quantity,unit_price_minor:line.unit_price_minor})),reason:'Confirmed corrected supplier price',external_event_id:`review-correct-${seed}`});
    }
    const before=structuredClone(w);assert.throws(()=>act(w,{type:'match_supplier_invoice',supplier_invoice_id:w.supplierInvoices[0].id},buyer),(error:any)=>error.code==='connection_unavailable');assert.deepEqual(w,before);assertSubledgers(w,false);
    act(w,{type:'set_fault',system:'netsuite',mode:'healthy'});
    for(const invoice of [...w.supplierInvoices])act(w,{type:'match_supplier_invoice',supplier_invoice_id:invoice.id},buyer);
    assertSubledgers(w,false);assert.equal(w.bills.length,4);assert.equal(summarize(w).cash_minor,initialCash);
    act(w,{type:'reopen_period'});assert.ok(w.settledUnposted.length>0); // Ledger is still unavailable.
    act(w,{type:'set_fault',system:'ledger',mode:'healthy'});act(w,{type:'advance_time',hours:1});assertSubledgers(w);assert.equal(w.settledUnposted.length,0);
    const item=w.inventoryItems[0],lots=w.inventoryLots.filter((lot:any)=>lot.item_id===item.id),quantity=lots[0].quantity_on_hand+1;
    const authorization=act(w,{type:'authorize_inventory_issue',lines:[{item_id:item.id,quantity}],purpose:'FIFO valuation review',external_event_id:`review-stock-authority-${seed}`}).authorization;
    const issue=act(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:item.id,quantity}],value_minor:1,allocations:[]},buyer).movement;
    assert.equal(issue.lines[0].allocations.length,2);assert.equal(issue.value_minor,lots[0].quantity_on_hand*lots[0].unit_cost_minor+lots[1].unit_cost_minor);assertSubledgers(w);
    const returned=Math.floor(quantity/2),originalValue=issue.lines[0].allocations[0].unit_cost_minor*returned;
    const movement=act(w,{type:'return_inventory',issue_id:issue.id,lines:[{item_id:item.id,quantity:returned}],reason:'Unused units returned',unit_cost_minor:1,external_event_id:`review-stock-return-${seed}`}).movement;
    assert.equal(movement.value_minor,originalValue);assertSubledgers(w);
    act(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:item.id,quantity:returned}]},buyer);assertSubledgers(w);
    unchangedOnReject(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:item.id,quantity:1}]},'inventory_authority_exceeded');
    unchangedOnReject(w,{type:'return_inventory',issue_id:issue.id,lines:[{item_id:item.id,quantity}],reason:'Return cannot exceed original unreturned units',external_event_id:`review-return-too-many-${seed}`},'inventory_return_exceeds_issue',judge);
    const journalCount=w.journals.length;act(w,{type:'advance_time',hours:1});assert.equal(w.journals.length,journalCount);assertSubledgers(w);
  }
});

test('closed-period aggregate inventory issue cannot create an unpostable journal beyond the money limit',()=>{
  const w=createWorld({kind:'procurement-matching',orderCount:1}),item=w.inventoryItems[2];
  for(let index=0;index<2;index++){const po=order(w,item.id,1000,1000000000,`large-${index}`);receive(w,po,1000,`large-${index}`);}
  assert.equal(w.inventoryItems[2].inventory_value_minor,2000000000000);
  const authorization=act(w,{type:'authorize_inventory_issue',lines:[{item_id:item.id,quantity:2000}],purpose:'Bounded posting review',external_event_id:'review-large-issue-authority'}).authorization;
  act(w,{type:'close_period'});
  unchangedOnReject(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:item.id,quantity:2000}]},'invalid_integer');
  act(w,{type:'reopen_period'});assertSubledgers(w);
});

import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError,normalizeWorld,recordsFor,summarize} from './world.ts';
import type {Action,Actor,World} from './world.ts';

const operator:Actor={id:'procurement-worker',role:'agent'},controller:Actor={id:'warehouse-controller',role:'controller'};
const act=(w:World,action:Action,actor:Actor=controller)=>applyAction(w,action,actor).result;
const world=()=>createWorld({kind:'procurement-matching',orderCount:1,approvalThresholdMinor:1_000_000_000,seed:'procurement-test'});
function rejects(w:World,action:Action,code:string,actor:Actor=operator){const previous=structuredClone(w);expect(()=>act(w,action,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(previous);}
function balances(w:World){
  for(const journal of w.journals)expect(journal.lines.reduce((sum:number,line:any)=>sum+line.debit_minor-line.credit_minor,0)).toBe(0);
  expect(w.accounts.reduce((sum:number,account:any)=>sum+account.balance_minor,0)).toBe(0);
  const effective=(id:string)=>w.accounts.find(account=>account.id===id).balance_minor+w.operations.filter(operation=>operation.status==='settled'&&!operation.journal_id).flatMap(operation=>operation.journal_lines??[]).filter(line=>line.account_id===id).reduce((sum,line)=>sum+(line.debit_minor??0)-(line.credit_minor??0),0);
  const stock=w.inventoryLots.reduce((sum:number,lot:any)=>sum+lot.quantity_on_hand*lot.unit_cost_minor,0);
  expect(effective('inventory')).toBe(stock);expect(summarize(w).inventory_value_minor).toBe(stock);
  for(const item of w.inventoryItems){expect(item.quantity_on_hand).toBe(w.inventoryLots.filter((lot:any)=>lot.item_id===item.id).reduce((sum:number,lot:any)=>sum+lot.quantity_on_hand,0));expect(item.inventory_value_minor).toBe(w.inventoryLots.filter((lot:any)=>lot.item_id===item.id).reduce((sum:number,lot:any)=>sum+lot.quantity_on_hand*lot.unit_cost_minor,0));expect(item.quantity_on_hand>=0).toBeTruthy();}
  const unbilled=w.goodsReceipts.flatMap((receipt:any)=>receipt.lines).reduce((sum:number,line:any)=>sum+(line.quantity-line.billed_quantity)*line.unit_cost_minor,0);
  expect(effective('grni')).toBe(0-unbilled);expect(summarize(w).grni_minor).toBe(unbilled);
  expect(effective('payables')).toBe(0-w.bills.reduce((sum:number,bill:any)=>sum+bill.amount_minor-bill.amount_paid_minor,0));
}
function purchase(w:World,quantity:number,price:number,item='item-cable',suffix='manual'){
  const requisition=act(w,{type:'authorize_purchase',vendor_id:w.vendors[0].id,lines:[{item_id:item,quantity,max_unit_price_minor:price}],purpose:'Approved fulfillment replenishment',external_event_id:`authority-${suffix}`}).requisition;
  const requested=act(w,{type:'create_purchase_order',vendor_id:w.vendors[0].id,document_ids:[requisition.document_id],lines:[{item_id:item,quantity,unit_price_minor:price}],reason:'Replenish under the warehouse requisition'},operator);
  return act(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'}).purchase_order;
}
const receive=(w:World,po:any,quantity:number,event:string)=>act(w,{type:'receive_goods',purchase_order_id:po.id,lines:[{po_line_id:po.lines[0].id,quantity}],reference:`warehouse-${event}`,external_event_id:event});
const invoice=(w:World,po:any,quantity:number,price:number,number:string)=>act(w,{type:'receive_supplier_invoice',vendor_id:po.vendor_id,purchase_order_id:po.id,invoice_number:number,lines:[{po_line_id:po.lines[0].id,quantity,unit_price_minor:price}],external_event_id:`invoice-${number}`}).supplier_invoice;
const match=(w:World,id:string)=>act(w,{type:'match_supplier_invoice',supplier_invoice_id:id},operator);

test('procurement seed uses actual authorities, approvals and receipts with four distinct exception cases',()=>{
  const w=createWorld({kind:'procurement-matching',seed:19});
  expect(w).toStrictEqual(createWorld({kind:'procurement-matching',seed:19}));
  expect(w.purchaseOrders.length).toBe(4);expect(w.supplierInvoices.length).toBe(4);expect(w.supplierInvoiceDeliveries.length).toBe(5);expect(w.bills.length).toBe(0);expect(w.invoices.length).toBe(0);
  expect(w.supplierInvoiceDeliveries.filter((delivery:any)=>delivery.duplicate).length).toBe(1);
  for(const po of w.purchaseOrders){const approval=w.approvals.find((approval:any)=>approval.id===po.approval_id);expect(approval.status).toBe('approved');expect(approval.requested_by).not.toBe(approval.decided_by);expect(w.documents.some(doc=>doc.id===po.document_id)).toBeTruthy();}
  const valid=match(w,w.supplierInvoices[0].id);expect(valid.status).toBe('matched');
  expect(match(w,w.supplierInvoices[1].id).issues.map((issue:any)=>issue.code)).toStrictEqual(['receipt_shortfall']);
  expect(match(w,w.supplierInvoices[2].id).issues.map((issue:any)=>issue.code)).toStrictEqual(['price_mismatch']);
  expect(match(w,w.supplierInvoices[3].id).issues.map((issue:any)=>issue.code)).toStrictEqual(['receipt_shortfall']);
  expect(summarize(w).unmatched_supplier_invoices).toBe(3);expect(w.bills.length).toBe(1);balances(w);
  expect(recordsFor(w,'netsuite','purchase-order')).toStrictEqual(w.purchaseOrders);expect(recordsFor(w,'zip','purchase-requisition')).toStrictEqual(w.purchaseRequisitions);expect(recordsFor(w,'ledger','inventory-lot')).toStrictEqual(w.inventoryLots);
  expect(createWorld({kind:'procurement-matching',orderCount:8}).purchaseOrders.length).toBe(8);
  expect(createWorld({kind:'procurement-matching',orderCount:1}).goodsReceipts.length).toBe(1);
});

test('every PO requires grounded cumulative requisition authority and a distinct approving controller, even at one cent',()=>{
  const w=world(),vendor=w.vendors[0],line={item_id:'item-cable',quantity:6,max_unit_price_minor:1};
  rejects(w,{type:'authorize_purchase',vendor_id:vendor.id,lines:[line],purpose:'Unauthorized',external_event_id:'bad-authority'},'controller_required');
  const requisition=act(w,{type:'authorize_purchase',vendor_id:vendor.id,lines:[line],purpose:'Six replacement cables',external_event_id:'six-cables'}).requisition;
  const request={type:'create_purchase_order',vendor_id:vendor.id,lines:[{item_id:'item-cable',quantity:3,unit_price_minor:1}],document_ids:[requisition.document_id],reason:'First three cables'};
  rejects(w,{...request,document_ids:['policy-payments']},'purchase_authority_required');
  rejects(w,{...request,lines:[{item_id:'item-cable',quantity:3,unit_price_minor:2}]},'purchase_authority_required');
  const first=act(w,request,operator);expect(first.status).toBe('awaiting_approval');expect(first.approval.amount_minor).toBe(3);
  rejects(w,{...request,lines:[{item_id:'item-cable',quantity:4,unit_price_minor:1}]},'purchase_authority_required');
  rejects(w,{type:'approve_purchase_order',purchase_order_id:first.purchase_order.id},'separate_controller_required',controller);
  rejects(w,{type:'decide_approval',approval_id:first.approval_id,decision:'approve'},'separate_controller_required',{id:operator.id,role:'controller'});
  rejects(w,{type:'receive_goods',purchase_order_id:first.purchase_order.id,lines:[{po_line_id:first.purchase_order.lines[0].id,quantity:1}],reference:'Unapproved delivery',external_event_id:'unapproved-delivery'},'purchase_order_not_approved',controller);
  act(w,{type:'decide_approval',approval_id:first.approval_id,decision:'reject'});expect(w.purchaseOrders.find((po:any)=>po.id===first.purchase_order.id).status).toBe('rejected');
  const next=act(w,{...request,lines:[{item_id:'item-cable',quantity:6,unit_price_minor:1}]},operator);act(w,{type:'decide_approval',approval_id:next.approval_id,decision:'approve'});
  expect(w.purchaseOrders.find((po:any)=>po.id===next.purchase_order.id).status).toBe('approved');balances(w);
});

test('partial receipts and successive invoice matches consume only unused quantities and create linked payable once',()=>{
  const w=world(),po=purchase(w,10,1250),initialValue=summarize(w).inventory_value_minor,initialGrni=summarize(w).grni_minor;
  receive(w,po,3,'first-truck');const first=invoice(w,po,2,1250,'FIRST'),firstMatch=match(w,first.id);
  expect(firstMatch.bill.amount_minor).toBe(2500);expect(firstMatch.bill.purchase_order_id).toBe(po.id);expect(firstMatch.bill.supplier_invoice_id).toBe(first.id);expect(firstMatch.bill.match_status).toBe('matched');
  expect(summarize(w).inventory_value_minor-initialValue).toBe(3750);expect(summarize(w).grni_minor-initialGrni).toBe(1250);
  const oversized=invoice(w,po,2,1250,'SECOND');expect(match(w,oversized.id).status).toBe('blocked');expect(w.bills.length).toBe(1);
  receive(w,po,5,'second-truck');const second=match(w,oversized.id);expect(second.status).toBe('matched');
  const third=invoice(w,po,4,1250,'THIRD');expect(match(w,third.id).status).toBe('matched');expect(w.bills.length).toBe(3);
  const actual=w.purchaseOrders.find((entry:any)=>entry.id===po.id);expect(actual.lines[0].received_quantity).toBe(8);expect(actual.lines[0].billed_quantity).toBe(8);expect(actual.status).toBe('partially_received');
  expect(summarize(w).grni_minor).toBe(initialGrni);expect(summarize(w).inventory_value_minor-initialValue).toBe(10000);expect(summarize(w).payables_minor).toBe(10000);
  const beforeJournals=w.journals.length;expect(match(w,third.id).already_matched).toBe(true);expect(w.bills.length).toBe(3);expect(w.journals.length).toBe(beforeJournals);
  const cash=summarize(w).cash_minor;const payment=act(w,{type:'pay_bill',bill_id:firstMatch.bill.id},operator);expect(payment.operation.status).toBe('pending');act(w,{type:'advance_time',hours:1});
  expect(summarize(w).cash_minor).toBe(cash-2500);expect(summarize(w).payables_minor).toBe(7500);expect(w.bills.find(bill=>bill.id===firstMatch.bill.id).status).toBe('paid');balances(w);
});

test('price correction preserves supplier history; duplicate deliveries cannot create a second obligation',()=>{
  const w=world(),po=purchase(w,5,2000);receive(w,po,5,'complete-receipt');
  const source=invoice(w,po,5,2200,'PRICE-ERROR'),before=w.journals.length,blocked=match(w,source.id);expect(blocked.issues[0].code).toBe('price_mismatch');expect(w.journals.length).toBe(before);expect(w.bills.length).toBe(0);
  const corrected=act(w,{type:'correct_supplier_invoice',supplier_invoice_id:source.id,lines:[{po_line_id:po.lines[0].id,quantity:5,unit_price_minor:2000}],reason:'Supplier acknowledged erroneous unit price',external_event_id:'correction-1'}).supplier_invoice;
  expect(corrected.revision).toBe(2);expect(corrected.revisions[0].amount_minor).toBe(11000);expect(corrected.amount_minor).toBe(10000);expect(w.documents.some(doc=>doc.id===corrected.revisions[0].document_id)).toBeTruthy();
  const result=match(w,corrected.id);expect(result.bill.amount_minor).toBe(10000);expect(w.purchaseOrders.find((entry:any)=>entry.id===po.id).status).toBe('closed');
  const invoices=w.supplierInvoices.length,bills=w.bills.length,journals=w.journals.length;
  const duplicate=act(w,{type:'receive_supplier_invoice',vendor_id:po.vendor_id,purchase_order_id:po.id,invoice_number:'price-error',lines:[{po_line_id:po.lines[0].id,quantity:5,unit_price_minor:2000}],external_event_id:'resend-price-error'});
  expect(duplicate.delivery.duplicate).toBe(true);expect(w.supplierInvoices.length).toBe(invoices);expect(w.bills.length).toBe(bills);expect(w.journals.length).toBe(journals);
  rejects(w,{type:'receive_supplier_invoice',vendor_id:po.vendor_id,purchase_order_id:po.id,invoice_number:'PRICE-ERROR',lines:[{po_line_id:po.lines[0].id,quantity:6,unit_price_minor:2000}],external_event_id:'conflicting-copy'},'duplicate_invoice_conflict',controller);
  rejects(w,{type:'correct_supplier_invoice',supplier_invoice_id:source.id,lines:[{po_line_id:po.lines[0].id,quantity:1,unit_price_minor:2000}],reason:'Attempt to rewrite a posted obligation',external_event_id:'rewrite-matched'},'matched_invoice_locked',controller);balances(w);
});

test('receipts and matches reject over-receiving and over-billing atomically without erasing supplier facts',()=>{
  const w=world(),po=purchase(w,4,1000);receive(w,po,3,'partial-receipt');
  rejects(w,{type:'receive_goods',purchase_order_id:po.id,lines:[{po_line_id:po.lines[0].id,quantity:2}],reference:'Too many',external_event_id:'over-receipt'},'over_receipt',controller);
  const inflated=invoice(w,po,5,1000,'EXCESS');expect(match(w,inflated.id).issues.map((issue:any)=>issue.code)).toStrictEqual(['invoice_exceeds_order','receipt_shortfall']);expect(w.bills.length).toBe(0);
  rejects(w,{type:'receive_goods',purchase_order_id:po.id,lines:[{po_line_id:po.lines[0].id,quantity:0.5}],reference:'Fractional',external_event_id:'fractional-receipt'},'invalid_integer',controller);
  rejects(w,{type:'receive_supplier_invoice',purchase_order_id:po.id,vendor_id:w.vendors[1].id,invoice_number:'WRONG',lines:[{po_line_id:po.lines[0].id,quantity:1,unit_price_minor:1000}],external_event_id:'wrong-vendor'},'vendor_mismatch',controller);balances(w);
});

test('FIFO stock issues require typed authority and returns restore original lot costs, even after newer receipts',()=>{
  const w=world(),first=purchase(w,3,1000,'item-cable','fifo-first'),second=purchase(w,4,2000,'item-cable','fifo-second');receive(w,first,3,'fifo-truck-first');receive(w,second,4,'fifo-truck-second');
  const authorization=act(w,{type:'authorize_inventory_issue',lines:[{item_id:'item-cable',quantity:6}],purpose:'Replace six certified devices',external_event_id:'six-stock'}).authorization;
  rejects(w,{type:'issue_inventory',authorization_id:'policy-payments',lines:[{item_id:'item-cable',quantity:1}]},'not_found');
  rejects(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:'item-cable',quantity:7}]},'inventory_authority_exceeded');
  const issue=act(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:'item-cable',quantity:5}]},operator).movement;
  expect(issue.value_minor).toBe(7000);expect(issue.lines[0].allocations.map((a:any)=>[a.quantity,a.unit_cost_minor])).toStrictEqual([[3,1000],[2,2000]]);
  const third=purchase(w,1,9000,'item-cable','fifo-third');receive(w,third,1,'fifo-truck-third');
  const returned=act(w,{type:'return_inventory',issue_id:issue.id,lines:[{item_id:'item-cable',quantity:4}],reason:'Four devices unused and physically returned',external_event_id:'return-four'}).movement;
  expect(returned.value_minor).toBe(5000);expect(returned.lines[0].allocations.map((a:any)=>[a.quantity,a.unit_cost_minor])).toStrictEqual([[3,1000],[1,2000]]);
  const remainingReturn=act(w,{type:'return_inventory',issue_id:issue.id,lines:[{item_id:'item-cable',quantity:1}],reason:'Final device returned',external_event_id:'return-last'}).movement;expect(remainingReturn.value_minor).toBe(2000);
  expect(w.inventoryAuthorizations.find((a:any)=>a.id===authorization.id).lines[0].issued_quantity).toBe(0);
  rejects(w,{type:'return_inventory',issue_id:issue.id,lines:[{item_id:'item-cable',quantity:1}],reason:'Duplicate physical return',external_event_id:'return-too-many'},'inventory_return_exceeds_issue',controller);
  expect(w.inventoryItems.find((item:any)=>item.id==='item-cable').inventory_value_minor).toBe(20000);balances(w);
});

test('an authorization cannot issue absent stock and split issues cannot exceed its net quantity',()=>{
  const w=world(),authorization=act(w,{type:'authorize_inventory_issue',lines:[{item_id:'item-case',quantity:10}],purpose:'Stock use for repair',external_event_id:'stock-case-authority'}).authorization;
  rejects(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:'item-case',quantity:1}]},'insufficient_inventory');
  const po=purchase(w,12,300,'item-case','cases');receive(w,po,12,'case-truck');
  act(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:'item-case',quantity:6}]},operator);
  rejects(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:'item-case',quantity:5}]},'inventory_authority_exceeded');
  act(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:'item-case',quantity:4}]},operator);expect(w.inventoryItems.find((item:any)=>item.id==='item-case').quantity_on_hand).toBe(2);balances(w);
});

test('locked periods and ledger outages defer procurement accounting while preserving external goods and exact recovery',()=>{
  const w=world(),po=purchase(w,4,1700),priorInventory=w.accounts.find(account=>account.id==='inventory').balance_minor;
  act(w,{type:'close_period'});const received=receive(w,po,4,'locked-receipt');const supplied=invoice(w,po,3,1700,'LOCKED'),matched=match(w,supplied.id);
  expect(received.operation.accounting_status).toBe('pending_posting');expect(matched.operation.accounting_status).toBe('pending_posting');expect(w.accounts.find(account=>account.id==='inventory').balance_minor).toBe(priorInventory);
  expect(w.bills[0].amount_minor).toBe(5100);expect(w.settledUnposted.length).toBe(2);balances(w);
  act(w,{type:'set_fault',system:'netsuite',mode:'offline'});act(w,{type:'reopen_period'});expect(w.settledUnposted.length).toBe(2);
  rejects(w,{type:'match_supplier_invoice',supplier_invoice_id:w.supplierInvoices[0].id},'connection_unavailable');
  act(w,{type:'set_fault',system:'netsuite',mode:'healthy'});act(w,{type:'advance_time',hours:1});expect(w.settledUnposted.length).toBe(0);expect(w.accounts.find(account=>account.id==='inventory').balance_minor).toBe(priorInventory+6800);balances(w);
  const journals=w.journals.length,bank=structuredClone(w.bankTransactions);act(w,{type:'advance_time',hours:1});expect(w.journals.length).toBe(journals);expect(w.bankTransactions).toStrictEqual(bank);
  const authorization=act(w,{type:'authorize_inventory_issue',lines:[{item_id:'item-cable',quantity:1}],purpose:'Service usage',external_event_id:'locked-use-authority'}).authorization;
  const issue=act(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:'item-cable',quantity:1}]},operator).movement;
  act(w,{type:'set_fault',system:'netsuite',mode:'offline'});const returned=act(w,{type:'return_inventory',issue_id:issue.id,lines:[{item_id:'item-cable',quantity:1}],reason:'Unneeded stock',external_event_id:'offline-return'});
  expect(returned.operation.accounting_status).toBe('pending_posting');balances(w);act(w,{type:'set_fault',system:'netsuite',mode:'healthy'});act(w,{type:'advance_time',hours:1});balances(w);
});

test('external event replay is immutable and approval email uses the durable outbox',()=>{
  const w=world();act(w,{type:'set_fault',system:'gmail',mode:'offline'});const po=purchase(w,2,1000);expect(w.messages.some(message=>message.source_refs.includes(po.id)&&message.delivery_status==='queued')).toBeTruthy();
  const action={type:'receive_goods',purchase_order_id:po.id,lines:[{po_line_id:po.lines[0].id,quantity:1}],reference:'Receipt proof',external_event_id:'stable-physical-fact'};
  const first=act(w,action),receipts=w.goodsReceipts.length,journals=w.journals.length;const replay=act(w,action);expect(replay.replayed).toBe(true);expect(replay.receipt.id).toBe(first.receipt.id);expect(w.goodsReceipts.length).toBe(receipts);expect(w.journals.length).toBe(journals);
  rejects(w,{...action,reference:'Changed receipt'},'external_event_conflict',controller);rejects(w,action,'controller_required');
  act(w,{type:'set_fault',system:'gmail',mode:'healthy'});act(w,{type:'advance_time',hours:1});expect(w.messages.filter(message=>message.source_refs.includes(po.id)).every(message=>message.delivery_status==='delivered')).toBeTruthy();balances(w);
});

test('new procurement accounts cannot be fabricated by manual journals and old worlds normalize additively',()=>{
  const w=world();for(const account of ['inventory','grni'])rejects(w,{type:'post_journal',lines:[{account_id:account,debit_minor:500},{account_id:'equity',credit_minor:500}]},'control_account_locked');
  const old=createWorld({kind:'saas-collections',orderCount:1}),prior=structuredClone({journals:old.journals,bank:old.bankTransactions,accounts:old.accounts.filter(account=>!['inventory','grni','inventory-expense'].includes(account.id))});
  for(const key of ['purchaseRequisitions','purchaseOrders','goodsReceipts','supplierInvoices','supplierInvoiceDeliveries','inventoryItems','inventoryLots','inventoryMovements','inventoryAuthorizations'])delete old[key];old.accounts=prior.accounts;
  normalizeWorld(old);expect(old.journals).toStrictEqual(prior.journals);expect(old.bankTransactions).toStrictEqual(prior.bank);expect(old.accounts.find(account=>account.id==='inventory').balance_minor).toBe(0);expect(recordsFor(old,'netsuite','inventory-item')).toStrictEqual([]);
});

test('procurement controls alter real receipts, variance and deferred journals without inventing settlements',()=>{
  const w=createWorld({kind:'procurement-matching',orderCount:4,procurementControls:{partialReceiptPercent:0,priceVariancePercent:0,duplicateInvoice:false,periodClosed:true},initialFaults:[{system:'netsuite',mode:'offline'}]});
  expect(w.goodsReceipts.length).toBe(2);expect(w.supplierInvoiceDeliveries.length).toBe(4);expect(w.settledUnposted.length).toBe(2);expect(w.accounts.find(account=>account.id==='inventory').balance_minor).toBe(0);expect(w.bankTransactions.length).toBe(1);balances(w);
  act(w,{type:'set_fault',system:'netsuite',mode:'healthy'});expect(match(w,w.supplierInvoices[2].id).status).toBe('matched');act(w,{type:'reopen_period'});expect(w.settledUnposted.length).toBe(0);expect(w.bankTransactions.length).toBe(1);balances(w);
  expect(()=>createWorld({kind:'procurement-matching',orderCount:201})).toThrow(DomainError);
  for(const procurementControls of [{partialReceiptPercent:100},{priceVariancePercent:-1},{duplicateInvoice:'yes'},{unknown:true}])expect(()=>createWorld({kind:'procurement-matching',procurementControls:procurementControls as any})).toThrow(DomainError);
  expect(()=>createWorld({kind:'treasury',procurementControls:{}})).toThrow(DomainError);
});

test('a combined inventory issue cannot queue a journal larger than accounting can post after reopening',()=>{
  const w=world(),cables=purchase(w,1000,600_000_000,'item-cable','large-cables'),cases=purchase(w,1000,600_000_000,'item-case','large-cases');
  act(w,{type:'close_period'});receive(w,cables,1000,'large-cable-delivery');receive(w,cases,1000,'large-case-delivery');
  const authorization=act(w,{type:'authorize_inventory_issue',lines:[{item_id:'item-cable',quantity:1000},{item_id:'item-case',quantity:1000}],purpose:'Two approved equipment deployments',external_event_id:'large-stock-use'}).authorization;
  rejects(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id:'item-cable',quantity:1000},{item_id:'item-case',quantity:1000}]},'invalid_integer');
  expect(w.inventoryMovements.length).toBe(0);expect(w.settledUnposted.length).toBe(2);balances(w);
  // Each distinct deployment stays within the same documented exact-money cap.
  for(const item_id of ['item-cable','item-case'])act(w,{type:'issue_inventory',authorization_id:authorization.id,lines:[{item_id,quantity:1000}]},operator);
  expect(w.settledUnposted.length).toBe(4);balances(w);act(w,{type:'reopen_period'});expect(w.settledUnposted.length).toBe(0);balances(w);
});

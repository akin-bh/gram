import { test, expect } from 'bun:test';
import {createWorld,applyAction,summarize,DomainError} from './world.ts';
import type {World} from './world.ts';
import {providerRequest} from './provider-adapters.ts';
const controller={id:'judge',role:'controller'} as const,agent={id:'agent',role:'agent'} as const;
function request(world:World,system:string,path:string,method='GET',input?:any){const url=new URL(path,'http://local.test');return providerRequest({world,system,route:url.pathname,url,method,input,execute:action=>applyAction(world,action,agent).result});}
function advance(world:World){applyAction(world,{type:'advance_time',hours:1},controller);}

test('Stripe refund maps one economic effect across payment, charge, bank and partial refund states',async()=>{
  const w=createWorld({orderCount:2}),p=w.payments[0],amount=Math.floor(p.refundable_minor/2),opening=summarize(w).cash_minor;
  const before=await request(w,'stripe',`/v1/payment_intents/${p.id}`);expect(before?.body.amount_received).toBe(p.amount_minor);
  const pending=await request(w,'stripe','/v1/refunds','POST',{payment_intent:p.id,amount});
  expect(pending?.body.object).toBe('refund');expect(pending?.body.status).toBe('pending');expect(pending?.body.payment_intent).toBe(p.id);
  advance(w);
  const refund=await request(w,'stripe',`/v1/refunds/${pending?.body.id}`),charge=await request(w,'stripe',`/v1/charges/ch_${p.id}`);
  expect(refund?.body.status).toBe('succeeded');expect(charge?.body.amount_refunded).toBe(amount);expect(charge?.body.refunded).toBe(false);
  expect(charge?.body.refunds.data[0].id).toBe(pending?.body.id);expect(summarize(w).cash_minor).toBe(opening-amount);
  const account=await request(w,'mercury','/api/v1/accounts');expect(account?.body.accounts[0].currentBalance).toBe((opening-amount)/100);
  const transactions=await request(w,'mercury','/api/v1/account/cash-bank/transactions');expect(transactions?.body.transactions[0].amount).toBe(-amount/100);
});

test('Stripe high-value approval does not pretend a refund exists before a controller decision',async()=>{
  const w=createWorld({orderCount:1,approvalThresholdMinor:100});
  const result=await request(w,'stripe','/v1/refunds','POST',{charge:`ch_${w.payments[0].id}`,amount:500});
  expect(result?.status).toBe(202);expect(result?.body.object).toBe('finance_world.approval_required');expect(w.refunds.length).toBe(0);
  applyAction(w,{type:'decide_approval',approval_id:result?.body.approval_id,decision:'approve'},controller);
  expect(w.refunds.length).toBe(1);advance(w);
  const list=await request(w,'stripe',`/v1/refunds?payment_intent=${w.payments[0].id}`);expect(list?.body.data[0].status).toBe('succeeded');
});

test('Stripe pagination covers the collection once and rejects unsupported filtering',async()=>{
  const w=createWorld({orderCount:21});let cursor='',ids:string[]=[];
  do{const page=await request(w,'stripe','/v1/payment_intents?limit=6'+(cursor?'&starting_after='+cursor:''));ids.push(...page?.body.data.map((p:any)=>p.id));cursor=page?.body.has_more?page.body.data.at(-1).id:'';}while(cursor);
  expect(ids.length).toBe(21);expect(new Set(ids).size).toBe(21);
  await expect(request(w,'stripe','/v1/payment_intents?created[gte]=0')).rejects.toThrowSatisfying((error:any)=>error instanceof DomainError&&error.status===501);
  await expect(request(w,'stripe','/v1/payment_intents?starting_after=missing')).rejects.toThrow(/Unknown pagination/);
});

test('Stripe dispute reads and explicit local evidence submission preserve the processor outcome boundary',async()=>{
  const w=createWorld({orderCount:2}),payment=w.payments[0];
  const opened=applyAction(w,{type:'open_dispute',payment_id:payment.id,amount_minor:500,reason:'fraudulent',external_event_id:'issuer-open-one'},controller).result;
  const id=opened.dispute.id,read=await request(w,'stripe',`/v1/disputes/${id}`);
  expect(read?.body.object).toBe('dispute');expect(read?.body.status).toBe('needs_response');expect(read?.body.payment_intent).toBe(payment.id);expect(read?.body.charge).toBe(`ch_${payment.id}`);expect(read?.body.evidence_details.has_evidence).toBe(false);
  const bank=summarize(w).cash_minor;
  const submitted=await request(w,'stripe',`/v1/disputes/${id}`,'POST',{finance_world_evidence:{document_ids:['contract-promoter'],statement:'The captured ticket was purchased under the signed promoter terms.'},submit:true});
  expect(submitted?.body.status).toBe('under_review');expect(submitted?.body.evidence_details.submission_count).toBe(1);expect(submitted?.body.finance_world_evidence.document_ids).toStrictEqual(['contract-promoter']);expect(summarize(w).cash_minor).toBe(bank);
  const again=await request(w,'stripe',`/v1/disputes/${id}`,'POST',{finance_world_evidence:{document_ids:['contract-promoter'],statement:'The captured ticket was purchased under the signed promoter terms.'}});expect(again?.body.evidence_details.submission_count).toBe(1);
  const charge=await request(w,'stripe',`/v1/charges/ch_${payment.id}`);expect(charge?.body.disputed).toBe(true);
  await expect(request(w,'stripe',`/v1/disputes/${id}`,'POST',{status:'won',finance_world_evidence:{document_ids:['contract-promoter'],statement:'Change outcome'}})).rejects.toThrow(/Unsupported body field/);
  await expect(request(w,'stripe',`/v1/disputes/${id}`,'POST',{evidence:{uncategorized_text:'Unsupported automatic authority'}})).rejects.toThrow(/Unsupported body field/);
  await expect(request(w,'stripe',`/v1/disputes/${id}`,'POST',{finance_world_evidence:{document_ids:['missing-doc'],statement:'Unsupported'},submit:true})).rejects.toThrow(/Source document not found/);
  await expect(request(w,'stripe',`/v1/disputes/${id}`,'POST',{finance_world_evidence:{document_ids:['contract-promoter'],statement:'Draft'},submit:false})).rejects.toThrow(/Only immediate evidence submission/);
  applyAction(w,{type:'resolve_dispute',dispute_id:id,outcome:'won',external_event_id:'issuer-won-one'},controller);
  const resolved=await request(w,'stripe',`/v1/disputes/${id}`);expect(resolved?.body.status).toBe('won');expect(summarize(w).cash_minor).toBe(bank+500);
  await expect(request(w,'stripe',`/v1/disputes/${id}`,'POST',{finance_world_evidence:{document_ids:['contract-promoter'],statement:'Late change'}})).rejects.toThrow(/resolved dispute/);
});

test('Stripe dispute lists filter and paginate without interpreting unsupported filters as success',async()=>{
  const w=createWorld({orderCount:3});
  for(let i=0;i<3;i++)applyAction(w,{type:'open_dispute',payment_id:w.payments[i].id,amount_minor:100,reason:'Customer reports service issue',external_event_id:`issuer-${i}`},controller);
  const first=await request(w,'stripe','/v1/disputes?limit=2');expect(first?.body.data.length).toBe(2);expect(first?.body.has_more).toBe(true);expect(first?.body.data[0].reason).toBe('general');expect(first?.body.data[0].metadata.finance_world_reason).toBe('Customer reports service issue');
  const last=await request(w,'stripe',`/v1/disputes?limit=2&starting_after=${first?.body.data[1].id}`);expect(last?.body.data.length).toBe(1);expect(last?.body.has_more).toBe(false);
  const filter=await request(w,'stripe',`/v1/disputes?payment_intent=${w.payments[1].id}`);expect(filter?.body.data.length).toBe(1);expect(filter?.body.data[0].payment_intent).toBe(w.payments[1].id);
  await expect(request(w,'stripe','/v1/disputes?status=won')).rejects.toThrow(/Unsupported query parameter/);
  await expect(request(w,'stripe','/v1/disputes/missing')).rejects.toThrowSatisfying((e:any)=>e.status===404);
  expect(await request(w,'stripe','/v1/disputes','POST',{payment_intent:w.payments[0].id})).toBeUndefined();
});

test('Stripe credit notes authorize only their original collected invoice refund and expose its settlement',async()=>{
  const w=createWorld({kind:'saas-collections',orderCount:1,approvalThresholdMinor:100000000}),invoice=w.invoices[0],amount=Math.min(10000,invoice.amount_minor);
  const collection=applyAction(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:amount},agent).result;advance(w);
  const payment=w.payments.find(p=>p.operation_id===collection.operation.id)!;
  const issued=applyAction(w,{type:'issue_credit_note',invoice_id:invoice.id,payment_id:payment.id,amount_minor:5000,reason:'Controller approved a service concession',external_event_id:'credit-issued-1'},controller).result;
  const note=await request(w,'stripe',`/v1/credit_notes/${issued.credit_note.id}`);expect(note?.body.object).toBe('credit_note');expect(note?.body.invoice).toBe(invoice.id);expect(note?.body.amount).toBe(5000);expect(note?.body.post_payment_amount).toBe(5000);expect(note?.body.status).toBe('issued');
  const notes=await request(w,'stripe',`/v1/credit_notes?invoice=${invoice.id}&customer=${invoice.customer_id}`);expect(notes?.body.data.length).toBe(1);
  await expect(request(w,'stripe','/v1/refunds','POST',{payment_intent:payment.id,amount:5000})).rejects.toThrow(/issued credit note/);
  const refund=await request(w,'stripe','/v1/refunds','POST',{payment_intent:payment.id,amount:5000,credit_note_id:note?.body.id});expect(refund?.body.status).toBe('pending');expect(refund?.body.metadata.finance_world_credit_note_id).toBe(note?.body.id);
  advance(w);
  const completed=await request(w,'stripe',`/v1/credit_notes/${note?.body.id}`);expect(completed?.body.metadata.finance_world_status).toBe('refunded');expect(completed?.body.metadata.finance_world_refunded_minor).toBe('5000');expect(completed?.body.refunds).toStrictEqual([{amount:5000,refund:refund?.body.id}]);
  const invoiceView=await request(w,'stripe',`/v1/invoices/${invoice.id}`);expect(invoiceView?.body.post_payment_credit_notes_amount).toBe(5000);expect(invoiceView?.body.amount_paid).toBe(amount);
  expect(summarize(w).reconciliation.balanced).toBe(true);expect(summarize(w).reconciliation.bank_ledger_difference_minor).toBe(0);
  expect(await request(w,'stripe','/v1/credit_notes','POST',{invoice:invoice.id,amount:100})).toBeUndefined();
  await expect(request(w,'stripe','/v1/credit_notes?status=issued')).rejects.toThrow(/Unsupported query parameter/);
});

test('provider projection upgrades legacy collections before reading disputes or credits',async()=>{
  const w=createWorld({orderCount:1});delete w.disputes;delete w.creditNotes;
  const disputes=await request(w,'stripe','/v1/disputes'),credits=await request(w,'stripe','/v1/credit_notes');expect(disputes?.body.data).toStrictEqual([]);expect(credits?.body.data).toStrictEqual([]);
});

test('Gmail sends and reads RFC 2822 UTF-8 text, labels and threads backed by canonical messages',async()=>{
  const w=createWorld({orderCount:2});
  const mime=['From: finance@simulation.test','To: Fan <fan1@example.test>','Subject: =?UTF-8?B?UmVmdW5kIOKckw==?=','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','','Your refund is in progress.'].join('\r\n');
  const sent=await request(w,'gmail','/gmail/v1/users/me/messages/send','POST',{raw:Buffer.from(mime).toString('base64url')});
  expect(sent?.body.payload.headers.find((h:any)=>h.name==='Subject').value).toBe('Refund ✓');
  expect(w.messages.at(-1).to).toStrictEqual(['fan1@example.test']);expect(w.messages.at(-1).body).toBe('Your refund is in progress.');
  const raw=await request(w,'gmail',`/gmail/v1/users/me/messages/${sent?.body.id}?format=raw`);
  expect(Buffer.from(raw?.body.raw,'base64url').toString()).toBe(mime);
  const thread=await request(w,'gmail',`/gmail/v1/users/me/threads/${sent?.body.threadId}`);expect(thread?.body.messages[0].id).toBe(sent?.body.id);
  const search=await request(w,'gmail','/gmail/v1/users/me/messages?labelIds=SENT&q=to:fan1@example.test');expect(search?.body.messages.length).toBe(1);
  const attachments=await request(w,'gmail','/gmail/v1/users/me/messages?q=has:attachment');expect(attachments?.body.messages).toStrictEqual([]);
  await expect(request(w,'gmail','/gmail/v1/users/me/messages?q=has:drive')).rejects.toThrow(/Unsupported Gmail search/);
});

test('unsupported MIME is rejected before an email is added and malformed bodies do not succeed',async()=>{
  const w=createWorld(),before=w.messages.length;
  const mime='To: fan@example.test\r\nSubject: Test\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x';
  await expect(request(w,'gmail','/gmail/v1/users/me/messages/send','POST',{raw:Buffer.from(mime).toString('base64url')})).rejects.toThrow(/Malformed or unterminated multipart/);
  await expect(request(w,'gmail','/gmail/v1/users/me/messages/send','POST',{raw:'not!base64'})).rejects.toThrow(/base64url/);
  expect(w.messages.length).toBe(before);
});

test('Plaid incremental sync uses debit-positive amounts and later exposes only newly settled bank rows',async()=>{
  const w=createWorld({orderCount:2});
  const first=await request(w,'plaid','/transactions/sync','POST',{count:500});
  expect(first?.body.added[0].amount).toBe(-w.bankTransactions[0].amount_minor/100);expect(first?.body.has_more).toBe(false);
  applyAction(w,{type:'refund',payment_id:w.payments[0].id,amount_minor:100},agent);advance(w);
  const next=await request(w,'plaid','/transactions/sync','POST',{cursor:first?.body.next_cursor});
  expect(next?.body.added.length).toBe(1);expect(next?.body.added[0].amount).toBe(1);
  const empty=await request(w,'plaid','/transactions/sync','POST',{cursor:next?.body.next_cursor});expect(empty?.body.added).toStrictEqual([]);
  const accounts=await request(w,'plaid','/accounts/get','POST',{});expect(accounts?.body.accounts[0].balances.current).toBe(summarize(w).cash_minor/100);
});

test('QuickBooks and NetSuite reflect shared invoice payments and the same balanced journal',async()=>{
  const w=createWorld({kind:'saas-collections',orderCount:4},'realm-1'),invoice=w.invoices[0];
  applyAction(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:1000},agent);advance(w);
  const qb=await request(w,'quickbooks',`/v3/company/realm-1/invoice/${invoice.id}`);
  const ns=await request(w,'netsuite',`/services/rest/record/v1/invoice/${invoice.id}`);
  expect(qb?.body.Invoice.Balance).toBe((invoice.amount_minor-1000)/100);expect(ns?.body.amountRemaining).toBe(qb?.body.Invoice.Balance);
  const query=await request(w,'quickbooks','/v3/company/realm-1/query?query='+encodeURIComponent('SELECT * FROM Invoice STARTPOSITION 2 MAXRESULTS 2'));expect(query?.body.QueryResponse.Invoice[0].Id).toBe(w.invoices[1].id);expect(query?.body.QueryResponse.Invoice.length).toBe(2);
  const last=w.journals.at(-1);const journal=await request(w,'netsuite',`/services/rest/record/v1/journalEntry/${last.id}`);
  expect(journal?.body.line.items.reduce((sum:number,line:any)=>sum+line.debit-line.credit,0)).toBe(0);
  await expect(request(w,'quickbooks','/v3/company/wrong/query?query=SELECT%20*%20FROM%20Invoice')).rejects.toThrow(/Realm must match/);
  await expect(request(w,'netsuite','/services/rest/record/v1/invoice?q=amountRemaining%20GREATER%200')).rejects.toThrow(/Unsupported query/);
});

test('Ramp bills use the same paid state and unsupported writes return undefined without mutation',async()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:3});
  applyAction(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:100},agent);advance(w);
  const bills=await request(w,'ramp','/developer/v1/bills?status=PARTIALLY_PAID');expect(bills?.body.data.length).toBe(1);expect(bills?.body.data[0].amount).toBe(w.bills[0].amount_minor);
  const before=structuredClone(w);expect(await request(w,'ramp','/developer/v1/bills','POST',{amount:1})).toBeUndefined();
  expect(await request(w,'stripe','/v1/payment_intents','POST',{amount:1})).toBeUndefined();
  expect(await request(w,'gmail','/gmail/v1/users/me/messages/batchDelete','POST',{ids:['all']})).toBeUndefined();
  expect(w).toStrictEqual(before);
});

function procurementWorld(){
  const w=createWorld({kind:'supplier-fraud',orderCount:1},'procurement-realm');
  const vendor=w.vendors[0];
  w.purchaseOrders=[{id:'po-one',vendor_id:vendor.id,status:'partially_received',created_at:w.now,amount_minor:6099,currency:'USD',requested_by:'buyer',approval_id:'approval-po-one',document_ids:['source-order'],lines:[{id:'po-line-1',item_id:'item-one',quantity:3,unit_price_minor:2033,amount_minor:6099,received_quantity:2,billed_quantity:0}]}];
  w.goodsReceipts=[{id:'receipt-one',purchase_order_id:'po-one',received_at:w.now,reference:'Warehouse delivery 17',document_id:'receipt-proof',operation_id:'op-receive-one',lines:[{id:'receipt-line-1',po_line_id:'po-line-1',item_id:'item-one',quantity:2,unit_cost_minor:2033,amount_minor:4066,billed_quantity:0,lot_id:'lot-one'}]}];
  w.inventoryItems=[{id:'item-one',sku:'SKU-01',name:'Conference kit',quantity_on_hand:2,inventory_value_minor:4066,currency:'USD'},{id:'item-two',sku:'SKU-02',name:'Badge holder',quantity_on_hand:0,inventory_value_minor:0,currency:'USD'}];
  w.supplierInvoices=[{id:'supplier-invoice-one',vendor_id:vendor.id,purchase_order_id:'po-one',invoice_number:'SUP-103',status:'blocked',received_at:w.now,due_at:w.now,amount_minor:6099,currency:'USD',revision:1,document_id:'invoice-evidence',issues:['Insufficient receipt quantity'],lines:[{po_line_id:'po-line-1',item_id:'item-one',quantity:3,unit_price_minor:2033,amount_minor:6099}]}];
  w.bills=[];
  return w;
}

test('procurement provider views preserve partial receipt quantities, exact costs, approval and inventory references',async()=>{
  const w=procurementWorld(),order=w.purchaseOrders[0],receipt=w.goodsReceipts[0],item=w.inventoryItems[0];
  const ns=await request(w,'netsuite','/services/rest/record/v1/purchaseOrder/po-one');
  const qb=await request(w,'quickbooks','/v3/company/procurement-realm/purchaseorder/po-one?minorversion=75');
  expect(ns?.body.total).toBe(60.99);expect(qb?.body.PurchaseOrder.TotalAmt).toBe(60.99);
  expect(ns?.body.entity.id).toBe(order.vendor_id);expect(qb?.body.PurchaseOrder.VendorRef.value).toBe(order.vendor_id);
  expect(ns?.body.finance_world).toStrictEqual(qb?.body.PurchaseOrder.finance_world);expect(ns?.body.finance_world.approval_id).toBe('approval-po-one');expect(ns?.body.finance_world.status).toBe('partially_received');
  const nsLine=ns?.body.item.items[0],qbLine=qb?.body.PurchaseOrder.Line[0];
  expect(nsLine.item.id).toBe(item.id);expect(nsLine.quantity).toBe(3);expect(nsLine.rate).toBe(20.33);expect(nsLine.finance_world.received_quantity).toBe(2);
  expect(qbLine.ItemBasedExpenseLineDetail.ItemRef.value).toBe(item.id);expect(qbLine.ItemBasedExpenseLineDetail.Qty).toBe(3);expect(qbLine.ItemBasedExpenseLineDetail.UnitPrice).toBe(20.33);expect(qbLine.finance_world.billed_quantity).toBe(0);
  const received=await request(w,'netsuite','/services/rest/record/v1/itemReceipt/receipt-one');
  expect(received?.body.createdFrom.id).toBe(order.id);expect(received?.body.item.items[0].quantity).toBe(2);expect(received?.body.item.items[0].amount).toBe(40.66);expect(received?.body.item.items[0].finance_world.po_line_id).toBe(order.lines[0].id);expect(received?.body.item.items[0].finance_world.lot_id).toBe('lot-one');expect(received?.body.finance_world.operation_id).toBe(receipt.operation_id);
  const inventory=await request(w,'netsuite','/services/rest/record/v1/inventoryItem/item-one'),qItem=await request(w,'quickbooks','/v3/company/procurement-realm/item/item-one');
  expect(inventory?.body.itemId).toBe(item.sku);expect(inventory?.body.totalQuantityOnHand).toBe(2);expect(qItem?.body.Item.QtyOnHand).toBe(2);expect(qItem?.body.Item.TrackQtyOnHand).toBe(true);expect(qItem?.body.Item.Type).toBe('Inventory');expect(qItem?.body.Item.finance_world.inventory_value_minor).toBe(4066);expect(inventory?.body.finance_world).toStrictEqual(qItem?.body.Item.finance_world);
});

test('unmatched supplier invoice is not a payable; matched bill links back to receipt and purchase order evidence',async()=>{
  const w=procurementWorld(),invoice=w.supplierInvoices[0];
  const query=(entity:string)=>'/v3/company/procurement-realm/query?query='+encodeURIComponent(`SELECT * FROM ${entity}`);
  expect((await request(w,'quickbooks',query('Bill')))?.body.QueryResponse.Bill).toStrictEqual([]);
  expect((await request(w,'netsuite','/services/rest/record/v1/vendorBill'))?.body.totalResults).toBe(0);
  await expect(request(w,'netsuite','/services/rest/record/v1/vendorBill/'+invoice.id)).rejects.toThrowSatisfying((e:any)=>e.status===404);
  // The accounting domain has recognized two received units, retaining the exact source invoice and lot allocation.
  invoice.status='matched';invoice.amount_minor=4066;invoice.lines[0].quantity=2;invoice.lines[0].amount_minor=4066;invoice.lines[0].allocations=[{receipt_id:'receipt-one',receipt_line_id:'receipt-line-1',quantity:2}];invoice.bill_id='bill-matched';
  w.bills.push({id:'bill-matched',vendor_id:invoice.vendor_id,amount_minor:4066,amount_paid_minor:2033,currency:'USD',status:'partially_paid',due_at:invoice.due_at,description:'Received inventory',supplier_invoice_id:invoice.id,purchase_order_id:'po-one',receipt_ids:['receipt-one'],match_status:'matched'});
  const ns=await request(w,'netsuite','/services/rest/record/v1/vendorBill/bill-matched'),qb=await request(w,'quickbooks','/v3/company/procurement-realm/bill/bill-matched');
  expect(ns?.body.tranId).toBe('SUP-103');expect(qb?.body.Bill.DocNumber).toBe('SUP-103');expect(ns?.body.total).toBe(40.66);expect(qb?.body.Bill.TotalAmt).toBe(40.66);expect(ns?.body.amountRemaining).toBe(20.33);expect(qb?.body.Bill.Balance).toBe(20.33);
  expect(ns?.body.createdFrom.id).toBe('po-one');expect(qb?.body.Bill.LinkedTxn).toStrictEqual([{TxnId:'po-one',TxnType:'PurchaseOrder'}]);expect(ns?.body.finance_world.supplier_invoice_id).toBe(invoice.id);expect(ns?.body.finance_world.receipt_ids).toStrictEqual(['receipt-one']);expect(ns?.body.finance_world.match_status).toBe('matched');
  expect(ns?.body.item.items[0].quantity).toBe(2);expect(qb?.body.Bill.Line[0].ItemBasedExpenseLineDetail.Qty).toBe(2);expect(ns?.body.item.items[0].finance_world.allocations).toStrictEqual(invoice.lines[0].allocations);
  expect((await request(w,'quickbooks',query('Bill')))?.body.QueryResponse.Bill).toStrictEqual([qb?.body.Bill]);
});

test('procurement pagination and query boundaries preserve canonical collection identity without accepting unsupported writes',async()=>{
  const w=procurementWorld(),before=structuredClone(w);
  const first=await request(w,'netsuite','/services/rest/record/v1/inventoryItem?limit=1');expect(first?.body.totalResults).toBe(2);expect(first?.body.hasMore).toBe(true);expect(first?.body.items[0].id).toBe('item-one');
  const next=await request(w,'netsuite',first?.body.links[0].href);expect(next?.body.items[0].id).toBe('item-two');expect(next?.body.hasMore).toBe(false);
  const query=await request(w,'quickbooks','/v3/company/procurement-realm/query?query='+encodeURIComponent('SELECT * FROM item STARTPOSITION 2 MAXRESULTS 1'));expect(query?.body.QueryResponse.Item[0].Id).toBe('item-two');expect(query?.body.QueryResponse.totalCount).toBe(2);
  const specific=await request(w,'quickbooks','/v3/company/procurement-realm/query?query='+encodeURIComponent("SELECT * FROM PurchaseOrder WHERE Id = 'po-one'"));expect(specific?.body.QueryResponse.PurchaseOrder[0].Id).toBe('po-one');
  await expect(request(w,'quickbooks','/v3/company/procurement-realm/query?query='+encodeURIComponent("SELECT * FROM Item WHERE QtyOnHand > 0"))).rejects.toThrowSatisfying((e:any)=>e.code==='unsupported_query');
  await expect(request(w,'quickbooks','/v3/company/wrong/item/item-one')).rejects.toThrowSatisfying((e:any)=>e.status===404);
  await expect(request(w,'quickbooks','/v3/company/procurement-realm/bill/missing')).rejects.toThrowSatisfying((e:any)=>e.status===404);
  await expect(request(w,'quickbooks','/v3/company/procurement-realm/item/item-one?minorversion=76')).rejects.toThrowSatisfying((e:any)=>e.status===501);
  await expect(request(w,'netsuite','/services/rest/record/v1/itemReceipt?q=quantity%20GREATER%200')).rejects.toThrowSatisfying((e:any)=>e.status===501);
  await expect(request(w,'netsuite','/services/rest/record/v1/inventoryItem?offset=3')).rejects.toThrowSatisfying((e:any)=>e.code==='invalid_cursor');
  for(const kind of ['purchaseOrder','itemReceipt','vendorBill','inventoryItem'])expect(await request(w,'netsuite',`/services/rest/record/v1/${kind}`,'POST',{status:'approved'})).toBeUndefined();
  for(const kind of ['purchaseorder','bill','item'])expect(await request(w,'quickbooks',`/v3/company/procurement-realm/${kind}`,'POST',{QtyOnHand:999})).toBeUndefined();
  expect(w).toStrictEqual(before);
});

test('legacy worlds expose empty procurement collections without inventing orders or stock',async()=>{
  const w=createWorld({orderCount:1});for(const key of ['purchaseOrders','goodsReceipts','supplierInvoices','inventoryItems'])delete w[key];
  for(const kind of ['purchaseOrder','itemReceipt','inventoryItem'])expect((await request(w,'netsuite',`/services/rest/record/v1/${kind}`))?.body.totalResults).toBe(0);
  for(const entity of ['PurchaseOrder','Item'])expect((await request(w,'quickbooks',`/v3/company/${w.id}/query?query=`+encodeURIComponent(`SELECT * FROM ${entity}`)))?.body.QueryResponse[entity]).toStrictEqual([]);
});

test('provider procurement reads follow real receipt, matching, settlement, stock issue and original-cost return transitions',async()=>{
  const w=createWorld({kind:'procurement-matching',orderCount:2,seed:42,approvalThresholdMinor:100000000},'lifecycle-realm');
  const complete=w.supplierInvoices[0],partial=w.supplierInvoices[1],partialPO=w.purchaseOrders.find((po:any)=>po.id===partial.purchase_order_id),partialLine=partialPO.lines[0];
  const initialCash=summarize(w).cash_minor,stockId=w.inventoryItems[0].id,initialStock=w.inventoryItems[0].quantity_on_hand,unitCost=w.purchaseOrders[0].lines[0].unit_price_minor;
  const ns=(kind:string,id?:string)=>request(w,'netsuite',`/services/rest/record/v1/${kind}`+(id?`/${id}`:''));
  const qb=(kind:string,id:string)=>request(w,'quickbooks',`/v3/company/lifecycle-realm/${kind}/${id}`);
  expect(w.supplierInvoiceDeliveries.filter((delivery:any)=>delivery.supplier_invoice_id===complete.id).length).toBe(2);
  expect((await ns('vendorBill'))?.body.totalResults).toBe(0);
  const blocked=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:partial.id},agent).result;
  expect(blocked.status).toBe('blocked');expect(blocked.issues.some((issue:any)=>issue.code==='receipt_shortfall')).toBeTruthy();expect((await ns('vendorBill'))?.body.totalResults).toBe(0);
  expect((await ns('purchaseOrder',partialPO.id))?.body.item.items[0].finance_world.received_quantity).toBe(partialLine.received_quantity);
  const remaining=partialLine.quantity-partialLine.received_quantity;
  const receipt=applyAction(w,{type:'receive_goods',purchase_order_id:partialPO.id,lines:[{po_line_id:partialLine.id,quantity:remaining}],reference:'Final warehouse delivery',external_event_id:'adapter-final-receipt'},controller).result.receipt;
  const received=await ns('itemReceipt',receipt.id);expect(received?.body.createdFrom.id).toBe(partialPO.id);expect(received?.body.item.items[0].quantity).toBe(remaining);expect(received?.body.finance_world.operation_id).toBe(receipt.operation_id);
  const second=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:partial.id},agent).result;
  expect(second.status).toBe('matched');expect((await ns('vendorBill',second.bill.id))?.body.finance_world.receipt_ids.length).toBe(2);
  expect((await qb('purchaseorder',partialPO.id))?.body.PurchaseOrder.POStatus).toBe('Closed');
  const first=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:complete.id},agent).result;
  const replay=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:complete.id},agent).result;
  expect(replay.already_matched).toBe(true);expect(replay.bill.id).toBe(first.bill.id);expect(w.bills.length).toBe(2);
  expect((await ns('vendorBill',first.bill.id))?.body.total).toBe(complete.amount_minor/100);
  expect((await qb('bill',first.bill.id))?.body.Bill.finance_world.supplier_invoice_id).toBe(complete.id);
  applyAction(w,{type:'pay_bill',bill_id:first.bill.id},agent);advance(w);
  expect((await ns('vendorBill',first.bill.id))?.body.amountRemaining).toBe(0);expect((await qb('bill',first.bill.id))?.body.Bill.Balance).toBe(0);expect(summarize(w).cash_minor).toBe(initialCash-complete.amount_minor);
  const movement=applyAction(w,{type:'issue_inventory',authorization_id:w.inventoryAuthorizations[0].id,lines:[{item_id:stockId,quantity:2}]},agent).result.movement;
  expect((await qb('item',stockId))?.body.Item.QtyOnHand).toBe(initialStock-2);
  expect((await ns('inventoryItem',stockId))?.body.finance_world.inventory_value_minor).toBe((initialStock-2)*unitCost);
  applyAction(w,{type:'return_inventory',issue_id:movement.id,lines:[{item_id:stockId,quantity:1}],reason:'One unused reader returned to the receiving lot',external_event_id:'adapter-unused-stock-return'},controller);
  const finalStock=await ns('inventoryItem',stockId),finalItem=await qb('item',stockId);
  expect(finalStock?.body.totalQuantityOnHand).toBe(initialStock-1);expect(finalItem?.body.Item.QtyOnHand).toBe(initialStock-1);expect(finalItem?.body.Item.finance_world.inventory_value_minor).toBe((initialStock-1)*unitCost);
  expect(summarize(w).reconciliation.balanced).toBe(true);expect(summarize(w).reconciliation.bank_ledger_difference_minor).toBe(0);
});

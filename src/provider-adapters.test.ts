import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {createWorld,applyAction,summarize,DomainError} from './world.ts';
import type {World} from './world.ts';
import {providerRequest} from './provider-adapters.ts';
const controller={id:'judge',role:'controller'} as const,agent={id:'agent',role:'agent'} as const;
function request(world:World,system:string,path:string,method='GET',input?:any){const url=new URL(path,'http://local.test');return providerRequest({world,system,route:url.pathname,url,method,input,execute:action=>applyAction(world,action,agent).result});}
function advance(world:World){applyAction(world,{type:'advance_time',hours:1},controller);}

test('Stripe refund maps one economic effect across payment, charge, bank and partial refund states',async()=>{
  const w=createWorld({orderCount:2}),p=w.payments[0],amount=Math.floor(p.refundable_minor/2),opening=summarize(w).cash_minor;
  const before=await request(w,'stripe',`/v1/payment_intents/${p.id}`);assert.equal(before?.body.amount_received,p.amount_minor);
  const pending=await request(w,'stripe','/v1/refunds','POST',{payment_intent:p.id,amount});
  assert.equal(pending?.body.object,'refund');assert.equal(pending?.body.status,'pending');assert.equal(pending?.body.payment_intent,p.id);
  advance(w);
  const refund=await request(w,'stripe',`/v1/refunds/${pending?.body.id}`),charge=await request(w,'stripe',`/v1/charges/ch_${p.id}`);
  assert.equal(refund?.body.status,'succeeded');assert.equal(charge?.body.amount_refunded,amount);assert.equal(charge?.body.refunded,false);
  assert.equal(charge?.body.refunds.data[0].id,pending?.body.id);assert.equal(summarize(w).cash_minor,opening-amount);
  const account=await request(w,'mercury','/api/v1/accounts');assert.equal(account?.body.accounts[0].currentBalance,(opening-amount)/100);
  const transactions=await request(w,'mercury','/api/v1/account/cash-bank/transactions');assert.equal(transactions?.body.transactions[0].amount,-amount/100);
});

test('Stripe high-value approval does not pretend a refund exists before a controller decision',async()=>{
  const w=createWorld({orderCount:1,approvalThresholdMinor:100});
  const result=await request(w,'stripe','/v1/refunds','POST',{charge:`ch_${w.payments[0].id}`,amount:500});
  assert.equal(result?.status,202);assert.equal(result?.body.object,'finance_world.approval_required');assert.equal(w.refunds.length,0);
  applyAction(w,{type:'decide_approval',approval_id:result?.body.approval_id,decision:'approve'},controller);
  assert.equal(w.refunds.length,1);advance(w);
  const list=await request(w,'stripe',`/v1/refunds?payment_intent=${w.payments[0].id}`);assert.equal(list?.body.data[0].status,'succeeded');
});

test('Stripe pagination covers the collection once and rejects unsupported filtering',async()=>{
  const w=createWorld({orderCount:21});let cursor='',ids:string[]=[];
  do{const page=await request(w,'stripe','/v1/payment_intents?limit=6'+(cursor?'&starting_after='+cursor:''));ids.push(...page?.body.data.map((p:any)=>p.id));cursor=page?.body.has_more?page.body.data.at(-1).id:'';}while(cursor);
  assert.equal(ids.length,21);assert.equal(new Set(ids).size,21);
  await assert.rejects(()=>request(w,'stripe','/v1/payment_intents?created[gte]=0'),(error:any)=>error instanceof DomainError&&error.status===501);
  await assert.rejects(()=>request(w,'stripe','/v1/payment_intents?starting_after=missing'),/Unknown pagination/);
});

test('Stripe dispute reads and explicit local evidence submission preserve the processor outcome boundary',async()=>{
  const w=createWorld({orderCount:2}),payment=w.payments[0];
  const opened=applyAction(w,{type:'open_dispute',payment_id:payment.id,amount_minor:500,reason:'fraudulent',external_event_id:'issuer-open-one'},controller).result;
  const id=opened.dispute.id,read=await request(w,'stripe',`/v1/disputes/${id}`);
  assert.equal(read?.body.object,'dispute');assert.equal(read?.body.status,'needs_response');assert.equal(read?.body.payment_intent,payment.id);assert.equal(read?.body.charge,`ch_${payment.id}`);assert.equal(read?.body.evidence_details.has_evidence,false);
  const bank=summarize(w).cash_minor;
  const submitted=await request(w,'stripe',`/v1/disputes/${id}`,'POST',{finance_world_evidence:{document_ids:['contract-promoter'],statement:'The captured ticket was purchased under the signed promoter terms.'},submit:true});
  assert.equal(submitted?.body.status,'under_review');assert.equal(submitted?.body.evidence_details.submission_count,1);assert.deepEqual(submitted?.body.finance_world_evidence.document_ids,['contract-promoter']);assert.equal(summarize(w).cash_minor,bank);
  const again=await request(w,'stripe',`/v1/disputes/${id}`,'POST',{finance_world_evidence:{document_ids:['contract-promoter'],statement:'The captured ticket was purchased under the signed promoter terms.'}});assert.equal(again?.body.evidence_details.submission_count,1);
  const charge=await request(w,'stripe',`/v1/charges/ch_${payment.id}`);assert.equal(charge?.body.disputed,true);
  await assert.rejects(()=>request(w,'stripe',`/v1/disputes/${id}`,'POST',{status:'won',finance_world_evidence:{document_ids:['contract-promoter'],statement:'Change outcome'}}),/Unsupported body field/);
  await assert.rejects(()=>request(w,'stripe',`/v1/disputes/${id}`,'POST',{evidence:{uncategorized_text:'Unsupported automatic authority'}}),/Unsupported body field/);
  await assert.rejects(()=>request(w,'stripe',`/v1/disputes/${id}`,'POST',{finance_world_evidence:{document_ids:['missing-doc'],statement:'Unsupported'},submit:true}),/Source document not found/);
  await assert.rejects(()=>request(w,'stripe',`/v1/disputes/${id}`,'POST',{finance_world_evidence:{document_ids:['contract-promoter'],statement:'Draft'},submit:false}),/Only immediate evidence submission/);
  applyAction(w,{type:'resolve_dispute',dispute_id:id,outcome:'won',external_event_id:'issuer-won-one'},controller);
  const resolved=await request(w,'stripe',`/v1/disputes/${id}`);assert.equal(resolved?.body.status,'won');assert.equal(summarize(w).cash_minor,bank+500);
  await assert.rejects(()=>request(w,'stripe',`/v1/disputes/${id}`,'POST',{finance_world_evidence:{document_ids:['contract-promoter'],statement:'Late change'}}),/resolved dispute/);
});

test('Stripe dispute lists filter and paginate without interpreting unsupported filters as success',async()=>{
  const w=createWorld({orderCount:3});
  for(let i=0;i<3;i++)applyAction(w,{type:'open_dispute',payment_id:w.payments[i].id,amount_minor:100,reason:'Customer reports service issue',external_event_id:`issuer-${i}`},controller);
  const first=await request(w,'stripe','/v1/disputes?limit=2');assert.equal(first?.body.data.length,2);assert.equal(first?.body.has_more,true);assert.equal(first?.body.data[0].reason,'general');assert.equal(first?.body.data[0].metadata.finance_world_reason,'Customer reports service issue');
  const last=await request(w,'stripe',`/v1/disputes?limit=2&starting_after=${first?.body.data[1].id}`);assert.equal(last?.body.data.length,1);assert.equal(last?.body.has_more,false);
  const filter=await request(w,'stripe',`/v1/disputes?payment_intent=${w.payments[1].id}`);assert.equal(filter?.body.data.length,1);assert.equal(filter?.body.data[0].payment_intent,w.payments[1].id);
  await assert.rejects(()=>request(w,'stripe','/v1/disputes?status=won'),/Unsupported query parameter/);
  await assert.rejects(()=>request(w,'stripe','/v1/disputes/missing'),(e:any)=>e.status===404);
  assert.equal(await request(w,'stripe','/v1/disputes','POST',{payment_intent:w.payments[0].id}),undefined);
});

test('Stripe credit notes authorize only their original collected invoice refund and expose its settlement',async()=>{
  const w=createWorld({kind:'saas-collections',orderCount:1,approvalThresholdMinor:100000000}),invoice=w.invoices[0],amount=Math.min(10000,invoice.amount_minor);
  const collection=applyAction(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:amount},agent).result;advance(w);
  const payment=w.payments.find(p=>p.operation_id===collection.operation.id)!;
  const issued=applyAction(w,{type:'issue_credit_note',invoice_id:invoice.id,payment_id:payment.id,amount_minor:5000,reason:'Controller approved a service concession',external_event_id:'credit-issued-1'},controller).result;
  const note=await request(w,'stripe',`/v1/credit_notes/${issued.credit_note.id}`);assert.equal(note?.body.object,'credit_note');assert.equal(note?.body.invoice,invoice.id);assert.equal(note?.body.amount,5000);assert.equal(note?.body.post_payment_amount,5000);assert.equal(note?.body.status,'issued');
  const notes=await request(w,'stripe',`/v1/credit_notes?invoice=${invoice.id}&customer=${invoice.customer_id}`);assert.equal(notes?.body.data.length,1);
  await assert.rejects(()=>request(w,'stripe','/v1/refunds','POST',{payment_intent:payment.id,amount:5000}),/issued credit note/);
  const refund=await request(w,'stripe','/v1/refunds','POST',{payment_intent:payment.id,amount:5000,credit_note_id:note?.body.id});assert.equal(refund?.body.status,'pending');assert.equal(refund?.body.metadata.finance_world_credit_note_id,note?.body.id);
  advance(w);
  const completed=await request(w,'stripe',`/v1/credit_notes/${note?.body.id}`);assert.equal(completed?.body.metadata.finance_world_status,'refunded');assert.equal(completed?.body.metadata.finance_world_refunded_minor,'5000');assert.deepEqual(completed?.body.refunds,[{amount:5000,refund:refund?.body.id}]);
  const invoiceView=await request(w,'stripe',`/v1/invoices/${invoice.id}`);assert.equal(invoiceView?.body.post_payment_credit_notes_amount,5000);assert.equal(invoiceView?.body.amount_paid,amount);
  assert.equal(summarize(w).reconciliation.balanced,true);assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,0);
  assert.equal(await request(w,'stripe','/v1/credit_notes','POST',{invoice:invoice.id,amount:100}),undefined);
  await assert.rejects(()=>request(w,'stripe','/v1/credit_notes?status=issued'),/Unsupported query parameter/);
});

test('provider projection upgrades legacy collections before reading disputes or credits',async()=>{
  const w=createWorld({orderCount:1});delete w.disputes;delete w.creditNotes;
  const disputes=await request(w,'stripe','/v1/disputes'),credits=await request(w,'stripe','/v1/credit_notes');assert.deepEqual(disputes?.body.data,[]);assert.deepEqual(credits?.body.data,[]);
});

test('Gmail sends and reads RFC 2822 UTF-8 text, labels and threads backed by canonical messages',async()=>{
  const w=createWorld({orderCount:2});
  const mime=['From: finance@simulation.test','To: Fan <fan1@example.test>','Subject: =?UTF-8?B?UmVmdW5kIOKckw==?=','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','','Your refund is in progress.'].join('\r\n');
  const sent=await request(w,'gmail','/gmail/v1/users/me/messages/send','POST',{raw:Buffer.from(mime).toString('base64url')});
  assert.equal(sent?.body.payload.headers.find((h:any)=>h.name==='Subject').value,'Refund ✓');
  assert.deepEqual(w.messages.at(-1).to,['fan1@example.test']);assert.equal(w.messages.at(-1).body,'Your refund is in progress.');
  const raw=await request(w,'gmail',`/gmail/v1/users/me/messages/${sent?.body.id}?format=raw`);
  assert.equal(Buffer.from(raw?.body.raw,'base64url').toString(),mime);
  const thread=await request(w,'gmail',`/gmail/v1/users/me/threads/${sent?.body.threadId}`);assert.equal(thread?.body.messages[0].id,sent?.body.id);
  const search=await request(w,'gmail','/gmail/v1/users/me/messages?labelIds=SENT&q=to:fan1@example.test');assert.equal(search?.body.messages.length,1);
  const attachments=await request(w,'gmail','/gmail/v1/users/me/messages?q=has:attachment');assert.deepEqual(attachments?.body.messages,[]);
  await assert.rejects(()=>request(w,'gmail','/gmail/v1/users/me/messages?q=has:drive'),/Unsupported Gmail search/);
});

test('unsupported MIME is rejected before an email is added and malformed bodies do not succeed',async()=>{
  const w=createWorld(),before=w.messages.length;
  const mime='To: fan@example.test\r\nSubject: Test\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x';
  await assert.rejects(()=>request(w,'gmail','/gmail/v1/users/me/messages/send','POST',{raw:Buffer.from(mime).toString('base64url')}),/Malformed or unterminated multipart/);
  await assert.rejects(()=>request(w,'gmail','/gmail/v1/users/me/messages/send','POST',{raw:'not!base64'}),/base64url/);
  assert.equal(w.messages.length,before);
});

test('Plaid incremental sync uses debit-positive amounts and later exposes only newly settled bank rows',async()=>{
  const w=createWorld({orderCount:2});
  const first=await request(w,'plaid','/transactions/sync','POST',{count:500});
  assert.equal(first?.body.added[0].amount,-w.bankTransactions[0].amount_minor/100);assert.equal(first?.body.has_more,false);
  applyAction(w,{type:'refund',payment_id:w.payments[0].id,amount_minor:100},agent);advance(w);
  const next=await request(w,'plaid','/transactions/sync','POST',{cursor:first?.body.next_cursor});
  assert.equal(next?.body.added.length,1);assert.equal(next?.body.added[0].amount,1);
  const empty=await request(w,'plaid','/transactions/sync','POST',{cursor:next?.body.next_cursor});assert.deepEqual(empty?.body.added,[]);
  const accounts=await request(w,'plaid','/accounts/get','POST',{});assert.equal(accounts?.body.accounts[0].balances.current,summarize(w).cash_minor/100);
});

test('QuickBooks and NetSuite reflect shared invoice payments and the same balanced journal',async()=>{
  const w=createWorld({kind:'saas-collections',orderCount:4},'realm-1'),invoice=w.invoices[0];
  applyAction(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:1000},agent);advance(w);
  const qb=await request(w,'quickbooks',`/v3/company/realm-1/invoice/${invoice.id}`);
  const ns=await request(w,'netsuite',`/services/rest/record/v1/invoice/${invoice.id}`);
  assert.equal(qb?.body.Invoice.Balance,(invoice.amount_minor-1000)/100);assert.equal(ns?.body.amountRemaining,qb?.body.Invoice.Balance);
  const query=await request(w,'quickbooks','/v3/company/realm-1/query?query='+encodeURIComponent('SELECT * FROM Invoice STARTPOSITION 2 MAXRESULTS 2'));assert.equal(query?.body.QueryResponse.Invoice[0].Id,w.invoices[1].id);assert.equal(query?.body.QueryResponse.Invoice.length,2);
  const last=w.journals.at(-1);const journal=await request(w,'netsuite',`/services/rest/record/v1/journalEntry/${last.id}`);
  assert.equal(journal?.body.line.items.reduce((sum:number,line:any)=>sum+line.debit-line.credit,0),0);
  await assert.rejects(()=>request(w,'quickbooks','/v3/company/wrong/query?query=SELECT%20*%20FROM%20Invoice'),/Realm must match/);
  await assert.rejects(()=>request(w,'netsuite','/services/rest/record/v1/invoice?q=amountRemaining%20GREATER%200'),/Unsupported query/);
});

test('Ramp bills use the same paid state and unsupported writes return undefined without mutation',async()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:3});
  applyAction(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:100},agent);advance(w);
  const bills=await request(w,'ramp','/developer/v1/bills?status=PARTIALLY_PAID');assert.equal(bills?.body.data.length,1);assert.equal(bills?.body.data[0].amount,w.bills[0].amount_minor);
  const before=structuredClone(w);assert.equal(await request(w,'ramp','/developer/v1/bills','POST',{amount:1}),undefined);
  assert.equal(await request(w,'stripe','/v1/payment_intents','POST',{amount:1}),undefined);
  assert.equal(await request(w,'gmail','/gmail/v1/users/me/messages/batchDelete','POST',{ids:['all']}),undefined);
  assert.deepEqual(w,before);
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
  assert.equal(ns?.body.total,60.99);assert.equal(qb?.body.PurchaseOrder.TotalAmt,60.99);
  assert.equal(ns?.body.entity.id,order.vendor_id);assert.equal(qb?.body.PurchaseOrder.VendorRef.value,order.vendor_id);
  assert.deepEqual(ns?.body.finance_world,qb?.body.PurchaseOrder.finance_world);assert.equal(ns?.body.finance_world.approval_id,'approval-po-one');assert.equal(ns?.body.finance_world.status,'partially_received');
  const nsLine=ns?.body.item.items[0],qbLine=qb?.body.PurchaseOrder.Line[0];
  assert.equal(nsLine.item.id,item.id);assert.equal(nsLine.quantity,3);assert.equal(nsLine.rate,20.33);assert.equal(nsLine.finance_world.received_quantity,2);
  assert.equal(qbLine.ItemBasedExpenseLineDetail.ItemRef.value,item.id);assert.equal(qbLine.ItemBasedExpenseLineDetail.Qty,3);assert.equal(qbLine.ItemBasedExpenseLineDetail.UnitPrice,20.33);assert.equal(qbLine.finance_world.billed_quantity,0);
  const received=await request(w,'netsuite','/services/rest/record/v1/itemReceipt/receipt-one');
  assert.equal(received?.body.createdFrom.id,order.id);assert.equal(received?.body.item.items[0].quantity,2);assert.equal(received?.body.item.items[0].amount,40.66);assert.equal(received?.body.item.items[0].finance_world.po_line_id,order.lines[0].id);assert.equal(received?.body.item.items[0].finance_world.lot_id,'lot-one');assert.equal(received?.body.finance_world.operation_id,receipt.operation_id);
  const inventory=await request(w,'netsuite','/services/rest/record/v1/inventoryItem/item-one'),qItem=await request(w,'quickbooks','/v3/company/procurement-realm/item/item-one');
  assert.equal(inventory?.body.itemId,item.sku);assert.equal(inventory?.body.totalQuantityOnHand,2);assert.equal(qItem?.body.Item.QtyOnHand,2);assert.equal(qItem?.body.Item.TrackQtyOnHand,true);assert.equal(qItem?.body.Item.Type,'Inventory');assert.equal(qItem?.body.Item.finance_world.inventory_value_minor,4066);assert.deepEqual(inventory?.body.finance_world,qItem?.body.Item.finance_world);
});

test('unmatched supplier invoice is not a payable; matched bill links back to receipt and purchase order evidence',async()=>{
  const w=procurementWorld(),invoice=w.supplierInvoices[0];
  const query=(entity:string)=>'/v3/company/procurement-realm/query?query='+encodeURIComponent(`SELECT * FROM ${entity}`);
  assert.deepEqual((await request(w,'quickbooks',query('Bill')))?.body.QueryResponse.Bill,[]);
  assert.equal((await request(w,'netsuite','/services/rest/record/v1/vendorBill'))?.body.totalResults,0);
  await assert.rejects(()=>request(w,'netsuite','/services/rest/record/v1/vendorBill/'+invoice.id),(e:any)=>e.status===404);
  // The accounting domain has recognized two received units, retaining the exact source invoice and lot allocation.
  invoice.status='matched';invoice.amount_minor=4066;invoice.lines[0].quantity=2;invoice.lines[0].amount_minor=4066;invoice.lines[0].allocations=[{receipt_id:'receipt-one',receipt_line_id:'receipt-line-1',quantity:2}];invoice.bill_id='bill-matched';
  w.bills.push({id:'bill-matched',vendor_id:invoice.vendor_id,amount_minor:4066,amount_paid_minor:2033,currency:'USD',status:'partially_paid',due_at:invoice.due_at,description:'Received inventory',supplier_invoice_id:invoice.id,purchase_order_id:'po-one',receipt_ids:['receipt-one'],match_status:'matched'});
  const ns=await request(w,'netsuite','/services/rest/record/v1/vendorBill/bill-matched'),qb=await request(w,'quickbooks','/v3/company/procurement-realm/bill/bill-matched');
  assert.equal(ns?.body.tranId,'SUP-103');assert.equal(qb?.body.Bill.DocNumber,'SUP-103');assert.equal(ns?.body.total,40.66);assert.equal(qb?.body.Bill.TotalAmt,40.66);assert.equal(ns?.body.amountRemaining,20.33);assert.equal(qb?.body.Bill.Balance,20.33);
  assert.equal(ns?.body.createdFrom.id,'po-one');assert.deepEqual(qb?.body.Bill.LinkedTxn,[{TxnId:'po-one',TxnType:'PurchaseOrder'}]);assert.equal(ns?.body.finance_world.supplier_invoice_id,invoice.id);assert.deepEqual(ns?.body.finance_world.receipt_ids,['receipt-one']);assert.equal(ns?.body.finance_world.match_status,'matched');
  assert.equal(ns?.body.item.items[0].quantity,2);assert.equal(qb?.body.Bill.Line[0].ItemBasedExpenseLineDetail.Qty,2);assert.deepEqual(ns?.body.item.items[0].finance_world.allocations,invoice.lines[0].allocations);
  assert.deepEqual((await request(w,'quickbooks',query('Bill')))?.body.QueryResponse.Bill,[qb?.body.Bill]);
});

test('procurement pagination and query boundaries preserve canonical collection identity without accepting unsupported writes',async()=>{
  const w=procurementWorld(),before=structuredClone(w);
  const first=await request(w,'netsuite','/services/rest/record/v1/inventoryItem?limit=1');assert.equal(first?.body.totalResults,2);assert.equal(first?.body.hasMore,true);assert.equal(first?.body.items[0].id,'item-one');
  const next=await request(w,'netsuite',first?.body.links[0].href);assert.equal(next?.body.items[0].id,'item-two');assert.equal(next?.body.hasMore,false);
  const query=await request(w,'quickbooks','/v3/company/procurement-realm/query?query='+encodeURIComponent('SELECT * FROM item STARTPOSITION 2 MAXRESULTS 1'));assert.equal(query?.body.QueryResponse.Item[0].Id,'item-two');assert.equal(query?.body.QueryResponse.totalCount,2);
  const specific=await request(w,'quickbooks','/v3/company/procurement-realm/query?query='+encodeURIComponent("SELECT * FROM PurchaseOrder WHERE Id = 'po-one'"));assert.equal(specific?.body.QueryResponse.PurchaseOrder[0].Id,'po-one');
  await assert.rejects(()=>request(w,'quickbooks','/v3/company/procurement-realm/query?query='+encodeURIComponent("SELECT * FROM Item WHERE QtyOnHand > 0")),(e:any)=>e.code==='unsupported_query');
  await assert.rejects(()=>request(w,'quickbooks','/v3/company/wrong/item/item-one'),(e:any)=>e.status===404);
  await assert.rejects(()=>request(w,'quickbooks','/v3/company/procurement-realm/bill/missing'),(e:any)=>e.status===404);
  await assert.rejects(()=>request(w,'quickbooks','/v3/company/procurement-realm/item/item-one?minorversion=76'),(e:any)=>e.status===501);
  await assert.rejects(()=>request(w,'netsuite','/services/rest/record/v1/itemReceipt?q=quantity%20GREATER%200'),(e:any)=>e.status===501);
  await assert.rejects(()=>request(w,'netsuite','/services/rest/record/v1/inventoryItem?offset=3'),(e:any)=>e.code==='invalid_cursor');
  for(const kind of ['purchaseOrder','itemReceipt','vendorBill','inventoryItem'])assert.equal(await request(w,'netsuite',`/services/rest/record/v1/${kind}`,'POST',{status:'approved'}),undefined);
  for(const kind of ['purchaseorder','bill','item'])assert.equal(await request(w,'quickbooks',`/v3/company/procurement-realm/${kind}`,'POST',{QtyOnHand:999}),undefined);
  assert.deepEqual(w,before);
});

test('legacy worlds expose empty procurement collections without inventing orders or stock',async()=>{
  const w=createWorld({orderCount:1});for(const key of ['purchaseOrders','goodsReceipts','supplierInvoices','inventoryItems'])delete w[key];
  for(const kind of ['purchaseOrder','itemReceipt','inventoryItem'])assert.equal((await request(w,'netsuite',`/services/rest/record/v1/${kind}`))?.body.totalResults,0);
  for(const entity of ['PurchaseOrder','Item'])assert.deepEqual((await request(w,'quickbooks',`/v3/company/${w.id}/query?query=`+encodeURIComponent(`SELECT * FROM ${entity}`)))?.body.QueryResponse[entity],[]);
});

test('provider procurement reads follow real receipt, matching, settlement, stock issue and original-cost return transitions',async()=>{
  const w=createWorld({kind:'procurement-matching',orderCount:2,seed:42,approvalThresholdMinor:100000000},'lifecycle-realm');
  const complete=w.supplierInvoices[0],partial=w.supplierInvoices[1],partialPO=w.purchaseOrders.find((po:any)=>po.id===partial.purchase_order_id),partialLine=partialPO.lines[0];
  const initialCash=summarize(w).cash_minor,stockId=w.inventoryItems[0].id,initialStock=w.inventoryItems[0].quantity_on_hand,unitCost=w.purchaseOrders[0].lines[0].unit_price_minor;
  const ns=(kind:string,id?:string)=>request(w,'netsuite',`/services/rest/record/v1/${kind}`+(id?`/${id}`:''));
  const qb=(kind:string,id:string)=>request(w,'quickbooks',`/v3/company/lifecycle-realm/${kind}/${id}`);
  assert.equal(w.supplierInvoiceDeliveries.filter((delivery:any)=>delivery.supplier_invoice_id===complete.id).length,2);
  assert.equal((await ns('vendorBill'))?.body.totalResults,0);
  const blocked=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:partial.id},agent).result;
  assert.equal(blocked.status,'blocked');assert.ok(blocked.issues.some((issue:any)=>issue.code==='receipt_shortfall'));assert.equal((await ns('vendorBill'))?.body.totalResults,0);
  assert.equal((await ns('purchaseOrder',partialPO.id))?.body.item.items[0].finance_world.received_quantity,partialLine.received_quantity);
  const remaining=partialLine.quantity-partialLine.received_quantity;
  const receipt=applyAction(w,{type:'receive_goods',purchase_order_id:partialPO.id,lines:[{po_line_id:partialLine.id,quantity:remaining}],reference:'Final warehouse delivery',external_event_id:'adapter-final-receipt'},controller).result.receipt;
  const received=await ns('itemReceipt',receipt.id);assert.equal(received?.body.createdFrom.id,partialPO.id);assert.equal(received?.body.item.items[0].quantity,remaining);assert.equal(received?.body.finance_world.operation_id,receipt.operation_id);
  const second=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:partial.id},agent).result;
  assert.equal(second.status,'matched');assert.equal((await ns('vendorBill',second.bill.id))?.body.finance_world.receipt_ids.length,2);
  assert.equal((await qb('purchaseorder',partialPO.id))?.body.PurchaseOrder.POStatus,'Closed');
  const first=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:complete.id},agent).result;
  const replay=applyAction(w,{type:'match_supplier_invoice',supplier_invoice_id:complete.id},agent).result;
  assert.equal(replay.already_matched,true);assert.equal(replay.bill.id,first.bill.id);assert.equal(w.bills.length,2);
  assert.equal((await ns('vendorBill',first.bill.id))?.body.total,complete.amount_minor/100);
  assert.equal((await qb('bill',first.bill.id))?.body.Bill.finance_world.supplier_invoice_id,complete.id);
  applyAction(w,{type:'pay_bill',bill_id:first.bill.id},agent);advance(w);
  assert.equal((await ns('vendorBill',first.bill.id))?.body.amountRemaining,0);assert.equal((await qb('bill',first.bill.id))?.body.Bill.Balance,0);assert.equal(summarize(w).cash_minor,initialCash-complete.amount_minor);
  const movement=applyAction(w,{type:'issue_inventory',authorization_id:w.inventoryAuthorizations[0].id,lines:[{item_id:stockId,quantity:2}]},agent).result.movement;
  assert.equal((await qb('item',stockId))?.body.Item.QtyOnHand,initialStock-2);
  assert.equal((await ns('inventoryItem',stockId))?.body.finance_world.inventory_value_minor,(initialStock-2)*unitCost);
  applyAction(w,{type:'return_inventory',issue_id:movement.id,lines:[{item_id:stockId,quantity:1}],reason:'One unused reader returned to the receiving lot',external_event_id:'adapter-unused-stock-return'},controller);
  const finalStock=await ns('inventoryItem',stockId),finalItem=await qb('item',stockId);
  assert.equal(finalStock?.body.totalQuantityOnHand,initialStock-1);assert.equal(finalItem?.body.Item.QtyOnHand,initialStock-1);assert.equal(finalItem?.body.Item.finance_world.inventory_value_minor,(initialStock-1)*unitCost);
  assert.equal(summarize(w).reconciliation.balanced,true);assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,0);
});

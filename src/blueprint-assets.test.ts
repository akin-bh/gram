import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {createWorld,applyAction,type World} from './world.ts';
import {blueprintSchema,validateBlueprint} from './blueprint.ts';
import {assetBlueprintShape} from './blueprint-assets.ts';
import {fixedAssetReport} from './fixed-assets.ts';

const opening='2026-08-01T09:00:00.000Z',capitalized='2026-08-01T09:00:00.001Z',service='2026-08-01T09:15:30.123Z',asOf='2026-11-01T15:42:17.123Z';
const operator={id:'asset-live-operator',role:'operator'} as const,controller={id:'independent-asset-controller',role:'controller'} as const;
function sources():any{return {
  version:1,opening_at:opening,as_of:asOf,
  vendors:[{ref:'supplier',name:'Equipment Supply',email:'ap@equipment.test'}],
  customers:[{ref:'buyer',name:'Verified Buyer',email:'buyer@equipment.test'}],
  service_contracts:[{ref:'buyer-contract',counterparty_kind:'customer',counterparty_ref:'buyer',amount_minor:100000,description:'Signed original customer collection authority',signed_at:opening}],
  inventory_items:[{ref:'scanner',sku:'SCANNER-1',name:'Scanner'}],
  purchase_orders:[{ref:'equipment-po',vendor_ref:'supplier',purpose:'Equipment for operations',approval:'approved',lines:[{ref:'scanner-line',item_ref:'scanner',quantity:4,unit_price_minor:1001,max_unit_price_minor:1001}],receipts:[{ref:'first-delivery',reference:'DELIVERY-1',lines:[{line_ref:'scanner-line',quantity:2}]},{ref:'second-delivery',reference:'DELIVERY-2',lines:[{line_ref:'scanner-line',quantity:2}]}],invoices:[{ref:'supplier-invoice',invoice_number:'EQUIPMENT-1',due_at:asOf,lines:[{line_ref:'scanner-line',quantity:4,unit_price_minor:1001}]}]}],
  asset_policies:[{ref:'equipment-policy',name:'Three month book policy',useful_life_months:3,salvage_bps:1000}],
  asset_acquisitions:[{ref:'first-authority',name:'In-service scanner pair',policy_ref:'equipment-policy',supplier_invoice_ref:'supplier-invoice',allocations:[{receipt_ref:'first-delivery',po_line_ref:'scanner-line',quantity:2}]},{ref:'second-authority',name:'Uncapitalized scanner pair',policy_ref:'equipment-policy',supplier_invoice_ref:'supplier-invoice',allocations:[{receipt_ref:'second-delivery',po_line_ref:'scanner-line',quantity:2}]}],
  asset_capitalizations:[{ref:'in-service-asset',acquisition_ref:'first-authority',capitalized_at:capitalized,in_service_at:service}],
  asset_disposal_terms:[{ref:'sale-authority',asset_ref:'in-service-asset',kind:'sale',buyer_ref:'buyer',proceeds_minor:1500,reason:'Controller source terms for sale of original equipment'}],
};}
function create(input:any=sources(),id='asset-source-world'){return createWorld({kind:'fixed-asset-close',name:'Equipment',seed:42,orderCount:1,startingCashMinor:2000000,cancelEvent:false,blueprint:input} as any,id);}
const refId=(w:World,ref:string)=>w.blueprintManifest.refs[ref].id;
const balance=(w:World,id:string)=>w.accounts.find(row=>row.id===id).balance_minor;
function expectReject(input:any,code?:string){const before=structuredClone(input);assert.throws(()=>create(input),(error:any)=>!code||error.code===code);assert.deepEqual(input,before);}

test('typed asset sources derive exact receipt cost and record real source history without paying the supplier or preapproving disposal',()=>{
  const input=sources(),before=structuredClone(input),w=create(input);assert.deepEqual(input,before);
  assert.equal(w.fixedAssetPolicies.length,1);assert.equal(w.assetAcquisitionAuthorizations.length,2);assert.equal(w.fixedAssets.length,1);assert.equal(w.assetDisposalAuthorizations.length,1);assert.equal(w.assetDisposals.length,0);assert.equal(w.assetDepreciationEntries.length,0);
  assert.equal(w.supplierInvoices[0].status,'matched');assert.equal(w.bills.length,1);assert.equal(w.bills[0].amount_minor,4004);assert.equal(w.bills[0].amount_paid_minor,0);assert.equal(balance(w,'payables'),-4004);assert.equal(balance(w,'grni'),0);assert.equal(balance(w,'inventory'),2002);assert.equal(balance(w,'fixed-asset-cost'),2002);assert.equal(balance(w,'accumulated-depreciation'),0);assert.equal(w.bankTransactions.length,1);assert.equal(balance(w,'cash-bank'),2000000);
  const asset=w.fixedAssets[0];assert.equal(asset.id,refId(w,'in-service-asset'));assert.equal(asset.cost_minor,2002);assert.equal(asset.salvage_minor,200);assert.equal(asset.useful_life_months,3);assert.equal(asset.capitalized_at,capitalized);assert.equal(asset.in_service_at,service);assert.equal(asset.status,'in_service');assert.equal(w.now,asOf);assert.equal(w.assetDisposalAuthorizations[0].created_at,asOf);assert.equal(w.assetDisposalAuthorizations[0].status,'authorized');
  const receipt=w.goodsReceipts.find((row:any)=>row.id===refId(w,'first-delivery'));assert.equal(asset.allocations[0].receipt_line_id,receipt.lines[0].id);assert.equal(asset.allocations[0].unit_cost_minor,1001);assert.equal(w.assetAcquisitionAuthorizations.find((row:any)=>row.id===refId(w,'second-authority')).status,'authorized');
  assert.equal(w.approvals.length,1);assert.equal(w.approvals[0].status,'approved');assert.notEqual(w.approvals[0].requested_by,w.approvals[0].decided_by);
  const history=w.generationHistory;assert.equal(history.filter((row:any)=>row.action.type==='match_supplier_invoice').length,1);assert.equal(history.find((row:any)=>row.action.type==='capitalize_asset').at,capitalized);assert.equal(history.find((row:any)=>row.action.type==='place_asset_in_service').at,service);assert.equal(history.find((row:any)=>row.action.type==='authorize_asset_disposal').at,asOf);assert.ok(history.some((row:any)=>row.action.type==='advance_to'&&row.action.at===capitalized));assert.ok(history.every((row:any)=>row.action.type!=='pay_bill'&&row.action.type!=='depreciate_asset'&&row.action.type!=='request_asset_disposal'));
  assert.equal(fixedAssetReport(w).register_balanced,true);assert.equal(fixedAssetReport(w).journal_proof_complete,true);
});

test('generated asset history supports actual depreciation, independent disposal and customer collection without rewriting source provenance',()=>{
  const w=create(),asset=w.fixedAssets[0],history=JSON.stringify(w.generationHistory),cash=structuredClone(w.bankTransactions),bill=structuredClone(w.bills[0]);
  const depreciation=applyAction(w,{type:'depreciate_asset',asset_id:asset.id,through_month:'2026-10'},operator).result;assert.equal(depreciation.asset.accumulated_depreciation_minor,1201);assert.equal(depreciation.asset.net_book_value_minor,801);assert.deepEqual(depreciation.entries.map((row:any)=>row.amount_minor),[600,601]);assert.deepEqual(w.bankTransactions,cash);
  const request=applyAction(w,{type:'request_asset_disposal',authorization_id:refId(w,'sale-authority')},operator).result;assert.equal(request.status,'awaiting_approval');assert.deepEqual(w.bankTransactions,cash);assert.equal(w.invoices.length,0);
  const before=structuredClone(w);assert.throws(()=>applyAction(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},{id:operator.id,role:'controller'}));assert.deepEqual(w,before);
  applyAction(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},controller);applyAction(w,{type:'record_asset_disposal_completion',disposal_id:request.disposal.id,disposed_at:w.now,external_event_id:'actual-disposal-completion'},controller);const disposed=applyAction(w,{type:'dispose_asset',disposal_id:request.disposal.id},operator).result;assert.equal(disposed.asset.status,'disposed');assert.equal(disposed.invoice.amount_minor,1500);assert.equal(balance(w,'asset-disposal-gain'),-699);assert.equal(balance(w,'fixed-asset-cost'),0);assert.equal(balance(w,'accumulated-depreciation'),0);assert.deepEqual(w.bankTransactions,cash);assert.deepEqual(w.bills[0],bill);
  applyAction(w,{type:'collect_invoice',invoice_id:disposed.invoice.id},operator);applyAction(w,{type:'advance_time',hours:1},controller);assert.equal(w.invoices[0].status,'paid');assert.equal(balance(w,'cash-bank'),2001500);assert.equal(balance(w,'receivables'),0);assert.deepEqual(w.bills[0],bill);assert.equal(JSON.stringify(w.generationHistory),history);assert.equal(fixedAssetReport(w).journal_proof_complete,true);
});

test('authority-only acquisition remains usable by a later operator and same-time capitalization precedes service',()=>{
  const input=sources();input.asset_capitalizations[0].capitalized_at=opening;input.asset_capitalizations[0].in_service_at=opening;const w=create(input);assert.equal(w.fixedAssets[0].in_service_at,opening);const before=w.bankTransactions.length;
  const result=applyAction(w,{type:'capitalize_asset',authorization_id:refId(w,'second-authority')},operator).result;assert.equal(result.asset.cost_minor,2002);assert.equal(result.asset.status,'capitalized');assert.equal(result.asset.in_service_at,undefined);assert.equal(w.fixedAssets.length,2);assert.equal(balance(w,'inventory'),0);assert.equal(balance(w,'fixed-asset-cost'),4004);assert.equal(w.bankTransactions.length,before);
  const count=w.operations.length;assert.equal(applyAction(w,{type:'capitalize_asset',authorization_id:refId(w,'second-authority')},operator).result.replayed,true);assert.equal(w.operations.length,count);
});

test('closed accounting retains physical asset facts and posts each genuine source operation once after reopening',()=>{
  const input=sources();input.period_closed=true;const w=create(input);assert.equal(w.fixedAssets[0].cost_minor,2002);assert.equal(w.fixedAssets[0].status,'in_service');assert.equal(w.journals.length,1);assert.equal(balance(w,'fixed-asset-cost'),0);assert.equal(balance(w,'payables'),0);assert.equal(w.operations.length,4);assert.ok(w.operations.every((row:any)=>row.status==='settled'&&!row.journal_id));
  const bank=structuredClone(w.bankTransactions),history=JSON.stringify(w.generationHistory);applyAction(w,{type:'reopen_period'},controller);assert.equal(balance(w,'fixed-asset-cost'),2002);assert.equal(balance(w,'inventory'),2002);assert.equal(balance(w,'payables'),-4004);assert.deepEqual(w.bankTransactions,bank);assert.equal(w.journals.length,5);applyAction(w,{type:'reopen_period'},controller);assert.equal(w.journals.length,5);assert.equal(JSON.stringify(w.generationHistory),history);assert.equal(fixedAssetReport(w).journal_proof_complete,true);
});

test('asset topology rejects wrong source kinds, cross-order receipt references, duplicate claims and cumulative excess',()=>{
  for(const mutate of [(b:any)=>b.asset_acquisitions[0].policy_ref='equipment-po',(b:any)=>b.asset_acquisitions[0].supplier_invoice_ref='buyer-contract',(b:any)=>b.asset_acquisitions[0].allocations[0].po_line_ref='scanner',(b:any)=>b.asset_acquisitions[0].allocations.push({...b.asset_acquisitions[0].allocations[0]}),(b:any)=>b.asset_acquisitions[1].allocations[0].quantity=3,(b:any)=>b.asset_acquisitions[1].allocations[0].receipt_ref='first-delivery',(b:any)=>b.purchase_orders[0].invoices[0].lines[0].quantity=3,(b:any)=>b.asset_capitalizations.push({...b.asset_capitalizations[0],ref:'duplicate-asset'}),(b:any)=>b.asset_disposal_terms.push({...b.asset_disposal_terms[0],ref:'duplicate-disposal'}),(b:any)=>b.asset_policies[0].ref='supplier']){const input=sources();mutate(input);expectReject(input);}
  const cross=sources();cross.purchase_orders.push({ref:'other-order',vendor_ref:'supplier',purpose:'Other approved source',approval:'approved',lines:[{ref:'other-line',item_ref:'scanner',quantity:2,unit_price_minor:1001,max_unit_price_minor:1001}],receipts:[{ref:'other-receipt',reference:'OTHER',lines:[{line_ref:'other-line',quantity:2}]}],invoices:[]});cross.asset_acquisitions[0].allocations[0]={receipt_ref:'other-receipt',po_line_ref:'other-line',quantity:2};expectReject(cross,'invalid_blueprint_asset_source');
});

test('actual matching rejects price discrepancies and an asset cannot claim a receipt allocated by FIFO to another invoice',()=>{
  const price=sources();price.purchase_orders[0].invoices[0].lines[0].unit_price_minor=1002;expectReject(price,'blueprint_asset_invoice_unmatched');
  const fifo=sources();fifo.asset_acquisitions=fifo.asset_acquisitions.slice(0,1);fifo.asset_acquisitions[0].allocations[0].receipt_ref='second-delivery';fifo.purchase_orders[0].invoices[0].lines[0].quantity=2;expectReject(fifo,'blueprint_source_rejected');
});

test('asset timestamps cannot backdate acquisition, place service before capitalization or escape the construction window',()=>{
  for(const mutate of [(b:any)=>b.asset_capitalizations[0].capitalized_at='2026-07-31T09:00:00.000Z',(b:any)=>b.asset_capitalizations[0].capitalized_at='2026-11-02T09:00:00.000Z',(b:any)=>b.asset_capitalizations[0].in_service_at=opening,(b:any)=>b.asset_capitalizations[0].in_service_at='2026-11-02T09:00:00.000Z']){const input=sources();mutate(input);expectReject(input,'invalid_blueprint_asset_time');}
  const future=sources();delete future.as_of;expectReject(future,'invalid_blueprint_asset_time');
});

test('sale and retirement terms preserve buyer authority and cannot inject completed disposal, cost or book balances',()=>{
  const noContract=sources();noContract.service_contracts=[];expectReject(noContract,'blueprint_asset_buyer_authority_required');
  const retirement=sources();retirement.asset_disposal_terms=[{ref:'retire-authority',asset_ref:'in-service-asset',kind:'retirement',proceeds_minor:0,reason:'Retire at a later independently approved completion'}];const w=create(retirement);assert.equal(w.assetDisposalAuthorizations[0].kind,'retirement');assert.equal(w.assetDisposalAuthorizations[0].proceeds_minor,0);assert.equal(w.assetDisposals.length,0);assert.equal(w.invoices.length,0);
  for(const mutate of [(b:any)=>b.asset_acquisitions[0].cost_minor=1,(b:any)=>b.asset_capitalizations[0].net_book_value_minor=1,(b:any)=>b.asset_capitalizations[0].accumulated_depreciation_minor=1,(b:any)=>b.asset_policies[0].method='tax-macrs',(b:any)=>b.asset_disposal_terms[0].approved=true,(b:any)=>b.asset_disposal_terms[0].disposed_at=asOf,(b:any)=>b.asset_disposal_terms[0].proceeds_minor=0,(b:any)=>{b.asset_disposal_terms[0].kind='retirement';b.asset_disposal_terms[0].proceeds_minor=0;}]){const input=sources();mutate(input);assert.equal(blueprintSchema.safeParse(input).success,false);}
  assert.doesNotThrow(()=>z.toJSONSchema(z.object(assetBlueprintShape).strict(),{target:'draft-7'}));
});

test('asset sources join global reference and line budgets and remain deterministic across saved world identities',()=>{
  const input=sources(),a=create(input,'first-asset-world'),b=create(input,'second-asset-world');assert.deepEqual({...a,id:'portable'},{...b,id:'portable'});const firstAuthority=a.generationHistory.find((row:any)=>row.action.type==='authorize_asset_acquisition');assert.equal(firstAuthority.result.authorization.status,'authorized');assert.equal(a.assetAcquisitionAuthorizations.find((row:any)=>row.id===firstAuthority.result.authorization.id).status,'capitalized');
  const tooManyLines=sources();tooManyLines.asset_acquisitions=Array.from({length:8},(_,index)=>({...tooManyLines.asset_acquisitions[0],ref:`extra-authority-${index}`,allocations:Array.from({length:50},()=>({...tooManyLines.asset_acquisitions[0].allocations[0]}))}));assert.throws(()=>validateBlueprint(tooManyLines),(e:any)=>e.code==='blueprint_too_large');
});

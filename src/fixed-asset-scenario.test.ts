import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {applyAction,createWorld,recordsFor} from './world.ts';
import {fixedAssetReport} from './fixed-assets.ts';

test('fixed-asset close builds deterministic source-backed acquisition cases and exposes the actual uncompleted work',()=>{
  const w=createWorld({kind:'fixed-asset-close',seed:72});assert.deepEqual(w,createWorld({kind:'fixed-asset-close',seed:72}));assert.equal(w.purchaseOrders.length,3);assert.equal(w.supplierInvoices.length,3);assert.equal(w.bills.length,3);assert.equal(w.fixedAssets.length,2);assert.equal(w.assetAcquisitionAuthorizations.filter((a:any)=>a.status==='authorized').length,1);assert.equal(w.assetDisposalAuthorizations.length,1);assert.equal(w.assetDisposals.length,0);assert.equal(w.assetDepreciationEntries.length,0);assert.equal(w.invoices.length,0);assert.equal(w.now,'2027-01-01T09:00:00.000Z');assert.equal(w.fixedAssetSources.through_month,'2026-12');
  assert.ok(w.bills.every(bill=>bill.status==='open'&&bill.amount_paid_minor===0));assert.ok(w.supplierInvoices.every((invoice:any)=>invoice.status==='matched'));assert.ok(w.approvals.every(approval=>approval.status==='approved'&&approval.requested_by!==approval.decided_by));assert.equal(w.bankTransactions.length,1);assert.ok(w.messages.some(message=>message.source_refs.includes(w.fixedAssetSources.brief_document_id)));assert.equal(fixedAssetReport(w).journal_proof_complete,true);assert.deepEqual(recordsFor(w,'assettiger','fixed-asset'),w.fixedAssets);
});

test('fixed-asset scenario honors case counts and fault application without inventing missing financial history',()=>{
  for(const count of [1,2,4,12]){const w=createWorld({kind:'fixed-asset-close',orderCount:count,seed:'repeatable',initialFaults:[{system:'netsuite',mode:'offline'}]});assert.equal(w.purchaseOrders.length,count);assert.equal(w.assetAcquisitionAuthorizations.length,count);assert.equal(w.fixedAssets.length,count-Math.floor((count+1)/3));assert.equal(w.assetDisposalAuthorizations.length,Math.floor(count/3));assert.equal(w.faults.netsuite.mode,'offline');assert.ok(w.operations.every(op=>op.journal_id));assert.equal(fixedAssetReport(w).register_balanced,true);}
});

test('operator can finish seeded depreciation while actual sale still waits for approval and physical evidence',()=>{
  const w=createWorld({kind:'fixed-asset-close',seed:19}),operator={id:'asset-close-agent',role:'agent' as const};for(const asset of w.fixedAssets){const result=applyAction(w,{type:'depreciate_asset',asset_id:asset.id,through_month:w.fixedAssetSources.through_month},operator).result;assert.equal(result.entries.length,2);assert.equal(result.asset.accumulated_depreciation_minor,Number(BigInt(asset.cost_minor-asset.salvage_minor)*2n/36n));}
  const auth=w.assetDisposalAuthorizations[0],request=applyAction(w,{type:'request_asset_disposal',authorization_id:auth.id},operator).result;assert.equal(request.status,'awaiting_approval');assert.equal(w.invoices.length,0);assert.equal(w.bankTransactions.length,1);assert.equal(fixedAssetReport(w).journal_proof_complete,true);
});

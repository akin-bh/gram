import {test,expect} from 'bun:test';
import {applyAction,createWorld,recordsFor} from './world.ts';
import {fixedAssetReport} from './fixed-assets.ts';

test('fixed-asset close builds deterministic source-backed acquisition cases and exposes the actual uncompleted work',()=>{
  const w=createWorld({kind:'fixed-asset-close',seed:72});expect(w).toStrictEqual(createWorld({kind:'fixed-asset-close',seed:72}));expect(w.purchaseOrders.length).toBe(3);expect(w.supplierInvoices.length).toBe(3);expect(w.bills.length).toBe(3);expect(w.fixedAssets.length).toBe(2);expect(w.assetAcquisitionAuthorizations.filter((a:any)=>a.status==='authorized').length).toBe(1);expect(w.assetDisposalAuthorizations.length).toBe(1);expect(w.assetDisposals.length).toBe(0);expect(w.assetDepreciationEntries.length).toBe(0);expect(w.invoices.length).toBe(0);expect(w.now).toBe('2027-01-01T09:00:00.000Z');expect(w.fixedAssetSources.through_month).toBe('2026-12');
  expect(w.bills.every(bill=>bill.status==='open'&&bill.amount_paid_minor===0)).toBeTruthy();expect(w.supplierInvoices.every((invoice:any)=>invoice.status==='matched')).toBeTruthy();expect(w.approvals.every(approval=>approval.status==='approved'&&approval.requested_by!==approval.decided_by)).toBeTruthy();expect(w.bankTransactions.length).toBe(1);expect(w.messages.some(message=>message.source_refs.includes(w.fixedAssetSources.brief_document_id))).toBeTruthy();expect(fixedAssetReport(w).journal_proof_complete).toBe(true);expect(recordsFor(w,'assettiger','fixed-asset')).toStrictEqual(w.fixedAssets);
});

test('fixed-asset scenario honors case counts and fault application without inventing missing financial history',()=>{
  for(const count of [1,2,4,12]){const w=createWorld({kind:'fixed-asset-close',orderCount:count,seed:'repeatable',initialFaults:[{system:'netsuite',mode:'offline'}]});expect(w.purchaseOrders.length).toBe(count);expect(w.assetAcquisitionAuthorizations.length).toBe(count);expect(w.fixedAssets.length).toBe(count-Math.floor((count+1)/3));expect(w.assetDisposalAuthorizations.length).toBe(Math.floor(count/3));expect(w.faults.netsuite.mode).toBe('offline');expect(w.operations.every(op=>op.journal_id)).toBeTruthy();expect(fixedAssetReport(w).register_balanced).toBe(true);}
});

test('operator can finish seeded depreciation while actual sale still waits for approval and physical evidence',()=>{
  const w=createWorld({kind:'fixed-asset-close',seed:19}),operator={id:'asset-close-agent',role:'agent' as const};for(const asset of w.fixedAssets){const result=applyAction(w,{type:'depreciate_asset',asset_id:asset.id,through_month:w.fixedAssetSources.through_month},operator).result;expect(result.entries.length).toBe(2);expect(result.asset.accumulated_depreciation_minor).toBe(Number(BigInt(asset.cost_minor-asset.salvage_minor)*2n/36n));}
  const auth=w.assetDisposalAuthorizations[0],request=applyAction(w,{type:'request_asset_disposal',authorization_id:auth.id},operator).result;expect(request.status).toBe('awaiting_approval');expect(w.invoices.length).toBe(0);expect(w.bankTransactions.length).toBe(1);expect(fixedAssetReport(w).journal_proof_complete).toBe(true);
});

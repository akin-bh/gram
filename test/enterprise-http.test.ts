import {test,expect} from 'bun:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../src/store.ts';
import {start} from './integration-fixture.ts';
const okay=(response:any)=>{assert.equal(response.status,200,JSON.stringify(response.data));return response.data.result;};
test('asset, FX and statutory workflows enforce HTTP authority and retain exact financial state, receipts and audit after restart',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'gram-enterprise-http-')),database=join(folder,'worlds.sqlite');let f=await start(database);
 try{
  const ids:string[]=[];
  for(const kind of ['fixed-asset-close','treasury-fx','payroll-federal']){
   const created=await f.call('/api/worlds',{kind,orderCount:3,initialCashMinor:2000000});expect(created.status).toBe(201);let w=created.data.world;ids.push(w.id);
   const id=w.id,token=f.agent(id),prefix=`/api/worlds/${id}`,act=(a:any,worker=false,key?:string)=>f.act(id,a,worker?token:undefined,key),state=async()=>(await f.call(prefix)).data.world;
   const caps=(await f.call('/api/capabilities')).data;for(const name of ['record_bank_account','record_fx_quote','record_asset_policy','record_employee_tax_profile','record_statutory_payroll_policy'])expect(caps.controller_actions).toContain(name);for(const name of ['capitalize_asset','request_asset_disposal','request_treasury_transfer','revalue_bank_account'])expect(caps.actions).toContain(name);expect(caps.actions).not.toContain('approve_asset_disposal');
   for(const type of ['record_fx_quote','record_asset_policy','record_employee_tax_profile'])expect((await act({type,external_event_id:'worker-forged'},true)).status).toBe(403);
   for(const system of ['netsuite','gusto','mercury','stripe','gmail'])await f.connect(id,system);
   const subscription=await f.call(prefix+'/webhooks',{events:['operation.*']});expect(subscription.status).toBe(201);
   if(kind==='fixed-asset-close'){
    for(const asset of w.fixedAssets)okay(await act({type:'depreciate_asset',asset_id:asset.id,through_month:w.fixedAssetSources.through_month},true));
    const uncapitalized=w.assetAcquisitionAuthorizations.find((a:any)=>a.status==='authorized');const capitalization=okay(await act({type:'capitalize_asset',authorization_id:uncapitalized.id},true));okay(await act({type:'place_asset_in_service',asset_id:capitalization.asset.id,in_service_at:w.now,external_event_id:'asset-service'}));
    const authority=w.assetDisposalAuthorizations[0],requested=okay(await act({type:'request_asset_disposal',authorization_id:authority.id},true));expect(requested.status).toBe('awaiting_approval');
    expect((await act({type:'approve_asset_disposal',disposal_id:requested.disposal.id},true)).status).toBe(400);
    okay(await act({type:'decide_approval',approval_id:requested.approval_id,decision:'approve'}));
    expect((await act({type:'dispose_asset',disposal_id:requested.disposal.id},true)).status).toBe(409);
    okay(await act({type:'record_asset_disposal_completion',disposal_id:requested.disposal.id,disposed_at:w.now,external_event_id:'physical-sale'}));
    const disposed=okay(await act({type:'dispose_asset',disposal_id:requested.disposal.id},true));expect(disposed.invoice.source_type).toBe('asset_sale');const beforeCash=(await f.call(prefix)).data.summary.cash_minor;
    okay(await act({type:'collect_invoice',invoice_id:disposed.invoice.id},true,'asset-collection'));okay(await act({type:'advance_time',hours:1}));w=await state();expect(w.invoices.find((i:any)=>i.id===disposed.invoice.id).status).toBe('paid');expect((await f.call(prefix)).data.summary.cash_minor).toBe(beforeCash+disposed.invoice.amount_minor);
    const journals=w.journals.length,rows=w.bankTransactions.length;expect((await act({type:'collect_invoice',invoice_id:disposed.invoice.id},true,'asset-collection')).data.replayed).toBe(true);w=await state();expect([w.journals.length,w.bankTransactions.length]).toEqual([journals,rows]);
   }else if(kind==='treasury-fx'){
    const source=w.treasurySources;okay(await act({type:'revalue_bank_account',bank_account_id:source.bank_account_id,quote_id:source.closing_quote_id},true));
    const request={type:'request_treasury_transfer',from_account_id:source.bank_account_id,to_account_id:'cash-bank',amount_minor:source.requested_repatriation_minor,fee_minor:0,quote_id:source.closing_quote_id,reason:'Controller cash mandate'};
    const proposed=okay(await act(request,true));expect(proposed.status).toBe('awaiting_approval');okay(await act({type:'decide_approval',approval_id:proposed.approval_id,decision:'approve'}));
    okay(await act({type:'set_fault',system:'mercury',mode:'offline'}));okay(await act({type:'advance_time',hours:1}));w=await state();expect(w.treasuryTransfers.find((t:any)=>t.id===proposed.transfer.id).status).toBe('pending');
    okay(await act({type:'set_fault',system:'mercury',mode:'healthy'}));okay(await act({type:'close_period'}));okay(await act({type:'advance_time',hours:1}));w=await state();const op=w.operations.find((o:any)=>o.id===w.treasuryTransfers.find((t:any)=>t.id===proposed.transfer.id).operation_id);expect(op.cash_legs).toHaveLength(2);expect(op.accounting_status).toBe('pending_posting');const receipt=op.receipt_id;
    okay(await act({type:'reopen_period'}));w=await state();expect(w.operations.find((o:any)=>o.id===op.id).receipt_id).toBe(receipt);expect(w.operations.find((o:any)=>o.id===op.id).accounting_status).toBe('posted');
   }else{
    const source=w.statutoryPayrollSources,calculated=okay(await act({type:'calculate_payroll',policy_id:source.policy_id,employee_ids:source.employee_ids,time_record_ids:source.time_record_ids},true)).payroll_run;
    expect(calculated.lines[0].tax_calculation.employee_social_security_minor).toBe(3100);expect(calculated.lines[0].tax_calculation.employee_additional_medicare_minor).toBe(900);expect(calculated.lines[0].tax_calculation.employer_futa_minor).toBe(0);
    const wage=okay(await act({type:'execute_payroll',payroll_run_id:calculated.id},true));okay(await act({type:'close_period'}));okay(await act({type:'decide_approval',approval_id:wage.approval_id,decision:'approve'}));okay(await act({type:'advance_time',hours:1}));w=await state();expect(w.payrollRuns[0].status).toBe('paid');expect(w.payslips.every((p:any)=>p.tax_calculation.ruleset.ruleset_sha256)).toBe(true);
    const tax=okay(await act({type:'remit_payroll_taxes',payroll_run_id:calculated.id},true));okay(await act({type:'decide_approval',approval_id:tax.approval_id,decision:'approve'}));okay(await act({type:'advance_time',hours:1}));okay(await act({type:'reopen_period'}));w=await state();expect(w.payrollRuns[0].tax_paid_minor).toBe(calculated.tax_total_minor);expect(w.bankTransactions.filter((b:any)=>b.payroll_run_id===calculated.id)).toHaveLength(2);
   }
   expect((await f.call(prefix)).data.summary.reconciliation.balanced).toBe(true);expect(f.server.store.verify(id).valid).toBe(true);const dispatch=await f.call(prefix+'/webhooks/dispatch',{});expect(dispatch.data.failed).toBe(0);expect(dispatch.data.delivered).toBeGreaterThan(0);
   const snapshot=(await f.call(prefix)).data;expect(snapshot.webhooks.receiver.receipts.length).toBe(snapshot.webhooks.deliveries.data.length);
  }
  const fingerprints=Object.fromEntries(ids.map(id=>[id,hash(JSON.stringify(f.server.store.world(id)))])),chains=Object.fromEntries(ids.map(id=>[id,f.server.store.verify(id)])),port=Number(new URL(f.base).port);
  await f.close();f=await start(database,port);expect((await fetch(f.base+'/health')).status).toBe(200);
  for(const id of ids){expect(hash(JSON.stringify(f.server.store.world(id)))).toBe(fingerprints[id]);expect(f.server.store.verify(id)).toEqual(chains[id]);}
 }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

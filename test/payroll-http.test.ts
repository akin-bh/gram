import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {hash} from '../src/store.ts';

async function start(database:string,port=0){
  const server=await startServer({database,port,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  let cookie:string;
  try{
    const home=await fetch(base,{headers:{Connection:'close'}});assert.equal(home.status,200);
    cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  }catch(error){await server.close();throw error;}
  const call=async(path:string,input?:any,token?:string,key:string=randomUUID(),anonymous=false)=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:(anonymous?{}:{Cookie:cookie})),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const connect=async(world:string,system:string)=>{
    const started=await call(`/api/worlds/${world}/connect/${system}`,{});assert.equal(started.status,200,JSON.stringify(started.data));
    const url=new URL(started.data.authorization_url);
    const consent=await fetch(`${base}/oauth/${system}/consent${url.search}`,{headers:{Cookie:cookie}});assert.equal(consent.status,200);
    const info=await consent.json();assert.equal(info.world,world);assert.equal(info.provider.id,system);assert.deepEqual(info.scopes,['read','write']);
    const params=new URLSearchParams(url.search);params.set('decision','allow');
    const allowed=await fetch(base+url.pathname,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});assert.equal(allowed.status,303);await allowed.text();
    const callback=await fetch(allowed.headers.get('location')!,{headers:{Cookie:cookie},redirect:'manual'});assert.equal(callback.status,303);await callback.text();
  };
  const grant=async(world:string,scope:string)=>{
    const redirect='http://127.0.0.1:9123/payroll-test-callback',registered=await call('/api/oauth/clients',{name:'Payroll HTTP scope verification',redirect_uris:[redirect]});assert.equal(registered.status,201);
    const client=registered.data.client_id,verifier=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
    const form=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope,state:randomUUID(),world_id:world,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
    const accepted=await fetch(base+'/oauth/gusto/authorize',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});assert.equal(accepted.status,303);await accepted.text();
    const code=new URL(accepted.headers.get('location')!).searchParams.get('code');
    const token=await call('/oauth/gusto/token',{grant_type:'authorization_code',client_id:client,redirect_uri:redirect,code,code_verifier:verifier},undefined,randomUUID(),true);assert.equal(token.status,200,JSON.stringify(token.data));return token.data.access_token as string;
  };
  const create=async(input:any={})=>{const created=await call('/api/worlds',{kind:'payroll-close',name:'Payroll HTTP verification',seed:17,orderCount:2,approvalThresholdMinor:100000000,payrollControls:{missingTime:false,disabledRoute:false},...input});assert.equal(created.status,201,JSON.stringify(created.data));return created.data.world;};
  const agent=(world:string)=>{const token=randomUUID();server.store.put('agent-tokens',hash(token),{world,actor:`agent-world:${world}`,expires_at:Date.now()+60000});return token;};
  const act=(world:string,input:any,token?:string,key?:string)=>call(`/api/worlds/${world}/actions`,input,token,key);
  return {server,base,call,connect,grant,create,agent,act,close:()=>server.close()};
}
async function fixture(){
  const folder=mkdtempSync(join(tmpdir(),'finance-payroll-http-')),database=join(folder,'world.sqlite');
  try{const f=await start(database);return {...f,folder,database,dispose:async()=>{await f.close();rmSync(folder,{recursive:true,force:true});}};}catch(error){rmSync(folder,{recursive:true,force:true});throw error;}
}
const okay=(response:any)=>{assert.equal(response.status,200,JSON.stringify(response.data));return response.data.result;};
const calculation=(world:any)=>({type:'calculate_payroll',policy_id:world.payrollPolicies[0].id,time_record_ids:world.payrollTimeRecords.map((record:any)=>record.id),employee_ids:world.employees.map((employee:any)=>employee.id)});

test('payroll HTTP source facts remain controller-owned and real OAuth grants enforce world, provider and write scope',async()=>{
  const f=await fixture();
  try{
    const w=await f.create(),other=await f.create({name:'Other payroll company'}),token=f.agent(w.id),prefix=`/api/worlds/${w.id}`;
    const context=await f.call(prefix+'/context',undefined,token);assert.equal(context.status,200);
    for(const action of ['calculate_payroll','execute_payroll','remit_payroll_taxes'])assert.ok(context.data.available_actions.includes(action));
    for(const type of ['record_employee','set_employee_route','record_payroll_policy','record_payroll_time','cancel_payroll'])assert.equal((await f.act(w.id,{type,external_event_id:'agent-cannot-manufacture-source'},token)).status,403,type);
    assert.equal((await f.call(prefix+'/records?system=gusto&feed=payroll-time',undefined,token)).status,401);
    assert.equal((await f.act(w.id,calculation(w),token)).status,401);
    const readToken=await f.grant(w.id,'read');
    const records=await f.call(prefix+'/records?system=gusto&feed=payroll-time',undefined,readToken);assert.equal(records.status,200);assert.equal(records.data.data.length,w.payrollTimeRecords.length);
    assert.equal((await f.act(w.id,calculation(w),readToken)).status,403);
    assert.equal((await f.call(`/api/worlds/${other.id}/records?system=gusto&feed=payroll-time`,undefined,readToken)).status,403);
    assert.equal((await f.call(prefix+'/records?system=gmail&feed=message',undefined,readToken)).status,403);
    const writeToken=await f.grant(w.id,'read write');
    okay(await f.act(w.id,calculation(w),writeToken));
    const snapshot=(await f.call(prefix)).data;assert.equal(snapshot.world.payrollRuns.length,1);assert.equal(snapshot.world.operations.length,0);assert.equal(snapshot.world.payslips.length,0);
    assert.equal((await f.act(w.id,{type:'decide_approval',approval_id:'forged',decision:'approve'},writeToken)).status,403);
    assert.equal(f.server.store.verify(w.id).valid,true);
    const audit=JSON.stringify(f.server.store.events(w.id,0,1000));for(const secret of [readToken,writeToken,token])assert.ok(!audit.includes(secret));
  }finally{await f.dispose();}
});

test('payroll and tax payments require separate approval, settle once through outages, and retain payslips, webhooks and restart evidence',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'finance-payroll-restart-')),database=join(folder,'world.sqlite');let f=await start(database);
  try{
    const w=await f.create(),token=f.agent(w.id),prefix=`/api/worlds/${w.id}`;
    for(const system of ['gusto','gmail','bank','ledger'])await f.connect(w.id,system);
    const subscription=await f.call(prefix+'/webhooks',{events:['payroll.*']});assert.equal(subscription.status,201);
    const opening=(await f.call(prefix)).data.summary.cash_minor,input=calculation(w);
    const calculations=await Promise.all(Array.from({length:4},()=>f.act(w.id,input,token,'one-payroll-calculation')));
    calculations.forEach(okay);assert.equal(calculations.filter(response=>!response.data.replayed).length,1);
    const run=calculations[0].data.result.payroll_run,runId=run.id,immutableLines=structuredClone(run.lines);
    assert.equal(run.gross_minor,run.net_minor+run.employee_withholding_minor);assert.equal(run.tax_total_minor,run.employee_withholding_minor+run.employer_tax_minor);
    const requested=okay(await f.act(w.id,{type:'execute_payroll',payroll_run_id:runId},token,'execute-one-payroll'));assert.equal(requested.status,'awaiting_approval');
    assert.equal(okay(await f.act(w.id,{type:'execute_payroll',payroll_run_id:runId},token,'execute-one-payroll')).approval_id,requested.approval_id);
    assert.equal((await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},token)).status,403);
    let snapshot=(await f.call(prefix)).data;assert.equal(snapshot.summary.cash_minor,opening);assert.equal(snapshot.world.payslips.length,0);
    const approved=okay(await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'}));
    assert.equal(approved.operation.status,'pending');assert.ok(approved.accrual_operation.id);
    const cancelPending=await f.act(w.id,{type:'cancel_payroll',payroll_run_id:runId,reason:'Accepted payments cannot be erased',external_event_id:'cancel-accepted-payroll'});assert.equal(cancelPending.status,409);assert.equal(cancelPending.data.error.code,'payroll_cannot_cancel');
    snapshot=(await f.call(prefix)).data;assert.equal(snapshot.summary.cash_minor,opening);assert.equal(snapshot.summary.available_cash_minor,opening-run.net_minor);
    const balance=(state:any,id:string)=>state.world.accounts.find((account:any)=>account.id===id).balance_minor;
    assert.equal(balance(snapshot,'payroll-expense'),run.gross_minor);assert.equal(balance(snapshot,'employer-payroll-tax-expense'),run.employer_tax_minor);assert.equal(balance(snapshot,'wages-payable'),-run.net_minor);assert.equal(balance(snapshot,'employee-withholding-payable'),-run.employee_withholding_minor);assert.equal(balance(snapshot,'employer-payroll-tax-payable'),-run.employer_tax_minor);
    okay(await f.act(w.id,{type:'set_fault',system:'gusto',mode:'offline'}));okay(await f.act(w.id,{type:'advance_time',hours:1}));
    snapshot=(await f.call(prefix)).data;assert.equal(snapshot.world.operations.find((op:any)=>op.id===approved.operation.id).status,'pending');assert.equal(snapshot.world.payslips.length,0);assert.equal(snapshot.summary.cash_minor,opening);
    assert.equal((await f.call(prefix+'/records?system=gusto&feed=payroll-run',undefined,token)).status,503);
    okay(await f.act(w.id,{type:'set_fault',system:'gusto',mode:'healthy'}));okay(await f.act(w.id,{type:'set_fault',system:'gmail',mode:'offline'}));okay(await f.act(w.id,{type:'close_period'}));okay(await f.act(w.id,{type:'advance_time',hours:1}));
    snapshot=(await f.call(prefix)).data;let paid=snapshot.world.payrollRuns.find((row:any)=>row.id===runId);
    assert.equal(paid.status,'paid');assert.equal(paid.amount_paid_minor,run.net_minor);assert.deepEqual(paid.lines,immutableLines);assert.equal(snapshot.summary.cash_minor,opening-run.net_minor);assert.equal(snapshot.world.payslips.length,w.employees.length);assert.ok(snapshot.summary.unposted_settlements>0);
    for(const slip of snapshot.world.payslips){
      const line=immutableLines.find((row:any)=>row.employee_id===slip.employee_id);assert.equal(slip.net_minor,line.net_minor);assert.equal(slip.gross_minor,line.gross_minor);assert.ok(slip.receipt_id);assert.equal(slip.payroll_run_id,runId);
      const mail=snapshot.world.messages.find((row:any)=>row.source_refs?.includes(slip.id));assert.ok(mail);assert.equal(mail.delivery_status,'queued');assert.ok(mail.source_refs.includes(slip.document_id));assert.ok(mail.source_refs.includes(slip.receipt_id));
    }
    const tax=okay(await f.act(w.id,{type:'remit_payroll_taxes',payroll_run_id:runId},token,'one-tax-remittance'));assert.equal(tax.status,'awaiting_approval');assert.notEqual(tax.approval_id,requested.approval_id);assert.equal(tax.tax_remittance.amount_minor,run.tax_total_minor);
    assert.equal(okay(await f.act(w.id,{type:'remit_payroll_taxes',payroll_run_id:runId},token)).tax_remittance.id,tax.tax_remittance.id);
    assert.equal((await f.act(w.id,{type:'decide_approval',approval_id:tax.approval_id,decision:'approve'},token)).status,403);
    const taxApproved=okay(await f.act(w.id,{type:'decide_approval',approval_id:tax.approval_id,decision:'approve'}));assert.equal(taxApproved.operation.status,'pending');
    assert.equal(okay(await f.act(w.id,{type:'remit_payroll_taxes',payroll_run_id:runId},token)).operation.id,taxApproved.operation.id);
    snapshot=(await f.call(prefix)).data;assert.equal(snapshot.summary.available_cash_minor,opening-run.net_minor-run.tax_total_minor);
    okay(await f.act(w.id,{type:'advance_time',hours:1}));snapshot=(await f.call(prefix)).data;paid=snapshot.world.payrollRuns.find((row:any)=>row.id===runId);
    assert.equal(paid.tax_paid_minor,run.tax_total_minor);assert.equal(snapshot.summary.cash_minor,opening-run.gross_minor-run.employer_tax_minor);assert.equal(snapshot.world.payrollTaxRemittances.length,1);assert.equal(snapshot.world.payslips.length,w.employees.length);
    okay(await f.act(w.id,{type:'reopen_period'}));okay(await f.act(w.id,{type:'set_fault',system:'gmail',mode:'healthy'}));okay(await f.act(w.id,{type:'advance_time',hours:1}));
    snapshot=(await f.call(prefix)).data;assert.equal(snapshot.summary.unposted_settlements,0);assert.equal(snapshot.summary.reconciliation.balanced,true);assert.equal(snapshot.summary.reconciliation.bank_ledger_difference_minor,0);
    for(const id of ['wages-payable','employee-withholding-payable','employer-payroll-tax-payable'])assert.equal(balance(snapshot,id),0);
    for(const slip of snapshot.world.payslips)assert.equal(snapshot.world.messages.find((row:any)=>row.source_refs?.includes(slip.id)).delivery_status,'delivered');
    const dispatch=await f.call(prefix+'/webhooks/dispatch',{});assert.equal(dispatch.status,200);assert.equal(dispatch.data.failed,0);assert.ok(dispatch.data.delivered>0);
    snapshot=(await f.call(prefix)).data;const deliveries=snapshot.webhooks.deliveries.data;
    assert.ok(deliveries.some((row:any)=>row.event.type==='payroll.paid'));assert.ok(deliveries.some((row:any)=>row.event.type==='payroll.taxes_remitted'));assert.ok(deliveries.every((row:any)=>row.status==='delivered'));assert.equal(snapshot.webhooks.receiver.receipts.length,deliveries.length);
    assert.equal(f.server.store.verify(w.id).valid,true);
    const counts={operations:snapshot.world.operations.length,journals:snapshot.world.journals.length,bank:snapshot.world.bankTransactions.length,payslips:snapshot.world.payslips.length,receipts:snapshot.webhooks.receiver.receipts.length},port=Number(new URL(f.base).port);
    await f.close();f=await start(database,port);const nextToken=f.agent(w.id);
    assert.equal((await f.act(w.id,input,nextToken,'one-payroll-calculation')).data.replayed,true);
    assert.equal((await f.act(w.id,{type:'execute_payroll',payroll_run_id:runId},nextToken,'execute-one-payroll')).data.replayed,true);
    assert.equal((await f.act(w.id,{type:'remit_payroll_taxes',payroll_run_id:runId},nextToken,'one-tax-remittance')).data.replayed,true);
    okay(await f.act(w.id,{type:'advance_time',hours:1}));snapshot=(await f.call(prefix)).data;
    assert.deepEqual({operations:snapshot.world.operations.length,journals:snapshot.world.journals.length,bank:snapshot.world.bankTransactions.length,payslips:snapshot.world.payslips.length,receipts:snapshot.webhooks.receiver.receipts.length},counts);
    assert.equal((await f.call(prefix+'/records?system=gusto&feed=payslip',undefined,nextToken)).data.data.length,w.employees.length);
    assert.equal((await f.call(prefix+'/records?system=gusto&feed=payroll-tax-remittance',undefined,nextToken)).data.data.length,1);
    assert.equal(f.server.store.verify(w.id).valid,true);
    const log=JSON.stringify(f.server.store.events(w.id,0,1000));assert.ok(!log.includes(subscription.data.secret));
  }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

test('missing payroll sources and disabled routes cannot be supplied by the worker or bypassed at approval and settlement',async()=>{
  const f=await fixture();
  try{
    const w=await f.create({payrollControls:{missingTime:true,disabledRoute:true}}),prefix=`/api/worlds/${w.id}`,token=f.agent(w.id);await f.connect(w.id,'gusto');
    const missing=await f.act(w.id,calculation(w),token);assert.equal(missing.status,409);assert.equal(missing.data.error.code,'missing_payroll_time');
    assert.equal((await f.call(prefix)).data.world.payrollRuns.length,0);
    const source=w.payrollTimeRecords[0],employee=w.employees[1],time={type:'record_payroll_time',employee_id:employee.id,period_start:source.period_start,period_end:source.period_end,minutes:source.minutes,external_event_id:'missing-time-verified'};
    assert.equal((await f.act(w.id,time,token)).status,403);
    const received=okay(await f.act(w.id,time)),again=okay(await f.act(w.id,time));assert.equal(again.replayed,true);assert.equal(again.time_record.id,received.time_record.id);
    const changed=await f.act(w.id,{...time,minutes:source.minutes+1});assert.equal(changed.status,409);assert.equal(changed.data.error.code,'external_event_conflict');
    const employeeUpdate=await f.act(w.id,{type:'record_employee',employee_id:employee.id,display_name:'Altered employee',hourly_rate_minor:1,external_event_id:'rewrite-original-wage'});assert.equal(employeeUpdate.status,409);assert.equal(employeeUpdate.data.error.code,'employee_exists');
    const state=(await f.call(prefix)).data.world;
    const result=okay(await f.act(w.id,{...calculation(state),gross_minor:1,net_minor:1,verified_route_id:'attacker-route',status:'paid'},token)),run=result.payroll_run,originalLines=structuredClone(result.payroll_run.lines);
    assert.ok(run.net_minor>1);assert.equal(run.status,'calculated');assert.ok(run.lines.every((line:any)=>line.verified_route_id===`synthetic-payroll-route-${line.employee_id}`));
    const disabled=await f.act(w.id,{type:'execute_payroll',payroll_run_id:run.id},token);assert.equal(disabled.status,409);assert.equal(disabled.data.error.code,'payroll_route_disabled');
    assert.equal((await f.call(prefix)).data.world.approvals.length,0);
    const route=(enabled:boolean,event:string)=>({type:'set_employee_route',employee_id:employee.id,enabled,reason:'Controller verified synthetic route availability',external_event_id:event});
    assert.equal((await f.act(w.id,route(true,'worker-cannot-enable-route'),token)).status,403);
    okay(await f.act(w.id,route(true,'controller-enables-route')));
    const requested=okay(await f.act(w.id,{type:'execute_payroll',payroll_run_id:run.id},token));assert.equal(requested.status,'awaiting_approval');
    okay(await f.act(w.id,route(false,'route-unavailable-at-approval')));
    const approval=await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'});assert.equal(approval.status,409);assert.equal(approval.data.error.code,'payroll_route_disabled');
    let snapshot=(await f.call(prefix)).data;assert.equal(snapshot.world.approvals[0].status,'pending');assert.equal(snapshot.world.operations.length,0);
    okay(await f.act(w.id,route(true,'verified-for-approval')));const approved=okay(await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'}));
    const before=snapshot.summary.cash_minor;okay(await f.act(w.id,route(false,'route-unavailable-before-settlement')));okay(await f.act(w.id,{type:'advance_time',hours:1}));
    snapshot=(await f.call(prefix)).data;assert.equal(snapshot.world.operations.find((operation:any)=>operation.id===approved.operation.id).last_error,'payroll_route_disabled');assert.equal(snapshot.world.payslips.length,0);assert.equal(snapshot.summary.cash_minor,before);
    okay(await f.act(w.id,route(true,'verified-for-settlement')));okay(await f.act(w.id,{type:'advance_time',hours:1}));snapshot=(await f.call(prefix)).data;
    assert.equal(snapshot.world.payslips.length,2);assert.deepEqual(snapshot.world.payrollRuns[0].lines,originalLines);assert.equal(snapshot.summary.cash_minor,before-run.net_minor);assert.equal(snapshot.summary.reconciliation.balanced,true);assert.equal(f.server.store.verify(w.id).valid,true);
    const second=await f.create({orderCount:1});await f.connect(second.id,'gusto');const selfRun=okay(await f.act(second.id,calculation(second))).payroll_run;
    const selfRequested=okay(await f.act(second.id,{type:'execute_payroll',payroll_run_id:selfRun.id}));
    const selfApprove=await f.act(second.id,{type:'decide_approval',approval_id:selfRequested.approval_id,decision:'approve'});assert.equal(selfApprove.status,403);assert.equal(selfApprove.data.error.code,'separate_controller_required');
    assert.equal((await f.call(`/api/worlds/${second.id}`)).data.world.operations.length,0);
    const cancellation={type:'cancel_payroll',payroll_run_id:selfRun.id,reason:'Release mistaken unexecuted calculation for a separate requester',external_event_id:'cancel-unexecuted-payroll'};
    const cancelled=okay(await f.act(second.id,cancellation));assert.equal(cancelled.payroll_run.status,'rejected');assert.equal(okay(await f.act(second.id,cancellation)).replayed,true);
    assert.equal((await f.call(`/api/worlds/${second.id}`)).data.world.approvals[0].status,'rejected');
    const replacement=okay(await f.act(second.id,calculation(second),f.agent(second.id))).payroll_run;assert.notEqual(replacement.id,selfRun.id);assert.deepEqual(replacement.lines,selfRun.lines);
    const rejectedExecution=await f.act(second.id,{type:'execute_payroll',payroll_run_id:selfRun.id});assert.equal(rejectedExecution.status,409);assert.equal(rejectedExecution.data.error.code,'payroll_rejected');
  }finally{await f.dispose();}
});

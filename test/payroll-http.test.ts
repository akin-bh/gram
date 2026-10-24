import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {hash} from '../src/store.ts';

async function start(database:string,port=0){
  const server=await startServer({database,port,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  let cookie:string;
  try{
    const home=await fetch(base,{headers:{Connection:'close'}});expect(home.status).toBe(200);
    cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  }catch(error){await server.close();throw error;}
  const call=async(path:string,input?:any,token?:string,key:string=crypto.randomUUID(),anonymous=false)=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:(anonymous?{}:{Cookie:cookie})),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const connect=async(world:string,system:string)=>{
    const started=await call(`/api/worlds/${world}/connect/${system}`,{});expect(started.status,JSON.stringify(started.data)).toBe(200);
    const url=new URL(started.data.authorization_url);
    const consent=await fetch(`${base}/oauth/${system}/consent${url.search}`,{headers:{Cookie:cookie}});expect(consent.status).toBe(200);
    const info=await consent.json();expect(info.world).toBe(world);expect(info.provider.id).toBe(system);expect(info.scopes).toStrictEqual(['read','write']);
    const params=new URLSearchParams(url.search);params.set('decision','allow');
    const allowed=await fetch(base+url.pathname,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});expect(allowed.status).toBe(303);await allowed.text();
    const callback=await fetch(allowed.headers.get('location')!,{headers:{Cookie:cookie},redirect:'manual'});expect(callback.status).toBe(303);await callback.text();
  };
  const grant=async(world:string,scope:string)=>{
    const redirect='http://127.0.0.1:9123/payroll-test-callback',registered=await call('/api/oauth/clients',{name:'Payroll HTTP scope verification',redirect_uris:[redirect]});expect(registered.status).toBe(201);
    const client=registered.data.client_id,verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    const form=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope,state:crypto.randomUUID(),world_id:world,code_challenge:new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
    const accepted=await fetch(base+'/oauth/gusto/authorize',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});expect(accepted.status).toBe(303);await accepted.text();
    const code=new URL(accepted.headers.get('location')!).searchParams.get('code');
    const token=await call('/oauth/gusto/token',{grant_type:'authorization_code',client_id:client,redirect_uri:redirect,code,code_verifier:verifier},undefined,crypto.randomUUID(),true);expect(token.status,JSON.stringify(token.data)).toBe(200);return token.data.access_token as string;
  };
  const create=async(input:any={})=>{const created=await call('/api/worlds',{kind:'payroll-close',name:'Payroll HTTP verification',seed:17,orderCount:2,approvalThresholdMinor:100000000,payrollControls:{missingTime:false,disabledRoute:false},...input});expect(created.status,JSON.stringify(created.data)).toBe(201);return created.data.world;};
  const agent=(world:string)=>{const token=crypto.randomUUID();server.store.put('agent-tokens',hash(token),{world,actor:`agent-world:${world}`,expires_at:Date.now()+60000});return token;};
  const act=(world:string,input:any,token?:string,key?:string)=>call(`/api/worlds/${world}/actions`,input,token,key);
  return {server,base,call,connect,grant,create,agent,act,close:()=>server.close()};
}
async function fixture(){
  const folder=mkdtempSync(join(tmpdir(),'finance-payroll-http-')),database=join(folder,'world.sqlite');
  try{const f=await start(database);return {...f,folder,database,dispose:async()=>{await f.close();rmSync(folder,{recursive:true,force:true});}};}catch(error){rmSync(folder,{recursive:true,force:true});throw error;}
}
const okay=(response:any)=>{expect(response.status,JSON.stringify(response.data)).toBe(200);return response.data.result;};
const calculation=(world:any)=>({type:'calculate_payroll',policy_id:world.payrollPolicies[0].id,time_record_ids:world.payrollTimeRecords.map((record:any)=>record.id),employee_ids:world.employees.map((employee:any)=>employee.id)});

test('payroll HTTP source facts remain controller-owned and real OAuth grants enforce world, provider and write scope',async()=>{
  const f=await fixture();
  try{
    const w=await f.create(),other=await f.create({name:'Other payroll company'}),token=f.agent(w.id),prefix=`/api/worlds/${w.id}`;
    const context=await f.call(prefix+'/context',undefined,token);expect(context.status).toBe(200);
    for(const action of ['calculate_payroll','execute_payroll','remit_payroll_taxes'])expect(context.data.available_actions.includes(action)).toBeTruthy();
    for(const type of ['record_employee','set_employee_route','record_payroll_policy','record_payroll_time','cancel_payroll'])expect((await f.act(w.id,{type,external_event_id:'agent-cannot-manufacture-source'},token)).status,type).toBe(403);
    expect((await f.call(prefix+'/records?system=gusto&feed=payroll-time',undefined,token)).status).toBe(401);
    expect((await f.act(w.id,calculation(w),token)).status).toBe(401);
    const readToken=await f.grant(w.id,'read');
    const records=await f.call(prefix+'/records?system=gusto&feed=payroll-time',undefined,readToken);expect(records.status).toBe(200);expect(records.data.data.length).toBe(w.payrollTimeRecords.length);
    expect((await f.act(w.id,calculation(w),readToken)).status).toBe(403);
    expect((await f.call(`/api/worlds/${other.id}/records?system=gusto&feed=payroll-time`,undefined,readToken)).status).toBe(403);
    expect((await f.call(prefix+'/records?system=gmail&feed=message',undefined,readToken)).status).toBe(403);
    const writeToken=await f.grant(w.id,'read write');
    okay(await f.act(w.id,calculation(w),writeToken));
    const snapshot=(await f.call(prefix)).data;expect(snapshot.world.payrollRuns.length).toBe(1);expect(snapshot.world.operations.length).toBe(0);expect(snapshot.world.payslips.length).toBe(0);
    expect((await f.act(w.id,{type:'decide_approval',approval_id:'forged',decision:'approve'},writeToken)).status).toBe(403);
    expect(f.server.store.verify(w.id).valid).toBe(true);
    const audit=JSON.stringify(f.server.store.events(w.id,0,1000));for(const secret of [readToken,writeToken,token])expect(!audit.includes(secret)).toBeTruthy();
  }finally{await f.dispose();}
});

test('payroll and tax payments require separate approval, settle once through outages, and retain payslips, webhooks and restart evidence',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'finance-payroll-restart-')),database=join(folder,'world.sqlite');let f=await start(database);
  try{
    const w=await f.create(),token=f.agent(w.id),prefix=`/api/worlds/${w.id}`;
    for(const system of ['gusto','gmail','bank','ledger'])await f.connect(w.id,system);
    const subscription=await f.call(prefix+'/webhooks',{events:['payroll.*']});expect(subscription.status).toBe(201);
    const opening=(await f.call(prefix)).data.summary.cash_minor,input=calculation(w);
    const calculations=await Promise.all(Array.from({length:4},()=>f.act(w.id,input,token,'one-payroll-calculation')));
    calculations.forEach(okay);expect(calculations.filter(response=>!response.data.replayed).length).toBe(1);
    const run=calculations[0].data.result.payroll_run,runId=run.id,immutableLines=structuredClone(run.lines);
    expect(run.gross_minor).toBe(run.net_minor+run.employee_withholding_minor);expect(run.tax_total_minor).toBe(run.employee_withholding_minor+run.employer_tax_minor);
    const requested=okay(await f.act(w.id,{type:'execute_payroll',payroll_run_id:runId},token,'execute-one-payroll'));expect(requested.status).toBe('awaiting_approval');
    expect(okay(await f.act(w.id,{type:'execute_payroll',payroll_run_id:runId},token,'execute-one-payroll')).approval_id).toBe(requested.approval_id);
    expect((await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},token)).status).toBe(403);
    let snapshot=(await f.call(prefix)).data;expect(snapshot.summary.cash_minor).toBe(opening);expect(snapshot.world.payslips.length).toBe(0);
    const approved=okay(await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'}));
    expect(approved.operation.status).toBe('pending');expect(approved.accrual_operation.id).toBeTruthy();
    const cancelPending=await f.act(w.id,{type:'cancel_payroll',payroll_run_id:runId,reason:'Accepted payments cannot be erased',external_event_id:'cancel-accepted-payroll'});expect(cancelPending.status).toBe(409);expect(cancelPending.data.error.code).toBe('payroll_cannot_cancel');
    snapshot=(await f.call(prefix)).data;expect(snapshot.summary.cash_minor).toBe(opening);expect(snapshot.summary.available_cash_minor).toBe(opening-run.net_minor);
    const balance=(state:any,id:string)=>state.world.accounts.find((account:any)=>account.id===id).balance_minor;
    expect(balance(snapshot,'payroll-expense')).toBe(run.gross_minor);expect(balance(snapshot,'employer-payroll-tax-expense')).toBe(run.employer_tax_minor);expect(balance(snapshot,'wages-payable')).toBe(-run.net_minor);expect(balance(snapshot,'employee-withholding-payable')).toBe(-run.employee_withholding_minor);expect(balance(snapshot,'employer-payroll-tax-payable')).toBe(-run.employer_tax_minor);
    okay(await f.act(w.id,{type:'set_fault',system:'gusto',mode:'offline'}));okay(await f.act(w.id,{type:'advance_time',hours:1}));
    snapshot=(await f.call(prefix)).data;expect(snapshot.world.operations.find((op:any)=>op.id===approved.operation.id).status).toBe('pending');expect(snapshot.world.payslips.length).toBe(0);expect(snapshot.summary.cash_minor).toBe(opening);
    expect((await f.call(prefix+'/records?system=gusto&feed=payroll-run',undefined,token)).status).toBe(503);
    okay(await f.act(w.id,{type:'set_fault',system:'gusto',mode:'healthy'}));okay(await f.act(w.id,{type:'set_fault',system:'gmail',mode:'offline'}));okay(await f.act(w.id,{type:'close_period'}));okay(await f.act(w.id,{type:'advance_time',hours:1}));
    snapshot=(await f.call(prefix)).data;let paid=snapshot.world.payrollRuns.find((row:any)=>row.id===runId);
    expect(paid.status).toBe('paid');expect(paid.amount_paid_minor).toBe(run.net_minor);expect(paid.lines).toStrictEqual(immutableLines);expect(snapshot.summary.cash_minor).toBe(opening-run.net_minor);expect(snapshot.world.payslips.length).toBe(w.employees.length);expect(snapshot.summary.unposted_settlements>0).toBeTruthy();
    for(const slip of snapshot.world.payslips){
      const line=immutableLines.find((row:any)=>row.employee_id===slip.employee_id);expect(slip.net_minor).toBe(line.net_minor);expect(slip.gross_minor).toBe(line.gross_minor);expect(slip.receipt_id).toBeTruthy();expect(slip.payroll_run_id).toBe(runId);
      const mail=snapshot.world.messages.find((row:any)=>row.source_refs?.includes(slip.id));expect(mail).toBeTruthy();expect(mail.delivery_status).toBe('queued');expect(mail.source_refs.includes(slip.document_id)).toBeTruthy();expect(mail.source_refs.includes(slip.receipt_id)).toBeTruthy();
    }
    const tax=okay(await f.act(w.id,{type:'remit_payroll_taxes',payroll_run_id:runId},token,'one-tax-remittance'));expect(tax.status).toBe('awaiting_approval');expect(tax.approval_id).not.toBe(requested.approval_id);expect(tax.tax_remittance.amount_minor).toBe(run.tax_total_minor);
    expect(okay(await f.act(w.id,{type:'remit_payroll_taxes',payroll_run_id:runId},token)).tax_remittance.id).toBe(tax.tax_remittance.id);
    expect((await f.act(w.id,{type:'decide_approval',approval_id:tax.approval_id,decision:'approve'},token)).status).toBe(403);
    const taxApproved=okay(await f.act(w.id,{type:'decide_approval',approval_id:tax.approval_id,decision:'approve'}));expect(taxApproved.operation.status).toBe('pending');
    expect(okay(await f.act(w.id,{type:'remit_payroll_taxes',payroll_run_id:runId},token)).operation.id).toBe(taxApproved.operation.id);
    snapshot=(await f.call(prefix)).data;expect(snapshot.summary.available_cash_minor).toBe(opening-run.net_minor-run.tax_total_minor);
    okay(await f.act(w.id,{type:'advance_time',hours:1}));snapshot=(await f.call(prefix)).data;paid=snapshot.world.payrollRuns.find((row:any)=>row.id===runId);
    expect(paid.tax_paid_minor).toBe(run.tax_total_minor);expect(snapshot.summary.cash_minor).toBe(opening-run.gross_minor-run.employer_tax_minor);expect(snapshot.world.payrollTaxRemittances.length).toBe(1);expect(snapshot.world.payslips.length).toBe(w.employees.length);
    okay(await f.act(w.id,{type:'reopen_period'}));okay(await f.act(w.id,{type:'set_fault',system:'gmail',mode:'healthy'}));okay(await f.act(w.id,{type:'advance_time',hours:1}));
    snapshot=(await f.call(prefix)).data;expect(snapshot.summary.unposted_settlements).toBe(0);expect(snapshot.summary.reconciliation.balanced).toBe(true);expect(snapshot.summary.reconciliation.bank_ledger_difference_minor).toBe(0);
    for(const id of ['wages-payable','employee-withholding-payable','employer-payroll-tax-payable'])expect(balance(snapshot,id)).toBe(0);
    for(const slip of snapshot.world.payslips)expect(snapshot.world.messages.find((row:any)=>row.source_refs?.includes(slip.id)).delivery_status).toBe('delivered');
    const dispatch=await f.call(prefix+'/webhooks/dispatch',{});expect(dispatch.status).toBe(200);expect(dispatch.data.failed).toBe(0);expect(dispatch.data.delivered>0).toBeTruthy();
    snapshot=(await f.call(prefix)).data;const deliveries=snapshot.webhooks.deliveries.data;
    expect(deliveries.some((row:any)=>row.event.type==='payroll.paid')).toBeTruthy();expect(deliveries.some((row:any)=>row.event.type==='payroll.taxes_remitted')).toBeTruthy();expect(deliveries.every((row:any)=>row.status==='delivered')).toBeTruthy();expect(snapshot.webhooks.receiver.receipts.length).toBe(deliveries.length);
    expect(f.server.store.verify(w.id).valid).toBe(true);
    const counts={operations:snapshot.world.operations.length,journals:snapshot.world.journals.length,bank:snapshot.world.bankTransactions.length,payslips:snapshot.world.payslips.length,receipts:snapshot.webhooks.receiver.receipts.length},port=Number(new URL(f.base).port);
    await f.close();f=await start(database,port);const nextToken=f.agent(w.id);
    expect((await f.act(w.id,input,nextToken,'one-payroll-calculation')).data.replayed).toBe(true);
    expect((await f.act(w.id,{type:'execute_payroll',payroll_run_id:runId},nextToken,'execute-one-payroll')).data.replayed).toBe(true);
    expect((await f.act(w.id,{type:'remit_payroll_taxes',payroll_run_id:runId},nextToken,'one-tax-remittance')).data.replayed).toBe(true);
    okay(await f.act(w.id,{type:'advance_time',hours:1}));snapshot=(await f.call(prefix)).data;
    expect({operations:snapshot.world.operations.length,journals:snapshot.world.journals.length,bank:snapshot.world.bankTransactions.length,payslips:snapshot.world.payslips.length,receipts:snapshot.webhooks.receiver.receipts.length}).toStrictEqual(counts);
    expect((await f.call(prefix+'/records?system=gusto&feed=payslip',undefined,nextToken)).data.data.length).toBe(w.employees.length);
    expect((await f.call(prefix+'/records?system=gusto&feed=payroll-tax-remittance',undefined,nextToken)).data.data.length).toBe(1);
    expect(f.server.store.verify(w.id).valid).toBe(true);
    const log=JSON.stringify(f.server.store.events(w.id,0,1000));expect(!log.includes(subscription.data.secret)).toBeTruthy();
  }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

test('missing payroll sources and disabled routes cannot be supplied by the worker or bypassed at approval and settlement',async()=>{
  const f=await fixture();
  try{
    const w=await f.create({payrollControls:{missingTime:true,disabledRoute:true}}),prefix=`/api/worlds/${w.id}`,token=f.agent(w.id);await f.connect(w.id,'gusto');
    const missing=await f.act(w.id,calculation(w),token);expect(missing.status).toBe(409);expect(missing.data.error.code).toBe('missing_payroll_time');
    expect((await f.call(prefix)).data.world.payrollRuns.length).toBe(0);
    const source=w.payrollTimeRecords[0],employee=w.employees[1],time={type:'record_payroll_time',employee_id:employee.id,period_start:source.period_start,period_end:source.period_end,minutes:source.minutes,external_event_id:'missing-time-verified'};
    expect((await f.act(w.id,time,token)).status).toBe(403);
    const received=okay(await f.act(w.id,time)),again=okay(await f.act(w.id,time));expect(again.replayed).toBe(true);expect(again.time_record.id).toBe(received.time_record.id);
    const changed=await f.act(w.id,{...time,minutes:source.minutes+1});expect(changed.status).toBe(409);expect(changed.data.error.code).toBe('external_event_conflict');
    const employeeUpdate=await f.act(w.id,{type:'record_employee',employee_id:employee.id,display_name:'Altered employee',hourly_rate_minor:1,external_event_id:'rewrite-original-wage'});expect(employeeUpdate.status).toBe(409);expect(employeeUpdate.data.error.code).toBe('employee_exists');
    const state=(await f.call(prefix)).data.world;
    const result=okay(await f.act(w.id,{...calculation(state),gross_minor:1,net_minor:1,verified_route_id:'attacker-route',status:'paid'},token)),run=result.payroll_run,originalLines=structuredClone(result.payroll_run.lines);
    expect(run.net_minor>1).toBeTruthy();expect(run.status).toBe('calculated');expect(run.lines.every((line:any)=>line.verified_route_id===`synthetic-payroll-route-${line.employee_id}`)).toBeTruthy();
    const disabled=await f.act(w.id,{type:'execute_payroll',payroll_run_id:run.id},token);expect(disabled.status).toBe(409);expect(disabled.data.error.code).toBe('payroll_route_disabled');
    expect((await f.call(prefix)).data.world.approvals.length).toBe(0);
    const route=(enabled:boolean,event:string)=>({type:'set_employee_route',employee_id:employee.id,enabled,reason:'Controller verified synthetic route availability',external_event_id:event});
    expect((await f.act(w.id,route(true,'worker-cannot-enable-route'),token)).status).toBe(403);
    okay(await f.act(w.id,route(true,'controller-enables-route')));
    const requested=okay(await f.act(w.id,{type:'execute_payroll',payroll_run_id:run.id},token));expect(requested.status).toBe('awaiting_approval');
    okay(await f.act(w.id,route(false,'route-unavailable-at-approval')));
    const approval=await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'});expect(approval.status).toBe(409);expect(approval.data.error.code).toBe('payroll_route_disabled');
    let snapshot=(await f.call(prefix)).data;expect(snapshot.world.approvals[0].status).toBe('pending');expect(snapshot.world.operations.length).toBe(0);
    okay(await f.act(w.id,route(true,'verified-for-approval')));const approved=okay(await f.act(w.id,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'}));
    const before=snapshot.summary.cash_minor;okay(await f.act(w.id,route(false,'route-unavailable-before-settlement')));okay(await f.act(w.id,{type:'advance_time',hours:1}));
    snapshot=(await f.call(prefix)).data;expect(snapshot.world.operations.find((operation:any)=>operation.id===approved.operation.id).last_error).toBe('payroll_route_disabled');expect(snapshot.world.payslips.length).toBe(0);expect(snapshot.summary.cash_minor).toBe(before);
    okay(await f.act(w.id,route(true,'verified-for-settlement')));okay(await f.act(w.id,{type:'advance_time',hours:1}));snapshot=(await f.call(prefix)).data;
    expect(snapshot.world.payslips.length).toBe(2);expect(snapshot.world.payrollRuns[0].lines).toStrictEqual(originalLines);expect(snapshot.summary.cash_minor).toBe(before-run.net_minor);expect(snapshot.summary.reconciliation.balanced).toBe(true);expect(f.server.store.verify(w.id).valid).toBe(true);
    const second=await f.create({orderCount:1});await f.connect(second.id,'gusto');const selfRun=okay(await f.act(second.id,calculation(second))).payroll_run;
    const selfRequested=okay(await f.act(second.id,{type:'execute_payroll',payroll_run_id:selfRun.id}));
    const selfApprove=await f.act(second.id,{type:'decide_approval',approval_id:selfRequested.approval_id,decision:'approve'});expect(selfApprove.status).toBe(403);expect(selfApprove.data.error.code).toBe('separate_controller_required');
    expect((await f.call(`/api/worlds/${second.id}`)).data.world.operations.length).toBe(0);
    const cancellation={type:'cancel_payroll',payroll_run_id:selfRun.id,reason:'Release mistaken unexecuted calculation for a separate requester',external_event_id:'cancel-unexecuted-payroll'};
    const cancelled=okay(await f.act(second.id,cancellation));expect(cancelled.payroll_run.status).toBe('rejected');expect(okay(await f.act(second.id,cancellation)).replayed).toBe(true);
    expect((await f.call(`/api/worlds/${second.id}`)).data.world.approvals[0].status).toBe('rejected');
    const replacement=okay(await f.act(second.id,calculation(second),f.agent(second.id))).payroll_run;expect(replacement.id).not.toBe(selfRun.id);expect(replacement.lines).toStrictEqual(selfRun.lines);
    const rejectedExecution=await f.act(second.id,{type:'execute_payroll',payroll_run_id:selfRun.id});expect(rejectedExecution.status).toBe(409);expect(rejectedExecution.data.error.code).toBe('payroll_rejected');
  }finally{await f.dispose();}
});

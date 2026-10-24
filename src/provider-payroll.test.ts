import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createWorld,applyAction,DomainError} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {providerPayroll,providerPayrollRoutes} from './provider-payroll.ts';
const controller:Actor={id:'gusto-source-controller',role:'controller'},operator:Actor={id:'gusto-operator',role:'operator'},reviewer:Actor={id:'gusto-review-controller',role:'controller'};
const act=(w:World,a:Action,actor=controller)=>applyAction(w,a,actor).result;
const fresh=()=>createWorld({kind:'payroll-close',orderCount:3,payrollControls:{missingTime:false,disabledRoute:false}},'gusto-provider-world');
function api(w:World){const calls:Action[]=[];return {calls,async request(route:string,method='GET',input?:any,headers?:Headers){return providerPayroll({system:'gusto',world:w,route:route.split('?')[0]!,url:`http://simulation.test${route}`,method,input,headers,execute:action=>{calls.push(action);return act(w,action,operator);}});}};}
function sourceBody(w:World,employeeIds=w.employees.map((row:any)=>row.id)){const times=w.payrollTimeRecords.filter((row:any)=>employeeIds.includes(row.employee_id));return {off_cycle:true,off_cycle_reason:'Adhoc',start_date:times[0].period_start,end_date:times[0].period_end,employee_uuids:employeeIds,finance_world:{policy_id:w.payrollPolicies[0].id,time_record_ids:times.map((row:any)=>row.id)}};}
const payrollRoute=(w:World,id?:string)=>`/v1/companies/${w.id}/payrolls${id?`/${id}`:''}`;
const versionBody=(row:any)=>({finance_world:{version:row.finance_world.version}});
const financial=(w:World)=>structuredClone({accounts:w.accounts,bank:w.bankTransactions,journals:w.journals,operations:w.operations,approvals:w.approvals,payslips:w.payslips});
async function rejects(w:World,call:()=>Promise<any>,code:string){const before=structuredClone(w);await assert.rejects(call,(error:any)=>error instanceof DomainError&&error.code===code);assert.deepEqual(w,before);}

test('Gusto company/employee reads use exact canonical records and pagination without inventing legal or onboarding facts',async()=>{
  const w=fresh(),client=api(w),before=structuredClone(w),company=await client.request(`/v1/companies/${w.id}`);
  assert.equal(company!.body.uuid,w.id);assert.equal(company!.body.name,w.name);assert.equal(company!.body.ein,undefined);assert.equal(company!.body.company_status,undefined);
  const first=await client.request(`/v1/companies/${w.id}/employees?page=1&per=2&sort_by=name:desc&include=company_name`),last=await client.request(`/v1/companies/${w.id}/employees?page=2&per=2&sort_by=name:desc`);
  assert.equal(first!.body.length,2);assert.equal(last!.body.length,1);assert.equal(first!.headers!['X-Total-Count'],'3');assert.equal(first!.headers!['X-Total-Pages'],'2');assert.equal(first!.body[0].company_name,w.name);
  const source=w.employees[0],detail=await client.request(`/v1/employees/${source.id}`);assert.equal(detail!.body.email,source.email);assert.equal(detail!.body.finance_world.hourly_rate,`${Math.floor(source.hourly_rate_minor/100)}.${String(source.hourly_rate_minor%100).padStart(2,'0')}`);assert.equal(detail!.body.ssn,undefined);assert.equal(detail!.body.onboarded,undefined);assert.equal(detail!.body.finance_world.employment_document_id,source.document_id);assert.equal(detail!.body.finance_world.route_enabled,true);
  const subset=await client.request(`/v1/companies/${w.id}/employees?uuids=${source.id}`);assert.deepEqual(subset!.body.map((row:any)=>row.uuid),[source.id]);assert.equal(client.calls.length,0);assert.deepEqual(w,before);
});

test('Gusto create/calculate/submit maps to real stable-ID draft, exact source calculation, independent approval and actual wage settlement',async()=>{
  const w=fresh(),client=api(w),before=financial(w),created=await client.request(payrollRoute(w),'POST',sourceBody(w)),draft=created!.body;
  assert.equal(created!.status,200);assert.equal(draft.finance_world.canonical_status,'draft');assert.equal(draft.calculated_at,null);assert.equal(draft.totals,undefined);assert.equal(draft.employee_compensations.length,3);assert.deepEqual(financial(w),before);
  await rejects(w,()=>client.request(`${payrollRoute(w,draft.uuid)}/submit`,'PUT',versionBody(draft)),'payroll_not_calculated');
  const calculated=await client.request(`${payrollRoute(w,draft.uuid)}/calculate`,'PUT',versionBody(draft)),run=w.payrollRuns[0];assert.equal(calculated!.status,202);assert.equal(calculated!.body.uuid,draft.uuid);assert.equal(w.payrollRuns.length,1);assert.equal(calculated!.body.processing_request.status,'calculate_success');assert.equal(calculated!.body.employee_compensations[0].net_pay,null);assert.equal(calculated!.body.finance_world.wages_paid,false);assert.deepEqual(financial(w),before);
  const submitted=await client.request(`${payrollRoute(w,draft.uuid)}/submit`,'PUT',versionBody(calculated!.body));assert.equal(submitted!.status,202);assert.equal(submitted!.body.finance_world.canonical_status,'awaiting_approval');assert.equal(submitted!.body.finance_world.approval_status,'pending');assert.equal(submitted!.body.processed,false);assert.equal(w.bankTransactions.length,before.bank.length);assert.equal(w.operations.length,0);
  act(w,{type:'decide_approval',approval_id:w.payrollRuns[0].approval_id,decision:'approve'},reviewer);
  const pending=await client.request(payrollRoute(w,draft.uuid));assert.equal(pending!.body.processing_request.status,'submitting');assert.equal(pending!.body.processed,false);assert.equal(w.payslips.length,0);
  act(w,{type:'advance_time',hours:1});const paid=await client.request(payrollRoute(w,draft.uuid));assert.equal(paid!.body.processed,true);assert.equal(paid!.body.processing_request.status,'submit_success');assert.equal(paid!.body.finance_world.wages_paid,true);assert.equal(paid!.body.finance_world.tax_remitted,false);assert.equal(paid!.body.totals.gross_pay,`${BigInt(run.gross_minor)/100n}.${String(BigInt(run.gross_minor)%100n).padStart(2,'0')}`);assert.ok(paid!.body.employee_compensations.every((row:any)=>row.net_pay!==null));assert.equal(w.payslips.length,3);
  assert.deepEqual(client.calls.filter(row=>row.type!=='execute_payroll').map(row=>row.type),['prepare_payroll','calculate_prepared_payroll']);
});

test('federal payroll projection preserves authoritative tax components, W4-derived source IDs and exact USD strings',async()=>{
  const w=createWorld({kind:'payroll-federal',orderCount:1},'gusto-federal'),client=api(w),created=await client.request(payrollRoute(w),'POST',sourceBody(w));await client.request(`${payrollRoute(w,created!.body.uuid)}/calculate`,'PUT',versionBody(created!.body));
  const response=await client.request(`${payrollRoute(w,created!.body.uuid)}?include=taxes`),row=response!.body.employee_compensations[0];
  assert.equal(response!.body.totals.gross_pay,'2000.00');assert.equal(response!.body.totals.employee_taxes,'225.15');assert.equal(response!.body.totals.employer_taxes,'60.00');assert.equal(response!.body.totals.tax_debit,'285.15');assert.equal(row.taxes.find((tax:any)=>tax.name==='Federal Income Tax').amount,'156.15');assert.equal(row.taxes.find((tax:any)=>tax.name==='Social Security'&&!tax.employer).amount,'31.00');assert.equal(row.finance_world.tax_profile_id,w.employeeTaxProfiles[0].id);assert.equal(row.finance_world.taxable_bases.social_security_minor,50000);assert.match(row.finance_world.tax_ruleset.ruleset_sha256,/^[a-f0-9]{64}$/);assert.equal(row.net_pay,null);assert.equal(response!.body.finance_world.estimated_net_pay,'1774.85');
});

test('list/detail pagination, processing filters and source period filters never invent a payroll or duplicate totals',async()=>{
  const w=fresh(),client=api(w);
  for(const employee of w.employees)await client.request(payrollRoute(w),'POST',sourceBody(w,[employee.id]));
  assert.equal((await client.request(payrollRoute(w)))!.body.length,0,'Official defaults include processed regular payrolls only');
  const listed=await client.request(`${payrollRoute(w)}?processing_statuses=unprocessed&payroll_types=off_cycle&page=2&per=2`);assert.equal(listed!.body.length,1);assert.equal(listed!.headers!['X-Total-Count'],'3');assert.equal(listed!.body[0].totals,undefined);
  const employee=await client.request(`/v1/companies/${w.id}/employees?payroll_uuid=${w.payrollRuns[0].id}`);assert.deepEqual(employee!.body.map((row:any)=>row.uuid),w.payrollRuns[0].employee_ids);
  assert.equal((await client.request(`${payrollRoute(w)}?processing_statuses=unprocessed&payroll_types=off_cycle&start_date=2026-10-20`))!.body.length,0);
  const separate=fresh(),all=api(separate),draft=await all.request(payrollRoute(separate),'POST',sourceBody(separate));await all.request(`${payrollRoute(separate,draft!.body.uuid)}/calculate`,'PUT',versionBody(draft!.body));
  const one=await all.request(`${payrollRoute(separate,draft!.body.uuid)}?page=1&per=1`),three=await all.request(`${payrollRoute(separate,draft!.body.uuid)}?page=3&per=1`);assert.equal(one!.body.employee_compensations.length,1);assert.equal(three!.body.employee_compensations.length,1);assert.deepEqual(one!.body.totals,three!.body.totals);assert.equal(one!.headers!['X-Total-Count'],'3');
});

test('versions reject stale writes, preserve unrelated-read stability, and invalidate changed underlying source authority',async()=>{
  const w=fresh(),client=api(w),draft=await client.request(payrollRoute(w),'POST',sourceBody(w));const id=draft!.body.uuid;
  await rejects(w,()=>client.request(`${payrollRoute(w,id)}/calculate`,'PUT',{finance_world:{version:'0'.repeat(64)}}),'payroll_version_conflict');
  act(w,{type:'receive_email',from:'auditor@simulation.test',subject:'Unrelated note',body:'No payroll source changed.'});assert.equal((await client.request(payrollRoute(w,id)))!.body.finance_world.version,draft!.body.finance_world.version);
  act(w,{type:'set_employee_route',employee_id:w.employees[0].id,enabled:false,reason:'Controller verification hold',external_event_id:'gusto-route-hold'});
  assert.equal((await client.request(payrollRoute(w,id)))!.body.finance_world.source_stale,true);await rejects(w,()=>client.request(`${payrollRoute(w,id)}/calculate`,'PUT',versionBody(draft!.body)),'payroll_source_changed');
});

test('unsupported vendor writes, source replacements, false scheduling and unknown filters are rejected explicitly',async()=>{
  const w=fresh(),client=api(w),body=sourceBody(w);
  for(const patch of [{check_date:'2026-10-25'},{fixed_withholding_rate:true},{employee_compensations:[]},{submission_blockers:[]},{finance_world:{...body.finance_world,approved_by:'forged'}}])await rejects(w,()=>client.request(payrollRoute(w),'POST',{...body,...patch}),'unsupported_field');
  await rejects(w,()=>client.request(payrollRoute(w),'POST',{...body,off_cycle:false}),'unsupported_payroll_type');await rejects(w,()=>client.request(payrollRoute(w),'POST',{...body,start_date:'2026-10-02'}),'payroll_period_mismatch');
  await rejects(w,()=>client.request(`/v1/employees/${w.employees[0].id}`,'PUT',{version:'forged',rate:'0.01'}),'unsupported_operation');
  for(const query of ['include=benefits','processed=true','payroll_types=external','per=2&page=1&page=2'])await rejects(w,()=>client.request(`${payrollRoute(w)}?${query}`),query.includes('page=2')?'duplicate_parameter':'unsupported_filter');
  await rejects(w,()=>client.request(payrollRoute(w), 'GET',undefined,new Headers({'X-Gusto-API-Version':'2020-01-01'})),'unsupported_api_version');
  await rejects(w,()=>client.request('/v1/companies/other-world/payrolls'),'resource_missing');await rejects(w,()=>client.request('/v1/employees/employee-does-not-exist'),'resource_missing');assert.equal(await client.request('/v1/unimplemented'),undefined);
});

test('provider outages preserve real drafts and calculations without manufacturing accepted writes',async()=>{
  const w=fresh(),client=api(w),draft=await client.request(payrollRoute(w),'POST',sourceBody(w));act(w,{type:'set_fault',system:'gusto',mode:'offline'});
  await rejects(w,()=>client.request(`${payrollRoute(w,draft!.body.uuid)}/calculate`,'PUT',versionBody(draft!.body)),'connection_unavailable');
  act(w,{type:'set_fault',system:'gusto',mode:'healthy'});const calculated=await client.request(`${payrollRoute(w,draft!.body.uuid)}/calculate`,'PUT',versionBody(draft!.body));act(w,{type:'set_fault',system:'bank',mode:'offline'});
  await rejects(w,()=>client.request(`${payrollRoute(w,draft!.body.uuid)}/submit`,'PUT',versionBody(calculated!.body)),'connection_unavailable');assert.equal(w.payrollRuns[0].status,'calculated');assert.equal(w.approvals.length,0);assert.equal(w.operations.length,0);
});

test('route manifest makes all actual calculations and submissions writes and only exposes the supported bounded Gusto subset',()=>{
  assert.equal(providerPayrollRoutes.length,8);assert.equal(new Set(providerPayrollRoutes.map(row=>row.id)).size,8);
  assert.deepEqual(providerPayrollRoutes.filter(row=>row.access==='write').map(row=>row.id),['gusto.payroll.create','gusto.payroll.calculate','gusto.payroll.submit']);assert.ok(providerPayrollRoutes.every(row=>row.documentation[0].startsWith('https://docs.gusto.com/embedded-payroll/reference/')));
});

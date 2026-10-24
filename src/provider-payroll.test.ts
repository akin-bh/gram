import {test,expect} from 'bun:test';
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
async function rejects(w:World,call:()=>Promise<any>,code:string){const before=structuredClone(w);await expect(call()).rejects.toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);}

test('Gusto company/employee reads use exact canonical records and pagination without inventing legal or onboarding facts',async()=>{
  const w=fresh(),client=api(w),before=structuredClone(w),company=await client.request(`/v1/companies/${w.id}`);
  expect(company!.body.uuid).toBe(w.id);expect(company!.body.name).toBe(w.name);expect(company!.body.ein).toBeUndefined();expect(company!.body.company_status).toBeUndefined();
  const first=await client.request(`/v1/companies/${w.id}/employees?page=1&per=2&sort_by=name:desc&include=company_name`),last=await client.request(`/v1/companies/${w.id}/employees?page=2&per=2&sort_by=name:desc`);
  expect(first!.body.length).toBe(2);expect(last!.body.length).toBe(1);expect(first!.headers!['X-Total-Count']).toBe('3');expect(first!.headers!['X-Total-Pages']).toBe('2');expect(first!.body[0].company_name).toBe(w.name);
  const source=w.employees[0],detail=await client.request(`/v1/employees/${source.id}`);expect(detail!.body.email).toBe(source.email);expect(detail!.body.finance_world.hourly_rate).toBe(`${Math.floor(source.hourly_rate_minor/100)}.${String(source.hourly_rate_minor%100).padStart(2,'0')}`);expect(detail!.body.ssn).toBeUndefined();expect(detail!.body.onboarded).toBeUndefined();expect(detail!.body.finance_world.employment_document_id).toBe(source.document_id);expect(detail!.body.finance_world.route_enabled).toBe(true);
  const subset=await client.request(`/v1/companies/${w.id}/employees?uuids=${source.id}`);expect(subset!.body.map((row:any)=>row.uuid)).toStrictEqual([source.id]);expect(client.calls.length).toBe(0);expect(w).toStrictEqual(before);
});

test('Gusto create/calculate/submit maps to real stable-ID draft, exact source calculation, independent approval and actual wage settlement',async()=>{
  const w=fresh(),client=api(w),before=financial(w),created=await client.request(payrollRoute(w),'POST',sourceBody(w)),draft=created!.body;
  expect(created!.status).toBe(200);expect(draft.finance_world.canonical_status).toBe('draft');expect(draft.calculated_at).toBeNull();expect(draft.totals).toBeUndefined();expect(draft.employee_compensations.length).toBe(3);expect(financial(w)).toStrictEqual(before);
  await rejects(w,()=>client.request(`${payrollRoute(w,draft.uuid)}/submit`,'PUT',versionBody(draft)),'payroll_not_calculated');
  const calculated=await client.request(`${payrollRoute(w,draft.uuid)}/calculate`,'PUT',versionBody(draft)),run=w.payrollRuns[0];expect(calculated!.status).toBe(202);expect(calculated!.body.uuid).toBe(draft.uuid);expect(w.payrollRuns.length).toBe(1);expect(calculated!.body.processing_request.status).toBe('calculate_success');expect(calculated!.body.employee_compensations[0].net_pay).toBeNull();expect(calculated!.body.finance_world.wages_paid).toBe(false);expect(financial(w)).toStrictEqual(before);
  const submitted=await client.request(`${payrollRoute(w,draft.uuid)}/submit`,'PUT',versionBody(calculated!.body));expect(submitted!.status).toBe(202);expect(submitted!.body.finance_world.canonical_status).toBe('awaiting_approval');expect(submitted!.body.finance_world.approval_status).toBe('pending');expect(submitted!.body.processed).toBe(false);expect(w.bankTransactions.length).toBe(before.bank.length);expect(w.operations.length).toBe(0);
  act(w,{type:'decide_approval',approval_id:w.payrollRuns[0].approval_id,decision:'approve'},reviewer);
  const pending=await client.request(payrollRoute(w,draft.uuid));expect(pending!.body.processing_request.status).toBe('submitting');expect(pending!.body.processed).toBe(false);expect(w.payslips.length).toBe(0);
  act(w,{type:'advance_time',hours:1});const paid=await client.request(payrollRoute(w,draft.uuid));expect(paid!.body.processed).toBe(true);expect(paid!.body.processing_request.status).toBe('submit_success');expect(paid!.body.finance_world.wages_paid).toBe(true);expect(paid!.body.finance_world.tax_remitted).toBe(false);expect(paid!.body.totals.gross_pay).toBe(`${BigInt(run.gross_minor)/100n}.${String(BigInt(run.gross_minor)%100n).padStart(2,'0')}`);expect(paid!.body.employee_compensations.every((row:any)=>row.net_pay!==null)).toBeTruthy();expect(w.payslips.length).toBe(3);
  expect(client.calls.filter(row=>row.type!=='execute_payroll').map(row=>row.type)).toStrictEqual(['prepare_payroll','calculate_prepared_payroll']);
});

test('federal payroll projection preserves authoritative tax components, W4-derived source IDs and exact USD strings',async()=>{
  const w=createWorld({kind:'payroll-federal',orderCount:1},'gusto-federal'),client=api(w),created=await client.request(payrollRoute(w),'POST',sourceBody(w));await client.request(`${payrollRoute(w,created!.body.uuid)}/calculate`,'PUT',versionBody(created!.body));
  const response=await client.request(`${payrollRoute(w,created!.body.uuid)}?include=taxes`),row=response!.body.employee_compensations[0];
  expect(response!.body.totals.gross_pay).toBe('2000.00');expect(response!.body.totals.employee_taxes).toBe('225.15');expect(response!.body.totals.employer_taxes).toBe('60.00');expect(response!.body.totals.tax_debit).toBe('285.15');expect(row.taxes.find((tax:any)=>tax.name==='Federal Income Tax').amount).toBe('156.15');expect(row.taxes.find((tax:any)=>tax.name==='Social Security'&&!tax.employer).amount).toBe('31.00');expect(row.finance_world.tax_profile_id).toBe(w.employeeTaxProfiles[0].id);expect(row.finance_world.taxable_bases.social_security_minor).toBe(50000);expect(row.finance_world.tax_ruleset.ruleset_sha256).toMatch(/^[a-f0-9]{64}$/);expect(row.net_pay).toBeNull();expect(response!.body.finance_world.estimated_net_pay).toBe('1774.85');
});

test('list/detail pagination, processing filters and source period filters never invent a payroll or duplicate totals',async()=>{
  const w=fresh(),client=api(w);
  for(const employee of w.employees)await client.request(payrollRoute(w),'POST',sourceBody(w,[employee.id]));
  expect((await client.request(payrollRoute(w)))!.body.length,'Official defaults include processed regular payrolls only').toBe(0);
  const listed=await client.request(`${payrollRoute(w)}?processing_statuses=unprocessed&payroll_types=off_cycle&page=2&per=2`);expect(listed!.body.length).toBe(1);expect(listed!.headers!['X-Total-Count']).toBe('3');expect(listed!.body[0].totals).toBeUndefined();
  const employee=await client.request(`/v1/companies/${w.id}/employees?payroll_uuid=${w.payrollRuns[0].id}`);expect(employee!.body.map((row:any)=>row.uuid)).toStrictEqual(w.payrollRuns[0].employee_ids);
  expect((await client.request(`${payrollRoute(w)}?processing_statuses=unprocessed&payroll_types=off_cycle&start_date=2026-10-20`))!.body.length).toBe(0);
  const separate=fresh(),all=api(separate),draft=await all.request(payrollRoute(separate),'POST',sourceBody(separate));await all.request(`${payrollRoute(separate,draft!.body.uuid)}/calculate`,'PUT',versionBody(draft!.body));
  const one=await all.request(`${payrollRoute(separate,draft!.body.uuid)}?page=1&per=1`),three=await all.request(`${payrollRoute(separate,draft!.body.uuid)}?page=3&per=1`);expect(one!.body.employee_compensations.length).toBe(1);expect(three!.body.employee_compensations.length).toBe(1);expect(one!.body.totals).toStrictEqual(three!.body.totals);expect(one!.headers!['X-Total-Count']).toBe('3');
});

test('versions reject stale writes, preserve unrelated-read stability, and invalidate changed underlying source authority',async()=>{
  const w=fresh(),client=api(w),draft=await client.request(payrollRoute(w),'POST',sourceBody(w));const id=draft!.body.uuid;
  await rejects(w,()=>client.request(`${payrollRoute(w,id)}/calculate`,'PUT',{finance_world:{version:'0'.repeat(64)}}),'payroll_version_conflict');
  act(w,{type:'receive_email',from:'auditor@simulation.test',subject:'Unrelated note',body:'No payroll source changed.'});expect((await client.request(payrollRoute(w,id)))!.body.finance_world.version).toBe(draft!.body.finance_world.version);
  act(w,{type:'set_employee_route',employee_id:w.employees[0].id,enabled:false,reason:'Controller verification hold',external_event_id:'gusto-route-hold'});
  expect((await client.request(payrollRoute(w,id)))!.body.finance_world.source_stale).toBe(true);await rejects(w,()=>client.request(`${payrollRoute(w,id)}/calculate`,'PUT',versionBody(draft!.body)),'payroll_source_changed');
});

test('unsupported vendor writes, source replacements, false scheduling and unknown filters are rejected explicitly',async()=>{
  const w=fresh(),client=api(w),body=sourceBody(w);
  for(const patch of [{check_date:'2026-10-25'},{fixed_withholding_rate:true},{employee_compensations:[]},{submission_blockers:[]},{finance_world:{...body.finance_world,approved_by:'forged'}}])await rejects(w,()=>client.request(payrollRoute(w),'POST',{...body,...patch}),'unsupported_field');
  await rejects(w,()=>client.request(payrollRoute(w),'POST',{...body,off_cycle:false}),'unsupported_payroll_type');await rejects(w,()=>client.request(payrollRoute(w),'POST',{...body,start_date:'2026-10-02'}),'payroll_period_mismatch');
  await rejects(w,()=>client.request(`/v1/employees/${w.employees[0].id}`,'PUT',{version:'forged',rate:'0.01'}),'unsupported_operation');
  for(const query of ['include=benefits','processed=true','payroll_types=external','per=2&page=1&page=2'])await rejects(w,()=>client.request(`${payrollRoute(w)}?${query}`),query.includes('page=2')?'duplicate_parameter':'unsupported_filter');
  await rejects(w,()=>client.request(payrollRoute(w), 'GET',undefined,new Headers({'X-Gusto-API-Version':'2020-01-01'})),'unsupported_api_version');
  await rejects(w,()=>client.request('/v1/companies/other-world/payrolls'),'resource_missing');await rejects(w,()=>client.request('/v1/employees/employee-does-not-exist'),'resource_missing');expect(await client.request('/v1/unimplemented')).toBeUndefined();
});

test('provider outages preserve real drafts and calculations without manufacturing accepted writes',async()=>{
  const w=fresh(),client=api(w),draft=await client.request(payrollRoute(w),'POST',sourceBody(w));act(w,{type:'set_fault',system:'gusto',mode:'offline'});
  await rejects(w,()=>client.request(`${payrollRoute(w,draft!.body.uuid)}/calculate`,'PUT',versionBody(draft!.body)),'connection_unavailable');
  act(w,{type:'set_fault',system:'gusto',mode:'healthy'});const calculated=await client.request(`${payrollRoute(w,draft!.body.uuid)}/calculate`,'PUT',versionBody(draft!.body));act(w,{type:'set_fault',system:'bank',mode:'offline'});
  await rejects(w,()=>client.request(`${payrollRoute(w,draft!.body.uuid)}/submit`,'PUT',versionBody(calculated!.body)),'connection_unavailable');expect(w.payrollRuns[0].status).toBe('calculated');expect(w.approvals.length).toBe(0);expect(w.operations.length).toBe(0);
});

test('route manifest makes all actual calculations and submissions writes and only exposes the supported bounded Gusto subset',()=>{
  expect(providerPayrollRoutes.length).toBe(8);expect(new Set(providerPayrollRoutes.map(row=>row.id)).size).toBe(8);
  expect(providerPayrollRoutes.filter(row=>row.access==='write').map(row=>row.id)).toStrictEqual(['gusto.payroll.create','gusto.payroll.calculate','gusto.payroll.submit']);expect(providerPayrollRoutes.every(row=>row.documentation[0].startsWith('https://docs.gusto.com/embedded-payroll/reference/'))).toBeTruthy();
});

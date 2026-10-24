/** Gusto Embedded Payroll 2026-06-15 subset over one canonical company.
 * Official references below were read 2026-10-24. No Gusto onboarding, ACH
 * calendar, state/local tax, deduction, benefit or filing success is inferred.
 * The finance_world extension explicitly carries source authority, opaque
 * concurrency versions, controller review and separate wage/tax settlement.
 */
import {createHash} from 'node:crypto';
import {DomainError} from './world.ts';
import type {World} from './world.ts';
import type {ProviderRequest,ProviderResponse} from './provider-adapters.ts';
import {payrollRunVersion,payrollSourceVersion} from './payroll.ts';

const DOC='https://docs.gusto.com/embedded-payroll/reference/';
const VERSION='2026-06-15';
const limitations=['Synthetic company and employee IDs, not externally issued Gusto UUIDs.','Only existing controller-approved regular-wage source time and explicit simulation or 2026 federal policy are supported.','No earnings edits, payroll schedules, supplemental rates, benefits, state/local tax or tax filing.','Calculate is synchronous canonical computation behind an accepted response; submit requires distinct controller review and simulated one-hour wage settlement. Taxes remit separately.'];
export const providerPayrollRoutes=[
  {id:'gusto.company.get',system:'gusto',method:'GET',path:'/v1/companies/:company_id',access:'read',description:'Read the canonical company identity without inventing legal/tax/onboarding attributes.',documentation:[DOC+'get-v1-companies'],limitations},
  {id:'gusto.employees.list',system:'gusto',method:'GET',path:'/v1/companies/:company_id/employees',access:'read',description:'Read source employees with page/per, uuids, payroll_uuid, search_term and name sorting.',documentation:[DOC+'get-v1-companies-company_id-employees'],limitations},
  {id:'gusto.employee.get',system:'gusto',method:'GET',path:'/v1/employees/:employee_id',access:'read',description:'Read a synthetic employee and their canonical employment/time/tax source references.',documentation:[DOC+'get-v1-employees'],limitations},
  {id:'gusto.payrolls.list',system:'gusto',method:'GET',path:'/v1/companies/:company_id/payrolls',access:'read',description:'List actual runs. Use processing_statuses=processed,unprocessed and payroll_types=regular,off_cycle to include drafts; defaults are processed and regular. Supported query names: page, per, processing_statuses, payroll_types, start_date, end_date, sort_order=asc|desc, include=totals,taxes. No include_off_cycle parameter.',documentation:[DOC+'get-v1-companies-company_id-payrolls'],limitations},
  {id:'gusto.payroll.get',system:'gusto',method:'GET',path:'/v1/companies/:company_id/payrolls/:payroll_id',access:'read',description:'Read actual payroll state, paginated employee compensations, exact USD totals and source version.',documentation:[DOC+'get-v1-companies-company_id-payrolls-payroll_id'],limitations},
  {id:'gusto.payroll.create',system:'gusto',method:'POST',path:'/v1/companies/:company_id/payrolls',access:'write',description:'Create an uncalculated Adhoc preparation. Requires off_cycle:true, off_cycle_reason:Adhoc, exact source start_date/end_date, employee_uuids and finance_world:{policy_id,time_record_ids}.',documentation:[DOC+'post-v1-companies-company_id-payrolls'],limitations},
  {id:'gusto.payroll.calculate',system:'gusto',method:'PUT',path:'/v1/companies/:company_id/payrolls/:payroll_id/calculate',access:'write',description:'Calculate the same immutable preparation from frozen source facts. Requires finance_world:{version} from the latest GET.',documentation:[DOC+'put-v1-companies-company_id-payrolls-payroll_id-calculate'],limitations},
  {id:'gusto.payroll.submit',system:'gusto',method:'PUT',path:'/v1/companies/:company_id/payrolls/:payroll_id/submit',access:'write',description:'Request independent approval for an existing calculation. Requires finance_world:{version}; accepted review is not paid wages or remitted taxes.',documentation:[DOC+'put-v1-companies-company_id-payrolls-payroll_id-submit'],limitations},
] as const;

function fail(code:string,message:string,status=400):never{throw new DomainError(status,code,message);}
const clone=<T>(value:T):T=>structuredClone(value);
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const find=(rows:any[],id:string,label:string)=>rows.find(row=>row.id===id)??fail('resource_missing',`${label} does not exist in this world`,404);
function decode(value:string){try{const result=decodeURIComponent(value);if(!result||/[\u0000-\u001f\u007f/\\]/.test(result))fail('invalid_parameter','Invalid resource identifier');return result;}catch(error){if(error instanceof DomainError)throw error;return fail('invalid_parameter','Malformed resource identifier');}}
function fields(value:any,allowed:string[]){if(!value||typeof value!=='object'||Array.isArray(value))fail('invalid_body','Expected an object body',422);for(const key of Object.keys(value))if(!allowed.includes(key))fail('unsupported_field',`Unsupported Gusto subset field: ${key}`,501);}
function query(url:URL,allowed:string[]){for(const key of url.searchParams.keys()){if(!allowed.includes(key))fail('unsupported_filter',`Unsupported Gusto subset query: ${key}`,501);if(url.searchParams.getAll(key).length!==1)fail('duplicate_parameter',`Repeated query: ${key}`,422);}}
function integer(raw:string|null,label:string,fallback:number,max=100){if(raw===null)return fallback;if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>max)fail('invalid_parameter',`${label} must be an integer in 1..${max}`,422);return Number(raw);}
function ids(value:any,label:string):string[]{if(!Array.isArray(value)||!value.length||value.length>100||value.some((id:any)=>typeof id!=='string'||!id||id.length>200)||new Set(value).size!==value.length)fail('invalid_parameter',`${label} requires 1–100 distinct source IDs`,422);return value;}
function csv(raw:string|null,allowed:string[],label:string,fallback:string[]=[]){if(raw===null)return fallback;const result=raw.split(',');if(!result.length||result.some(value=>!allowed.includes(value))||new Set(result).size!==result.length)fail('unsupported_filter',`${label} supports ${allowed.join(', ')}`,501);return result;}
function date(raw:string|null,label:string){if(raw===null)return undefined;if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)||!Number.isFinite(Date.parse(raw))||new Date(raw).toISOString().slice(0,10)!==raw)fail('invalid_parameter',`${label} must be a real YYYY-MM-DD date`,422);return raw;}
/** USD amounts never pass through binary floating-point division. */
function usd(minor:number){if(!Number.isSafeInteger(minor)||minor<0)fail('invalid_payroll_record','Payroll amount is not an exact nonnegative USD cent value',409);const n=BigInt(minor);return `${n/100n}.${String(n%100n).padStart(2,'0')}`;}
function hours(minutes:number){const millionths=(BigInt(minutes)*1000000n+30n)/60n;return `${millionths/1000000n}.${String(millionths%1000000n).padStart(6,'0')}`;}
function page<T>(rows:T[],url:URL,forced=false):{rows:T[];headers:Record<string,string>}{if(!forced&&!url.searchParams.has('page')&&!url.searchParams.has('per'))return {rows,headers:{}};const number=integer(url.searchParams.get('page'),'page',1,1000000),per=integer(url.searchParams.get('per'),'per',forced?100:25),offset=(number-1)*per;return {rows:rows.slice(offset,offset+per),headers:{'X-Page':String(number),'X-Per-Page':String(per),'X-Total-Count':String(rows.length),'X-Total-Pages':String(Math.ceil(rows.length/per))}};}
function names(employee:any){const [first,...last]=employee.display_name.split(/\s+/);return {first_name:first,last_name:last.join(' ')};}
function employeeShape(w:World,employee:any,include:string[]=[]){return {uuid:employee.id,company_uuid:w.id,...names(employee),email:employee.email,version:hash(employee),payment_method:'Direct Deposit',...(include.includes('company_name')?{company_name:w.name}:{}),finance_world:{display_name:employee.display_name,name_projection:'Display-name tokens; no separate legal-name record is asserted',hourly_rate:usd(employee.hourly_rate_minor),currency:'USD',route_enabled:employee.route_enabled,verified_route_id:employee.verified_route_id,employment_document_id:employee.document_id,time_record_ids:(w.payrollTimeRecords??[]).filter((row:any)=>row.employee_id===employee.id).map((row:any)=>row.id),tax_profile_ids:(w.employeeTaxProfiles??[]).filter((row:any)=>row.employee_id===employee.id).map((row:any)=>row.id)}};}
function taxRows(line:any){const tax=line.tax_calculation;if(!tax)return [{name:'Simulation employee withholding',employer:false,amount:usd(line.employee_withholding_minor)},{name:'Simulation employer charge',employer:true,amount:usd(line.employer_tax_minor)}];return ([['Federal Income Tax',false,'federal_income_tax_minor'],['Social Security',false,'employee_social_security_minor'],['Medicare',false,'employee_medicare_minor'],['Additional Medicare',false,'employee_additional_medicare_minor'],['Social Security',true,'employer_social_security_minor'],['Medicare',true,'employer_medicare_minor'],['FUTA (no state credit assumed)',true,'employer_futa_minor']] as const).map(([name,employer,key])=>({name,employer,amount:usd(tax[key])}));}
function payrollShape(w:World,run:any,include:string[],detail:boolean,url:URL):ProviderResponse{
  const calculated=Array.isArray(run.lines),processed=run.status==='paid';
  const selected=calculated?run.lines:run.source_snapshot?.time_records??[],sourceEmployees=run.source_snapshot?.employees??w.employees;
  const operation=w.operations.find(row=>row.id===run.operation_id),approval=w.approvals.find(row=>row.id===run.approval_id);
  const finance:any={canonical_status:run.status,version:payrollRunVersion(run),source_version:run.source_version??null,source_stale:run.status==='draft'&&run.source_version!==payrollSourceVersion(w,run),policy_id:run.policy_id,time_record_ids:clone(run.time_record_ids),employee_ids:clone(run.employee_ids),policy_mode:run.policy.mode??'synthetic',policy_document_id:run.policy.document_id,calculation_document_id:run.document_id??null,preparation_document_id:run.prepared_document_id??null,approval_id:run.approval_id??null,approval_status:approval?.status??(run.status==='awaiting_approval'?'pending':null),operation_id:run.operation_id??null,settlement_status:operation?.status??null,wages_paid:processed,tax_remitted:processed&&run.tax_paid_minor===run.tax_total_minor,amount_paid:usd(run.amount_paid_minor),tax_paid:usd(run.tax_paid_minor),tax_outstanding:calculated?usd(run.tax_total_minor-run.tax_paid_minor):null,estimated_net_pay:calculated?usd(run.net_minor):null,simulation_settlement_hours:1,status_semantics:'processed means actual simulated wage settlement; controller approval and tax remittance are separate',scope:limitations};
  const body:any={uuid:run.id,payroll_uuid:run.id,company_uuid:w.id,off_cycle:run.off_cycle??false,...(run.off_cycle?{off_cycle_reason:run.off_cycle_reason}:{}),auto_payroll:false,external:false,processed,processed_date:run.paid_at?.slice(0,10)??null,calculated_at:calculated?(run.calculated_at??run.created_at):null,pay_period:{start_date:run.period_start,end_date:run.period_end,pay_schedule_uuid:null},...(processed?{check_date:run.paid_at.slice(0,10)}:{}),created_at:run.created_at,processing_request:run.status==='draft'||run.status==='rejected'?null:{status:processed?'submit_success':run.status==='pending'?'submitting':'calculate_success',errors:[]},finance_world:finance};
  if(calculated&&(detail||include.includes('totals')))body.totals={gross_pay:usd(run.gross_minor),net_pay:usd(run.net_minor),net_pay_debit:usd(run.net_minor),employee_taxes:usd(run.employee_withholding_minor),employer_taxes:usd(run.employer_tax_minor),tax_debit:usd(run.tax_total_minor),company_debit:usd(run.gross_minor+run.employer_tax_minor)};
  if(calculated&&include.includes('taxes'))body.company_taxes=[]; // Supported taxes are allocated per employee; no additional company-only taxes.
  if(!detail)return {body};
  const compensations=selected.map((line:any)=>{const employee=find(sourceEmployees,line.employee_id,'Source employee');return {employee_uuid:line.employee_id,...names(employee),excluded:false,gross_pay:calculated?usd(line.gross_minor):null,net_pay:processed?usd(line.net_minor):null,check_amount:processed?usd(line.net_minor):null,payment_method:'Direct Deposit',hourly_compensations:[{name:'Regular',hours:hours(line.minutes),...(calculated?{amount:usd(line.gross_minor)}:{})}],...(include.includes('taxes')&&calculated?{taxes:taxRows(line)}:{}),finance_world:{minutes:line.minutes,hourly_rate:usd(line.hourly_rate_minor),hours_projection:'Rounded to six decimal hours for display; exact source minutes determine wages',time_record_id:line.time_record_id??line.id,source_document_ids:line.source_document_ids??[line.document_id,line.employee_document_id],tax_profile_id:line.tax_profile_id??null,...(line.tax_calculation?{tax_ruleset:clone(line.tax_calculation.ruleset),taxable_bases:clone(line.tax_calculation.taxable_bases)}:{})}};});
  const paginated=page(compensations,url,true);body.employee_compensations=paginated.rows;return {body,headers:paginated.headers};
}

export async function providerPayroll(ctx:ProviderRequest):Promise<ProviderResponse|undefined>{
  if(ctx.system!=='gusto')return undefined;
  const url=typeof ctx.url==='string'?new URL(ctx.url):ctx.url,w=ctx.world,method=ctx.method.toUpperCase(),route=ctx.route.replace(/\/$/,'');
  const requestedVersion=ctx.headers?.get('X-Gusto-API-Version');if(requestedVersion!==undefined&&requestedVersion!==null&&requestedVersion!==VERSION)fail('unsupported_api_version',`This adapter supports Gusto API ${VERSION}`,501);
  const company=/^\/v1\/companies\/([^/]+)(?:\/(employees|payrolls)(?:\/([^/]+)(?:\/(calculate|submit))?)?)?$/.exec(route),employee=/^\/v1\/employees\/([^/]+)$/.exec(route);
  if(!company&&!employee)return undefined;
  if(company&&decode(company[1]!)!==w.id)fail('resource_missing','Company does not exist in this world',404);
  const response=(result:ProviderResponse)=>({...result,headers:{'X-Gusto-API-Version':VERSION,...result.headers}});
  if(employee){if(method!=='GET')fail('unsupported_operation','Employee writes require controller source actions, not this vendor subset',501);query(url,['include']);const include=csv(url.searchParams.get('include'),['company_name'],'include');return response({body:employeeShape(w,find(w.employees,decode(employee[1]!),'Employee'),include)});}
  const [,companyId,collection,rawId,operation]=company!;void companyId;
  if(!collection){if(method!=='GET')fail('unsupported_operation','Company writes are not implemented',501);query(url,[]);return response({body:{uuid:w.id,name:w.name,finance_world:{world_id:w.id,currency:'USD',policy_ids:w.payrollPolicies.map((row:any)=>row.id),scope:limitations}}});}
  if(collection==='employees'){
    if(rawId||operation)return undefined;if(method!=='GET')fail('unsupported_operation','Employee creation is a controller source action',501);
    query(url,['page','per','uuids','payroll_uuid','search_term','sort_by','include']);const include=csv(url.searchParams.get('include'),['company_name'],'include');let rows=[...w.employees];
    if(url.searchParams.has('uuids')){const requested=ids(url.searchParams.get('uuids')!.split(','),'uuids');rows=rows.filter(row=>requested.includes(row.id));}
    if(url.searchParams.has('payroll_uuid')){const run=find(w.payrollRuns,url.searchParams.get('payroll_uuid')!,'Payroll');rows=rows.filter(row=>run.employee_ids.includes(row.id));}
    if(url.searchParams.has('search_term')){const term=url.searchParams.get('search_term')!.toLowerCase();rows=rows.filter(row=>`${row.display_name} ${row.email}`.toLowerCase().includes(term));}
    if(url.searchParams.has('sort_by')){const sort=url.searchParams.get('sort_by')!;if(!/^name(?::(?:asc|desc))?$/.test(sort))fail('unsupported_filter','Only name:asc and name:desc employee sorting is supported',501);rows.sort((a,b)=>a.display_name.localeCompare(b.display_name)||a.id.localeCompare(b.id));if(sort.endsWith(':desc'))rows.reverse();}
    const p=page(rows,url);return response({body:p.rows.map(row=>employeeShape(w,row,include)),headers:p.headers});
  }
  if(method==='POST'&&!rawId){
    query(url,[]);const input=ctx.input;fields(input,['off_cycle','off_cycle_reason','start_date','end_date','employee_uuids','finance_world']);
    if(input.off_cycle!==true||input.off_cycle_reason!=='Adhoc')fail('unsupported_payroll_type','Only an Adhoc off-cycle source preparation is implemented',501);
    fields(input.finance_world,['policy_id','time_record_ids']);const employeeIds=ids(input.employee_uuids,'employee_uuids'),sourceIds=ids(input.finance_world.time_record_ids,'time_record_ids');
    const start=date(input.start_date??null,'start_date'),end=date(input.end_date??null,'end_date');if(!start||!end)fail('invalid_parameter','start_date and end_date are required',422);
    const sources=sourceIds.map(id=>find(w.payrollTimeRecords,id,'Payroll time'));if(sources.some(row=>row.period_start!==start||row.period_end!==end))fail('payroll_period_mismatch','Vendor pay period must equal every authoritative time source period',409);
    const result=await ctx.execute({type:'prepare_payroll',policy_id:input.finance_world.policy_id,time_record_ids:sourceIds,employee_ids:employeeIds});return response({...payrollShape(w,result.payroll_run,[],true,url),status:200});
  }
  if(rawId){
    const run=find(w.payrollRuns,decode(rawId),'Payroll');
    if(operation){
      if(method!=='PUT')return undefined;query(url,[]);fields(ctx.input,['finance_world']);fields(ctx.input.finance_world,['version']);const version=ctx.input.finance_world.version;
      if(typeof version!=='string'||!/^[a-f0-9]{64}$/.test(version))fail('payroll_version_required','finance_world.version must be the opaque version from GET',409);
      if(version!==payrollRunVersion(run))fail('payroll_version_conflict','Payroll changed since it was read',409);
      const result=await ctx.execute(operation==='calculate'?{type:'calculate_prepared_payroll',payroll_run_id:run.id,version}:{type:'execute_payroll',payroll_run_id:run.id});return response({...payrollShape(w,result.payroll_run,[],true,url),status:202});
    }
    if(method!=='GET')fail('unsupported_operation','Payroll earnings and source facts are immutable; vendor update/delete is unsupported',501);query(url,['page','per','include']);const include=csv(url.searchParams.get('include'),['taxes','totals'],'include');return response(payrollShape(w,run,include,true,url));
  }
  if(method!=='GET')return undefined;
  query(url,['page','per','processing_statuses','payroll_types','start_date','end_date','sort_order','include']);
  const statuses=csv(url.searchParams.get('processing_statuses'),['processed','unprocessed'],'processing_statuses',['processed']),types=csv(url.searchParams.get('payroll_types'),['regular','off_cycle'],'payroll_types',['regular']),include=csv(url.searchParams.get('include'),['taxes','totals'],'include'),start=date(url.searchParams.get('start_date'),'start_date'),end=date(url.searchParams.get('end_date'),'end_date')??w.now.slice(0,10);
  if(start&&start>end)fail('invalid_parameter','start_date cannot follow end_date',422);const order=url.searchParams.get('sort_order')??'asc';if(!['asc','desc'].includes(order))fail('invalid_parameter','sort_order must be asc or desc',422);
  let rows=w.payrollRuns.filter((run:any)=>statuses.includes(run.status==='paid'?'processed':'unprocessed')&&types.includes(run.off_cycle?'off_cycle':'regular')&&(!start||run.period_start>=start)&&run.period_end<=end).sort((a:any,b:any)=>a.period_start.localeCompare(b.period_start)||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));if(order==='desc')rows.reverse();const p=page(rows,url);return response({body:p.rows.map(run=>payrollShape(w,run,include,false,url).body),headers:p.headers});
}

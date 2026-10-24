/** Versioned regular-wage US federal payroll. Opening YTD and W-4 are controller
 * evidence; calculated runs serialize each employee's annual tax-base claim.
 * Tax deposits remain simulated; this module neither files returns nor applies
 * state/local taxes, benefit deductions, supplemental wages or FUTA credits. */
import type {World,Actor,Action} from './world.ts';
import type {PayrollHooks} from './payroll.ts';
import {calculateFederalPayrollTax,validateFederalW4,validatePriorYtd,payrollPayPeriods,federalPayrollRuleset,PayrollTaxError} from './payroll-tax.ts';
export const statutoryPayrollCollections:Record<string,string>={'employee-tax-profile':'employeeTaxProfiles'};
export const statutoryPayrollRequirements:Record<string,{role:'controller'|'operator';system:string;external?:boolean}>={record_employee_tax_profile:{role:'controller',system:'gusto',external:true},record_statutory_payroll_policy:{role:'controller',system:'gusto',external:true}};
export function normalizeStatutoryPayroll(w:World){w.employeeTaxProfiles??=[];}
function fields(a:Action,names:string[],h:PayrollHooks){if(Object.keys(a).some(key=>!['type','action',...names].includes(key)))h.fail('invalid_statutory_field','Unsupported statutory payroll source field');}
function year(a:any,h:PayrollHooks){if(a.tax_year!==2026||a.jurisdiction!=='US-federal')h.fail('unsupported_tax_ruleset','Only the versioned 2026 US federal regular-wage ruleset is supported');}
function sourceDate(raw:any,h:PayrollHooks){if(typeof raw!=='string'||!/^2026-\d{2}-\d{2}$/.test(raw)||!Number.isFinite(Date.parse(raw))||new Date(raw).toISOString().slice(0,10)!==raw)h.fail('invalid_tax_source_date','Tax source as_of_date must be a valid 2026 YYYY-MM-DD');return raw as string;}
function taxCall<T>(fn:()=>T,h:PayrollHooks):T{try{return fn();}catch(error){if(error instanceof PayrollTaxError)h.fail(error.code,error.message,400);throw error;}}
export function statutoryPayrollAction(w:World,a:Action,actor:Actor,h:PayrollHooks):{handled:boolean;result?:any}{
 const type=a.type??a.action;if(!type||!statutoryPayrollRequirements[type])return {handled:false};if(actor.role!=='controller')h.fail('controller_required','Payroll tax sources require controller authority',403);year(a,h);
 if(type==='record_statutory_payroll_policy'){
  fields(a,['name','tax_year','jurisdiction','pay_frequency','external_event_id'],h);if(typeof a.pay_frequency!=='string'||!Object.hasOwn(payrollPayPeriods,a.pay_frequency))h.fail('unsupported_pay_frequency','Choose a supported regular payroll frequency');
  const policy:any={id:h.id('payroll-policy'),mode:'us-federal-2026',name:h.text(a.name,'name',200),tax_year:2026,jurisdiction:'US-federal',pay_frequency:a.pay_frequency,wage_kind:'regular',taxable_bases:'gross regular wages for all federal taxes; no pretax deductions',futa_credit:'none',ruleset:structuredClone(federalPayrollRuleset),tax_beneficiary_id:'synthetic-us-federal-tax-authority',created_at:w.now,issued_by:actor.id,external_event_id:a.external_event_id};
  const doc=h.document('statutory-payroll-policy',policy.name,'2026 US federal regular wages: IRS Publication 15-T Worksheet 1A and Publication 15. Employee Form W-4 and opening year-to-date wages must be explicit source records. All current gross wages are taxable for income tax, Social Security, Medicare and FUTA. FUTA uses the full 6% without state credit. No state/local tax, deductions, supplemental pay or filing is inferred. Both wage and deposit payments require independent approval.',{policy_id:policy.id,ruleset:policy.ruleset});policy.document_id=doc.id;w.payrollPolicies.push(policy);h.emit('payroll.statutory_policy_recorded',{policy_id:policy.id,document_id:doc.id});return {handled:true,result:{policy}};
 }
 fields(a,['employee_id','tax_year','jurisdiction','w4','prior_ytd','as_of_date','external_event_id'],h);const employee=h.find(w.employees,a.employee_id,'Employee'),date=sourceDate(a.as_of_date,h);
 if(date>=w.now.slice(0,10))h.fail('invalid_tax_source_date','Opening tax YTD must precede the current simulation date');
 if(w.employeeTaxProfiles.some((p:any)=>p.employee_id===employee.id&&p.tax_year===a.tax_year))h.fail('tax_profile_exists','An immutable employee profile already exists for this tax year',409);
 if(w.payrollRuns.some((run:any)=>!['draft','rejected'].includes(run.status)&&run.employee_ids.includes(employee.id)&&((run.paid_at??run.created_at).slice(0,4)==='2026')))h.fail('tax_profile_after_payroll','Record opening tax evidence before calculating or paying any run in this tax year',409);
 const profile:any={id:h.id('tax-profile'),employee_id:employee.id,tax_year:2026,jurisdiction:'US-federal',w4:taxCall(()=>validateFederalW4(a.w4),h),prior_ytd:taxCall(()=>validatePriorYtd(a.prior_ytd),h),as_of_date:date,recorded_at:w.now,recorded_by:actor.id,external_event_id:a.external_event_id};
 const doc=h.document('employee-tax-profile',`Federal tax source ${employee.id}`,`Controller source: 2026 Form W-4 elections and wages previously paid through ${date}. Opening YTD is historical source context, not a new payroll expense or cash movement. Profile ${profile.id} is immutable. Current-period tax bases derive only from approved time and employment records.`,{tax_profile_id:profile.id,employee_id:employee.id,w4:profile.w4,prior_ytd:profile.prior_ytd,as_of_date:date});profile.document_id=doc.id;w.employeeTaxProfiles.push(profile);h.emit('payroll.tax_profile_recorded',{tax_profile_id:profile.id,employee_id:employee.id,document_id:doc.id});return {handled:true,result:{tax_profile:profile}};
}
export function statutoryCalculation(w:World,policy:any,source:any,employee:any,gross:number,h:PayrollHooks){
 const profile=w.employeeTaxProfiles.find((p:any)=>p.employee_id===employee.id&&p.tax_year===Number(w.now.slice(0,4)));
 if(policy.mode!=='us-federal-2026'){if(w.employeeTaxProfiles.some((p:any)=>p.employee_id===employee.id))h.fail('tax_policy_mismatch','An employee with statutory tax evidence requires the matching statutory policy',409);return undefined;}
 if(w.now.slice(0,4)!=='2026')h.fail('unsupported_tax_year','The configured statutory ruleset cannot calculate wages outside 2026',409);
 if(!profile)h.fail('missing_employee_tax_profile','Record explicit W-4 and opening YTD source facts before statutory calculation',409);
 if(source.period_start<=profile.as_of_date)h.fail('tax_period_before_opening_ytd','Current work must follow the opening historical YTD cutoff',409);
 const employeeRuns=w.payrollRuns.filter((r:any)=>!['draft','rejected'].includes(r.status)&&r.employee_ids.includes(employee.id));
 if(employeeRuns.some((r:any)=>r.status!=='paid'))h.fail('tax_year_claimed','Settle or cancel the existing employee payroll calculation before claiming another annual tax base',409);
 if(employeeRuns.some((r:any)=>r.status==='paid'&&r.paid_at.slice(0,4)==='2026'&&(r.policy.mode!=='us-federal-2026'||r.period_end>=source.period_start)))h.fail('tax_payroll_sequence','Statutory wages require chronological completed work periods and consistent tax policy',409);
 const prior:any=structuredClone(profile.prior_ytd),paid=employeeRuns.filter((r:any)=>r.status==='paid'&&r.paid_at.slice(0,4)==='2026');
 for(const r of paid){const line=r.lines.find((l:any)=>l.employee_id===employee.id);if(!line.tax_input)h.fail('tax_ytd_evidence_missing','Paid source run lacks exact statutory wage bases',409);for(const key of ['social_security_wages_minor','medicare_wages_minor','futa_wages_minor']){const total=BigInt(prior[key])+BigInt(line.tax_input[key]);if(total>1000000000000n)h.fail('tax_ytd_overflow','Annual wage source exceeds supported bounds');prior[key]=Number(total);}}
 const input={tax_year:2026,jurisdiction:'US-federal',wage_kind:'regular',pay_frequency:policy.pay_frequency,gross_wages_minor:gross,federal_taxable_wages_minor:gross,social_security_wages_minor:gross,medicare_wages_minor:gross,futa_wages_minor:gross,w4:profile.w4,prior_ytd:prior};
 const calculation=taxCall(()=>calculateFederalPayrollTax(input),h);
 return {tax_input:structuredClone(input),tax_calculation:calculation,tax_profile_id:profile.id,tax_source_document_ids:[profile.document_id,...paid.map((r:any)=>r.document_id)],prior_payroll_run_ids:paid.map((r:any)=>r.id)};
}
export function statutoryExecutionCheck(w:World,run:any,h:PayrollHooks){
 if(run.policy.mode!=='us-federal-2026')return;
 if(w.now.slice(0,4)!=='2026')h.fail('tax_year_changed','Cancel this unexecuted calculation and supply rules for the actual payment year',409);
 for(const line of run.lines){const competing=w.payrollRuns.filter((r:any)=>r.id!==run.id&&!['draft','rejected'].includes(r.status)&&r.employee_ids.includes(line.employee_id));if(competing.some((r:any)=>r.status!=='paid')||competing.filter((r:any)=>r.status==='paid'&&r.paid_at.slice(0,4)==='2026').map((r:any)=>r.id).join('|')!==line.prior_payroll_run_ids.join('|'))h.fail('tax_ytd_changed','Paid wages or another annual tax claim changed since calculation; cancel and recalculate',409);}
}
export function statutorySettlementBlock(w:World,run:any){return run.policy.mode==='us-federal-2026'&&w.now.slice(0,4)!=='2026'?'tax_year_changed':undefined;}

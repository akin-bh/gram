import {test,expect} from 'bun:test';
import {createWorld,applyAction,DomainError} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {payrollRunVersion,payrollSourceVersion} from './payroll.ts';
const controller:Actor={id:'prepared-source-controller',role:'controller'},operator:Actor={id:'prepared-accountant',role:'operator'},other:Actor={id:'second-accountant',role:'operator'},reviewer:Actor={id:'independent-payroll-reviewer',role:'controller'};
const act=(w:World,a:Action,actor=operator)=>applyAction(w,a,actor).result;
const fresh=()=>createWorld({kind:'payroll-close',orderCount:2,payrollControls:{missingTime:false,disabledRoute:false}});
const selection=(w:World)=>({policy_id:w.payrollPolicies[0].id,time_record_ids:w.payrollTimeRecords.map((row:any)=>row.id)});
const financial=(w:World)=>structuredClone({accounts:w.accounts,bank:w.bankTransactions,journals:w.journals,operations:w.operations,approvals:w.approvals,payslips:w.payslips});
const fail=(w:World,a:Action,code:string,actor=operator)=>{const before=structuredClone(w);expect(()=>act(w,a,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);};

test('preparation records immutable source evidence without calculating, claiming wages or moving cash',()=>{
  const w=fresh(),before=financial(w),r=act(w,{type:'prepare_payroll',...selection(w)});
  expect(r.payroll_run.status).toBe('draft');expect(r.payroll_run.gross_minor).toBeUndefined();expect(r.payroll_run.lines).toBeUndefined();expect(r.version).toMatch(/^[a-f0-9]{64}$/);expect(r.version).toBe(payrollRunVersion(r.payroll_run));expect(r.payroll_run.source_version).toBe(payrollSourceVersion(w,r.payroll_run));expect(financial(w)).toStrictEqual(before);
  expect(act(w,{type:'prepare_payroll',...selection(w)}).payroll_run.id).toBe(r.payroll_run.id);expect(w.payrollRuns.length).toBe(1);
  fail(w,{type:'execute_payroll',payroll_run_id:r.payroll_run.id},'payroll_not_calculated');
  const legacy=act(w,{type:'calculate_payroll',...selection(w)}).payroll_run;expect(legacy.id).not.toBe(r.payroll_run.id);expect(legacy.status).toBe('calculated');expect(financial(w)).toStrictEqual(before);
});

test('prepared calculation uses the existing exact maths on the same canonical ID and execution still needs distinct approval',()=>{
  const w=fresh(),copy=structuredClone(w),expected=act(copy,{type:'calculate_payroll',...selection(copy)}).payroll_run,r=act(w,{type:'prepare_payroll',...selection(w)}),before=financial(w),snapshot=structuredClone(r.payroll_run.source_snapshot);
  act(w,{type:'send_email',to:['audit@simulation.test'],subject:'Unrelated note',body:'This correspondence does not change payroll inputs.'});
  const calculated=act(w,{type:'calculate_prepared_payroll',payroll_run_id:r.payroll_run.id,version:r.version}).payroll_run;
  expect(calculated.id).toBe(r.payroll_run.id);expect(w.payrollRuns.length).toBe(1);expect(calculated.gross_minor).toBe(expected.gross_minor);expect(calculated.net_minor).toBe(expected.net_minor);expect(calculated.lines).toStrictEqual(expected.lines);expect(calculated.source_snapshot).toStrictEqual(snapshot);expect(financial(w)).toStrictEqual(before);
  fail(w,{type:'calculate_prepared_payroll',payroll_run_id:calculated.id,version:r.version},'payroll_version_conflict');
  const requested=act(w,{type:'execute_payroll',payroll_run_id:calculated.id});expect(requested.status).toBe('awaiting_approval');expect(w.operations.length).toBe(0);
  fail(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},'controller_required',operator);
  act(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},reviewer);expect(w.payrollRuns[0].status).toBe('pending');expect(w.payslips.length).toBe(0);
  act(w,{type:'advance_time',hours:1},controller);expect(w.payrollRuns[0].status).toBe('paid');expect(w.payslips.length).toBe(2);
});

test('invalid versions, changed source evidence and forged calculation fields fail without mutating a draft',()=>{
  const w=fresh(),r=act(w,{type:'prepare_payroll',...selection(w)});
  fail(w,{type:'calculate_prepared_payroll',payroll_run_id:r.payroll_run.id},'payroll_version_required');
  fail(w,{type:'calculate_prepared_payroll',payroll_run_id:r.payroll_run.id,version:'0'.repeat(64)},'payroll_version_conflict');
  fail(w,{type:'calculate_prepared_payroll',payroll_run_id:r.payroll_run.id,version:r.version,gross_minor:1},'invalid_payroll_field');
  fail(w,{type:'prepare_payroll',...selection(w),hourly_rate_minor:1},'invalid_payroll_field');
  act(w,{type:'set_employee_route',employee_id:w.employees[0].id,enabled:false,reason:'Verification changed after preparation',external_event_id:'prepared-route-change'},controller);
  fail(w,{type:'calculate_prepared_payroll',payroll_run_id:r.payroll_run.id,version:r.version},'payroll_source_changed');
  act(w,{type:'cancel_payroll',payroll_run_id:r.payroll_run.id,reason:'Supersede stale preparation with original source history retained',external_event_id:'prepared-cancel'},controller);
  const replacement=act(w,{type:'prepare_payroll',...selection(w)});expect(replacement.payroll_run.id).not.toBe(r.payroll_run.id);expect(w.payrollRuns[0].status).toBe('rejected');expect(w.payrollRuns[1].status).toBe('draft');
});

test('overlapping preparations do not claim wages but only one can calculate and execute',()=>{
  const w=createWorld({kind:'payroll-federal',orderCount:1}),one=act(w,{type:'prepare_payroll',...selection(w)}),two=act(w,{type:'prepare_payroll',...selection(w)},other);
  expect(one.payroll_run.id).not.toBe(two.payroll_run.id);
  act(w,{type:'calculate_prepared_payroll',payroll_run_id:one.payroll_run.id,version:one.version});
  fail(w,{type:'calculate_prepared_payroll',payroll_run_id:two.payroll_run.id,version:two.version},'payroll_period_claimed',other);
  const request=act(w,{type:'execute_payroll',payroll_run_id:one.payroll_run.id});act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},reviewer);act(w,{type:'advance_time',hours:1},controller);
  expect(w.payrollRuns[0].status).toBe('paid');expect(w.payrollRuns[1].status).toBe('draft');expect(w.payslips.length).toBe(1);
});

test('a draft does not block adding missing federal source facts, but their new version requires a fresh preparation',()=>{
  const w=createWorld({kind:'payroll-federal',initialCashMinor:1000000,blueprint:{version:1,opening_at:'2026-10-24T09:00:00.000Z',payroll_policy:{ref:'federal',mode:'us-federal-2026',name:'Federal source policy',tax_year:2026,jurisdiction:'US-federal',pay_frequency:'semimonthly'},employees:[{ref:'employee',name:'Synthetic employee',hourly_rate_minor:2500,time_records:[{ref:'time',period_start:'2026-10-01',period_end:'2026-10-14',minutes:4800}]}]} as any});
  const r=act(w,{type:'prepare_payroll',...selection(w)});fail(w,{type:'calculate_prepared_payroll',payroll_run_id:r.payroll_run.id,version:r.version},'missing_employee_tax_profile');
  act(w,{type:'record_employee_tax_profile',employee_id:w.employees[0].id,tax_year:2026,jurisdiction:'US-federal',as_of_date:'2026-09-30',w4:{form_year:2026,filing_status:'single_or_married_filing_separately',step2_checked:false,annual_credits_minor:0,other_income_minor:0,deductions_minor:0,extra_withholding_minor:0},prior_ytd:{social_security_wages_minor:18400000,medicare_wages_minor:19900000,futa_wages_minor:700000},external_event_id:'profile-after-draft'},controller);
  fail(w,{type:'calculate_prepared_payroll',payroll_run_id:r.payroll_run.id,version:r.version},'payroll_source_changed');
  act(w,{type:'cancel_payroll',payroll_run_id:r.payroll_run.id,reason:'Use newly supplied tax source facts',external_event_id:'cancel-missing-profile-draft'},controller);
  const prepared=act(w,{type:'prepare_payroll',...selection(w)}),run=act(w,{type:'calculate_prepared_payroll',payroll_run_id:prepared.payroll_run.id,version:prepared.version}).payroll_run;
  expect(run.lines[0].tax_input.prior_ytd.social_security_wages_minor).toBe(18400000);expect(run.gross_minor).toBe(200000);expect(run.id).toBe(prepared.payroll_run.id);
});

test('failed payroll maths leaves an uncalculated preparation intact without claims or accounting',()=>{
  const w=createWorld({kind:'payroll-close',initialCashMinor:1000,blueprint:{version:1,opening_at:'2026-10-24T09:00:00.000Z',payroll_policy:{ref:'policy',mode:'synthetic',name:'Explicit high withholding',employee_withholding_bps:9999,employer_tax_bps:0},employees:[{ref:'small',name:'Synthetic small source',hourly_rate_minor:1,time_records:[{ref:'time',period_start:'2026-10-01',period_end:'2026-10-02',minutes:60}]}]} as any});
  const r=act(w,{type:'prepare_payroll',...selection(w)});fail(w,{type:'calculate_prepared_payroll',payroll_run_id:r.payroll_run.id,version:r.version},'zero_net_payroll');expect(w.payrollRuns.length).toBe(1);expect(w.payrollRuns[0].status).toBe('draft');expect(w.operations.length).toBe(0);
});

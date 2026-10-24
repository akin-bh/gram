import {test,expect} from 'bun:test';
import {createWorld,applyAction,DomainError,normalizeWorld,recordsFor,summarize,actionRequirements} from './world.ts';
import type {Action,Actor,World} from './world.ts';

const operator:Actor={id:'payroll-worker',role:'agent'},controller:Actor={id:'payroll-controller',role:'controller'};
const act=(w:World,action:Action,actor=controller)=>applyAction(w,action,actor).result;
const world=(extra:any={})=>createWorld({kind:'payroll-close',orderCount:1,payrollControls:{missingTime:false,disabledRoute:false},...extra});
const calculate=(w:World,extra:any={})=>act(w,{type:'calculate_payroll',policy_id:w.payrollPolicies[0].id,time_record_ids:w.payrollTimeRecords.map((row:any)=>row.id),...extra},operator).payroll_run;
const execute=(w:World,run:any)=>{const requested=act(w,{type:'execute_payroll',payroll_run_id:run.id},operator);return act(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'});};
const remit=(w:World,run:any)=>{const requested=act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},operator);return act(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'});};
function reject(w:World,action:Action,code:string,actor=operator){const before=structuredClone(w);expect(()=>act(w,action,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);}
function balanced(w:World){
  for(const journal of w.journals)expect(journal.lines.reduce((sum:number,line:any)=>sum+line.debit_minor-line.credit_minor,0)).toBe(0);
  expect(w.accounts.reduce((sum,account)=>sum+account.balance_minor,0)).toBe(0);
  const effective=(id:string)=>w.accounts.find(account=>account.id===id).balance_minor+w.operations.filter(operation=>operation.status==='settled'&&!operation.journal_id).flatMap(operation=>operation.journal_lines??[]).filter(line=>line.account_id===id).reduce((sum,line)=>sum+(line.debit_minor??0)-(line.credit_minor??0),0);
  const accrued=w.payrollRuns.filter((run:any)=>['pending','paid'].includes(run.status));
  expect(effective('payroll-expense')).toBe(accrued.reduce((sum:number,run:any)=>sum+run.gross_minor,0));
  expect(effective('employer-payroll-tax-expense')).toBe(accrued.reduce((sum:number,run:any)=>sum+run.employer_tax_minor,0));
  expect(effective('wages-payable')).toBe(0-accrued.reduce((sum:number,run:any)=>sum+run.net_minor-run.amount_paid_minor,0));
  const paidTax=w.payrollTaxRemittances.filter((row:any)=>row.status==='settled');
  expect(effective('employee-withholding-payable')).toBe(paidTax.reduce((sum:number,row:any)=>sum+row.employee_withholding_minor,0)-accrued.reduce((sum:number,run:any)=>sum+run.employee_withholding_minor,0));
  expect(effective('employer-payroll-tax-payable')).toBe(paidTax.reduce((sum:number,row:any)=>sum+row.employer_tax_minor,0)-accrued.reduce((sum:number,run:any)=>sum+run.employer_tax_minor,0));
}
function custom(w:World,id:string,rate:number,minutes:number,withheld=2000,employer=765){
  act(w,{type:'record_employee',employee_id:id,display_name:`Synthetic ${id}`,hourly_rate_minor:rate,external_event_id:`employee:${id}`});
  const policy=act(w,{type:'record_payroll_policy',name:`Test simulation ${id}`,employee_withholding_bps:withheld,employer_tax_bps:employer,external_event_id:`policy:${id}`}).policy;
  const time=act(w,{type:'record_payroll_time',employee_id:id,period_start:'2026-09-01',period_end:'2026-09-15',minutes,external_event_id:`time:${id}`}).time_record;
  return act(w,{type:'calculate_payroll',policy_id:policy.id,time_record_ids:[time.id],employee_ids:[id]},operator).payroll_run;
}

test('payroll scenario records deterministic employment and explicit simulation policy with honest source blockers',()=>{
  const w=createWorld({kind:'payroll-close',seed:'payroll'});expect(w).toStrictEqual(createWorld({kind:'payroll-close',seed:'payroll'}));expect(w.employees.length).toBe(3);expect(w.payrollTimeRecords.length).toBe(2);expect(w.payrollSources.missing_time_employee_ids).toStrictEqual(['employee-3']);expect(w.payrollSources.disabled_route_employee_ids).toStrictEqual(['employee-2']);expect(w.invoices.length).toBe(0);expect(w.bills.length).toBe(0);expect(w.payrollRuns.length).toBe(0);
  expect(w.documents.find(doc=>doc.type==='payroll-close-brief').body).toMatch(/not statutory tax rates/);expect(w.documents.find(doc=>doc.type==='payroll-close-brief').body).toMatch(/employee-3/);
  reject(w,{type:'calculate_payroll',policy_id:w.payrollPolicies[0].id,time_record_ids:w.payrollTimeRecords.map((row:any)=>row.id)},'missing_payroll_time');
  act(w,{type:'record_payroll_time',employee_id:'employee-3',period_start:'2026-10-01',period_end:'2026-10-15',minutes:4800,external_event_id:'missing-time-source'});const run=calculate(w);
  reject(w,{type:'execute_payroll',payroll_run_id:run.id},'payroll_route_disabled');expect(w.approvals.length).toBe(0);
  act(w,{type:'set_employee_route',employee_id:'employee-2',enabled:true,reason:'Controller verified existing synthetic route',external_event_id:'verified-route'});expect(execute(w,run).operation.status).toBe('pending');balanced(w);
  for(const feed of ['employee','payroll-policy','payroll-time','payroll-run','payroll-tax-remittance','payslip'])expect(recordsFor(w,'gusto',feed)).toStrictEqual(recordsFor(w,'ledger',feed));
});

test('gross and taxes use independent exact half-up rounding; calculations do not post or pay',()=>{
  const w=world(),before=w.journals.length,run=custom(w,'rounding-worker',101,90,2500,5000);
  // 101*90/60 = 151.5 -> 152; withholding38; employer76; net114.
  expect(run.gross_minor).toBe(152);expect(run.employee_withholding_minor).toBe(38);expect(run.employer_tax_minor).toBe(76);expect(run.net_minor).toBe(114);expect(run.tax_total_minor).toBe(114);
  expect(w.journals.length).toBe(before);expect(w.operations.length).toBe(0);expect(w.payslips.length).toBe(0);expect(run.policy.rounding).toBe('half-up to integer USD cents per employee');
  const duplicate=act(w,{type:'calculate_payroll',policy_id:run.policy_id,time_record_ids:run.time_record_ids,employee_ids:run.employee_ids},operator);expect(duplicate.replayed).toBe(true);expect(duplicate.payroll_run.id).toBe(run.id);expect(w.payrollRuns.length).toBe(1);balanced(w);
});

test('independent approval accrues exact liabilities, wages settle once, and separate approved taxes discharge only tax balances',()=>{
  const w=world({approvalThresholdMinor:1e12}),run=custom(w,'exact-worker',2500,4800),cash=summarize(w).cash_minor;
  expect(run.gross_minor).toBe(200000);expect(run.net_minor).toBe(160000);expect(run.employee_withholding_minor).toBe(40000);expect(run.employer_tax_minor).toBe(15300);
  const request=act(w,{type:'execute_payroll',payroll_run_id:run.id},operator);expect(request.status).toBe('awaiting_approval');expect(summarize(w).reserved_minor).toBe(0);
  reject(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'separate_controller_required',{id:operator.id,role:'controller'});
  const accepted=act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'});expect(accepted.operation.amount_minor).toBe(160000);expect(summarize(w).reserved_minor).toBe(160000);expect(summarize(w).wages_payable_minor).toBe(160000);expect(summarize(w).payroll_taxes_payable_minor).toBe(55300);expect(w.payslips.length).toBe(0);balanced(w);
  reject(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},'payroll_not_paid');act(w,{type:'advance_time',hours:1});expect(summarize(w).cash_minor).toBe(cash-160000);expect(summarize(w).wages_payable_minor).toBe(0);expect(summarize(w).payroll_taxes_payable_minor).toBe(55300);expect(w.payslips.length).toBe(1);balanced(w);
  const slip=w.payslips[0];expect(slip.net_minor).toBe(160000);expect(w.messages.some(message=>message.source_refs.includes(slip.id)&&message.source_refs.includes(slip.receipt_id))).toBeTruthy();expect(act(w,{type:'execute_payroll',payroll_run_id:run.id},operator).replayed).toBe(true);
  const taxRequest=act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},operator);expect(taxRequest.status).toBe('awaiting_approval');reject(w,{type:'decide_approval',approval_id:taxRequest.approval_id,decision:'approve'},'separate_controller_required',{id:operator.id,role:'controller'});
  const tax=act(w,{type:'decide_approval',approval_id:taxRequest.approval_id,decision:'approve'});expect(tax.operation.amount_minor).toBe(55300);expect(summarize(w).reserved_minor).toBe(55300);expect(act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},operator).operation.id).toBe(tax.operation.id);
  act(w,{type:'advance_time',hours:1});expect(summarize(w).cash_minor).toBe(cash-215300);expect(summarize(w).payroll_taxes_payable_minor).toBe(0);expect(summarize(w).reserved_minor).toBe(0);balanced(w);
  const bank=structuredClone(w.bankTransactions),journals=structuredClone(w.journals);act(w,{type:'advance_time',hours:24});expect(w.bankTransactions).toStrictEqual(bank);expect(w.journals).toStrictEqual(journals);expect(w.payslips.length).toBe(1);reject(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},'no_payroll_taxes_due');
});

test('rejected and cancelled unexecuted runs preserve evidence but release period claims, and cannot later execute',()=>{
  const w=world(),run=calculate(w),request=act(w,{type:'execute_payroll',payroll_run_id:run.id},operator);
  act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'reject'});expect(summarize(w).reserved_minor).toBe(0);expect(w.operations.length).toBe(0);const replacement=calculate(w);expect(replacement.id).not.toBe(run.id);reject(w,{type:'execute_payroll',payroll_run_id:run.id},'payroll_rejected');
  reject(w,{type:'cancel_payroll',payroll_run_id:replacement.id,reason:'Agent cannot release controls',external_event_id:'agent-cancel'},'controller_required');
  act(w,{type:'set_employee_route',employee_id:w.employees[0].id,enabled:false,reason:'Verification pending',external_event_id:'disable-before-cancel'});act(w,{type:'cancel_payroll',payroll_run_id:replacement.id,reason:'Recalculate under corrected policy',external_event_id:'controller-cancel'});const third=calculate(w);expect(third.id).not.toBe(replacement.id);expect(w.documents.some(doc=>doc.payroll_run_id===replacement.id&&doc.type==='payroll-cancellation')).toBeTruthy();
  act(w,{type:'set_employee_route',employee_id:w.employees[0].id,enabled:true,reason:'Verified route',external_event_id:'enable-after-cancel'});execute(w,third);reject(w,{type:'cancel_payroll',payroll_run_id:third.id,reason:'Too late',external_event_id:'cancel-accepted'},'payroll_cannot_cancel',controller);balanced(w);
});

test('source authority and calendar guards prohibit duplicate time, future periods, fabricated rates and zero net pay',()=>{
  const w=world(),employee=w.employees[0],time=w.payrollTimeRecords[0];
  for(const type of ['record_employee','record_payroll_policy','record_payroll_time','set_employee_route','cancel_payroll'])expect(actionRequirements[type].role).toBe('controller');
  reject(w,{type:'record_employee',employee_id:'forged-worker',display_name:'Not verified',hourly_rate_minor:10,external_event_id:'forged-employment'},'controller_required');
  reject(w,{type:'record_employee',employee_id:employee.id,display_name:'Duplicate',hourly_rate_minor:10,external_event_id:'duplicate-employee'},'employee_exists',controller);
  for(const [period_start,period_end] of [['2026-02-30','2026-03-01'],['2026-11-01','2026-11-15'],['2026-09-10','2026-09-01'],['2026-08-01','2026-09-30'],['2026-10-24','2026-10-24']])reject(w,{type:'record_payroll_time',employee_id:employee.id,period_start,period_end,minutes:60,external_event_id:`invalid-date:${period_start}`},'invalid_payroll_period',controller);
  reject(w,{type:'record_payroll_time',employee_id:employee.id,period_start:time.period_start,period_end:time.period_end,minutes:60,external_event_id:'duplicate-period'},'payroll_time_overlap',controller);
  reject(w,{type:'record_payroll_time',employee_id:employee.id,period_start:'2026-09-01',period_end:'2026-09-01',minutes:1441,external_event_id:'too-many-minutes'},'invalid_integer',controller);
  const policy=w.payrollPolicies[0],baseline=calculate(w);expect(baseline.lines[0].hourly_rate_minor).toBe(employee.hourly_rate_minor);expect(baseline.policy.employee_withholding_bps).toBe(policy.employee_withholding_bps);
  const zero=world();expect(()=>custom(zero,'zero-net-worker',1,60,9999,0)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='zero_net_payroll');
});

test('provider outages and disabled routes hold the immutable wage batch without sending premature payslips',()=>{
  const w=world(),run=calculate(w),accepted=execute(w,run),cash=summarize(w).cash_minor;
  act(w,{type:'set_fault',system:'gusto',mode:'offline'});const blocked=act(w,{type:'advance_time',hours:1});expect(blocked.blocked[0].reason).toBe('gusto:offline');expect(w.payslips.length).toBe(0);expect(summarize(w).cash_minor).toBe(cash);expect(summarize(w).reserved_minor).toBe(run.net_minor);
  act(w,{type:'set_fault',system:'gusto',mode:'healthy'});act(w,{type:'set_employee_route',employee_id:run.employee_ids[0],enabled:false,reason:'Verification temporarily suspended',external_event_id:'route-held'});expect(act(w,{type:'advance_time',hours:1}).blocked[0].reason).toBe('payroll_route_disabled');
  act(w,{type:'set_employee_route',employee_id:run.employee_ids[0],enabled:true,reason:'Same route verified',external_event_id:'route-restored'});act(w,{type:'set_fault',system:'bank',mode:'rate_limit'});expect(act(w,{type:'advance_time',hours:1}).blocked[0].reason).toBe('bank:rate_limit');
  act(w,{type:'set_fault',system:'bank',mode:'healthy'});act(w,{type:'set_fault',system:'gmail',mode:'offline'});act(w,{type:'advance_time',hours:1});expect(w.operations.find(operation=>operation.id===accepted.operation.id).status).toBe('settled');expect(w.payslips.length).toBe(1);expect(w.messages.some(message=>message.source_refs.includes(w.payslips[0].id)&&message.delivery_status==='queued')).toBeTruthy();
  act(w,{type:'set_fault',system:'gmail',mode:'healthy'});act(w,{type:'advance_time',hours:1});expect(w.messages.filter(message=>message.source_refs.includes(w.payslips[0].id)).every(message=>message.delivery_status==='delivered')).toBeTruthy();balanced(w);
});

test('payroll accrual, wage settlement and tax remittance remain separate facts while all journals defer and recover exactly once',()=>{
  const w=world({payrollControls:{missingTime:false,disabledRoute:false,periodClosed:true}}),run=calculate(w),cash=summarize(w).cash_minor;
  execute(w,run);expect(w.settledUnposted.length).toBe(1);act(w,{type:'advance_time',hours:1});expect(w.settledUnposted.length).toBe(2);expect(summarize(w).cash_minor).toBe(cash-run.net_minor);expect(w.accounts.find(account=>account.id==='wages-payable').balance_minor).toBe(0);expect(summarize(w).payroll_taxes_payable_minor).toBe(run.tax_total_minor);balanced(w);
  remit(w,run);act(w,{type:'advance_time',hours:1});expect(w.settledUnposted.length).toBe(3);expect(summarize(w).cash_minor).toBe(cash-run.gross_minor-run.employer_tax_minor);expect(summarize(w).payroll_taxes_payable_minor).toBe(0);balanced(w);
  act(w,{type:'set_fault',system:'netsuite',mode:'offline'});act(w,{type:'reopen_period'});expect(w.settledUnposted.length).toBe(3);act(w,{type:'set_fault',system:'netsuite',mode:'healthy'});act(w,{type:'set_fault',system:'ledger',mode:'offline'});act(w,{type:'advance_time',hours:1});expect(w.settledUnposted.length).toBe(3);
  const bank=structuredClone(w.bankTransactions);act(w,{type:'set_fault',system:'ledger',mode:'healthy'});act(w,{type:'advance_time',hours:1});expect(w.settledUnposted.length).toBe(0);expect(summarize(w).reconciliation.bank_ledger_difference_minor).toBe(0);expect(w.bankTransactions).toStrictEqual(bank);balanced(w);
});

test('tax rejection releases only its unexecuted remittance and never permits another employee wage payment',()=>{
  const w=world(),run=calculate(w);execute(w,run);act(w,{type:'advance_time',hours:1});const first=act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},operator);
  act(w,{type:'decide_approval',approval_id:first.approval_id,decision:'reject'});expect(w.payrollRuns[0].status).toBe('paid');expect(w.payrollTaxRemittances[0].status).toBe('rejected');expect(summarize(w).reserved_minor).toBe(0);
  const replacement=remit(w,run);expect(replacement.tax_remittance.id).not.toBe(first.tax_remittance.id);expect(summarize(w).reserved_minor).toBe(run.tax_total_minor);act(w,{type:'advance_time',hours:1});expect(w.payrollTaxRemittances.filter((row:any)=>row.status==='settled').length).toBe(1);expect(w.payslips.length).toBe(1);balanced(w);
});

test('controller fact replay preserves source IDs, while migration adds only empty payroll collections and zero balances',()=>{
  const w=world(),action={type:'record_employee',employee_id:'replay-worker',display_name:'Synthetic replay',hourly_rate_minor:2700,external_event_id:'employee-replay'},first=act(w,action),docCount=w.documents.length;
  expect(act(w,action).replayed).toBe(true);expect(w.documents.length).toBe(docCount);expect(w.employees.filter((employee:any)=>employee.id===first.employee.id).length).toBe(1);reject(w,{...action,hourly_rate_minor:2800},'external_event_conflict',controller);
  for(const account of ['wages-payable','employee-withholding-payable','employer-payroll-tax-payable'])reject(w,{type:'post_journal',lines:[{account_id:account,debit_minor:1},{account_id:'equity',credit_minor:1}]},'control_account_locked');
  const old=createWorld({orderCount:1}),ids=['payroll-expense','employer-payroll-tax-expense','wages-payable','employee-withholding-payable','employer-payroll-tax-payable'];old.accounts=old.accounts.filter(account=>!ids.includes(account.id));for(const key of ['employees','payrollPolicies','payrollTimeRecords','payrollRuns','payrollTaxRemittances','payslips'])delete old[key];const bank=structuredClone(old.bankTransactions),journals=structuredClone(old.journals),accounts=structuredClone(old.accounts);normalizeWorld(old);expect(old.bankTransactions).toStrictEqual(bank);expect(old.journals).toStrictEqual(journals);expect(old.accounts.filter(account=>!ids.includes(account.id))).toStrictEqual(accounts);expect(old.accounts.filter(account=>ids.includes(account.id)).every(account=>account.balance_minor===0)).toBeTruthy();expect(recordsFor(old,'gusto','payroll-run')).toStrictEqual([]);
});

test('large payroll batches aggregate journal lines and enforce total monetary caps before accepting an unpostable calculation',()=>{
  const w=world({orderCount:100,startingCashMinor:100_000_000}),run=calculate(w);execute(w,run);expect(w.journals.find(journal=>journal.source_id===w.payrollRuns[0].accrual_operation_id).lines.length).toBe(5);act(w,{type:'advance_time',hours:1});expect(w.payslips.length).toBe(100);balanced(w);
  const huge=world(),before=huge.payrollRuns.length;expect(()=>custom(huge,'huge-worker',1_000_000_000,40000,0,10000)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='invalid_integer');expect(huge.payrollRuns.length).toBe(before);expect(huge.operations.length).toBe(0);
  for(const payrollControls of [{employeeWithholdingBps:10000},{employerTaxBps:10001},{missingTime:'yes'},{unknown:true}])expect(()=>createWorld({kind:'payroll-close',payrollControls:payrollControls as any})).toThrow(DomainError);expect(()=>createWorld({kind:'payroll-close',orderCount:101})).toThrow(DomainError);expect(()=>createWorld({kind:'treasury',payrollControls:{}})).toThrow(DomainError);
});

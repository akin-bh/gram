import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createWorld,applyAction,DomainError,normalizeWorld,recordsFor,summarize,actionRequirements} from './world.ts';
import type {Action,Actor,World} from './world.ts';

const operator:Actor={id:'payroll-worker',role:'agent'},controller:Actor={id:'payroll-controller',role:'controller'};
const act=(w:World,action:Action,actor=controller)=>applyAction(w,action,actor).result;
const world=(extra:any={})=>createWorld({kind:'payroll-close',orderCount:1,payrollControls:{missingTime:false,disabledRoute:false},...extra});
const calculate=(w:World,extra:any={})=>act(w,{type:'calculate_payroll',policy_id:w.payrollPolicies[0].id,time_record_ids:w.payrollTimeRecords.map((row:any)=>row.id),...extra},operator).payroll_run;
const execute=(w:World,run:any)=>{const requested=act(w,{type:'execute_payroll',payroll_run_id:run.id},operator);return act(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'});};
const remit=(w:World,run:any)=>{const requested=act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},operator);return act(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'});};
function reject(w:World,action:Action,code:string,actor=operator){const before=structuredClone(w);assert.throws(()=>act(w,action,actor),(error:any)=>error instanceof DomainError&&error.code===code);assert.deepEqual(w,before);}
function balanced(w:World){
  for(const journal of w.journals)assert.equal(journal.lines.reduce((sum:number,line:any)=>sum+line.debit_minor-line.credit_minor,0),0);
  assert.equal(w.accounts.reduce((sum,account)=>sum+account.balance_minor,0),0);
  const effective=(id:string)=>w.accounts.find(account=>account.id===id).balance_minor+w.operations.filter(operation=>operation.status==='settled'&&!operation.journal_id).flatMap(operation=>operation.journal_lines??[]).filter(line=>line.account_id===id).reduce((sum,line)=>sum+(line.debit_minor??0)-(line.credit_minor??0),0);
  const accrued=w.payrollRuns.filter((run:any)=>['pending','paid'].includes(run.status));
  assert.equal(effective('payroll-expense'),accrued.reduce((sum:number,run:any)=>sum+run.gross_minor,0));
  assert.equal(effective('employer-payroll-tax-expense'),accrued.reduce((sum:number,run:any)=>sum+run.employer_tax_minor,0));
  assert.equal(effective('wages-payable'),0-accrued.reduce((sum:number,run:any)=>sum+run.net_minor-run.amount_paid_minor,0));
  const paidTax=w.payrollTaxRemittances.filter((row:any)=>row.status==='settled');
  assert.equal(effective('employee-withholding-payable'),paidTax.reduce((sum:number,row:any)=>sum+row.employee_withholding_minor,0)-accrued.reduce((sum:number,run:any)=>sum+run.employee_withholding_minor,0));
  assert.equal(effective('employer-payroll-tax-payable'),paidTax.reduce((sum:number,row:any)=>sum+row.employer_tax_minor,0)-accrued.reduce((sum:number,run:any)=>sum+run.employer_tax_minor,0));
}
function custom(w:World,id:string,rate:number,minutes:number,withheld=2000,employer=765){
  act(w,{type:'record_employee',employee_id:id,display_name:`Synthetic ${id}`,hourly_rate_minor:rate,external_event_id:`employee:${id}`});
  const policy=act(w,{type:'record_payroll_policy',name:`Test simulation ${id}`,employee_withholding_bps:withheld,employer_tax_bps:employer,external_event_id:`policy:${id}`}).policy;
  const time=act(w,{type:'record_payroll_time',employee_id:id,period_start:'2026-09-01',period_end:'2026-09-15',minutes,external_event_id:`time:${id}`}).time_record;
  return act(w,{type:'calculate_payroll',policy_id:policy.id,time_record_ids:[time.id],employee_ids:[id]},operator).payroll_run;
}

test('payroll scenario records deterministic employment and explicit simulation policy with honest source blockers',()=>{
  const w=createWorld({kind:'payroll-close',seed:'payroll'});assert.deepEqual(w,createWorld({kind:'payroll-close',seed:'payroll'}));assert.equal(w.employees.length,3);assert.equal(w.payrollTimeRecords.length,2);assert.deepEqual(w.payrollSources.missing_time_employee_ids,['employee-3']);assert.deepEqual(w.payrollSources.disabled_route_employee_ids,['employee-2']);assert.equal(w.invoices.length,0);assert.equal(w.bills.length,0);assert.equal(w.payrollRuns.length,0);
  assert.match(w.documents.find(doc=>doc.type==='payroll-close-brief').body,/not statutory tax rates/);assert.match(w.documents.find(doc=>doc.type==='payroll-close-brief').body,/employee-3/);
  reject(w,{type:'calculate_payroll',policy_id:w.payrollPolicies[0].id,time_record_ids:w.payrollTimeRecords.map((row:any)=>row.id)},'missing_payroll_time');
  act(w,{type:'record_payroll_time',employee_id:'employee-3',period_start:'2026-10-01',period_end:'2026-10-15',minutes:4800,external_event_id:'missing-time-source'});const run=calculate(w);
  reject(w,{type:'execute_payroll',payroll_run_id:run.id},'payroll_route_disabled');assert.equal(w.approvals.length,0);
  act(w,{type:'set_employee_route',employee_id:'employee-2',enabled:true,reason:'Controller verified existing synthetic route',external_event_id:'verified-route'});assert.equal(execute(w,run).operation.status,'pending');balanced(w);
  for(const feed of ['employee','payroll-policy','payroll-time','payroll-run','payroll-tax-remittance','payslip'])assert.deepEqual(recordsFor(w,'gusto',feed),recordsFor(w,'ledger',feed));
});

test('gross and taxes use independent exact half-up rounding; calculations do not post or pay',()=>{
  const w=world(),before=w.journals.length,run=custom(w,'rounding-worker',101,90,2500,5000);
  // 101*90/60 = 151.5 -> 152; withholding38; employer76; net114.
  assert.equal(run.gross_minor,152);assert.equal(run.employee_withholding_minor,38);assert.equal(run.employer_tax_minor,76);assert.equal(run.net_minor,114);assert.equal(run.tax_total_minor,114);
  assert.equal(w.journals.length,before);assert.equal(w.operations.length,0);assert.equal(w.payslips.length,0);assert.equal(run.policy.rounding,'half-up to integer USD cents per employee');
  const duplicate=act(w,{type:'calculate_payroll',policy_id:run.policy_id,time_record_ids:run.time_record_ids,employee_ids:run.employee_ids},operator);assert.equal(duplicate.replayed,true);assert.equal(duplicate.payroll_run.id,run.id);assert.equal(w.payrollRuns.length,1);balanced(w);
});

test('independent approval accrues exact liabilities, wages settle once, and separate approved taxes discharge only tax balances',()=>{
  const w=world({approvalThresholdMinor:1e12}),run=custom(w,'exact-worker',2500,4800),cash=summarize(w).cash_minor;
  assert.equal(run.gross_minor,200000);assert.equal(run.net_minor,160000);assert.equal(run.employee_withholding_minor,40000);assert.equal(run.employer_tax_minor,15300);
  const request=act(w,{type:'execute_payroll',payroll_run_id:run.id},operator);assert.equal(request.status,'awaiting_approval');assert.equal(summarize(w).reserved_minor,0);
  reject(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'separate_controller_required',{id:operator.id,role:'controller'});
  const accepted=act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'});assert.equal(accepted.operation.amount_minor,160000);assert.equal(summarize(w).reserved_minor,160000);assert.equal(summarize(w).wages_payable_minor,160000);assert.equal(summarize(w).payroll_taxes_payable_minor,55300);assert.equal(w.payslips.length,0);balanced(w);
  reject(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},'payroll_not_paid');act(w,{type:'advance_time',hours:1});assert.equal(summarize(w).cash_minor,cash-160000);assert.equal(summarize(w).wages_payable_minor,0);assert.equal(summarize(w).payroll_taxes_payable_minor,55300);assert.equal(w.payslips.length,1);balanced(w);
  const slip=w.payslips[0];assert.equal(slip.net_minor,160000);assert.ok(w.messages.some(message=>message.source_refs.includes(slip.id)&&message.source_refs.includes(slip.receipt_id)));assert.equal(act(w,{type:'execute_payroll',payroll_run_id:run.id},operator).replayed,true);
  const taxRequest=act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},operator);assert.equal(taxRequest.status,'awaiting_approval');reject(w,{type:'decide_approval',approval_id:taxRequest.approval_id,decision:'approve'},'separate_controller_required',{id:operator.id,role:'controller'});
  const tax=act(w,{type:'decide_approval',approval_id:taxRequest.approval_id,decision:'approve'});assert.equal(tax.operation.amount_minor,55300);assert.equal(summarize(w).reserved_minor,55300);assert.equal(act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},operator).operation.id,tax.operation.id);
  act(w,{type:'advance_time',hours:1});assert.equal(summarize(w).cash_minor,cash-215300);assert.equal(summarize(w).payroll_taxes_payable_minor,0);assert.equal(summarize(w).reserved_minor,0);balanced(w);
  const bank=structuredClone(w.bankTransactions),journals=structuredClone(w.journals);act(w,{type:'advance_time',hours:24});assert.deepEqual(w.bankTransactions,bank);assert.deepEqual(w.journals,journals);assert.equal(w.payslips.length,1);reject(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},'no_payroll_taxes_due');
});

test('rejected and cancelled unexecuted runs preserve evidence but release period claims, and cannot later execute',()=>{
  const w=world(),run=calculate(w),request=act(w,{type:'execute_payroll',payroll_run_id:run.id},operator);
  act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'reject'});assert.equal(summarize(w).reserved_minor,0);assert.equal(w.operations.length,0);const replacement=calculate(w);assert.notEqual(replacement.id,run.id);reject(w,{type:'execute_payroll',payroll_run_id:run.id},'payroll_rejected');
  reject(w,{type:'cancel_payroll',payroll_run_id:replacement.id,reason:'Agent cannot release controls',external_event_id:'agent-cancel'},'controller_required');
  act(w,{type:'set_employee_route',employee_id:w.employees[0].id,enabled:false,reason:'Verification pending',external_event_id:'disable-before-cancel'});act(w,{type:'cancel_payroll',payroll_run_id:replacement.id,reason:'Recalculate under corrected policy',external_event_id:'controller-cancel'});const third=calculate(w);assert.notEqual(third.id,replacement.id);assert.ok(w.documents.some(doc=>doc.payroll_run_id===replacement.id&&doc.type==='payroll-cancellation'));
  act(w,{type:'set_employee_route',employee_id:w.employees[0].id,enabled:true,reason:'Verified route',external_event_id:'enable-after-cancel'});execute(w,third);reject(w,{type:'cancel_payroll',payroll_run_id:third.id,reason:'Too late',external_event_id:'cancel-accepted'},'payroll_cannot_cancel',controller);balanced(w);
});

test('source authority and calendar guards prohibit duplicate time, future periods, fabricated rates and zero net pay',()=>{
  const w=world(),employee=w.employees[0],time=w.payrollTimeRecords[0];
  for(const type of ['record_employee','record_payroll_policy','record_payroll_time','set_employee_route','cancel_payroll'])assert.equal(actionRequirements[type].role,'controller');
  reject(w,{type:'record_employee',employee_id:'forged-worker',display_name:'Not verified',hourly_rate_minor:10,external_event_id:'forged-employment'},'controller_required');
  reject(w,{type:'record_employee',employee_id:employee.id,display_name:'Duplicate',hourly_rate_minor:10,external_event_id:'duplicate-employee'},'employee_exists',controller);
  for(const [period_start,period_end] of [['2026-02-30','2026-03-01'],['2026-11-01','2026-11-15'],['2026-09-10','2026-09-01'],['2026-08-01','2026-09-30'],['2026-10-24','2026-10-24']])reject(w,{type:'record_payroll_time',employee_id:employee.id,period_start,period_end,minutes:60,external_event_id:`invalid-date:${period_start}`},'invalid_payroll_period',controller);
  reject(w,{type:'record_payroll_time',employee_id:employee.id,period_start:time.period_start,period_end:time.period_end,minutes:60,external_event_id:'duplicate-period'},'payroll_time_overlap',controller);
  reject(w,{type:'record_payroll_time',employee_id:employee.id,period_start:'2026-09-01',period_end:'2026-09-01',minutes:1441,external_event_id:'too-many-minutes'},'invalid_integer',controller);
  const policy=w.payrollPolicies[0],baseline=calculate(w);assert.equal(baseline.lines[0].hourly_rate_minor,employee.hourly_rate_minor);assert.equal(baseline.policy.employee_withholding_bps,policy.employee_withholding_bps);
  const zero=world();assert.throws(()=>custom(zero,'zero-net-worker',1,60,9999,0),(error:any)=>error instanceof DomainError&&error.code==='zero_net_payroll');
});

test('provider outages and disabled routes hold the immutable wage batch without sending premature payslips',()=>{
  const w=world(),run=calculate(w),accepted=execute(w,run),cash=summarize(w).cash_minor;
  act(w,{type:'set_fault',system:'gusto',mode:'offline'});const blocked=act(w,{type:'advance_time',hours:1});assert.equal(blocked.blocked[0].reason,'gusto:offline');assert.equal(w.payslips.length,0);assert.equal(summarize(w).cash_minor,cash);assert.equal(summarize(w).reserved_minor,run.net_minor);
  act(w,{type:'set_fault',system:'gusto',mode:'healthy'});act(w,{type:'set_employee_route',employee_id:run.employee_ids[0],enabled:false,reason:'Verification temporarily suspended',external_event_id:'route-held'});assert.equal(act(w,{type:'advance_time',hours:1}).blocked[0].reason,'payroll_route_disabled');
  act(w,{type:'set_employee_route',employee_id:run.employee_ids[0],enabled:true,reason:'Same route verified',external_event_id:'route-restored'});act(w,{type:'set_fault',system:'bank',mode:'rate_limit'});assert.equal(act(w,{type:'advance_time',hours:1}).blocked[0].reason,'bank:rate_limit');
  act(w,{type:'set_fault',system:'bank',mode:'healthy'});act(w,{type:'set_fault',system:'gmail',mode:'offline'});act(w,{type:'advance_time',hours:1});assert.equal(w.operations.find(operation=>operation.id===accepted.operation.id).status,'settled');assert.equal(w.payslips.length,1);assert.ok(w.messages.some(message=>message.source_refs.includes(w.payslips[0].id)&&message.delivery_status==='queued'));
  act(w,{type:'set_fault',system:'gmail',mode:'healthy'});act(w,{type:'advance_time',hours:1});assert.ok(w.messages.filter(message=>message.source_refs.includes(w.payslips[0].id)).every(message=>message.delivery_status==='delivered'));balanced(w);
});

test('payroll accrual, wage settlement and tax remittance remain separate facts while all journals defer and recover exactly once',()=>{
  const w=world({payrollControls:{missingTime:false,disabledRoute:false,periodClosed:true}}),run=calculate(w),cash=summarize(w).cash_minor;
  execute(w,run);assert.equal(w.settledUnposted.length,1);act(w,{type:'advance_time',hours:1});assert.equal(w.settledUnposted.length,2);assert.equal(summarize(w).cash_minor,cash-run.net_minor);assert.equal(w.accounts.find(account=>account.id==='wages-payable').balance_minor,0);assert.equal(summarize(w).payroll_taxes_payable_minor,run.tax_total_minor);balanced(w);
  remit(w,run);act(w,{type:'advance_time',hours:1});assert.equal(w.settledUnposted.length,3);assert.equal(summarize(w).cash_minor,cash-run.gross_minor-run.employer_tax_minor);assert.equal(summarize(w).payroll_taxes_payable_minor,0);balanced(w);
  act(w,{type:'set_fault',system:'netsuite',mode:'offline'});act(w,{type:'reopen_period'});assert.equal(w.settledUnposted.length,3);act(w,{type:'set_fault',system:'netsuite',mode:'healthy'});act(w,{type:'set_fault',system:'ledger',mode:'offline'});act(w,{type:'advance_time',hours:1});assert.equal(w.settledUnposted.length,3);
  const bank=structuredClone(w.bankTransactions);act(w,{type:'set_fault',system:'ledger',mode:'healthy'});act(w,{type:'advance_time',hours:1});assert.equal(w.settledUnposted.length,0);assert.equal(summarize(w).reconciliation.bank_ledger_difference_minor,0);assert.deepEqual(w.bankTransactions,bank);balanced(w);
});

test('tax rejection releases only its unexecuted remittance and never permits another employee wage payment',()=>{
  const w=world(),run=calculate(w);execute(w,run);act(w,{type:'advance_time',hours:1});const first=act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},operator);
  act(w,{type:'decide_approval',approval_id:first.approval_id,decision:'reject'});assert.equal(w.payrollRuns[0].status,'paid');assert.equal(w.payrollTaxRemittances[0].status,'rejected');assert.equal(summarize(w).reserved_minor,0);
  const replacement=remit(w,run);assert.notEqual(replacement.tax_remittance.id,first.tax_remittance.id);assert.equal(summarize(w).reserved_minor,run.tax_total_minor);act(w,{type:'advance_time',hours:1});assert.equal(w.payrollTaxRemittances.filter((row:any)=>row.status==='settled').length,1);assert.equal(w.payslips.length,1);balanced(w);
});

test('controller fact replay preserves source IDs, while migration adds only empty payroll collections and zero balances',()=>{
  const w=world(),action={type:'record_employee',employee_id:'replay-worker',display_name:'Synthetic replay',hourly_rate_minor:2700,external_event_id:'employee-replay'},first=act(w,action),docCount=w.documents.length;
  assert.equal(act(w,action).replayed,true);assert.equal(w.documents.length,docCount);assert.equal(w.employees.filter((employee:any)=>employee.id===first.employee.id).length,1);reject(w,{...action,hourly_rate_minor:2800},'external_event_conflict',controller);
  for(const account of ['wages-payable','employee-withholding-payable','employer-payroll-tax-payable'])reject(w,{type:'post_journal',lines:[{account_id:account,debit_minor:1},{account_id:'equity',credit_minor:1}]},'control_account_locked');
  const old=createWorld({orderCount:1}),ids=['payroll-expense','employer-payroll-tax-expense','wages-payable','employee-withholding-payable','employer-payroll-tax-payable'];old.accounts=old.accounts.filter(account=>!ids.includes(account.id));for(const key of ['employees','payrollPolicies','payrollTimeRecords','payrollRuns','payrollTaxRemittances','payslips'])delete old[key];const bank=structuredClone(old.bankTransactions),journals=structuredClone(old.journals),accounts=structuredClone(old.accounts);normalizeWorld(old);assert.deepEqual(old.bankTransactions,bank);assert.deepEqual(old.journals,journals);assert.deepEqual(old.accounts.filter(account=>!ids.includes(account.id)),accounts);assert.ok(old.accounts.filter(account=>ids.includes(account.id)).every(account=>account.balance_minor===0));assert.deepEqual(recordsFor(old,'gusto','payroll-run'),[]);
});

test('large payroll batches aggregate journal lines and enforce total monetary caps before accepting an unpostable calculation',()=>{
  const w=world({orderCount:100,startingCashMinor:100_000_000}),run=calculate(w);execute(w,run);assert.equal(w.journals.find(journal=>journal.source_id===w.payrollRuns[0].accrual_operation_id).lines.length,5);act(w,{type:'advance_time',hours:1});assert.equal(w.payslips.length,100);balanced(w);
  const huge=world(),before=huge.payrollRuns.length;assert.throws(()=>custom(huge,'huge-worker',1_000_000_000,40000,0,10000),(error:any)=>error instanceof DomainError&&error.code==='invalid_integer');assert.equal(huge.payrollRuns.length,before);assert.equal(huge.operations.length,0);
  for(const payrollControls of [{employeeWithholdingBps:10000},{employerTaxBps:10001},{missingTime:'yes'},{unknown:true}])assert.throws(()=>createWorld({kind:'payroll-close',payrollControls:payrollControls as any}),DomainError);assert.throws(()=>createWorld({kind:'payroll-close',orderCount:101}),DomainError);assert.throws(()=>createWorld({kind:'treasury',payrollControls:{}}),DomainError);
});

import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError,summarize} from './world.ts';
import type {Action,Actor,World} from './world.ts';

const worker:Actor={id:'payroll-review-worker',role:'agent'};
const controller:Actor={id:'payroll-review-controller',role:'controller'};
const act=(w:World,input:Action,actor:Actor=controller)=>applyAction(w,input,actor).result;
const payroll=(controls:any={},count=3)=>createWorld({kind:'payroll-close',orderCount:count,seed:'payroll-review',initialCashMinor:900_000_000,approvalThresholdMinor:1_000_000_000,payrollControls:{missingTime:false,disabledRoute:false,...controls}});
function rejects(w:World,input:Action,code:string,actor:Actor=worker){
  const before=structuredClone(w);
  expect(()=>act(w,input,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);
  expect(w,'A rejected action must leave its source records, accounting and IDs unchanged').toStrictEqual(before);
}
function calculate(w:World,policy=w.payrollPolicies[0],sources=w.payrollTimeRecords,employeeIds?:string[]){
  return act(w,{type:'calculate_payroll',policy_id:policy.id,time_record_ids:sources.map((source:any)=>source.id),...(employeeIds?{employee_ids:employeeIds}:{})},worker).payroll_run;
}
function approve(w:World,request:any){return act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'});}
function execute(w:World,run:any){return approve(w,act(w,{type:'execute_payroll',payroll_run_id:run.id},worker));}
function policy(w:World,employee=0,employer=0,suffix='review'){
  return act(w,{type:'record_payroll_policy',name:'Explicit review policy',employee_withholding_bps:employee,employer_tax_bps:employer,external_event_id:`policy-${suffix}`}).policy;
}
function employeeTime(w:World,rate:number,suffix='review',minutes=60,start='2026-10-01',end='2026-10-14'){
  const employee=act(w,{type:'record_employee',employee_id:`review-${suffix}`,display_name:`Review ${suffix}`,hourly_rate_minor:rate,external_event_id:`employee-${suffix}`}).employee;
  const time=act(w,{type:'record_payroll_time',employee_id:employee.id,period_start:start,period_end:end,minutes,external_event_id:`time-${suffix}`}).time_record;
  return {employee,time};
}
function controlBalances(w:World){
  const effective=(id:string)=>w.accounts.find(account=>account.id===id).balance_minor+w.operations.filter(operation=>operation.status==='settled'&&!operation.journal_id).flatMap(operation=>operation.journal_lines||[]).filter(line=>line.account_id===id).reduce((sum,line)=>sum+(line.debit_minor||0)-(line.credit_minor||0),0);
  const accrued=w.payrollRuns.filter((run:any)=>run.accrual_operation_id);
  expect(effective('wages-payable')).toBe(0-accrued.reduce((sum:number,run:any)=>sum+run.net_minor-run.amount_paid_minor,0));
  expect(effective('employee-withholding-payable')+effective('employer-payroll-tax-payable')).toBe(0-accrued.reduce((sum:number,run:any)=>sum+run.tax_total_minor-run.tax_paid_minor,0));
  for(const journal of w.journals){
    expect(journal.lines.length<=100).toBeTruthy();
    expect(journal.lines.reduce((sum:number,line:any)=>sum+line.debit_minor-line.credit_minor,0)).toBe(0);
    for(const line of journal.lines)expect((line.debit_minor>0)!==(line.credit_minor>0),'Zero and double-sided lines are invalid').toBeTruthy();
  }
  expect(summarize(w).reconciliation.balanced).toBe(true);
}

test('implicit employee selection requires missing time; explicit subsets reject extra source employees',()=>{
  const w=payroll({missingTime:true}),source=w.payrollTimeRecords[0];
  expect(w.payrollTimeRecords.length<w.employees.length).toBeTruthy();
  rejects(w,{type:'calculate_payroll',policy_id:w.payrollPolicies[0].id,time_record_ids:w.payrollTimeRecords.map((row:any)=>row.id)},'missing_payroll_time');
  rejects(w,{type:'calculate_payroll',policy_id:w.payrollPolicies[0].id,time_record_ids:w.payrollTimeRecords.map((row:any)=>row.id),employee_ids:[source.employee_id]},'missing_payroll_time');
  const run=calculate(w,w.payrollPolicies[0],[source],[source.employee_id]);
  expect(run.employee_ids).toStrictEqual([source.employee_id]);expect(run.time_record_ids).toStrictEqual([source.id]);expect(run.lines.length).toBe(1);
  expect(run.lines[0].source_document_ids).toStrictEqual([source.document_id,source.employee_document_id,w.payrollPolicies[0].document_id]);
  expect(w.operations.length).toBe(0);expect(w.payslips.length).toBe(0);
});

test('source periods cannot overlap; rejected runs release claims but can never execute again',()=>{
  const w=payroll({},1),source=w.payrollTimeRecords[0],run=calculate(w),otherPolicy=policy(w,1000,500,'other');
  rejects(w,{type:'record_payroll_time',employee_id:source.employee_id,period_start:source.period_end,period_end:source.period_end,minutes:1,external_event_id:'inclusive-overlap'},'payroll_time_overlap',controller);
  rejects(w,{type:'calculate_payroll',policy_id:otherPolicy.id,time_record_ids:[source.id]},'payroll_period_claimed');
  const pending=act(w,{type:'execute_payroll',payroll_run_id:run.id},worker);
  act(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'reject'});
  const replacement=calculate(w,otherPolicy,[source]);expect(replacement.id).not.toBe(run.id);
  rejects(w,{type:'execute_payroll',payroll_run_id:run.id},'payroll_rejected');
  rejects(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'approve'},'approval_already_decided',controller);
  execute(w,replacement);act(w,{type:'advance_time',hours:1});
  expect(w.payslips.length).toBe(1);expect(w.payslips[0].payroll_run_id).toBe(replacement.id);controlBalances(w);
});

for(const [withholding,employer] of [[0,0],[0,765],[2000,0]])test(`zero-component tax policy ${withholding}/${employer} posts only nonzero balanced lines`,()=>{
  const w=payroll({employeeWithholdingBps:withholding,employerTaxBps:employer},2),opening=summarize(w).cash_minor,run=calculate(w),accepted=execute(w,run);
  const accrual=w.journals.find(journal=>journal.source_id===accepted.accrual_operation.id);
  expect(accrual).toBeTruthy();expect(accrual.lines.length).toBe(2+Number(withholding>0)+2*Number(employer>0));
  act(w,{type:'advance_time',hours:1});
  if(!withholding&&!employer)rejects(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},'no_payroll_taxes_due');
  else{
    const remittance=approve(w,act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},worker));
    act(w,{type:'advance_time',hours:1});
    expect(w.journals.find(journal=>journal.source_id===remittance.operation.id).lines.length).toBe(2);
  }
  expect(summarize(w).cash_minor).toBe(opening-run.gross_minor-run.employer_tax_minor);controlBalances(w);
});

test('payroll rounds per employee using exact half-up arithmetic and rejects a zero net wage atomically',()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:1}),source=employeeTime(w,31,'rounded',30),p=policy(w,2500,3333);
  const run=calculate(w,p,[source.time]);
  expect(run.gross_minor).toBe(16);expect(run.employee_withholding_minor).toBe(4);expect(run.net_minor).toBe(12);expect(run.employer_tax_minor).toBe(5);expect(run.tax_total_minor).toBe(9);
  execute(w,run);act(w,{type:'advance_time',hours:1});controlBalances(w);
  const tiny=employeeTime(w,1,'zero-net',30),half=policy(w,5000,0,'half');
  rejects(w,{type:'calculate_payroll',policy_id:half.id,time_record_ids:[tiny.time.id],employee_ids:[tiny.employee.id]},'zero_net_payroll');
});

test('maximum employee count aggregates accounting instead of exceeding the journal line limit',()=>{
  const w=payroll({},100),run=calculate(w),accepted=execute(w,run);
  expect(run.lines.length).toBe(100);expect(w.journals.find(journal=>journal.source_id===accepted.accrual_operation.id).lines.length).toBe(5);
  act(w,{type:'advance_time',hours:1});expect(w.payslips.length).toBe(100);controlBalances(w);
});

for(const family of ['supplier-fraud','ticket-cancellation'])test(`pending payroll shares cash reservations with ${family==='supplier-fraud'?'supplier payments':'refunds'} in both directions`,()=>{
  const w=createWorld({kind:family,orderCount:2,initialCashMinor:100_000,approvalThresholdMinor:1_000_000_000}),cash=summarize(w).cash_minor;
  const source=employeeTime(w,cash-100,'reserve'),p=policy(w),run=calculate(w,p,[source.time]);
  const outgoing=family==='supplier-fraud'?{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:101}:{type:'refund',payment_id:w.payments.find(payment=>payment.status==='succeeded').id,amount_minor:101};
  const reverse=structuredClone(w);
  execute(w,run);expect(summarize(w).available_cash_minor).toBe(100);
  rejects(w,outgoing,'insufficient_funds');
  act(reverse,outgoing,worker);
  rejects(reverse,{type:'execute_payroll',payroll_run_id:run.id},'insufficient_funds');
  expect(summarize(reverse).reserved_minor).toBe(101);
  act(w,{type:'advance_time',hours:1});expect(summarize(w).cash_minor).toBe(100);expect(summarize(w).reserved_minor).toBe(0);controlBalances(w);
});

test('approved tax remittance reserves cash against supplier payments and cannot duplicate the liability',()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:2,initialCashMinor:10_000,approvalThresholdMinor:1_000_000_000}),source=employeeTime(w,9900,'tax-reserve'),p=policy(w,2000,0),run=calculate(w,p,[source.time]);
  execute(w,run);act(w,{type:'advance_time',hours:1});
  const tax=act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},worker);const approved=approve(w,tax);
  expect(summarize(w).reserved_minor).toBe(1980);expect(summarize(w).available_cash_minor).toBe(100);
  rejects(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:101},'insufficient_funds');
  const replay=act(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},worker);expect(replay.operation.id).toBe(approved.operation.id);expect(w.payrollTaxRemittances.length).toBe(1);
  act(w,{type:'advance_time',hours:1});expect(summarize(w).cash_minor).toBe(100);expect(summarize(w).reserved_minor).toBe(0);
  rejects(w,{type:'remit_payroll_taxes',payroll_run_id:run.id},'no_payroll_taxes_due');controlBalances(w);
});

test('route disabling after approval holds the immutable whole batch until original route recovery',()=>{
  const w=payroll({},2),opening=summarize(w).cash_minor,run=calculate(w),frozen=structuredClone(run.lines),approved=execute(w,run),employeeId=run.employee_ids[0];
  act(w,{type:'set_employee_route',employee_id:employeeId,enabled:false,reason:'Independent route verification hold',external_event_id:'route-disabled'});
  const blocked=act(w,{type:'advance_time',hours:2});
  expect(blocked.blocked.some((item:any)=>item.operation_id===approved.operation.id&&item.reason==='payroll_route_disabled')).toBeTruthy();
  expect(summarize(w).cash_minor).toBe(opening);expect(summarize(w).reserved_minor).toBe(run.net_minor);expect(w.payslips.length).toBe(0);
  expect(w.payrollRuns[0].lines).toStrictEqual(frozen);expect(w.operations.find(operation=>operation.id===approved.operation.id).recipient_routes).toStrictEqual(frozen.map((line:any)=>({employee_id:line.employee_id,verified_route_id:line.verified_route_id,amount_minor:line.net_minor})));
  act(w,{type:'set_employee_route',employee_id:employeeId,enabled:true,reason:'Original route verified',external_event_id:'route-restored'});
  act(w,{type:'advance_time',hours:1});act(w,{type:'advance_time',hours:1});
  expect(w.payslips.length).toBe(2);expect(w.bankTransactions.filter(transaction=>transaction.source_id===approved.operation.id).length).toBe(1);expect(summarize(w).cash_minor).toBe(opening-run.net_minor);controlBalances(w);
});

test('aggregate and employer-cost overflow reject calculation without consuming source claims',()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:1}),first=employeeTime(w,1_000_000_000,'large-one',43_200,'2026-09-01','2026-09-30'),second=employeeTime(w,1_000_000_000,'large-two',43_200,'2026-09-01','2026-09-30'),p=policy(w);
  rejects(w,{type:'calculate_payroll',policy_id:p.id,time_record_ids:[first.time.id,second.time.id]},'invalid_integer');
  const doubled=policy(w,0,10000,'large-tax');
  rejects(w,{type:'calculate_payroll',policy_id:doubled.id,time_record_ids:[first.time.id],employee_ids:[first.employee.id]},'invalid_integer');
  expect(w.payrollRuns.length).toBe(0);expect(w.operations.length).toBe(0);
  const valid=calculate(w,p,[first.time],[first.employee.id]);expect(valid.gross_minor).toBe(720_000_000_000);expect(valid.net_minor).toBe(valid.gross_minor);
});

test('payroll control accounts and invalid manual journals cannot bypass frozen obligations',()=>{
  const w=payroll({},1),run=calculate(w);execute(w,run);
  for(const account of ['wages-payable','employee-withholding-payable','employer-payroll-tax-payable'])rejects(w,{type:'post_journal',description:'Attempt to clear source liability',lines:[{account_id:account,debit_minor:1},{account_id:'expenses',credit_minor:1}]},'control_account_locked',controller);
  rejects(w,{type:'post_journal',description:'Malformed adjustment',lines:[{account_id:'expenses',debit_minor:10},{account_id:'revenue',credit_minor:9}]},'unbalanced_journal',controller);
  controlBalances(w);
});

test('controller cancellation releases an unexecuted calculation and preserves its immutable source history',()=>{
  const w=payroll({},1),run=calculate(w),frozen=structuredClone(run.lines),cancel={type:'cancel_payroll',payroll_run_id:run.id,reason:'Controller selected a replacement policy',external_event_id:'cancel-review-run'};
  rejects(w,cancel,'controller_required');
  const cancelled=act(w,cancel);expect(cancelled.payroll_run.status).toBe('rejected');expect(cancelled.payroll_run.lines).toStrictEqual(frozen);
  expect(w.documents.some(document=>document.id===cancelled.payroll_run.cancellation_document_id)).toBeTruthy();
  expect(act(w,cancel).replayed).toBe(true);expect(w.operations.length).toBe(0);
  const replacement=calculate(w);expect(replacement.id).not.toBe(run.id);
  rejects(w,{type:'execute_payroll',payroll_run_id:run.id},'payroll_rejected');
  execute(w,replacement);
  rejects(w,{...cancel,payroll_run_id:replacement.id,external_event_id:'cannot-cancel-accepted'},'payroll_cannot_cancel',controller);
  act(w,{type:'advance_time',hours:1});expect(w.payslips.length).toBe(1);controlBalances(w);
});

test('approval rechecks shared cash and atomically retains the pending decision when another payment uses it',()=>{
  const w=createWorld({kind:'supplier-fraud',orderCount:2,initialCashMinor:10_000,approvalThresholdMinor:1_000_000_000}),source=employeeTime(w,9900,'approval-cash'),p=policy(w),run=calculate(w,p,[source.time]);
  const request=act(w,{type:'execute_payroll',payroll_run_id:run.id},worker);
  expect(summarize(w).reserved_minor).toBe(0);
  act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:101},worker);
  rejects(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'insufficient_funds',controller);
  expect(w.approvals.find(approval=>approval.id===request.approval_id).status).toBe('pending');
  expect(w.payrollRuns[0].status).toBe('awaiting_approval');expect(w.payrollRuns[0].accrual_operation_id).toBeUndefined();
  expect(w.operations.filter(operation=>operation.type==='execute_payroll'||operation.type==='payroll_accrued').length).toBe(0);expect(w.payslips.length).toBe(0);
  act(w,{type:'cancel_payroll',payroll_run_id:run.id,reason:'Defer payroll until funded',external_event_id:'cancel-underfunded-review'});
  expect(w.approvals.find(approval=>approval.id===request.approval_id).status).toBe('rejected');
  rejects(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'approval_already_decided',controller);
  controlBalances(w);
});

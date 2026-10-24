import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {AgentError,scenarioSchema,validateGeneratedScenario} from './agent.ts';
import {applyAction,createWorld,summarize} from './world.ts';

type Scenario=z.infer<typeof scenarioSchema>;
const scenario=(patch:Record<string,unknown>={}):any=>({kind:'ticket-cancellation',name:'Validation',description:'Synthetic source-backed financial records.',seed:1,orderCount:4,currency:'USD',cancelEvent:false,initialFaults:[],limitations:[],...patch});
function rejected(value:unknown,phase:'schema'|'domain',domainCode?:string){
  const before=structuredClone(value);
  assert.throws(()=>validateGeneratedScenario(value),(error:unknown)=>{
    assert.ok(error instanceof AgentError);assert.equal(error.code,'invalid_generated_scenario');assert.equal(error.status,502);
    const details=error.details as any;assert.equal(details.phase,phase);
    if(phase==='schema'){assert.ok(Array.isArray(details.issues)&&details.issues.length>0);assert.ok(details.issues.every((issue:any)=>typeof issue.code==='string'&&Array.isArray(issue.path)));}
    else{assert.equal(details.code,domainCode);assert.equal(typeof details.message,'string');assert.ok(details.message.length>0);}
    return true;
  });
  assert.deepEqual(value,before,'Invalid generated output must remain available unchanged for diagnosis');
}

test('generation validation rejects payroll counts the domain cannot create and retains the supported upper bound',()=>{
  for(const orderCount of [101,200])rejected(scenario({kind:'payroll-close',orderCount}),'domain','invalid_integer');
  const result=validateGeneratedScenario(scenario({kind:'payroll-close',orderCount:100,payrollControls:{missingTime:false,disabledRoute:false}}));
  const world=createWorld(result);assert.equal(world.employees.length,100);assert.equal(world.payrollTimeRecords.length,100);assert.equal(summarize(world).reconciliation.balanced,true);
});

test('generation validation rejects controls belonging to a different scenario family',()=>{
  const controls={exceptionControls:{creditNotePercent:10},procurementControls:{duplicateInvoice:true},payrollControls:{missingTime:true},reconciliationControls:{omitStatementLine:true}};
  const owners={exceptionControls:'settlement-exceptions',procurementControls:'procurement-matching',payrollControls:'payroll-close',reconciliationControls:'bank-reconciliation'};
  for(const [field,value] of Object.entries(controls)){
    rejected(scenario({[field]:value}),'domain','invalid_scenario');
    rejected(scenario({[field]:{}}),'domain','invalid_scenario');
    for(const kind of Object.values(owners).filter(kind=>kind!==owners[field as keyof typeof owners]))rejected(scenario({kind,[field]:value}),'domain','invalid_scenario');
  }
});

test('generation validation rejects a resolved or evidenced dispute when no dispute is generated',()=>{
  for(const disputeStatus of ['won','lost','evidence_submitted'])rejected(scenario({kind:'settlement-exceptions',exceptionControls:{disputePercent:0,disputeStatus}}),'domain','invalid_scenario');
  const noDispute=validateGeneratedScenario(scenario({kind:'settlement-exceptions',exceptionControls:{disputePercent:0,disputeStatus:'open'}}));
  assert.equal(createWorld(noDispute).disputes.length,0);
});

test('generation validation rejects duplicate fault providers instead of selecting a silent winner',()=>{
  for(const mode of ['offline','expired'])rejected(scenario({initialFaults:[{system:'bank',mode:'offline'},{system:'bank',mode}]}),'domain','invalid_fault');
  const value=validateGeneratedScenario(scenario({initialFaults:[{system:'bank',mode:'offline'},{system:'gusto',mode:'expired'}]}));
  const world=createWorld(value);assert.equal(world.faults.bank.mode,'offline');assert.equal(world.faults.gusto.mode,'expired');
});

test('generation validation rejects empty optional narrative rather than returning an uncreatable draft',()=>{
  for(const narrative of ['', ' ', '\n\t'])rejected(scenario({narrative}),'domain','invalid_text');
  const without=validateGeneratedScenario(scenario());assert.equal('narrative' in without,false);
  const withContext=validateGeneratedScenario(scenario({narrative:'The controller reviews source documents before approving payments.'}));
  assert.match(createWorld(withContext).documents.find((document:any)=>document.id==='scenario-context').body,/controller reviews/);
});

test('generation validation rejects whitespace-only required name, description and limitation text',()=>{
  for(const patch of [{name:'   '},{description:'\n\t'},{limitations:[' ']}])rejected(scenario(patch),'domain','invalid_text');
});

test('schema failures retain the same public error contract and actionable issue metadata',()=>{
  for(const value of [null,[],{},scenario({currency:'BTC'}),scenario({kind:'not-a-family'}),scenario({orderCount:1.5}),scenario({startingCashMinor:-1}),scenario({controller:true}),scenario({payrollControls:{taxJurisdiction:'unimplemented'}}),scenario({kind:'bank-reconciliation',reconciliationControls:{omitStatementLine:'yes'}}),scenario({kind:'bank-reconciliation',reconciliationControls:{deferredPosting:1}}),scenario({kind:'bank-reconciliation',reconciliationControls:{autoClose:true}})])rejected(value,'schema');
});

test('54 extreme valid configurations materialize across all nine families without losing source controls or balance',()=>{
  const kinds:Scenario['kind'][]=['ticket-cancellation','saas-collections','supplier-fraud','period-close','treasury','settlement-exceptions','procurement-matching','payroll-close','bank-reconciliation'];
  let checked=0;
  for(const kind of kinds)for(const seed of [1,42,2147483647])for(const startingCashMinor of [0,100000000000]){
    const controls=kind==='payroll-close'?{payrollControls:{missingTime:false,disabledRoute:false,employeeWithholdingBps:9999,employerTaxBps:10000}}:kind==='settlement-exceptions'?{exceptionControls:{creditNotePercent:100,disputePercent:100,disputeStatus:'lost',returnedPaymentPercent:100}}:kind==='procurement-matching'?{procurementControls:{partialReceiptPercent:0,priceVariancePercent:100,duplicateInvoice:true,periodClosed:true}}:kind==='bank-reconciliation'?{reconciliationControls:{omitStatementLine:seed===42,deferredPosting:startingCashMinor===0}}:{};
    const input=scenario({kind,seed,startingCashMinor,cancelEvent:kind==='ticket-cancellation',...controls}),before=structuredClone(input);
    const validated=validateGeneratedScenario(input),world=createWorld(validated,`validated-${kind}-${seed}-${startingCashMinor}`);
    assert.deepEqual(input,before);assert.deepEqual(validated,input);assert.equal(world.kind,kind);assert.equal(world.seed,seed);assert.equal(world.bankTransactions[0].amount_minor,startingCashMinor);
    const summary=summarize(world);assert.equal(summary.reconciliation.balanced,true);assert.equal(summary.reconciliation.bank_ledger_difference_minor,0);
    for(const journal of world.journals)assert.equal(journal.lines.reduce((total:number,line:any)=>total+line.debit_minor-line.credit_minor,0),0);
    if(kind==='payroll-close'){
      assert.equal(world.employees.length,4);assert.equal(world.payrollTimeRecords.length,4);assert.ok(world.employees.every((employee:any)=>employee.route_enabled));
      const run=applyAction(world,{type:'calculate_payroll',policy_id:world.payrollPolicies[0].id,time_record_ids:world.payrollTimeRecords.map((record:any)=>record.id)},{id:'offline-scenario-validator',role:'agent'}).result.payroll_run;
      assert.equal(run.lines.length,4);assert.equal(run.gross_minor,run.net_minor+run.employee_withholding_minor);assert.equal(run.employer_tax_minor,run.gross_minor);assert.ok(run.lines.every((line:any)=>line.net_minor>0));
    }else if(kind==='procurement-matching'){
      assert.equal(world.purchaseOrders.length,4);assert.equal(world.goodsReceipts.length,2);assert.equal(world.supplierInvoiceDeliveries.filter((delivery:any)=>delivery.duplicate).length,1);assert.equal(world.periodClosed,true);assert.ok(world.settledUnposted.length>0);
    }else if(kind==='settlement-exceptions'){
      assert.equal(world.disputes[0].status,'lost');assert.equal(world.paymentReturns.length,1);assert.equal(world.paymentReturns[0].amount_minor,world.bills[0].amount_minor);
    }else if(kind==='bank-reconciliation'){
      const omitted=seed===42,deferred=startingCashMinor===0,statement=world.bankStatements[0];
      assert.equal(world.invoices.length,4);assert.equal(world.operations.length,4);assert.ok(world.operations.every((operation:any)=>operation.status==='settled'&&operation.journal_id));
      assert.equal(world.bankStatements.length,1);assert.equal(statement.status,'open');assert.equal(statement.lines.length,omitted?2:3);assert.equal(world.reconciliationSources.omitted_bank_transaction_ids.length,omitted?1:0);assert.equal(world.reconciliationSources.late_posted_operation_ids.length,deferred?4:0);
      const receiptJournals=world.operations.map((operation:any)=>world.journals.find((journal:any)=>journal.id===operation.journal_id));assert.ok(receiptJournals.every((journal:any)=>deferred?journal.posted_at>statement.end_at:journal.posted_at<=statement.end_at));
      assert.equal(statement.closing_balance_minor,statement.opening_balance_minor+statement.lines.reduce((sum:number,line:any)=>sum+line.amount_minor,0));
      assert.equal(statement.closing_balance_minor<summary.cash_minor,omitted);assert.equal(world.reconciliationMatches.length,0);assert.equal(world.reconciliationReports.length,0);
    }
    checked++;
  }
  assert.equal(checked,54);
});

test('semantic validation is an isolated dry run and returns independent configuration data',()=>{
  const input=scenario({kind:'payroll-close',narrative:'Recorded source facts only.',payrollControls:{missingTime:false,disabledRoute:false,periodClosed:true},initialFaults:[{system:'bank',mode:'offline'}],limitations:['Synthetic simulation policy.']});
  const original=structuredClone(input),unrelatedWorld=createWorld({kind:'procurement-matching',seed:4}),originalWorld=structuredClone(unrelatedWorld);
  function freeze(value:any){if(value&&typeof value==='object'){for(const nested of Object.values(value))freeze(nested);Object.freeze(value);}}
  freeze(input);const first=validateGeneratedScenario(input),second=validateGeneratedScenario(input);
  assert.deepEqual(input,original);assert.deepEqual(unrelatedWorld,originalWorld);assert.deepEqual(first,second);assert.deepEqual(first,original);
  assert.notEqual(first,input);assert.notEqual(first.payrollControls,input.payrollControls);assert.notEqual(first.initialFaults,input.initialFaults);assert.notEqual(first.initialFaults[0],input.initialFaults[0]);assert.notEqual(first.limitations,input.limitations);
  first.payrollControls!.missingTime=true;first.initialFaults[0]!.mode='expired';first.limitations.push('Only this returned copy changes.');
  assert.deepEqual(input,original);assert.deepEqual(second,original);assert.deepEqual(unrelatedWorld,originalWorld);
  assert.equal('id' in second,false);assert.equal('employees' in second,false);assert.equal('generationHistory' in second,false);assert.equal('operations' in second,false);
});

test('structured output remains JSON-serializable draft-7 with strict object and family boundaries',()=>{
  const schema=z.toJSONSchema(scenarioSchema,{target:'draft-7'}),serialized=JSON.stringify(schema),roundTrip=JSON.parse(serialized);
  assert.equal(roundTrip.$schema,'http://json-schema.org/draft-07/schema#');assert.equal(roundTrip.type,'object');assert.equal(roundTrip.additionalProperties,false);
  assert.ok(roundTrip.required.includes('kind'));assert.ok(roundTrip.required.includes('orderCount'));assert.equal(roundTrip.properties.kind.enum.length,13);
  for(const controls of ['exceptionControls','procurementControls','payrollControls','reconciliationControls']){assert.equal(roundTrip.properties[controls].type,'object');assert.equal(roundTrip.properties[controls].additionalProperties,false);}
  assert.equal(roundTrip.properties.currency.const,'USD');assert.equal(roundTrip.properties.orderCount.type,'integer');
  const modernOnly=new Set(['$defs','$dynamicRef','$dynamicAnchor','prefixItems','unevaluatedItems','unevaluatedProperties']);
  function walk(value:any){if(value&&typeof value==='object')for(const [key,nested] of Object.entries(value)){assert.ok(!modernOnly.has(key),`Unexpected newer-draft keyword ${key}`);walk(nested);}}
  walk(roundTrip);assert.deepEqual(roundTrip,schema);
});

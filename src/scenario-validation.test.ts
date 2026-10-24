import {test,expect} from 'bun:test';
import {z} from 'zod';
import {AgentError,scenarioSchema,validateGeneratedScenario} from './agent.ts';
import {applyAction,createWorld,summarize} from './world.ts';

type Scenario=z.infer<typeof scenarioSchema>;
const scenario=(patch:Record<string,unknown>={}):any=>({kind:'ticket-cancellation',name:'Validation',description:'Synthetic source-backed financial records.',seed:1,orderCount:4,currency:'USD',cancelEvent:false,initialFaults:[],limitations:[],...patch});
function rejected(value:unknown,phase:'schema'|'domain',domainCode?:string){
  const before=structuredClone(value);
  expect(()=>validateGeneratedScenario(value)).toThrowSatisfying((error:any)=>{
    expect(error instanceof AgentError).toBeTruthy();expect(error.code).toBe('invalid_generated_scenario');expect(error.status).toBe(502);
    const details=error.details as any;expect(details.phase).toBe(phase);
    if(phase==='schema'){expect(Array.isArray(details.issues)&&details.issues.length>0).toBeTruthy();expect(details.issues.every((issue:any)=>typeof issue.code==='string'&&Array.isArray(issue.path))).toBeTruthy();}
    else{expect(details.code).toBe(domainCode);expect(typeof details.message).toBe('string');expect(details.message.length>0).toBeTruthy();}
    return true;
  });
  expect(value,'Invalid generated output must remain available unchanged for diagnosis').toStrictEqual(before);
}

test('generation validation rejects payroll counts the domain cannot create and retains the supported upper bound',()=>{
  for(const orderCount of [101,200])rejected(scenario({kind:'payroll-close',orderCount}),'domain','invalid_integer');
  const result=validateGeneratedScenario(scenario({kind:'payroll-close',orderCount:100,payrollControls:{missingTime:false,disabledRoute:false}}));
  const world=createWorld(result);expect(world.employees.length).toBe(100);expect(world.payrollTimeRecords.length).toBe(100);expect(summarize(world).reconciliation.balanced).toBe(true);
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
  expect(createWorld(noDispute).disputes.length).toBe(0);
});

test('generation validation rejects duplicate fault providers instead of selecting a silent winner',()=>{
  for(const mode of ['offline','expired'])rejected(scenario({initialFaults:[{system:'bank',mode:'offline'},{system:'bank',mode}]}),'domain','invalid_fault');
  const value=validateGeneratedScenario(scenario({initialFaults:[{system:'bank',mode:'offline'},{system:'gusto',mode:'expired'}]}));
  const world=createWorld(value);expect(world.faults.bank.mode).toBe('offline');expect(world.faults.gusto.mode).toBe('expired');
});

test('generation validation rejects empty optional narrative rather than returning an uncreatable draft',()=>{
  for(const narrative of ['', ' ', '\n\t'])rejected(scenario({narrative}),'domain','invalid_text');
  const without=validateGeneratedScenario(scenario());expect('narrative' in without).toBe(false);
  const withContext=validateGeneratedScenario(scenario({narrative:'The controller reviews source documents before approving payments.'}));
  expect(createWorld(withContext).documents.find((document:any)=>document.id==='scenario-context').body).toMatch(/controller reviews/);
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
    expect(input).toStrictEqual(before);expect(validated).toStrictEqual(input);expect(world.kind).toBe(kind);expect(world.seed).toBe(seed);expect(world.bankTransactions[0].amount_minor).toBe(startingCashMinor);
    const summary=summarize(world);expect(summary.reconciliation.balanced).toBe(true);expect(summary.reconciliation.bank_ledger_difference_minor).toBe(0);
    for(const journal of world.journals)expect(journal.lines.reduce((total:number,line:any)=>total+line.debit_minor-line.credit_minor,0)).toBe(0);
    if(kind==='payroll-close'){
      expect(world.employees.length).toBe(4);expect(world.payrollTimeRecords.length).toBe(4);expect(world.employees.every((employee:any)=>employee.route_enabled)).toBeTruthy();
      const run=applyAction(world,{type:'calculate_payroll',policy_id:world.payrollPolicies[0].id,time_record_ids:world.payrollTimeRecords.map((record:any)=>record.id)},{id:'offline-scenario-validator',role:'agent'}).result.payroll_run;
      expect(run.lines.length).toBe(4);expect(run.gross_minor).toBe(run.net_minor+run.employee_withholding_minor);expect(run.employer_tax_minor).toBe(run.gross_minor);expect(run.lines.every((line:any)=>line.net_minor>0)).toBeTruthy();
    }else if(kind==='procurement-matching'){
      expect(world.purchaseOrders.length).toBe(4);expect(world.goodsReceipts.length).toBe(2);expect(world.supplierInvoiceDeliveries.filter((delivery:any)=>delivery.duplicate).length).toBe(1);expect(world.periodClosed).toBe(true);expect(world.settledUnposted.length>0).toBeTruthy();
    }else if(kind==='settlement-exceptions'){
      expect(world.disputes[0].status).toBe('lost');expect(world.paymentReturns.length).toBe(1);expect(world.paymentReturns[0].amount_minor).toBe(world.bills[0].amount_minor);
    }else if(kind==='bank-reconciliation'){
      const omitted=seed===42,deferred=startingCashMinor===0,statement=world.bankStatements[0];
      expect(world.invoices.length).toBe(4);expect(world.operations.length).toBe(4);expect(world.operations.every((operation:any)=>operation.status==='settled'&&operation.journal_id)).toBeTruthy();
      expect(world.bankStatements.length).toBe(1);expect(statement.status).toBe('open');expect(statement.lines.length).toBe(omitted?2:3);expect(world.reconciliationSources.omitted_bank_transaction_ids.length).toBe(omitted?1:0);expect(world.reconciliationSources.late_posted_operation_ids.length).toBe(deferred?4:0);
      const receiptJournals=world.operations.map((operation:any)=>world.journals.find((journal:any)=>journal.id===operation.journal_id));expect(receiptJournals.every((journal:any)=>deferred?journal.posted_at>statement.end_at:journal.posted_at<=statement.end_at)).toBeTruthy();
      expect(statement.closing_balance_minor).toBe(statement.opening_balance_minor+statement.lines.reduce((sum:number,line:any)=>sum+line.amount_minor,0));
      expect(statement.closing_balance_minor<summary.cash_minor).toBe(omitted);expect(world.reconciliationMatches.length).toBe(0);expect(world.reconciliationReports.length).toBe(0);
    }
    checked++;
  }
  expect(checked).toBe(54);
});

test('semantic validation is an isolated dry run and returns independent configuration data',()=>{
  const input=scenario({kind:'payroll-close',narrative:'Recorded source facts only.',payrollControls:{missingTime:false,disabledRoute:false,periodClosed:true},initialFaults:[{system:'bank',mode:'offline'}],limitations:['Synthetic simulation policy.']});
  const original=structuredClone(input),unrelatedWorld=createWorld({kind:'procurement-matching',seed:4}),originalWorld=structuredClone(unrelatedWorld);
  function freeze(value:any){if(value&&typeof value==='object'){for(const nested of Object.values(value))freeze(nested);Object.freeze(value);}}
  freeze(input);const first=validateGeneratedScenario(input),second=validateGeneratedScenario(input);
  expect(input).toStrictEqual(original);expect(unrelatedWorld).toStrictEqual(originalWorld);expect(first).toStrictEqual(second);expect(first).toStrictEqual(original);
  expect(first).not.toBe(input);expect(first.payrollControls).not.toBe(input.payrollControls);expect(first.initialFaults).not.toBe(input.initialFaults);expect(first.initialFaults[0]).not.toBe(input.initialFaults[0]);expect(first.limitations).not.toBe(input.limitations);
  first.payrollControls!.missingTime=true;first.initialFaults[0]!.mode='expired';first.limitations.push('Only this returned copy changes.');
  expect(input).toStrictEqual(original);expect(second).toStrictEqual(original);expect(unrelatedWorld).toStrictEqual(originalWorld);
  expect('id' in second).toBe(false);expect('employees' in second).toBe(false);expect('generationHistory' in second).toBe(false);expect('operations' in second).toBe(false);
});

test('structured output remains JSON-serializable draft-7 with strict object and family boundaries',()=>{
  const schema=z.toJSONSchema(scenarioSchema,{target:'draft-7'}),serialized=JSON.stringify(schema),roundTrip=JSON.parse(serialized);
  expect(roundTrip.$schema).toBe('http://json-schema.org/draft-07/schema#');expect(roundTrip.type).toBe('object');expect(roundTrip.additionalProperties).toBe(false);
  expect(roundTrip.required.includes('kind')).toBeTruthy();expect(roundTrip.required.includes('orderCount')).toBeTruthy();expect(roundTrip.properties.kind.enum.length).toBe(13);
  for(const controls of ['exceptionControls','procurementControls','payrollControls','reconciliationControls']){expect(roundTrip.properties[controls].type).toBe('object');expect(roundTrip.properties[controls].additionalProperties).toBe(false);}
  expect(roundTrip.properties.currency.const).toBe('USD');expect(roundTrip.properties.orderCount.type).toBe('integer');
  const modernOnly=new Set(['$defs','$dynamicRef','$dynamicAnchor','prefixItems','unevaluatedItems','unevaluatedProperties']);
  function walk(value:any){if(value&&typeof value==='object')for(const [key,nested] of Object.entries(value)){expect(!modernOnly.has(key),`Unexpected newer-draft keyword ${key}`).toBeTruthy();walk(nested);}}
  walk(roundTrip);expect(roundTrip).toStrictEqual(schema);
});

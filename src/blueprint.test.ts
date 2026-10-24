import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {blueprintSchema,validateBlueprint,materializeBlueprint,BlueprintError} from './blueprint.ts';
import {createWorld,applyAction,summarize} from './world.ts';

const opening='2026-10-24T09:00:00.000Z',signed='2026-10-01T09:00:00.000Z',completed='2026-10-09T09:00:00.000Z',issued='2026-10-10T09:00:00.000Z',due='2026-11-10T09:00:00.000Z';
const customer={ref:'studio',name:'Cedar Studio',email:'billing@cedar.test'},vendor={ref:'supplier',name:'Paper Supply',email:'accounts@paper.test'};
const service=(ref:string,contract_ref:string,amount_minor:number)=>({ref,contract_ref,invoice_number:ref.toUpperCase(),amount_minor,issued_at:issued,due_at:due,service_completed_at:completed,completion_reference:`Completed ${ref}`});
const payroll=()=>({payroll_policy:{ref:'wage-policy',mode:'synthetic',name:'Explicit payroll',employee_withholding_bps:2000,employer_tax_bps:765},employees:[{ref:'ava',name:'Ava Lin',hourly_rate_minor:3200,route_enabled:true,time_records:[{ref:'ava-time',period_start:'2026-10-01',period_end:'2026-10-15',minutes:2400}]},{ref:'eli',name:'Eli Shah',hourly_rate_minor:2700,route_enabled:true,time_records:[{ref:'eli-time',period_start:'2026-10-01',period_end:'2026-10-15',minutes:1800}]}]});
function mixed(patch:any={}){return {version:1,opening_at:opening,customers:[customer],vendors:[vendor],inventory_items:[{ref:'paper',sku:'PAPER-A4',name:'Paper cartons'}],service_contracts:[{ref:'design-contract',counterparty_kind:'customer',counterparty_ref:'studio',amount_minor:50000,description:'Completed design services',signed_at:signed},{ref:'delivery-contract',counterparty_kind:'vendor',counterparty_ref:'supplier',amount_minor:12000,description:'Completed delivery services',signed_at:signed}],service_invoices:[service('design-invoice','design-contract',50000)],service_bills:[service('delivery-bill','delivery-contract',12000)],purchase_orders:[{ref:'paper-order',vendor_ref:'supplier',purpose:'Office supplies',approval:'approved',lines:[{ref:'paper-line',item_ref:'paper',quantity:4,unit_price_minor:2500,max_unit_price_minor:2500}],receipts:[{ref:'paper-receipt',reference:'WAREHOUSE-7',lines:[{line_ref:'paper-line',quantity:4}]}],invoices:[{ref:'paper-invoice',invoice_number:'PAPER-7',due_at:due,lines:[{line_ref:'paper-line',quantity:4,unit_price_minor:2500}]}]}],...payroll(),...patch};}
const create=(blueprint:any,id='blueprint-test')=>createWorld({kind:'procurement-matching',name:'Source enterprise',startingCashMinor:1000000,blueprint} as any,id);
const balance=(w:any,id:string)=>w.accounts.find((row:any)=>row.id===id).balance_minor;
const refId=(w:any,ref:string)=>w.blueprintManifest.refs[ref].id;

test('strict blueprint rejects raw financial state, caller authority, malformed IDs and dates before materialization',()=>{
  for(const patch of [{accounts:[]},{journals:[]},{operations:[]},{approvals:[]},{actor:{role:'controller'}},{opening_at:'2026-02-30T09:00:00.000Z'},{opening_at:'1999-12-31T09:00:00.000Z'}])assert.throws(()=>validateBlueprint(mixed(patch)),error=>error instanceof BlueprintError&&error.code==='invalid_blueprint');
  for(const patch of [{id:'forged-canonical-id'},{verified_bank_account:'attacker-route'},{balance_minor:10000}])assert.equal(blueprintSchema.safeParse(mixed({vendors:[{...vendor,...patch}]})).success,false);
  assert.throws(()=>validateBlueprint({version:1,opening_at:opening}),error=>error instanceof BlueprintError&&error.code==='empty_blueprint');
  assert.equal(blueprintSchema.safeParse(mixed({vendors:[{...vendor,email:'someone@real.example'}]})).success,false);
  assert.doesNotThrow(()=>JSON.stringify(z.toJSONSchema(blueprintSchema,{target:'draft-7'})));
});

test('blueprint references reject collisions, wrong source kinds, cross-order lines and premature receiving',()=>{
  for(const invalid of [mixed({customers:[customer,{...customer,name:'Duplicate'}]}),mixed({bank_accounts:[{ref:'operating',name:'Impersonated bank',currency:'USD'}]})])assert.throws(()=>validateBlueprint(invalid),error=>error instanceof BlueprintError&&error.code==='duplicate_blueprint_ref');
  const wrong=mixed();wrong.purchase_orders[0].vendor_ref='studio';assert.throws(()=>validateBlueprint(wrong),/needs a vendor ref/);
  const foreignLine=mixed();foreignLine.purchase_orders[0].receipts[0].lines[0].line_ref='unknown-order-line';assert.throws(()=>validateBlueprint(foreignLine),/outside its purchase order/);
  const premature=mixed();premature.purchase_orders[0].approval='pending';assert.throws(()=>validateBlueprint(premature),error=>error instanceof BlueprintError&&error.code==='unapproved_blueprint_purchase');
  const oversized={version:1,opening_at:opening,customers:Array.from({length:100},(_,i)=>({...customer,ref:`customer-${i}`})),vendors:Array.from({length:100},(_,i)=>({...vendor,ref:`vendor-${i}`})),bank_accounts:[{ref:'extra-bank',name:'Extra',currency:'USD'}]};assert.throws(()=>validateBlueprint(oversized),error=>error instanceof BlueprintError&&error.code==='blueprint_too_large');
});

test('custom enterprise materializes exact source economics without preset extras or assumed payroll/payment completion',()=>{
  const input=mixed(),before=structuredClone(input),w=create(input);assert.deepEqual(input,before);assert.equal(w.customers.length,1);assert.equal(w.vendors.length,1);assert.equal(w.inventoryItems.length,1);assert.equal(w.employees.length,2);assert.equal(w.orders.length,0);
  assert.equal(w.customers[0].name,'Cedar Studio');assert.equal(w.vendors[0].name,'Paper Supply');assert.match(w.vendors[0].verified_bank_account,/^synthetic-vendor-route-/);assert.notEqual(w.customers[0].id,customer.ref);
  assert.equal(w.invoices[0].amount_minor,50000);assert.equal(w.invoices[0].amount_paid_minor,0);assert.equal(w.bills[0].amount_minor,12000);assert.equal(w.bills[0].amount_paid_minor,0);assert.equal(w.bills.length,1,'Unmatched supplier invoice is not another payable');
  assert.equal(balance(w,'cash-bank'),1000000);assert.equal(balance(w,'receivables'),50000);assert.equal(balance(w,'payables'),-12000);assert.equal(balance(w,'inventory'),10000);assert.equal(balance(w,'grni'),-10000);assert.equal(w.bankTransactions.length,1);
  assert.equal(w.payrollRuns.length,0);assert.equal(w.payslips.length,0);assert.equal(w.supplierInvoices[0].status,'received');assert.equal(w.purchaseOrders[0].status,'received');assert.equal(summarize(w).reconciliation.balanced,true);
  const calculated=applyAction(structuredClone(w),{type:'calculate_payroll',policy_id:refId(w,'wage-policy'),time_record_ids:[refId(w,'ava-time'),refId(w,'eli-time')]},{id:'independent-payroll-operator',role:'operator'}).result.payroll_run;
  assert.equal(calculated.gross_minor,209000);assert.equal(calculated.net_minor,167200);assert.equal(calculated.employee_withholding_minor,41800);assert.equal(w.payrollRuns.length,0,'Validation calculation remains in its discarded clone');
});

test('source chronology, cumulative contract values, purchase ceilings and receipts are enforced by real domain actions',()=>{
  const cases:any[]=[];const future=mixed();future.service_invoices[0].service_completed_at='2026-10-25T09:00:00.000Z';cases.push(future);
  const excess=mixed();excess.service_invoices.push(service('extra-invoice','design-contract',1));cases.push(excess);
  const price=mixed();price.purchase_orders[0].lines[0].unit_price_minor=2600;cases.push(price);
  const receipt=mixed();receipt.purchase_orders[0].receipts[0].lines[0].quantity=5;cases.push(receipt);
  const time=mixed();time.employees[0].time_records[0].minutes=60000;cases.push(time);
  for(const input of cases){const before=structuredClone(input);assert.throws(()=>create(input),error=>(error as any).code==='blueprint_source_rejected'&&/Blueprint source/.test((error as Error).message));assert.deepEqual(input,before);}
});

test('pending approvals and deferred posting stay real, while source history is independent of later object mutation',()=>{
  const pending=mixed();pending.purchase_orders[0].approval='pending';pending.purchase_orders[0].receipts=[];pending.purchase_orders[0].invoices=[];const waiting=create(pending);assert.equal(waiting.purchaseOrders[0].status,'awaiting_approval');assert.equal(waiting.approvals[0].status,'pending');assert.equal(waiting.goodsReceipts.length,0);
  const w=create(mixed({period_closed:true}));assert.equal(w.periodClosed,true);assert.equal(w.operations.length,3);assert.ok(w.operations.every((op:any)=>op.status==='settled'&&!op.journal_id));assert.equal(balance(w,'receivables'),0);assert.equal(w.invoices[0].amount_minor,50000);assert.equal(w.journals.length,1);
  const history=JSON.stringify(w.generationHistory),created=w.generationHistory.find((row:any)=>row.action.type==='create_purchase_order');assert.equal(created.result.purchase_order.status,'awaiting_approval');assert.equal(w.purchaseOrders[0].status,'received');assert.notEqual(w.purchaseOrders[0].approved_by,w.purchaseOrders[0].requested_by);
  applyAction(w,{type:'reopen_period'},{id:'later-controller',role:'controller'});w.vendors[0].name='Later local label';assert.equal(JSON.stringify(w.generationHistory),history);assert.equal(w.journals.length,4);assert.ok(w.operations.every((op:any)=>op.journal_id));assert.equal(summarize(w).reconciliation.balanced,true);
});

test('blueprints replay identically under independent world IDs and reject mixing with preset controls',()=>{
  const a=create(mixed(),'world-first'),b=create(mixed(),'world-second');assert.deepEqual({...a,id:'portable'},{...b,id:'portable'});assert.equal(a.blueprintManifest.digest,b.blueprintManifest.digest);
  for(const controls of [{procurementControls:{duplicateInvoice:true}},{payrollControls:{missingTime:false}},{treasuryControls:{foreignCurrency:'KWD'}}])assert.throws(()=>createWorld({kind:'procurement-matching',name:'Conflicting sources',blueprint:mixed(),...controls} as any));
  const earlier=mixed({opening_at:'2026-10-23T09:00:00.000Z'}),world=create(earlier);assert.equal(world.now,earlier.opening_at);assert.equal(world.bankTransactions[0].posted_at,earlier.opening_at);assert.equal(world.journals[0].posted_at,earlier.opening_at);
  assert.throws(()=>createWorld({kind:'procurement-matching',blueprint:mixed()} as any),error=>(error as any).code==='blueprint_opening_capital_required');
  const zero=createWorld({kind:'procurement-matching',startingCashMinor:0,blueprint:mixed()} as any);assert.equal(summarize(zero).cash_minor,0);assert.equal(zero.bankTransactions[0].amount_minor,0);
});

test('custom payroll preserves missing source blockers and supports genuine federal W-4/YTD facts',()=>{
  const missing=mixed();missing.employees[1].time_records=[];const blocked=create(missing);assert.equal(blocked.employees.length,2);assert.throws(()=>applyAction(blocked,{type:'calculate_payroll',policy_id:refId(blocked,'wage-policy'),time_record_ids:[refId(blocked,'ava-time')]},{id:'operator',role:'operator'}),error=>(error as any).code==='missing_payroll_time');
  const b:any={version:1,opening_at:opening,payroll_policy:{ref:'federal-policy',mode:'us-federal-2026',name:'Federal regular wages',tax_year:2026,jurisdiction:'US-federal',pay_frequency:'semimonthly'},employees:[{ref:'nora',name:'Nora Bell',hourly_rate_minor:5000,time_records:[{ref:'nora-time',period_start:'2026-10-01',period_end:'2026-10-15',minutes:4800}],tax_profile:{ref:'nora-tax',as_of_date:'2026-09-30',w4:{form_year:2026,filing_status:'single_or_married_filing_separately',step2_checked:false,annual_credits_minor:0,other_income_minor:0,deductions_minor:0,extra_withholding_minor:0},prior_ytd:{social_security_wages_minor:18000000,medicare_wages_minor:19000000,futa_wages_minor:19000000}}}]};
  const world=create(b);assert.equal(world.employeeTaxProfiles.length,1);assert.equal(world.payrollRuns.length,0);assert.equal(world.operations.length,0);assert.equal(world.journals.length,1,'Opening historical YTD is not a new wage expense');
  const run=applyAction(world,{type:'calculate_payroll',policy_id:refId(world,'federal-policy'),time_record_ids:[refId(world,'nora-time')]},{id:'operator',role:'operator'}).result.payroll_run;assert.equal(run.gross_minor,400000);assert.equal(run.lines[0].tax_profile_id,refId(world,'nora-tax'));assert.equal(run.lines[0].tax_input.prior_ytd.medicare_wages_minor,19000000);assert.equal(run.lines[0].tax_input.gross_wages_minor,400000);assert.equal(world.operations.length,0);
});

test('foreign source obligations and genuine initial funding preserve native amounts, basis, receipts and independent review',()=>{
  const b={version:1,opening_at:opening,bank_accounts:[{ref:'kwd-bank',name:'KWD operating',currency:'KWD'}],fx_quotes:[{ref:'kwd-rate',base_currency:'KWD',quote_currency:'USD',numerator:'13',denominator:'4',observed_at:'2026-10-02T09:00:00.000Z',expires_at:'2026-10-31T09:00:00.000Z'}],foreign_counterparties:[{ref:'foreign-client',kind:'customer',name:'Kuwait Studio',email:'billing@kuwait.test',currency:'KWD'},{ref:'foreign-supplier',kind:'vendor',name:'Kuwait Services',email:'ap@kuwait-services.test',currency:'KWD'}],foreign_contracts:[{ref:'export-contract',counterparty_ref:'foreign-client',amount_minor:200000,description:'Completed localization work',signed_at:signed},{ref:'import-contract',counterparty_ref:'foreign-supplier',amount_minor:60000,description:'Completed translation work',signed_at:signed}],foreign_invoices:[{...service('export-invoice','export-contract',200000),quote_ref:'kwd-rate'}],foreign_bills:[{...service('import-bill','import-contract',60000),quote_ref:'kwd-rate'}],historical_funding:[{ref:'initial-funding',from_account_ref:'operating',to_account_ref:'kwd-bank',amount_minor:100000,fee_minor:25,quote_ref:'kwd-rate',reason:'Initial approved native operating liquidity'}]};
  const w=create(b);assert.equal(w.foreignInvoices[0].amount_minor,200000);assert.equal(w.foreignInvoices[0].original_functional_minor,65000);assert.equal(w.foreignBills[0].original_functional_minor,19500);assert.equal(w.foreignSettlements.length,0);assert.equal(w.foreignInvoices[0].amount_settled_minor,0);
  const transfer=w.treasuryTransfers[0],op=w.operations.find((row:any)=>row.id===transfer.operation_id);assert.equal(transfer.status,'settled');assert.equal(transfer.destination_amount_minor,307692);assert.equal(op.cash_legs.length,2);assert.notEqual(transfer.requested_by,transfer.approved_by);assert.ok(w.bankTransactions.filter((row:any)=>row.source_id===op.id).every((row:any)=>row.receipt_id===op.receipt_id));assert.equal(w.now,'2026-10-24T10:00:00.000Z');assert.equal(summarize(w).reconciliation.balanced,true);
  assert.ok(w.generationHistory.some((row:any)=>row.action.type==='advance_time'&&row.events.some((event:any)=>event.type==='operation.settled')));assert.throws(()=>createWorld({kind:'treasury-fx',name:'Underfunded',startingCashMinor:100,blueprint:b} as any),/Blueprint source initial-funding/);
});

function federalBlueprint():any{return {version:1,opening_at:opening,payroll_policy:{ref:'federal-policy',mode:'us-federal-2026',name:'Federal regular wages',tax_year:2026,jurisdiction:'US-federal',pay_frequency:'semimonthly'},employees:[{ref:'worker',name:'Payroll Source Worker',hourly_rate_minor:5000,time_records:[{ref:'work-time',period_start:'2026-10-01',period_end:'2026-10-15',minutes:4800}],tax_profile:{ref:'tax-source',as_of_date:'2026-09-30',w4:{form_year:2020,filing_status:'single_or_married_filing_separately',step2_checked:false,annual_credits_minor:0,other_income_minor:0,deductions_minor:0,extra_withholding_minor:0},prior_ytd:{social_security_wages_minor:0,medicare_wages_minor:0,futa_wages_minor:0}}}]};}
function addFunding(b:any,count:number){b.bank_accounts=[{ref:'wage-bank',name:'Wage bank',currency:'USD'}];b.historical_funding=Array.from({length:count},(_,index)=>({ref:`funding-${index+1}`,from_account_ref:'operating',to_account_ref:'wage-bank',amount_minor:10000,fee_minor:0,reason:'Independently approved historical wage liquidity'}));return b;}

test('federal blueprint rejects unsupported opening, work and profile years before any source transition',()=>{
  const cases:{blueprint:any;path:string;ref:string;year:number}[]=[];
  for(const year of [2025,2027]){const b=federalBlueprint();b.opening_at=`${year}-10-24T09:00:00.000Z`;cases.push({blueprint:b,path:'opening_at',ref:'federal-policy',year});}
  for(const [field,value] of [['period_start','2025-12-31'],['period_end','2027-01-01']] as const){const b=federalBlueprint();b.employees[0].time_records[0][field]=value;cases.push({blueprint:b,path:`employees[0].time_records[0].${field}`,ref:'work-time',year:Number(value.slice(0,4))});}
  for(const year of [2025,2027]){const b=federalBlueprint();b.employees[0].tax_profile.as_of_date=`${year}-09-30`;cases.push({blueprint:b,path:'employees[0].tax_profile.as_of_date',ref:'tax-source',year});}
  for(const item of cases){
    const inputBefore=structuredClone(item.blueprint);
    assert.throws(()=>validateBlueprint(item.blueprint),(error:any)=>error instanceof BlueprintError&&error.code==='incompatible_blueprint_payroll_year'&&(error.details as any).path===item.path&&(error.details as any).source_ref===item.ref&&(error.details as any).expected_year===2026&&(error.details as any).actual_year===item.year);
    assert.throws(()=>create(item.blueprint),(error:any)=>error.code==='incompatible_blueprint_payroll_year');
    const draft=createWorld({kind:'saas-collections',orderCount:1}),draftBefore=structuredClone(draft);let calls=0;
    assert.throws(()=>materializeBlueprint(draft,item.blueprint,{perform:()=>{calls++;throw new Error('Source action must not run');}}));
    assert.equal(calls,0);assert.deepEqual(draft,draftBefore);assert.deepEqual(item.blueprint,inputBefore);
  }
});

test('federal funding validates the first historical step crossing the supported year before materialization',()=>{
  for(const [openingAt,count,index] of [['2026-12-31T23:00:00.000Z',1,0],['2026-12-31T22:00:00.000Z',2,1]] as const){
    const b=addFunding(federalBlueprint(),count);b.opening_at=openingAt;
    assert.throws(()=>validateBlueprint(b),(error:any)=>error.code==='incompatible_blueprint_payroll_year'&&error.details.path===`historical_funding[${index}].settled_at`&&error.details.source_ref===`funding-${index+1}`&&error.details.value==='2027-01-01T00:00:00.000Z');
    assert.throws(()=>create(b),(error:any)=>error.code==='incompatible_blueprint_payroll_year');
  }
  const b=addFunding(federalBlueprint(),2);b.opening_at='2026-12-31T21:59:59.999Z';
  const w=create(b);assert.equal(w.now,'2026-12-31T23:59:59.999Z');assert.equal(w.treasuryTransfers.length,2);assert.ok(w.treasuryTransfers.every((row:any)=>row.status==='settled'));
  const run=applyAction(w,{type:'calculate_payroll',policy_id:refId(w,'federal-policy'),time_record_ids:[refId(w,'work-time')]},{id:'payroll-operator',role:'operator'}).result.payroll_run;
  assert.equal(run.gross_minor,400000);assert.equal(run.lines[0].tax_input.tax_year,2026);assert.equal(run.lines[0].tax_input.w4.form_year,2020,'A valid older W-4 form is not a different payment tax year');
});

test('federal year validation retains deliberate missing time and tax-profile blockers',()=>{
  const b=federalBlueprint();delete b.employees[0].tax_profile;
  const w=create(b);assert.equal(w.employeeTaxProfiles.length,0);
  assert.throws(()=>applyAction(w,{type:'calculate_payroll',policy_id:refId(w,'federal-policy'),time_record_ids:[refId(w,'work-time')]},{id:'payroll-operator',role:'operator'}),(error:any)=>error.code==='missing_employee_tax_profile');
  b.employees[0].time_records=[];assert.equal(create(b).payrollTimeRecords.length,0);
});

test('synthetic payroll retains arbitrary supported simulation years, cross-year work and historical funding',()=>{
  for(const year of [2001,2026,2027]){
    const b=addFunding(federalBlueprint(),2);b.opening_at=`${year}-12-31T23:00:00.000Z`;b.payroll_policy={ref:'synthetic-policy',mode:'synthetic',name:'Explicit simulation withholding',employee_withholding_bps:2000,employer_tax_bps:1000};delete b.employees[0].tax_profile;
    b.employees[0].time_records[0].period_start=`${year}-12-01`;b.employees[0].time_records[0].period_end=`${year}-12-15`;
    const w=create(b);assert.equal(w.now,`${year+1}-01-01T01:00:00.000Z`);
    const run=applyAction(w,{type:'calculate_payroll',policy_id:refId(w,'synthetic-policy'),time_record_ids:[refId(w,'work-time')]},{id:'payroll-operator',role:'operator'}).result.payroll_run;
    assert.equal(run.gross_minor,400000);assert.equal(run.employee_withholding_minor,80000);assert.equal(run.net_minor,320000);assert.equal(w.employeeTaxProfiles.length,0);
  }
  const b=federalBlueprint();b.opening_at='2027-01-06T09:00:00.000Z';b.payroll_policy={ref:'synthetic-policy',mode:'synthetic',name:'Cross-year source work',employee_withholding_bps:0,employer_tax_bps:0};delete b.employees[0].tax_profile;b.employees[0].time_records[0].period_start='2026-12-25';b.employees[0].time_records[0].period_end='2027-01-05';
  const w=create(b),run=applyAction(w,{type:'calculate_payroll',policy_id:refId(w,'synthetic-policy'),time_record_ids:[refId(w,'work-time')]},{id:'payroll-operator',role:'operator'}).result.payroll_run;assert.equal(run.net_minor,400000);assert.equal(run.period_start,'2026-12-25');assert.equal(run.period_end,'2027-01-05');
});

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentActionSchema, loadAgentConfig, runAgent, sanitizeAgentEvent, scenarioSchema,validateGeneratedScenario } from './agent.ts';
import {actionRequirements,createWorld} from './world.ts';

test('agent tools cannot encode controller decisions, account rewrites, or actor impersonation', () => {
  for (const action of [
    { type: 'decide_approval', approval_id: 'approval-1', decision: 'approve' },
    { type: 'advance_time', hours: 24 },
    { type: 'set_fault', system: 'stripe', mode: 'healthy' },
    { type: 'refund', payment_id: 'payment-1', amount_minor: 100, actor: 'controller' },
    { type: 'pay_bill', bill_id: 'bill-1', bank_account: 'unverified-override' },
  ]) assert.equal(agentActionSchema.safeParse(action).success, false);
  assert.equal(agentActionSchema.safeParse({ type: 'refund', payment_id: 'payment-1', amount_minor: 100 }).success, true);
});

test('asset and treasury tools accept only source-grounded public operator actions, never controller or internal authority',()=>{
  const allowed=[{type:'capitalize_asset',authorization_id:'asset-authority-1'},{type:'depreciate_asset',asset_id:'asset-1',through_month:'2026-09'},{type:'request_asset_disposal',authorization_id:'disposal-authority-1'},{type:'dispose_asset',disposal_id:'disposal-1'},{type:'request_treasury_transfer',from_account_id:'cash-bank',to_account_id:'foreign-bank',amount_minor:1000,fee_minor:0,quote_id:'fx-quote-1',reason:'Recorded treasury mandate'},{type:'revalue_bank_account',bank_account_id:'foreign-bank',quote_id:'fx-quote-1'}];
  for(const action of allowed){assert.equal(agentActionSchema.safeParse(action).success,true);assert.equal(actionRequirements[action.type]!.role,'operator');assert.equal(actionRequirements[action.type]!.internal,undefined);assert.equal(agentActionSchema.safeParse({...action,actor:'controller'}).success,false);}
  for(const type of ['record_asset_policy','authorize_asset_acquisition','cancel_asset_acquisition','place_asset_in_service','authorize_asset_disposal','approve_asset_disposal','cancel_asset_disposal','record_asset_disposal_completion','record_bank_account','set_bank_account_status','record_fx_quote','cancel_treasury_transfer','record_employee_tax_profile','record_statutory_payroll_policy'])assert.equal(agentActionSchema.safeParse({type,authorization_id:'source-1'}).success,false,type);
  for(const patch of [{amount_minor:0},{amount_minor:0.5},{fee_minor:-1},{numerator:'11',denominator:'10'},{bank_account:'arbitrary-beneficiary'}])assert.equal(agentActionSchema.safeParse({...allowed[4],...patch}).success,false);
  assert.equal(agentActionSchema.safeParse({...allowed[1],through_month:'2026-13'}).success,false);
});

test('foreign service tools require native source identity, matching bank and quote without controller authority',()=>{
  const allowed=[{type:'collect_foreign_invoice',invoice_id:'foreign-invoice-1',bank_account_id:'kwd-account',amount_minor:123456,quote_id:'quote-1'},{type:'pay_foreign_bill',bill_id:'foreign-bill-1',bank_account_id:'eur-account',amount_minor:12345,quote_id:'quote-1'},{type:'revalue_foreign_obligation',kind:'bill',obligation_id:'foreign-bill-1',quote_id:'quote-1'}];
  for(const action of allowed){assert.equal(agentActionSchema.safeParse(action).success,true);assert.equal(actionRequirements[action.type]!.role,'operator');for(const extra of [{beneficiary_id:'new-route'},{currency:'USD'},{actor:'controller'},{approval_id:'self-approved'}])assert.equal(agentActionSchema.safeParse({...action,...extra}).success,false);}
  for(const type of ['record_customer','record_vendor','record_inventory_item','record_service_contract','record_service_invoice','record_service_bill','record_foreign_counterparty','record_foreign_contract','record_foreign_invoice','record_foreign_bill','set_foreign_counterparty_status','cancel_foreign_settlement'])assert.equal(agentActionSchema.safeParse({type}).success,false,type);
  for(const amount_minor of [0,-1,0.1,1e12+1])assert.equal(agentActionSchema.safeParse({...allowed[0],amount_minor}).success,false);
  for(const currency of ['EUR','GBP','JPY','KWD']){const scenario=validateGeneratedScenario({kind:'foreign-service-close',name:'Trade',description:'Source-backed foreign service review',seed:1,orderCount:2,currency:'USD',cancelEvent:false,initialFaults:[],limitations:[],foreignControls:{currency,periodClosed:true}}),world=createWorld(scenario);assert.equal(world.foreignInvoices.length,2);assert.equal(world.foreignBills.length,2);assert.equal(world.foreignInvoices[0].currency,currency);}
});

test('generator schema materializes assets, native-currency treasury and federal payroll without borrowing incompatible family controls',()=>{
  const base={name:'Operations',description:'Inspect authentic source records and request independent approval.',seed:23,orderCount:3,currency:'USD',cancelEvent:false,initialFaults:[],limitations:['Synthetic provider subsets.']};
  for(const kind of ['fixed-asset-close','treasury-fx','payroll-federal']){
    const config=validateGeneratedScenario({...base,kind,...(kind==='treasury-fx'?{treasuryControls:{foreignCurrency:'JPY',fundingMinor:100000,feeMinor:0,deferredPosting:true}}:{})}),world=createWorld(config,'portable-new-company');assert.equal(world.kind,kind);
    if(kind==='treasury-fx'){assert.equal(world.treasuryControls.foreignCurrency,'JPY');assert.ok(world.treasuryTransfers.some((transfer:any)=>transfer.status==='settled'));}
    if(kind==='payroll-federal'){assert.equal(world.employeeTaxProfiles.length,3);assert.equal(world.payrollPolicies[0].mode,'us-federal-2026');}
    if(kind==='fixed-asset-close')assert.equal(world.assetAcquisitionAuthorizations.length,3);
  }
  assert.throws(()=>validateGeneratedScenario({...base,kind:'payroll-close',treasuryControls:{foreignCurrency:'EUR'}}));
  assert.throws(()=>validateGeneratedScenario({...base,kind:'payroll-federal',payrollControls:{missingTime:false}}));
});

test('financial tool arguments reject fractional, unsafe, negative, and malformed values', () => {
  for (const amount of [-1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.equal(agentActionSchema.safeParse({ type: 'refund', payment_id: 'payment-1', amount_minor: amount }).success, false);
  }
  assert.equal(agentActionSchema.safeParse({ type: 'send_email', to: 'not-an-address', subject: 'Hello', body: 'Hello' }).success, false);
  assert.equal(agentActionSchema.safeParse({ type: 'post_journal', lines: [{ account_id: 'a', debit_minor: 100, credit_minor: 0 }] }).success, false);
});

test('audit sanitization removes supplied secrets and reasoning without losing tool evidence', () => {
  const event = {
    authorization: 'Bearer hidden',
    nested: { access_token: 'hidden', refreshToken: 'hidden', client_secret: 'hidden', 'x-goog-api-key': 'hidden' },
    content: [
      { type: 'thinking', thinking: 'private' },
      { type: 'redacted_thinking', data: 'private' },
      { type: 'text', text: 'Result contains secret-123 and sk-ant-demo-key. Google: AIza'+'x'.repeat(35) },
      { type: 'tool_use', id: 'tool-1', name: 'execute_action', input: { type: 'refund', amount_minor: 100 } },
    ],
  };
  const safe = sanitizeAgentEvent(event, ['secret-123']) as typeof event;
  assert.equal(safe.authorization, '[REDACTED]');
  assert.deepEqual(safe.nested, { access_token: '[REDACTED]', refreshToken: '[REDACTED]', client_secret: '[REDACTED]', 'x-goog-api-key': '[REDACTED]' });
  assert.equal(safe.content.length, 2);
  assert.equal(safe.content[0]?.text, 'Result contains [REDACTED] and [REDACTED]. Google: [REDACTED]');
  assert.equal(safe.content[1]?.input?.amount_minor, 100);
  assert.equal(event.content.length, 4, 'sanitize does not mutate the SDK payload');
});

test('scenario generator output schema constrains economic simulation parameters', () => {
  const scenario = { kind: 'ticket-cancellation', name: 'Copper Hall', description: 'A cancelled concert.', seed: 1, orderCount: 12, currency: 'USD', cancelEvent: true, initialFaults: [], limitations: [] };
  assert.equal(scenarioSchema.safeParse(scenario).success, true);
  assert.equal(scenarioSchema.safeParse({...scenario,name:'a'.repeat(24)}).success,true);
  for (const patch of [{name:'a'.repeat(25)}, { kind: 'invented-vendor' }, { currency: 'BTC' }, { orderCount: 201 }, { seed: 1.5 }, { startingCashMinor: -1 }, { controller: true }, { initialFaults: [{ system: 'invented-vendor', mode: 'offline' }] }, { initialFaults: [{ system: 'bank', mode: 'cash-stolen' }] }]) {
    assert.equal(scenarioSchema.safeParse({ ...scenario, ...patch }).success, false);
  }
});

test('config exposes availability but never credentials, and missing configuration is explicit', () => {
  const folder = mkdtempSync(join(tmpdir(), 'finance-world-config-test-'));
  const envFile = join(folder, 'test.env');
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousFile = process.env.FINANCE_WORLD_ENV_FILE;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.FINANCE_WORLD_ENV_FILE = envFile;
    assert.equal(loadAgentConfig().available, false);
    writeFileSync(envFile, "ANTHROPIC_API_KEY='fake-test-credential'\n", { mode: 0o600 });
    const config = loadAgentConfig();
    assert.equal(config.available, true);
    assert.equal(JSON.stringify(config).includes('fake-test-credential'), false);
    writeFileSync(envFile, 'ANTHROPIC_API_KEY=\n');
    assert.equal(loadAgentConfig().available, false);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousFile === undefined) delete process.env.FINANCE_WORLD_ENV_FILE;
    else process.env.FINANCE_WORLD_ENV_FILE = previousFile;
    rmSync(folder, { recursive: true, force: true });
  }
});

test('agent refuses external or redirectable service endpoints before creating an SDK session', async () => {
  const options = { worldId: 'world-1', token: 'test-token', instruction: 'Read the ledger.', onEvent() {} };
  for (const baseUrl of ['https://example.com', 'http://127.0.0.1@evil.test', 'file:///tmp/service', 'http://127.0.0.1?next=evil', 'http://127.0.0.1/prefix']) {
    await assert.rejects(runAgent({ ...options, baseUrl }), { code: 'invalid_agent_endpoint' });
  }
  await assert.rejects(runAgent({ ...options, baseUrl: 'http://127.0.0.1:4320', worldId: '../other-world' }), { code: 'invalid_world_id' });
});

test('procurement tools accept grounded operator requests and cannot manufacture warehouse or purchasing authority',()=>{
  for(const action of [
    {type:'create_purchase_order',vendor_id:'vendor-1',lines:[{item_id:'item-1',quantity:2,unit_price_minor:500}],document_ids:['doc-requisition'],reason:'Authorized equipment'},
    {type:'match_supplier_invoice',supplier_invoice_id:'supplier-invoice-1'},
    {type:'issue_inventory',authorization_id:'authority-1',lines:[{item_id:'item-1',quantity:2}]},
  ])assert.equal(agentActionSchema.safeParse(action).success,true);
  for(const action of [
    {type:'authorize_purchase',vendor_id:'vendor-1',lines:[{item_id:'item-1',quantity:2,max_unit_price_minor:500}],purpose:'Self authorization',external_event_id:'fake'},
    {type:'approve_purchase_order',purchase_order_id:'po-1'},
    {type:'receive_goods',purchase_order_id:'po-1',lines:[{po_line_id:'line-1',quantity:2}],reference:'Invented receipt',external_event_id:'fake'},
    {type:'correct_supplier_invoice',supplier_invoice_id:'supplier-invoice-1',lines:[],external_event_id:'fake'},
    {type:'authorize_inventory_issue',lines:[{item_id:'item-1',quantity:2}],purpose:'Self authorization',external_event_id:'fake'},
    {type:'return_inventory',issue_id:'issue-1',lines:[{item_id:'item-1',quantity:2}],reason:'Invented return',external_event_id:'fake'},
    {type:'match_supplier_invoice',supplier_invoice_id:'supplier-invoice-1',force:true},
    {type:'create_purchase_order',vendor_id:'vendor-1',lines:[{item_id:'item-1',quantity:0.5,unit_price_minor:500}],document_ids:['doc-requisition'],reason:'Fractional stock'},
  ])assert.equal(agentActionSchema.safeParse(action).success,false);
  const scenario={kind:'procurement-matching',name:'Warehouse',description:'Three-way matching',seed:7,orderCount:4,currency:'USD',cancelEvent:false,initialFaults:[],limitations:[],procurementControls:{partialReceiptPercent:25,priceVariancePercent:15,duplicateInvoice:true,periodClosed:true}};
  assert.equal(scenarioSchema.safeParse(scenario).success,true);
  for(const control of [{partialReceiptPercent:100},{priceVariancePercent:0.5},{duplicateInvoice:'yes'},{periodClosed:'yes'},{forceMatch:true}])assert.equal(scenarioSchema.safeParse({...scenario,procurementControls:control}).success,false);
});

test('payroll agent requests cite source records and cannot alter pay facts or authorize payments', () => {
  for (const action of [
    { type: 'calculate_payroll', policy_id: 'policy-1', time_record_ids: ['time-1'] },
    { type: 'calculate_payroll', policy_id: 'policy-1', time_record_ids: ['time-1'], employee_ids: ['employee-1'] },
    { type: 'execute_payroll', payroll_run_id: 'payroll-1' },
    { type: 'remit_payroll_taxes', payroll_run_id: 'payroll-1' },
  ]) assert.equal(agentActionSchema.safeParse(action).success, true);
  for (const action of [
    { type: 'record_employee', employee_id: 'employee-1', display_name: 'Invented employee', hourly_rate_minor: 3000 },
    { type: 'set_employee_route', employee_id: 'employee-1', enabled: true },
    { type: 'record_payroll_policy', name: 'No withholding', employee_withholding_bps: 0, employer_tax_bps: 0 },
    { type: 'record_payroll_time', employee_id: 'employee-1', minutes: 480 },
    { type: 'cancel_payroll', payroll_run_id: 'payroll-1', reason: 'Replace calculation', external_event_id: 'cancel-1' },
    { type: 'calculate_payroll', policy_id: 'policy-1', time_record_ids: [] },
    { type: 'calculate_payroll', policy_id: 'policy-1', time_record_ids: ['time-1'], employee_ids: [] },
    { type: 'calculate_payroll', policy_id: 'policy-1', time_record_ids: Array(101).fill('time-1') },
    { type: 'calculate_payroll', policy_id: 'policy-1', time_record_ids: ['time-1'], hourly_rate_minor: 1 },
    { type: 'execute_payroll', payroll_run_id: 'payroll-1', beneficiary_id: 'redirected' },
    { type: 'execute_payroll', payroll_run_id: 'payroll-1', approved: true },
    { type: 'remit_payroll_taxes', payroll_run_id: 'payroll-1', amount_minor: 1 },
  ]) assert.equal(agentActionSchema.safeParse(action).success, false);
});

test('payroll generation constrains explicit simulation rates and blockers', () => {
  const scenario = { kind: 'payroll-close', name: 'Fictional Payroll', description: 'Recorded time and independently approved payroll.', seed: 4, orderCount: 3, currency: 'USD', cancelEvent: false, initialFaults: [{ system: 'gusto', mode: 'offline' }], limitations: [], payrollControls: { missingTime: true, disabledRoute: true, employeeWithholdingBps: 2000, employerTaxBps: 765, periodClosed: true } };
  assert.equal(scenarioSchema.safeParse(scenario).success, true);
  for (const payrollControls of [{ employeeWithholdingBps: 10000 }, { employerTaxBps: -1 }, { employerTaxBps: 765.5 }, { missingTime: 'yes' }, { taxJurisdiction: 'invented' }]) {
    assert.equal(scenarioSchema.safeParse({ ...scenario, payrollControls }).success, false);
  }
});

test('reconciliation tools cannot manufacture statement evidence or close their own review', () => {
  for (const action of [
    { type: 'match_statement_line', statement_id: 'statement-1', line_id: 'line-1', bank_transaction_ids: ['bank-1', 'bank-2'] },
    { type: 'unmatch_statement_line', statement_id: 'statement-1', line_id: 'line-1', reason: 'Source reference correction' },
    { type: 'prepare_reconciliation', statement_id: 'statement-1' },
  ]) assert.equal(agentActionSchema.safeParse(action).success, true);
  for (const action of [
    { type: 'record_bank_statement', source_statement_id: 'statement-1', lines: [], external_event_id: 'invented' },
    { type: 'record_bank_activity', source_transaction_id: 'bank-fee-1', kind: 'fee', amount_minor: 100, external_event_id: 'invented' },
    { type: 'classify_bank_activity', bank_activity_id: 'activity-1', account_id: 'cash-bank' },
    { type: 'classify_bank_activity', bank_activity_id: 'activity-1', account_id: 'bank-fee-expense', amount_minor: 1 },
    { type: 'classify_bank_activity', bank_activity_id: 'activity-1', account_id: 'bank-fee-expense', posted_at: '2026-01-01T00:00:00.000Z' },
    { type: 'replace_bank_statement', statement_id: 'statement-1', lines: [], external_event_id: 'invented' },
    { type: 'close_reconciliation', statement_id: 'statement-1', report_id: 'report-1', source_fingerprint: 'forged', acknowledged_timing_item_ids: [], external_event_id: 'self-approved' },
    { type: 'reopen_reconciliation', statement_id: 'statement-1', reason: 'Bypass', external_event_id: 'invented' },
    { type: 'match_statement_line', statement_id: 'statement-1', line_id: 'line-1', bank_transaction_ids: [] },
    { type: 'match_statement_line', statement_id: 'statement-1', line_id: 'line-1', bank_transaction_ids: ['bank-1'], amount_minor: 1 },
    { type: 'match_statement_line', statement_id: 'statement-1', line_id: 'line-1', bank_transaction_ids: ['bank-1'], force: true },
    { type: 'prepare_reconciliation', statement_id: 'statement-1', close: true },
  ]) assert.equal(agentActionSchema.safeParse(action).success, false);
  const scenario = { kind: 'bank-reconciliation', name: 'gram treasury', description: 'Statement source matching.', seed: 1, orderCount: 4, currency: 'USD', cancelEvent: false, initialFaults: [], limitations: [], reconciliationControls: { omitStatementLine: true, deferredPosting: true } };
  assert.equal(scenarioSchema.safeParse(scenario).success, true);
  for (const account_id of ['bank-fee-expense','interest-income'])assert.equal(agentActionSchema.safeParse({type:'classify_bank_activity',bank_activity_id:'activity-1',account_id}).success,true);
  assert.equal(scenarioSchema.safeParse({...scenario,reconciliationControls:{bankFeeMinor:2500,interestMinor:175}}).success,true);
  for (const reconciliationControls of [{ omitStatementLine: 1 }, { deferredPosting: 'yes' }, { postMissingCash: true },{bankFeeMinor:-1},{interestMinor:1.5},{bankFeeMinor:1_000_000_000_001}]) {
    assert.equal(scenarioSchema.safeParse({ ...scenario, reconciliationControls }).success, false);
  }
});

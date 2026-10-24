import {test,expect} from 'bun:test';
import {createWorld,applyAction,summarize,DomainError} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {invoiceRefs,payerMatches,parseRemittance,backtestRule} from './cash-application.ts';
import {whyTimeline,workBriefing,workItemView,agentQueue} from './work.ts';
import {scoreCashApplication} from './cash-score.ts';
import {colleagueTick} from './colleague.ts';

const agent:Actor={id:'agent-world:test',role:'agent'},controller:Actor={id:'controller-local',role:'controller'},dana:Actor={id:'slack:U0DANA',role:'accountant'};
const act=(w:World,action:Action,actor:Actor=controller)=>applyAction(w,action,actor).result;
const denied=(w:World,action:Action,actor:Actor,code:string)=>{const before=structuredClone(w);expect(()=>act(w,action,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);};
const balanced=(w:World)=>{const s=summarize(w);expect(s.reconciliation.balanced).toBe(true);expect(s.reconciliation.bank_ledger_difference_minor).toBe(0);};
const item=(w:World,reference:string)=>w.workItems.find((row:any)=>row.id===w.bankReceipts.find((receipt:any)=>receipt.bank_reference===reference)?.work_item_id);
const find=(rows:any[],id:any,label:string)=>rows.find(row=>row.id===id)??(()=>{throw new Error(`${label} not found`);})();
const policies:{rule:any;title:string}[]=[
  {rule:{kind:'exact_match'},title:'Apply exact referenced payments'},
  {rule:{kind:'multi_invoice_split'},title:'Split payments across cited invoices'},
  {rule:{kind:'payer_alias',payer_name:'BRIGHTWATER HOSPITALITY LLC',customer_ids:['cus-copper','cus-brightsocial','cus-dockside']},title:'Brightwater pays for its bars'},
  {rule:{kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:5000,channels:['wire']},title:'Wire fees up to $50 to bank fees'},
  {rule:{kind:'early_pay_discount',max_bps:200,within_days:10},title:'2/10 discounts taken on time'},
  {rule:{kind:'keg_deposit_netting',deposit_minor:3000},title:'Net returned keg deposits'},
];
function onboarded(options:{enabled?:boolean}={}){
  const w=createWorld({kind:'cash-application',seed:42},'world-test');
  for(const policy of policies){
    const proposed=act(w,{type:'policy_propose',rule:policy.rule,title:policy.title,rationale:'The AR team handled every comparable case this way last year.',evidence:{queries:[{sql:'SELECT adjustment_account, COUNT(*) FROM applied_lines GROUP BY 1',finding:'Consistent treatment in history'}]}},agent).policy;
    expect(proposed.backtest.contrary).toBe(0);expect(proposed.backtest.support).toBeGreaterThan(5);
    act(w,{type:'policy_decide',policy_id:proposed.id,decision:'approve',reason:'Matches how we work'});
  }
  if(options.enabled!==false)act(w,{type:'seat_configure',enabled:true});
  return w;
}

test('memo, payer and remittance parsing reads what people actually type',()=>{
  expect(invoiceRefs('WIRE IN GREAT LAKES BEVERAGE DIST INV 2005 INV 2006')).toStrictEqual(['INV-2005','INV-2006']);
  expect(invoiceRefs('INV 1201/1207')).toStrictEqual(['INV-1201','INV-1207']);
  expect(invoiceRefs('PMT INV1101 INV1102')).toStrictEqual(['INV-1101','INV-1102']);
  expect(invoiceRefs('lNV 1O42')).toStrictEqual(['INV-1042']);
  expect(invoiceRefs('INV 2011 LESS 6 KEG RTN')).toStrictEqual(['INV-2011']);
  expect(invoiceRefs('DEPOSIT 000483921')).toStrictEqual([]);
  expect(payerMatches('GREAT LAKES BEVERAGE DIST','Great Lakes Beverage Distributors')).toBe(true);
  expect(payerMatches('PINE AND POST TAPROOM','Pine & Post Taproom')).toBe(true);
  expect(payerMatches('LAKESHORE GAMING LLC','Lakeshore Casino')).toBe(false);
  expect(payerMatches('BRIGHTWATER HOSPITALITY LLC','The Copper Still')).toBe(false);
  expect(parseRemittance('invoice,gross,deduction_code,deduction,net\n2007,8000.00,,0.00,8000.00\n2008,6500.00,PROMO-Q4,120.00,6380.00')).toStrictEqual({rows:[{invoice_id:'INV-2007',gross_minor:800000,deduction_code:'',deduction_minor:0,net_minor:800000},{invoice_id:'INV-2008',gross_minor:650000,deduction_code:'PROMO-Q4',deduction_minor:12000,net_minor:638000}],net_minor:1438000});
});

test('the company is learned from records: history holds the patterns, backtests find their boundaries',()=>{
  const w=createWorld({kind:'cash-application',seed:42},'world-test');
  expect(createWorld({kind:'cash-application',seed:42},'world-test')).toStrictEqual(w);balanced(w);
  expect(w.cashHistory.receipts.length).toBeGreaterThan(250);expect(w.seat.autonomy.enabled).toBe(false);expect(w.seat.onboarding.status).toBe('pending');
  // No policy is written down anywhere: the seat starts with none.
  expect(w.policies).toStrictEqual([]);expect(w.documents.some((doc:any)=>/\$50|bank fee|10 days/i.test(doc.body??''))).toBe(false);
  const tight=backtestRule(w,{kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:5000,channels:['wire']}),loose=backtestRule(w,{kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:20000,channels:['wire']});
  expect(tight.contrary).toBe(0);expect(tight.support).toBeGreaterThan(40);expect(loose.contrary).toBeGreaterThan(0);
  expect(backtestRule(w,{kind:'early_pay_discount',max_bps:200,within_days:10}).contrary).toBe(0);
  expect(backtestRule(w,{kind:'early_pay_discount',max_bps:200,within_days:30}).contrary).toBeGreaterThan(0);
  expect(backtestRule(w,{kind:'payer_alias',payer_name:'BRIGHTWATER HOSPITALITY LLC',customer_ids:['cus-copper']}).contrary).toBeGreaterThan(0);
});

test('a new bank line creates a work item by itself; roles are enforced in code, not the prompt',()=>{
  const w=onboarded({enabled:false});
  expect(w.workItems).toStrictEqual([]);
  act(w,{type:'advance_time',hours:24});balanced(w);
  expect(w.workItems.map((row:any)=>[row.state,row.created_by])).toStrictEqual([['new','sync'],['new','sync'],['new','sync'],['new','sync']]);
  expect(w.workLog.filter((row:any)=>row.action==='create').every((row:any)=>row.role==='sync')).toBe(true);
  const anchor=item(w,'JPM-88310431');
  denied(w,{type:'work_decide',work_item_id:anchor.id,decision:'approve'},agent,'work_permission_denied');
  denied(w,{type:'work_propose',work_item_id:anchor.id,allocations:[{invoice_id:'INV-2001',amount_minor:128400}],confidence:0.9,reason:'controller trying to do the agent job'},controller,'work_permission_denied');
  denied(w,{type:'policy_decide',policy_id:'pol-001',decision:'approve'},agent,'work_permission_denied');
  denied(w,{type:'seat_configure',enabled:true},agent,'work_permission_denied');
  denied(w,{type:'seat_configure',enabled:true},dana,'work_permission_denied');
  // Proposals are recorded but autonomy is off, so everything waits for a person.
  const result=act(w,{type:'work_propose',work_item_id:anchor.id,allocations:[{invoice_id:'INV-2001',amount_minor:128400}],confidence:0.97,reason:'Memo cites INV-2001 and the amount equals its balance.',evidence_ids:['INV-2001']},agent);
  expect(result.outcome).toBe('awaiting_approval');expect(result.proposal.covered).toBe(true);expect(result.proposal.confidence).toBe(0.97);
  denied(w,{type:'work_decide',work_item_id:anchor.id,decision:'reject'},dana,'invalid_work_text');
  const posted=act(w,{type:'work_decide',work_item_id:anchor.id,decision:'approve',reason:'Looks right'},dana);
  expect(posted.application.allocations).toStrictEqual([{invoice_id:'INV-2001',amount_minor:128400}]);expect(item(w,'JPM-88310431').state).toBe('posted');balanced(w);
  expect(w.invoices.find((row:any)=>row.id==='INV-2001').status).toBe('paid');
});

test('covered and confident work posts without a person; the log says which policy and why',()=>{
  const w=onboarded();act(w,{type:'advance_time',hours:24});
  const propose=(reference:string,body:any,confidence=0.95)=>act(w,{type:'work_propose',work_item_id:item(w,reference).id,confidence,reason:'Evidence on the bank line and invoices supports this.',...body},agent);
  expect(propose('JPM-88310431',{allocations:[{invoice_id:'INV-2001',amount_minor:128400}]}).outcome).toBe('auto_approved');
  const wire=propose('JPM-88310442',{allocations:[{invoice_id:'INV-2003',amount_minor:5797500}],adjustments:[{invoice_id:'INV-2003',kind:'bank_fee',amount_minor:2500}]});
  expect(wire.outcome).toBe('auto_approved');expect(wire.proposal.policies.map((row:any)=>row.kind).sort()).toStrictEqual(['exact_match','short_pay_writeoff']);
  expect(propose('JPM-88310457',{allocations:[{invoice_id:'INV-2005',amount_minor:1240000},{invoice_id:'INV-2006',amount_minor:620000}]}).outcome).toBe('auto_approved');
  const alias=propose('JPM-88310463',{allocations:[{invoice_id:'INV-2009',amount_minor:315000}]});
  expect(alias.outcome).toBe('auto_approved');expect(alias.proposal.basis.find((row:any)=>row.factor==='payer').why).toMatch(/alias/);
  balanced(w);
  const fee=w.journals.find((row:any)=>row.lines.some((line:any)=>line.account_id==='bank-fee-expense'));
  expect(fee.lines).toStrictEqual([{account_id:'unapplied-cash',debit_minor:5797500,credit_minor:0,currency:'USD'},{account_id:'bank-fee-expense',debit_minor:2500,credit_minor:0,currency:'USD'},{account_id:'receivables',debit_minor:0,credit_minor:5800000,currency:'USD'}]);
  expect((summarize(w) as any).unapplied_cash_minor).toBe(0);
  const why=whyTimeline(w,'INV-2003');
  expect(why.timeline.map((row:any)=>[row.role,row.action])).toStrictEqual([['sync','create'],['ai_agent','propose'],['policy_engine','approve'],['gateway','post']]);
  expect(why.timeline[2].why).toMatch(/pol-00\d v1/);expect(why.journals.map((row:any)=>row.source_type)).toStrictEqual(['invoice','operation']);
  // Hard limits hold whoever asks.
  act(w,{type:'advance_time',hours:24});
  denied(w,{type:'work_propose',work_item_id:item(w,'JPM-88310478').id,allocations:[{invoice_id:'INV-2011',amount_minor:979000}],adjustments:[{invoice_id:'INV-2011',kind:'keg_deposit',amount_minor:21000}],hold_on_account:true,confidence:0.9,reason:'Seven kegs returned according to the customer.'},agent,'keg_return_missing');
  denied(w,{type:'work_propose',work_item_id:item(w,'JPM-88310478').id,allocations:[{invoice_id:'INV-2011',amount_minor:1000000}],confidence:0.9,reason:'Apply the full invoice from this receipt.'},agent,'exceeds_receipt');
  denied(w,{type:'work_propose',work_item_id:item(w,'JPM-88310478').id,allocations:[{invoice_id:'INV-2011',amount_minor:982000}],adjustments:[{invoice_id:'INV-2002',kind:'bank_fee',amount_minor:100}],confidence:0.9,reason:'Write off a fee on an invoice this receipt does not pay.'},agent,'invalid_adjustment');
});

test('low confidence waits for a person, a question gets answered, and a no is handled',()=>{
  const w=onboarded();act(w,{type:'advance_time',hours:48});
  // A $310 short-pay from a new customer has no precedent: the gateway says so.
  const pine=item(w,'JPM-88310502');
  const asked=act(w,{type:'work_ask',work_item_id:pine.id,to_role:'accountant',question:'Pine & Post short-paid INV-2014 by $310 with no remittance. Is this a valid deduction or should I chase it?'},agent);
  expect(item(w,'JPM-88310502').state).toBe('needs_info');expect(agentQueue(w).some((row:any)=>row.id===pine.id)).toBe(false);
  denied(w,{type:'work_answer',question_id:asked.question.id,answer:'self-answer'},agent,'work_permission_denied');
  act(w,{type:'work_answer',question_id:asked.question.id,answer:'They returned a damaged half-barrel. Hold the $310 as a deduction pending the credit memo.'},dana);
  expect(item(w,'JPM-88310502').state).toBe('answered');expect(agentQueue(w).some((row:any)=>row.id===pine.id)).toBe(true);expect(w.precedents.at(-1).source).toBe('answer');
  const proposal=act(w,{type:'work_propose',work_item_id:pine.id,allocations:[{invoice_id:'INV-2014',amount_minor:189000}],adjustments:[{invoice_id:'INV-2014',kind:'deduction_pending',amount_minor:31000}],confidence:0.8,reason:'Dana confirmed a damaged half-barrel; hold as a deduction pending the credit memo.'},agent);
  expect(proposal.outcome).toBe('awaiting_approval');expect(proposal.proposal.confidence).toBeLessThan(0.5);
  expect(proposal.proposal.basis.some((row:any)=>/no precedent/.test(row.why))).toBe(true);
  act(w,{type:'work_decide',work_item_id:pine.id,decision:'approve',reason:'Matches the return note'},dana);expect(item(w,'JPM-88310502').state).toBe('posted');
  // Summit's late discount: the seat's first instinct is wrong and a person says no.
  const summit=item(w,'JPM-88310494');
  const late=act(w,{type:'work_propose',work_item_id:summit.id,allocations:[{invoice_id:'INV-2013',amount_minor:1470000}],adjustments:[{invoice_id:'INV-2013',kind:'early_pay_discount',amount_minor:30000}],confidence:0.7,reason:'Customer took the 2% discount shown on their terms.'},agent);
  expect(late.outcome).toBe('awaiting_approval');expect(late.proposal.gaps.join(' ')).toMatch(/early-payment discount/);
  act(w,{type:'work_decide',work_item_id:summit.id,decision:'reject',reason:'They paid on day 26; terms only allow the discount within 10 days. Apply the cash and chase the $300.'},dana);
  expect(item(w,'JPM-88310494').state).toBe('rejected');expect(item(w,'JPM-88310494').last_rejection.reason).toMatch(/day 26/);expect(agentQueue(w).some((row:any)=>row.id===summit.id)).toBe(true);
  expect(w.precedents.at(-1)).toMatchObject({source:'rejection',agent_proposal:{adjustment_kinds:['early_pay_discount']},human:{decision:'reject'}});
  const revised=act(w,{type:'work_propose',work_item_id:summit.id,allocations:[{invoice_id:'INV-2013',amount_minor:1470000}],chase:{invoice_id:'INV-2013',amount_minor:30000},confidence:0.9,reason:'Per Dana: discount disallowed after day 10; apply the cash and send a short-pay notice for $300.'},agent);
  expect(revised.outcome).toBe('awaiting_approval');
  act(w,{type:'work_decide',work_item_id:summit.id,decision:'approve',reason:'Send it'},dana);
  const followUp=w.workItems.find((row:any)=>row.kind==='follow_up');expect(followUp.state).toBe('scheduled');expect(followUp.amount_minor).toBe(30000);
  expect(w.messages.some((row:any)=>row.direction==='outbound'&&/Short payment on INV-2013/.test(row.subject))).toBe(true);
  // Time passes: Summit pays the balance before the follow-up is due, so nobody has to chase again.
  act(w,{type:'advance_to',at:'2026-11-03T13:00:00.000Z'});
  const balance=item(w,'JPM-88310540');
  expect(act(w,{type:'work_propose',work_item_id:balance.id,allocations:[{invoice_id:'INV-2013',amount_minor:30000}],confidence:0.95,reason:'Memo cites INV-2013 and equals the chased balance.'},agent).outcome).toBe('auto_approved');
  expect(w.workItems.find((row:any)=>row.id===followUp.id).state).toBe('closed');balanced(w);
});

test('duplicate cash is held, unidentified cash is asked about, and outages delay posting without losing the approval',()=>{
  const w=onboarded();act(w,{type:'advance_time',hours:24});
  act(w,{type:'work_propose',work_item_id:item(w,'JPM-88310431').id,allocations:[{invoice_id:'INV-2001',amount_minor:128400}],confidence:0.95,reason:'Memo cites INV-2001 and the amount matches.'},agent);
  act(w,{type:'advance_time',hours:48});
  const duplicate=item(w,'JPM-88310526');
  denied(w,{type:'work_propose',work_item_id:duplicate.id,allocations:[{invoice_id:'INV-2001',amount_minor:128400}],confidence:0.9,reason:'Apply to the invoice in the memo.'},agent,'invoice_already_paid');
  denied(w,{type:'work_propose',work_item_id:duplicate.id,allocations:[],confidence:0.9,reason:'Leave it somewhere for now.'},agent,'unapplied_cash_unacknowledged');
  const hold=act(w,{type:'work_propose',work_item_id:duplicate.id,allocations:[],hold_on_account:true,confidence:0.9,reason:'INV-2001 is already paid; this repeats JPM-88310431. Hold on account until AR decides refund or credit.'},agent);
  expect(hold.outcome).toBe('awaiting_approval');
  act(w,{type:'set_fault',system:'netsuite',mode:'offline'});
  const blocked=act(w,{type:'work_decide',work_item_id:duplicate.id,decision:'approve',reason:'Keep it as credit on account'},dana);
  expect(blocked.blocked).toBe('connection_unavailable');expect(item(w,'JPM-88310526').state).toBe('approved');expect(item(w,'JPM-88310526').posting_error.code).toBe('connection_unavailable');
  expect(w.workLog.at(-1)).toMatchObject({action:'post',allowed:false});
  act(w,{type:'set_fault',system:'netsuite',mode:'healthy'});
  expect(item(w,'JPM-88310526').state).toBe('posted');expect(w.bankReceipts.find((row:any)=>row.bank_reference==='JPM-88310526').status).toBe('on_account');
  expect((summarize(w) as any).unapplied_cash_minor).toBeGreaterThanOrEqual(128400);balanced(w);
  const view:any=workItemView(w,item(w,'JPM-88310519').id,{find});
  expect(view.features.payer.name_matches).toStrictEqual([]);
  expect(view.candidate_invoices.filter((row:any)=>row.reasons.includes('open balance equals the receipt')).map((row:any)=>row.invoice_id).sort()).toStrictEqual(['INV-2015','INV-2016']);
});

test('people teach a new deduction once; the seat proposes the policy and the next one posts by itself',()=>{
  const w=onboarded();act(w,{type:'advance_to',at:'2026-11-03T13:00:00.000Z'});
  const first=item(w,'JPM-88310533'),view:any=workItemView(w,first.id,{find});
  expect(view.remittances[0].rows[1]).toMatchObject({invoice_id:'INV-2008',deduction_code:'PROMO-Q4',deduction_minor:12000});
  const question=act(w,{type:'work_ask',work_item_id:first.id,to_role:'accountant',question:'Great Lakes deducted $120 on INV-2008 with code PROMO-Q4. Is that a valid deduction, and which account?'},agent).question;
  act(w,{type:'work_answer',question_id:question.id,answer:'PROMO-Q4 is our Q4 scan-back promotion. Valid; book it to promotional allowances, every time this quarter.'},dana);
  const resolution={allocations:[{invoice_id:'INV-2007',amount_minor:800000},{invoice_id:'INV-2008',amount_minor:638000}],adjustments:[{invoice_id:'INV-2008',kind:'promotional_allowance',amount_minor:12000}]};
  expect(act(w,{type:'work_propose',work_item_id:first.id,...resolution,confidence:0.85,reason:'Dana confirmed PROMO-Q4 is a valid scan-back deduction.'},agent).outcome).toBe('awaiting_approval');
  act(w,{type:'work_decide',work_item_id:first.id,decision:'approve'},dana);
  const approval=w.precedents.find((row:any)=>row.source==='approval'&&row.work_item_id===first.id);
  expect(approval.features.deduction_codes).toStrictEqual(['PROMO-Q4']);
  denied(w,{type:'policy_propose',rule:{kind:'deduction_code',code:'PROMO-Q4',adjustment:'promotional_allowance',customer_ids:['cus-glbd'],max_bps:300},title:'Accept PROMO-Q4 scan-backs',rationale:'Dana said so.',evidence:{}},agent,'policy_evidence_required');
  const policy=act(w,{type:'policy_propose',rule:{kind:'deduction_code',code:'PROMO-Q4',adjustment:'promotional_allowance',customer_ids:['cus-glbd'],max_bps:300},title:'Accept PROMO-Q4 scan-backs from Great Lakes',rationale:'The AR lead confirmed the Q4 scan-back program and approved the first deduction.',evidence:{precedent_ids:[approval.id]}},agent).policy;
  expect(policy.backtest).toMatchObject({covered:1,support:1,contrary:0});
  act(w,{type:'policy_decide',policy_id:policy.id,decision:'approve',reason:'Q4 program runs through December'});
  act(w,{type:'advance_to',at:'2026-11-10T13:00:00.000Z'});
  const second=act(w,{type:'work_propose',work_item_id:item(w,'JPM-88310557').id,allocations:[{invoice_id:'INV-2017',amount_minor:910000},{invoice_id:'INV-2018',amount_minor:530500}],adjustments:[{invoice_id:'INV-2018',kind:'promotional_allowance',amount_minor:9500}],confidence:0.95,reason:'Remittance lists both invoices with a PROMO-Q4 deduction covered by policy.'},agent);
  expect(second.outcome).toBe('auto_approved');expect(second.proposal.policies.map((row:any)=>row.id)).toContain(policy.id);balanced(w);
  const briefing=workBriefing(w);
  expect(briefing.policies.active.length).toBe(7);expect(briefing.recent_feedback[0].decision).toBe('approve');
});

test('approving a policy releases work already waiting on it; the score counts only what the key says is right',()=>{
  const w=createWorld({kind:'cash-application',seed:42},'world-test');act(w,{type:'seat_configure',enabled:true});act(w,{type:'advance_time',hours:24});
  const anchor=item(w,'JPM-88310431');
  expect(act(w,{type:'work_propose',work_item_id:anchor.id,allocations:[{invoice_id:'INV-2001',amount_minor:128400}],confidence:0.95,reason:'Memo cites INV-2001 and the amount matches.'},agent).outcome).toBe('awaiting_approval');
  const policy=act(w,{type:'policy_propose',rule:{kind:'exact_match'},title:'Exact referenced payments',rationale:'Every exact referenced payment last year was applied as billed.',evidence:{queries:[{sql:'SELECT COUNT(*) FROM applied_lines',finding:'135 of 135'}]}},agent).policy;
  const released=act(w,{type:'policy_decide',policy_id:policy.id,decision:'approve'}).released;
  expect(released.map((row:any)=>row.work_item_id)).toStrictEqual([anchor.id]);expect(item(w,'JPM-88310431').state).toBe('posted');
  const score=scoreCashApplication(w);
  expect(score.summary).toMatchObject({cases:14,delivered:4,posted:1,auto_posted:1,auto_correct:1,false_auto_posts:[],precision_of_automation:1});
});

test('every approval decision can carry its why, and it reaches the audit event',()=>{
  const w=createWorld({kind:'supplier-fraud',seed:3,orderCount:2,approvalThresholdMinor:100},'world-approvals');
  const requested=act(w,{type:'pay_bill',bill_id:w.bills[0].id},{id:'operator-1',role:'operator'});
  expect(requested.status).toBe('awaiting_approval');
  const decided=applyAction(w,{type:'decide_approval',approval_id:requested.approval_id,decision:'reject',reason:'Vendor bank details changed yesterday; verify by phone first.'},controller);
  expect(w.approvals.find((row:any)=>row.id===requested.approval_id)).toMatchObject({status:'rejected',decided_by:'controller-local',decision_reason:'Vendor bank details changed yesterday; verify by phone first.'});
  expect(decided.events.find(event=>event.type==='approval.decided')).toMatchObject({reason:'Vendor bank details changed yesterday; verify by phone first.'});
});

test('a judge can drop in a bank line of their own; it becomes work the same way, once',()=>{
  const w=onboarded();
  const line={type:'record_bank_receipt',bank_reference:'JPM-JUDGE-0001',amount_minor:5794000,channel:'wire',payer_name:'HARBORVIEW HOTEL GROUP',memo:'WIRE IN HARBORVIEW HOTEL GROUP INV 2003',external_event_id:'console:JPM-JUDGE-0001'};
  denied(w,line,agent,'controller_required');
  const recorded=act(w,line);
  expect(recorded.receipt).toMatchObject({bank_reference:'JPM-JUDGE-0001',status:'unapplied',unapplied_minor:5794000});
  expect(w.workItems.at(-1)).toMatchObject({state:'new',created_by:'sync',subject_id:recorded.receipt.id});
  expect(act(w,line).replayed).toBe(true);expect(w.workItems.length).toBe(1);
  denied(w,{...line,external_event_id:'console:other'},controller,'duplicate_bank_reference');
  // $60 short is outside the learned $50 bound, so even a confident proposal waits for a person.
  const proposal=act(w,{type:'work_propose',work_item_id:w.workItems.at(-1).id,allocations:[{invoice_id:'INV-2003',amount_minor:5794000}],adjustments:[{invoice_id:'INV-2003',kind:'bank_fee',amount_minor:6000}],confidence:0.9,reason:'Looks like a bigger intermediary fee on the same wire.'},agent);
  expect(proposal.outcome).toBe('awaiting_approval');expect(proposal.proposal.gaps.join(' ')).toMatch(/bank fee of \$60\.00/);balanced(w);
});

test('a proposal a person rejected cannot come back unchanged; a changed one can',()=>{
  const w=onboarded();act(w,{type:'advance_to',at:'2026-10-28T13:00:00.000Z'});
  const summit=item(w,'JPM-88310494')!;
  // Summit took 2% on day 26; terms allow 10, so no policy covers the discount and the proposal waits for a person.
  const discount={type:'work_propose',work_item_id:summit.id,allocations:[{invoice_id:'INV-2013',amount_minor:1470000}],adjustments:[{invoice_id:'INV-2013',kind:'early_pay_discount',amount_minor:30000}],confidence:0.9,reason:'Summit took its 2% discount; book it as an early-payment discount.'};
  expect(act(w,discount,agent).outcome).toBe('awaiting_approval');
  act(w,{type:'work_decide',work_item_id:summit.id,decision:'reject',reason:'Taken 26 days after the invoice; terms allow 10. Chase it.'},dana);
  expect(item(w,'JPM-88310494').rejected_proposals).toHaveLength(1);
  // The same move under new words is refused by the gateway, with the person's reason in the refusal.
  denied(w,{...discount,reason:'On reflection the discount still looks earned to me.'},agent,'repeat_proposal');
  expect(()=>act(w,{...discount,reason:'Second try.'},agent)).toThrowSatisfying((error:any)=>error instanceof DomainError&&/Chase it/.test(error.message));
  expect(item(w,'JPM-88310494').state).toBe('rejected');
  // A different move goes through, and the item keeps every proposal it ever received.
  const chase=act(w,{type:'work_propose',work_item_id:summit.id,allocations:[{invoice_id:'INV-2013',amount_minor:1470000}],chase:{invoice_id:'INV-2013',amount_minor:30000},confidence:0.9,reason:'Discount disallowed: apply the cash and chase the $300.'},agent);
  expect(chase.outcome).toBe('awaiting_approval');
  expect(item(w,'JPM-88310494').proposals.map((row:any)=>row.adjustment_kinds)).toStrictEqual([['early_pay_discount'],[]]);
  // The score reports the forbidden move even though a person caught it.
  const score=scoreCashApplication(w),row=score.cases.find((entry:any)=>entry.bank_reference==='JPM-88310494');
  expect(row!.forbidden_hits).toStrictEqual(['P-1 proposed early_pay_discount']);expect(score.summary.forbidden_proposals).toHaveLength(1);expect(score.summary.should_not_auto_posted).toStrictEqual([]);
});

test('a policy bound wider than its evidence is reported as headroom; the simulated controller refuses it',()=>{
  const w=createWorld({kind:'cash-application',seed:42},'world-bound');
  const tight=backtestRule(w,{kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:4500,channels:['wire']});
  expect(tight.contrary).toBe(0);expect(tight.bound).toStrictEqual({rule:4500,unit:'cents',largest_supporting:4500,headroom_pct:0});
  const wide=backtestRule(w,{kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:5000,channels:['wire']});
  expect(wide.contrary).toBe(0);expect(wide.bound).toMatchObject({rule:5000,largest_supporting:4500,headroom_pct:11.1});
  expect(backtestRule(w,{kind:'exact_match'}).bound).toBeNull();
  expect(backtestRule(w,{kind:'deduction_code',code:'PROMO-Q4',adjustment:'promotional_allowance',customer_ids:['cus-glbd'],max_bps:200}).bound).toStrictEqual({rule:200,unit:'bps',largest_supporting:null,headroom_pct:null});
});

test('ablation: trusting the agent\'s confidence posts what the gateway would hold, and the score says so',()=>{
  const proposal=(id:string)=>({type:'work_propose',work_item_id:id,allocations:[{invoice_id:'INV-2014',amount_minor:189000}],adjustments:[{invoice_id:'INV-2014',kind:'bank_fee',amount_minor:31000}],confidence:0.97,reason:'A $310 fee, I am confident.'});
  const w=onboarded();act(w,{type:'advance_to',at:'2026-10-28T13:00:00.000Z'});
  expect(act(w,proposal(item(w,'JPM-88310502').id),agent).outcome).toBe('awaiting_approval');
  const ablated=onboarded();act(ablated,{type:'advance_to',at:'2026-10-28T13:00:00.000Z'});
  denied(ablated,{type:'seat_configure',ablation:{bogus:true}},controller,'invalid_seat_setting');
  denied(ablated,{type:'seat_configure',ablation:{trust_agent_confidence:true}},agent,'work_permission_denied');
  act(ablated,{type:'seat_configure',ablation:{trust_agent_confidence:true}});
  expect(summarize(ablated).seat!.ablation.trust_agent_confidence).toBe(true);
  const result=act(ablated,proposal(item(ablated,'JPM-88310502').id),agent);
  expect(result.outcome).toBe('auto_approved');expect(item(ablated,'JPM-88310502').state).toBe('posted');
  const score=scoreCashApplication(ablated).summary;
  expect(score.false_auto_posts).toStrictEqual(['JPM-88310502']);expect(score.should_not_auto_posted).toStrictEqual(['JPM-88310502']);expect(score.forbidden_proposals[0]!).toMatch(/^JPM-88310502: P-\d+ proposed bank_fee$/);
  expect(score.by_set.planted.precision_of_automation).toBe(0);
  balanced(ablated);
});

test('a company can start with no history to learn from, and bad controls are refused',()=>{
  expect(()=>createWorld({kind:'cash-application',seed:42,cashControls:{history:'yes' as any}},'x')).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='invalid_scenario');
  expect(()=>createWorld({kind:'cash-application',seed:42,cashControls:{heldOut:true} as any},'x')).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='invalid_scenario');
  expect(()=>createWorld({kind:'bank-reconciliation',cashControls:{history:false}},'x')).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code==='invalid_scenario');
  const w=createWorld({kind:'cash-application',seed:42,cashControls:{history:false}},'world-nohistory');
  expect(w.cashHistory.receipts).toHaveLength(0);expect(w.seat.onboarding.status).toBe('done');expect(summarize(w).seat!.history_imported).toBe(false);
  expect(backtestRule(w,{kind:'exact_match'}).covered).toBe(0);
  expect(createWorld({kind:'cash-application',seed:42},'world-history').cashHistory.receipts.length).toBeGreaterThan(250);
});

test('a judge records a bank line with its answer key; the seat works it unseen and the score reports a judge set',async()=>{
  const w=onboarded();act(w,{type:'advance_to',at:'2026-10-27T13:00:00.000Z'});
  const key={type:'record_case_expectation',bank_reference:'JPM-99000001',title:'Wire $50 short, above the learned fee bound',expected:{allocations:[{invoice_id:'INV-2004',amount_minor:2425000}],chase:{invoice_id:'INV-2004',amount_minor:5000}},forbid:{adjustment_kinds:['bank_fee']},auto:false,truth:'Harborview fees have always been $15 to $45; a $50 difference is not a fee we absorb. Apply $24,250 to INV-2004 and send a short-pay notice for the $50.'};
  // The line comes first; the key needs a line to score, and only the controller may record one.
  denied(w,key,controller,'unknown_bank_reference');
  act(w,{type:'record_bank_receipt',bank_reference:'JPM-99000001',amount_minor:2425000,channel:'wire',payer_name:'HARBORVIEW HOTEL GROUP',memo:'WIRE IN HARBORVIEW HOTEL GROUP INV 2004',external_event_id:'judge:JPM-99000001'});
  denied(w,key,agent,'controller_required');
  denied(w,{...key,forbid:{adjustment_kinds:['tip']}},controller,'invalid_case_expectation');
  denied(w,{...key,auto:'no'},controller,'invalid_case_expectation');
  denied(w,{...key,truth:'short'},controller,'invalid_case_expectation');
  denied(w,{...key,expected:{}},controller,'invalid_case_expectation');
  expect(act(w,key).case).toMatchObject({set:'judge',auto:false,first_move:'ask'});
  denied(w,key,controller,'case_expectation_exists');
  expect(summarize(w).seat!.judge_cases).toBe(1);
  const judge=item(w,'JPM-99000001')!;expect(judge.state).toBe('new');
  // The seat sees the bank line, the invoices and the history, never the key or the truth.
  for(const view of [workItemView(w,judge.id,{find}),workBriefing(w)])expect(JSON.stringify(view)).not.toMatch(/not a fee we absorb|judge/);
  // It asks; the simulated AR lead answers from the judge's truth; the right proposal is approved and posted.
  act(w,{type:'seat_configure',colleagues:true});
  const work=(_world:string,input:any,actor:any)=>({result:act(w,input,actor)}),caseFile=async(_situation:string,_what:string,truth:string)=>({text:truth,phrased_by:'case-file' as const});
  act(w,{type:'work_ask',work_item_id:judge.id,to_role:'accountant',question:'Harborview wired $50 short of INV-2004. Is that a fee we absorb, or do we chase it?'},agent);
  await colleagueTick('world-test',w,work,caseFile);
  expect(w.questions.at(-1)).toMatchObject({status:'answered',answered_by:'sim:dana.ruiz'});expect(w.questions.at(-1).answer).toMatch(/not a fee we absorb/);
  expect(act(w,{type:'work_propose',work_item_id:judge.id,allocations:[{invoice_id:'INV-2004',amount_minor:2425000}],chase:{invoice_id:'INV-2004',amount_minor:5000},confidence:0.9,reason:'Per the AR lead: apply the cash and chase the $50.'},agent).outcome).toBe('awaiting_approval');
  await colleagueTick('world-test',w,work,caseFile);
  expect(item(w,'JPM-99000001').state).toBe('posted');
  const score=scoreCashApplication(w),judgeScore=score.summary.by_set.judge;
  expect(score.cases.find((row:any)=>row.bank_reference==='JPM-99000001')).toMatchObject({set:'judge',case:'judge_scenario',first_move:'ask',correct:true,approval:'human'});
  expect(judgeScore).toMatchObject({cases:1,correct:1,auto_posted:0,forbidden_proposals:[],should_not_auto_posted:[],missed_auto:[]});expect(judgeScore.human_touches).toBeGreaterThanOrEqual(2);
  expect(score.summary.by_set.planted.cases).toBe(4);
  balanced(w);
});

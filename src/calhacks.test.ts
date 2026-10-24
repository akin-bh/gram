import {test,expect} from 'bun:test';
import {createWorld,applyAction,summarize,DomainError} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {agentQueue,whyTimeline} from './work.ts';
import {scoreSeat} from './cash-score.ts';
import {calhacksDomain,EVENT,W9_THRESHOLD_MINOR} from './calhacks.ts';

const agent:Actor={id:'agent-world:test',role:'agent'},controller:Actor={id:'controller-local',role:'controller'},lead:Actor={id:'sponsorship.lead',role:'accountant'};
const act=(w:World,action:Action,actor:Actor=controller)=>applyAction(w,action,actor).result;
const denied=(w:World,action:Action,actor:Actor,code:string)=>{const before=structuredClone(w);expect(()=>act(w,action,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);};
const balanced=(w:World)=>{const s=summarize(w);expect(s.reconciliation.balanced).toBe(true);expect(s.reconciliation.bank_ledger_difference_minor).toBe(0);};
const find=(rows:any[],id:any,label:string)=>rows.find(row=>row.id===id)??(()=>{throw new Error(`${label} not found`);})();
const caseItem=(w:World,reference:string)=>calhacksDomain.caseItem(w,w.sponsorCaseKey.find((row:any)=>row.reference===reference));
const balance=(w:World,id:string)=>w.accounts.find((row:any)=>row.id===id)?.balance_minor??0;
/** The policies the seat is expected to learn from last year's books, with the bounds the records support. */
const POLICIES=[
  {rule:{kind:'payment_settles_invoice'},title:'A payment equal to the cited invoice settles it'},
  {rule:{kind:'multi_invoice_payment'},title:'One payment for several invoices is split across them'},
  {rule:{kind:'payer_alias',payer_name:'QUILL HOLDINGS LLC',sponsor_ids:['spn-quill']},title:'Quill Holdings pays for Quill Labs'},
  {rule:{kind:'wire_fee_bound',max_minor:3_500},title:'Wire fees up to $35'},
  {rule:{kind:'card_fee_rate',rate_bps:290,fixed_minor:30,tolerance_minor:100},title:'Card payments net of Stripe\'s 2.9% + 30¢'},
  {rule:{kind:'recognize_on_event'},title:'Sponsorship fees are income once the event has happened'},
  {rule:{kind:'prize_fund_passthrough'},title:'Prize funds are owed to the winners, never income'},
  {rule:{kind:'payment_within_limit'},title:'Approve requests within limit, with document, no duplicate, W-9 for reportable prizes'},
];
function onboarded(){
  const w=createWorld({kind:'calhacks',seed:42},'world-calhacks');
  for(const policy of POLICIES){
    const proposed=act(w,{type:'policy_propose',rule:policy.rule,title:policy.title,rationale:'Last year\'s books handled every comparable case this way.',evidence:{queries:[{sql:'SELECT COUNT(*) FROM allocations',finding:'all agree'}]}},agent).policy;
    expect(proposed.backtest.contrary).toBe(0);expect(proposed.backtest.support).toBeGreaterThan(0);
    act(w,{type:'policy_decide',policy_id:proposed.id,decision:'approve',reason:'Matches how we work'});
  }
  act(w,{type:'seat_configure',enabled:true});
  return w;
}

test('the books open balanced: fees deferred, prize funds owed to the winners, nothing recognized',()=>{
  const w=createWorld({kind:'calhacks',seed:42},'w');
  balanced(w);
  expect(w.sponsorInvoices).toHaveLength(10);expect(w.sponsorCaseKey).toHaveLength(14);
  expect(balance(w,'sponsorship-income')).toBe(0);expect(-balance(w,'deferred-sponsorship')).toBe(12_600_000);expect(-balance(w,'prize-fund-owed')).toBe(2_100_000);
  expect(w.seat.people.every((person:any)=>person.simulated)).toBe(true);
  expect(calhacksDomain.historySummary(w).records).toBeGreaterThan(30);
});

test('policies learned from last year cover the ordinary cases, and the gateway posts them without a person; the exceptions wait',()=>{
  const w=onboarded();
  act(w,{type:'advance_to',at:'2026-09-21T17:00:00.000Z'});
  const exact=caseItem(w,'WF-55500101');
  act(w,{type:'work_propose',work_item_id:exact.id,allocations:[{invoice_id:'SI-1302',amount_minor:2_000_000}],confidence:0.95,reason:'Lattice paid its Gold fee as invoiced.'},agent);
  expect(find(w.workItems,exact.id,'Item').state).toBe('posted');expect(find(w.sponsorInvoices,'SI-1302','Invoice').status).toBe('paid');
  // Before the event, a fee stays deferred; the gateway refuses to recognize it early.
  expect(balance(w,'sponsorship-income')).toBe(0);
  act(w,{type:'advance_to',at:'2026-09-23T17:00:00.000Z'});
  const short=caseItem(w,'WF-55500118');
  denied(w,{type:'work_propose',work_item_id:short.id,allocations:[{invoice_id:'SI-1301',amount_minor:2_996_500}],lines:[{invoice_id:'SI-1301',kind:'wire_fee',amount_minor:3_500}],recognize:['SI-1301'],confidence:0.9,reason:'Recognize now.'},agent,'recognition_before_event');
  act(w,{type:'work_propose',work_item_id:short.id,allocations:[{invoice_id:'SI-1301',amount_minor:2_996_500}],lines:[{invoice_id:'SI-1301',kind:'wire_fee',amount_minor:3_500}],confidence:0.9,reason:'Northwind\'s wire arrived $35 short: the bank\'s fee.'},agent);
  expect(find(w.workItems,short.id,'Item').state).toBe('posted');expect(balance(w,'bank-fee-expense')).toBe(3_500);
  act(w,{type:'advance_to',at:'2026-09-28T17:00:00.000Z'});
  const both=caseItem(w,'WF-55500133');
  // A prize fund is never income: recognizing it is refused in code.
  denied(w,{type:'work_propose',work_item_id:both.id,allocations:[{invoice_id:'SI-1303',amount_minor:1_200_000},{invoice_id:'SI-1304',amount_minor:1_600_000}],recognize:['SI-1304'],confidence:0.9,reason:'All income.'},agent,'prize_fund_is_not_income');
  act(w,{type:'work_propose',work_item_id:both.id,allocations:[{invoice_id:'SI-1303',amount_minor:1_200_000},{invoice_id:'SI-1304',amount_minor:1_600_000}],confidence:0.95,reason:'Harbor paid its Silver fee and the $16,000 prize fund together.'},agent);
  expect(find(w.workItems,both.id,'Item').state).toBe('posted');expect(-balance(w,'prize-fund-owed')).toBe(2_100_000);
  act(w,{type:'advance_to',at:'2026-10-06T17:00:00.000Z'});
  const alias=caseItem(w,'WF-55500147'),card=caseItem(w,'WF-55500162');
  act(w,{type:'work_propose',work_item_id:alias.id,allocations:[{invoice_id:'SI-1305',amount_minor:600_000}],confidence:0.92,reason:'Quill Holdings pays for Quill Labs, as last year.'},agent);
  expect(find(w.workItems,alias.id,'Item').state).toBe('posted');
  act(w,{type:'work_propose',work_item_id:card.id,allocations:[{invoice_id:'SI-1306',amount_minor:1_165_170}],lines:[{invoice_id:'SI-1306',kind:'card_fee',amount_minor:34_830}],confidence:0.92,reason:'Beacon paid by card; Stripe kept 2.9% + 30¢.'},agent);
  expect(find(w.workItems,card.id,'Item').state).toBe('posted');expect(balance(w,'card-fee-expense')).toBe(34_830);
  // A sponsor that pays its fee but not the prize fund it underwrote is chased, and a notice needs a person.
  act(w,{type:'advance_to',at:'2026-10-09T17:00:00.000Z'});
  const partial=caseItem(w,'WF-55500178');
  act(w,{type:'work_propose',work_item_id:partial.id,allocations:[{invoice_id:'SI-1307',amount_minor:2_000_000}],chase:{invoice_id:'SI-1308',amount_minor:500_000},confidence:0.8,reason:'Pacific paid the Gold fee; the $5,000 prize fund is still due.'},agent);
  expect(find(w.workItems,partial.id,'Item').state).toBe('proposed');
  act(w,{type:'work_decide',work_item_id:partial.id,decision:'approve',reason:'Chase the prize fund.'},lead);
  expect(find(w.workItems,partial.id,'Item').state).toBe('posted');expect(w.messages.some((row:any)=>row.direction==='outbound'&&/SI-1308/.test(row.subject))).toBe(true);
  balanced(w);
});

test('payment requests: over-limit rerouted, duplicates refused, a reportable prize waits for its W-9, and a clean one posts alone',()=>{
  const w=onboarded();
  act(w,{type:'advance_to',at:'2026-10-22T17:00:00.000Z'});
  const over=caseItem(w,'PR-901'),clean=caseItem(w,'PR-902'),dup=caseItem(w,'PR-903');
  denied(w,{type:'work_propose',work_item_id:over.id,decision:'approve',confidence:0.9,reason:'Fine, pay it now.'},agent,'approval_limit_exceeded');
  act(w,{type:'work_propose',work_item_id:over.id,decision:'reroute',route_to:'appr-director',confidence:0.9,reason:'The Logistics Lead\'s limit is $2,500; the Director of Finance covers $4,200.'},agent);
  expect(find(w.workItems,over.id,'Item').state).toBe('proposed');
  act(w,{type:'work_propose',work_item_id:clean.id,decision:'approve',confidence:0.95,reason:'Within limit, receipt attached, no duplicate.'},agent);
  expect(find(w.workItems,clean.id,'Item').state).toBe('posted');expect(find(w.paymentRequests,'PR-902','Request').status).toBe('approved_for_payment');expect(balance(w,'supplies-expense')).toBe(18_000);
  denied(w,{type:'work_propose',work_item_id:dup.id,decision:'approve',confidence:0.9,reason:'Pay it as approved.'},agent,'possible_duplicate');
  act(w,{type:'advance_to',at:'2026-10-27T17:00:00.000Z'});
  const prize=caseItem(w,'PR-904'),paid=caseItem(w,'PR-905');
  expect(find(w.paymentRequests,'PR-904','Request').amount_minor).toBeGreaterThanOrEqual(W9_THRESHOLD_MINOR);
  denied(w,{type:'work_propose',work_item_id:prize.id,decision:'approve',confidence:0.9,reason:'Winner confirmed.'},agent,'tax_form_missing');
  act(w,{type:'work_propose',work_item_id:prize.id,decision:'hold_missing_tax_form',confidence:0.9,reason:'A prize of $8,000 is reportable; the team\'s W-9 is not on file.'},agent);
  expect(find(w.workItems,prize.id,'Item').state).toBe('proposed');
  act(w,{type:'work_propose',work_item_id:paid.id,decision:'approve',confidence:0.95,reason:'Winner confirmed, W-9 on file, within the Sponsorship Lead\'s limit.'},agent);
  expect(find(w.workItems,paid.id,'Item').state).toBe('posted');expect(balance(w,'prizes-payable')).toBe(-300_000);expect(-balance(w,'prize-fund-owed')).toBe(2_100_000-300_000);
  balanced(w);
});

test('when the event ends, deferred fees become income under policy; a late payer is recognized at once; a reversal defers it again',()=>{
  const w=onboarded();
  act(w,{type:'advance_to',at:'2026-09-21T17:00:00.000Z'});
  act(w,{type:'work_propose',work_item_id:caseItem(w,'WF-55500101').id,allocations:[{invoice_id:'SI-1302',amount_minor:2_000_000}],confidence:0.95,reason:'Paid as invoiced.'},agent);
  act(w,{type:'advance_to',at:EVENT.ends_at});
  const close=w.workItems.find((row:any)=>row.kind==='event_close');expect(close).toBeTruthy();expect(agentQueue(w).some((row:any)=>row.id===close.id)).toBe(true);
  act(w,{type:'work_propose',work_item_id:close.id,recognize:['SI-1302'],confidence:0.95,reason:'The event ended; Lattice\'s paid fee is income.'},agent);
  expect(find(w.workItems,close.id,'Item').state).toBe('posted');expect(balance(w,'sponsorship-income')).toBe(-2_000_000);expect(find(w.sponsorInvoices,'SI-1302','Invoice').recognized_minor).toBe(2_000_000);
  act(w,{type:'advance_to',at:'2026-10-28T17:00:00.000Z'});
  const late=caseItem(w,'WF-55500210');
  act(w,{type:'work_propose',work_item_id:late.id,allocations:[{invoice_id:'SI-1310',amount_minor:2_000_000}],recognize:['SI-1310'],confidence:0.95,reason:'Juniper paid after the event; income at once.'},agent);
  expect(find(w.workItems,late.id,'Item').state).toBe('posted');expect(balance(w,'sponsorship-income')).toBe(-4_000_000);balanced(w);
  const reversed=act(w,{type:'work_reverse',work_item_id:late.id,reason:'Juniper\'s wire was for next year\'s sponsorship, not this one.'},lead);
  expect(find(w.workItems,late.id,'Item').state).toBe('reversed');expect(balance(w,'sponsorship-income')).toBe(-2_000_000);expect(find(w.sponsorInvoices,'SI-1310','Invoice').status).toBe('open');
  expect(find(w.workItems,reversed.reposted_as,'Reposting').reversed_from).toBe(late.id);balanced(w);
  expect(whyTimeline(w,'SI-1310').timeline.map((row:any)=>row.action)).toEqual(expect.arrayContaining(['propose','approve','post','reverse']));
});

test('the score reads the answer key: planted cases, precision of automation, and what must not happen',()=>{
  const w=onboarded();
  act(w,{type:'advance_to',at:'2026-09-23T17:00:00.000Z'});
  act(w,{type:'work_propose',work_item_id:caseItem(w,'WF-55500101').id,allocations:[{invoice_id:'SI-1302',amount_minor:2_000_000}],confidence:0.95,reason:'Paid as invoiced.'},agent);
  const score=scoreSeat(w);
  expect(score.summary.precision_of_automation).toBe(1);expect(score.summary.auto_posted).toBe(1);expect(score.summary.forbidden_proposals).toHaveLength(0);
  expect(score.cases.find((row:any)=>row.bank_reference==='WF-55500101')).toMatchObject({posted:true,correct:true,approval:'policy'});
  expect(score.cases.find((row:any)=>row.bank_reference==='PR-904')).toMatchObject({delivered:false});
});

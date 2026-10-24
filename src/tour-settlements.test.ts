import {test,expect} from 'bun:test';
import {createWorld,applyAction,summarize,DomainError} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {workBriefing,workItemView,agentQueue} from './work.ts';
import {scoreSeat} from './cash-score.ts';
import {colleagueTick} from './colleague.ts';
import {tourDomain,TOUR_KIND} from './tour-settlements.ts';

const agent:Actor={id:'agent-world:test',role:'agent'},controller:Actor={id:'controller-local',role:'controller'},accountant:Actor={id:'tour.accountant',role:'accountant'};
const act=(w:World,action:Action,actor:Actor=controller)=>applyAction(w,action,actor).result;
const denied=(w:World,action:Action,actor:Actor,code:string)=>{const before=structuredClone(w);expect(()=>act(w,action,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w).toStrictEqual(before);};
const balanced=(w:World)=>{const s=summarize(w);expect(s.reconciliation.balanced).toBe(true);expect(s.reconciliation.bank_ledger_difference_minor).toBe(0);};
const find=(rows:any[],id:any,label:string)=>rows.find(row=>row.id===id)??(()=>{throw new Error(`${label} not found`);})();
const caseItem=(w:World,reference:string)=>tourDomain.caseItem(w,w.tourCaseKey.find((row:any)=>row.reference===reference));
/** The policies the seat is expected to learn from last season, with the bounds the records support. */
const POLICIES=[
  {rule:{kind:'deposit_settles_show'},title:'A deposit equal to the statement net settles the show'},
  {rule:{kind:'multi_show_deposit'},title:'One deposit for several shows is split across them'},
  {rule:{kind:'venue_alias',payer_name:'MELB ARENA OPERATIONS PTY LTD',venue_ids:['VEN-MEL']},title:'Melbourne arena pays under its operating company name'},
  {rule:{kind:'merchant_fee_bound',venue_ids:['VEN-MEL','VEN-SYD','VEN-BNE','VEN-PER','VEN-ADL','VEN-AKL'],max_bps:180},title:'Merchant fees up to 1.80% of gross'},
  {rule:{kind:'music_licence_rate',rate_bps:220,tolerance_minor:100},title:'Music licence at 2.20% of gross'},
  {rule:{kind:'advance_recoupment',venue_ids:['VEN-MEL']},title:'Melbourne recoups its ticketing advance on settlements'},
  {rule:{kind:'fx_tolerance',max_minor:1_000_000},title:'FX differences up to A$10,000 on NZD settlements'},
  {rule:{kind:'recognize_on_performance'},title:'Recognize revenue when a performed show settles'},
  {rule:{kind:'invoice_within_limit'},title:'Approve invoices within the approver\'s limit with a document on file'},
  {rule:{kind:'catering_recharge_bound',venue_ids:['VEN-MEL','VEN-BNE'],max_minor:2_500_000},title:'Catering recharges up to A$25,000'},
];
function onboarded(){
  const w=createWorld({kind:TOUR_KIND,seed:42},'world-tour');
  for(const policy of POLICIES){
    const proposed=act(w,{type:'policy_propose',rule:policy.rule,title:policy.title,rationale:'Every comparable settlement or invoice last season was handled this way; see the queries.',evidence:{queries:[{sql:'SELECT kind, gl_account, COUNT(*) FROM settled_lines GROUP BY 1, 2',finding:'Consistent coding, no contrary cases'}]}},agent).policy;
    expect(proposed.backtest.contrary,`${policy.rule.kind} contrary`).toBe(0);expect(proposed.backtest.support,`${policy.rule.kind} support`).toBeGreaterThan(0);
    act(w,{type:'policy_decide',policy_id:proposed.id,decision:'approve',reason:'Matches last season'});
  }
  act(w,{type:'seat_configure',enabled:true});
  return w;
}
const DAYS=tourDomain.bench.days;

test('the Live Nation seat seeds a real-structured company: AUD books, deferred revenue for sold shows, labeled fixtures, history to learn from',()=>{
  const w=createWorld({kind:TOUR_KIND,seed:42},'world-tour');
  expect(w.currency).toBe('AUD');expect(w.name).toBe('Live Nation Australasia');expect(w.seat.title).toMatch(/Tour Settlements Officer/);
  expect(w.seat.sources.real.some((row:string)=>/JR-93271/.test(row))).toBe(true);expect(w.seat.sources.simulated.length).toBeGreaterThan(3);
  expect(w.venues.every((row:any)=>row.simulated)).toBe(true);expect(w.approvers.every((row:any)=>row.simulated)).toBe(true);
  // Ticket money for sold shows sits in deferred revenue until the event, per the 10-K; nothing is recognized yet.
  const deferred=0-find(w.accounts,'deferred-revenue-events','Account').balance_minor,receivable=find(w.accounts,'settlement-receivable','Account').balance_minor;
  expect(deferred).toBe(receivable);expect(deferred).toBe(w.shows.reduce((total:number,show:any)=>total+show.gross_box_office_aud_minor,0));
  expect(find(w.accounts,'concert-revenue','Account').balance_minor).toBe(0);
  expect(w.tourHistory.settlements.length).toBeGreaterThan(30);expect(w.tourHistory.invoices.length).toBeGreaterThan(30);expect(w.tourHistory.deposits.some((row:any)=>row.original_currency==='NZD')).toBe(true);
  expect(w.tourCaseKey).toHaveLength(10);expect(w.tourCaseKey.filter((row:any)=>row.auto)).toHaveLength(4);
  expect(createWorld({kind:TOUR_KIND,seed:42},'world-tour')).toStrictEqual(w);
  balanced(w);
  // The briefing carries the licence parameter and its source; the console never gets the history or the key.
  expect(workBriefing(w).history.parameters.music_licence_bps).toBe(220);expect(tourDomain.hidden).toContain('tourCaseKey');
});

test('every planted expectation passes the hard checks and scores correct; forbidden moves are refused by code, not prompt',()=>{
  const w=onboarded();
  for(const day of DAYS){
    act(w,{type:'advance_to',at:`${day}T22:00:00.000Z`});
    for(const item of agentQueue(w).filter((row:any)=>row.kind!=='follow_up')){
      const entry=tourDomain.caseFor(w,item)!;expect(entry,item.id).toBeTruthy();
      const view=workItemView(w,item.id,{find});expect(JSON.stringify(view)).not.toMatch(/truth|judge/);
      const result=act(w,{type:'work_propose',work_item_id:item.id,...tourDomain.score.correction(entry),confidence:0.95,reason:`Settle ${item.id} as the records support.`},agent);
      if(entry.auto)expect(result.outcome,`${entry.case} should post alone`).toBe('auto_approved');
      else{expect(result.outcome,`${entry.case} must wait for a person`).toBe('awaiting_approval');act(w,{type:'work_decide',work_item_id:item.id,decision:'approve',reason:entry.truth},accountant);}
    }
  }
  const score=scoreSeat(w);
  expect(score.summary).toMatchObject({delivered:10,posted:10,correct:10,auto_posted:4,auto_correct:4,false_auto_posts:[],should_not_auto_posted:[],forbidden_proposals:[],missed_auto:[]});
  // Revenue: six performed shows recognized, the postponed Adelaide show still deferred.
  const adelaide=find(w.shows,'SH-3007','Show');expect(adelaide.recognized_minor).toBe(0);expect(w.shows.filter((row:any)=>row.recognized_minor>0)).toHaveLength(6);
  // The A$200,000 advance the Melbourne partner paid is a liability, reduced by the two A$20,000 recoupments.
  expect(find(w.accounts,'venue-advances','Account').balance_minor).toBe(-16_000_000);expect(find(w.venues,'VEN-MEL','Venue').contract.recoupable_advance_minor).toBe(16_000_000);
  expect(find(w.tourInvoices,'AP-9001','Invoice').status).toBe('rerouted_to_appr-ta');expect(find(w.tourInvoices,'AP-9003','Invoice').status).toBe('rejected_duplicate');expect(find(w.tourInvoices,'AP-9004','Invoice').status).toBe('held_missing_document');expect(find(w.tourInvoices,'AP-9002','Invoice').status).toBe('approved_for_payment');
  // Follow-ups were scheduled for the three chases and nothing is left in clearing.
  expect(w.workItems.filter((row:any)=>row.kind==='follow_up')).toHaveLength(3);expect((summarize(w) as any).settlements_clearing_minor).toBe(0);
  balanced(w);
});

test('the 10-K rules and the approval limits are hard checks: no recognition before performance, no approval over a limit, no deduction outside the contract',()=>{
  const w=onboarded();act(w,{type:'advance_to',at:'2026-03-27T22:00:00.000Z'});
  const adelaide=caseItem(w,'ANZ-77400178')!,overLimit=caseItem(w,'AP-9001')!,duplicate=caseItem(w,'AP-9003')!,missing=caseItem(w,'AP-9004')!,brisbane=caseItem(w,'ANZ-77400133')!;
  const adlEntry=tourDomain.caseFor(w,adelaide)!,deposit=adlEntry.expected.allocations[0][1];
  denied(w,{type:'work_propose',work_item_id:adelaide.id,allocations:[{show_id:'SH-3007',amount_minor:deposit}],lines:[],recognize:['SH-3007'],chase:{show_id:'SH-3007',amount_minor:adlEntry.expected.chase[1]},confidence:0.9,reason:'Recognize the Adelaide show now.'},agent,'recognition_before_performance');
  denied(w,{type:'work_propose',work_item_id:adelaide.id,allocations:[{show_id:'SH-3007',amount_minor:deposit}],lines:[{show_id:'SH-3007',kind:'catering',amount_minor:adlEntry.expected.chase[1]}],recognize:[],confidence:0.9,reason:'Code the gap as catering.'},agent,'deduction_not_in_contract');
  denied(w,{type:'work_propose',work_item_id:overLimit.id,decision:'approve',confidence:0.9,reason:'The PM approved it.'},agent,'approval_limit_exceeded');
  denied(w,{type:'work_propose',work_item_id:duplicate.id,decision:'approve',confidence:0.9,reason:'Approved by the Tour Accountant.'},agent,'possible_duplicate');
  denied(w,{type:'work_propose',work_item_id:missing.id,decision:'approve',confidence:0.9,reason:'Within limit.'},agent,'document_missing');
  // Even a person cannot approve those through this seat: the checks are the gateway's, not the agent's.
  denied(w,{type:'work_correct',work_item_id:overLimit.id,decision:'approve',reason:'Just approve it.'},accountant,'approval_limit_exceeded');
  // Brisbane's 2.4% merchant fee is inside the open receivable, so the hard checks allow coding it; the policy bound (1.8%) does not cover it, so it waits for a person, and the score counts the forbidden move if proposed.
  const bne=tourDomain.caseFor(w,brisbane)!,taken=bne.expected.lines.find((row:any)=>row[1]==='merchant_fee')[2]+bne.expected.chase[1];
  const result=act(w,{type:'work_propose',work_item_id:brisbane.id,allocations:bne.expected.allocations.map(([show_id,amount_minor]:[string,number])=>({show_id,amount_minor})),lines:bne.expected.lines.map(([show_id,kind,amount_minor]:[string,string,number])=>({show_id,kind,amount_minor:kind==='merchant_fee'?taken:amount_minor})),recognize:['SH-3004'],confidence:0.9,reason:'Code the fee as stated.'},agent);
  expect(result.outcome).toBe('awaiting_approval');expect(result.proposal.gaps.join(' ')).toMatch(/merchant fee/);
});

test('the simulated Tour Accountant answers from the answer key and refuses what the key rules out; a judge can add a deposit or an invoice with its own key',async()=>{
  const w=onboarded();act(w,{type:'seat_configure',colleagues:true});act(w,{type:'advance_to',at:'2026-03-24T22:00:00.000Z'});
  const work=(_world:string,input:any,actor:any)=>({result:act(w,input,actor)}),caseFile=async(_s:string,_w:string,truth:string)=>({text:truth,phrased_by:'case-file' as const});
  const perth=caseItem(w,'ANZ-77400162')!;
  act(w,{type:'work_ask',work_item_id:perth.id,to_role:'accountant',question:'Perth states gross A$12,000 below the ticket audit. Which gross do we book, and do we chase the difference?'},agent);
  await colleagueTick('world-tour',w,work,caseFile);
  expect(w.questions.at(-1)).toMatchObject({status:'answered',answered_by:'sim:tour.accountant'});expect(w.questions.at(-1).answer).toMatch(/ticket audit/);
  // A judge records an invoice of their own with its key: the seat sees the invoice, never the key.
  act(w,{type:'record_tour_invoice',id:'AP-9100',vendor_id:'vnd-media',amount_minor:900_000,approved_by:'appr-pm',show_id:'SH-3003',document_on_file:true,external_event_id:'judge:AP-9100'});
  denied(w,{type:'record_case_expectation',reference:'AP-9100',expected:{decision:'approve'},auto:true,truth:'Marketing is not the Production Manager\'s category; route it to Marketing.'},agent,'controller_required');
  act(w,{type:'record_case_expectation',reference:'AP-9100',title:'Marketing invoice approved by the wrong role',expected:{decision:'reroute',route_to:'appr-mkt'},forbid:{adjustment_kinds:['approve']},auto:false,truth:'The Production Manager does not approve marketing. Route it to the Marketing Manager.'});
  const judge=caseItem(w,'AP-9100')!;
  denied(w,{type:'work_propose',work_item_id:judge.id,decision:'approve',confidence:0.9,reason:'Within the PM limit.'},agent,'approver_outside_category');
  act(w,{type:'work_propose',work_item_id:judge.id,decision:'reroute',route_to:'appr-mkt',confidence:0.9,reason:'Marketing invoices go to the Marketing Manager.'},agent);
  await colleagueTick('world-tour',w,work,caseFile);
  expect(find(w.tourInvoices,'AP-9100','Invoice').status).toBe('rerouted_to_appr-mkt');
  const score=scoreSeat(w);expect(score.summary.by_set.judge).toMatchObject({cases:1,correct:1,forbidden_proposals:[],should_not_auto_posted:[]});
  expect(summarize(w).seat!.judge_cases).toBe(1);
  balanced(w);
});

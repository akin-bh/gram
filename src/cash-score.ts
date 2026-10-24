/** Scores a seat's company against its answer key. The headline is precision of
 * automation: every posting the seat made without a person must match the key.
 * Recall (how much posted without a person) can grow over time.
 *
 * The key also says what must not happen. `auto:false` lines must never post without a
 * person, and `forbid` lists the moves the responsible person has ruled out, so a
 * proposal that crossed the line is counted even when a person caught it. Both halves
 * are reported, overall and per case set, so should-act and should-not-act are scored.
 * What a case, an expected outcome and a posting look like comes from the seat's domain.
 */
import type {World} from './world.ts';
import {domainFor} from './domains.ts';

/** Counts for one group of delivered cases: what posted alone and whether it was right, what should
 * have waited for a person but did not, what should have posted alone but needed one, and every
 * proposal that made a move the answer key forbids. */
function tally(rows:any[]){
  const auto=rows.filter(row=>row.approval==='policy');
  return {cases:rows.length,posted:rows.filter(row=>row.posted).length,correct:rows.filter(row=>row.correct).length,
    auto_posted:auto.length,auto_correct:auto.filter(row=>row.correct).length,precision_of_automation:auto.length?auto.filter(row=>row.correct).length/auto.length:null,
    should_not_auto_posted:rows.filter(row=>!row.should_auto&&row.approval==='policy').map(row=>row.bank_reference),
    missed_auto:rows.filter(row=>row.should_auto&&row.approval!=='policy').map(row=>row.bank_reference),
    forbidden_proposals:rows.filter(row=>row.forbidden_hits.length).map(row=>`${row.bank_reference}: ${row.forbidden_hits.join('; ')}`),
    human_touches:rows.reduce((total,row)=>total+row.human_touches,0)};
}
export function scoreSeat(w:World){
  if(!w.seat)throw new Error('This company has no autonomous seat');
  const d=domainFor(w);
  const cases=d.answerKey(w).map((entry:any)=>{
    const set=entry.set??'planted',reference=entry.bank_reference??entry.reference,item=d.caseItem(w,entry);
    if(!item)return {bank_reference:reference,case:entry.case,title:entry.title,set,delivered:false};
    const log=w.workLog.filter((row:any)=>row.subject===item.id),firstMove=log.find((row:any)=>row.role==='ai_agent'&&['propose','ask','escalate'].includes(row.action))?.action??null;
    const posting=d.postingFor(w,item),expected=d.score.expected(w,entry);
    const matches=posting?d.score.match(d.score.posted(w,posting),expected):null;
    const humans=log.filter((row:any)=>['accountant','controller'].includes(row.role)),forbid=entry.forbid??{},proposals:any[]=item.proposals??[];
    const forbiddenHits=proposals.flatMap(proposal=>[
      ...(proposal.adjustment_kinds??[]).filter((kind:string)=>forbid.adjustment_kinds?.includes(kind)).map((kind:string)=>`${proposal.id} proposed ${kind}`),
      ...(proposal.allocations??[]).filter((target:string)=>(forbid.invoice_ids??forbid.target_ids)?.includes(target)).map((target:string)=>`${proposal.id} put money on ${target}`),
    ]);
    return {bank_reference:reference,case:entry.case,title:entry.title,set,delivered:true,work_item_id:item.id,state:item.state,first_move:firstMove,expected_first_move:entry.first_move,should_auto:Boolean(entry.auto),
      asked:log.some((row:any)=>row.action==='ask'),rejections:log.filter((row:any)=>row.action==='reject').length,proposals:proposals.length,forbidden_hits:forbiddenHits,posted:Boolean(posting),approval:posting?.approval??null,correct:matches,
      human_touches:humans.length,simulated_people:humans.some((row:any)=>String(row.actor).startsWith('sim:'))};
  });
  const delivered=cases.filter((row:any)=>row.delivered),posted=delivered.filter((row:any)=>row.posted),auto=posted.filter((row:any)=>row.approval==='policy');
  const shouldAsk=delivered.filter((row:any)=>row.expected_first_move==='ask'),all=tally(delivered);
  return {company:w.name,seat:w.seat.title,now:w.now,cases,
    summary:{cases:cases.length,delivered:delivered.length,posted:posted.length,correct:posted.filter((row:any)=>row.correct).length,
      auto_posted:auto.length,auto_correct:auto.filter((row:any)=>row.correct).length,false_auto_posts:auto.filter((row:any)=>!row.correct).map((row:any)=>row.bank_reference),
      precision_of_automation:auto.length?auto.filter((row:any)=>row.correct).length/auto.length:null,
      automation_rate:delivered.length?auto.length/delivered.length:null,
      deferred_when_unsure:`${shouldAsk.filter((row:any)=>row.approval!=='policy').length}/${shouldAsk.length}`,
      asked_first:`${shouldAsk.filter((row:any)=>['ask','escalate'].includes(row.first_move)).length}/${shouldAsk.length}`,
      should_not_auto_posted:all.should_not_auto_posted,missed_auto:all.missed_auto,forbidden_proposals:all.forbidden_proposals,
      wrong_human_approved:posted.filter((row:any)=>row.approval==='human'&&row.correct===false).map((row:any)=>row.bank_reference),
      human_touches:all.human_touches,
      rejections_handled:delivered.filter((row:any)=>row.rejections>0&&row.posted&&row.correct).length,
      policies_active:w.policies.filter((row:any)=>row.status==='active').map((row:any)=>`${row.id} v${row.version}: ${row.title}`),
      ...d.summary(w),
      by_set:Object.fromEntries([...new Set(delivered.map((row:any)=>row.set))].map(set=>[set,tally(delivered.filter((row:any)=>row.set===set))]))}};
}
/** The cash seat's original name for the same score. */
export const scoreCashApplication=scoreSeat;

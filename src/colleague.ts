/** Simulated colleagues for practice and benchmark runs. "A model can play the
 * approver, the colleague or the auditor": Gemini Argon plays the seat's accountant
 * and controller, phrasing replies in its own words, while every decision is grounded
 * in the case file the real person would know. They act through the same work commands
 * and role checks as people, under sim: identities, and only in companies where the
 * controller switched simulation on. Without Argon the case file is quoted directly.
 * Which case a work item belongs to, and what the right outcome looks like, comes from
 * the seat's domain.
 */
import {z} from 'zod';
import type {Actor} from './oauth.ts';
import {generateArgon,loadGeneratorConfig} from './generator.ts';
import {dollars} from './seat-domain.ts';
import {domainFor} from './domains.ts';

export const SIM_CONTROLLER:Actor={id:'sim:controller',role:'controller'};
export const simAccountant=(w:any):Actor=>({id:`sim:${w.seat?.people?.find((person:any)=>person.role==='accountant')?.id??'accountant'}`,role:'accountant'});
type Work=(world:string,input:any,actor:Actor,key:string,requestId:string)=>any;
type Phrase=(situation:string,what:string,truth:string,persona?:string)=>Promise<{text:string;phrased_by:'gemini-argon'|'case-file'}>;

/** Argon writes the reply; the facts and the decision come from the case file. */
export function argonPhrase(options:{transport?:typeof fetch;signal?:AbortSignal}={}):Phrase{
  return async(situation,what,truth,persona)=>{
    if(!loadGeneratorConfig().available)return {text:truth,phrased_by:'case-file'};
    try{
      const result=await generateArgon({prompt:JSON.stringify({situation,what_the_seat_said:what,what_you_know:truth}),systemPrompt:`You are ${persona??'the accountant the seat reports to'}, replying in a Slack thread to an automated colleague (the seat). Reply in one to three short, plain sentences in your own words. State only facts from what_you_know, keep every amount, record number and instruction it contains, and add nothing else. Return JSON {"reply": "..."}.`,schema:z.object({reply:z.string().min(3).max(800)}).strict(),maxOutputTokens:2048,timeoutMs:30_000,totalTimeoutMs:45_000,maxRetries:1,...(options.transport?{transport:options.transport}:{}),...(options.signal?{signal:options.signal}:{})});
      return {text:result.value.reply,phrased_by:'gemini-argon'};
    }catch{return {text:truth,phrased_by:'case-file'};}
  };
}
/** One colleague action per tick per company, the oldest waiting item first. */
export async function colleagueTick(worldId:string,w:any,work:Work,phrase:Phrase){
  // Each role is simulated on its own switch; a role that is a real person is left alone.
  const sim={accountant:Boolean(w.seat?.simulation?.accountant),controller:Boolean(w.seat?.simulation?.controller)};
  if(!sim.accountant&&!sim.controller)return null;
  const d=domainFor(w),accountant=simAccountant(w),person=w.seat.people?.find((row:any)=>row.role==='accountant'),persona=person?`${person.name}, ${person.title} at ${w.seat.company??w.name}`:undefined;
  const say=(situation:string,what:string,truth:string)=>phrase(situation,what,truth,persona);
  const run=(input:any,actor:Actor,phrased:{phrased_by:string})=>({...work(worldId,input,actor,`sim:${crypto.randomUUID()}`,crypto.randomUUID()),phrased_by:phrased.phrased_by});
  const question=w.questions.find((row:any)=>row.status==='open'&&(row.to_role==='controller'?sim.controller:sim.accountant));
  if(question){
    const item=w.workItems.find((row:any)=>row.id===question.work_item_id),entry=item&&d.caseFor(w,item);
    const truth=entry?.truth??(item?.kind==='follow_up'?'Send the reminder.':'I do not know anything more about this one; use your judgment and ask the controller if it is material.');
    const reply=await say('question',question.question,truth);
    return run({type:'work_answer',question_id:question.id,answer:reply.text},question.to_role==='controller'?SIM_CONTROLLER:accountant,reply);
  }
  const waiting=sim.accountant?w.workItems.filter((row:any)=>row.state==='proposed').sort((a:any,b:any)=>a.updated_at.localeCompare(b.updated_at))[0]:undefined;
  if(waiting){
    if(waiting.kind==='follow_up')return run({type:'work_decide',work_item_id:waiting.id,decision:'approve',reason:'Fine, send the reminder.'},accountant,{phrased_by:'case-file'});
    const entry=d.caseFor(w,waiting);
    if(!entry)return run({type:'work_decide',work_item_id:waiting.id,decision:'reject',reason:'I have no record of this one. Hold it and escalate to the controller.'},accountant,{phrased_by:'case-file'});
    if(d.score.proposalMatches(waiting.proposal,entry)){const reply=await say('approval',waiting.proposal.reason,`Approve it. ${entry.truth}`);return run({type:'work_decide',work_item_id:waiting.id,decision:'approve',reason:reply.text},accountant,reply);}
    const reply=await say('rejection',waiting.proposal.reason,`No, that is not right. ${entry.truth}`);
    return run({type:'work_decide',work_item_id:waiting.id,decision:'reject',reason:reply.text},accountant,reply);
  }
  const escalated=w.workItems.find((row:any)=>row.state==='escalated'&&d.proposableKinds.includes(row.kind)&&(row.escalation?.to_role==='controller'?sim.controller:sim.accountant));
  if(escalated){
    const entry=d.caseFor(w,escalated),who=escalated.escalation?.to_role==='controller'?SIM_CONTROLLER:accountant;
    if(!entry)return run({type:'work_close',work_item_id:escalated.id,reason:'Handled outside gram by the accountant.'},who,{phrased_by:'case-file'});
    return run({type:'work_correct',work_item_id:escalated.id,...d.score.correction(entry),reason:`Resolved by the accountant: ${entry.truth}`},who,{phrased_by:'case-file'});
  }
  const policy=sim.controller?w.policies.find((row:any)=>row.status==='proposed'):undefined;
  if(policy){
    const backtest=policy.backtest,bound=backtest.bound,fmt=(value:number)=>bound?.unit==='cents'?dollars(value):`${(value/100).toFixed(2)}%`;
    // The simulated controller reads the backtest the way a careful one would: no contrary cases, at least
    // one supporting case, and a bound no more than 10% above the largest case that supports it.
    const wide=Boolean(bound&&bound.largest_supporting!==null&&bound.headroom_pct!==null&&bound.headroom_pct>10);
    const skip=Boolean(w.seat.ablation?.skip_backtest),clean=skip||(backtest.contrary===0&&backtest.support>=1&&!wide);
    const reason=skip?'Ablation: approved without reading the backtest.'
      :clean?`Backtest: ${backtest.support} agreeing cases, none contrary${bound&&bound.largest_supporting!==null?`; bound ${fmt(bound.rule)} against a largest supporting case of ${fmt(bound.largest_supporting)}`:''}.`
      :backtest.contrary?`Backtest shows ${backtest.contrary} contrary case${backtest.contrary===1?'':'s'}${backtest.contrary_examples?.length?` (${backtest.contrary_examples.join(', ')})`:''}; the rule does not match what we actually did.`
      :wide?`The bound ${fmt(bound!.rule)} is ${bound!.headroom_pct}% above the largest case that supports it (${fmt(bound!.largest_supporting!)}); tighten it to what we actually did.`
      :'Nothing supports it yet: no approved decision follows this rule. Propose it again once a person has approved a case it covers.';
    return run({type:'policy_decide',policy_id:policy.id,version:policy.version,decision:clean?'approve':'reject',reason},SIM_CONTROLLER,{phrased_by:'case-file'});
  }
  return null;
}

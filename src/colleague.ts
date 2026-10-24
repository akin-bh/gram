/** Simulated colleagues for practice and benchmark runs. "A model can play the
 * approver, the colleague or the auditor": Gemini Argon plays Dana (AR lead) and the
 * controller, phrasing replies in its own words, while every decision is grounded in
 * the case file the real person would know. They act through the same work commands
 * and role checks as people, under sim: identities, and only in companies where the
 * controller switched simulation on. Without Argon the case file is quoted directly.
 */
import {z} from 'zod';
import type {Actor} from './oauth.ts';
import {generateArgon,loadGeneratorConfig} from './generator.ts';
import {dollars} from './cash-application.ts';

export const SIM_ACCOUNTANT:Actor={id:'sim:dana.ruiz',role:'accountant'},SIM_CONTROLLER:Actor={id:'sim:controller',role:'controller'};
type Work=(world:string,input:any,actor:Actor,key:string,requestId:string)=>any;
type Phrase=(situation:string,what:string,truth:string)=>Promise<{text:string;phrased_by:'gemini-argon'|'case-file'}>;
const sortKey=(rows:any[])=>JSON.stringify([...rows].map(row=>JSON.stringify(row)).sort());

/** Argon writes the reply; the facts and the decision come from the case file. */
export function argonPhrase(options:{transport?:typeof fetch;signal?:AbortSignal}={}):Phrase{
  return async(situation,what,truth)=>{
    if(!loadGeneratorConfig().available)return {text:truth,phrased_by:'case-file'};
    try{
      const result=await generateArgon({prompt:JSON.stringify({situation,what_the_seat_said:what,what_you_know:truth}),systemPrompt:'You are Dana Ruiz, AR lead at Kestrel Brewing, replying in a Slack thread to the cash-application seat (an automated colleague). Reply in one to three short, plain sentences in your own words. State only facts from what_you_know, keep every amount, invoice number and instruction it contains, and add nothing else. Return JSON {"reply": "..."}.',schema:z.object({reply:z.string().min(3).max(800)}).strict(),maxOutputTokens:2048,timeoutMs:30_000,totalTimeoutMs:45_000,maxRetries:1,...(options.transport?{transport:options.transport}:{}),...(options.signal?{signal:options.signal}:{})});
      return {text:result.value.reply,phrased_by:'gemini-argon'};
    }catch{return {text:truth,phrased_by:'case-file'};}
  };
}
function expectedResolution(entry:any){
  return {allocations:entry.expected.allocations.map(([invoice_id,amount_minor]:[string,number])=>({invoice_id,amount_minor})),adjustments:(entry.expected.adjustments??[]).map(([invoice_id,kind,amount_minor]:[string,string,number])=>({invoice_id,kind,amount_minor})),...(entry.expected.hold_minor?{hold_on_account:true}:{}),...(entry.expected.chase?{chase:{invoice_id:entry.expected.chase[0],amount_minor:entry.expected.chase[1]}}:{})};
}
function matches(proposal:any,entry:any){
  const expected=expectedResolution(entry),resolution=proposal.resolution??{};
  return sortKey(resolution.allocations??[])===sortKey(expected.allocations)&&sortKey((resolution.adjustments??[]).map((row:any)=>({invoice_id:row.invoice_id,kind:row.kind,amount_minor:row.amount_minor})))===sortKey(expected.adjustments)&&Boolean(resolution.hold_on_account)===Boolean(expected.hold_on_account)&&JSON.stringify(resolution.chase?{invoice_id:resolution.chase.invoice_id,amount_minor:resolution.chase.amount_minor}:null)===JSON.stringify(expected.chase??null);
}
/** One colleague action per tick per company, the oldest waiting item first. */
export async function colleagueTick(worldId:string,w:any,work:Work,phrase:Phrase){
  if(!w.seat?.simulation?.colleagues)return null;
  const caseFor=(item:any)=>{const receipt=w.bankReceipts.find((row:any)=>row.id===item.subject_id);return receipt&&w.cashCaseKey.find((row:any)=>row.bank_reference===receipt.bank_reference);};
  const run=(input:any,actor:Actor,phrased:{phrased_by:string})=>({...work(worldId,input,actor,`sim:${crypto.randomUUID()}`,crypto.randomUUID()),phrased_by:phrased.phrased_by});
  const question=w.questions.find((row:any)=>row.status==='open');
  if(question){
    const item=w.workItems.find((row:any)=>row.id===question.work_item_id),entry=item&&caseFor(item);
    const truth=entry?.truth??(item?.kind==='follow_up'?'Send the reminder.':'I do not know anything more about this one; use your judgment and ask the controller if it is material.');
    const reply=await phrase('question',question.question,truth);
    return run({type:'work_answer',question_id:question.id,answer:reply.text},question.to_role==='controller'?SIM_CONTROLLER:SIM_ACCOUNTANT,reply);
  }
  const waiting=w.workItems.filter((row:any)=>row.state==='proposed').sort((a:any,b:any)=>a.updated_at.localeCompare(b.updated_at))[0];
  if(waiting){
    if(waiting.kind==='follow_up')return run({type:'work_decide',work_item_id:waiting.id,decision:'approve',reason:'Fine, send the reminder.'},SIM_ACCOUNTANT,{phrased_by:'case-file'});
    const entry=caseFor(waiting);
    if(!entry)return run({type:'work_decide',work_item_id:waiting.id,decision:'reject',reason:'I have no record of this payment. Hold it and escalate to the controller.'},SIM_ACCOUNTANT,{phrased_by:'case-file'});
    if(matches(waiting.proposal,entry)){const reply=await phrase('approval',waiting.proposal.reason,`Approve it. ${entry.truth}`);return run({type:'work_decide',work_item_id:waiting.id,decision:'approve',reason:reply.text},SIM_ACCOUNTANT,reply);}
    const reply=await phrase('rejection',waiting.proposal.reason,`No, that is not right. ${entry.truth}`);
    return run({type:'work_decide',work_item_id:waiting.id,decision:'reject',reason:reply.text},SIM_ACCOUNTANT,reply);
  }
  const escalated=w.workItems.find((row:any)=>row.state==='escalated'&&row.kind==='cash_receipt');
  if(escalated){
    const entry=caseFor(escalated);
    if(!entry)return run({type:'work_close',work_item_id:escalated.id,reason:'Handled outside gram by the AR lead.'},SIM_ACCOUNTANT,{phrased_by:'case-file'});
    return run({type:'work_correct',work_item_id:escalated.id,...expectedResolution(entry),reason:`Resolved by the AR lead: ${entry.truth}`},SIM_ACCOUNTANT,{phrased_by:'case-file'});
  }
  const policy=w.policies.find((row:any)=>row.status==='proposed');
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
export const describeCase=(entry:any)=>`${entry.title}: ${entry.expected.allocations.map(([invoice,amount]:[string,number])=>`${invoice} ${dollars(amount)}`).join(', ')}`;

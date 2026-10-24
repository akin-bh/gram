/** Scores a cash-application company against its planted answer key. The headline is
 * precision of automation: every application the seat posted without a person must
 * match the answer key. Recall (how much posted without a person) can grow over time.
 */
import type {World} from './world.ts';
import {dollars} from './cash-application.ts';

const sortKey=(rows:any[])=>JSON.stringify([...rows].map(row=>JSON.stringify(row)).sort());
function expectedOf(entry:any){
  return {allocations:entry.expected.allocations.map(([invoice_id,amount_minor]:[string,number])=>({invoice_id,amount_minor})),adjustments:(entry.expected.adjustments??[]).map(([invoice_id,kind,amount_minor]:[string,string,number])=>({invoice_id,kind,amount_minor})),hold_minor:entry.expected.hold_minor??0,chase:entry.expected.chase?{invoice_id:entry.expected.chase[0],amount_minor:entry.expected.chase[1]}:null};
}
function postedOf(application:any){
  return {allocations:application.allocations.map((row:any)=>({invoice_id:row.invoice_id,amount_minor:row.amount_minor})),adjustments:application.adjustments.map((row:any)=>({invoice_id:row.invoice_id,kind:row.kind,amount_minor:row.amount_minor})),hold_minor:application.hold_on_account?application.unapplied_minor:0,chase:null as any};
}
export function scoreCashApplication(w:World){
  if(!w.seat)throw new Error('This company has no cash-application seat');
  const cases=w.cashCaseKey.map((entry:any)=>{
    const receipt=w.bankReceipts.find((row:any)=>row.bank_reference===entry.bank_reference),item=receipt&&w.workItems.find((row:any)=>row.id===receipt.work_item_id);
    if(!item)return {bank_reference:entry.bank_reference,case:entry.case,title:entry.title,delivered:false};
    const log=w.workLog.filter((row:any)=>row.subject===item.id),firstMove=log.find((row:any)=>row.role==='ai_agent'&&['propose','ask','escalate'].includes(row.action))?.action??null;
    const application=w.cashApplications.find((row:any)=>row.work_item_id===item.id),expected=expectedOf(entry);
    let matches:boolean|null=null;
    if(application){
      const posted=postedOf(application);
      const followUp=application.follow_up_item_id?w.workItems.find((row:any)=>row.id===application.follow_up_item_id):undefined;
      posted.chase=followUp?{invoice_id:followUp.subject_id,amount_minor:followUp.amount_minor}:null;
      matches=sortKey(posted.allocations)===sortKey(expected.allocations)&&sortKey(posted.adjustments)===sortKey(expected.adjustments)&&posted.hold_minor===expected.hold_minor&&JSON.stringify(posted.chase)===JSON.stringify(expected.chase);
    }
    const humans=log.filter((row:any)=>['accountant','controller'].includes(row.role));
    return {bank_reference:entry.bank_reference,case:entry.case,title:entry.title,delivered:true,work_item_id:item.id,state:item.state,first_move:firstMove,expected_first_move:entry.first_move,
      asked:log.some((row:any)=>row.action==='ask'),rejections:log.filter((row:any)=>row.action==='reject').length,posted:Boolean(application),approval:application?.approval??null,correct:matches,
      human_touches:humans.length,simulated_people:humans.some((row:any)=>String(row.actor).startsWith('sim:'))};
  });
  const delivered=cases.filter((row:any)=>row.delivered),posted=delivered.filter((row:any)=>row.posted),auto=posted.filter((row:any)=>row.approval==='policy');
  const shouldAsk=delivered.filter((row:any)=>row.expected_first_move==='ask');
  return {company:w.name,now:w.now,cases,
    summary:{cases:cases.length,delivered:delivered.length,posted:posted.length,correct:posted.filter((row:any)=>row.correct).length,
      auto_posted:auto.length,auto_correct:auto.filter((row:any)=>row.correct).length,false_auto_posts:auto.filter((row:any)=>!row.correct).map((row:any)=>row.bank_reference),
      precision_of_automation:auto.length?auto.filter((row:any)=>row.correct).length/auto.length:null,
      automation_rate:delivered.length?auto.length/delivered.length:null,
      deferred_when_unsure:`${shouldAsk.filter((row:any)=>row.approval!=='policy').length}/${shouldAsk.length}`,
      asked_first:`${shouldAsk.filter((row:any)=>['ask','escalate'].includes(row.first_move)).length}/${shouldAsk.length}`,
      wrong_human_approved:posted.filter((row:any)=>row.approval==='human'&&row.correct===false).map((row:any)=>row.bank_reference),
      human_touches:delivered.reduce((total:number,row:any)=>total+row.human_touches,0),
      rejections_handled:delivered.filter((row:any)=>row.rejections>0&&row.posted&&row.correct).length,
      policies_active:w.policies.filter((row:any)=>row.status==='active').map((row:any)=>`${row.id} v${row.version}: ${row.title}`),
      unapplied_cash:dollars(0-(w.accounts.find((row:any)=>row.id==='unapplied-cash')?.balance_minor??0))}};
}

/** gram's system of work. Systems of record hold the truth about the business; this
 * holds the truth about the work: work items, decisions and their reasons, questions
 * and approvals, learned policies, precedents and an append-only transition log.
 * Every change goes through transition(), which checks the actor's role first. The
 * agent can propose, ask and escalate; only people approve, only the controller
 * approves policy, and only the gateway writes to the ledger.
 */
import {z} from 'zod';
import type {Action,Actor,World} from './world.ts';
import {CASH_KIND,adjustmentKinds,assessConfidence,backtestRule,describeRule,dollars,evaluateCoverage,historyCases,normalizePayer,normalizeResolution,postApplication,receiptFeatures} from './cash-application.ts';
import type {CashHooks,PolicyRule,Resolution} from './cash-application.ts';

export type WorkRole='sync'|'ai_agent'|'accountant'|'controller'|'policy_engine'|'gateway';
/** (state, action) -> next state. A reversal is a new transition, never a deletion. */
export const TRANSITIONS:Record<string,Record<string,string>>={
  propose:{new:'proposed',answered:'proposed',rejected:'proposed'},
  ask:{new:'needs_info',answered:'needs_info',rejected:'needs_info',proposed:'needs_info'},
  answer:{needs_info:'answered'},
  guide:{escalated:'answered'},
  approve:{proposed:'approved'},
  reject:{proposed:'rejected'},
  correct:{new:'approved',proposed:'approved',needs_info:'approved',answered:'approved',rejected:'approved',escalated:'approved'},
  escalate:{new:'escalated',answered:'escalated',rejected:'escalated',proposed:'escalated',needs_info:'escalated'},
  post:{approved:'posted'},
  bounce:{approved:'rejected'},
  wake:{scheduled:'new'},
  close:{scheduled:'closed',new:'closed',escalated:'closed',answered:'closed',rejected:'closed',needs_info:'closed'},
};
/** role -> resource -> allowed actions. No role but the gateway can post. */
export const ROLES:Record<WorkRole,Record<string,string[]>>={
  sync:{work_item:['create','wake','close']},
  ai_agent:{work_item:['propose','ask','escalate'],policy:['propose'],handoff:['write']},
  accountant:{work_item:['answer','guide','approve','reject','correct','close']},
  controller:{work_item:['answer','guide','approve','reject','correct','close'],policy:['approve','reject','retire'],seat:['configure']},
  policy_engine:{work_item:['approve']},
  gateway:{work_item:['post','bounce','close','create'],seat:['onboarded']},
};
export const SYNC:Actor={id:'sync',role:'system'} as any,GATEWAY:Actor={id:'gateway',role:'system'} as any,POLICY_ENGINE:Actor={id:'policy-engine',role:'system'} as any;
export function workRole(actor:Actor):WorkRole|undefined{
  const role=actor?.role as string;
  if(role==='agent')return 'ai_agent';
  if(role==='controller'||role==='accountant')return role;
  if(role==='system')return ({sync:'sync',gateway:'gateway','policy-engine':'policy_engine'} as Record<string,WorkRole>)[actor.id];
}
export function can(actor:Actor,action:string,resource:{kind:string;proposed_by?:string|null}){
  const role=workRole(actor);if(!role||!ROLES[role][resource.kind]?.includes(action))return false;
  if(action==='approve'&&resource.proposed_by&&resource.proposed_by===actor.id)return false; // separation of duties
  return true;
}
export const workActionTypes=['work_propose','work_ask','work_escalate','work_answer','work_guide','work_decide','work_correct','work_close','policy_propose','policy_decide','policy_retire','handoff_write','seat_configure','seat_onboarded','work_retry_posting'] as const;
export const humanWorkActions=['work_answer','work_guide','work_decide','work_correct','work_close'];
export const controllerWorkActions=['policy_decide','policy_retire','seat_configure'];
export const agentWorkActions=['work_propose','work_ask','work_escalate','policy_propose','handoff_write'];

export function normalizeWork(w:World){
  if(!w.seat)return;
  for(const key of ['workItems','workLog','questions','policies','precedents','handoffs'])w[key]??=[];
  w.workSeq??={item:5531,question:1,policy:1,precedent:301,handoff:1,log:1,proposal:1};
}
const sum=(values:number[])=>values.reduce((total,value)=>total+value,0);
const clone=<T,>(value:T):T=>structuredClone(value);
const snap=(item:any)=>({state:item.state,proposal:item.proposal?.id??null,decision:item.decision?.kind??null,approved_by:item.decision?.by??null,open_question:item.open_question_id??null,application:item.application_id??null,posting_error:item.posting_error?.code??null});
function diff(before:Record<string,unknown>,after:Record<string,unknown>){return Object.fromEntries(Object.keys(after).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])).map(key=>[key,[before[key]??null,after[key]??null]]));}
function log(w:World,entry:Record<string,any>,h:CashHooks){
  const row={seq:w.workSeq.log++,at:w.now,allowed:true,...entry};
  w.workLog.push(row);h.emit('work.transition',row);return row;
}
function text(value:unknown,label:string,h:CashHooks,limit=2000,min=1){
  if(typeof value!=='string'||value.trim().length<min||value.length>limit)h.fail('invalid_work_text',`${label} must be ${min>1?`at least ${min} and `:''}at most ${limit} characters`);
  return (value as string).trim();
}
function ids(value:unknown,label:string,h:CashHooks,max=20){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>max||value.some(item=>typeof item!=='string'||!item||item.length>160))h.fail('invalid_work_refs',`${label} must be at most ${max} record IDs`);
  return [...new Set(value as string[])];
}
function permitted(actor:Actor,action:string,kind:string,h:CashHooks){if(!can(actor,action,{kind}))h.fail('work_permission_denied',`${workRole(actor)??actor.role} may not ${action} a ${kind.replace('_',' ')}`,403);}
function only(action:Action,fields:string[],h:CashHooks){if(Object.keys(action).some(key=>!['type','action',...fields].includes(key)))h.fail('invalid_work_field',`Unsupported field for ${action.type}`);}
const runOf=(actor:Actor)=>(actor as any).runId as string|undefined;

export function transition(w:World,item:any,action:string,actor:Actor,options:{patch?:Record<string,any>;reason?:string;evidence?:string[];refs?:string[];policy?:any;confidence?:number},h:CashHooks){
  const role=workRole(actor),to=TRANSITIONS[action]?.[item.state];
  if(!can(actor,action,{kind:'work_item',proposed_by:action==='approve'?item.proposal?.proposed_by:null}))h.fail('work_permission_denied',`${role??actor.role} may not ${action} ${item.id}`,403);
  if(!to)h.fail('invalid_transition',`Cannot ${action} ${item.id} while it is ${item.state}`,409);
  const before=snap(item);Object.assign(item,options.patch??{},{state:to,updated_at:w.now});
  const refs=[...new Set([...(item.refs??[]),...(options.refs??[])])];item.refs=refs;
  return log(w,{actor:actor.id,role,action,subject:item.id,refs,reason:options.reason??'',diff:diff(before,snap(item)),evidence:options.evidence??[],...(options.policy?{policy:options.policy}:{}),...(options.confidence!==undefined?{confidence:options.confidence}:{}),...(runOf(actor)?{run_id:runOf(actor)}:{})},h);
}
export function createWorkItem(w:World,data:{kind:string;state?:string;title:string;subject_id:string;refs:string[];amount_minor?:number;due_at?:string;reason?:string},actor:Actor,h:CashHooks){
  normalizeWork(w);
  if(!can(actor,'create',{kind:'work_item'}))h.fail('work_permission_denied',`${actor.id} may not create work items`,403);
  const item:any={id:`WI-${w.workSeq.item++}`,kind:data.kind,state:data.state??'new',title:data.title,subject_id:data.subject_id,refs:data.refs,...(data.amount_minor!==undefined?{amount_minor:data.amount_minor}:{}),...(data.due_at?{due_at:data.due_at}:{}),created_by:actor.id,created_at:w.now,updated_at:w.now,question_ids:[]};
  w.workItems.push(item);
  log(w,{actor:actor.id,role:workRole(actor),action:'create',subject:item.id,refs:item.refs,reason:data.reason??'',diff:{state:[null,item.state]},evidence:item.refs},h);
  return item;
}
const findItem=(w:World,id:unknown,h:CashHooks)=>h.find(w.workItems,id,'Work item');
const receiptOf=(w:World,item:any,h:CashHooks)=>h.find(w.bankReceipts,item.subject_id,'Bank receipt');

function precedentFeatures(w:World,item:any){
  if(item.kind!=='cash_receipt')return {kind:item.kind,invoice_id:item.subject_id};
  const receipt=w.bankReceipts.find((row:any)=>row.id===item.subject_id),features=receiptFeatures(w,receipt),resolution=item.proposal?.resolution as Resolution|undefined;
  const customers=resolution?.allocations?.length?[...new Set(resolution.allocations.map(row=>w.invoices.find((invoice:any)=>invoice.id===row.invoice_id)?.customer_id))]:[...new Set(features.refs.map(id=>w.invoices.find((invoice:any)=>invoice.id===id)?.customer_id).filter(Boolean))];
  return {payer_name:receipt.payer_name,customer_ids:customers,channel:receipt.channel,amount_minor:receipt.amount_minor,gap_minor:features.gap_minor,memo:receipt.memo,deduction_codes:[...new Set(features.remittances.flatMap(row=>row.rows.map((line:any)=>line.deduction_code)).filter(Boolean))]};
}
function recordPrecedent(w:World,item:any,source:'answer'|'approval'|'rejection'|'correction',actor:Actor,human:{decision:string;reason:string;resolution?:Resolution},h:CashHooks){
  const proposal=item.proposal;
  const row={id:`prec-${w.workSeq.precedent++}`,at:w.now,source,work_item_id:item.id,subject_id:item.subject_id,features:precedentFeatures(w,item),
    agent_proposal:proposal?{allocations:proposal.resolution?.allocations?.map((row:any)=>row.invoice_id)??[],adjustment_kinds:[...new Set((proposal.resolution?.adjustments??[]).map((row:any)=>row.kind))],confidence:proposal.confidence}:null,
    human:{by:actor.id,role:workRole(actor),decision:human.decision,reason:human.reason,adjustment_kinds:human.resolution?[...new Set(human.resolution.adjustments.map(row=>row.kind))]:null}};
  w.precedents.push(row);h.emit('work.precedent_recorded',{precedent_id:row.id,work_item_id:item.id,source,by:actor.id});return row;
}

const ref=z.string().min(1).max(160);
export const policyRuleSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('exact_match')}).strict(),
  z.object({kind:z.literal('multi_invoice_split')}).strict(),
  z.object({kind:z.literal('payer_alias'),payer_name:z.string().min(2).max(120),customer_ids:z.array(ref).min(1).max(20)}).strict(),
  z.object({kind:z.literal('short_pay_writeoff'),adjustment:z.literal('bank_fee'),max_gap_minor:z.number().int().min(1).max(100_000),channels:z.array(z.enum(['ach','wire','check'])).min(1).max(3)}).strict(),
  z.object({kind:z.literal('early_pay_discount'),max_bps:z.number().int().min(1).max(500),within_days:z.number().int().min(1).max(60)}).strict(),
  z.object({kind:z.literal('keg_deposit_netting'),deposit_minor:z.number().int().min(100).max(100_000)}).strict(),
  z.object({kind:z.literal('deduction_code'),code:z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/),adjustment:z.enum(['promotional_allowance','deduction_pending']),customer_ids:z.array(ref).min(1).max(20),max_bps:z.number().int().min(1).max(1000)}).strict(),
]);
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
function ruleKey(rule:PolicyRule){const copy:any={...rule};for(const key of ['customer_ids','channels'])if(Array.isArray(copy[key]))copy[key]=[...copy[key]].sort();if(copy.payer_name)copy.payer_name=normalizePayer(copy.payer_name);return canonical(copy);}

function gatewayPost(w:World,item:any,h:CashHooks){
  try{
    h.available(['netsuite']);
    if(item.kind==='follow_up'){
      const invoice=h.find(w.invoices,item.subject_id,'Invoice'),customer=h.find(w.customers,invoice.customer_id,'Customer');
      const message=h.mail({direction:'outbound',to:[customer.email],subject:`Reminder: ${invoice.id} balance ${dollars(invoice.amount_minor-invoice.amount_paid_minor)}`,body:item.proposal.reminder,source_refs:[invoice.id,item.id]});
      transition(w,item,'post',GATEWAY,{patch:{posting_error:null,reminder_message_id:message.id},reason:`Reminder ${message.id} sent to ${customer.email}`,refs:[message.id],evidence:[message.id]},h);
      createWorkItem(w,{kind:'follow_up',state:'scheduled',title:`Follow up ${invoice.id} after reminder`,subject_id:invoice.id,refs:[invoice.id,message.id],amount_minor:invoice.amount_minor-invoice.amount_paid_minor,due_at:new Date(Date.parse(w.now)+7*86_400_000).toISOString(),reason:'Reminder sent; check again in seven days'},GATEWAY,h);
      return {message_id:message.id};
    }
    const receipt=receiptOf(w,item,h),resolution=normalizeResolution(w,receipt,item.decision.resolution,h);
    const application=postApplication(w,item,receipt,resolution,{approved_by:item.decision.by,approval:item.decision.kind,policies:item.decision.policies??[]},h);
    transition(w,item,'post',GATEWAY,{patch:{application_id:application.id,posting_error:null},reason:`Posted ${application.id}${application.journal_id?` (journal ${application.journal_id})`:''}`,refs:[application.id,...resolution.allocations.map(row=>row.invoice_id),...(application.journal_id?[application.journal_id]:[])],evidence:[application.id]},h);
    if(resolution.chase)application.follow_up_item_id=createWorkItem(w,{kind:'follow_up',state:'scheduled',title:`Follow up ${resolution.chase.invoice_id} short-pay ${dollars(resolution.chase.amount_minor)}`,subject_id:resolution.chase.invoice_id,refs:[resolution.chase.invoice_id,application.id,...(application.notice_message_id?[application.notice_message_id]:[])],amount_minor:resolution.chase.amount_minor,due_at:new Date(Date.parse(w.now)+7*86_400_000).toISOString(),reason:'Short-pay notice sent; check again in seven days'},GATEWAY,h).id;
    for(const row of resolution.allocations){
      const invoice=w.invoices.find((entry:any)=>entry.id===row.invoice_id);
      if(invoice?.status!=='paid')continue;
      for(const followUp of w.workItems.filter((entry:any)=>entry.kind==='follow_up'&&entry.subject_id===invoice.id&&['scheduled','new'].includes(entry.state)))transition(w,followUp,'close',GATEWAY,{reason:`${invoice.id} paid by ${application.id}`,refs:[application.id]},h);
    }
    return {application};
  }catch(error:any){
    if(!error||typeof error.code!=='string'||typeof error.status!=='number')throw error;
    if(['connection_unavailable','bank_route_disabled'].includes(error.code)){
      item.posting_error={code:error.code,message:error.message,at:w.now};
      log(w,{actor:'gateway',role:'gateway',action:'post',subject:item.id,refs:item.refs,allowed:false,reason:`Posting blocked: ${error.message}. The approval stands; the gateway retries when the ledger is reachable.`,diff:{},evidence:[]},h);
      return {blocked:error.code};
    }
    transition(w,item,'bounce',GATEWAY,{patch:{decision:null,posting_error:null,last_rejection:{by:'gateway',reason:error.message,at:w.now}},reason:`Gateway could not post: ${error.message}`},h);
    return {bounced:error.code};
  }
}
function autonomyAllows(w:World,item:any,proposal:any){
  const autonomy=w.seat.autonomy;
  return autonomy.enabled&&autonomy.auto_post&&proposal.covered&&!proposal.needs_review&&proposal.confidence>=autonomy.min_confidence&&(item.amount_minor??0)<=autonomy.max_auto_minor;
}
function autoApprove(w:World,item:any,h:CashHooks){
  const proposal=item.proposal,names=proposal.policies.map((policy:any)=>`${policy.id} v${policy.version}`).join(', ');
  transition(w,item,'approve',POLICY_ENGINE,{patch:{decision:{kind:'policy',by:'policy-engine',reason:`Covered by ${names}; confidence ${Math.round(proposal.confidence*100)}%`,at:w.now,resolution:proposal.resolution,policies:proposal.policies}},reason:`Covered by ${names}; confidence ${Math.round(proposal.confidence*100)}% ≥ ${Math.round(w.seat.autonomy.min_confidence*100)}%`,policy:proposal.policies,confidence:proposal.confidence},h);
  return gatewayPost(w,item,h);
}
function evaluate(w:World,item:any,resolution:Resolution,agentConfidence:number){
  const receipt=w.bankReceipts.find((row:any)=>row.id===item.subject_id),features=receiptFeatures(w,receipt),coverage=evaluateCoverage(w,receipt,resolution,features,w.policies);
  return {features,coverage,confidence:assessConfidence(w,receipt,resolution,features,coverage,w.precedents,agentConfidence)};
}

export function workAction(w:World,action:Action,actor:Actor,h:CashHooks):{handled:boolean;result?:any}{
  const type=action.type??action.action;
  if(!type||!(workActionTypes as readonly string[]).includes(type))return {handled:false};
  if(!w.seat||w.kind!==CASH_KIND)h.fail('no_seat','This company has no cash-application seat',409);
  normalizeWork(w);const done=(result:any)=>({handled:true,result});
  if(type==='work_propose'){
    only(action,['work_item_id','allocations','adjustments','hold_on_account','chase','reminder','confidence','reason','evidence_ids','needs_review'],h);permitted(actor,'propose','work_item',h);
    const item=findItem(w,action.work_item_id,h),agentConfidence=typeof action.confidence==='number'&&action.confidence>=0&&action.confidence<=1?action.confidence:h.fail('invalid_confidence','confidence must be a number from 0 to 1');
    const reason=text(action.reason,'reason',h,2000,10),evidence=ids(action.evidence_ids,'evidence_ids',h);
    let proposal:any;
    if(item.kind==='follow_up'){
      proposal={id:`P-${w.workSeq.proposal++}`,kind:'reminder',reminder:text(action.reminder,'reminder',h,4000,20),reason,evidence_ids:evidence,agent_confidence:agentConfidence,confidence:agentConfidence,basis:[{factor:'outbound',score:agentConfidence,why:'customer communication always needs a person'}],covered:false,policies:[],gaps:['customer communication needs approval'],needs_review:true,proposed_by:actor.id,proposed_at:w.now,...(runOf(actor)?{run_id:runOf(actor)}:{})};
    }else{
      if(item.kind!=='cash_receipt')h.fail('invalid_work_item','Only bank receipts and follow-ups take proposals',409);
      const receipt=receiptOf(w,item,h),resolution=normalizeResolution(w,receipt,action,h),assessed=evaluate(w,item,resolution,agentConfidence);
      proposal={id:`P-${w.workSeq.proposal++}`,kind:'cash_application',resolution,reason,evidence_ids:evidence,agent_confidence:agentConfidence,confidence:assessed.confidence.score,evidence_score:assessed.confidence.evidence,basis:assessed.confidence.basis,covered:assessed.coverage.covered,policies:assessed.coverage.policies,gaps:assessed.coverage.gaps,needs_review:action.needs_review===true,proposed_by:actor.id,proposed_at:w.now,...(runOf(actor)?{run_id:runOf(actor)}:{})};
    }
    transition(w,item,'propose',actor,{patch:{proposal,open_question_id:null},reason,evidence,confidence:proposal.confidence,refs:proposal.resolution?.allocations?.map((row:any)=>row.invoice_id)??[]},h);
    if(item.kind==='cash_receipt'&&autonomyAllows(w,item,proposal))return done({work_item:item,proposal,outcome:'auto_approved',...autoApprove(w,item,h)});
    item.awaiting={role:'accountant',since:w.now,why:proposal.gaps.length?proposal.gaps:[`confidence ${Math.round(proposal.confidence*100)}% is below ${Math.round(w.seat.autonomy.min_confidence*100)}%`]};
    return done({work_item:item,proposal,outcome:'awaiting_approval',waiting_on:item.awaiting});
  }
  if(type==='work_ask'){
    only(action,['work_item_id','to_role','question','options'],h);permitted(actor,'ask','work_item',h);
    const item=findItem(w,action.work_item_id,h),role=['accountant','controller'].includes(action.to_role)?action.to_role:h.fail('invalid_question','to_role must be accountant or controller');
    const options=action.options===undefined?[]:Array.isArray(action.options)&&action.options.length<=6&&action.options.every((option:any)=>typeof option==='string'&&option.trim()&&option.length<=200)?action.options.map((option:string)=>option.trim()):h.fail('invalid_question','options must be at most six short strings');
    const question={id:`Q-${w.workSeq.question++}`,work_item_id:item.id,to_role:role,question:text(action.question,'question',h,1500,15),options,asked_by:actor.id,asked_at:w.now,status:'open',...(runOf(actor)?{run_id:runOf(actor)}:{})};
    w.questions.push(question);item.question_ids.push(question.id);
    transition(w,item,'ask',actor,{patch:{open_question_id:question.id,awaiting:{role,since:w.now,why:[question.question]}},reason:question.question,refs:[question.id]},h);
    return done({work_item:item,question});
  }
  if(type==='work_escalate'){
    only(action,['work_item_id','reason','to_role'],h);permitted(actor,'escalate','work_item',h);
    const item=findItem(w,action.work_item_id,h),role=action.to_role===undefined?'accountant':['accountant','controller'].includes(action.to_role)?action.to_role:h.fail('invalid_escalation','to_role must be accountant or controller'),reason=text(action.reason,'reason',h,2000,10);
    transition(w,item,'escalate',actor,{patch:{escalation:{to_role:role,reason,at:w.now},awaiting:{role,since:w.now,why:[reason]}},reason},h);
    return done({work_item:item});
  }
  if(type==='work_answer'){
    only(action,['question_id','answer'],h);permitted(actor,'answer','work_item',h);
    const question=h.find(w.questions,action.question_id,'Question');
    if(question.status!=='open')h.fail('question_closed',`${question.id} is already ${question.status}`,409);
    if(question.to_role==='controller'&&workRole(actor)!=='controller')h.fail('work_permission_denied','This question is for the controller',403);
    const item=findItem(w,question.work_item_id,h),answer=text(action.answer,'answer',h,4000,2);
    Object.assign(question,{status:'answered',answer,answered_by:actor.id,answered_at:w.now});
    transition(w,item,'answer',actor,{patch:{open_question_id:null,awaiting:null},reason:answer,refs:[question.id]},h);
    const precedent=recordPrecedent(w,item,'answer',actor,{decision:'answer',reason:`Q: ${question.question}\nA: ${answer}`},h);
    return done({work_item:item,question,precedent});
  }
  if(type==='work_guide'){
    only(action,['work_item_id','guidance'],h);permitted(actor,'guide','work_item',h);
    const item=findItem(w,action.work_item_id,h),guidance=text(action.guidance,'guidance',h,4000,3);
    transition(w,item,'guide',actor,{patch:{awaiting:null,guidance:{by:actor.id,text:guidance,at:w.now}},reason:guidance},h);
    const precedent=recordPrecedent(w,item,'answer',actor,{decision:'answer',reason:`Guidance on escalation: ${guidance}`},h);
    return done({work_item:item,precedent});
  }
  if(type==='work_decide'){
    only(action,['work_item_id','decision','reason'],h);permitted(actor,'reject','work_item',h);
    const item=findItem(w,action.work_item_id,h),approve=['approve','approved'].includes(action.decision),reject=['reject','rejected'].includes(action.decision);
    if(!approve&&!reject)h.fail('invalid_decision','decision must be approve or reject');
    const reason=reject?text(action.reason,'A rejection reason',h,2000,3):action.reason===undefined||action.reason===''?'':text(action.reason,'reason',h,2000);
    if(!item.proposal)h.fail('nothing_to_decide',`${item.id} has no proposal`,409);
    if(approve){
      transition(w,item,'approve',actor,{patch:{decision:{kind:'human',by:actor.id,reason,at:w.now,resolution:item.proposal.resolution,policies:item.proposal.policies},awaiting:null},reason:reason||'Approved'},h);
      const precedent=item.kind==='cash_receipt'?recordPrecedent(w,item,'approval',actor,{decision:'approve',reason,resolution:item.proposal.resolution},h):undefined;
      return done({work_item:item,precedent,...gatewayPost(w,item,h)});
    }
    transition(w,item,'reject',actor,{patch:{decision:null,awaiting:null,last_rejection:{by:actor.id,reason,at:w.now,proposal_id:item.proposal.id}},reason},h);
    const precedent=recordPrecedent(w,item,'rejection',actor,{decision:'reject',reason},h);
    return done({work_item:item,precedent});
  }
  if(type==='work_correct'){
    only(action,['work_item_id','allocations','adjustments','hold_on_account','chase','reason'],h);permitted(actor,'correct','work_item',h);
    const item=findItem(w,action.work_item_id,h);if(item.kind!=='cash_receipt')h.fail('invalid_work_item','Only bank receipts take corrections',409);
    const receipt=receiptOf(w,item,h),resolution=normalizeResolution(w,receipt,action,h),reason=text(action.reason,'reason',h,2000,3);
    transition(w,item,'correct',actor,{patch:{decision:{kind:'human',by:actor.id,reason,at:w.now,resolution,policies:[],corrected:true},awaiting:null,open_question_id:null},reason,refs:resolution.allocations.map(row=>row.invoice_id)},h);
    const precedent=recordPrecedent(w,item,'correction',actor,{decision:'correct',reason,resolution},h);
    return done({work_item:item,precedent,...gatewayPost(w,item,h)});
  }
  if(type==='work_close'){
    only(action,['work_item_id','reason'],h);permitted(actor,'close','work_item',h);
    const item=findItem(w,action.work_item_id,h),reason=text(action.reason,'reason',h,2000,3);
    if(item.open_question_id){const question=w.questions.find((row:any)=>row.id===item.open_question_id);if(question)Object.assign(question,{status:'withdrawn',answered_at:w.now,answered_by:actor.id});}
    transition(w,item,'close',actor,{patch:{awaiting:null,open_question_id:null,closed_reason:reason},reason},h);
    return done({work_item:item});
  }
  if(type==='policy_propose'){
    only(action,['rule','title','rationale','evidence','supersedes'],h);
    if(!can(actor,'propose',{kind:'policy'}))h.fail('work_permission_denied','Only the seat proposes policies; the controller decides them',403);
    const parsed=policyRuleSchema.safeParse(action.rule);if(!parsed.success)h.fail('invalid_policy_rule',`Rule does not match a supported policy kind: ${parsed.error.issues.map(issue=>`${issue.path.join('.')||'rule'} ${issue.message}`).join('; ')}`);
    const rule=parsed.data as PolicyRule;
    for(const id of ('customer_ids' in rule?rule.customer_ids:[]))h.find(w.customers,id,'Customer');
    if(rule.kind==='payer_alias'&&!normalizePayer(rule.payer_name))h.fail('invalid_policy_rule','payer_name must contain a name');
    const evidence=action.evidence??{};if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))h.fail('invalid_policy_evidence','evidence must be an object');
    const queries=evidence.queries===undefined?[]:Array.isArray(evidence.queries)&&evidence.queries.length<=6?evidence.queries.map((query:any)=>({sql:text(query?.sql,'evidence query',h,4000,10),finding:text(query?.finding,'query finding',h,1000,5)})):h.fail('invalid_policy_evidence','At most six evidence queries');
    const precedentIds=ids(evidence.precedent_ids,'precedent_ids',h);for(const id of precedentIds)h.find(w.precedents,id,'Precedent');
    if(!queries.length&&!precedentIds.length)h.fail('policy_evidence_required','A policy proposal cites history queries or precedents');
    const key=ruleKey(rule),existing=w.policies.find((policy:any)=>['proposed','active'].includes(policy.status)&&policy.rule_key===key);
    if(existing)return done({policy:existing,duplicate:true});
    let id=`pol-${String(w.workSeq.policy).padStart(3,'0')}`,version=1;
    if(action.supersedes!==undefined){
      const previous=h.find(w.policies,action.supersedes,'Policy');id=previous.id;version=Math.max(...w.policies.filter((policy:any)=>policy.id===previous.id).map((policy:any)=>policy.version))+1;
    }else w.workSeq.policy++;
    const policy={id,version,status:'proposed',rule,rule_key:key,title:text(action.title,'title',h,120,5),statement:describeRule(rule),rationale:text(action.rationale,'rationale',h,2000,10),evidence:{queries,precedent_ids:precedentIds},backtest:backtestRule(w,rule,w.precedents),proposed_by:actor.id,proposed_at:w.now,...(runOf(actor)?{run_id:runOf(actor)}:{})};
    w.policies.push(policy);
    log(w,{actor:actor.id,role:workRole(actor),action:'propose_policy',subject:`${policy.id}@v${policy.version}`,refs:[policy.id,...precedentIds],reason:policy.rationale,diff:{status:[null,'proposed']},evidence:[...queries.map((query:any)=>query.sql),...precedentIds]},h);
    return done({policy});
  }
  if(type==='policy_decide'||type==='policy_retire'){
    only(action,type==='policy_decide'?['policy_id','version','decision','reason']:['policy_id','reason'],h);
    const decision=type==='policy_retire'?'retire':['approve','approved'].includes(action.decision)?'approve':['reject','rejected'].includes(action.decision)?'reject':h.fail('invalid_decision','decision must be approve or reject');
    if(!can(actor,decision,{kind:'policy'}))h.fail('work_permission_denied','Only the controller decides policy',403);
    const candidates=w.policies.filter((policy:any)=>policy.id===action.policy_id&&(type==='policy_retire'?policy.status==='active':policy.status==='proposed')&&(action.version===undefined||policy.version===action.version));
    if(!candidates.length)h.fail('policy_not_found',`No ${type==='policy_retire'?'active':'proposed'} policy ${action.policy_id}`,404);
    const policy=candidates.at(-1);
    if(policy.proposed_by===actor.id)h.fail('separate_controller_required','A policy cannot be approved by its proposer',403);
    const reason=decision==='approve'&&(action.reason===undefined||action.reason==='')?'':text(action.reason,'reason',h,2000,3);
    const before=policy.status;
    if(decision==='approve'){for(const previous of w.policies.filter((row:any)=>row.id===policy.id&&row.status==='active'))Object.assign(previous,{status:'superseded',superseded_at:w.now,superseded_by:`${policy.id}@v${policy.version}`});Object.assign(policy,{status:'active',decided_by:actor.id,decided_at:w.now,decision_reason:reason});}
    else Object.assign(policy,{status:decision==='retire'?'retired':'rejected',decided_by:actor.id,decided_at:w.now,decision_reason:reason});
    log(w,{actor:actor.id,role:workRole(actor),action:`${decision}_policy`,subject:`${policy.id}@v${policy.version}`,refs:[policy.id],reason,diff:{status:[before,policy.status]},evidence:[]},h);
    const released:any[]=[];
    if(decision==='approve'){
      // Items already waiting on a person may now be covered: re-check them under the new policy.
      for(const item of w.workItems.filter((row:any)=>row.state==='proposed'&&row.kind==='cash_receipt'&&row.proposal?.kind==='cash_application')){
        let assessed;try{assessed=evaluate(w,item,normalizeResolution(w,receiptOf(w,item,h),item.proposal.resolution,h),item.proposal.agent_confidence);}catch{continue;}
        Object.assign(item.proposal,{confidence:assessed.confidence.score,evidence_score:assessed.confidence.evidence,basis:assessed.confidence.basis,covered:assessed.coverage.covered,policies:assessed.coverage.policies,gaps:assessed.coverage.gaps});
        if(autonomyAllows(w,item,item.proposal)){item.awaiting=null;released.push({work_item_id:item.id,...autoApprove(w,item,h)});}
      }
    }
    return done({policy,released});
  }
  if(type==='handoff_write'){
    only(action,['summary','open_items','next_steps'],h);
    if(!can(actor,'write',{kind:'handoff'}))h.fail('work_permission_denied','Only the seat writes handoffs',403);
    const list=(value:unknown,label:string,max:number)=>value===undefined?[]:Array.isArray(value)&&value.length<=max&&value.every(item=>typeof item==='string'&&item.trim()&&item.length<=500)?(value as string[]).map(item=>item.trim()):h.fail('invalid_handoff',`${label} must be at most ${max} short strings`);
    const handoff={id:`HO-${w.workSeq.handoff++}`,at:w.now,by:actor.id,...(runOf(actor)?{run_id:runOf(actor)}:{}),summary:text(action.summary,'summary',h,4000,10),open_items:list(action.open_items,'open_items',30),next_steps:list(action.next_steps,'next_steps',10)};
    w.handoffs.push(handoff);h.emit('work.handoff_written',{handoff_id:handoff.id,run_id:handoff.run_id});return done({handoff});
  }
  if(type==='seat_configure'){
    only(action,['enabled','auto_post','min_confidence','max_auto_minor','colleagues'],h);
    if(!can(actor,'configure',{kind:'seat'}))h.fail('work_permission_denied','Only the controller configures the seat',403);
    const before=clone(w.seat.autonomy),simulation=clone(w.seat.simulation);
    for(const key of ['enabled','auto_post'] as const)if(action[key]!==undefined){if(typeof action[key]!=='boolean')h.fail('invalid_seat_setting',`${key} must be boolean`);w.seat.autonomy[key]=action[key];}
    if(action.min_confidence!==undefined){if(typeof action.min_confidence!=='number'||action.min_confidence<0.5||action.min_confidence>1)h.fail('invalid_seat_setting','min_confidence must be from 0.5 to 1');w.seat.autonomy.min_confidence=action.min_confidence;}
    if(action.max_auto_minor!==undefined)w.seat.autonomy.max_auto_minor=h.integer(action.max_auto_minor,'max_auto_minor',0,1e11);
    if(action.colleagues!==undefined){if(typeof action.colleagues!=='boolean')h.fail('invalid_seat_setting','colleagues must be boolean');w.seat.simulation.colleagues=action.colleagues;}
    log(w,{actor:actor.id,role:workRole(actor),action:'configure_seat',subject:w.seat.id,refs:[w.seat.id],reason:'Seat settings changed',diff:{...diff(before,w.seat.autonomy),...diff(simulation,w.seat.simulation)},evidence:[]},h);
    return done({seat:w.seat});
  }
  if(type==='seat_onboarded'){
    if(!can(actor,'onboarded',{kind:'seat'}))h.fail('work_permission_denied','Onboarding completion is recorded by the host',403);
    const before=w.seat.onboarding.status;w.seat.onboarding={status:'done',completed_at:w.now,policies_proposed:w.policies.length,...(action.run_id?{run_id:String(action.run_id).slice(0,80)}:{})};
    log(w,{actor:actor.id,role:workRole(actor),action:'complete_onboarding',subject:w.seat.id,refs:[w.seat.id],reason:`${w.policies.length} policies proposed from history`,diff:{onboarding:[before,'done']},evidence:[]},h);
    return done({seat:w.seat});
  }
  // work_retry_posting
  if(!['gateway','controller'].includes(workRole(actor)??''))h.fail('work_permission_denied','Only the gateway or controller retries postings',403);
  const retried=w.workItems.filter((item:any)=>item.state==='approved').map((item:any)=>({work_item_id:item.id,...gatewayPost(w,item,h)}));
  return done({retried});
}

/** Time passing is how the seat remembers: due follow-ups wake, paid ones close,
 * and approved work blocked by an outage posts once the ledger is back. */
export function advanceWork(w:World,h:CashHooks){
  if(!w.seat)return;normalizeWork(w);
  for(const item of w.workItems.filter((row:any)=>row.kind==='follow_up'&&row.state==='scheduled'&&row.due_at<=w.now)){
    const invoice=w.invoices.find((row:any)=>row.id===item.subject_id);
    if(!invoice||invoice.amount_paid_minor>=invoice.amount_minor)transition(w,item,'close',SYNC,{reason:`${item.subject_id} paid before the follow-up was due`},h);
    else transition(w,item,'wake',SYNC,{reason:`Follow-up due: ${invoice.id} still has ${dollars(invoice.amount_minor-invoice.amount_paid_minor)} open`},h);
  }
  for(const item of w.workItems.filter((row:any)=>row.state==='approved'&&row.posting_error))gatewayPost(w,item,h);
}

export const AGENT_STATES=['new','answered','rejected'];
export function agentQueue(w:World){return (w.workItems??[]).filter((item:any)=>AGENT_STATES.includes(item.state));}
export function waitingOnPeople(w:World){return (w.workItems??[]).filter((item:any)=>['proposed','needs_info','escalated'].includes(item.state));}
function compactItem(item:any){return {id:item.id,kind:item.kind,state:item.state,title:item.title,subject_id:item.subject_id,amount_minor:item.amount_minor,updated_at:item.updated_at,...(item.due_at?{due_at:item.due_at}:{}),...(item.last_rejection?{last_rejection:item.last_rejection}:{}),...(item.open_question_id?{open_question_id:item.open_question_id}:{}),...(item.awaiting?{awaiting:item.awaiting}:{})};}
function compactPolicy(policy:any){return {id:policy.id,version:policy.version,status:policy.status,title:policy.title,statement:policy.statement,rule:policy.rule,backtest:{covered:policy.backtest.covered,support:policy.backtest.support,contrary:policy.backtest.contrary},proposed_at:policy.proposed_at,...(policy.decided_by?{decided_by:policy.decided_by,decision_reason:policy.decision_reason}:{})};}

/** What a returning colleague reads first: the queue, the rules in force, what people
 * said since the last shift and the last handoff. It persists across runs. */
export function workBriefing(w:World){
  normalizeWork(w);
  const counts=Object.fromEntries(['new','proposed','needs_info','answered','rejected','approved','posted','escalated','scheduled','closed'].map(state=>[state,w.workItems.filter((item:any)=>item.state===state).length]));
  const feedback=w.precedents.slice(-10).reverse().map((row:any)=>({id:row.id,at:row.at,work_item_id:row.work_item_id,source:row.source,by:row.human.by,decision:row.human.decision,reason:row.human.reason,customer_ids:row.features?.customer_ids??[]}));
  return {seat:{title:w.seat.title,company:w.seat.company,one_line:w.seat.one_line,duties:w.seat.duties,people:w.seat.people,access:w.seat.access,autonomy:w.seat.autonomy,onboarding:w.seat.onboarding},now:w.now,counts,
    your_queue:agentQueue(w).map(compactItem),waiting_on_people:waitingOnPeople(w).map(compactItem),blocked_postings:w.workItems.filter((item:any)=>item.posting_error).map(compactItem),
    policies:{active:w.policies.filter((row:any)=>row.status==='active').map(compactPolicy),proposed:w.policies.filter((row:any)=>row.status==='proposed').map(compactPolicy),rejected:w.policies.filter((row:any)=>row.status==='rejected').slice(-5).map(compactPolicy)},
    recent_feedback:feedback,last_handoffs:w.handoffs.slice(-3).reverse(),
    history:{receipts:w.cashHistory.receipts.length,applications:w.cashHistory.applications.length,from:w.cashHistory.receipts[0]?.posted_at??null,to:w.cashHistory.receipts.at(-1)?.posted_at??null,note:'Query it with query_history (SQL, read-only).'}};
}
function historySummary(w:World,customerIds:string[],payer:string){
  const cases=historyCases(w).filter(c=>c.customers.some(id=>customerIds.includes(id))||(payer&&normalizePayer(c.receipt.payer_name)===normalizePayer(payer)));
  const treatments=new Map<string,{count:number;examples:string[];gaps:number[]}>();
  for(const c of cases){
    const key=c.adjustments.length?c.adjustments.map(row=>row.account).join('+'):c.gap>0?'gap left open':c.applications.some((row:any)=>!row.invoice_id)?'not applied':'paid as billed';
    const row=treatments.get(key)??{count:0,examples:[],gaps:[]};row.count++;if(row.examples.length<3)row.examples.push(c.receipt.id);if(c.gap>0)row.gaps.push(c.gap);treatments.set(key,row);
  }
  return {receipts:cases.length,channels:[...new Set(cases.map(c=>c.receipt.channel))],payer_names:[...new Set(cases.map(c=>c.receipt.payer_name).filter(Boolean))].slice(0,5),
    treatments:[...treatments].map(([treatment,row])=>({treatment,count:row.count,examples:row.examples,...(row.gaps.length?{gap_range:[dollars(Math.min(...row.gaps)),dollars(Math.max(...row.gaps))]}:{})})).sort((a,b)=>b.count-a.count)};
}
export function workItemView(w:World,id:string,h:Pick<CashHooks,'find'>){
  normalizeWork(w);const item=h.find(w.workItems,id,'Work item');
  const timeline=w.workLog.filter((row:any)=>row.subject===item.id),questions=w.questions.filter((row:any)=>row.work_item_id===item.id);
  if(item.kind!=='cash_receipt'){
    const invoice=w.invoices.find((row:any)=>row.id===item.subject_id),customer=invoice&&w.customers.find((row:any)=>row.id===invoice.customer_id);
    return {item,invoice,customer,applications:w.cashApplications.filter((row:any)=>row.allocations.some((line:any)=>line.invoice_id===item.subject_id)),messages:w.messages.filter((row:any)=>row.source_refs?.includes(item.subject_id)).map((row:any)=>({id:row.id,direction:row.direction,subject:row.subject,created_at:row.created_at,to:row.to,from:row.from})),questions,timeline};
  }
  const receipt=w.bankReceipts.find((row:any)=>row.id===item.subject_id),features=receiptFeatures(w,receipt);
  const invoices=features.candidates.map(row=>{const invoice=w.invoices.find((entry:any)=>entry.id===row.invoice_id),customer=w.customers.find((entry:any)=>entry.id===invoice.customer_id);return {...row,customer_name:customer?.name,amount_minor:invoice.amount_minor,amount_paid_minor:invoice.amount_paid_minor,issued_at:invoice.issued_at,due_at:invoice.due_at,status:invoice.status,terms:invoice.terms,...(invoice.keg_deposit_minor?{keg_deposit_minor:invoice.keg_deposit_minor}:{})};});
  const customerIds=[...new Set(invoices.map(row=>row.customer_id))];
  const similar=w.precedents.filter((row:any)=>row.features?.customer_ids?.some((customer:string)=>customerIds.includes(customer))||(receipt.payer_name&&normalizePayer(row.features?.payer_name)===normalizePayer(receipt.payer_name))).slice(-8);
  return {item,receipt,features:{memo_refs:features.memo_refs,refs:features.refs,payer:features.payer,gap_minor:features.gap_minor,referenced_open_minor:features.referenced_open_minor,keg_returns_available:features.keg_returns_available},
    remittances:features.remittances,candidate_invoices:invoices,keg_returns:w.kegReturns.filter((row:any)=>customerIds.includes(row.customer_id)),history:historySummary(w,customerIds,receipt.payer_name),
    similar_precedents:similar,questions,timeline,adjustment_kinds:Object.fromEntries(Object.entries(adjustmentKinds).map(([kind,row])=>[kind,row.label]))};
}
export function precedentSearch(w:World,query:{customer_id?:string;payer?:string;kind?:string;text?:string;limit?:number}){
  normalizeWork(w);const needle=query.text?.toLowerCase();
  const rows=w.precedents.filter((row:any)=>(!query.customer_id||row.features?.customer_ids?.includes(query.customer_id))&&(!query.payer||normalizePayer(row.features?.payer_name)===normalizePayer(query.payer))&&(!query.kind||row.human?.adjustment_kinds?.includes(query.kind)||row.agent_proposal?.adjustment_kinds?.includes(query.kind))&&(!needle||JSON.stringify(row).toLowerCase().includes(needle)));
  return rows.slice(-(query.limit??20)).reverse();
}
/** Months later, "why?" is one query over the append-only log and the records it cites. */
export function whyTimeline(w:World,subject:string){
  normalizeWork(w);
  const items=new Set<string>(w.workItems.filter((item:any)=>item.id===subject||item.subject_id===subject||item.refs?.includes(subject)).map((item:any)=>item.id));
  const entries=w.workLog.filter((row:any)=>row.subject===subject||items.has(row.subject)||row.refs?.includes(subject)).map((row:any)=>({at:row.at,seq:row.seq,actor:row.actor,role:row.role,action:row.action,subject:row.subject,change:row.diff,why:row.reason,allowed:row.allowed,...(row.policy?{policy:row.policy}:{}),...(row.confidence!==undefined?{confidence:row.confidence}:{}),evidence:row.evidence}));
  const applications=w.cashApplications.filter((row:any)=>items.has(row.work_item_id)||row.receipt_id===subject||row.allocations.some((line:any)=>line.invoice_id===subject));
  const journals=w.journals.filter((row:any)=>applications.some((application:any)=>application.journal_id===row.id)||row.source_id===subject);
  return {subject,work_items:[...items],timeline:entries,applications,journals};
}

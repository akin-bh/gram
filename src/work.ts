/** gram's system of work. Systems of record hold the truth about the business; this
 * holds the truth about the work: work items, decisions and their reasons, questions
 * and approvals, learned policies, precedents and an append-only transition log.
 * Every change goes through transition(), which checks the actor's role first. The
 * agent can propose, ask and escalate; only people approve, only the controller
 * approves policy, and only the gateway writes to the ledger.
 *
 * Nothing here knows what a bank receipt or a venue settlement is. Everything about
 * the records, the hard checks, the policy kinds and the posting comes from the seat's
 * SeatDomain (src/seat-domain.ts), so a second seat is a second domain, not a second
 * system of work.
 */
import type {Action,Actor,World} from './world.ts';
import {canonical,domainFor} from './seat-domain.ts';
import type {WorkHooks,SeatDomain} from './seat-domain.ts';

export type WorkRole='sync'|'ai_agent'|'accountant'|'controller'|'policy_engine'|'gateway'|'dispatcher';
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
  /** The host's scheduler. When the seat leaves an item untouched twice, the dispatcher hands it to a
   * person instead of relaunching forever. It can do nothing else. */
  dispatcher:{work_item:['escalate']},
};
export const SYNC:Actor={id:'sync',role:'system'} as any,GATEWAY:Actor={id:'gateway',role:'system'} as any,POLICY_ENGINE:Actor={id:'policy-engine',role:'system'} as any,DISPATCHER:Actor={id:'dispatcher',role:'system'} as any;
export function workRole(actor:Actor):WorkRole|undefined{
  const role=actor?.role as string;
  if(role==='agent')return 'ai_agent';
  if(role==='controller'||role==='accountant')return role;
  if(role==='system')return ({sync:'sync',gateway:'gateway','policy-engine':'policy_engine',dispatcher:'dispatcher'} as Record<string,WorkRole>)[actor.id];
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
  w.seat.ablation??={trust_agent_confidence:false,skip_backtest:false};
}
const clone=<T,>(value:T):T=>structuredClone(value);
const snap=(item:any)=>({state:item.state,proposal:item.proposal?.id??null,decision:item.decision?.kind??null,approved_by:item.decision?.by??null,open_question:item.open_question_id??null,application:item.application_id??null,posting_error:item.posting_error?.code??null});
function diff(before:Record<string,unknown>,after:Record<string,unknown>){return Object.fromEntries(Object.keys(after).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])).map(key=>[key,[before[key]??null,after[key]??null]]));}
function log(w:World,entry:Record<string,any>,h:WorkHooks){
  const row={seq:w.workSeq.log++,at:w.now,allowed:true,...entry};
  w.workLog.push(row);h.emit('work.transition',row);return row;
}
function text(value:unknown,label:string,h:WorkHooks,limit=2000,min=1){
  if(typeof value!=='string'||value.trim().length<min||value.length>limit)h.fail('invalid_work_text',`${label} must be ${min>1?`at least ${min} and `:''}at most ${limit} characters`);
  return (value as string).trim();
}
function ids(value:unknown,label:string,h:WorkHooks,max=20){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>max||value.some(item=>typeof item!=='string'||!item||item.length>160))h.fail('invalid_work_refs',`${label} must be at most ${max} record IDs`);
  return [...new Set(value as string[])];
}
function permitted(actor:Actor,action:string,kind:string,h:WorkHooks){if(!can(actor,action,{kind}))h.fail('work_permission_denied',`${workRole(actor)??actor.role} may not ${action} a ${kind.replace('_',' ')}`,403);}
function only(action:Action,fields:string[],h:WorkHooks){if(Object.keys(action).some(key=>!['type','action',...fields].includes(key)))h.fail('invalid_work_field',`Unsupported field for ${action.type}`);}
const runOf=(actor:Actor)=>(actor as any).runId as string|undefined;

export function transition(w:World,item:any,action:string,actor:Actor,options:{patch?:Record<string,any>;reason?:string;evidence?:string[];refs?:string[];policy?:any;confidence?:number},h:WorkHooks){
  const role=workRole(actor),to=TRANSITIONS[action]?.[item.state];
  if(!can(actor,action,{kind:'work_item',proposed_by:action==='approve'?item.proposal?.proposed_by:null}))h.fail('work_permission_denied',`${role??actor.role} may not ${action} ${item.id}`,403);
  if(!to)h.fail('invalid_transition',`Cannot ${action} ${item.id} while it is ${item.state}`,409);
  const before=snap(item);Object.assign(item,options.patch??{},{state:to,updated_at:w.now});
  const refs=[...new Set([...(item.refs??[]),...(options.refs??[])])];item.refs=refs;
  return log(w,{actor:actor.id,role,action,subject:item.id,refs,reason:options.reason??'',diff:diff(before,snap(item)),evidence:options.evidence??[],...(options.policy?{policy:options.policy}:{}),...(options.confidence!==undefined?{confidence:options.confidence}:{}),...(runOf(actor)?{run_id:runOf(actor)}:{})},h);
}
export function createWorkItem(w:World,data:{kind:string;state?:string;title:string;subject_id:string;refs:string[];amount_minor?:number;due_at?:string;reason?:string},actor:Actor,h:WorkHooks){
  normalizeWork(w);
  if(!can(actor,'create',{kind:'work_item'}))h.fail('work_permission_denied',`${actor.id} may not create work items`,403);
  const item:any={id:`WI-${w.workSeq.item++}`,kind:data.kind,state:data.state??'new',title:data.title,subject_id:data.subject_id,refs:data.refs,...(data.amount_minor!==undefined?{amount_minor:data.amount_minor}:{}),...(data.due_at?{due_at:data.due_at}:{}),created_by:actor.id,created_at:w.now,updated_at:w.now,question_ids:[]};
  w.workItems.push(item);
  log(w,{actor:actor.id,role:workRole(actor),action:'create',subject:item.id,refs:item.refs,reason:data.reason??'',diff:{state:[null,item.state]},evidence:item.refs},h);
  return item;
}
const findItem=(w:World,id:unknown,h:WorkHooks)=>h.find(w.workItems,id,'Work item');

function recordPrecedent(w:World,d:SeatDomain,item:any,source:'answer'|'approval'|'rejection'|'correction',actor:Actor,human:{decision:string;reason:string;resolution?:any},h:WorkHooks){
  const proposal=item.proposal,summary=proposal?.resolution?d.summarizeResolution(proposal.resolution):null;
  const row={id:`prec-${w.workSeq.precedent++}`,at:w.now,source,work_item_id:item.id,subject_id:item.subject_id,features:d.precedentFeatures(w,item),
    agent_proposal:proposal?{allocations:summary?.allocations??[],adjustment_kinds:summary?.adjustment_kinds??[],confidence:proposal.confidence}:null,
    human:{by:actor.id,role:workRole(actor),decision:human.decision,reason:human.reason,adjustment_kinds:human.resolution?d.summarizeResolution(human.resolution).adjustment_kinds:null}};
  w.precedents.push(row);h.emit('work.precedent_recorded',{precedent_id:row.id,work_item_id:item.id,source,by:actor.id});return row;
}

/** What a proposal would do, independent of its wording. A proposal a person rejected cannot
 * come back under new words: the gateway compares what it does, not what it says. */
const proposalFingerprint=(d:SeatDomain,proposal:any)=>canonical(proposal.kind==='reminder'?{reminder:proposal.reminder}:d.fingerprint(proposal.resolution));
/** Every proposal an item ever received, kept for the score and the "why" view. */
const compactProposal=(d:SeatDomain,proposal:any)=>({id:proposal.id,kind:proposal.kind,at:proposal.proposed_at,by:proposal.proposed_by,...(proposal.run_id?{run_id:proposal.run_id}:{}),...(proposal.resolution?d.summarizeResolution(proposal.resolution):{allocations:[],adjustment_kinds:[],hold_on_account:false,chase:null}),confidence:proposal.confidence,fingerprint:proposalFingerprint(d,proposal)});

function gatewayPost(w:World,item:any,h:WorkHooks){
  const d=domainFor(w);
  try{
    h.available(d.readSystems.post);
    if(item.kind==='follow_up'){
      const sent=d.reminder(w,item,h);
      transition(w,item,'post',GATEWAY,{patch:{posting_error:null,reminder_message_id:sent.message_id},reason:`Reminder ${sent.message_id} sent`,refs:[sent.message_id],evidence:[sent.message_id]},h);
      if(sent.follow_up)createWorkItem(w,sent.follow_up,GATEWAY,h);
      return {message_id:sent.message_id};
    }
    const resolution=d.normalize(w,item,item.decision.resolution,h);
    const posting=d.post(w,item,resolution,{approved_by:item.decision.by,approval:item.decision.kind,policies:item.decision.policies??[]},h);
    transition(w,item,'post',GATEWAY,{patch:{application_id:posting.id,posting_error:null},reason:`Posted ${posting.id}${posting.journal_id?` (journal ${posting.journal_id})`:''}`,refs:[posting.id,...posting.refs],evidence:posting.evidence},h);
    for(const followUp of posting.follow_ups??[])posting.follow_up_item_id=createWorkItem(w,followUp,GATEWAY,h).id;
    for(const subject of posting.close_follow_ups_for??[])for(const followUp of w.workItems.filter((entry:any)=>entry.kind==='follow_up'&&entry.subject_id===subject&&['scheduled','new'].includes(entry.state)))transition(w,followUp,'close',GATEWAY,{reason:`${subject} settled by ${posting.id}`,refs:[posting.id]},h);
    delete posting.follow_ups;delete posting.close_follow_ups_for;
    return {application:posting};
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
/** Under the trust-agent ablation the gateway's own evidence check is switched off and the agent's
 * stated confidence decides. It exists only to show, in the benchmark, what the gateway is for. */
const trustedConfidence=(w:World,proposal:any)=>w.seat.ablation?.trust_agent_confidence?proposal.agent_confidence:proposal.confidence;
function autonomyAllows(w:World,item:any,proposal:any){
  const autonomy=w.seat.autonomy,covered=w.seat.ablation?.trust_agent_confidence?true:proposal.covered;
  return autonomy.enabled&&autonomy.auto_post&&covered&&!proposal.needs_review&&trustedConfidence(w,proposal)>=autonomy.min_confidence&&(item.amount_minor??0)<=autonomy.max_auto_minor;
}
function autoApprove(w:World,item:any,h:WorkHooks){
  const proposal=item.proposal,confidence=trustedConfidence(w,proposal),names=proposal.policies.length?proposal.policies.map((policy:any)=>`${policy.id} v${policy.version}`).join(', '):'no policy (ablation: the agent\'s own confidence was trusted)';
  transition(w,item,'approve',POLICY_ENGINE,{patch:{decision:{kind:'policy',by:'policy-engine',reason:`Covered by ${names}; confidence ${Math.round(confidence*100)}%`,at:w.now,resolution:proposal.resolution,policies:proposal.policies}},reason:`Covered by ${names}; confidence ${Math.round(confidence*100)}% ≥ ${Math.round(w.seat.autonomy.min_confidence*100)}%`,policy:proposal.policies,confidence},h);
  return gatewayPost(w,item,h);
}
function evaluate(w:World,d:SeatDomain,item:any,resolution:any,agentConfidence:number){
  const features=d.features(w,item),coverage=d.coverage(w,item,resolution,features,w.policies);
  return {features,coverage,confidence:d.confidence(w,item,resolution,features,coverage,w.precedents,agentConfidence)};
}

export function workAction(w:World,action:Action,actor:Actor,h:WorkHooks):{handled:boolean;result?:any}{
  const type=action.type??action.action;
  if(!type||!(workActionTypes as readonly string[]).includes(type))return {handled:false};
  if(!w.seat)h.fail('no_seat','This company has no autonomous seat',409);
  const d=domainFor(w);
  normalizeWork(w);const done=(result:any)=>({handled:true,result});
  const resolutionFields=Object.keys(d.tools.proposeSchema).filter(key=>!['work_item_id','confidence','reason','evidence_ids','needs_review','reminder'].includes(key));
  if(type==='work_propose'){
    only(action,['work_item_id','reminder','confidence','reason','evidence_ids','needs_review',...resolutionFields],h);permitted(actor,'propose','work_item',h);
    const item=findItem(w,action.work_item_id,h),agentConfidence=typeof action.confidence==='number'&&action.confidence>=0&&action.confidence<=1?action.confidence:h.fail('invalid_confidence','confidence must be a number from 0 to 1');
    const reason=text(action.reason,'reason',h,2000,10),evidence=ids(action.evidence_ids,'evidence_ids',h);
    let proposal:any;
    if(item.kind==='follow_up'){
      proposal={id:`P-${w.workSeq.proposal++}`,kind:'reminder',reminder:text(action.reminder,'reminder',h,4000,20),reason,evidence_ids:evidence,agent_confidence:agentConfidence,confidence:agentConfidence,basis:[{factor:'outbound',score:agentConfidence,why:'outside communication always needs a person'}],covered:false,policies:[],gaps:['outside communication needs approval'],needs_review:true,proposed_by:actor.id,proposed_at:w.now,...(runOf(actor)?{run_id:runOf(actor)}:{})};
    }else{
      if(!d.proposableKinds.includes(item.kind))h.fail('invalid_work_item',`Only ${d.proposableKinds.join(', ')} items and follow-ups take proposals`,409);
      const resolution=d.normalize(w,item,action,h),assessed=evaluate(w,d,item,resolution,agentConfidence);
      proposal={id:`P-${w.workSeq.proposal++}`,kind:d.proposalKind,resolution,lines:d.describeResolution(w,resolution),reason,evidence_ids:evidence,agent_confidence:agentConfidence,confidence:assessed.confidence.score,evidence_score:assessed.confidence.evidence,basis:assessed.confidence.basis,covered:assessed.coverage.covered,policies:assessed.coverage.policies,gaps:assessed.coverage.gaps,needs_review:action.needs_review===true,proposed_by:actor.id,proposed_at:w.now,...(runOf(actor)?{run_id:runOf(actor)}:{})};
    }
    // A no from a person is final for that move. The same resolution cannot be proposed again, however it is worded.
    const fingerprint=proposalFingerprint(d,proposal),repeat=(item.rejected_proposals??[]).find((row:any)=>row.fingerprint===fingerprint);
    if(repeat)h.fail('repeat_proposal',`${repeat.proposal_id} proposed exactly this and ${repeat.by} rejected it: "${repeat.reason}". Change the proposal, ask a question, or escalate; do not resubmit it.`,409);
    transition(w,item,'propose',actor,{patch:{proposal,open_question_id:null,proposals:[...(item.proposals??[]),compactProposal(d,proposal)]},reason,evidence,confidence:proposal.confidence,refs:proposal.resolution?d.resolutionRefs(proposal.resolution):[]},h);
    if(item.kind!=='follow_up'&&autonomyAllows(w,item,proposal))return done({work_item:item,proposal,outcome:'auto_approved',...autoApprove(w,item,h)});
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
    const precedent=recordPrecedent(w,d,item,'answer',actor,{decision:'answer',reason:`Q: ${question.question}\nA: ${answer}`},h);
    return done({work_item:item,question,precedent});
  }
  if(type==='work_guide'){
    only(action,['work_item_id','guidance'],h);permitted(actor,'guide','work_item',h);
    const item=findItem(w,action.work_item_id,h),guidance=text(action.guidance,'guidance',h,4000,3);
    transition(w,item,'guide',actor,{patch:{awaiting:null,guidance:{by:actor.id,text:guidance,at:w.now}},reason:guidance},h);
    const precedent=recordPrecedent(w,d,item,'answer',actor,{decision:'answer',reason:`Guidance on escalation: ${guidance}`},h);
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
      const precedent=d.proposableKinds.includes(item.kind)?recordPrecedent(w,d,item,'approval',actor,{decision:'approve',reason,resolution:item.proposal.resolution},h):undefined;
      return done({work_item:item,precedent,...gatewayPost(w,item,h)});
    }
    transition(w,item,'reject',actor,{patch:{decision:null,awaiting:null,last_rejection:{by:actor.id,reason,at:w.now,proposal_id:item.proposal.id},rejected_proposals:[...(item.rejected_proposals??[]),{proposal_id:item.proposal.id,fingerprint:proposalFingerprint(d,item.proposal),by:actor.id,reason,at:w.now}]},reason},h);
    const precedent=recordPrecedent(w,d,item,'rejection',actor,{decision:'reject',reason},h);
    return done({work_item:item,precedent});
  }
  if(type==='work_correct'){
    only(action,['work_item_id','reason',...resolutionFields],h);permitted(actor,'correct','work_item',h);
    const item=findItem(w,action.work_item_id,h);if(!d.proposableKinds.includes(item.kind))h.fail('invalid_work_item',`Only ${d.proposableKinds.join(', ')} items take corrections`,409);
    const resolution=d.normalize(w,item,action,h),reason=text(action.reason,'reason',h,2000,3);
    transition(w,item,'correct',actor,{patch:{decision:{kind:'human',by:actor.id,reason,at:w.now,resolution,policies:[],corrected:true},awaiting:null,open_question_id:null},reason,refs:d.resolutionRefs(resolution)},h);
    const precedent=recordPrecedent(w,d,item,'correction',actor,{decision:'correct',reason,resolution},h);
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
    const parsed=d.ruleSchema.safeParse(action.rule);if(!parsed.success)h.fail('invalid_policy_rule',`Rule does not match a supported policy kind: ${parsed.error.issues.map((issue:any)=>`${issue.path.join('.')||'rule'} ${issue.message}`).join('; ')}`);
    const rule=parsed.data as any;
    d.validateRule(w,rule,h);
    const evidence=action.evidence??{};if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))h.fail('invalid_policy_evidence','evidence must be an object');
    const queries=evidence.queries===undefined?[]:Array.isArray(evidence.queries)&&evidence.queries.length<=6?evidence.queries.map((query:any)=>({sql:text(query?.sql,'evidence query',h,4000,10),finding:text(query?.finding,'query finding',h,1000,5)})):h.fail('invalid_policy_evidence','At most six evidence queries');
    const precedentIds=ids(evidence.precedent_ids,'precedent_ids',h);for(const id of precedentIds)h.find(w.precedents,id,'Precedent');
    if(!queries.length&&!precedentIds.length)h.fail('policy_evidence_required','A policy proposal cites history queries or precedents');
    const key=d.ruleKey(rule),existing=w.policies.find((policy:any)=>['proposed','active'].includes(policy.status)&&policy.rule_key===key);
    if(existing)return done({policy:existing,duplicate:true});
    let id=`pol-${String(w.workSeq.policy).padStart(3,'0')}`,version=1;
    if(action.supersedes!==undefined){
      const previous=h.find(w.policies,action.supersedes,'Policy');id=previous.id;version=Math.max(...w.policies.filter((policy:any)=>policy.id===previous.id).map((policy:any)=>policy.version))+1;
    }else w.workSeq.policy++;
    const policy={id,version,status:'proposed',rule,rule_key:key,title:text(action.title,'title',h,120,5),statement:d.describeRule(rule),rationale:text(action.rationale,'rationale',h,2000,10),evidence:{queries,precedent_ids:precedentIds},backtest:d.backtest(w,rule,w.precedents),proposed_by:actor.id,proposed_at:w.now,...(runOf(actor)?{run_id:runOf(actor)}:{})};
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
      for(const item of w.workItems.filter((row:any)=>row.state==='proposed'&&d.proposableKinds.includes(row.kind)&&row.proposal?.resolution)){
        let assessed;try{assessed=evaluate(w,d,item,d.normalize(w,item,item.proposal.resolution,h),item.proposal.agent_confidence);}catch{continue;}
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
    only(action,['enabled','auto_post','min_confidence','max_auto_minor','colleagues','ablation'],h);
    if(!can(actor,'configure',{kind:'seat'}))h.fail('work_permission_denied','Only the controller configures the seat',403);
    const before=clone(w.seat.autonomy),simulation=clone(w.seat.simulation),ablationBefore=clone(w.seat.ablation??{});
    for(const key of ['enabled','auto_post'] as const)if(action[key]!==undefined){if(typeof action[key]!=='boolean')h.fail('invalid_seat_setting',`${key} must be boolean`);w.seat.autonomy[key]=action[key];}
    if(action.min_confidence!==undefined){if(typeof action.min_confidence!=='number'||action.min_confidence<0.5||action.min_confidence>1)h.fail('invalid_seat_setting','min_confidence must be from 0.5 to 1');w.seat.autonomy.min_confidence=action.min_confidence;}
    if(action.max_auto_minor!==undefined)w.seat.autonomy.max_auto_minor=h.integer(action.max_auto_minor,'max_auto_minor',0,1e11);
    if(action.colleagues!==undefined){if(typeof action.colleagues!=='boolean')h.fail('invalid_seat_setting','colleagues must be boolean');w.seat.simulation.colleagues=action.colleagues;}
    if(action.ablation!==undefined){
      const ablation=action.ablation;
      if(!ablation||typeof ablation!=='object'||Array.isArray(ablation)||Object.keys(ablation).some(key=>!['trust_agent_confidence','skip_backtest'].includes(key))||Object.values(ablation).some(value=>typeof value!=='boolean'))h.fail('invalid_seat_setting','ablation accepts trust_agent_confidence and skip_backtest booleans');
      w.seat.ablation={...(w.seat.ablation??{}),...ablation};
    }
    log(w,{actor:actor.id,role:workRole(actor),action:'configure_seat',subject:w.seat.id,refs:[w.seat.id],reason:'Seat settings changed',diff:{...diff(before,w.seat.autonomy),...diff(simulation,w.seat.simulation),...diff(ablationBefore,w.seat.ablation??{})},evidence:[]},h);
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

/** Time passing is how the seat remembers: due follow-ups wake, settled ones close,
 * and approved work blocked by an outage posts once the ledger is back. */
export function advanceWork(w:World,h:WorkHooks){
  if(!w.seat)return;normalizeWork(w);
  const d=domainFor(w);
  for(const item of w.workItems.filter((row:any)=>row.kind==='follow_up'&&row.state==='scheduled'&&row.due_at<=w.now)){
    const status=d.followUpOpen(w,item);
    if(!status.open)transition(w,item,'close',SYNC,{reason:status.reason},h);
    else transition(w,item,'wake',SYNC,{reason:status.reason},h);
  }
  for(const item of w.workItems.filter((row:any)=>row.state==='approved'&&row.posting_error))gatewayPost(w,item,h);
}

export const AGENT_STATES=['new','answered','rejected'];
export function agentQueue(w:World){return (w.workItems??[]).filter((item:any)=>AGENT_STATES.includes(item.state));}
export function waitingOnPeople(w:World){return (w.workItems??[]).filter((item:any)=>['proposed','needs_info','escalated'].includes(item.state));}
function compactItem(item:any){return {id:item.id,kind:item.kind,state:item.state,title:item.title,subject_id:item.subject_id,amount_minor:item.amount_minor,updated_at:item.updated_at,...(item.due_at?{due_at:item.due_at}:{}),...(item.last_rejection?{last_rejection:item.last_rejection}:{}),...(item.open_question_id?{open_question_id:item.open_question_id}:{}),...(item.awaiting?{awaiting:item.awaiting}:{})};}
function compactPolicy(policy:any){return {id:policy.id,version:policy.version,status:policy.status,title:policy.title,statement:policy.statement,rule:policy.rule,backtest:{covered:policy.backtest.covered,support:policy.backtest.support,contrary:policy.backtest.contrary,...(policy.backtest.bound?{bound:policy.backtest.bound}:{})},proposed_at:policy.proposed_at,...(policy.decided_by?{decided_by:policy.decided_by,decision_reason:policy.decision_reason}:{})};}

/** What a returning colleague reads first: the queue, the rules in force, what people
 * said since the last shift and the last handoff. It persists across runs. */
export function workBriefing(w:World){
  normalizeWork(w);
  const d=domainFor(w);
  const counts=Object.fromEntries(['new','proposed','needs_info','answered','rejected','approved','posted','escalated','scheduled','closed'].map(state=>[state,w.workItems.filter((item:any)=>item.state===state).length]));
  const feedback=w.precedents.slice(-10).reverse().map((row:any)=>({id:row.id,at:row.at,work_item_id:row.work_item_id,source:row.source,by:row.human.by,decision:row.human.decision,reason:row.human.reason,subject_ids:row.features?.customer_ids??row.features?.subject_ids??[]}));
  return {seat:{title:w.seat.title,company:w.seat.company,one_line:w.seat.one_line,duties:w.seat.duties,people:w.seat.people,access:w.seat.access,autonomy:w.seat.autonomy,onboarding:w.seat.onboarding},now:w.now,counts,
    your_queue:agentQueue(w).map(compactItem),waiting_on_people:waitingOnPeople(w).map(compactItem),blocked_postings:w.workItems.filter((item:any)=>item.posting_error).map(compactItem),
    policies:{active:w.policies.filter((row:any)=>row.status==='active').map(compactPolicy),proposed:w.policies.filter((row:any)=>row.status==='proposed').map(compactPolicy),rejected:w.policies.filter((row:any)=>row.status==='rejected').slice(-5).map(compactPolicy)},
    recent_feedback:feedback,last_handoffs:w.handoffs.slice(-3).reverse(),
    history:d.historySummary(w)};
}
export function workItemView(w:World,id:string,h:Pick<WorkHooks,'find'>){
  normalizeWork(w);const item=h.find(w.workItems,id,'Work item'),d=domainFor(w);
  const timeline=w.workLog.filter((row:any)=>row.subject===item.id),questions=w.questions.filter((row:any)=>row.work_item_id===item.id);
  return {item,...d.itemView(w,item,h),similar_precedents:d.similarPrecedents(w,item,w.precedents),questions,timeline};
}
export function precedentSearch(w:World,query:{subject_id?:string;counterparty?:string;kind?:string;text?:string;limit?:number}){
  normalizeWork(w);const needle=query.text?.toLowerCase(),d=domainFor(w);
  const rows=w.precedents.filter((row:any)=>d.precedentMatches(row,query)&&(!query.kind||row.human?.adjustment_kinds?.includes(query.kind)||row.agent_proposal?.adjustment_kinds?.includes(query.kind))&&(!needle||JSON.stringify(row).toLowerCase().includes(needle)));
  return rows.slice(-(query.limit??20)).reverse();
}
/** Months later, "why?" is one query over the append-only log and the records it cites. */
export function whyTimeline(w:World,subject:string){
  normalizeWork(w);const d=domainFor(w);
  const items=new Set<string>(w.workItems.filter((item:any)=>item.id===subject||item.subject_id===subject||item.refs?.includes(subject)).map((item:any)=>item.id));
  const entries=w.workLog.filter((row:any)=>row.subject===subject||items.has(row.subject)||row.refs?.includes(subject)).map((row:any)=>({at:row.at,seq:row.seq,actor:row.actor,role:row.role,action:row.action,subject:row.subject,change:row.diff,why:row.reason,allowed:row.allowed,...(row.policy?{policy:row.policy}:{}),...(row.confidence!==undefined?{confidence:row.confidence}:{}),evidence:row.evidence}));
  const postings=d.postings(w).filter((row:any)=>items.has(row.work_item_id)||d.postingTouches(row,subject));
  const journals=w.journals.filter((row:any)=>postings.some((posting:any)=>posting.journal_id===row.id)||row.source_id===subject);
  return {subject,work_items:[...items],timeline:entries,applications:postings,postings,journals};
}

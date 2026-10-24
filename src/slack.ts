/** Slack is where the finance team already talks, so the seat asks and gets answers there.
 * gram stays the system of work: every card is drawn from its state, every click goes
 * through the same work command and role check as the console, and a click on an
 * out-of-date card is refused. Socket Mode keeps the app local: no public URL.
 *
 * The channel reads like a team, not a log. Rules the seat learned together are one
 * message with one Approve-all for the controller; a proposal is three lines and what it
 * needs a person for; a question is one line; the person's own words go in the thread
 * under their name, simulated colleagues included; handoffs never leave gram.
 *
 * Identity is the Slack user ID in the payload, mapped to a gram role by explicit lists.
 * Message text is never authority; a thread reply only answers the question it replies to.
 * "@gram why SH-3004?" is answered from the append-only log, the same query as the console's Why?.
 * Cards are domain-neutral: the seat's domain writes each proposal's lines and the company's
 * currency, so the tour seat and the cash seat post the same cards.
 */
import {readFileSync} from 'node:fs';
import type {Store} from './store.ts';
import type {Actor} from './oauth.ts';
import {domainFor} from './seat-domain.ts';
import {whyTimeline,workBriefing} from './work.ts';

const ENV_FILE=Bun.fileURLToPath(new URL('../.env',import.meta.url));
export type SlackConfig={botToken:string;appToken:string;channel:string;teamId?:string;accountants:Set<string>;controllers:Set<string>};
function setting(name:string,file:Record<string,string>){return (process.env[name]??file[name]??'').trim();}
/** Tokens reach gram only through this loader and never leave the process. */
export function loadSlackConfig():{available:boolean;reason?:string;config?:SlackConfig;channel?:string}{
  const file:Record<string,string>={};
  try{for(const line of readFileSync(process.env.FINANCE_WORLD_ENV_FILE||ENV_FILE,'utf8').split(/\r\n?|\n/)){const match=line.match(/^\s*(?:export\s+)?(SLACK_[A-Z_]+)\s*=\s*(.*?)\s*$/);if(match)file[match[1]!]=match[2]!.replace(/^(['"])(.*)\1$/,'$2').replace(/\s+#.*$/,'');}}catch{}
  const botToken=setting('SLACK_BOT_TOKEN',file),appToken=setting('SLACK_APP_TOKEN',file),channel=setting('SLACK_CHANNEL_ID',file);
  const ids=(value:string)=>new Set(value.split(',').map(item=>item.trim()).filter(item=>/^[UW][A-Z0-9]{2,}$/.test(item)));
  const accountants=ids(setting('SLACK_ACCOUNTANTS',file)),controllers=ids(setting('SLACK_CONTROLLERS',file)),teamId=setting('SLACK_TEAM_ID',file)||undefined;
  if(!botToken.startsWith('xoxb-')||!appToken.startsWith('xapp-')||!/^[CG][A-Z0-9]{2,}$/.test(channel))return {available:false,reason:'Set SLACK_BOT_TOKEN (xoxb-), SLACK_APP_TOKEN (xapp-) and SLACK_CHANNEL_ID to connect Slack.'};
  if(!accountants.size&&!controllers.size)return {available:false,reason:'Map at least one Slack user ID in SLACK_ACCOUNTANTS or SLACK_CONTROLLERS.'};
  return {available:true,channel,config:{botToken,appToken,channel,teamId,accountants,controllers}};
}
/** Slack mrkdwn treats <, > and & as control characters (links, @channel). */
export const escapeSlack=(value:unknown)=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const clip=(value:unknown,limit=2800)=>{const text=escapeSlack(value);return text.length>limit?`${text.slice(0,limit-1)}…`:text;};
const pct=(value:number)=>`${Math.round(value*100)}%`;
/** Each seat's company books in its own currency; cards show the figures the console shows. */
function moneyFor(w:any){
  let currency='USD';try{currency=domainFor(w).defaults.currency||'USD';}catch{}
  const format=new Intl.NumberFormat('en-US',{style:'currency',currency});
  return (minor:number)=>format.format((Number(minor)||0)/100);
}
function peopleOf(w:any){const title=(role:string)=>(w.seat?.people??[]).find((row:any)=>row.role===role)?.title;return {accountant:title('accountant')??'Accountant',controller:title('controller')??'Controller'};}
/** Who acted, as the team would say it: a Slack mention, a named simulated colleague, or the console. */
function person(w:any,actor:unknown):{label:string;simulated:boolean}{
  const id=String(actor??''),people:any[]=w?.seat?.people??[];
  const titled=(row:any,suffix:string)=>`${clip(row.name)} · ${clip(row.title)}${suffix}`;
  if(id.startsWith('slack:'))return {label:`<@${id.slice(6)}>`,simulated:false};
  if(id.startsWith('sim:')){const key=id.slice(4),row=people.find((p:any)=>p.id===key)??(key==='controller'?people.find((p:any)=>p.role==='controller'):undefined);return {label:row?titled(row,' (simulated)'):`${clip(key)} (simulated)`,simulated:true};}
  if(id==='controller-local'){const row=people.find((p:any)=>p.role==='controller');return {label:row?titled(row,' (in gram)'):'Controller (in gram)',simulated:false};}
  if(id.startsWith('agent-world:'))return {label:'the seat',simulated:false};
  if(id==='policy-engine')return {label:'policy',simulated:false};
  return {label:clip(id),simulated:false};
}
/** A rule's bound next to the largest case that supports it, as the console shows it. */
function boundText(backtest:any,money:(minor:number)=>string){
  const bound=backtest?.bound;if(!bound||bound.largest_supporting===null||bound.largest_supporting===undefined)return '';
  const fmt=(value:number)=>bound.unit==='cents'?money(value):`${(value/100).toFixed(2)}%`;
  return ` · bound ${fmt(bound.rule)} vs largest case ${fmt(bound.largest_supporting)}${bound.headroom_pct>0?` (+${bound.headroom_pct}%)`:''}`;
}
/** Record ids as people type them: WI-5531, sh-3004, pol-001, ANZ-77400101. Matched case-insensitively against the work. */
function matchRecord(w:any,typed:string){
  const wanted=typed.toLowerCase(),pool=new Set<string>();
  for(const item of w.workItems??[]){pool.add(item.id);pool.add(item.subject_id);for(const ref of item.refs??[])pool.add(ref);}
  for(const policy of w.policies??[])pool.add(policy.id);
  for(const question of w.questions??[])pool.add(question.id);
  return [...pool].find(id=>String(id).toLowerCase()===wanted);
}
const policyGroup=(policy:any)=>policy.run_id?`run:${policy.run_id}`:`${policy.id}@v${policy.version}`;
export type SlackDeps={store:Store;baseUrl:string;config:SlackConfig;world:(id:string)=>any;work:(world:string,input:any,actor:Actor,key:string,requestId:string)=>any;transport?:typeof fetch;socket?:(url:string)=>WebSocket;now?:()=>number};
type Reply={label:string;simulated:boolean;text:string};
type Card={key:string;kind:'proposal'|'question'|'policy'|'escalation';text:string;blocks:any[];final:boolean;reply?:Reply};

export class SlackBridge{
  deps:SlackDeps;socket?:WebSocket;stopped=false;reconnects=0;connected=false;lastError?:string;private queue=Promise.resolve();
  constructor(deps:SlackDeps){this.deps=deps;}
  role(user:string):'accountant'|'controller'|undefined{return this.deps.config.controllers.has(user)?'controller':this.deps.config.accountants.has(user)?'accountant':undefined;}
  async api(method:string,body:Record<string,unknown>):Promise<any>{
    const response=await (this.deps.transport??fetch)(`https://slack.com/api/${method}`,{method:'POST',headers:{Authorization:`Bearer ${this.deps.config.botToken}`,'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(body)});
    if(response.status===429){const wait=Number(response.headers.get('retry-after')??'1');await Bun.sleep(Math.min(30,wait)*1000);return this.api(method,body);}
    const data:any=await response.json().catch(()=>({ok:false,error:'invalid_slack_response'}));
    if(!data.ok)throw new Error(`Slack ${method} failed: ${data.error}`);return data;
  }
  /** Draw the cards the work state calls for, and redraw any whose state moved on. */
  cards(worldId:string):Card[]{
    const w=this.deps.world(worldId),open=`${this.deps.baseUrl}/?world=${encodeURIComponent(worldId)}&view=work`,cards:Card[]=[],money=moneyFor(w),who=peopleOf(w),name=(actor:unknown)=>person(w,actor).label;
    const link=(id?:string)=>`<${open}${id?`&item=${encodeURIComponent(id)}`:''}|Open in gram>`;
    const receiptOf=(item:any)=>(w.bankReceipts??[]).find((row:any)=>row.id===item.subject_id);
    // The record under the item in one line: a bank line in any seat, otherwise the item's own title (an invoice, a follow-up).
    const headline=(item:any)=>{const receipt=receiptOf(item);return receipt?`${clip(receipt.bank_reference)} · ${money(receipt.amount_minor)} from ${clip(receipt.payer_name||'no payer name')} · \`${clip(receipt.memo||'—',120)}\``:clip(item.title??item.subject_id,200);};
    const seat=clip(w.seat?.title??'seat',80),said=(by:unknown,text:unknown):Reply|undefined=>{const words=String(text??'').trim();return words&&words!=='Approved in Slack'?{...person(w,by),text:words}:undefined;};
    for(const item of w.workItems){
      const line=headline(item);
      for(const proposal of item.proposal?[item.proposal]:[]){
        const live=item.state==='proposed'&&item.proposal.id===proposal.id,decided=w.workLog.filter((row:any)=>row.subject===item.id&&['approve','reject','correct','close','escalate','ask'].includes(row.action)&&row.at>=proposal.proposed_at).at(-1);
        const all:string[]=Array.isArray(proposal.lines)&&proposal.lines.length?proposal.lines:proposal.reminder?[`Send reminder: ${proposal.reminder}`]:[];
        const shown=all.slice(0,3).map(entry=>clip(entry,120)).join(' · ')+(all.length>3?` · +${all.length-3} more`:'');
        const verbs:Record<string,string>={approve:':white_check_mark: Approved',reject:':x: Rejected',correct:':pencil2: Corrected',close:':heavy_minus_sign: Closed',ask:':question: The seat asked a question instead',escalate:':arrow_up: Escalated'};
        const outcome=decided?`${verbs[decided.action]??clip(decided.action)} by ${name(decided.actor)}`:`_${clip(item.state)}_`;
        const blocks:any[]=[
          {type:'section',text:{type:'mrkdwn',text:`*${item.id}* · ${line}\n*Proposes* (${pct(proposal.confidence)}): ${shown||'—'}\n_${clip(proposal.reason,280)}_`}},
          ...(proposal.gaps?.length?[{type:'section',text:{type:'mrkdwn',text:`*Needs you:* ${proposal.gaps.slice(0,3).map((gap:string)=>clip(gap,160)).join(' · ')}`}}]:[]),
          ...(live?[{type:'actions',block_id:'decide',elements:[
            {type:'button',action_id:'gram_approve',style:'primary',text:{type:'plain_text',text:'Approve'},value:JSON.stringify({world:worldId,item:item.id,proposal:proposal.id}),confirm:{title:{type:'plain_text',text:'Approve and post?'},text:{type:'mrkdwn',text:'The gateway posts this to the ledger right away.'},confirm:{type:'plain_text',text:'Approve'},deny:{type:'plain_text',text:'Cancel'}}},
            {type:'button',action_id:'gram_reject',style:'danger',text:{type:'plain_text',text:'Reject…'},value:JSON.stringify({world:worldId,item:item.id,proposal:proposal.id})},
          ]}]:[{type:'context',elements:[{type:'mrkdwn',text:outcome}]}]),
          {type:'context',elements:[{type:'mrkdwn',text:`${seat} · ${link(item.id)}`}]},
        ];
        const reply=decided?said(decided.actor,decided.why):undefined;
        cards.push({key:`proposal:${item.id}:${proposal.id}`,kind:'proposal',text:`${item.id} needs a decision`,blocks,final:!live,...(reply?{reply}:{})});
      }
      if(item.state==='escalated'&&item.escalation)cards.push({key:`escalation:${item.id}:${item.escalation.at}`,kind:'escalation',text:`${item.id} escalated`,final:true,blocks:[
        {type:'section',text:{type:'mrkdwn',text:`*${item.id}* · ${line}\n:arrow_up: *Escalated to the ${clip(item.escalation.to_role==='controller'?who.controller:who.accountant)}:* ${clip(item.escalation.reason,500)}`}},{type:'context',elements:[{type:'mrkdwn',text:`${seat} · ${link(item.id)}`}]}]});
    }
    for(const question of w.questions){
      const item=w.workItems.find((row:any)=>row.id===question.work_item_id),live=question.status==='open';
      const outcome=question.status==='answered'?`:speech_balloon: Answered by ${name(question.answered_by)}`:question.status==='withdrawn'?'_Withdrawn_':'';
      const reply=question.status==='answered'?said(question.answered_by,question.answer):undefined;
      cards.push({key:`question:${question.id}`,kind:'question',text:`Question for the ${question.to_role}: ${String(question.question).slice(0,120)}`,final:!live,...(reply?{reply}:{}),blocks:[
        {type:'section',text:{type:'mrkdwn',text:`${item?`*${item.id}* · ${headline(item)}\n`:''}*${clip(question.to_role==='controller'?who.controller:who.accountant)}, the seat asks:* ${clip(question.question,500)}`}},
        ...(live?[{type:'actions',block_id:'answer',elements:[...(question.options??[]).slice(0,4).map((option:string,index:number)=>({type:'button',action_id:`gram_option_${index}`,text:{type:'plain_text',text:option.slice(0,75)},value:JSON.stringify({world:worldId,question:question.id,option:index})})),{type:'button',action_id:'gram_answer',text:{type:'plain_text',text:'Answer…'},value:JSON.stringify({world:worldId,question:question.id})}]},{type:'context',elements:[{type:'mrkdwn',text:'Or reply in this thread.'}]}]:[{type:'context',elements:[{type:'mrkdwn',text:outcome}]}]),
      ]});
    }
    // Rules proposed in one run are one message. The onboarding batch is the seat saying what it read in the books.
    const groups=new Map<string,any[]>();
    for(const policy of w.policies){const key=policyGroup(policy);groups.set(key,[...(groups.get(key)??[]),policy]);}
    for(const [key,group] of groups){
      const pending=group.filter((p:any)=>p.status==='proposed'),live=pending.length>0,one=group.length===1?group[0]:undefined;
      const backtest=(p:any)=>`${p.backtest.support} agree, ${p.backtest.contrary} contrary${boundText(p.backtest,money)}`;
      const count=(status:string)=>group.filter((p:any)=>p.status===status).length,deciders=[...new Set(group.filter((p:any)=>p.decided_by).map((p:any)=>name(p.decided_by)))];
      const outcome=[count('active')?`:white_check_mark: ${count('active')} approved`:'',count('rejected')?`:x: ${count('rejected')} rejected`:'',count('superseded')?`${count('superseded')} superseded`:'',count('retired')?`${count('retired')} retired`:''].filter(Boolean).join(' · ')+(deciders.length?` by ${deciders.join(', ')}`:'');
      const onboarding=w.seat?.onboarding?.run_id&&key===`run:${w.seat.onboarding.run_id}`;
      const blocks:any[]=one?[{type:'section',text:{type:'mrkdwn',text:`*Policy ${one.id} v${one.version}: ${clip(one.title,100)}*\n${clip(one.statement,400)}\n_${clip(one.rationale,300)}_\nBacktest: ${backtest(one)}${one.backtest.note?` · ${clip(one.backtest.note,200)}`:''}`}}]
        :[{type:'section',text:{type:'mrkdwn',text:`*${group.length} rules the seat proposes${onboarding?' after reading last season':''}*\n${group.slice(0,20).map((p:any,i:number)=>`${i+1}. ${clip(p.title,90)} — ${backtest(p)}`).join('\n')}${group.length>20?`\n…and ${group.length-20} more in gram`:''}`.slice(0,2900)}}];
      if(live&&one)blocks.push({type:'actions',block_id:'policy',elements:[
        {type:'button',action_id:'gram_policy_approve',style:'primary',text:{type:'plain_text',text:'Approve policy'},value:JSON.stringify({world:worldId,policy:one.id,version:one.version}),confirm:{title:{type:'plain_text',text:'Approve this policy?'},text:{type:'mrkdwn',text:'Covered work will post without asking.'},confirm:{type:'plain_text',text:'Approve'},deny:{type:'plain_text',text:'Cancel'}}},
        {type:'button',action_id:'gram_policy_reject',style:'danger',text:{type:'plain_text',text:'Reject…'},value:JSON.stringify({world:worldId,policy:one.id,version:one.version})},
      ]},{type:'context',elements:[{type:'mrkdwn',text:'Only the controller can decide policy.'}]});
      else if(live)blocks.push({type:'actions',block_id:'policies',elements:[
        {type:'button',action_id:'gram_policies_approve',style:'primary',text:{type:'plain_text',text:`Approve all ${pending.length}`},value:JSON.stringify({world:worldId,group:key}),confirm:{title:{type:'plain_text',text:`Approve ${pending.length} policies?`},text:{type:'mrkdwn',text:'Covered work will post without asking.'},confirm:{type:'plain_text',text:'Approve all'},deny:{type:'plain_text',text:'Cancel'}}},
      ]},{type:'context',elements:[{type:'mrkdwn',text:`Only the controller can decide policy. To reject or change one: ${link()}`}]});
      else blocks.push({type:'context',elements:[{type:'mrkdwn',text:outcome||'—'}]});
      const reasons=[...new Set(group.filter((p:any)=>p.decision_reason&&p.decision_reason!=='Approved in Slack').map((p:any)=>String(p.decision_reason)))],decider=group.find((p:any)=>p.decided_by)?.decided_by;
      const reply=!live&&decider&&reasons.length?{...person(w,decider),text:reasons.length===1?reasons[0]!:reasons.slice(0,3).map(reason=>clip(reason,200)).join(' · ')}:undefined;
      cards.push({key:`policies:${key}`,kind:'policy',text:one?`Policy proposal ${one.id} v${one.version}`:`${group.length} policy proposals`,final:!live,...(reply?{reply}:{}),blocks});
    }
    return cards;
  }
  /** Posts new cards and redraws changed ones exactly once; safe to call repeatedly. */
  reconcile(worldId:string){
    this.queue=this.queue.then(async()=>{
      const binding=this.deps.store.get('slack-bindings',worldId);if(!binding?.enabled)return;
      for(const card of this.cards(worldId)){
        const id=`${worldId}:${card.key}`,record=this.deps.store.get('slack-cards',id),digest=new Bun.CryptoHasher('sha256').update(JSON.stringify(card.blocks)).digest('hex');
        if(record?.digest===digest||record?.suppressed)continue;
        if(!record&&card.final&&card.kind!=='escalation')continue; // A card decided before Slack saw it is never posted.
        try{
          if(record){
            await this.api('chat.update',{channel:record.channel,ts:record.ts,text:card.text,blocks:card.blocks});
            // The person's own words go in the thread once, when the card is decided; a thread reply that answered a question is already there.
            let replied=Boolean(record.replied);
            if(!replied&&card.final&&!record.final&&card.reply&&!record.thread_answer){await this.sayInThread(record.channel,record.ts,card.reply);replied=true;}
            this.deps.store.put('slack-cards',id,{...record,digest,final:card.final,replied,updated_at:new Date().toISOString()});
          }
          else{const posted=await this.api('chat.postMessage',{channel:binding.channel,text:card.text,blocks:card.blocks,unfurl_links:false});this.deps.store.put('slack-cards',id,{world:worldId,key:card.key,kind:card.kind,channel:posted.channel,ts:posted.ts,digest,final:card.final,posted_at:new Date().toISOString()});}
        }catch(error){this.lastError=String(error);this.deps.store.audit(worldId,'slack.delivery_failed',{card:card.key,error:String(error)},'slack');}
      }
    }).catch(error=>{this.lastError=String(error);});
    return this.queue;
  }
  /** A simulated colleague speaks under her own name (chat:write.customize); anyone else is quoted by gram. */
  private async sayInThread(channel:string,ts:string,reply:Reply){
    const text=clip(reply.text,1200);
    if(reply.simulated){
      try{await this.api('chat.postMessage',{channel,thread_ts:ts,text,username:reply.label.replace(/[*_`]/g,''),icon_emoji:':bust_in_silhouette:',unfurl_links:false});return;}
      catch(error){if(!/missing_scope|invalid_arguments|not_allowed/.test(String(error)))throw error;}
    }
    await this.api('chat.postMessage',{channel,thread_ts:ts,text:`${reply.label}: ${text}`,unfurl_links:false});
  }
  private act(worldId:string,input:any,user:string,key:string){
    const role=this.role(user);
    if(!role){this.deps.store.audit(worldId,'work.denied',{action:input.type,code:'slack_user_not_mapped',message:`Slack user ${user} has no gram role`},`slack:${user}`);throw Object.assign(new Error('Your Slack account is not mapped to a gram role.'),{code:'slack_user_not_mapped'});}
    return this.deps.work(worldId,input,{id:`slack:${user}`,role},`slack:${key}`,crypto.randomUUID());
  }
  /** Cards name their company; it must be one this channel is bound to. */
  private worldFor(card:{world?:unknown}){
    const id=typeof card.world==='string'?card.world:undefined;
    return id&&this.deps.store.get('slack-bindings',id)?.enabled?id:undefined;
  }
  /** Binding a company posts only what is waiting from now on, not its whole past. */
  bind(worldId:string,enabled:boolean){
    const binding={world:worldId,enabled,channel:this.deps.config.channel,changed_at:new Date().toISOString()};
    this.deps.store.put('slack-bindings',worldId,binding);
    if(enabled)for(const card of this.cards(worldId)){const id=`${worldId}:${card.key}`;if(card.final&&!this.deps.store.get('slack-cards',id))this.deps.store.put('slack-cards',id,{world:worldId,key:card.key,kind:card.kind,suppressed:true,digest:new Bun.CryptoHasher('sha256').update(JSON.stringify(card.blocks)).digest('hex'),final:true});}
    return binding;
  }
  /** Handles one Socket Mode envelope and returns the ack payload, if any. */
  async handle(envelope:any):Promise<Record<string,unknown>|undefined>{
    const payload=envelope.payload??{},team=payload.team?.id??payload.team_id??payload.user?.team_id;
    if(this.deps.config.teamId&&team&&team!==this.deps.config.teamId)return;
    if(envelope.type==='events_api'){
      const event=payload.event??{},eventId=payload.event_id;
      if(!eventId||this.deps.store.get('slack-events',eventId))return;
      this.deps.store.put('slack-events',eventId,{at:new Date().toISOString()});
      if(event.bot_id||!event.user||typeof event.text!=='string')return;
      const card=event.thread_ts?this.deps.store.all('slack-cards').find((row:any)=>row.ts===event.thread_ts&&row.channel===event.channel&&row.kind==='question'):undefined;
      // A mention in the channel or a DM is a question to gram. A mention inside a question's thread is that
      // question's answer, which the message event records; it is not explained twice.
      if(event.type==='app_mention'||(event.type==='message'&&event.channel_type==='im'&&!event.subtype)){
        if(!(card&&event.type==='app_mention'))await this.explain(event).catch(error=>{this.lastError=String(error);});
        return;
      }
      if(event.type!=='message'||event.subtype||!event.thread_ts||!card)return;
      const questionId=String(card.key).slice('question:'.length),w=this.deps.world(card.world),question=w.questions.find((row:any)=>row.id===questionId);
      if(question?.status!=='open')return;
      try{this.act(card.world,{type:'work_answer',question_id:questionId,answer:event.text.slice(0,4000)},event.user,`event:${eventId}`);this.deps.store.put('slack-cards',`${card.world}:${card.key}`,{...card,thread_answer:true});}
      catch(error:any){await this.api('chat.postEphemeral',{channel:event.channel,user:event.user,thread_ts:event.thread_ts,text:`gram did not record that answer: ${escapeSlack(error.message)}`}).catch(()=>{});}
      await this.reconcile(card.world);return;
    }
    if(envelope.type!=='interactive')return;
    const user=payload.user?.id as string|undefined;if(!user)return;
    if(payload.type==='block_actions'){
      const action=payload.actions?.[0];if(!action?.action_id?.startsWith('gram_'))return;
      let value:any={};try{value=JSON.parse(action.value??'{}');}catch{return;}
      const worldId=this.worldFor(value);if(!worldId)return;
      const reply=(text:string)=>this.api('chat.postEphemeral',{channel:payload.channel?.id??payload.container?.channel_id,user,text}).catch(()=>{});
      const meta=JSON.stringify({...value,world:worldId,channel:payload.channel?.id??payload.container?.channel_id,ts:payload.message?.ts??payload.container?.message_ts});
      const modal=(callback:string,title:string,label:string)=>this.api('views.open',{trigger_id:payload.trigger_id,view:{type:'modal',callback_id:callback,private_metadata:meta,title:{type:'plain_text',text:title},submit:{type:'plain_text',text:'Submit'},close:{type:'plain_text',text:'Cancel'},blocks:[{type:'input',block_id:'reason',label:{type:'plain_text',text:label},element:{type:'plain_text_input',action_id:'text',multiline:true,min_length:3,max_length:2000}}]}}).catch((error:unknown)=>reply(`Could not open the form (${escapeSlack(String(error))}). Decide in gram instead.`));
      try{
        if(action.action_id==='gram_approve'){
          const w=this.deps.world(worldId),item=w.workItems.find((row:any)=>row.id===value.item);
          if(item?.proposal?.id!==value.proposal||item.state!=='proposed'){await reply('This card is out of date; the item has moved on.');await this.reconcile(worldId);return;}
          this.act(worldId,{type:'work_decide',work_item_id:value.item,decision:'approve',reason:'Approved in Slack'},user,`${payload.trigger_id}`);
        }
        else if(action.action_id==='gram_reject')await modal('gram_reject','Reject proposal','Why? The seat reads this.');
        else if(action.action_id==='gram_answer')await modal('gram_answer','Answer the seat','Your answer');
        else if(action.action_id==='gram_policy_approve')this.act(worldId,{type:'policy_decide',policy_id:value.policy,version:value.version,decision:'approve',reason:'Approved in Slack'},user,`${payload.trigger_id}`);
        else if(action.action_id==='gram_policy_reject')await modal('gram_policy_reject','Reject policy','Why? The seat reads this.');
        else if(action.action_id==='gram_policies_approve'){
          // One click, one decision per policy: each is role-checked and logged on its own.
          const pending=this.deps.world(worldId).policies.filter((row:any)=>row.status==='proposed'&&policyGroup(row)===value.group);
          if(!pending.length){await reply('These policies were already decided.');await this.reconcile(worldId);return;}
          let approved=0;const failures:string[]=[];
          for(const policy of pending){
            try{this.act(worldId,{type:'policy_decide',policy_id:policy.id,version:policy.version,decision:'approve',reason:'Approved in Slack'},user,`${payload.trigger_id}:${policy.id}@${policy.version}`);approved++;}
            catch(error:any){failures.push(`${policy.id}: ${error.message}`);if(error.code==='slack_user_not_mapped'||/Only the controller/.test(error.message))break;}
          }
          if(failures.length)await reply(`Approved ${approved}; gram refused ${failures.length}: ${escapeSlack(failures.slice(0,3).join(' · '))}`);
        }
        else if(action.action_id.startsWith('gram_option_')){
          const w=this.deps.world(worldId),question=w.questions.find((row:any)=>row.id===value.question),option=question?.options?.[Number(value.option)];
          if(question?.status!=='open'||!option){await reply('This question was already answered.');return;}
          this.act(worldId,{type:'work_answer',question_id:question.id,answer:option},user,`${payload.trigger_id}`);
        }
      }catch(error:any){await reply(`gram refused: ${escapeSlack(error.message)}`);}
      await this.reconcile(worldId);return;
    }
    if(payload.type==='view_submission'){
      let meta:any={};try{meta=JSON.parse(payload.view?.private_metadata??'{}');}catch{return {response_action:'errors',errors:{reason:'This form expired; decide in gram.'}};}
      const text=String(payload.view?.state?.values?.reason?.text?.value??'').trim(),callback=payload.view?.callback_id;
      if(text.length<3)return {response_action:'errors',errors:{reason:'Give a reason of at least three characters.'}};
      const input=callback==='gram_reject'?{type:'work_decide',work_item_id:meta.item,decision:'reject',reason:text}:callback==='gram_answer'?{type:'work_answer',question_id:meta.question,answer:text}:callback==='gram_policy_reject'?{type:'policy_decide',policy_id:meta.policy,version:meta.version,decision:'reject',reason:text}:undefined;
      if(!input||!meta.world)return;
      if(callback==='gram_reject'){const item=this.deps.world(meta.world).workItems.find((row:any)=>row.id===meta.item);if(item?.proposal?.id!==meta.proposal||item.state!=='proposed')return {response_action:'errors',errors:{reason:'This proposal is no longer waiting for a decision.'}};}
      try{this.act(meta.world,input,user,`view:${payload.view?.id}`);}
      catch(error:any){return {response_action:'errors',errors:{reason:String(error.message).slice(0,150)}};}
      void this.reconcile(meta.world);return;
    }
  }
  /** "@gram why SH-3004?" or "status": answered from the work log and the briefing, never from the model.
   * Anyone in the channel may ask; the answer is what the console's Why? shows, with no decision attached. */
  private async explain(event:any){
    const text=String(event.text).replace(/<@[A-Z0-9]+>/g,' ').trim(),channel=event.channel,thread=event.thread_ts??(event.channel_type==='im'?undefined:event.ts);
    const post=(body:string)=>this.api('chat.postMessage',{channel,text:body.slice(0,3900),...(thread?{thread_ts:thread}:{}),unfurl_links:false});
    const worlds=this.deps.store.all('slack-bindings').filter((row:any)=>row.enabled&&row.world).map((row:any)=>row.world as string);
    if(!worlds.length){await post('No company is bound to this channel yet. Turn on *Ask and approve in Slack* in gram first.');return;}
    const typed=[...new Set([...text.matchAll(/\b([A-Za-z]{1,6}-[A-Za-z0-9]{2,14})\b/g)].map(match=>match[1]!))].slice(0,3);
    const answers:string[]=[];
    for(const worldId of worlds){
      let w:any;try{w=this.deps.world(worldId);}catch{continue;}
      const open=`${this.deps.baseUrl}/?world=${encodeURIComponent(worldId)}&view=work`;
      for(const id of typed){
        const subject=matchRecord(w,id);if(!subject)continue;
        const why=whyTimeline(w,subject);
        if(!why.timeline.length){answers.push(`Nothing in the work log touches *${escapeSlack(subject)}* at ${escapeSlack(w.name)}.`);continue;}
        const rows=why.timeline.slice(-20).map((row:any)=>`${String(row.at).slice(0,16).replace('T',' ')} · ${person(w,row.actor).label} (${clip(row.role)}) · ${clip(row.action)}${row.allowed===false?' · *BLOCKED*':''}${Array.isArray(row.policy)&&row.policy.length?` · ${row.policy.map((policy:any)=>`${clip(policy.id)} v${policy.version}`).join(', ')}`:''}${row.confidence!==undefined?` · ${pct(row.confidence)}`:''}${row.why?` — ${clip(row.why,240)}`:''}`);
        const item=why.work_items[0];
        answers.push(`*Why ${escapeSlack(subject)}* · ${escapeSlack(w.name)}${why.work_items.length?` · ${why.work_items.map(escapeSlack).join(', ')}`:''}\n${rows.join('\n')}${why.journals.length?`\nJournals: ${why.journals.map((journal:any)=>escapeSlack(journal.id)).join(', ')}`:''}\n<${open}${item?`&item=${encodeURIComponent(item)}`:''}|Open in gram>`);
        this.deps.store.audit(worldId,'slack.explained',{subject,entries:why.timeline.length,asked_by:event.user},`slack:${event.user}`);
      }
      if(!typed.length&&/\b(status|queue|waiting|briefing|open|what)\b/i.test(text)){
        const briefing=workBriefing(w),c=briefing.counts as Record<string,number>;
        const waiting=briefing.waiting_on_people.slice(0,5).map((row:any)=>`• ${escapeSlack(row.id)} · ${escapeSlack(row.title)} · ${escapeSlack(row.state.replaceAll('_',' '))}${row.awaiting?.why?.length?` — ${clip(row.awaiting.why[0],160)}`:''}`);
        answers.push(`*${escapeSlack(briefing.seat.title)} · ${escapeSlack(briefing.seat.company)}* · ${briefing.seat.autonomy.enabled?'on duty':'off duty'} · in its queue ${c.new+c.answered+c.rejected} · waiting on people ${c.proposed+c.needs_info+c.escalated} · posted ${c.posted} · policies in force ${briefing.policies.active.length}${waiting.length?`\n${waiting.join('\n')}`:''}\n<${open}|Open in gram>`);
      }
    }
    if(typed.length&&!answers.length)answers.push(`I don't have a record called ${typed.map(id=>`*${escapeSlack(id)}*`).join(' or ')}. Ask about a work item, bank line, show, invoice, policy or question id, e.g. \`why WI-5531\`.`);
    if(!answers.length)answers.push('Ask me *why* about a record (`why SH-3004`, `why WI-5531`, `why pol-001`) or for *status*. Decisions stay on the cards: Approve, Reject…, Answer….');
    await post(answers.join('\n\n'));
  }
  /** Socket Mode: open a fresh wss URL for every connection and ack each envelope. */
  async connect(){
    if(this.stopped)return;
    try{
      const response=await (this.deps.transport??fetch)('https://slack.com/api/apps.connections.open',{method:'POST',headers:{Authorization:`Bearer ${this.deps.config.appToken}`,'Content-Type':'application/x-www-form-urlencoded'}});
      const data:any=await response.json();if(!data.ok)throw new Error(`apps.connections.open failed: ${data.error}`);
      const socket=(this.deps.socket??(url=>new WebSocket(url)))(data.url);this.socket=socket;
      socket.addEventListener('message',event=>{void (async()=>{
        let message:any;try{message=JSON.parse(String(event.data));}catch{return;}
        if(message.type==='hello'){this.connected=true;this.reconnects=0;this.lastError=undefined;return;}
        if(message.type==='disconnect'){this.connected=false;socket.close();if(message.reason==='link_disabled')this.stopped=true;return;}
        if(!message.envelope_id)return;
        // Ack block actions and events immediately; a form submission needs its errors in the ack.
        if(message.type!=='interactive'||message.payload?.type!=='view_submission'){socket.send(JSON.stringify({envelope_id:message.envelope_id}));await this.handle(message).catch(error=>{this.lastError=String(error);});return;}
        const payload=await this.handle(message).catch(error=>({response_action:'errors',errors:{reason:String(error).slice(0,150)}}));
        socket.send(JSON.stringify({envelope_id:message.envelope_id,...(payload?{payload}:{})}));
      })();});
      socket.addEventListener('close',()=>{this.connected=false;if(this.socket===socket&&!this.stopped)setTimeout(()=>void this.connect(),Math.min(30_000,1000*2**Math.min(5,this.reconnects++))).unref();});
    }catch(error){this.lastError=String(error);if(!this.stopped)setTimeout(()=>void this.connect(),Math.min(60_000,2000*2**Math.min(5,this.reconnects++))).unref();}
  }
  stop(){this.stopped=true;this.socket?.close();}
  status(){return {connected:this.connected,channel:this.deps.config.channel,accountants:this.deps.config.accountants.size,controllers:this.deps.config.controllers.size,...(this.lastError?{last_error:this.lastError.replace(/xox[a-z]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+/g,'[REDACTED]')}:{})};}
}

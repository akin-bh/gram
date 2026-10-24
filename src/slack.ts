/** Slack is where the AR team already talks, so the seat asks and gets answers there.
 * gram stays the system of work: every card is drawn from its state, every click goes
 * through the same work command and role check as the console, and a click on an
 * out-of-date card is refused. Socket Mode keeps the app local: no public URL.
 *
 * Identity is the Slack user ID in the payload, mapped to a gram role by explicit lists.
 * Message text is never authority; a thread reply only answers the question it replies to.
 */
import {readFileSync} from 'node:fs';
import type {Store} from './store.ts';
import type {Actor} from './oauth.ts';
import {dollars} from './cash-application.ts';

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
export type SlackDeps={store:Store;baseUrl:string;config:SlackConfig;world:(id:string)=>any;work:(world:string,input:any,actor:Actor,key:string,requestId:string)=>any;transport?:typeof fetch;socket?:(url:string)=>WebSocket;now?:()=>number};
type Card={key:string;kind:'proposal'|'question'|'policy'|'escalation'|'handoff';text:string;blocks:any[];final:boolean};

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
    const w=this.deps.world(worldId),open=`${this.deps.baseUrl}/?world=${encodeURIComponent(worldId)}&view=work`,cards:Card[]=[];
    const link=(id:string)=>`<${open}&item=${encodeURIComponent(id)}|Open in gram>`;
    const customer=(invoiceId:string)=>{const invoice=w.invoices.find((row:any)=>row.id===invoiceId);return w.customers.find((row:any)=>row.id===invoice?.customer_id)?.name??invoice?.customer_id??'';};
    const receiptOf=(item:any)=>w.bankReceipts.find((row:any)=>row.id===item.subject_id);
    for(const item of w.workItems){
      const receipt=receiptOf(item),line=receipt?`*Bank line* ${clip(receipt.bank_reference)} · ${clip(receipt.channel.toUpperCase())} · ${dollars(receipt.amount_minor)} from ${clip(receipt.payer_name||'no payer name')} · memo \`${clip(receipt.memo||'—',200)}\``:`*Invoice* ${clip(item.subject_id)}`;
      for(const proposal of item.proposal?[item.proposal]:[]){
        const live=item.state==='proposed'&&item.proposal.id===proposal.id,decided=w.workLog.filter((row:any)=>row.subject===item.id&&['approve','reject','correct','close','escalate','ask'].includes(row.action)&&row.at>=proposal.proposed_at).at(-1);
        const resolution=proposal.resolution,lines=resolution?[...resolution.allocations.map((row:any)=>`• Apply ${dollars(row.amount_minor)} to ${row.invoice_id} (${clip(customer(row.invoice_id))})`),...resolution.adjustments.map((row:any)=>`• Close ${dollars(row.amount_minor)} of ${row.invoice_id} as ${row.kind.replaceAll('_',' ')}`),...(resolution.hold_on_account?[`• Hold ${dollars(resolution.unapplied_minor)} on account`]:[]),...(resolution.chase?[`• Send a short-pay notice for ${dollars(resolution.chase.amount_minor)} on ${resolution.chase.invoice_id}`]:[])]:[`• Send reminder: ${clip(proposal.reminder,600)}`];
        const outcome=decided?`${decided.action==='approve'?':white_check_mark: Approved':decided.action==='reject'?':x: Rejected':decided.action==='correct'?':pencil2: Corrected':decided.action==='close'?':heavy_minus_sign: Closed':decided.action==='ask'?':question: Seat asked a question instead':':arrow_up: Escalated'} by ${decided.actor.startsWith('slack:')?`<@${decided.actor.slice(6)}>`:clip(decided.actor)}${decided.why?`: ${clip(decided.why,600)}`:''}`:'';
        const blocks:any[]=[
          {type:'header',text:{type:'plain_text',text:`${item.id} · ${receipt?receipt.payer_name||'Unidentified deposit':'Follow-up'} · ${dollars(item.amount_minor??0)}`.slice(0,150)}},
          {type:'section',text:{type:'mrkdwn',text:line}},
          {type:'section',text:{type:'mrkdwn',text:`*Proposal* (confidence ${pct(proposal.confidence)})\n${lines.join('\n')}\n_${clip(proposal.reason,800)}_`}},
          {type:'context',elements:[{type:'mrkdwn',text:(proposal.basis??[]).map((row:any)=>`${row.factor}: ${pct(row.score)} – ${clip(row.why,160)}`).join(' · ').slice(0,2900)||'—'}]},
          ...(proposal.gaps?.length?[{type:'section',text:{type:'mrkdwn',text:`*Why it needs you*\n${proposal.gaps.map((gap:string)=>`• ${clip(gap,300)}`).join('\n')}`}}]:[]),
          ...(live?[{type:'actions',block_id:'decide',elements:[
            {type:'button',action_id:'gram_approve',style:'primary',text:{type:'plain_text',text:'Approve'},value:JSON.stringify({world:worldId,item:item.id,proposal:proposal.id}),confirm:{title:{type:'plain_text',text:'Approve and post?'},text:{type:'mrkdwn',text:'The gateway posts this to NetSuite right away.'},confirm:{type:'plain_text',text:'Approve'},deny:{type:'plain_text',text:'Cancel'}}},
            {type:'button',action_id:'gram_reject',style:'danger',text:{type:'plain_text',text:'Reject…'},value:JSON.stringify({world:worldId,item:item.id,proposal:proposal.id})},
          ]}]:[{type:'section',text:{type:'mrkdwn',text:outcome||`_${clip(item.state)}_`}}]),
          {type:'context',elements:[{type:'mrkdwn',text:`Proposed by the cash-application seat · ${link(item.id)}`}]},
        ];
        cards.push({key:`proposal:${item.id}:${proposal.id}`,kind:'proposal',text:`${item.id} needs a decision`,blocks,final:!live});
      }
      if(item.state==='escalated'&&item.escalation)cards.push({key:`escalation:${item.id}:${item.escalation.at}`,kind:'escalation',text:`${item.id} escalated`,final:true,blocks:[
        {type:'header',text:{type:'plain_text',text:`${item.id} escalated to the ${item.escalation.to_role}`.slice(0,150)}},{type:'section',text:{type:'mrkdwn',text:`${line}\n\n${clip(item.escalation.reason,1500)}`}},{type:'context',elements:[{type:'mrkdwn',text:`Resolve it in ${link(item.id)}`}]}]});
    }
    for(const question of w.questions){
      const item=w.workItems.find((row:any)=>row.id===question.work_item_id),receipt=item&&receiptOf(item),live=question.status==='open';
      const answered=question.status==='answered'?`:speech_balloon: Answered by ${String(question.answered_by).startsWith('slack:')?`<@${String(question.answered_by).slice(6)}>`:clip(question.answered_by)}: ${clip(question.answer,1500)}`:question.status==='withdrawn'?'_Withdrawn_':'';
      cards.push({key:`question:${question.id}`,kind:'question',text:`Question for the ${question.to_role}: ${String(question.question).slice(0,120)}`,final:!live,blocks:[
        {type:'header',text:{type:'plain_text',text:`Question on ${question.work_item_id}`.slice(0,150)}},
        ...(receipt?[{type:'section',text:{type:'mrkdwn',text:`*Bank line* ${clip(receipt.bank_reference)} · ${dollars(receipt.amount_minor)} from ${clip(receipt.payer_name||'no payer name')} · memo \`${clip(receipt.memo||'—',200)}\``}}]:[]),
        {type:'section',text:{type:'mrkdwn',text:`*${question.to_role==='controller'?'Controller':'AR lead'}, the seat asks:*\n${clip(question.question,1500)}`}},
        ...(live?[{type:'actions',block_id:'answer',elements:[...(question.options??[]).slice(0,4).map((option:string,index:number)=>({type:'button',action_id:`gram_option_${index}`,text:{type:'plain_text',text:option.slice(0,75)},value:JSON.stringify({world:worldId,question:question.id,option:index})})),{type:'button',action_id:'gram_answer',text:{type:'plain_text',text:'Answer…'},value:JSON.stringify({world:worldId,question:question.id})}]},{type:'context',elements:[{type:'mrkdwn',text:'Or reply in this thread. Only mapped AR and controller accounts can answer.'}]}]:[{type:'section',text:{type:'mrkdwn',text:answered}}]),
      ]});
    }
    for(const policy of w.policies){
      const live=policy.status==='proposed';
      const outcome=live?'':`${policy.status==='active'?':white_check_mark: Approved':policy.status==='rejected'?':x: Rejected':`_${clip(policy.status)}_`}${policy.decided_by?` by ${String(policy.decided_by).startsWith('slack:')?`<@${String(policy.decided_by).slice(6)}>`:clip(policy.decided_by)}`:''}${policy.decision_reason?`: ${clip(policy.decision_reason,600)}`:''}`;
      cards.push({key:`policy:${policy.id}@v${policy.version}`,kind:'policy',text:`Policy proposal ${policy.id} v${policy.version}`,final:!live,blocks:[
        {type:'header',text:{type:'plain_text',text:`Policy proposal ${policy.id} v${policy.version}: ${policy.title}`.slice(0,150)}},
        {type:'section',text:{type:'mrkdwn',text:`${clip(policy.statement,1000)}\n_${clip(policy.rationale,800)}_`}},
        {type:'section',text:{type:'mrkdwn',text:`*Backtest* ${policy.backtest.support} cases agree, ${policy.backtest.contrary} contrary${policy.backtest.contrary_examples?.length?` (${policy.backtest.contrary_examples.map(clip).join(', ')})`:''}${policy.backtest.note?`\n${clip(policy.backtest.note,300)}`:''}`}},
        ...(policy.evidence?.queries?.length?[{type:'context',elements:[{type:'mrkdwn',text:policy.evidence.queries.map((query:any)=>`\`${clip(query.sql,200)}\` → ${clip(query.finding,200)}`).join('\n').slice(0,2900)}]}]:[]),
        ...(live?[{type:'actions',block_id:'policy',elements:[
          {type:'button',action_id:'gram_policy_approve',style:'primary',text:{type:'plain_text',text:'Approve policy'},value:JSON.stringify({world:worldId,policy:policy.id,version:policy.version}),confirm:{title:{type:'plain_text',text:'Approve this policy?'},text:{type:'mrkdwn',text:'Covered work will post without asking.'},confirm:{type:'plain_text',text:'Approve'},deny:{type:'plain_text',text:'Cancel'}}},
          {type:'button',action_id:'gram_policy_reject',style:'danger',text:{type:'plain_text',text:'Reject…'},value:JSON.stringify({world:worldId,policy:policy.id,version:policy.version})},
        ]},{type:'context',elements:[{type:'mrkdwn',text:'Only the controller can decide policy.'}]}]:[{type:'section',text:{type:'mrkdwn',text:outcome}}]),
      ]});
    }
    for(const handoff of w.handoffs.slice(-20))cards.push({key:`handoff:${handoff.id}`,kind:'handoff',text:'Shift handoff',final:true,blocks:[
      {type:'section',text:{type:'mrkdwn',text:`*Shift handoff* · ${clip(handoff.summary,2400)}`}},
      ...(handoff.open_items?.length?[{type:'context',elements:[{type:'mrkdwn',text:`Open: ${handoff.open_items.map((item:string)=>clip(item,200)).join(' · ').slice(0,2900)}`}]}]:[])]});
    return cards;
  }
  /** Posts new cards and redraws changed ones exactly once; safe to call repeatedly. */
  reconcile(worldId:string){
    this.queue=this.queue.then(async()=>{
      const binding=this.deps.store.get('slack-bindings',worldId);if(!binding?.enabled)return;
      for(const card of this.cards(worldId)){
        const id=`${worldId}:${card.key}`,record=this.deps.store.get('slack-cards',id),digest=new Bun.CryptoHasher('sha256').update(JSON.stringify(card.blocks)).digest('hex');
        if(record?.digest===digest||record?.suppressed)continue;
        if(!record&&card.final&&card.kind!=='handoff'&&card.kind!=='escalation')continue; // A card decided before Slack saw it is never posted.
        try{
          if(record){await this.api('chat.update',{channel:record.channel,ts:record.ts,text:card.text,blocks:card.blocks});this.deps.store.put('slack-cards',id,{...record,digest,final:card.final,updated_at:new Date().toISOString()});}
          else{const posted=await this.api('chat.postMessage',{channel:binding.channel,text:card.text,blocks:card.blocks,unfurl_links:false});this.deps.store.put('slack-cards',id,{world:worldId,key:card.key,kind:card.kind,channel:posted.channel,ts:posted.ts,digest,final:card.final,posted_at:new Date().toISOString()});}
        }catch(error){this.lastError=String(error);this.deps.store.audit(worldId,'slack.delivery_failed',{card:card.key,error:String(error)},'slack');}
      }
    }).catch(error=>{this.lastError=String(error);});
    return this.queue;
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
    const binding={enabled,channel:this.deps.config.channel,changed_at:new Date().toISOString()};
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
      if(event.type!=='message'||event.subtype||event.bot_id||!event.thread_ts||!event.user||typeof event.text!=='string')return;
      const card=this.deps.store.all('slack-cards').find((row:any)=>row.ts===event.thread_ts&&row.channel===event.channel&&row.kind==='question');
      if(!card)return;
      const questionId=String(card.key).slice('question:'.length),w=this.deps.world(card.world),question=w.questions.find((row:any)=>row.id===questionId);
      if(question?.status!=='open')return;
      try{this.act(card.world,{type:'work_answer',question_id:questionId,answer:event.text.slice(0,4000)},event.user,`event:${eventId}`);}
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

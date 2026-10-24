/** A seat: a Claude Agent SDK run whose tools are CRUD on the work. It reads work
 * items, history, precedents and policies; it can propose, ask, escalate, propose
 * policy and write a handoff. It cannot approve, post or reach anything else. The
 * host starts it when work arrives; nothing it knows survives the run except what it
 * writes into the system of work. Which records it works on, what a proposal looks
 * like and which policy kinds exist come from the seat's domain.
 */
import {createSdkMcpServer,query,tool} from '@anthropic-ai/claude-agent-sdk';
import type {SDKResultMessage} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';
import {rm} from 'node:fs/promises';
import {AgentError,abortLink,assertWorldEndpoint,baseOptions,createWorkspace,loadAgentConfig,requireKey,sanitizeAgentEvent} from './agent.ts';
import type {AgentEventSink,RunResult} from './agent.ts';
import {domainByKind} from './domains.ts';

export type SeatMode='onboarding'|'shift';
export const SEAT_LIMITS={onboarding:{maxTurns:40,maxBudgetUsd:3,durationMs:8*60_000},shift:{maxTurns:30,maxBudgetUsd:2,durationMs:6*60_000}} as const;
export type SeatRunConfiguration={worldId:string;baseUrl:string;token:string;mode:SeatMode;items:string[];reason:string;company:string;kind:string;model?:string;signal?:AbortSignal;onEvent:AgentEventSink};

export function seatPrompt(mode:SeatMode,items:string[],reason:string){
  if(mode==='onboarding')return `Onboarding run. ${reason}\nStart with get_briefing, then learn from the history and propose policies. Then work any items already in your queue. Finish with write_handoff.`;
  return `Shift run. ${reason}\nItems waiting for you: ${items.join(', ')}.\nStart with get_briefing, handle each item, then write_handoff.`;
}

const ref=z.string().min(1).max(160);

export async function runSeat(config:SeatRunConfiguration):Promise<RunResult>{
  const endpoint=assertWorldEndpoint(config.baseUrl,config.worldId);
  if(!config.token)throw new AgentError('missing_agent_token','A scoped world token is required.',401);
  if(config.signal?.aborted)throw new AgentError('agent_cancelled','Seat run was cancelled.',409);
  const domain=domainByKind(config.kind);
  if(!domain)throw new AgentError('no_seat_domain',`No seat domain is registered for ${config.kind}.`,400);
  const key=requireKey(),agentConfig=loadAgentConfig(),model=config.model||agentConfig.seatModel,effort=agentConfig.seatEffort,limits=SEAT_LIMITS[config.mode];
  const emit=async(event:Record<string,unknown>)=>config.onEvent(sanitizeAgentEvent(event,[key,config.token]) as Record<string,unknown>);
  const workspace=await createWorkspace(),{controller,dispose}=abortLink(config.signal,limits.durationMs),started=Date.now(),models=new Set<string>();
  let calls=0,sessionId:string|undefined,result:SDKResultMessage|undefined,stream:ReturnType<typeof query>|undefined;

  async function rpc(method:'GET'|'POST',suffix:string,body?:unknown){
    controller.signal.throwIfAborted();calls++;
    const path=`/api/worlds/${config.worldId}${suffix}`;
    await emit({type:'agent.tool.request',method,path,...(body===undefined?{}:{body})});
    try{
      const response=await fetch(endpoint+suffix,{method,headers:{Authorization:`Bearer ${config.token}`,...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)]),redirect:'manual'});
      const raw=await response.text();let data:unknown;
      try{data=JSON.parse(raw);}catch{data={error:{code:'invalid_service_response',message:'The work service returned a non-JSON response.'}};}
      await emit({type:'agent.tool.response',method,path,status:response.status,response:data});
      return {content:[{type:'text' as const,text:JSON.stringify(data)}],isError:!response.ok};
    }catch(error){
      if(controller.signal.aborted)throw error;
      const failure={error:{code:method==='POST'?'outcome_unknown':'service_unavailable',message:method==='POST'?'No response was received. Read the work item again before retrying.':'The work service could not be reached.'}};
      await emit({type:'agent.tool.failure',method,path,error:String(error),response:failure});
      return {content:[{type:'text' as const,text:JSON.stringify(failure)}],isError:true};
    }
  }
  const work=(type:string)=>(input:Record<string,unknown>)=>rpc('POST','/work',{type,...input});
  const precedentKinds=domain.tools.precedentKinds.length?z.enum(domain.tools.precedentKinds as [string,...string[]]).optional():z.string().max(60).optional();
  const server=createSdkMcpServer({name:'work',version:'0.1.0',tools:[
    tool('get_briefing','Start here every run. Your seat, your queue, items waiting on people, policies in force and proposed, recent feedback from people, the last handoffs, and history coverage.',{},()=>rpc('GET','/work/briefing')),
    tool('get_work_item',domain.tools.item,{work_item_id:ref},input=>rpc('GET',`/work/items/${encodeURIComponent(input.work_item_id)}`)),
    tool('search_precedents',domain.tools.precedents,{subject_id:ref.optional(),counterparty:z.string().max(120).optional(),kind:precedentKinds,text:z.string().max(200).optional()},input=>rpc('GET',`/work/precedents?${new URLSearchParams(Object.entries(input).filter(([,value])=>value!==undefined) as [string,string][])}`)),
    tool('query_history',`Read-only SQL (SQLite, one SELECT or WITH statement) over the imported history and live records. Tables: ${Object.entries(domain.historySchema).map(([name,columns])=>`${name}(${columns})`).join('; ')}. Returns at most 200 rows; aggregate rather than listing.`,{sql:z.string().min(8).max(4000),limit:z.number().int().min(1).max(200).optional()},input=>rpc('POST','/work/history',input)),
    tool('read_attachment','Read a text/CSV attachment from an email cited on a work item.',{message_id:ref,attachment_id:ref,offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(32000).optional()},input=>rpc('GET',`/attachment-content/${encodeURIComponent(input.message_id)}/${encodeURIComponent(input.attachment_id)}?offset=${input.offset??0}&limit=${input.limit??16000}`)),
    tool('propose_resolution',domain.tools.propose,{
      work_item_id:ref,...domain.tools.proposeSchema,reminder:z.string().min(20).max(4000).optional(),
      confidence:z.number().min(0).max(1),reason:z.string().min(10).max(2000),evidence_ids:z.array(ref).max(20).optional(),needs_review:z.boolean().optional(),
    },input=>work('work_propose')(input)),
    tool('ask_question','Ask one person one specific question about a work item. The item waits in needs_info until they answer; their answer returns it to your queue and becomes a precedent.',{work_item_id:ref,to_role:z.enum(['accountant','controller']),question:z.string().min(15).max(1500),options:z.array(z.string().min(1).max(200)).max(6).optional()},work('work_ask')),
    tool('escalate','Hand a work item to a person when it is outside what you should decide.',{work_item_id:ref,reason:z.string().min(10).max(2000),to_role:z.enum(['accountant','controller']).optional()},work('work_escalate')),
    tool('propose_policy',domain.tools.policy,{rule:domain.ruleSchema,title:z.string().min(5).max(120),rationale:z.string().min(10).max(2000),evidence:z.object({queries:z.array(z.object({sql:z.string().min(10).max(4000),finding:z.string().min(5).max(1000)}).strict()).max(6).optional(),precedent_ids:z.array(ref).max(20).optional()}).strict(),supersedes:ref.optional()},work('policy_propose')),
    tool('write_handoff','End every run with this. Summarize what you did, what waits on whom, and what the next run should do first. The next run reads it in its briefing.',{summary:z.string().min(10).max(4000),open_items:z.array(z.string().min(1).max(500)).max(30).optional(),next_steps:z.array(z.string().min(1).max(500)).max(10).optional()},work('handoff_write')),
  ]});
  const allowed=['get_briefing','get_work_item','search_precedents','query_history','read_attachment','propose_resolution','ask_question','escalate','propose_policy','write_handoff'].map(name=>`mcp__work__${name}`);
  try{
    await emit({type:'agent.started',model,effort,fallback_model:agentConfig.seatFallbackModel,mode:config.mode,items:config.items,reason:config.reason,max_turns:limits.maxTurns,max_budget_usd:limits.maxBudgetUsd});
    stream=query({prompt:seatPrompt(config.mode,config.items,config.reason),options:{
      ...baseOptions(workspace,key,model,controller),maxTurns:limits.maxTurns,maxBudgetUsd:limits.maxBudgetUsd,
      // Judgment work: explicit effort (Opus 5.5 defaults to medium) and a fallback so an outage does not stall the queue.
      effort,fallbackModel:agentConfig.seatFallbackModel,
      systemPrompt:domain.prompt(config.company),allowedTools:allowed,mcpServers:{work:server},
      hooks:{PreToolUse:[{hooks:[async input=>{
        const name='tool_name' in input?input.tool_name:'',permitted=allowed.includes(name);
        if(!permitted)await emit({type:'agent.capability.denied',tool:name});
        return {hookSpecificOutput:{hookEventName:'PreToolUse' as const,permissionDecision:permitted?'allow' as const:'deny' as const,permissionDecisionReason:permitted?'Seat tool.':'Outside this seat.'}};
      }]}]},
    }});
    for await(const message of stream){
      if(message.type==='system'&&message.subtype==='init'){sessionId=message.session_id;await emit({type:'agent.session',session_id:message.session_id,model:message.model,tools:message.tools});}
      if(message.type==='assistant'){if(message.message.model)models.add(message.message.model);await emit({type:'agent.message',model:message.message.model,content:message.message.content.filter(part=>part.type==='text'||part.type==='tool_use')});}
      if(message.type==='result')result=message;
    }
    if(!result||result.subtype!=='success'||result.is_error){
      const details=result?{subtype:result.subtype,cost_usd:result.total_cost_usd,usage:result.modelUsage,...('errors' in result?{errors:result.errors}:{})}:undefined;
      throw new AgentError('agent_run_failed',`The seat did not complete the run${result?` (${result.subtype})`:''}.`,502,sanitizeAgentEvent(details,[key,config.token]));
    }
    const completed={output:sanitizeAgentEvent(result.result,[key,config.token]) as string,usage:result.modelUsage,model,models:[...models],cost_usd:result.total_cost_usd,turns:result.num_turns,tool_calls:calls,session_id:sessionId,elapsed_ms:Date.now()-started};
    await emit({type:'agent.completed',...completed});return completed;
  }catch(error){
    const safe=controller.signal.aborted?new AgentError('agent_cancelled','Seat run was cancelled or reached its time limit. The system of work keeps everything it recorded.',409):error instanceof AgentError?error:new AgentError('agent_run_failed',sanitizeAgentEvent(String(error),[key,config.token]) as string);
    await emit({type:'agent.failed',code:safe.code,error:safe.message,details:safe.details,elapsed_ms:Date.now()-started});throw safe;
  }finally{stream?.close();dispose();await rm(workspace,{recursive:true,force:true});}
}

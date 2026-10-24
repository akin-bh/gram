import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineEmulator, createEmulator } from 'emulate';
import { Store, ServiceError, hash, secret, redact } from './store.ts';
import { OAuth } from './oauth.ts';
import type { Actor } from './oauth.ts';
import { createWorld, applyAction, recordsFor, summarize, normalizeWorld, actionRequirements, scenarioCatalog, systemCatalog } from './world.ts';
import { providerRequest } from './provider-adapters.ts';
import {providerContracts,matchProviderContract,providerRouteCatalog} from './provider-contracts.ts';
import {manualJournalProvider,manualJournalSystems} from './manual-journals.ts';
import { loadAgentConfig, runAgent } from './agent.ts';
import { compactRunProgress, withRunProgress, finishRun } from './agent-progress.ts';
import {defaultGeneratorProvider,generateWorldDraft,loadGeneratorConfig} from './generator.ts';
import { Webhooks } from './webhooks.ts';
import { MAIL_LIMITS } from './mail.ts';
import {buildAgentContextOverview,buildAgentProviderContext} from './agent-context.ts';
import {runSeat} from './seat.ts';
import type {SeatMode} from './seat.ts';
import {agentQueue,agentWorkActions,controllerWorkActions,humanWorkActions,precedentSearch,whyTimeline,workBriefing,workItemView,GATEWAY,DISPATCHER} from './work.ts';
import {queryHistory,HistoryQueryError} from './history-sql.ts';
import {scoreSeat} from './cash-score.ts';
import {domainByKind,domainFor,seatKinds} from './domains.ts';
import {SlackBridge,loadSlackConfig} from './slack.ts';
import {argonPhrase,colleagueTick} from './colleague.ts';
import type {SlackDeps} from './slack.ts';

const root = resolve(import.meta.dir, '..');
const json = (data: any, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers });
const controllerActions = new Set(['rename_company', 'cancel_event', 'advance_time', 'advance_to', 'set_fault', 'close_period', 'reopen_period', 'decide_approval', 'receive_email', ...Object.entries(actionRequirements).filter(([, requirement]) => requirement.role === 'controller' && !('internal' in requirement && requirement.internal)).map(([type]) => type)]);
const providers: Record<string, string> = { refund: 'stripe', pay_bill: 'mercury', collect_invoice: 'stripe', post_journal: 'netsuite', send_email: 'gmail', ...Object.fromEntries(Object.entries(actionRequirements).filter(([, requirement]) => requirement.role === 'operator' && !('internal' in requirement && requirement.internal)).map(([type, requirement]) => [type, requirement.system])) };
const cookies = (request: Request) => Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map(v => v.trim().split('=')));
const integer = (s: string | null, fallback: number, min: number, max: number) => { const n = s === null ? fallback : Number(s); if (!Number.isSafeInteger(n) || n < min || n > max) throw new ServiceError(400, 'invalid_pagination'); return n; };
async function body(request: Request): Promise<any> {
  const text = await request.text();
  if (Buffer.byteLength(text) > 1_048_576) throw new ServiceError(413, 'body_too_large');
  if (!text) return {};
  if (request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(); return v; } catch { throw new ServiceError(400, 'invalid_json'); }
}
function requireController(actor: Actor | undefined): asserts actor is Actor { if (!actor || actor.role !== 'controller') throw new ServiceError(403, 'controller_required'); }
function scoped(actor: Actor | undefined, world: string): asserts actor is Actor { if (!actor) throw new ServiceError(401, 'authentication_required'); if (actor.world && actor.world !== world) throw new ServiceError(403, 'world_scope_mismatch'); }

export type ServiceOptions = { database?: string; baseUrl?: string; agentEnabled?: boolean; generationEnabled?:boolean; webhookPorts?: number[]; deliveryIntervalMs?: number; seatIntervalMs?: number; maxSeatRunsPerHour?: number;
  /** Test seam: a scripted seat that drives the same HTTP work API as the Claude run. */
  seatRunner?: typeof runSeat;
  /** false disables Slack; an object injects configuration and transports for tests. */
  slack?: false | (Partial<Pick<SlackDeps,'transport'|'socket'|'config'>> & { connect?: boolean });
  /** Test seam for simulated colleagues' wording; decisions always come from the case file. */
  colleaguePhrase?: Parameters<typeof colleagueTick>[3] };
type RunSpec={kind:'instruction';instruction:string;actor:string;requestId?:string}|{kind:'seat';mode:SeatMode;items:string[];reason:string;trigger:string;actor:string;requestId?:string};
export async function createService(options: ServiceOptions = {}) {
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:24300';
  // Cookies ignore ports. Isolate concurrently running local UI instances.
  const sessionCookie = `fw_session_${new URL(baseUrl).port || '80'}`;
  const store = new Store(options.database ?? resolve(root, 'data/worlds.sqlite'));
  const oauth = new OAuth(store, baseUrl, systemCatalog);
  const hooks = new Webhooks(store, { baseUrl, allowedPorts: options.webhookPorts });
  let deliveryTimer: ReturnType<typeof setInterval> | undefined;
  const interval = options.deliveryIntervalMs ?? 1000;
  if (interval > 0) {
    deliveryTimer = setInterval(() => { void hooks.deliverDue(undefined, { limit: 20 }).catch(error => store.audit('_service', 'webhook.dispatch_error', { error: String(error) })); }, interval);
    deliveryTimer.unref();
  }
  const workers = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  const generations = new Map<string, {abort:AbortController;promise:Promise<any>}>();
  store.db.prepare('DELETE FROM kv WHERE namespace=?').run('agent-tokens');
  // An in-process worker cannot survive its service process. Retain its last trace for a fresh shift.
  for (const run of store.all('runs')) if (run.status === 'running') { store.put('runs', run.id, finishRun(run, 'interrupted', new Date().toISOString(), { error: 'Service restarted; launch a fresh shift using durable records.' })); store.audit(run.world, 'agent.interrupted', { run_id: run.id }); }
  const config = () => ({ ...loadAgentConfig(), ...(options.agentEnabled === false ? { available: false, reason: 'Agent disabled for this instance.' } : {}) });
  const generationConfig=()=>{
    const argon=loadGeneratorConfig(),anthropic=loadAgentConfig();
    const defaultProvider=defaultGeneratorProvider(),selected=defaultProvider==='gemini-argon'?argon:anthropic;
    return {available:options.generationEnabled!==false&&selected.available,defaultProvider,providers:{'gemini-argon':argon,anthropic:{available:anthropic.available,model:anthropic.model}},...(options.generationEnabled===false?{reason:'Generation disabled for this instance.'}:!selected.available?{reason:selected.reason}:{})};
  };
  function actorFor(request: Request): Actor | undefined {
    const authorization = request.headers.get('authorization');
    if (authorization) {
      const nativeZoho=/^\/providers\/zoho-books\/worlds\/[^/]+(?:\/|$)/.test(new URL(request.url).pathname),scheme=nativeZoho?'Zoho-oauthtoken ':'Bearer ';
      if (!authorization.startsWith(scheme)) return;
      const token = authorization.slice(scheme.length), worker = store.get('agent-tokens', hash(token));
      if (worker && worker.expires_at > Date.now()) return { id: worker.actor, role: 'agent', world: worker.world, runId: worker.runId };
      return oauth.bearer(token);
    }
    const session = store.get('sessions', hash(cookies(request)[sessionCookie] ?? ''));
    if (session && session.expires_at > Date.now()) return { id: session.actor, role: 'controller' };
  }
  function currentActor(request:Request,admitted:Actor|undefined){
    const current=actorFor(request);
    if(admitted&&(!current||current.id!==admitted.id||current.role!==admitted.role||current.world!==admitted.world||current.system!==admitted.system))throw new ServiceError(401,'authentication_required','Credentials expired, were revoked or changed during request preparation');
    return current;
  }
  const snapshot = (id: string) => {
    // The imported history and the answer key stay server-side; the console gets counts.
    const full = store.world(id), summary = summarize(full), world: any = { ...full }, domain = full.seat ? domainByKind(full.kind) : undefined;
    if (domain) { for (const key of domain.hidden) delete world[key]; const counts = domain.historySummary(full); Object.assign(world, { history_counts: counts, cash_history_counts: counts }); }
    return { world, summary, connections: oauth.connections(id), runs: store.all('runs').filter(r => r.world === id).map(({ token, ...r }) => r),
      webhooks: { subscriptions: hooks.list(id), deliveries: hooks.recent(id, 50), receiver: { mode: store.get('receiver-modes', id)?.mode ?? 'accept', receipts: store.all('webhook-receipts').filter(r => r.world_id === id).slice(-50) } } };
  };
  function authorizeAction(worldId:string,input:any,actor:Actor){
    if (typeof input.type !== 'string') throw new ServiceError(400, 'action_type_required');
    if (controllerActions.has(input.type)) {
      requireController(actor);
      if (input.type === 'decide_approval' && ['approve', 'accept', 'approved'].includes(input.decision)) {
        const approval = store.world(worldId).approvals.find((a: any) => a.id === input.approval_id);
        const approvalSystem = approval && (manualJournalProvider(approval.action) ?? providers[approval.action?.type] ?? actionRequirements[approval.action?.type]?.system);
        if (approvalSystem) oauth.require(worldId, approvalSystem, 'write', actor);
      }
    }
    else {
      const declared = providers[input.type];
      if (!declared) throw new ServiceError(400, 'unsupported_action');
      const system=manualJournalProvider(input)??declared;
      oauth.require(worldId, system, 'write', actor);
    }
  }
  function recordAction(world:any,input:any,applied:ReturnType<typeof applyAction>,actor:Actor,requestId:string){
    store.save(world);
    for(const event of applied.events)store.audit(world.id,event.type,event,actor.id,requestId);
    hooks.enqueue(world.id,applied.events,{requestId,actor:actor.id,revision:world.revision});
    store.audit(world.id,'action.completed',{action:input,result:applied.result,revision:world.revision,run_id:actor.runId},actor.id,requestId);
    // Slack cards are redrawn from committed state, after the transaction.
    if(slack&&world.seat)queueMicrotask(()=>void slack!.reconcile(world.id));
  }
  function action(worldId:string,input:any,actor:Actor,key:string,requestId:string,ifMatch?:string|null){
    authorizeAction(worldId,input,actor);
    return store.once(worldId, actor.id, key, input, () => {
      const world = store.world(worldId);
      if (ifMatch && ifMatch !== String(world.revision)) throw new ServiceError(409, 'stale_revision');
      const applied=applyAction(world,input,actor);recordAction(world,input,applied,actor,requestId);
      return {result:applied.result,revision:world.revision,summary:summarize(world)};
    });
  }
  /** Every write to the system of work goes through here: the role check, one atomic
   * commit with its audit events, and an audit record for attempts that were denied. */
  function workCommand(worldId:string,input:any,actor:Actor,key:string,requestId:string){
    const type=String(input?.type??''),allowed=actor.role==='agent'?agentWorkActions:actor.role==='controller'?[...humanWorkActions,...controllerWorkActions,'work_retry_posting']:actor.role==='accountant'?humanWorkActions:actor.role==='system'?['work_retry_posting','seat_onboarded','work_escalate']:[];
    try{
      if(!allowed.includes(type))throw new ServiceError(403,'work_action_denied',`${actor.role} may not perform ${type||'an unnamed action'}`);
      return store.once(worldId,actor.id,key,input,()=>{
        const world=store.world(worldId),applied=applyAction(world,input,actor as any);
        recordAction(world,input,applied,actor,requestId);return {result:applied.result,revision:world.revision};
      });
    }catch(error:any){
      if(error?.code!=='idempotency_conflict')store.audit(worldId,'work.denied',{action:type,subject:input?.work_item_id??input?.question_id??input?.policy_id??null,code:error?.code??'internal_error',message:String(error?.message??error),run_id:actor.runId},actor.id,requestId);
      throw error;
    }
  }
  const seatWorlds=new Set<string>(store.worlds().filter(world=>world.seat).map(world=>world.id));
  const slackSetup=options.slack===false?{available:false,reason:'Slack disabled for this instance.'}:options.slack?.config?{available:true,config:options.slack.config}:loadSlackConfig();
  const slack:SlackBridge|undefined=slackSetup.available&&slackSetup.config?new SlackBridge({store,baseUrl,config:slackSetup.config,world:id=>store.world(id),work:(world,input,actor,key,requestId)=>workCommand(world,input,actor,key,requestId),...(options.slack?{transport:options.slack.transport,socket:options.slack.socket}:{})}):undefined;
  if(slack&&(options.slack===undefined||(options.slack!==false&&options.slack.connect!==false)))void slack.connect();
  const seatState=new Map<string,{failures:number;retryAt:number;starts:number[];attempts:Map<string,{count:number;updated:string}>}>();
  const stateFor=(id:string)=>{let state=seatState.get(id);if(!state){state={failures:0,retryAt:0,starts:[],attempts:new Map()};seatState.set(id,state);}return state;};
  function launchRun(id:string,spec:RunSpec){
    if (store.all('runs').some(r => r.world === id && r.status === 'running')) throw new ServiceError(409, 'agent_already_running');
    const world=store.world(id),runId = crypto.randomUUID(), token = secret(), tokenHash = hash(token), startedAt = new Date().toISOString();
    const instruction=spec.kind==='instruction'?spec.instruction:`${spec.mode==='onboarding'?'Onboarding':'Shift'} · ${spec.reason}`;
    const run:any = { id: runId, world: id, status: 'running', instruction, model: spec.kind==='seat'?config().seatModel:config().model, started_at: startedAt, output: '', progress: compactRunProgress({ type: 'agent.started' }, startedAt), ...(spec.kind==='seat'?{seat:{mode:spec.mode,items:spec.items,trigger:spec.trigger,item_versions:Object.fromEntries(spec.items.map(item=>[item,world.workItems?.find((row:any)=>row.id===item)?.updated_at??null]))}}:{}) };
    store.put('agent-tokens', tokenHash, { world: id, actor: `agent-world:${id}`, runId, expires_at: Date.now() + 900_000 });
    store.put('runs', runId, run); store.audit(id, 'agent.started', { run_id: runId, instruction, model: run.model, ...(run.seat?{seat:run.seat,started_by:spec.actor}:{}) }, spec.actor, spec.requestId);
    const abort = new AbortController(),onEvent=(e:Record<string,unknown>) => {
      const current = store.get('runs', runId) ?? run, updated = withRunProgress(current, e, new Date().toISOString());
      if (updated !== current) store.put('runs', runId, updated);
      store.audit(id, 'agent.trace', { run_id: runId, ...e }, `agent:${runId}`);
    };
    const work=spec.kind==='seat'?(options.seatRunner??runSeat)({worldId:id,baseUrl,token,mode:spec.mode,items:spec.items,reason:spec.reason,company:world.name,kind:world.kind,signal:abort.signal,onEvent}):runAgent({ worldId: id, baseUrl, token, instruction, signal: abort.signal, onEvent });
    const promise = work.then(result => {
      store.put('runs', runId, finishRun(store.get('runs', runId) ?? run, 'completed', new Date().toISOString(), result)); store.audit(id, 'agent.completed', { run_id: runId, ...result }, `agent:${runId}`);
      if(spec.kind==='seat')afterSeatRun(id,runId,spec,true);
    }).catch(error => {
      const safe = redact(String(error)).replaceAll(token, '[REDACTED]');
      store.put('runs', runId, finishRun(store.get('runs', runId) ?? run, abort.signal.aborted ? 'cancelled' : 'failed', new Date().toISOString(), { error: safe })); store.audit(id, 'agent.failed', { run_id: runId, error: safe }, `agent:${runId}`);
      if(spec.kind==='seat')afterSeatRun(id,runId,spec,false);
    }).finally(() => { store.delete('agent-tokens', tokenHash); workers.delete(runId); });
    workers.set(runId, { abort, promise });
    return run;
  }
  /** Items a run left untouched are counted; after two such runs the item stops
   * relaunching the seat and is shown as stalled until something about it changes. */
  function afterSeatRun(id:string,runId:string,spec:Extract<RunSpec,{kind:'seat'}>,completed:boolean){
    const state=stateFor(id),world=store.world(id);
    if(completed){state.failures=0;state.retryAt=0;}else{state.failures++;state.retryAt=Date.now()+Math.min(600_000,60_000*state.failures);}
    for(const itemId of spec.items){
      const item=world.workItems?.find((row:any)=>row.id===itemId);if(!item)continue;
      const previous=state.attempts.get(itemId);
      if(agentQueue(world).some((row:any)=>row.id===itemId)&&(!previous||previous.updated===item.updated_at))state.attempts.set(itemId,{count:(previous?.count??0)+1,updated:item.updated_at});
      else state.attempts.delete(itemId);
      if((state.attempts.get(itemId)?.count??0)===2){
        store.audit(id,'seat.item_stalled',{work_item_id:itemId,run_id:runId},'dispatcher');
        // Two idle runs mean the seat cannot move this item. Hand it to a person rather than loop; the
        // dispatcher role may escalate and nothing else, and the escalation is a logged transition.
        try{workCommand(id,{type:'work_escalate',work_item_id:itemId,to_role:'accountant',reason:`The seat left ${itemId} untouched in two runs (last ${runId}). A person needs to decide it.`},DISPATCHER as any,`stall:${itemId}:${item.updated_at}`,crypto.randomUUID());state.attempts.delete(itemId);}
        catch(error){store.audit(id,'seat.escalation_failed',{work_item_id:itemId,error:String(error)},'dispatcher');}
      }
    }
    if(completed&&spec.mode==='onboarding'&&world.seat?.onboarding?.status==='pending'&&world.policies?.length){
      try{workCommand(id,{type:'seat_onboarded',run_id:runId},GATEWAY as any,`onboarded:${runId}`,crypto.randomUUID());}catch(error){store.audit(id,'seat.onboarding_record_failed',{run_id:runId,error:String(error)},'dispatcher');}
    }
  }
  function stalled(id:string){return [...stateFor(id).attempts].filter(([,row])=>row.count>=2).map(([item])=>item);}
  function seatStatus(id:string){
    const world=store.world(id);if(!world.seat)return undefined;
    const connections=oauth.connections(id),missing=domainFor(world).seatSystems.filter(system=>connections.find((row:any)=>row.system===system)?.status!=='connected'),state=stateFor(id);
    const running=store.all('runs').find((row:any)=>row.world===id&&row.status==='running');
    return {on_duty:Boolean(world.seat.autonomy.enabled),systems:domainFor(world).seatSystems,agent_available:Boolean(options.seatRunner)||config().available,model:config().seatModel,effort:config().seatEffort,missing_connections:missing,running_run:running?.id??null,stalled_items:stalled(id),retry_at:state.retryAt>Date.now()?new Date(state.retryAt).toISOString():null,runs_last_hour:state.starts.filter(at=>at>Date.now()-3_600_000).length,max_runs_per_hour:options.maxSeatRunsPerHour??12};
  }
  /** Work starts itself: a new bank line, an answer or a rejection puts an item in the
   * seat's queue, and the dispatcher launches a run for it without anyone asking. */
  function nextSeatRun(id:string,world:any):Extract<RunSpec,{kind:'seat'}>|undefined{
    const blocked=new Set(stalled(id)),queue=agentQueue(world).filter((item:any)=>!blocked.has(item.id));
    if(world.seat.onboarding?.status==='pending')return {kind:'seat',mode:'onboarding',items:queue.slice(0,6).map((item:any)=>item.id),reason:`No policies yet; ${domainFor(world).historySummary(world).records} historical records to learn from.`,trigger:'onboarding',actor:'dispatcher'};
    if(!queue.length)return;
    const items=queue.slice(0,6),count=(state:string)=>items.filter((item:any)=>item.state===state).length,parts=[];
    if(count('new'))parts.push(`${count('new')} new (${[...new Set(items.filter((item:any)=>item.state==='new').map((item:any)=>item.kind==='follow_up'?'follow-up due':'bank line'))].join(', ')})`);
    if(count('answered'))parts.push(`${count('answered')} answered by a person`);
    if(count('rejected'))parts.push(`${count('rejected')} rejected with a reason`);
    return {kind:'seat',mode:'shift',items:items.map((item:any)=>item.id),reason:parts.join('; '),trigger:count('rejected')?'rejection':count('answered')?'answer':'bank-feed',actor:'dispatcher'};
  }
  const phrase=options.colleaguePhrase??argonPhrase();
  let seatTicking=false;
  async function seatTick(){
    if(seatTicking)return;seatTicking=true;
    try{
      for(const id of [...seatWorlds]){
        let world:any;try{world=store.world(id);}catch{seatWorlds.delete(id);continue;}
        if(slack&&store.get('slack-bindings',id)?.enabled)void slack.reconcile(id);
        if(world.seat?.simulation?.colleagues){
          try{const acted=await colleagueTick(id,world,workCommand,phrase);if(acted){store.audit(id,'colleague.acted',{phrased_by:acted.phrased_by},'simulated-colleague');world=store.world(id);}}
          catch(error){store.audit(id,'colleague.failed',{error:String(error)},'simulated-colleague');}
        }
        if(!world.seat?.autonomy?.enabled)continue;
        if(world.workItems?.some((item:any)=>item.state==='approved'&&item.posting_error)&&(world.faults?.netsuite?.mode??'healthy')==='healthy'&&(world.faults?.ledger?.mode??'healthy')==='healthy'){
          try{workCommand(id,{type:'work_retry_posting'},GATEWAY as any,`retry:${world.revision}`,crypto.randomUUID());world=store.world(id);}catch{}
        }
        const status=seatStatus(id)!;
        if(!status.agent_available||status.running_run||status.missing_connections.length||status.retry_at||status.runs_last_hour>=status.max_runs_per_hour)continue;
        const plan=nextSeatRun(id,world);if(!plan)continue;
        try{launchRun(id,plan);stateFor(id).starts=[...stateFor(id).starts.filter(at=>at>Date.now()-3_600_000),Date.now()];}
        catch(error){store.audit(id,'seat.launch_failed',{error:String(error)},'dispatcher');}
      }
    }finally{seatTicking=false;}
  }
  let seatTimer:ReturnType<typeof setInterval>|undefined;
  const seatInterval=options.seatIntervalMs??2000;
  if(seatInterval>0){seatTimer=setInterval(()=>{void seatTick().catch(error=>store.audit('_service','seat.dispatch_error',{error:String(error)}));},seatInterval);seatTimer.unref();}
  async function dispatch(request: Request, actor: Actor | undefined, requestId: string): Promise<Response> {
    const url = new URL(request.url), path = url.pathname, parts = path.split('/').filter(Boolean), method = request.method;
    if (path === '/health') return json({ service: 'finance-world', runtime: `bun/${Bun.version}`, router: 'vercel-labs/emulate', synthetic: true, version: 1, worlds: store.worlds().length });
    if (parts[0] === 'receivers' && parts.length === 2 && method === 'POST') {
      const worldId = parts[1]; store.world(worldId);
      const verified = hooks.verify(worldId, request.headers, await request.text());
      if (store.get('receiver-modes', worldId)?.mode === 'fail') throw new ServiceError(503, 'receiver_unavailable', 'Judge receiver is simulating a failed delivery.');
      const previous = store.get('webhook-receipts', verified.delivery_id);
      if (!previous) store.transaction(() => {
        store.put('webhook-receipts', verified.delivery_id, { ...verified, world_id: worldId, received_at: new Date().toISOString() });
        store.audit(worldId, 'webhook.received', { event_id: verified.event_id, delivery_id: verified.delivery_id, subscription_id: verified.subscription_id });
      });
      return json({ received: true, duplicate: Boolean(previous), event_id: verified.event_id });
    }
    if (method === 'GET' && ['/', '/app.js', '/app.css'].includes(path)) {
      const file = path === '/' ? 'index.html' : path.slice(1), headers: Record<string, string> = { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' };
      if (path === '/' && !actor) {
        const session = secret(); store.put('sessions', hash(session), { actor: 'controller-local', expires_at: Date.now() + 86400_000 });
        headers['Set-Cookie'] = `${sessionCookie}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`;
      }
      return new Response(Bun.file(resolve(root, 'web', ...(path === '/' ? [file] : ['dist', file]))), { headers });
    }
    if (path === '/oauth/callback' && method === 'GET') {
      requireController(actor);
      return Response.redirect(oauth.callback(url.searchParams, hash(cookies(request)[sessionCookie] ?? '')), 303);
    }
    if (parts[0] === 'oauth' && parts.length === 3) {
      const [, system, route] = parts;
      if (route === '.well-known' || route === 'metadata') return json({ issuer: `${baseUrl}/oauth/${system}`, authorization_endpoint: `${baseUrl}/oauth/${system}/authorize`, token_endpoint: `${baseUrl}/oauth/${system}/token`, revocation_endpoint: `${baseUrl}/oauth/${system}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], scopes_supported: ['read', 'write'], token_endpoint_auth_methods_supported: ['none'] });
      if (route === 'consent' && method === 'GET') { requireController(actor); return json(oauth.consent(system, url.searchParams)); }
      if (route === 'authorize') {
        requireController(actor);
        if (method === 'GET') return new Response(await oauth.consentPage(system, url.searchParams), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        if (method === 'POST'){const input=await body(request),authorized=currentActor(request,actor);requireController(authorized);return Response.redirect(oauth.authorize(system,new URLSearchParams(input),authorized),303);}
      }
      if (route === 'token' && method === 'POST') return json(oauth.token(system, await body(request)));
      if (route === 'revoke' && method === 'POST') return json(oauth.revokeToken(system, await body(request)));
    }
    if (path === '/api/bootstrap' && method === 'GET') {
      requireController(actor);
      return json({ worlds: store.worlds().map(({ id, name, kind, now, revision }) => ({ id, name, kind, now, revision })), scenarios: scenarioCatalog, seats: seatKinds(), systems: systemCatalog, agent: config(),generator:generationConfig(), slack: slack ? { available: true, ...slack.status() } : { available: false, reason: slackSetup.reason } });
    }
    if (path === '/api/oauth/clients' && method === 'POST') { requireController(actor);const input=await body(request),authorized=currentActor(request,actor);requireController(authorized);return json(oauth.register(input),201); }
    if (path === '/api/worlds' && method === 'POST') {
      requireController(actor); const input = await body(request);actor=currentActor(request,actor);requireController(actor);
      const world = createWorld(input, 'world-' + crypto.randomUUID()),creator=actor.id;
      store.transaction(() => { store.save(world); store.audit(world.id, 'world.created', { scenario: input, summary: summarize(world) }, creator, requestId); });
      if (world.seat) seatWorlds.add(world.id);
      return json(snapshot(world.id), 201);
    }
    if (path === '/api/generate' && method === 'POST') {
      requireController(actor); if (options.generationEnabled===false) throw new ServiceError(503, 'generator_unavailable', 'Generation disabled for this instance.');
      const input = await body(request);actor=currentActor(request,actor);requireController(actor); if (typeof input.prompt !== 'string' || input.prompt.length < 10 || input.prompt.length > 12000) throw new ServiceError(400, 'invalid_prompt');
      const generationActor=actor.id;
      if(input.provider!==undefined&&!['gemini-argon','anthropic'].includes(input.provider))throw new ServiceError(400,'unsupported_generator_provider');
      const selectedProvider=input.provider??defaultGeneratorProvider(),selectedConfig=selectedProvider==='gemini-argon'?loadGeneratorConfig():loadAgentConfig();
      if(!selectedConfig.available)throw new ServiceError(503,'generator_unavailable',selectedConfig.reason??'The selected generation provider is unavailable.');
      store.audit('_service', 'scenario.generation_requested', { prompt_sha256: hash(input.prompt),prompt_chars:input.prompt.length,provider:input.provider??defaultGeneratorProvider() }, generationActor, requestId);
      if (generations.has(generationActor)) throw new ServiceError(409, 'generation_already_running');
      const abort = new AbortController(),cancel=()=>abort.abort(request.signal.reason);
      if(request.signal.aborted)cancel();else request.signal.addEventListener('abort',cancel,{once:true});
      const promise=generateWorldDraft(input.prompt,{provider:input.provider,signal:abort.signal,onEvent:e=>{store.audit('_service','scenario.generation_trace',e,generationActor,requestId);}});generations.set(generationActor,{abort,promise});
      try {
        const result = await promise;
        if(abort.signal.aborted)throw new ServiceError(409,'generation_cancelled','Generation was cancelled before draft acceptance.');
        store.audit('_service', 'scenario.generated', result, generationActor, requestId);
        return json(result);
      } finally { generations.delete(generationActor);request.signal.removeEventListener('abort',cancel); }
    }
    if (parts[0] === 'api' && parts[1] === 'worlds' && parts[2]) {
      const id = parts[2], route = parts.slice(3).join('/');
      scoped(actor, id); const world = store.world(id);
      if (!route && method === 'GET') { requireController(actor); return json(snapshot(id), 200, { ETag: String(world.revision) }); }
      if (route === 'context' && method === 'GET') {
        const params=url.searchParams;
        if(params.size){
          const view=params.get('view');
          if(!['overview','provider'].includes(view??'')||[...params.keys()].some(key=>!['view','system','cursor','limit'].includes(key)||params.getAll(key).length!==1))throw new ServiceError(400,'invalid_context_query');
          if(view==='overview'&&params.size!==1||view==='provider'&&!params.get('system'))throw new ServiceError(400,'invalid_context_query');
          const input={world,systems:systemCatalog,providerContracts,connections:oauth.connections(id),actionProviders:providers,actionProviderOptions:{prepare_manual_journal:manualJournalSystems,submit_manual_journal:manualJournalSystems},wallNow:new Date().toISOString(),mandate:'Operate through connected provider APIs. Read source evidence before effects. Never approve your own work, change connections or simulation time. Independent review is separate from submission; pending is not settled. Use each record currency and native minor units. Keep original payment references.'};
          if(view==='overview')return json(buildAgentContextOverview(input));
          const pageNumber=(key:'cursor'|'limit')=>{
            const value=params.get(key);
            if(value===null)return undefined;
            if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new ServiceError(400,`invalid_context_${key}`);
            return Number(value);
          };
          return json(buildAgentProviderContext(input,{system:params.get('system')!,cursor:pageNumber('cursor'),limit:pageNumber('limit')}));
        }
        return json({ world: { id, name: world.name, kind: world.kind, now: world.now, revision: world.revision }, clock_domains: { simulation: world.now, wall: new Date().toISOString(), oauth_expiry: 'wall', financial_settlement: 'simulation' }, systems: systemCatalog, connections: oauth.connections(id), mandate: 'Operate this simulated finance team through connected provider APIs. Read source documents and policy before effects. Never approve your own work, change connections or simulation time. High-value actions create controller review. Pending is not settled. Use native minor units for each account or statement currency (USD/EUR/GBP 2 decimals, JPY 0, KWD 3); the functional general ledger uses USD cents. Keep original payment references. Record unresolved work in a simulated email when Gmail is connected.', provider_contracts:providerContracts,action_providers: providers, action_provider_options:{prepare_manual_journal:manualJournalSystems,submit_manual_journal:manualJournalSystems}, available_actions: Object.keys(providers), records_endpoint: `/api/worlds/${id}/records?system=SYSTEM&feed=FEED`, note: 'Judge state is privileged. Read financial facts through scoped connectors. All provider effects stay in this world.' });
      }
      if (route === 'records' && method === 'GET') {
        const system = url.searchParams.get('system') ?? '', feed = url.searchParams.get('feed') ?? '';
        oauth.require(id, system, 'read', actor);
        const cursor = integer(url.searchParams.get('cursor'), 0, 0, 1000000), limit = integer(url.searchParams.get('limit'), 50, 1, 200);
        const records = recordsFor(world, system, feed), data = records.slice(cursor, cursor + limit);
        return json({ system, feed, schema_kind: 'finance-world-normalized-v1', data, total: records.length, next_cursor: cursor + limit < records.length ? String(cursor + limit) : null });
      }
      if (route === 'actions' && method === 'POST'){const input=await body(request),authorized=currentActor(request,actor);scoped(authorized,id);return json(action(id,input,authorized,request.headers.get('Idempotency-Key')??'',requestId,request.headers.get('If-Match')));}
      if (parts[3] === 'attachment-content' && parts.length === 6 && method === 'GET') {
        oauth.require(id, 'gmail', 'read', actor);
        const message = world.messages.find((m: any) => m.id === parts[4]), attachment = message?.attachments?.find((a: any) => a.id === parts[5]);
        if (!attachment) throw new ServiceError(404, 'attachment_not_found');
        const bytes = Buffer.from(attachment.data, 'base64url'), textFormat = /^(text\/|application\/(json|xml|csv)(;|$))/.test(attachment.mimeType);
        const { data, ...metadata } = attachment;
        const offset = integer(url.searchParams.get('offset'), 0, 0, 1_000_000), limit = integer(url.searchParams.get('limit'), 16000, 1, 32000);
        let characters: string[] | undefined;
        if (textFormat) { try { characters = Array.from(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { /* Preserve original bytes; never substitute corrupt evidence. */ } }
        return json({ message_id: message.id, ...metadata, source: `gmail:${message.id}:${attachment.id}`, ...(characters ? { text: characters.slice(offset, offset + limit).join(''), next_offset: offset + limit < characters.length ? offset + limit : null, total_characters: characters.length } : { extraction: textFormat ? 'unsupported-encoding' : 'binary', note: textFormat ? 'Attachment bytes are not valid UTF-8. Original bytes are retained through the Gmail attachment API; no text extraction has been performed.' : 'Binary attachment is retained intact and available through the Gmail attachment API. No text extraction has been performed; do not infer its contents.' }) });
      }
      if (parts[3] === 'messages' && parts[5] === 'attachments' && parts.length === 7 && method === 'GET') {
        requireController(actor);
        const message = world.messages.find((m: any) => m.id === parts[4]), attachment = message?.attachments?.find((a: any) => a.id === parts[6]);
        if (!attachment) throw new ServiceError(404, 'attachment_not_found');
        const name = encodeURIComponent(attachment.filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
        return new Response(Buffer.from(attachment.data, 'base64url'), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${name}` } });
      }
      if (route === 'webhooks' && method === 'GET') { requireController(actor); return json({ data: hooks.list(id) }); }
      if (route === 'webhooks' && method === 'POST') {
        requireController(actor); const input = await body(request);actor=currentActor(request,actor);requireController(actor);
        return json(hooks.register(id, { ...input, url: input.url || `${baseUrl}/receivers/${id}` }), 201);
      }
      if (route === 'webhooks/deliveries' && method === 'GET') {
        requireController(actor); return json(hooks.deliveries(id, { after: integer(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER), limit: integer(url.searchParams.get('limit'), 100, 1, 200) }));
      }
      if (route === 'webhooks/dispatch' && method === 'POST') { requireController(actor); return json(await hooks.deliverDue(id, { limit: 20 })); }
      if (route === 'webhooks/receiver' && method === 'POST') {
        requireController(actor); const input = await body(request);actor=currentActor(request,actor);requireController(actor);
        if (!['accept', 'fail'].includes(input.mode)) throw new ServiceError(400, 'invalid_receiver_mode');
        store.put('receiver-modes', id, { mode: input.mode }); store.audit(id, 'webhook.receiver_mode_changed', { mode: input.mode }, actor.id, requestId);
        return json({ mode: input.mode });
      }
      if (parts[3] === 'webhooks' && parts.length === 6 && parts[5] === 'disable' && method === 'POST') { requireController(actor); return json(hooks.disable(id, parts[4])); }
      if (parts[3] === 'webhooks' && parts[4] === 'deliveries' && parts.length === 7 && parts[6] === 'retry' && method === 'POST') { requireController(actor); return json(hooks.retry(id, parts[5])); }
      if (route.startsWith('connect/') && method === 'POST') { requireController(actor); return json(oauth.start(id, route.slice(8), hash(cookies(request)[sessionCookie] ?? ''))); }
      if (parts[3] === 'connections' && parts[5] === 'revoke' && method === 'POST') { requireController(actor); return json(oauth.revoke(id, parts[4])); }
      if (route === 'audit' && method === 'GET') {
        requireController(actor);
        const params = url.searchParams, after = integer(params.get('after'), 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(params.get('limit'), 200, 1, 1000);
        if (['order', 'before', 'snapshot', 'scope', 'q'].some(key => params.has(key))) {
          const order = params.get('order') ?? 'asc', scope = params.get('scope') ?? 'all', q = params.get('q') ?? '';
          if (!['asc', 'desc'].includes(order) || !['all', 'activity', 'errors'].includes(scope) || q.length > 500) throw new ServiceError(400, 'invalid_audit_query');
          if ((order === 'desc' && after !== 0) || (order === 'asc' && params.has('before'))) throw new ServiceError(400, 'invalid_audit_cursor');
          const before = params.has('before') ? integer(params.get('before'), 0, 1, Number.MAX_SAFE_INTEGER) : undefined;
          const snapshot = params.has('snapshot') ? integer(params.get('snapshot'), 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
          return json(store.queryEvents(id, { order: order as 'asc' | 'desc', after, before, snapshot, limit, scope: scope as 'all' | 'activity' | 'errors', q: q.trim() }));
        }
        const data = store.events(id, after, limit);
        return json({ data, next_cursor: data.length === limit ? String(data.at(-1).seq) : null });
      }
      if (parts[3] === 'audit' && parts[4] === 'events' && parts.length === 6 && method === 'GET') {
        requireController(actor);
        return json(store.event(id, integer(parts[5], 0, 1, Number.MAX_SAFE_INTEGER)));
      }
      if (route === 'audit/verify' && method === 'GET') { requireController(actor); return json(store.verify(id)); }
      if (route === 'audit/export' && method === 'GET') {
        requireController(actor); let after = 0, rows: any[] = [], page;
        do { page = store.events(id, after, 1000); rows.push(...page); after = page.at(-1)?.seq ?? after; } while (page.length === 1000);
        return new Response(rows.map(r => JSON.stringify(r)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${id}-audit.jsonl"` } });
      }
      if (route.startsWith('work') || route === 'why') {
        if (!world.seat) throw new ServiceError(404, 'no_seat', 'This company has no autonomous seat.');
        if (!actor || !['agent', 'controller'].includes(actor.role)) throw new ServiceError(403, 'work_access_denied');
        const domain = domainFor(world);
        // The seat reads its systems of record only through connections the controller granted.
        const seatRead = (systems: string[]) => { if (actor!.role === 'agent') for (const system of systems) oauth.require(id, system, 'read', actor!); };
        const find = (rows: any[], key: any, label: string) => rows.find(row => row.id === key) ?? (() => { throw new ServiceError(404, 'not_found', `${label} not found`); })();
        if (route === 'work/briefing' && method === 'GET') return json({ ...workBriefing(world), dispatcher: seatStatus(id) });
        if (route === 'work/items' && method === 'GET') { const state = url.searchParams.get('state'); return json({ data: world.workItems.filter((item: any) => !state || item.state === state) }); }
        if (parts[3] === 'work' && parts[4] === 'items' && parts.length === 6 && method === 'GET') { seatRead(domain.readSystems.item); return json(workItemView(world, decodeURIComponent(parts[5]), { find })); }
        if (route === 'work/precedents' && method === 'GET') { const q = url.searchParams; return json({ data: precedentSearch(world, { subject_id: q.get('subject_id') ?? q.get('customer_id') ?? undefined, counterparty: q.get('counterparty') ?? q.get('payer') ?? undefined, kind: q.get('kind') ?? undefined, text: q.get('text') ?? undefined, limit: integer(q.get('limit'), 20, 1, 100) }) }); }
        if (route === 'work/policies' && method === 'GET') return json({ data: world.policies });
        if (route === 'work/history' && method === 'POST') {
          seatRead(domain.readSystems.history); const input = await body(request);
          try { return json(await queryHistory(world, input.sql, { limit: typeof input.limit === 'number' ? input.limit : undefined })); }
          catch (error) { if (error instanceof HistoryQueryError) throw new ServiceError(error.status, error.code, error.message); throw error; }
        }
        if (route === 'work' && method === 'POST') { const input = await body(request), authorized = currentActor(request, actor); scoped(authorized, id); return json(workCommand(id, input, authorized!, request.headers.get('Idempotency-Key') ?? '', requestId)); }
        if (route === 'why' && method === 'GET') { const subject = url.searchParams.get('subject') ?? ''; if (!subject || subject.length > 160) throw new ServiceError(400, 'subject_required'); return json({ ...whyTimeline(world, subject), denied: store.queryEvents(id, { order: 'asc', limit: 50, scope: 'errors', q: subject }).data.filter((event: any) => event.type === 'work.denied') }); }
        if (route === 'work/score' && method === 'GET') { requireController(actor); return json(scoreSeat(world)); }
        if (route === 'work/status' && method === 'GET') return json(seatStatus(id));
        if (route === 'work/slack' && method === 'GET') { requireController(actor); return json({ available: Boolean(slack), ...(slack ? { status: slack.status(), binding: store.get('slack-bindings', id) ?? { enabled: false } } : { reason: slackSetup.reason }) }); }
        if (route === 'work/slack' && method === 'POST') {
          requireController(actor); const input = await body(request); actor = currentActor(request, actor); requireController(actor);
          if (!slack) throw new ServiceError(503, 'slack_unavailable', slackSetup.reason ?? 'Slack is not configured.');
          if (typeof input.enabled !== 'boolean') throw new ServiceError(400, 'invalid_slack_binding');
          const binding = slack.bind(id, input.enabled, typeof input.channel === 'string' ? input.channel : undefined); store.audit(id, 'slack.binding_changed', binding, actor.id, requestId);
          if (input.enabled) void slack.reconcile(id);
          return json({ binding, status: slack.status() });
        }
        throw new ServiceError(404, 'not_found');
      }
      if (route === 'agent' && method === 'POST') {
        requireController(actor); if (!config().available && !(world.seat && options.seatRunner)) throw new ServiceError(503, 'agent_unavailable', config().reason);
        const input = await body(request);actor=currentActor(request,actor);requireController(actor);const instruction = input.instruction ?? 'Investigate the current scenario, carry out authorized financial work through the connected systems, and report remaining blockers with evidence.';
        if (typeof instruction !== 'string' || instruction.length > 12000 || instruction.length < 5) throw new ServiceError(400, 'invalid_instruction');
        // A company with a seat is worked by the seat; an instruction becomes a shift note.
        if (world.seat) {
          const queue=agentQueue(world).slice(0,6).map((item:any)=>item.id),mode:SeatMode=world.seat.onboarding?.status==='pending'?'onboarding':'shift';
          return json(launchRun(id,{kind:'seat',mode,items:queue,reason:`Requested by the controller: ${instruction.slice(0,600)}`,trigger:'controller',actor:actor.id,requestId}),202);
        }
        return json(launchRun(id,{kind:'instruction',instruction,actor:actor.id,requestId}), 202);
      }
      if (parts[3] === 'agent' && parts[5] === 'cancel' && method === 'POST') {
        requireController(actor); const run = store.get('runs', parts[4]); if (!run || run.world !== id) throw new ServiceError(404, 'run_not_found');
        workers.get(run.id)?.abort.abort(); return json({ id: run.id, cancellation_requested: true });
      }
    }
    // Provider-shaped subsets and normalized feeds share the same domain transactions.
    if (parts[0] === 'providers' && parts[1] && parts[2] === 'worlds' && parts[3]) {
      const system = parts[1], id = parts[3], route = '/' + parts.slice(4).join('/'); scoped(actor, id);
      const contract=matchProviderContract(system,method,route),feedRequest=method==='GET'&&parts.length===6&&parts[4]==='feeds';
      oauth.require(id, system, contract?.access??(method==='GET'?'read':'write'), actor);
      if(!contract&&!feedRequest)throw new ServiceError(404,'unsupported_provider_route','This native route is not implemented. Inspect provider_contracts in context or capabilities.');
      const world = normalizeWorld(store.world(id)),input=method==='GET'?undefined:await body(request),baseRevision=world.revision,key=request.headers.get('Idempotency-Key')??'';
      const nativeActor=currentActor(request,actor);scoped(nativeActor,id);oauth.require(id,system,contract?.access??'read',nativeActor);
      // Validate tenancy even on an idempotent replay. This simulation uses the
      // canonical world ID as its tenant; the SDK supplies it from host scope.
      if(system==='xero'&&request.headers.has('Xero-Tenant-Id')&&request.headers.get('Xero-Tenant-Id')!==id)throw new ServiceError(403,'provider_world_mismatch','Xero tenant must equal the scoped world');
      if(system==='zoho-books'){if(url.searchParams.getAll('organization_id').length!==1)throw new ServiceError(400,'invalid_organization_id','Zoho requires exactly one organization_id');if(url.searchParams.get('organization_id')!==id)throw new ServiceError(403,'provider_world_mismatch','Zoho organization must equal the scoped world');}
      const signature={native_operation:contract?.id,method,route,query:[...url.searchParams],body:input??null};
      let response=contract?.access==='write'?store.replay(id,nativeActor.id,key,signature):undefined;
      if(!response&&contract){
        let planned:{input:any;applied:ReturnType<typeof applyAction>}|undefined;
        response=await providerRequest({system,world,route,url,method,input,headers:request.headers,execute:input=>{
          if(contract.access!=='write')throw new ServiceError(403,'provider_read_only','A read contract cannot execute financial actions');
          if(planned)throw new ServiceError(501,'provider_batch_unsupported','This contract permits one canonical action per request');
          authorizeAction(id,input,nativeActor);const applied=applyAction(world,input,nativeActor);planned={input:structuredClone(input),applied};return applied.result;
        }});
        if(contract.access==='write'){
          if(!response||!planned||response.rawBody!==undefined)throw new ServiceError(501,'provider_write_unsupported','A native write must produce one explicit canonical action and JSON response');
          const prepared=response,effect=planned;
          response=store.once(id,nativeActor.id,key,signature,()=>{
            const authorized=currentActor(request,nativeActor);scoped(authorized,id);
            oauth.require(id,system,'write',authorized);authorizeAction(id,effect.input,authorized);
            if(store.world(id).revision!==baseRevision)throw new ServiceError(409,'stale_revision','World changed during native request preparation; read current records before retrying');
            recordAction(world,effect.input,effect.applied,nativeActor,requestId);return prepared;
          });
        }
      }
      if(response?.replayed)response.headers={...response.headers,'Idempotent-Replayed':'true'};
      if (response){
        if(response.status===304||response.status===204)return new Response(null,{status:response.status,headers:response.headers});
        if(response.rawBody!==undefined)return new Response(typeof response.rawBody==='string'?response.rawBody:new Uint8Array(response.rawBody),{status:response.status??200,headers:{'Content-Type':'application/octet-stream',...response.headers}});
        return json(response.body,response.status??200,response.headers);
      }
      if (feedRequest && parts[5]) {
        const records = recordsFor(world, system, parts[5]), limit = integer(url.searchParams.get('limit'), 50, 1, 200), cursor = integer(url.searchParams.get('cursor'), 0, 0, 1000000);
        return json({ data: records.slice(cursor, cursor + limit), next_cursor: cursor + limit < records.length ? String(cursor + limit) : null, schema_kind: 'finance-world-normalized-v1' });
      }
      throw new ServiceError(404, 'unsupported_provider_route', 'This provider route is not implemented. Inspect /api/capabilities for exact contracts.');
    }
    if (path === '/api/capabilities' && method === 'GET') {
      if (!actor) throw new ServiceError(401, 'authentication_required');
      return json({
        coverage:{scenario_family_count:scenarioCatalog.length,scenario_families:scenarioCatalog,shared_projection_count:systemCatalog.length,rest_subset_providers:[...new Set(providerContracts.map(contract=>contract.system))],native_operation_count:providerContracts.length,note:'Projections share one canonical world. Listed native contracts are explicit supported subsets; unsupported vendor operations fail.'},
        generation:{...generationConfig(),usage:'Raw provider token usage is retained by stage; Argon thoughts are excluded from content but counted when reported.',cost:'Argon cost_usd is null without configured verified rates; configured rates produce an estimate. Claude reports SDK cost.',source_context:'Generated parties, documents and emails reference materialized canonical records and remain context-only; the draft is validated under independent world IDs before saving.'},
        blueprints:{version:1,source_mode:'An explicit blueprint replaces preset seeds; quantities and amounts come from typed source records.',opening_capital:'Explicit USD initialCashMinor or startingCashMinor, including zero; no model-supplied journals or opening subledger balances.',limits:{source_records:200,combined_lines:400,bytes:98304},sources:['USD customers/vendors/items and completed service contracts/invoices/bills','payroll employment/time and synthetic or 2026 federal policy','approved or pending procurement with actual receipt/invoice source transitions','verified native bank accounts and rational quotes','completed-service foreign receivables/payables','source-backed asset policies/acquisitions and dated capitalization/service history','independent bank fees/interest, closing FX quotes and unreconciled statements','signed ticket events, exact orders, captured or voided payments, processor availability, payouts/topups and cancellations'],chronology:'Optional as_of advances actual controller time with exact dated ticket/processor/asset source transitions and one-hour treasury funding settlement; no fabricated journals or retroactive GL posting.',history:'Host-generated IDs and stable external event IDs; each action/result/event is retained independently. Historical approvals use distinct controller and operator identities; historical funding must actually settle.',atomicity:'Invalid sources reject the whole unsaved world; no partial persistence or preset fallback.'},
        foreign_services:{functional_currency:'USD',source_recognition_minimum_usd_cents:1,native_currencies:['EUR','GBP','JPY','KWD'],sources:'Signed contracts and completed-service evidence must precede invoice issuance. Source FX must cover issuance; cumulative invoices cannot exceed contract authority.',settlement:'Independent approval for every collection/payment; verified same-currency bank and counterparty routes. Accepted quotes remain locked through provider outages; native reservations are shared with treasury.',accounting:'Separate native balances, original functional basis and current USD carrying values; obligation and cash FX components are proved separately. Revaluation is cash-neutral; deferred journals post once. Native receipts below one USD cent retain approval and receipt proof; zero net functional effect is explicitly accounted without a fictitious journal. Obligation allocation rounding is separate from rate gain; pooled cash realization includes disclosed basis rounding.',projections:'QuickBooks and NetSuite invoice/bill amounts retain native currency precision; journals remain USD. Exact functional and quote evidence is retained in finance_world metadata.',excluded:['foreign inventory purchasing','withholding tax','supplier/customer credit adjustments','direct foreign-to-different-foreign conversion','real bank execution']},
        manual_journals:{provider:'xero',providers:manualJournalSystems,default_provider:'xero',currency:'USD',sources:'Existing canonical source documents and balanced noncontrol account lines; immutable source snapshots, original provider and versioned drafts. Sage requires a controller-recorded journal register; SAP requires a configured persistent native identity space.',approval:'Every new prepared journal requires an independent controller decision. A requested POSTED status remains DRAFT until an actual GL entry exists.',posting:'Current simulation date, open period and healthy original accounting provider and ledger required at submission and approval. Failure leaves the decision pending; retry after recovery without altering journal history.',excluded:['tax or tracking allocation','backdating','posted journal edits or voids','batch writes','cash or subledger control adjustments']},
        fixed_assets:{currency:'USD',basis:'Approved matched procurement and exact received-lot allocations; capitalization moves inventory to asset cost without creating cash or payables.',depreciation:'Controller book policy; straight line, salvage floor, full month following service and completed months only; no tax depreciation.',disposal:'Existing controller terms, independent approval and a separate physical-disposal fact are required before derecognition; sales create source-linked receivables.',posting:'Deferred asset operations retain their original journals and post once after accounting recovery.'},
        treasury_fx:{functional_currency:'USD',native_currencies:['USD','EUR','GBP','JPY','KWD'],minor_unit_scales:{USD:2,EUR:2,GBP:2,JPY:0,KWD:3},transfers:'Verified internal accounts and original source quotes; every transfer requires independent approval. Paired native bank legs settle atomically with one operation and receipt.',valuation:'Revaluation is native-cash neutral; historical cost, USD carrying value and realized/unrealized FX remain separate.',boundaries:'Controller owns account status, source quotes and cancellation. Operators cannot override a route/rate, self-approve or backdate posting.'},
        supplier_payments:{currency:'USD',route_verification:{action:'record_supplier_route',fields:['vendor_id','previous_route_id','destination_reference','verification_reference','verified_at','verification_method','reason','external_event_id'],methods:['callback_on_file','bank_portal'],semantics:'Independent controller evidence creates an immutable successor; original contracts, bills and accepted instructions keep their original route. Generated correspondence grants no authority.'},returns:'Actual returns reopen AP and retain original receipts. The returned route is held for new requests, approval and settlement; existing reservations remain until a bank-confirmed terminal outcome.',outcomes:{actions:['cancel_bill_payment','reject_bill_payment'],required:['operation_id','bank_reference','reason','external_event_id'],rejection_codes:['invalid_beneficiary','insufficient_funds','bank_rejected'],semantics:'Only pending instructions without settlement evidence may terminate; release reservation without changing cash, AP or journals. Invalid-beneficiary rejection holds its route.'},requests:'pay_bill freezes current route evidence. Successor routes and retries require fresh independent approval. request_bill_payment always requires independent approval and an immutable company-scoped body idempotency key; supported native execution is USD ACH only.',feeds:['supplier-route','supplier-route-hold','bill-payment-outcome','payment-instruction','bill-payment-request'],excluded:['real bank execution','raw bank credentials','wire/card payment requests','automatic rerouting','commercial supplier credits']},
        statutory_payroll:{tax_year:2026,jurisdiction:'US-federal',wage_kind:'regular',sources:'Controller-recorded W-4, distinct opening YTD tax bases and versioned policy; current gross is taxable for supported federal components.',components:['federal_income_tax','social_security','medicare','additional_medicare','futa'],payments:'Independent wage approval and actual wage settlement precede a separate independently approved tax remittance.',excluded:['state/local tax','pretax deductions','supplemental wages','FUTA credit','tax return filing','external bank execution']},
        ticketing:{currency:'USD',sources:['record_ticket_event','record_ticket_order','record_ticket_payment','record_processor_payout','record_processor_topup','record_ticket_cancellation'],authority:'Controller-recorded signed event terms and explicit source outcomes; messages alone do not authorize cancellation or cash.',capture:'One full captured or voided outcome per order. Whole-order admission/tax/service-fee amounts and actual processing fees are explicit. Capture credits processor clearing only, with source availability time.',cash:'Actual processor movements are independent of GL posting. Payouts move available processor funds to the operating bank; topups use unreserved operating-bank funds. Both retain bank receipts.',refunds:'Cancellation permits admission and sourced admission tax to the original route, excluding earned service fees. New processor-funded refunds reserve and spend only processor funds; existing bank-funded records retain their original behavior.',limits:['USD only','one full capture or void per order','fixed signed refund policy','source tax amounts, no inferred statutory rates','observed payout/topup facts, no initiation or automated payout membership']},
        systems: systemCatalog, actions: Object.keys(providers), controller_actions: [...controllerActions], normalized_api: '/api/worlds/:world/records?system=:system&feed=:feed', provider_base: '/providers/:system/worlds/:world', provider_contracts:providerContracts,provider_routes:{...providerRouteCatalog(),all:['GET /feeds/:feed']}, semantics: 'Synthetic canonical records; normalized ERP projections share economic events. Do not aggregate mirrors as separate companies. Selected provider routes are subsets, not complete vendor implementations.', procurement: { approval: 'Purchase requisition authority and distinct controller PO approval are required', matching: 'Supplier invoices create a payable only after cumulative quantity, receiving, vendor, agreed price and duplicate-reference checks', inventory: 'Whole units and FIFO receipt cost; controller-authorized issues and original-cost issue returns', posting: 'Physical facts are preserved when accounting is unavailable; existing operations post once after recovery' }, exceptions: { actions: actionRequirements, event_replay: 'Controller facts require stable external_event_id; conflicting reuse fails', credit_refunds: 'refund requires credit_note_id for collected invoice payments' }, mail: { limits: MAIL_LIMITS, formats: ['text/plain', 'text/html', 'multipart/alternative', 'multipart/mixed', 'multipart/related'], attachments: 'Stored base64url; scoped text reader at /api/worlds/:world/attachment-content/:message/:attachment; binary extraction is not implemented' }, webhooks: { management: '/api/worlds/:world/webhooks', deliveries: '/api/worlds/:world/webhooks/deliveries', receiver: '/receivers/:world', delivery: 'Signed transactional outbox; at least once; durable retry and dead-letter; controller may explicitly retry', signature: 'HMAC-SHA256 of timestamp.rawBody', destination: 'Literal 127.0.0.1 HTTP; service port and explicitly configured extra ports only' }, oauth: { flow: 'authorization_code', pkce: 'S256 required', token_ttl_seconds: 3600, refresh_rotation: true }, persistence: 'SQLite WAL, synchronous FULL, atomic domain actions, hash-chained redacted audit' });
    }
    throw new ServiceError(404, 'not_found');
  }
  async function handler(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID(), started = performance.now(), url = new URL(request.url);
    let actor: Actor | undefined, response: Response, requestBody: any, world = url.pathname.match(/\/(?:worlds|receivers)\/([^/]+)/)?.[1] ?? '_service';
    try {
      if (url.origin !== baseUrl || (request.headers.get('host') && request.headers.get('host') !== new URL(baseUrl).host)) throw new ServiceError(403, 'invalid_host');
      if(url.pathname.includes('//'))throw new ServiceError(400,'invalid_path','Repeated path separators are not supported');
      const origin = request.headers.get('origin');
      if (origin && origin !== baseUrl) throw new ServiceError(403, 'cross_origin_request_denied');
      const fetchSite = request.headers.get('sec-fetch-site');
      if (fetchSite === 'cross-site' && !(request.method === 'GET' && url.pathname === '/' && request.headers.get('sec-fetch-mode') === 'navigate')) throw new ServiceError(403, 'cross_site_request_denied');
      actor = actorFor(request);
      if (!['GET', 'HEAD'].includes(request.method)){requestBody=await body(request.clone());actor=currentActor(request,actor);}
      response = await dispatch(request, actor, requestId);
    } catch (error: any) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      response = json({ error: { code: error.code ?? 'internal_error', message: status === 500 ? 'Internal service error; inspect the local audit.' : error.message }, request_id: requestId }, status);
      if (status === 500) store.audit(world, 'service.error', { name: error.name, message: String(error.message) }, actor?.id, requestId);
    }
    if (!['/', '/app.js', '/app.css', '/health'].includes(url.pathname)) {
      const query = Object.fromEntries(url.searchParams);
      let responseBody:any=url.pathname.includes('/audit')?{audit_read:true}:response.headers.get('content-type')?.includes('application/json')?await response.clone().json().catch(()=>null):{content_type:response.headers.get('content-type')};
      if(url.pathname.startsWith('/providers/')&&!response.headers.get('content-type')?.includes('application/json')){const bytes=Buffer.from(await response.clone().arrayBuffer());responseBody={...responseBody,byte_length:bytes.length,sha256:hash(bytes),etag:response.headers.get('etag')};}
      if(url.pathname==='/api/generate')requestBody={provider:requestBody?.provider??defaultGeneratorProvider(),...(typeof requestBody?.prompt==='string'?{prompt_sha256:hash(requestBody.prompt),prompt_chars:requestBody.prompt.length}:{})};
      store.audit(world, 'http.request', { method: request.method, path: url.pathname, run_id: actor?.runId, query, body: requestBody, status: response.status, response: responseBody, duration_ms: Math.round(performance.now() - started) }, actor?.id ?? 'anonymous', requestId);
    }
    const headers = new Headers(response.headers);
    headers.set('X-Request-Id', requestId); headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'same-origin'); headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (response.status === 429 || response.status === 503) headers.set('Retry-After', '5');
    return new Response(response.body, { status: response.status, headers });
  }
  const definition = defineEmulator({ name: 'finance-world', state: () => ({ schema_version: 1 }), setup({ app }) { app.use('*', c => handler(c.req.raw)); } });
  const runtime = await createEmulator({ service: definition, listen: false, inspector: false, baseUrl });
  const abortWork = () => { if (deliveryTimer) clearInterval(deliveryTimer); if (seatTimer) clearInterval(seatTimer); slack?.stop(); for (const w of workers.values()) w.abort.abort(); for (const a of generations.values()) a.abort.abort(); };
  return { fetch: runtime.fetch.bind(runtime), store, oauth, hooks, baseUrl, abortWork, seatTick, workCommand, seatStatus, launchRun, slack, async close() { abortWork(); await hooks.close(); await Promise.allSettled([...workers.values(),...generations.values()].map(w => w.promise)); await runtime.close(); store.close(); } };
}

export async function startServer(options: ServiceOptions & { port?: number } = {}) {
  const port = options.port ?? Number(process.env.FINANCE_WORLD_PORT ?? 24300);
  let service: Awaited<ReturnType<typeof createService>>;
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const server = Bun.serve({
    hostname: '127.0.0.1', port, maxRequestBodySize: 1_048_576,
    // Scenario generation may take several minutes; the SDK enforces its own deadline.
    idleTimeout: 255,
    async fetch(request, server) {
      if (new URL(request.url).pathname === '/api/generate') server.timeout(request, 0);
      await ready; return service.fetch(request);
    },
    error() { return json({ error: { code: 'transport_error' } }, 500); },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  try { service = await createService({ ...options, baseUrl }); markReady(); }
  catch (error) { markReady(); await server.stop(true); throw error; }
  let closed = false;
  return { ...service, async close() {
    if (closed) return; closed = true;
    service.abortWork(); await service.hooks.close();
    await server.stop(true); await service.close();
  } };
}
if (import.meta.main) {
  mkdirSync(resolve(root, 'data'), { recursive: true, mode: 0o700 });
  const webhookPorts = process.env.FINANCE_WORLD_WEBHOOK_PORTS?.split(',').map(p => Number(p.trim()));
  const service = await startServer({ database: process.env.FINANCE_WORLD_DB, webhookPorts });
  console.log(JSON.stringify({ service: 'finance-world', url: service.baseUrl, synthetic: true, agent: loadAgentConfig() }));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { if (!stopping) { stopping = true; void service.close(); } });
}

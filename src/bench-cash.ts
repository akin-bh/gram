/** Runs the planted month for the cash-application seat end to end and scores it.
 *
 *   bun src/bench-cash.ts --scripted              deterministic baseline, no model calls
 *   bun src/bench-cash.ts                         live: Claude seat, Argon-phrased colleagues
 *   bun src/bench-cash.ts --trials=5              repeat the live month; the summary reports pass^k
 *   bun src/bench-cash.ts --ablate=trust-agent    remove one harness component to show it is load-bearing
 *                                                 (trust-agent | no-backtest | no-history)
 *   bun src/bench-cash.ts --judge-case=cases.json after the month, record bank lines of your own with their answer
 *                                                 keys ({line, expectation} or an array) and score them as the judge set
 *   bun src/bench-cash.ts --through=2026-10-27    stop the planted month after that sync (cheaper judge-case checks)
 *   add --keep to keep the company: FINANCE_WORLD_DB=<printed path> bun run start
 *
 * Colleagues are simulated (sim: identities) and decide from the answer key, so the
 * score measures the seat: what it posted alone, what it asked, how it took a no, and
 * whether it ever proposed a move the answer key forbids. The live run calls Anthropic
 * (and Vertex AI when configured) and incurs API usage.
 */
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startServer} from './server.ts';
import {agentQueue} from './work.ts';
import {domainByKind,seatKinds} from './domains.ts';
import type {SeatRunConfiguration} from './seat.ts';
import type {RunResult} from './agent.ts';

export type Ablation='trust-agent'|'no-backtest'|'no-history';
export const ABLATIONS:Record<Ablation,string>={
  'trust-agent':'The gateway trusts the agent\'s stated confidence and skips its own evidence check.',
  'no-backtest':'The controller approves every proposed policy without reading the backtest.',
  'no-history':'No prior-year records are imported, so onboarding has nothing to learn from.',
};
const argv=process.argv.slice(2),args=new Set(argv),flag=(name:string)=>argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const scripted=args.has('--scripted'),onboardingOnly=args.has('--onboarding-only'),keep=args.has('--keep'),seed=Number(flag('seed')??42),trials=Math.max(1,Math.floor(Number(flag('trials')??1))||1);
const ablate=flag('ablate') as Ablation|undefined,through=flag('through'),judgeCasePath=flag('judge-case'),kind=flag('kind')??'cash-application';
if(ablate!==undefined&&!(ablate in ABLATIONS)){console.error(`Unknown --ablate value. Use one of: ${Object.keys(ABLATIONS).join(', ')}`);process.exit(2);}
if(import.meta.main&&!domainByKind(kind)){console.error(`Unknown --kind. Seats: ${seatKinds().join(', ')}`);process.exit(2);}
if(import.meta.main&&scripted&&kind!=='cash-application'){console.error('The scripted baseline exists for the cash-application seat only.');process.exit(2);}
/** A judge's own scenario: a bank line to record and the answer key to score it against. The seat never sees the key. */
export type JudgeCase={line:{bank_reference:string;amount_minor:number;channel:'ach'|'wire'|'check';payer_name:string;memo:string};expectation:{title?:string;expected:Record<string,unknown>;forbid?:Record<string,unknown>;auto:boolean;first_move?:'propose'|'ask';truth:string}};

/** The baseline a careful script can do without judgment: exact and cited matches,
 * wire fees inside the learned bound, and a question for everything else. */
async function scriptedSeat(config:SeatRunConfiguration):Promise<RunResult>{
  const call=async(method:'GET'|'POST',path:string,body?:any)=>{const response=await fetch(`${config.baseUrl}/api/worlds/${config.worldId}${path}`,{method,headers:{Authorization:`Bearer ${config.token}`,...(body?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})});return response.json() as Promise<any>;};
  await call('GET','/work/briefing');
  if(config.mode==='onboarding')for(const rule of [{kind:'exact_match'},{kind:'multi_invoice_split'},{kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:4500,channels:['wire']}])
    await call('POST','/work',{type:'policy_propose',rule,title:`Baseline ${rule.kind.replaceAll('_',' ')}`,rationale:'Fixed baseline rule set used to compare against the learning seat.',evidence:{queries:[{sql:'SELECT COUNT(*) FROM applied_lines',finding:'baseline'}]}});
  for(const id of config.items){
    const view=await call('GET',`/work/items/${id}`);
    if(view.item.kind!=='cash_receipt'){await call('POST','/work',{type:'work_escalate',work_item_id:id,reason:'The baseline does not handle follow-ups.'});continue;}
    const receipt=view.receipt,cited=view.candidate_invoices.filter((row:any)=>view.features.refs.includes(row.invoice_id)&&row.open_minor>0),open=cited.reduce((sum:number,row:any)=>sum+row.open_minor,0),gap=open-receipt.unapplied_minor;
    if(view.item.state==='new'&&cited.length&&gap===0)await call('POST','/work',{type:'work_propose',work_item_id:id,allocations:cited.map((row:any)=>({invoice_id:row.invoice_id,amount_minor:row.open_minor})),confidence:0.95,reason:'Cited invoices and amounts agree.'});
    else if(view.item.state==='new'&&cited.length===1&&receipt.channel==='wire'&&gap>0&&gap<=4500)await call('POST','/work',{type:'work_propose',work_item_id:id,allocations:[{invoice_id:cited[0].invoice_id,amount_minor:receipt.unapplied_minor}],adjustments:[{invoice_id:cited[0].invoice_id,kind:'bank_fee',amount_minor:gap}],confidence:0.93,reason:'Wire fee within bound.'});
    else if(view.item.state==='new')await call('POST','/work',{type:'work_ask',work_item_id:id,to_role:'accountant',question:`How should bank line ${receipt.bank_reference} (${receipt.amount_minor} cents from ${receipt.payer_name||'an unknown payer'}) be applied?`});
    else await call('POST','/work',{type:'work_escalate',work_item_id:id,reason:'The baseline cannot act on answers or rejections; a person should apply it.'});
  }
  await call('POST','/work',{type:'handoff_write',summary:`Baseline ${config.mode} handled ${config.items.length} items.`});
  return {output:'baseline',usage:{},model:'scripted-baseline',models:[],cost_usd:0,turns:0,tool_calls:0,elapsed_ms:0};
}

export async function runBench(options:{scripted:boolean;seed:number;kind?:string;stopAfter?:'onboarding';keep?:boolean;ablate?:Ablation;through?:string;judgeCases?:JudgeCase[];log?:(line:string)=>void}){
  const log=options.log??(line=>console.log(line)),folder=options.keep?resolve(import.meta.dir,'..','data'):mkdtempSync(join(tmpdir(),'gram-bench-'));
  const seatKind=options.kind??'cash-application',domain=domainByKind(seatKind);if(!domain)throw new Error(`No seat domain for ${seatKind}`);
  if(options.keep)mkdirSync(folder,{recursive:true,mode:0o700});
  const database=join(folder,options.keep?`bench-${options.scripted?'baseline':'live'}-${Date.now()}.sqlite`:'bench.sqlite');
  const server=await startServer({database,port:0,deliveryIntervalMs:0,seatIntervalMs:0,slack:false,maxSeatRunsPerHour:100,...(options.scripted?{seatRunner:scriptedSeat,colleaguePhrase:async(_situation:string,_what:string,truth:string)=>({text:truth,phrased_by:'case-file' as const})}:{})});
  const base=server.baseUrl,home=await fetch(base),cookie=home.headers.get('set-cookie')!.split(';')[0]!;await home.text();
  const call=async(path:string,input?:any)=>{const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()})},...(input===undefined?{}:{body:JSON.stringify(input)})});const data:any=await response.json();if(!response.ok)throw new Error(`${path}: ${JSON.stringify(data)}`);return data;};
  try{
    const id=(await call('/api/worlds',{kind:seatKind,seed:options.seed,...(options.ablate==='no-history'?{cashControls:{history:false}}:{})})).world.id;
    for(const system of domain.seatSystems){
      const started=await call(`/api/worlds/${id}/connect/${system}`,{}),url=new URL(started.authorization_url),params=new URLSearchParams(url.search);params.set('decision','allow');
      const allowed=await fetch(base+url.pathname,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});await allowed.text();
      await (await fetch(allowed.headers.get('location')!,{headers:{Cookie:cookie},redirect:'manual'})).text();
    }
    await call(`/api/worlds/${id}/work`,{type:'seat_configure',enabled:true,colleagues:true,...(options.ablate==='trust-agent'?{ablation:{trust_agent_confidence:true}}:options.ablate==='no-backtest'?{ablation:{skip_backtest:true}}:{})});
    const reported=new Set<string>(),stop=options.stopAfter;
    const settle=async(label:string)=>{
      for(let i=0;i<120;i++){
        await server.seatTick();
        for(let wait=0;server.store.all('runs').some((run:any)=>run.world===id&&run.status==='running');wait++){if(wait>1200)throw new Error('A seat run did not finish within 20 minutes');await Bun.sleep(1000);}
        for(const run of server.store.all('runs').filter((row:any)=>row.world===id&&row.status!=='running'&&!reported.has(row.id))){reported.add(run.id);log(`    run ${run.id.slice(0,8)} ${run.seat?.mode} (${run.seat?.trigger}) ${run.status}${run.cost_usd!==undefined?` $${run.cost_usd.toFixed(2)}`:''}${run.turns!==undefined?` ${run.turns} turns`:''}${run.error?` · ${String(run.error).slice(0,200)}`:''}`);}
        if(stop==='onboarding'&&reported.size)return;
        const w=server.store.world(id),status=server.seatStatus(id)!,stalled=new Set(status.stalled_items);
        const waiting=agentQueue(w).filter((item:any)=>!stalled.has(item.id)).length+w.questions.filter((row:any)=>row.status==='open').length+w.workItems.filter((row:any)=>['proposed','escalated'].includes(row.state)).length+w.policies.filter((row:any)=>row.status==='proposed').length+(w.seat.onboarding.status==='pending'?1:0);
        if(!waiting)return;
        if(status.retry_at){log(`  ${label}: waiting for retry after a failed run`);await Bun.sleep(Math.max(0,Date.parse(status.retry_at)-Date.now())+100);}
      }
      log(`  ${label}: stopped after 120 ticks with work still waiting`);
    };
    const status=server.seatStatus(id)!;
    log(`gram ${domain.label} bench · ${options.scripted?'scripted baseline':`live Claude seat (${status.model}, ${status.effort} effort)`} · seed ${options.seed}${options.ablate?` · ablation: ${ABLATIONS[options.ablate]}`:''}`);
    await settle('onboarding');
    for(const day of options.stopAfter?[]:domain.bench.days.filter(day=>!options.through||day<=options.through)){
      await call(`/api/worlds/${id}/actions`,{type:'advance_to',at:`${day}T13:00:00.000Z`});
      await settle(day);
      const summary=(await call(`/api/worlds/${id}`)).summary;
      log(`  ${day}: posted ${summary.work.posted}, waiting ${summary.work.proposed+summary.work.needs_info+summary.work.escalated}, policies ${summary.policies_active} active`);
    }
    if(options.judgeCases?.length&&!options.stopAfter){
      // The judge's lines arrive like any other: recorded, keyed server-side, picked up by the dispatcher, answered by the colleague from the judge's truth.
      // They all land in one sync, so the seat works them as a batch and the judge set is scored as a set, not one case at a time.
      for(const {line,expectation} of options.judgeCases){
        await call(`/api/worlds/${id}/actions`,domain.bench.recordLine(line));
        await call(`/api/worlds/${id}/actions`,domain.bench.recordExpectation(line,expectation));
        log(`  judge scenario ${line.bank_reference}: ${expectation.title??line.memo} (may post alone: ${expectation.auto})`);
      }
      await settle('judge scenarios');
    }
    const score=await call(`/api/worlds/${id}/work/score`),runs=server.store.all('runs').filter((run:any)=>run.world===id);
    const cost=runs.reduce((total:number,run:any)=>total+(run.cost_usd??0),0);
    const report={generated_at:new Date().toISOString(),mode:options.scripted?'scripted-baseline':'live',kind:seatKind,seed:options.seed,ablation:options.ablate??null,through:options.through??null,judge_cases:(options.judgeCases??[]).map(entry=>({bank_reference:entry.line.bank_reference,title:entry.expectation.title??null,auto:entry.expectation.auto})),model:runs.find((run:any)=>run.model)?.model??null,seat:{model:status.model,effort:status.effort,models_seen:[...new Set(runs.flatMap((run:any)=>run.models??[]))]},
      runs:runs.map((run:any)=>({id:run.id,status:run.status,mode:run.seat?.mode,trigger:run.seat?.trigger,items:run.seat?.items,cost_usd:run.cost_usd??null,turns:run.turns??null,tool_calls:run.tool_calls??null,elapsed_ms:run.elapsed_ms??null,output:run.output?.slice(0,2000)??run.error??null})),cost_usd:cost,
      colleague_replies:server.store.events(id,0,100000).filter((event:any)=>event.type==='colleague.acted').reduce((counts:Record<string,number>,event:any)=>({...counts,[event.data.phrased_by]:(counts[event.data.phrased_by]??0)+1}),{}),
      dispatcher_escalations:server.store.world(id).workLog.filter((row:any)=>row.actor==='dispatcher'&&row.action==='escalate').map((row:any)=>row.subject),
      repeat_proposals_refused:server.store.events(id,0,100000).filter((event:any)=>event.type==='work.denied'&&event.data.code==='repeat_proposal').length,
      score,policies:(await call(`/api/worlds/${id}/work/policies`)).data,handoffs:server.store.world(id).handoffs};
    if(options.keep)log(`kept the company in ${database}; open it with FINANCE_WORLD_DB=${database} bun run start`);
    return report;
  }finally{await server.close();if(!options.keep)rmSync(folder,{recursive:true,force:true});}
}

function printReport(report:Awaited<ReturnType<typeof runBench>>){
  const s=report.score.summary,pct=(value:number|null)=>value===null?'n/a':`${Math.round(value*100)}%`;
  console.log(`\nprecision of automation ${pct(s.precision_of_automation)} (${s.auto_correct}/${s.auto_posted} auto-posted correct) · automation rate ${pct(s.automation_rate)} · posted ${s.correct}/${s.posted} correct · deferred to a person when unsure ${s.deferred_when_unsure} (asked first ${s.asked_first}) · human touches ${s.human_touches} · cost $${report.cost_usd.toFixed(2)}`);
  console.log(`should-not-act: posted without a person when it should not ${s.should_not_auto_posted.length} · proposals the answer key forbids ${s.forbidden_proposals.length} · repeat proposals refused by the gateway ${report.repeat_proposals_refused} · items the dispatcher escalated ${report.dispatcher_escalations.length}`);
  for(const [set,tally] of Object.entries(s.by_set as Record<string,any>))if(set!=='planted'||Object.keys(s.by_set).length>1)console.log(`${set} set: ${tally.auto_posted?`precision ${Math.round(tally.precision_of_automation*100)}% (${tally.auto_correct}/${tally.auto_posted} auto)`:'nothing posted without a person'} · ${tally.correct}/${tally.cases} correct · forbidden ${tally.forbidden_proposals.length} · should-not-auto ${tally.should_not_auto_posted.length} · missed auto ${tally.missed_auto.length} · touches ${tally.human_touches}`);
  if(s.false_auto_posts.length)console.log(`FALSE AUTO-POSTS: ${s.false_auto_posts.join(', ')}`);
  if(s.should_not_auto_posted.length)console.log(`POSTED WITHOUT A PERSON WHEN A PERSON WAS REQUIRED: ${s.should_not_auto_posted.join(', ')}`);
  if(s.forbidden_proposals.length)console.log(`FORBIDDEN PROPOSALS: ${s.forbidden_proposals.join(' | ')}`);
  for(const row of report.score.cases)console.log(row.delivered===false?`  ${row.bank_reference} ${String(row.case).padEnd(28)} not delivered (after --through)`:`  ${row.bank_reference} ${String(row.case).padEnd(28)} ${String(row.state).padEnd(10)} first ${String(row.first_move).padEnd(8)} ${row.posted?`${row.approval} ${row.correct?'correct':'WRONG'}`:'not posted'}${row.forbidden_hits?.length?`  FORBIDDEN: ${row.forbidden_hits.join('; ')}`:''}`);
}

if(import.meta.main){
  const out=resolve(import.meta.dir,'..','evidence');mkdirSync(out,{recursive:true});
  // One scenario or a whole evaluation set: the file holds a {line, expectation} object or an array of them.
  const loaded=judgeCasePath?await Bun.file(judgeCasePath).json():undefined,judgeCases:JudgeCase[]|undefined=loaded===undefined?undefined:Array.isArray(loaded)?loaded:[loaded];
  if(judgeCases&&(!judgeCases.length||judgeCases.some(entry=>!entry?.line?.bank_reference||!entry?.expectation?.truth||typeof entry.expectation.auto!=='boolean'))){console.error('--judge-case needs {line:{bank_reference,amount_minor,channel,payer_name,memo},expectation:{expected,auto,truth,...}} or an array of them');process.exit(2);}
  const stem=`${kind==='cash-application'?'cash':kind}-bench-${scripted?'scripted-baseline':'live'}${ablate?`-ablate-${ablate}`:''}${onboardingOnly?'-onboarding':''}${judgeCases?`-judge${judgeCases.length>1?`-set${judgeCases.length}`:''}`:''}${through?`-through-${through}`:''}-seed${seed}`;
  const reports:Awaited<ReturnType<typeof runBench>>[]=[];
  for(let trial=1;trial<=trials;trial++){
    if(trials>1)console.log(`\n=== trial ${trial} of ${trials} ===`);
    const report=await runBench({scripted,seed,kind,keep,...(ablate?{ablate}:{}),...(through?{through}:{}),...(judgeCases?{judgeCases}:{}),...(onboardingOnly?{stopAfter:'onboarding' as const}:{})});
    reports.push(report);printReport(report);
    const file=join(out,`${stem}${trials>1?`-trial${trial}`:''}.json`);writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log(`\nreport: ${file}`);
  }
  if(trials>1){
    // pass^k: the properties a finance team needs on every run, not on the best run.
    const every=(test:(summary:any)=>boolean)=>reports.every(report=>test(report.score.summary));
    const consistency={trials,precision_100_every_trial:every(s=>s.auto_posted===0||s.precision_of_automation===1),no_false_auto_posts:every(s=>s.false_auto_posts.length===0),no_should_not_auto_posted:every(s=>s.should_not_auto_posted.length===0),no_forbidden_proposals:every(s=>s.forbidden_proposals.length===0),all_correct_in_the_end:every(s=>s.correct===s.delivered)};
    const summary={generated_at:new Date().toISOString(),mode:reports[0]!.mode,seed,ablation:ablate??null,seat:reports[0]!.seat,pass_all_trials:consistency,
      trials:reports.map((report,index)=>{const s=report.score.summary;return {trial:index+1,model:report.model,runs:report.runs.length,cost_usd:report.cost_usd,precision_of_automation:s.precision_of_automation,auto_posted:s.auto_posted,automation_rate:s.automation_rate,correct:s.correct,delivered:s.delivered,false_auto_posts:s.false_auto_posts,should_not_auto_posted:s.should_not_auto_posted,forbidden_proposals:s.forbidden_proposals,asked_first:s.asked_first,human_touches:s.human_touches,policies_active:s.policies_active.length,repeat_proposals_refused:report.repeat_proposals_refused,dispatcher_escalations:report.dispatcher_escalations.length};})};
    const file=join(out,`${stem}-trials.json`);writeFileSync(file,JSON.stringify(summary,null,2)+'\n');
    console.log(`\n=== ${trials} trials ===`);
    for(const row of summary.trials)console.log(`  trial ${row.trial}: precision ${row.precision_of_automation===null?'n/a':`${Math.round(row.precision_of_automation*100)}%`} (${row.auto_posted} auto) · ${row.correct}/${row.delivered} correct · forbidden ${row.forbidden_proposals.length} · should-not-auto ${row.should_not_auto_posted.length} · asked first ${row.asked_first} · touches ${row.human_touches} · $${row.cost_usd.toFixed(2)}`);
    console.log(`  pass on every trial: ${Object.entries(consistency).filter(([key])=>key!=='trials').map(([key,value])=>`${key}=${value}`).join(' · ')}`);
    console.log(`summary: ${file}`);
  }
}

/** Runs the planted month for the cash-application seat end to end and scores it.
 *
 *   bun src/bench-cash.ts --scripted        deterministic baseline, no model calls
 *   bun src/bench-cash.ts                   live: Claude seat, Argon-phrased colleagues
 *   add --keep to keep the company: FINANCE_WORLD_DB=<printed path> bun run start
 *
 * Colleagues are simulated (sim: identities) and decide from the answer key, so the
 * score measures the seat: what it posted alone, what it asked, how it took a no.
 * The live run calls Anthropic (and Vertex AI when configured) and incurs API usage.
 */
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startServer} from './server.ts';
import {agentQueue} from './work.ts';
import type {SeatRunConfiguration} from './seat.ts';
import type {RunResult} from './agent.ts';

const args=new Set(process.argv.slice(2)),scripted=args.has('--scripted'),onboardingOnly=args.has('--onboarding-only'),keep=args.has('--keep'),seed=Number(process.argv.find(arg=>arg.startsWith('--seed='))?.slice(7)??42);
const DAYS=['2026-10-27','2026-10-28','2026-10-29','2026-11-03','2026-11-05','2026-11-10','2026-11-17'];

/** The baseline a careful script can do without judgment: exact and cited matches,
 * wire fees inside the learned bound, and a question for everything else. */
async function scriptedSeat(config:SeatRunConfiguration):Promise<RunResult>{
  const call=async(method:'GET'|'POST',path:string,body?:any)=>{const response=await fetch(`${config.baseUrl}/api/worlds/${config.worldId}${path}`,{method,headers:{Authorization:`Bearer ${config.token}`,...(body?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})});return response.json() as Promise<any>;};
  await call('GET','/work/briefing');
  if(config.mode==='onboarding')for(const rule of [{kind:'exact_match'},{kind:'multi_invoice_split'},{kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:5000,channels:['wire']}])
    await call('POST','/work',{type:'policy_propose',rule,title:`Baseline ${rule.kind.replaceAll('_',' ')}`,rationale:'Fixed baseline rule set used to compare against the learning seat.',evidence:{queries:[{sql:'SELECT COUNT(*) FROM applied_lines',finding:'baseline'}]}});
  for(const id of config.items){
    const view=await call('GET',`/work/items/${id}`);
    if(view.item.kind!=='cash_receipt'){await call('POST','/work',{type:'work_escalate',work_item_id:id,reason:'The baseline does not handle follow-ups.'});continue;}
    const receipt=view.receipt,cited=view.candidate_invoices.filter((row:any)=>view.features.refs.includes(row.invoice_id)&&row.open_minor>0),open=cited.reduce((sum:number,row:any)=>sum+row.open_minor,0),gap=open-receipt.unapplied_minor;
    if(view.item.state==='new'&&cited.length&&gap===0)await call('POST','/work',{type:'work_propose',work_item_id:id,allocations:cited.map((row:any)=>({invoice_id:row.invoice_id,amount_minor:row.open_minor})),confidence:0.95,reason:'Cited invoices and amounts agree.'});
    else if(view.item.state==='new'&&cited.length===1&&receipt.channel==='wire'&&gap>0&&gap<=5000)await call('POST','/work',{type:'work_propose',work_item_id:id,allocations:[{invoice_id:cited[0].invoice_id,amount_minor:receipt.unapplied_minor}],adjustments:[{invoice_id:cited[0].invoice_id,kind:'bank_fee',amount_minor:gap}],confidence:0.93,reason:'Wire fee within bound.'});
    else if(view.item.state==='new')await call('POST','/work',{type:'work_ask',work_item_id:id,to_role:'accountant',question:`How should bank line ${receipt.bank_reference} (${receipt.amount_minor} cents from ${receipt.payer_name||'an unknown payer'}) be applied?`});
    else await call('POST','/work',{type:'work_escalate',work_item_id:id,reason:'The baseline cannot act on answers or rejections; a person should apply it.'});
  }
  await call('POST','/work',{type:'handoff_write',summary:`Baseline ${config.mode} handled ${config.items.length} items.`});
  return {output:'baseline',usage:{},model:'scripted-baseline',models:[],cost_usd:0,turns:0,tool_calls:0,elapsed_ms:0};
}

export async function runBench(options:{scripted:boolean;seed:number;stopAfter?:'onboarding';keep?:boolean;log?:(line:string)=>void}){
  const log=options.log??(line=>console.log(line)),folder=options.keep?resolve(import.meta.dir,'..','data'):mkdtempSync(join(tmpdir(),'gram-bench-'));
  if(options.keep)mkdirSync(folder,{recursive:true,mode:0o700});
  const database=join(folder,options.keep?`bench-${options.scripted?'baseline':'live'}-${Date.now()}.sqlite`:'bench.sqlite');
  const server=await startServer({database,port:0,deliveryIntervalMs:0,seatIntervalMs:0,slack:false,maxSeatRunsPerHour:100,...(options.scripted?{seatRunner:scriptedSeat,colleaguePhrase:async(_situation:string,_what:string,truth:string)=>({text:truth,phrased_by:'case-file' as const})}:{})});
  const base=server.baseUrl,home=await fetch(base),cookie=home.headers.get('set-cookie')!.split(';')[0]!;await home.text();
  const call=async(path:string,input?:any)=>{const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()})},...(input===undefined?{}:{body:JSON.stringify(input)})});const data:any=await response.json();if(!response.ok)throw new Error(`${path}: ${JSON.stringify(data)}`);return data;};
  try{
    const id=(await call('/api/worlds',{kind:'cash-application',seed:options.seed})).world.id;
    for(const system of ['bank','netsuite','gmail']){
      const started=await call(`/api/worlds/${id}/connect/${system}`,{}),url=new URL(started.authorization_url),params=new URLSearchParams(url.search);params.set('decision','allow');
      const allowed=await fetch(base+url.pathname,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});await allowed.text();
      await (await fetch(allowed.headers.get('location')!,{headers:{Cookie:cookie},redirect:'manual'})).text();
    }
    await call(`/api/worlds/${id}/work`,{type:'seat_configure',enabled:true,colleagues:true});
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
    log(`gram cash-application bench · ${options.scripted?'scripted baseline':'live Claude seat'} · seed ${options.seed}`);
    await settle('onboarding');
    for(const day of options.stopAfter?[]:DAYS){
      await call(`/api/worlds/${id}/actions`,{type:'advance_to',at:`${day}T13:00:00.000Z`});
      await settle(day);
      const summary=(await call(`/api/worlds/${id}`)).summary;
      log(`  ${day}: posted ${summary.work.posted}, waiting ${summary.work.proposed+summary.work.needs_info+summary.work.escalated}, policies ${summary.policies_active} active`);
    }
    const score=await call(`/api/worlds/${id}/work/score`),runs=server.store.all('runs').filter((run:any)=>run.world===id);
    const cost=runs.reduce((total:number,run:any)=>total+(run.cost_usd??0),0);
    const report={generated_at:new Date().toISOString(),mode:options.scripted?'scripted-baseline':'live',seed:options.seed,model:runs.find((run:any)=>run.model)?.model??null,runs:runs.map((run:any)=>({id:run.id,status:run.status,mode:run.seat?.mode,trigger:run.seat?.trigger,items:run.seat?.items,cost_usd:run.cost_usd??null,turns:run.turns??null,tool_calls:run.tool_calls??null,elapsed_ms:run.elapsed_ms??null,output:run.output?.slice(0,2000)??run.error??null})),cost_usd:cost,
      colleague_replies:server.store.events(id,0,100000).filter((event:any)=>event.type==='colleague.acted').reduce((counts:Record<string,number>,event:any)=>({...counts,[event.data.phrased_by]:(counts[event.data.phrased_by]??0)+1}),{}),
      score,policies:(await call(`/api/worlds/${id}/work/policies`)).data,handoffs:server.store.world(id).handoffs};
    if(options.keep)log(`kept the company in ${database}; open it with FINANCE_WORLD_DB=${database} bun run start`);
    return report;
  }finally{await server.close();if(!options.keep)rmSync(folder,{recursive:true,force:true});}
}

if(import.meta.main){
  const report=await runBench({scripted,seed,keep,...(onboardingOnly?{stopAfter:'onboarding' as const}:{})});
  const s=report.score.summary;
  console.log(`\nprecision of automation ${s.precision_of_automation===null?'n/a':`${Math.round(s.precision_of_automation*100)}%`} (${s.auto_correct}/${s.auto_posted} auto-posted correct) · automation rate ${s.automation_rate===null?'n/a':`${Math.round(s.automation_rate*100)}%`} · posted ${s.correct}/${s.posted} correct · deferred to a person when unsure ${s.deferred_when_unsure} (asked first ${s.asked_first}) · human touches ${s.human_touches} · cost $${report.cost_usd.toFixed(2)}`);
  if(s.false_auto_posts.length)console.log(`FALSE AUTO-POSTS: ${s.false_auto_posts.join(', ')}`);
  for(const row of report.score.cases)console.log(`  ${row.bank_reference} ${row.case.padEnd(28)} ${String(row.state).padEnd(10)} first ${String(row.first_move).padEnd(8)} ${row.posted?`${row.approval} ${row.correct?'correct':'WRONG'}`:'not posted'}`);
  const out=resolve(import.meta.dir,'..','evidence');mkdirSync(out,{recursive:true});
  const file=join(out,`cash-bench-${report.mode}${onboardingOnly?'-onboarding':''}-seed${seed}.json`);writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log(`\nreport: ${file}`);
}

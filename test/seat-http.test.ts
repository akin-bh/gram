import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import type {SeatRunConfiguration} from '../src/seat.ts';

/** A scripted seat with the Claude run's exact surface: the scoped token and the HTTP
 * work API. It proves the loop (feed → work item → dispatcher → seat → gateway) without
 * a model; the live run is recorded separately in evidence/. */
type Script=(call:(method:'GET'|'POST',path:string,body?:any)=>Promise<{status:number;data:any}>,config:SeatRunConfiguration)=>Promise<void>;
const POLICIES=[
  {rule:{kind:'exact_match'},title:'Apply exact referenced payments'},
  {rule:{kind:'multi_invoice_split'},title:'Split payments across cited invoices'},
  {rule:{kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:5000,channels:['wire']},title:'Wire fees up to $50 to bank fees'},
  {rule:{kind:'payer_alias',payer_name:'BRIGHTWATER HOSPITALITY LLC',customer_ids:['cus-copper','cus-brightsocial','cus-dockside']},title:'Brightwater pays for its bars'},
];
const learn:Script=async call=>{
  const history=await call('POST','/work/history',{sql:"SELECT channel, adjustment_account, COUNT(*) AS n, MAX(adjustment_minor) AS max_gap FROM applied_lines WHERE adjustment_minor > 0 GROUP BY 1, 2"});
  expect(history.status,JSON.stringify(history.data)).toBe(200);expect(history.data.rows.some((row:any)=>row.adjustment_account==='bank-fee-expense'&&row.max_gap<=5000)).toBe(true);
  for(const policy of POLICIES){const proposed=await call('POST','/work',{type:'policy_propose',...policy,rationale:'Every comparable case in the imported history was handled this way.',evidence:{queries:[{sql:'SELECT channel, adjustment_account, COUNT(*) FROM applied_lines GROUP BY 1, 2',finding:'Consistent treatment, no contrary cases'}]}});expect(proposed.status,JSON.stringify(proposed.data)).toBe(200);}
};
const apply:Script=async(call,config)=>{
  for(const id of config.items){
    const view=(await call('GET',`/work/items/${id}`)).data,receipt=view.receipt,cited=view.candidate_invoices.filter((row:any)=>view.features.refs.includes(row.invoice_id)&&row.open_minor>0);
    const open=cited.reduce((sum:number,row:any)=>sum+row.open_minor,0),gap=open-receipt.unapplied_minor;
    if(cited.length&&gap===0){await call('POST','/work',{type:'work_propose',work_item_id:id,allocations:cited.map((row:any)=>({invoice_id:row.invoice_id,amount_minor:row.open_minor})),confidence:0.95,reason:'The memo cites these invoices and the amounts agree.'});continue;}
    if(cited.length===1&&receipt.channel==='wire'&&gap>0&&gap<=5000){await call('POST','/work',{type:'work_propose',work_item_id:id,allocations:[{invoice_id:cited[0].invoice_id,amount_minor:receipt.unapplied_minor}],adjustments:[{invoice_id:cited[0].invoice_id,kind:'bank_fee',amount_minor:gap}],confidence:0.93,reason:'Wire short by an intermediary fee within the learned bound.'});continue;}
    if(view.item.state==='answered'){await call('POST','/work',{type:'work_escalate',work_item_id:id,reason:'Answered, but the scripted seat leaves judgment calls to people.'});continue;}
    await call('POST','/work',{type:'work_ask',work_item_id:id,to_role:'accountant',question:`How should ${receipt.payer_name||'this deposit'} for ${receipt.amount_minor} cents be applied?`});
  }
};
async function fixture(script:Script){
  const folder=mkdtempSync(join(tmpdir(),'gram-seat-http-')),runs:SeatRunConfiguration[]=[];
  const server=await startServer({database:join(folder,'world.sqlite'),port:0,agentEnabled:false,deliveryIntervalMs:0,seatIntervalMs:0,seatRunner:async config=>{
    runs.push(config);let calls=0;
    const call=async(method:'GET'|'POST',path:string,body?:any)=>{calls++;const response=await fetch(`${config.baseUrl}/api/worlds/${config.worldId}${path}`,{method,headers:{Authorization:`Bearer ${config.token}`,...(body?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
    expect((await call('GET','/work/briefing')).status).toBe(200);
    if(config.mode==='onboarding')await learn(call,config);
    await script(call,config);
    await call('POST','/work',{type:'handoff_write',summary:`Scripted ${config.mode} run handled ${config.items.length} items.`});
    return {output:'done',usage:{},model:'scripted',models:[],cost_usd:0,turns:1,tool_calls:calls,elapsed_ms:1};
  }});
  const base=server.baseUrl,home=await fetch(base),cookie=home.headers.get('set-cookie')!.split(';')[0]!;await home.text();
  const call=async(path:string,input?:any,token?:string)=>{const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:{Cookie:cookie}),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,data:await response.json()};};
  const connect=async(world:string,system:string)=>{
    const started=await call(`/api/worlds/${world}/connect/${system}`,{}),url=new URL(started.data.authorization_url),params=new URLSearchParams(url.search);params.set('decision','allow');
    const allowed=await fetch(base+url.pathname,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});await allowed.text();
    const callback=await fetch(allowed.headers.get('location')!,{headers:{Cookie:cookie},redirect:'manual'});expect(callback.status).toBe(303);await callback.text();
  };
  const settle=async()=>{for(let i=0;i<200;i++){if(!server.store.all('runs').some((run:any)=>run.status==='running'))return;await Bun.sleep(10);}throw new Error('Seat run did not finish');};
  const tick=async()=>{await server.seatTick();await settle();};
  return {server,call,connect,tick,runs,dispose:async()=>{await server.close();rmSync(folder,{recursive:true,force:true});}};
}

test('nobody starts the seat: it onboards from history, picks up new bank lines, and only people approve',async()=>{
  const f=await fixture(apply);
  try{
    const created=await f.call('/api/worlds',{kind:'cash-application',seed:42});expect(created.status,JSON.stringify(created.data)).toBe(201);
    const id=created.data.world.id;
    expect(created.data.world.cashHistory).toBeUndefined();expect(created.data.world.cashCaseKey).toBeUndefined();expect(created.data.world.cash_history_counts.receipts).toBeGreaterThan(250);
    expect((await f.call(`/api/worlds/${id}/work`,{type:'seat_configure',enabled:true})).status).toBe(200);
    await f.tick();expect(f.runs.length).toBe(0);
    expect((await f.call(`/api/worlds/${id}/work/status`)).data.missing_connections).toStrictEqual(['bank','netsuite','gmail']);
    for(const system of ['bank','netsuite','gmail'])await f.connect(id,system);
    await f.tick();
    expect(f.runs.map(run=>run.mode)).toStrictEqual(['onboarding']);
    let briefing=(await f.call(`/api/worlds/${id}/work/briefing`)).data;
    expect(briefing.seat.onboarding.status).toBe('done');expect(briefing.policies.proposed.length).toBe(4);expect(briefing.last_handoffs[0].summary).toMatch(/onboarding/);
    for(const policy of briefing.policies.proposed)expect((await f.call(`/api/worlds/${id}/work`,{type:'policy_decide',policy_id:policy.id,decision:'approve',reason:'Backtest is clean'})).status).toBe(200);
    await f.tick();expect(f.runs.length).toBe(1);
    // The morning sync brings four lines; the dispatcher launches a shift without anyone asking.
    expect((await f.call(`/api/worlds/${id}/actions`,{type:'advance_time',hours:24})).status).toBe(200);
    await f.tick();
    expect(f.runs.at(-1)!.mode).toBe('shift');expect(f.runs.at(-1)!.items.length).toBe(4);expect(f.runs.at(-1)!.reason).toMatch(/4 new \(bank line\)/);
    const snapshot=(await f.call(`/api/worlds/${id}`)).data;
    expect(snapshot.summary.work).toMatchObject({posted:4,new:0});expect(snapshot.summary.reconciliation.balanced).toBe(true);
    const run=f.server.store.all('runs').at(-1);expect(run.seat).toMatchObject({mode:'shift',trigger:'bank-feed'});expect(run.instruction).toMatch(/^Shift ·/);
    // The seat's token cannot approve, and the denial is in the audit chain.
    const token=crypto.randomUUID();f.server.store.put('agent-tokens',new Bun.CryptoHasher('sha256').update(token).digest('hex'),{world:id,actor:`agent-world:${id}`,expires_at:Date.now()+60_000});
    const attempt=await f.call(`/api/worlds/${id}/work`,{type:'work_decide',work_item_id:'WI-5531',decision:'approve'},token);
    expect(attempt.status).toBe(403);expect(attempt.data.error.code).toBe('work_action_denied');
    expect(f.server.store.events(id,0,2000).some((event:any)=>event.type==='work.denied'&&event.data.action==='work_decide'&&event.actor===`agent-world:${id}`)).toBe(true);
    const why=(await f.call(`/api/worlds/${id}/why?subject=INV-2003`,undefined,token)).data;
    expect(why.timeline.map((row:any)=>row.role)).toStrictEqual(['sync','ai_agent','policy_engine','gateway']);
    // Limits are connections, not prompt text: revoke the bank and the seat cannot read or launch.
    expect((await f.call(`/api/worlds/${id}/connections/bank/revoke`,{})).status).toBe(200);
    expect((await f.call(`/api/worlds/${id}/work/items/WI-5531`,undefined,token)).status).toBe(401);
    expect((await f.call(`/api/worlds/${id}/work/status`)).data.missing_connections).toStrictEqual(['bank']);
  }finally{await f.dispose();}
});

test('an answer from a person wakes the seat; an item it cannot move stops relaunching it',async()=>{
  let idle=false;
  const f=await fixture(async(call,config)=>{if(!idle)await apply(call,config);});
  try{
    const id=(await f.call('/api/worlds',{kind:'cash-application',seed:42})).data.world.id;
    for(const system of ['bank','netsuite','gmail'])await f.connect(id,system);
    await f.call(`/api/worlds/${id}/work`,{type:'seat_configure',enabled:true});await f.tick();
    for(const policy of (await f.call(`/api/worlds/${id}/work/briefing`)).data.policies.proposed)await f.call(`/api/worlds/${id}/work`,{type:'policy_decide',policy_id:policy.id,decision:'approve'});
    await f.call(`/api/worlds/${id}/actions`,{type:'advance_time',hours:48});await f.tick();await f.tick();
    let items=(await f.call(`/api/worlds/${id}/work/items`)).data.data;
    const pine=items.find((row:any)=>row.title.startsWith('PINE AND POST'));expect(pine.state).toBe('needs_info');
    const question=(await f.call(`/api/worlds/${id}/work/items/${pine.id}`)).data.questions[0];
    expect((await f.call(`/api/worlds/${id}/work`,{type:'work_answer',question_id:question.id,answer:'A damaged half-barrel came back. Hold the difference as a deduction pending our credit memo.'})).status).toBe(200);
    const before=f.runs.length;await f.tick();
    expect(f.runs.length).toBe(before+1);expect(f.runs.at(-1)!.items).toContain(pine.id);
    expect(f.server.store.all('runs').at(-1).seat.trigger).toBe('answer');
    items=(await f.call(`/api/worlds/${id}/work/items`)).data.data;expect(items.find((row:any)=>row.id===pine.id).state).toBe('escalated');
    // A run that leaves an item untouched counts against it; after two, the dispatcher stops.
    idle=true;await f.call(`/api/worlds/${id}/actions`,{type:'advance_time',hours:24});
    await f.tick();await f.tick();const stalledRuns=f.runs.length;await f.tick();
    expect(f.runs.length).toBe(stalledRuns);
    const status=(await f.call(`/api/worlds/${id}/work/status`)).data;expect(status.stalled_items.length).toBeGreaterThan(0);
    expect(f.server.store.events(id,0,5000).some((event:any)=>event.type==='seat.item_stalled')).toBe(true);
  }finally{await f.dispose();}
});

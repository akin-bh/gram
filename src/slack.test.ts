import {test,expect} from 'bun:test';
import {createService} from './server.ts';
import {escapeSlack} from './slack.ts';

const base='http://127.0.0.1:24300';
const config={botToken:'xoxb-test',appToken:'xapp-test',channel:'C0AR',teamId:'T0KESTREL',accountants:new Set(['U0DANA']),controllers:new Set(['U0CTRL'])};
async function fixture(kind='cash-application'){
  const calls:{method:string;body:any}[]=[];let ts=1000;
  const transport=(async(url:string,init:any)=>{const method=String(url).split('/').pop()!,body=JSON.parse(init.body);calls.push({method,body});return Response.json({ok:true,channel:body.channel??'C0AR',ts:method==='chat.postMessage'?String(ts++):body.ts});}) as any;
  const service=await createService({database:':memory:',baseUrl:base,agentEnabled:false,seatIntervalMs:0,deliveryIntervalMs:0,slack:{config,transport,connect:false}});
  const page=await service.fetch(new Request(base)),cookie=page.headers.get('set-cookie')!.split(';')[0]!;
  const call=async(path:string,input?:any)=>{const response=await service.fetch(new Request(base+path,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()})},...(input===undefined?{}:{body:JSON.stringify(input)})}));return {status:response.status,data:await response.json()};};
  const id=(await call('/api/worlds',{kind,seed:42})).data.world.id;
  const agent={id:`agent-world:${id}`,role:'agent' as const};
  const seat=(input:any)=>service.workCommand(id,input,agent,crypto.randomUUID(),crypto.randomUUID());
  const block=(user:string,action:string,value:any,message='')=>({type:'interactive',envelope_id:crypto.randomUUID(),payload:{type:'block_actions',team:{id:'T0KESTREL'},user:{id:user},trigger_id:`trigger-${crypto.randomUUID()}`,channel:{id:'C0AR'},message:{ts:message},actions:[{action_id:action,value:JSON.stringify(value)}]}});
  const submit=(user:string,callback:string,meta:any,reason:string)=>({type:'interactive',envelope_id:crypto.randomUUID(),payload:{type:'view_submission',team:{id:'T0KESTREL'},user:{id:user},view:{id:crypto.randomUUID(),callback_id:callback,private_metadata:JSON.stringify(meta),state:{values:{reason:{text:{type:'plain_text_input',value:reason}}}}}}});
  return {service,call,id,seat,calls,block,submit,slack:service.slack!,world:()=>service.store.world(id),close:()=>service.close()};
}

test('cards are drawn from gram state; a person approves in Slack and the card stops taking clicks',async()=>{
  const f=await fixture();
  try{
    expect((await f.call(`/api/worlds/${f.id}/work/slack`)).data).toMatchObject({available:true,binding:{enabled:false}});
    expect((await f.call(`/api/worlds/${f.id}/work/slack`,{enabled:true})).status).toBe(200);
    await f.call(`/api/worlds/${f.id}/actions`,{type:'advance_time',hours:24});
    f.seat({type:'work_propose',work_item_id:'WI-5532',allocations:[{invoice_id:'INV-2003',amount_minor:5797500}],adjustments:[{invoice_id:'INV-2003',kind:'bank_fee',amount_minor:2500}],confidence:0.9,reason:'Wire short by $25; history books these to bank fees.'});
    await f.slack.reconcile(f.id);
    const posted=f.calls.filter(row=>row.method==='chat.postMessage');
    expect(posted.length).toBe(1);expect(posted[0]!.body.channel).toBe('C0AR');
    const text=JSON.stringify(posted[0]!.body.blocks);
    expect(text).toContain('WI-5532');expect(text).toContain('gram_approve');expect(text).toContain('gram_reject');expect(text).toContain('Needs you');expect(text).toContain('no approved policy covers the bank fee');
    const proposal=f.world().workItems.find((row:any)=>row.id==='WI-5532').proposal.id;
    // An unmapped Slack user is refused and the refusal is audited.
    await f.slack.handle(f.block('U0STRANGER','gram_approve',{world:f.id,item:'WI-5532',proposal}));
    expect(f.world().workItems.find((row:any)=>row.id==='WI-5532').state).toBe('proposed');
    expect(f.calls.at(-1)!.method).toBe('chat.postEphemeral');expect(f.calls.at(-1)!.body.text).toMatch(/not mapped/);
    expect(f.service.store.events(f.id,0,5000).some((event:any)=>event.type==='work.denied'&&event.data.code==='slack_user_not_mapped')).toBe(true);
    await f.slack.handle(f.block('U0DANA','gram_approve',{world:f.id,item:'WI-5532',proposal}));
    const item=f.world().workItems.find((row:any)=>row.id==='WI-5532');
    expect(item.state).toBe('posted');expect(item.decision.by).toBe('slack:U0DANA');
    await f.slack.reconcile(f.id);
    const update=f.calls.filter(row=>row.method==='chat.update').at(-1)!;
    expect(update.body.ts).toBe(posted[0]!.body.ts??'1000');expect(JSON.stringify(update.body.blocks)).not.toContain('gram_approve');expect(JSON.stringify(update.body.blocks)).toContain('Approved by <@U0DANA>');
    // A click on the stale card cannot decide anything again.
    await f.slack.handle(f.block('U0DANA','gram_approve',{world:f.id,item:'WI-5532',proposal}));
    expect(f.calls.at(-1)!.body.text??'').toMatch(/out of date/);
    // Auto-posted or console-decided work never reaches Slack.
    expect(f.calls.filter(row=>row.method==='chat.postMessage').length).toBe(1);
  }finally{await f.close();}
});

test('a rejection needs a reason in a modal; a thread reply answers only its own question',async()=>{
  const f=await fixture();
  try{
    await f.call(`/api/worlds/${f.id}/work/slack`,{enabled:true});
    await f.call(`/api/worlds/${f.id}/actions`,{type:'advance_time',hours:48});
    f.seat({type:'work_propose',work_item_id:'WI-5537',allocations:[{invoice_id:'INV-2013',amount_minor:1470000}],adjustments:[{invoice_id:'INV-2013',kind:'early_pay_discount',amount_minor:30000}],confidence:0.7,reason:'Customer took a 2% discount per their terms.'});
    const asked=f.seat({type:'work_ask',work_item_id:'WI-5538',to_role:'accountant',question:'Pine & Post short-paid INV-2014 by $310 with no remittance. Valid deduction or chase?',options:['Chase it','Hold as deduction']});
    await f.slack.reconcile(f.id);
    const proposal=f.world().workItems.find((row:any)=>row.id==='WI-5537').proposal.id;
    await f.slack.handle(f.block('U0DANA','gram_reject',{world:f.id,item:'WI-5537',proposal},'1000'));
    const opened=f.calls.find(row=>row.method==='views.open')!;expect(opened.body.view.callback_id).toBe('gram_reject');
    const meta=JSON.parse(opened.body.view.private_metadata);
    expect(await f.slack.handle(f.submit('U0DANA','gram_reject',meta,'no'))).toMatchObject({response_action:'errors'});
    expect(await f.slack.handle(f.submit('U0DANA','gram_reject',meta,'Paid on day 26; the discount window is 10 days. Apply the cash and chase $300.'))).toBeUndefined();
    const rejected=f.world().workItems.find((row:any)=>row.id==='WI-5537');
    expect(rejected.state).toBe('rejected');expect(rejected.last_rejection).toMatchObject({by:'slack:U0DANA',reason:expect.stringContaining('day 26')});
    expect(await f.slack.handle(f.submit('U0DANA','gram_reject',meta,'Second submission for the same card'))).toMatchObject({response_action:'errors'});
    // Thread replies: a bot, an unmapped person, or another thread do nothing; the mapped AR lead answers.
    const card=f.service.store.all('slack-cards').find((row:any)=>row.key===`question:${asked.result.question.id}`);
    const reply=(user:string,text:string,extra:any={})=>f.slack.handle({type:'events_api',envelope_id:crypto.randomUUID(),payload:{team_id:'T0KESTREL',event_id:`Ev${crypto.randomUUID()}`,event:{type:'message',channel:card.channel,thread_ts:card.ts,user,text,...extra}}});
    await reply('U0DANA','ignored',{bot_id:'B1'});await reply('U0STRANGER','Chase it');
    await f.slack.handle({type:'events_api',payload:{team_id:'T0KESTREL',event_id:'Ev-other',event:{type:'message',channel:'C0AR',thread_ts:'9999',user:'U0DANA',text:'wrong thread'}}});
    expect(f.world().questions.find((row:any)=>row.id===asked.result.question.id).status).toBe('open');
    await reply('U0DANA','They returned a damaged half-barrel; hold the $310 as a deduction pending the credit memo.');
    const question=f.world().questions.find((row:any)=>row.id===asked.result.question.id);
    expect(question).toMatchObject({status:'answered',answered_by:'slack:U0DANA'});
    expect(f.world().workItems.find((row:any)=>row.id==='WI-5538').state).toBe('answered');
    // Policy decisions belong to the controller, in Slack as in the console.
    const policy=f.seat({type:'policy_propose',rule:{kind:'exact_match'},title:'Apply exact referenced payments',rationale:'All 135 comparable receipts last year were applied as billed.',evidence:{queries:[{sql:'SELECT COUNT(*) FROM applied_lines',finding:'135 of 135'}]}}).result.policy;
    await f.slack.reconcile(f.id);
    await f.slack.handle(f.block('U0DANA','gram_policy_approve',{world:f.id,policy:policy.id,version:1}));
    expect(f.world().policies[0].status).toBe('proposed');expect(f.calls.at(-1)!.body.text).toMatch(/refused/);
    await f.slack.handle(f.block('U0CTRL','gram_policy_approve',{world:f.id,policy:policy.id,version:1}));
    expect(f.world().policies[0]).toMatchObject({status:'active',decided_by:'slack:U0CTRL'});
    // Other workspaces and unbound companies are ignored.
    await f.slack.handle({...f.block('U0CTRL','gram_approve',{world:'world-elsewhere',item:'WI-5531',proposal:'P-1'}),payload:{...f.block('U0CTRL','gram_approve',{}).payload,team:{id:'T0OTHER'}}});
    expect(escapeSlack('<!channel> & <https://x|y>')).toBe('&lt;!channel&gt; &amp; &lt;https://x|y&gt;');
  }finally{await f.close();}
});

test('the tour seat posts the same cards in its own currency, and "@gram why" answers from the work log',async()=>{
  const f=await fixture('tour-settlements');
  try{
    await f.call(`/api/worlds/${f.id}/work/slack`,{enabled:true});
    await f.call(`/api/worlds/${f.id}/actions`,{type:'advance_time',hours:24});
    const item=f.world().workItems.find((row:any)=>row.kind==='settlement_deposit');
    f.seat({type:'work_propose',work_item_id:item.id,hold_on_account:true,confidence:0.5,reason:'Two statements, one deposit; holding until the split is confirmed.'});
    await f.slack.reconcile(f.id);
    const posted=f.calls.filter(row=>row.method==='chat.postMessage');
    expect(posted.length).toBe(1);
    const text=JSON.stringify(posted[0]!.body.blocks);
    expect(text).toContain('$');expect(text).toContain('Hold');expect(text).toContain('Settlement Manager');expect(text).not.toContain('invoice_id');expect(text).toContain('the ledger');
    // A mention in the channel is answered in its thread from the append-only log; ids match however they are typed.
    const mention=(text:string,extra:any={})=>f.slack.handle({type:'events_api',envelope_id:crypto.randomUUID(),payload:{team_id:'T0KESTREL',event_id:`Ev${crypto.randomUUID()}`,event:{type:'app_mention',channel:'C0AR',user:'U0DANA',text,ts:'2000',...extra}}});
    await mention(`<@U0BOT> why ${item.id.toLowerCase()}?`);
    const answer=f.calls.at(-1)!;
    expect(answer.method).toBe('chat.postMessage');expect(answer.body.thread_ts).toBe('2000');expect(answer.body.text).toContain(`Why ${item.id}`);expect(answer.body.text).toContain('propose');expect(answer.body.text).toContain('Open in gram');
    expect(f.service.store.events(f.id,0,5000).some((event:any)=>event.type==='slack.explained'&&event.data.subject===item.id)).toBe(true);
    await mention('<@U0BOT> why XX-9999');
    expect(f.calls.at(-1)!.body.text).toMatch(/don't have a record/);
    // A DM asks for status; the reply is the briefing, not a decision.
    await f.slack.handle({type:'events_api',envelope_id:crypto.randomUUID(),payload:{team_id:'T0KESTREL',event_id:`Ev${crypto.randomUUID()}`,event:{type:'message',channel_type:'im',channel:'D0DM',user:'U0DANA',text:'status?',ts:'2001'}}});
    const status=f.calls.at(-1)!;
    expect(status.body.channel).toBe('D0DM');expect(status.body.thread_ts).toBeUndefined();expect(status.body.text).toContain('waiting on people 1');expect(status.body.text).toContain(item.id);
    // The bot's own messages and duplicate event ids are ignored.
    const before=f.calls.length;
    await mention('<@U0BOT> why WI-5531',{bot_id:'B1'});
    expect(f.calls.length).toBe(before);
    expect(f.world().workItems.find((row:any)=>row.id===item.id).state).toBe('proposed');
  }finally{await f.close();}
});

test('rules proposed together are one message the controller approves in one click; people speak in the thread under their names; handoffs stay in gram',async()=>{
  const f=await fixture();
  try{
    await f.call(`/api/worlds/${f.id}/work/slack`,{enabled:true});
    const run={id:`agent-world:${f.id}`,role:'agent' as const,runId:'run-onboarding'};
    const propose=(rule:any,title:string)=>f.service.workCommand(f.id,{type:'policy_propose',rule,title,rationale:'Every comparable case last year was handled this way.',evidence:{queries:[{sql:'SELECT COUNT(*) FROM applied_lines',finding:'all agree'}]}},run as any,crypto.randomUUID(),crypto.randomUUID());
    propose({kind:'exact_match'},'Apply exact referenced payments');propose({kind:'multi_invoice_split'},'Split one payment across cited invoices');propose({kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:4500,channels:['wire']},'Wire fees up to $45');
    f.seat({type:'handoff_write',summary:'Onboarding run: proposed three policies from last year\'s records.'});
    await f.slack.reconcile(f.id);
    const posted=f.calls.filter(row=>row.method==='chat.postMessage');
    expect(posted.length).toBe(1);
    const text=JSON.stringify(posted[0]!.body.blocks);
    expect(text).toContain('3 rules');expect(text).toContain('gram_policies_approve');expect(text).not.toContain('handoff');expect(text).not.toContain('SELECT');
    // The accountant cannot decide policy, in one click or many.
    await f.slack.handle(f.block('U0DANA','gram_policies_approve',{world:f.id,group:'run:run-onboarding'}));
    expect(f.world().policies.filter((row:any)=>row.status==='active').length).toBe(0);expect(f.calls.at(-1)!.body.text).toMatch(/refused/);
    await f.slack.handle(f.block('U0CTRL','gram_policies_approve',{world:f.id,group:'run:run-onboarding'}));
    expect(f.world().policies.every((row:any)=>row.status==='active'&&row.decided_by==='slack:U0CTRL')).toBe(true);
    const update=f.calls.filter(row=>row.method==='chat.update').at(-1)!;
    expect(JSON.stringify(update.body.blocks)).toContain('3 approved');expect(JSON.stringify(update.body.blocks)).not.toContain('gram_policies_approve');
    // A simulated colleague's answer appears in the thread under her own name; the card shows who answered.
    await f.call(`/api/worlds/${f.id}/actions`,{type:'advance_time',hours:48});
    const asked=f.seat({type:'work_ask',work_item_id:'WI-5538',to_role:'accountant',question:'Pine & Post short-paid INV-2014 by $310. Valid deduction or chase?'});
    await f.slack.reconcile(f.id);
    const card=f.service.store.all('slack-cards').find((row:any)=>row.key===`question:${asked.result.question.id}`);
    expect(JSON.stringify(f.calls.filter(row=>row.method==='chat.postMessage').at(-1)!.body.blocks)).toContain('AR lead, the seat asks');
    f.service.workCommand(f.id,{type:'work_answer',question_id:asked.result.question.id,answer:'They returned a damaged half-barrel; hold the $310 pending the credit memo.'},{id:'sim:dana.ruiz',role:'accountant'} as any,crypto.randomUUID(),crypto.randomUUID());
    await f.slack.reconcile(f.id);
    const said=f.calls.filter(row=>row.method==='chat.postMessage').at(-1)!;
    expect(said.body.thread_ts).toBe(card.ts);expect(said.body.username).toContain('Dana Ruiz');expect(said.body.text).toContain('half-barrel');
    expect(JSON.stringify(f.calls.filter(row=>row.method==='chat.update').at(-1)!.body.blocks)).toContain('Answered by Dana Ruiz');
    // Said once: a later redraw does not repeat it.
    const before=f.calls.length;await f.slack.reconcile(f.id);expect(f.calls.length).toBe(before);
  }finally{await f.close();}
});

test('a card nobody touches is nudged in its thread, then handed to the controller by the dispatcher',async()=>{
  const f=await fixture();
  try{
    await f.call(`/api/worlds/${f.id}/work/slack`,{enabled:true});
    await f.call(`/api/worlds/${f.id}/actions`,{type:'advance_time',hours:24});
    f.seat({type:'work_propose',work_item_id:'WI-5532',allocations:[{invoice_id:'INV-2003',amount_minor:5797500}],adjustments:[{invoice_id:'INV-2003',kind:'bank_fee',amount_minor:2500}],confidence:0.9,reason:'Wire short by $25; history books these to bank fees.'});
    await f.slack.reconcile(f.id);
    const start=Date.now(),posts=()=>f.calls.filter(row=>row.method==='chat.postMessage');
    expect(posts().length).toBe(1);
    f.slack.deps.now=()=>start+11*60_000;await f.slack.reconcile(f.id);
    const nudge=posts().at(-1)!;
    expect(posts().length).toBe(2);expect(nudge.body.thread_ts).toBe('1000');expect(nudge.body.text).toContain('<@U0DANA>');expect(nudge.body.text).toContain('WI-5532');
    await f.slack.reconcile(f.id);expect(posts().length).toBe(2); // one nudge, not one per tick
    f.slack.deps.now=()=>start+22*60_000;await f.slack.reconcile(f.id);await f.slack.reconcile(f.id);
    const item=f.world().workItems.find((row:any)=>row.id==='WI-5532');
    expect(item.state).toBe('escalated');expect(item.escalation).toMatchObject({to_role:'controller'});
    expect(f.world().workLog.some((row:any)=>row.subject==='WI-5532'&&row.action==='escalate'&&row.role==='dispatcher')).toBe(true);
    expect(JSON.stringify(posts().at(-1)!.body.blocks)).toContain('Escalated to the Controller');
  }finally{await f.close();}
});

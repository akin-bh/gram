import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {hash} from '../src/store.ts';

async function start(database:string,port=0){
  const server=await startServer({database,port,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  let cookie:string;
  try{const home=await fetch(base,{headers:{Connection:'close'}});assert.equal(home.status,200);cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();}catch(error){await server.close();throw error;}
  const call=async(path:string,input?:any,token?:string,key:string=randomUUID(),anonymous=false)=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:(anonymous?{}:{Cookie:cookie})),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const connect=async(world:string,system:string)=>{
    const started=await call(`/api/worlds/${world}/connect/${system}`,{});assert.equal(started.status,200,JSON.stringify(started.data));const url=new URL(started.data.authorization_url);
    const consent=await fetch(`${base}/oauth/${system}/consent${url.search}`,{headers:{Cookie:cookie}});assert.equal(consent.status,200);const info=await consent.json();assert.equal(info.world,world);assert.equal(info.provider.id,system);assert.deepEqual(info.scopes,['read','write']);
    const params=new URLSearchParams(url.search);params.set('decision','allow');
    const accepted=await fetch(base+url.pathname,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});assert.equal(accepted.status,303);await accepted.text();
    const callback=await fetch(accepted.headers.get('location')!,{headers:{Cookie:cookie},redirect:'manual'});assert.equal(callback.status,303);await callback.text();
  };
  const grant=async(world:string,scope:string)=>{
    const redirect='http://127.0.0.1:9123/reconciliation-callback',client=await call('/api/oauth/clients',{name:'Reconciliation scope verification',redirect_uris:[redirect]});assert.equal(client.status,201);
    const verifier=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
    const form=new URLSearchParams({client_id:client.data.client_id,redirect_uri:redirect,response_type:'code',scope,state:randomUUID(),world_id:world,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
    const accepted=await fetch(base+'/oauth/mercury/authorize',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});assert.equal(accepted.status,303);await accepted.text();
    const code=new URL(accepted.headers.get('location')!).searchParams.get('code');
    const token=await call('/oauth/mercury/token',{grant_type:'authorization_code',client_id:client.data.client_id,redirect_uri:redirect,code,code_verifier:verifier},undefined,randomUUID(),true);assert.equal(token.status,200,JSON.stringify(token.data));return token.data.access_token as string;
  };
  const create=async(input:any={})=>{const created=await call('/api/worlds',{kind:'bank-reconciliation',name:'gram reconciliation verification',seed:31,orderCount:4,...input});assert.equal(created.status,201,JSON.stringify(created.data));return created.data.world;};
  const agent=(world:string)=>{const token=randomUUID();server.store.put('agent-tokens',hash(token),{world,actor:`agent-world:${world}`,expires_at:Date.now()+60000});return token;};
  const act=(world:string,input:any,token?:string,key?:string)=>call(`/api/worlds/${world}/actions`,input,token,key);
  return {server,base,call,connect,grant,create,agent,act,close:()=>server.close()};
}
async function fixture(){const folder=mkdtempSync(join(tmpdir(),'gram-reconciliation-http-')),database=join(folder,'world.sqlite');try{const f=await start(database);return {...f,folder,database,dispose:async()=>{await f.close();rmSync(folder,{recursive:true,force:true});}};}catch(error){rmSync(folder,{recursive:true,force:true});throw error;}}
const okay=(response:any)=>{assert.equal(response.status,200,JSON.stringify(response.data));return response.data.result;};
const financial=(world:any)=>({bankTransactions:world.bankTransactions,journals:world.journals,accounts:world.accounts,operations:world.operations});
const statementInput=(statement:any)=>({source_statement_id:statement.source_statement_id,account_id:statement.account_id,currency:statement.currency,start_at:statement.start_at,end_at:statement.end_at,opening_balance_minor:statement.opening_balance_minor,closing_balance_minor:statement.closing_balance_minor,lines:statement.lines.map((line:any)=>({source_line_id:line.source_line_id,posted_at:line.posted_at,amount_minor:line.amount_minor,source_refs:line.source_refs}))});
function sourceIds(world:any,statement:any,line:any){
  const rows=world.bankTransactions.filter((row:any)=>row.amount_minor!==0&&row.account_id===statement.account_id&&row.posted_at>statement.start_at&&row.posted_at<=statement.end_at&&line.source_refs.some((ref:string)=>[row.id,row.source_id,row.receipt_id].includes(ref)));
  assert.ok(rows.length);assert.equal(rows.reduce((sum:number,row:any)=>sum+row.amount_minor,0),line.amount_minor);return rows.map((row:any)=>row.id);
}
async function matchAll(f:Awaited<ReturnType<typeof start>>,world:any,statement:any,token:string){
  for(const line of statement.lines)okay(await f.act(world.id,{type:'match_statement_line',statement_id:statement.id,line_id:line.id,bank_transaction_ids:sourceIds(world,statement,line)},token));
}
const closeInput=(statement:any,report:any,event:string)=>({type:'close_reconciliation',statement_id:statement.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((item:any)=>item.id),external_event_id:event});

test('reconciliation HTTP authority and real OAuth scopes separate imported bank facts from operator matches',async()=>{
  const f=await fixture();
  try{
    const w=await f.create(),other=await f.create(),statement=w.bankStatements[0],line=statement.lines[0],token=f.agent(w.id),prefix=`/api/worlds/${w.id}`;
    const context=(await f.call(prefix+'/context',undefined,token)).data;
    for(const type of ['match_statement_line','unmatch_statement_line','prepare_reconciliation'])assert.ok(context.available_actions.includes(type));
    for(const type of ['record_bank_statement','replace_bank_statement','close_reconciliation','reopen_reconciliation'])assert.equal((await f.act(w.id,{type,external_event_id:'untrusted-worker'},token)).status,403);
    assert.equal((await f.call(prefix+'/records?system=mercury&feed=bank-statement',undefined,token)).status,401);
    const match={type:'match_statement_line',statement_id:statement.id,line_id:line.id,bank_transaction_ids:sourceIds(w,statement,line)};
    assert.equal((await f.act(w.id,match,token)).status,401);
    const read=await f.grant(w.id,'read');assert.equal((await f.call(prefix+'/records?system=mercury&feed=bank-statement',undefined,read)).status,200);
    assert.equal((await f.act(w.id,match,read)).status,403);assert.equal((await f.call(`/api/worlds/${other.id}/records?system=mercury&feed=bank-statement`,undefined,read)).status,403);assert.equal((await f.call(prefix+'/records?system=ledger&feed=reconciliation-report',undefined,read)).status,403);
    const write=await f.grant(w.id,'read write'),before=structuredClone(financial(w));okay(await f.act(w.id,match,write));
    const state=(await f.call(prefix)).data.world;assert.deepEqual(financial(state),before);assert.equal(state.reconciliationMatches.length,1);
    const copied={type:'record_bank_statement',...statementInput(statement),source_statement_id:'other-source-copy',external_event_id:'controller-import-copy'};
    assert.equal((await f.act(w.id,copied,write)).status,403);const imported=okay(await f.act(w.id,copied)).statement;
    assert.equal((await f.act(w.id,{...match,statement_id:imported.id,line_id:imported.lines[0].id},write)).status,409,'An active match cannot be reused by a second source statement');
    assert.equal(f.server.store.verify(w.id).valid,true);const audit=JSON.stringify(f.server.store.events(w.id,0,1000));for(const secret of [read,write,token])assert.ok(!audit.includes(secret));
  }finally{await f.dispose();}
});

test('grouped reconciliation preserves source references, requires exact dated timing acknowledgements, and survives signed delivery and restart',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'gram-reconciliation-restart-')),database=join(folder,'world.sqlite');let f=await start(database);
  try{
    const w=await f.create(),statement=w.bankStatements[0],prefix=`/api/worlds/${w.id}`,token=f.agent(w.id),before=structuredClone(financial(w));
    await f.connect(w.id,'mercury');await f.connect(w.id,'ledger');
    const subscription=await f.call(prefix+'/webhooks',{events:['*']});assert.equal(subscription.status,201);
    const grouped=statement.lines.find((line:any)=>sourceIds(w,statement,line).length>1);assert.ok(grouped);
    const match={type:'match_statement_line',statement_id:statement.id,line_id:grouped.id,bank_transaction_ids:sourceIds(w,statement,grouped)};
    const repeated=await Promise.all(Array.from({length:4},()=>f.act(w.id,match,token,'one-grounded-group')));repeated.forEach(okay);assert.equal(repeated.filter(result=>!result.data.replayed).length,1);
    assert.equal((await f.act(w.id,{...match,bank_transaction_ids:match.bank_transaction_ids.slice(0,1)},token,'one-grounded-group')).status,409);
    for(const line of statement.lines.filter((line:any)=>line.id!==grouped.id))okay(await f.act(w.id,{type:'match_statement_line',statement_id:statement.id,line_id:line.id,bank_transaction_ids:sourceIds(w,statement,line)},token));
    let prepared=okay(await f.act(w.id,{type:'prepare_reconciliation',statement_id:statement.id},token)),report=prepared.report;
    assert.equal(report.can_close,true);assert.deepEqual(report.blockers,[]);assert.deepEqual(report.unmatched_bank_transaction_ids,[]);assert.deepEqual(report.unmatched_statement_line_ids,[]);assert.ok(report.timing_items.length>0);
    assert.ok(report.timing_items.every((item:any)=>item.kind==='posted_after_cutoff'&&item.posted_at>statement.end_at&&item.journal_id&&item.bank_transaction_ids.length));assert.equal(report.adjusted_difference_minor,0);
    assert.equal((await f.act(w.id,closeInput(statement,report,'worker-close'),token)).status,403);
    assert.equal((await f.act(w.id,{...closeInput(statement,report,'missing-timing-ack'),acknowledged_timing_item_ids:[]})).status,409);
    assert.equal((await f.act(w.id,{...closeInput(statement,report,'wrong-timing-ack'),acknowledged_timing_item_ids:['invented-timing-item']})).status,409);
    // A changed match invalidates the earlier prepared evidence before close.
    okay(await f.act(w.id,{type:'unmatch_statement_line',statement_id:statement.id,line_id:grouped.id,reason:'Review grouped source references'},token));
    assert.equal((await f.act(w.id,closeInput(statement,report,'stale-match-close'))).status,409);
    okay(await f.act(w.id,match,token,'rematch-reviewed-group'));
    prepared=okay(await f.act(w.id,{type:'prepare_reconciliation',statement_id:statement.id},token));report=prepared.report;
    const closed=okay(await f.act(w.id,closeInput(statement,report,'independent-close'),'','close-reconciled-statement'));assert.equal(closed.closed,true);
    let snapshot=(await f.call(prefix)).data;assert.equal(snapshot.world.bankStatements[0].status,'closed');assert.deepEqual(financial(snapshot.world),before);
    const reportBeforeReopen=structuredClone(snapshot.world.reconciliationReports.find((row:any)=>row.id===report.id));
    assert.equal((await f.act(w.id,{type:'unmatch_statement_line',statement_id:statement.id,line_id:grouped.id,reason:'Cannot silently rewrite close'},token)).status,409);
    const reopening={type:'reopen_reconciliation',statement_id:statement.id,reason:'Controller reopens the attested statement for a new review',external_event_id:'independent-reopen'};
    assert.equal((await f.act(w.id,reopening,token)).status,403);okay(await f.act(w.id,reopening));assert.equal(okay(await f.act(w.id,reopening)).replayed,true);
    snapshot=(await f.call(prefix)).data;assert.deepEqual(financial(snapshot.world),before);assert.deepEqual(snapshot.world.reconciliationReports.find((row:any)=>row.id===report.id),reportBeforeReopen,'Reopen preserves the prior immutable report');
    prepared=okay(await f.act(w.id,{type:'prepare_reconciliation',statement_id:statement.id},token));assert.notEqual(prepared.report.id,report.id);
    okay(await f.act(w.id,closeInput(statement,prepared.report,'independent-second-close')));
    for(let page=0;page<10;page++){const dispatched=await f.call(prefix+'/webhooks/dispatch',{});assert.equal(dispatched.status,200);assert.equal(dispatched.data.failed,0);if(dispatched.data.attempted===0)break;}
    snapshot=(await f.call(prefix)).data;assert.ok(snapshot.webhooks.deliveries.data.length>0);assert.ok(snapshot.webhooks.deliveries.data.every((delivery:any)=>delivery.status==='delivered'));assert.equal(snapshot.webhooks.receiver.receipts.length,snapshot.webhooks.deliveries.data.length);assert.equal(new Set(snapshot.webhooks.receiver.receipts.map((receipt:any)=>receipt.delivery_id)).size,snapshot.webhooks.receiver.receipts.length);
    const durable={financial:financial(snapshot.world),statements:snapshot.world.bankStatements,matches:snapshot.world.reconciliationMatches,reports:snapshot.world.reconciliationReports,receipts:snapshot.webhooks.receiver.receipts},port=Number(new URL(f.base).port);
    assert.equal(f.server.store.verify(w.id).valid,true);const log=JSON.stringify(f.server.store.events(w.id,0,1000));assert.ok(!log.includes(subscription.data.secret));
    await f.close();f=await start(database,port);const nextToken=f.agent(w.id);
    assert.equal((await f.act(w.id,match,nextToken,'one-grounded-group')).data.replayed,true);
    snapshot=(await f.call(prefix)).data;assert.deepEqual({financial:financial(snapshot.world),statements:snapshot.world.bankStatements,matches:snapshot.world.reconciliationMatches,reports:snapshot.world.reconciliationReports,receipts:snapshot.webhooks.receiver.receipts},durable);
    const reports=await f.call(prefix+'/records?system=mercury&feed=reconciliation-report',undefined,nextToken);assert.equal(reports.status,200);assert.equal(reports.data.data.length,durable.reports.length);assert.equal(f.server.store.verify(w.id).valid,true);
  }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

test('omitted bank rows prevent close; replacing a statement retains the old source version and releases only its active matches',async()=>{
  const f=await fixture();
  try{
    const w=await f.create({reconciliationControls:{omitStatementLine:true,deferredPosting:false}}),statement=w.bankStatements[0],prefix=`/api/worlds/${w.id}`,token=f.agent(w.id),before=structuredClone(financial(w));await f.connect(w.id,'mercury');
    await matchAll(f,w,statement,token);const prepared=okay(await f.act(w.id,{type:'prepare_reconciliation',statement_id:statement.id},token));
    assert.equal(prepared.report.can_close,false);assert.ok(prepared.report.unmatched_bank_transaction_ids.length>0);assert.ok(prepared.report.blockers.length>0);assert.equal((await f.act(w.id,closeInput(statement,prepared.report,'cannot-close-incomplete'))).status,409);
    const unmatched=w.bankTransactions.filter((row:any)=>prepared.report.unmatched_bank_transaction_ids.includes(row.id));
    const replacement={type:'replace_bank_statement',...statementInput(statement),source_statement_id:statement.source_statement_id+'-corrected-v2',statement_id:statement.id,reason:'Bank supplied the omitted statement line',lines:[...statementInput(statement).lines,...unmatched.map((row:any)=>({source_line_id:`recovered-${row.id}`,posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.id]}))],external_event_id:'corrected-bank-source'};
    replacement.closing_balance_minor=replacement.opening_balance_minor+replacement.lines.reduce((sum:number,line:any)=>sum+line.amount_minor,0);
    const ambiguous=await f.act(w.id,{...replacement,source_statement_id:statement.source_statement_id,external_event_id:'cannot-rewrite-original-source-version'});assert.equal(ambiguous.status,409);assert.equal(ambiguous.data.error.code,'duplicate_statement_source');
    const replaced=okay(await f.act(w.id,replacement)).statement;assert.notEqual(replaced.id,statement.id);assert.equal(okay(await f.act(w.id,replacement)).replayed,true);
    let snapshot=(await f.call(prefix)).data;const old=snapshot.world.bankStatements.find((row:any)=>row.id===statement.id);assert.equal(old.status,'superseded');assert.deepEqual(old.lines,statement.lines);assert.deepEqual(financial(snapshot.world),before);
    await matchAll(f,snapshot.world,replaced,token);const next=okay(await f.act(w.id,{type:'prepare_reconciliation',statement_id:replaced.id},token));assert.equal(next.report.can_close,true);assert.deepEqual(next.report.unmatched_bank_transaction_ids,[]);assert.equal(next.report.adjusted_difference_minor,0);okay(await f.act(w.id,closeInput(replaced,next.report,'close-complete-replacement')));
    snapshot=(await f.call(prefix)).data;assert.deepEqual(financial(snapshot.world),before);assert.equal(snapshot.world.bankStatements.length,2);assert.equal(snapshot.world.bankStatements.find((row:any)=>row.id===replaced.id).status,'closed');assert.equal(f.server.store.verify(w.id).valid,true);
  }finally{await f.dispose();}
});

test('unposted settlements block reconciliation and actual later posting requires a fresh independently attested timing report',async()=>{
  const f=await fixture();
  try{
    const w=await f.create({kind:'saas-collections',orderCount:1}),prefix=`/api/worlds/${w.id}`,token=f.agent(w.id);await f.connect(w.id,'stripe');await f.connect(w.id,'mercury');
    const opening=(await f.call(prefix)).data.summary.cash_minor;
    okay(await f.act(w.id,{type:'close_period'}));const collection=okay(await f.act(w.id,{type:'collect_invoice',invoice_id:w.invoices[0].id,amount_minor:1000},token));okay(await f.act(w.id,{type:'advance_time',hours:1}));
    let snapshot=(await f.call(prefix)).data;const bank=snapshot.world.bankTransactions.find((row:any)=>row.source_id===collection.operation.id),cutoff=snapshot.world.now;assert.ok(bank);assert.equal(snapshot.summary.unposted_settlements,1);
    const input={type:'record_bank_statement',source_statement_id:'statement-with-deferred-collection',account_id:'cash-bank',currency:'USD',start_at:w.now,end_at:cutoff,opening_balance_minor:opening,closing_balance_minor:opening+1000,lines:[{source_line_id:'bank-confirmed-collection',posted_at:bank.posted_at,amount_minor:1000,source_refs:[bank.receipt_id]}],external_event_id:'import-deferred-bank-statement'};
    const beforeImport=structuredClone(financial(snapshot.world)),statement=okay(await f.act(w.id,input)).statement;assert.equal(okay(await f.act(w.id,input)).replayed,true);
    snapshot=(await f.call(prefix)).data;assert.deepEqual(financial(snapshot.world),beforeImport);
    okay(await f.act(w.id,{type:'match_statement_line',statement_id:statement.id,line_id:statement.lines[0].id,bank_transaction_ids:[bank.id]},token));
    const blocked=okay(await f.act(w.id,{type:'prepare_reconciliation',statement_id:statement.id},token)).report;assert.equal(blocked.can_close,false);assert.ok(blocked.blockers.length>0);assert.equal(blocked.timing_items.length,0);assert.equal((await f.act(w.id,closeInput(statement,blocked,'cannot-close-unposted'))).status,409);
    okay(await f.act(w.id,{type:'advance_time',hours:1}));okay(await f.act(w.id,{type:'reopen_period'}));snapshot=(await f.call(prefix)).data;
    const posted=snapshot.world.operations.find((row:any)=>row.id===collection.operation.id),journal=snapshot.world.journals.find((row:any)=>row.id===posted.journal_id);assert.ok(journal.posted_at>cutoff);assert.equal(snapshot.summary.unposted_settlements,0);
    assert.equal((await f.act(w.id,closeInput(statement,blocked,'stale-pre-posting-report'))).status,409);
    const ownReport=okay(await f.act(w.id,{type:'prepare_reconciliation',statement_id:statement.id})).report;
    assert.equal(ownReport.can_close,true);assert.notEqual(ownReport.source_fingerprint,blocked.source_fingerprint);assert.equal(ownReport.timing_items.length,1);assert.equal(ownReport.timing_items[0].journal_id,journal.id);assert.deepEqual(ownReport.timing_items[0].bank_transaction_ids,[bank.id]);assert.equal(ownReport.timing_items[0].posted_at,journal.posted_at);
    assert.equal((await f.act(w.id,closeInput(statement,ownReport,'cannot-attest-own-preparation'))).status,403);
    const fresh=okay(await f.act(w.id,{type:'prepare_reconciliation',statement_id:statement.id},token)).report;assert.equal(fresh.can_close,true);assert.equal(fresh.adjusted_difference_minor,0);
    assert.equal((await f.act(w.id,{...closeInput(statement,fresh,'cannot-ignore-late-book-date'),acknowledged_timing_item_ids:[]})).status,409);
    const beforeClose=structuredClone(financial((await f.call(prefix)).data.world));okay(await f.act(w.id,closeInput(statement,fresh,'controller-attests-exact-timing')));
    snapshot=(await f.call(prefix)).data;assert.deepEqual(financial(snapshot.world),beforeClose);assert.equal(snapshot.summary.cash_minor,opening+1000);assert.equal(snapshot.summary.reconciliation.bank_ledger_difference_minor,0);assert.equal(snapshot.summary.reconciliation.balanced,true);assert.equal(f.server.store.verify(w.id).valid,true);
  }finally{await f.dispose();}
});

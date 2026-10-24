import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {validateGeneratedScenario} from '../src/agent.ts';
import {hash} from '../src/store.ts';

async function start(database=':memory:',port=0){
  const server=await startServer({database,port,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  const home=await fetch(base,{headers:{Connection:'close'}});expect(home.status).toBe(200);const cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  const call=async(path:string,input?:any,token?:string,key:string=crypto.randomUUID(),anonymous=false)=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:(anonymous?{}:{Cookie:cookie})),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const grant=async(world:string,system:string,scope='read write')=>{
    const redirect='http://127.0.0.1:9123/blueprint-source-test',client=await call('/api/oauth/clients',{name:'Blueprint source operator',redirect_uris:[redirect]});expect(client.status).toBe(201);
    const verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''),form=new URLSearchParams({client_id:client.data.client_id,redirect_uri:redirect,response_type:'code',scope,state:crypto.randomUUID(),world_id:world,code_challenge:new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
    const consent=await fetch(base+`/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});expect(consent.status).toBe(303);await consent.text();
    const token=await call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:client.data.client_id,redirect_uri:redirect,code:new URL(consent.headers.get('location')!).searchParams.get('code'),code_verifier:verifier},undefined,crypto.randomUUID(),true);expect(token.status,JSON.stringify(token.data)).toBe(200);return token.data.access_token as string;
  };
  const agent=(world:string)=>{const token=crypto.randomUUID();server.store.put('agent-tokens',hash(token),{world,actor:`agent-world:${world}`,expires_at:Date.now()+60000});return token;};
  const act=(world:string,input:any,token?:string,key?:string)=>call(`/api/worlds/${world}/actions`,input,token,key);
  const state=async(world:string)=>(await call(`/api/worlds/${world}`)).data;
  const create=async(input:any)=>{const result=await call('/api/worlds',input);expect(result.status,JSON.stringify(result.data)).toBe(201);return result.data.world;};
  return {server,base,call,grant,agent,act,state,create,close:()=>server.close()};
}
type Fixture=Awaited<ReturnType<typeof start>>;
const okay=(response:any)=>{expect(response.status,JSON.stringify(response.data)).toBe(200);return response.data.result;};
const refId=(world:any,ref:string)=>world.blueprintManifest.refs[ref].id;
const balance=(world:any,id:string)=>world.accounts.find((account:any)=>account.id===id).balance_minor;
const economics=(world:any)=>({bankTransactions:world.bankTransactions,accounts:world.accounts,journals:world.journals,operations:world.operations});
const scenario=(blueprint:any,kind='bank-reconciliation')=>({name:'Source Works',description:'Explicit controller source facts with unresolved operator work.',kind,seed:83,orderCount:1,currency:'USD',startingCashMinor:1000000,cancelEvent:false,initialFaults:[],limitations:[],blueprint});
const closeInput=(statement:any,report:any,event:string)=>({type:'close_reconciliation',statement_id:statement.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((item:any)=>item.id),external_event_id:event});
function bankBlueprint(mismatch=false,closed=false):any{
  return {version:1,opening_at:'2026-10-01T09:00:00.000Z',as_of:'2026-10-02T10:00:00.000Z',period_closed:closed,
    bank_activities:[
      {ref:'fee-source',source_transaction_id:'BANK-FEE-250',account_ref:'operating',currency:'USD',kind:'fee',amount_minor:250,posted_at:'2026-10-02T09:00:00.000Z',description:'Observed account maintenance fee'},
      {ref:'interest-source',source_transaction_id:'BANK-INTEREST-75',account_ref:'operating',currency:'USD',kind:'interest',amount_minor:75,posted_at:'2026-10-02T09:15:00.000Z',description:'Observed account interest'},
    ],
    bank_statements:[{ref:'statement-source',source_statement_id:mismatch?'BANK-STATEMENT-DISCREPANCY':'BANK-STATEMENT-COMPLETE',account_ref:'operating',currency:'USD',start_at:'2026-10-01T09:00:00.000Z',end_at:'2026-10-02T09:30:00.000Z',opening_balance_minor:1000000,closing_balance_minor:mismatch?999824:999825,lines:[
      {ref:'statement-fee',source_line_id:'STATEMENT-FEE',posted_at:'2026-10-02T09:00:00.000Z',amount_minor:mismatch?-251:-250,source_refs:[{kind:'bank_activity',ref:'fee-source'}]},
      {ref:'statement-interest',source_line_id:'STATEMENT-INTEREST',posted_at:'2026-10-02T09:15:00.000Z',amount_minor:75,source_refs:[{kind:'bank_activity',ref:'interest-source'}]},
    ]}],
  };
}
function assetBlueprint():any{
  return {version:1,opening_at:'2026-08-01T09:00:00.000Z',as_of:'2026-10-02T10:00:00.000Z',
    vendors:[{ref:'supplier',name:'Scanner Supply',email:'ap@scanner-supply.test'}],inventory_items:[{ref:'scanner',sku:'SCAN-12',name:'Warehouse scanner'}],
    purchase_orders:[{ref:'scanner-order',vendor_ref:'supplier',purpose:'Approved warehouse equipment',approval:'approved',lines:[{ref:'scanner-line',item_ref:'scanner',quantity:2,unit_price_minor:12000,max_unit_price_minor:12000}],receipts:[{ref:'scanner-receipt',reference:'WAREHOUSE-RECEIPT',lines:[{line_ref:'scanner-line',quantity:2}]}],invoices:[{ref:'scanner-invoice',invoice_number:'SCANNER-INV-24000',due_at:'2026-08-31T09:00:00.000Z',lines:[{line_ref:'scanner-line',quantity:2,unit_price_minor:12000}]}]}],
    asset_policies:[{ref:'book-policy',name:'Twelve month straight-line policy',useful_life_months:12,salvage_bps:0}],
    asset_acquisitions:[{ref:'scanner-acquisition',name:'Receiving desk scanner',policy_ref:'book-policy',supplier_invoice_ref:'scanner-invoice',allocations:[{receipt_ref:'scanner-receipt',po_line_ref:'scanner-line',quantity:1}]}],
    asset_capitalizations:[{ref:'receiving-scanner',acquisition_ref:'scanner-acquisition',capitalized_at:'2026-08-01T12:00:00.123Z',in_service_at:'2026-08-01T12:00:00.456Z'}],
    asset_disposal_terms:[{ref:'retirement-terms',asset_ref:'receiving-scanner',kind:'retirement',proceeds_minor:0,reason:'Controller authorizes future retirement only after separate review'}],
    bank_accounts:[{ref:'euro-bank',name:'EUR operating',currency:'EUR'}],
    fx_quotes:[{ref:'funding-quote',base_currency:'EUR',quote_currency:'USD',numerator:'1',denominator:'1',observed_at:'2026-08-01T09:00:00.000Z',expires_at:'2026-08-02T09:00:00.000Z'}],
    historical_funding:[{ref:'euro-funding',from_account_ref:'operating',to_account_ref:'euro-bank',amount_minor:10000,fee_minor:0,quote_ref:'funding-quote',reason:'Approved EUR operating liquidity'}],
    closing_fx_quotes:[{ref:'closing-quote',base_currency:'EUR',quote_currency:'USD',numerator:'11',denominator:'10',observed_at:'2026-10-02T09:00:00.000Z',expires_at:'2026-10-03T09:00:00.000Z'}],
  };
}
async function matchActivities(f:Fixture,world:any,statement:any,token:string){
  for(const line of statement.lines){const activity=world.bankActivities.find((item:any)=>line.source_refs.some((ref:string)=>[item.source_transaction_id,item.receipt_id,item.bank_transaction_id,item.operation_id].includes(ref)));expect(activity).toBeTruthy();okay(await f.act(world.id,{type:'match_statement_line',statement_id:statement.id,line_id:line.id,bank_transaction_ids:[activity.bank_transaction_id]},token));}
}

test('advance_to uses exact controller time, rejects malformed/backward/oversized jumps atomically and replays once',async()=>{
  const f=await start();
  try{
    const world=await f.create({kind:'saas-collections',name:'Clock review',seed:11,orderCount:1}),token=f.agent(world.id),mercury=await f.grant(world.id,'mercury'),prefix=`/api/worlds/${world.id}`,target=new Date(Date.parse(world.now)+1).toISOString();
    const context=(await f.call(prefix+'/context',undefined,token)).data;expect(!context.available_actions.includes('advance_to')).toBeTruthy();
    const stripe=await f.grant(world.id,'stripe'),collection=okay(await f.act(world.id,{type:'collect_invoice',invoice_id:world.invoices[0].id},stripe));expect(collection.operation.status).toBe('pending');
    expect((await f.act(world.id,{type:'advance_to',at:target},token)).status).toBe(403);expect((await f.act(world.id,{type:'advance_to',at:target},mercury)).status).toBe(403);
    const cases=[
      [{at:world.now},409,'invalid_clock_target'],[{at:'2026-10-23T09:00:00.000Z'},409,'invalid_clock_target'],
      [{at:'2026-10-24T09:00:01Z'},400,'invalid_clock_timestamp'],[{at:'2026-02-30T09:00:00.000Z'},400,'invalid_clock_timestamp'],[{at:'2101-01-01T00:00:00.000Z'},400,'invalid_clock_timestamp'],
      [{at:new Date(Date.parse(world.now)+365*86400000+1).toISOString()},400,'clock_advance_too_large'],[{at:target,hours:1},400,'invalid_clock_field'],[{at:target,action:'advance_time'},400,'invalid_clock_field'],
    ] as const;
    for(const [fields,status,code] of cases){const before=(await f.state(world.id)).world,result=await f.act(world.id,{type:'advance_to',...fields});expect(result.status,JSON.stringify(result.data)).toBe(status);expect(result.data.error.code).toBe(code);expect((await f.state(world.id)).world).toStrictEqual(before);}
    const action={type:'advance_to',at:target},key=crypto.randomUUID();okay(await f.act(world.id,action,undefined,key));const after=(await f.state(world.id)).world;expect(after.now).toBe(target);expect(after.operations.find((row:any)=>row.id===collection.operation.id).status).toBe('pending');expect((await f.act(world.id,action,undefined,key)).data.replayed).toBe(true);expect((await f.state(world.id)).world).toStrictEqual(after);
    const last=new Date(Date.parse(target)+365*86400000).toISOString();okay(await f.act(world.id,{type:'advance_to',at:last}));const settled=(await f.state(world.id)).world;expect(settled.now).toBe(last);const operation=settled.operations.find((row:any)=>row.id===collection.operation.id);expect(operation.status).toBe('settled');expect(operation.settled_at).toBe(last);expect(settled.bankTransactions.filter((row:any)=>row.source_id===operation.id).length).toBe(1);expect(settled.journals.find((row:any)=>row.id===operation.journal_id).posted_at).toBe(last);
    const clockEvents=f.server.store.events(world.id,0,1000).filter((event:any)=>event.data?.to===target&&event.data?.elapsed_ms===1);expect(clockEvents.length).toBe(1);expect(clockEvents[0].data.from).toBe(world.now);expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);
  }finally{await f.close();}
});

test('custom generated asset sources replay portably with exact chronology, genuine funding and scoped depreciation',async()=>{
  const f=await start();
  try{
    const input=scenario(assetBlueprint(),'fixed-asset-close'),before=structuredClone(input),validated=validateGeneratedScenario(input),a=await f.create(validated),b=await f.create(validated);expect(input).toStrictEqual(before);expect(a.id).not.toBe(b.id);expect({...a,id:'portable'}).toStrictEqual({...b,id:'portable'});
    const asset=a.fixedAssets.find((row:any)=>row.id===refId(a,'receiving-scanner')),po=a.purchaseOrders[0],bill=a.bills.find((row:any)=>row.id===asset.bill_id),history=JSON.stringify(a.generationHistory),bank=structuredClone(a.bankTransactions);
    expect(a.now).toBe(input.blueprint.as_of);expect(asset.capitalized_at).toBe('2026-08-01T12:00:00.123Z');expect(asset.in_service_at).toBe('2026-08-01T12:00:00.456Z');expect(asset.cost_minor).toBe(12000);expect(asset.accumulated_depreciation_minor).toBe(0);expect(bill.amount_minor).toBe(24000);expect(bill.amount_paid_minor).toBe(0);expect(balance(a,'inventory')).toBe(12000);expect(balance(a,'fixed-asset-cost')).toBe(12000);expect(balance(a,'payables')).toBe(-24000);
    expect(po.requested_by).not.toBe(po.approved_by);expect(a.assetDisposals.length).toBe(0);expect(a.approvals.every((row:any)=>row.status==='approved')).toBeTruthy();expect(a.treasuryTransfers.length).toBe(1);expect(a.treasuryTransfers[0].status).toBe('settled');expect(a.treasuryTransfers[0].requested_by).not.toBe(a.treasuryTransfers[0].approved_by);expect(a.fxValuations.length).toBe(0);
    expect(a.fxQuotes.find((row:any)=>row.id===refId(a,'closing-quote')).observed_at).toBe('2026-10-02T09:00:00.000Z');expect(a.generationHistory.some((row:any)=>row.action.type==='capitalize_asset'&&row.at===asset.capitalized_at)).toBeTruthy();expect(a.generationHistory.some((row:any)=>row.action.type==='place_asset_in_service'&&row.at===asset.in_service_at)).toBeTruthy();
    const read=await f.grant(a.id,'netsuite','read'),write=await f.grant(a.id,'netsuite'),mercury=await f.grant(a.id,'mercury'),depreciate={type:'depreciate_asset',asset_id:asset.id,through_month:'2026-09'};
    expect((await f.act(a.id,depreciate,read)).status).toBe(403);expect((await f.act(a.id,depreciate,mercury)).status).toBe(403);expect((await f.act(b.id,depreciate,write)).status).toBe(403);
    const key=crypto.randomUUID(),depreciated=okay(await f.act(a.id,depreciate,write,key));expect(depreciated.asset.accumulated_depreciation_minor).toBe(1000);expect(depreciated.asset.net_book_value_minor).toBe(11000);expect(depreciated.entries.length).toBe(1);expect(depreciated.entries[0].month).toBe('2026-09');expect((await f.act(a.id,depreciate,write,key)).data.replayed).toBe(true);
    const revalued=okay(await f.act(a.id,{type:'revalue_bank_account',bank_account_id:refId(a,'euro-bank'),quote_id:refId(a,'closing-quote')},write));expect(revalued).toBeTruthy();
    const result=(await f.state(a.id)).world;expect(JSON.stringify(result.generationHistory)).toBe(history);expect(result.bankTransactions).toStrictEqual(bank);expect(result.bills[0].amount_paid_minor).toBe(0);expect(balance(result,'payables')).toBe(-24000);expect(result.fxValuations.length).toBe(1);expect(result.fxValuations[0].adjustment_minor).toBe(1000);expect(result.journals.find((row:any)=>row.id===depreciated.operation.journal_id).posted_at).toBe(input.blueprint.as_of);expect((await f.call(`/api/worlds/${a.id}/audit/verify`)).data.valid).toBe(true);
  }finally{await f.close();}
});

test('blueprint bank statements retain real discrepancies and cannot self-authorize classification or closure',async()=>{
  const f=await start();
  try{
    const input=scenario(bankBlueprint(true)),validated=validateGeneratedScenario(input),world=await f.create(validated),prefix=`/api/worlds/${world.id}`,mercury=await f.grant(world.id,'mercury'),netsuite=await f.grant(world.id,'netsuite'),statement=world.bankStatements[0],fee=world.bankActivities.find((row:any)=>row.kind==='fee');
    expect(statement.status).toBe('open');expect(world.reconciliationMatches.length).toBe(0);expect(world.reconciliationReports.length).toBe(0);expect(world.bankActivities.every((row:any)=>row.status==='unclassified')).toBeTruthy();expect(balance(world,'cash-bank')).toBe(999825);expect(statement.closing_balance_minor).toBe(999824);expect(fee.posted_at).toBe('2026-10-02T09:00:00.000Z');expect(fee.observed_at).toBe(input.blueprint.as_of);
    const saved=structuredClone(economics(world)),line=statement.lines.find((row:any)=>row.amount_minor<0),mismatch=await f.act(world.id,{type:'match_statement_line',statement_id:statement.id,line_id:line.id,bank_transaction_ids:[fee.bank_transaction_id]},mercury);expect(mismatch.status).toBe(409);expect(economics((await f.state(world.id)).world)).toStrictEqual(saved);
    const blocked=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;expect(blocked.can_close).toBe(false);expect(blocked.unmatched_statement_line_ids.includes(line.id)).toBeTruthy();expect(blocked.blockers.some((row:any)=>row.code==='unclassified_bank_activity')).toBeTruthy();expect((await f.act(world.id,closeInput(statement,blocked,'operator-cannot-close'),mercury)).status).toBe(403);expect((await f.act(world.id,closeInput(statement,blocked,'controller-cannot-close-discrepancy'))).status).toBe(409);
    for(const activity of world.bankActivities)okay(await f.act(world.id,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:activity.kind==='fee'?'bank-fee-expense':'interest-income'},netsuite));
    const report=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;expect(report.can_close,'Classifying genuine bank facts does not repair a discrepant external statement').toBe(false);expect(report.unmatched_statement_line_ids.length>0).toBeTruthy();expect((await f.state(world.id)).world.bankStatements[0].closing_balance_minor).toBe(999824);expect((await f.state(world.id)).world.bankTransactions).toStrictEqual(world.bankTransactions);expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);
  }finally{await f.close();}
});

test('blueprint deferred bank effects require actual later posting and exact independent closure, surviving restart',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'gram-blueprint-source-http-')),database=join(folder,'world.sqlite');let f=await start(database);
  try{
    const world=await f.create(scenario(bankBlueprint(false,true))),prefix=`/api/worlds/${world.id}`,mercury=await f.grant(world.id,'mercury'),netsuite=await f.grant(world.id,'netsuite'),statement=world.bankStatements[0],history=JSON.stringify(world.generationHistory),native=structuredClone(world.bankTransactions);
    expect(world.periodClosed).toBe(true);expect(world.journals.length).toBe(1);expect(world.operations.every((row:any)=>row.status==='settled'&&!row.journal_id)).toBeTruthy();expect((await f.state(world.id)).summary.cash_minor).toBe(999825);expect(balance(world,'cash-bank')).toBe(1000000);
    await matchActivities(f,world,statement,mercury);
    for(const activity of world.bankActivities)okay(await f.act(world.id,{type:'classify_bank_activity',bank_activity_id:activity.id,account_id:activity.kind==='fee'?'bank-fee-expense':'interest-income'},netsuite));
    const blocked=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;expect(blocked.can_close).toBe(false);expect(blocked.blockers.some((row:any)=>row.code==='unposted_bank_classification')).toBeTruthy();expect((await f.act(world.id,closeInput(statement,blocked,'cannot-close-deferred'))).status).toBe(409);
    const recovery='2026-10-03T10:00:00.007Z';okay(await f.act(world.id,{type:'advance_to',at:recovery}));okay(await f.act(world.id,{type:'reopen_period'}));
    let state=await f.state(world.id);expect(state.world.bankTransactions).toStrictEqual(native);expect(state.world.operations.length).toBe(4);expect(state.world.operations.every((row:any)=>row.journal_id)).toBeTruthy();expect(state.world.journals.filter((row:any)=>row.source_type!=='opening').every((row:any)=>row.posted_at===recovery)).toBeTruthy();expect(balance(state.world,'cash-bank')).toBe(999825);expect(balance(state.world,'bank-suspense')).toBe(0);expect(balance(state.world,'bank-fee-expense')).toBe(250);expect(balance(state.world,'interest-income')).toBe(-75);expect(JSON.stringify(state.world.generationHistory)).toBe(history);
    expect((await f.act(world.id,closeInput(statement,blocked,'stale-deferred-proof'))).status).toBe(409);
    const report=okay(await f.act(world.id,{type:'prepare_reconciliation',statement_id:statement.id},mercury)).report;expect(report.can_close).toBe(true);expect(report.adjusted_difference_minor).toBe(0);expect(report.timing_items.some((row:any)=>row.kind==='posted_after_cutoff')).toBeTruthy();expect(report.timing_items.filter((row:any)=>row.kind==='classification_posted_after_cutoff').length).toBe(2);expect(report.timing_items.every((row:any)=>row.posted_at===recovery)).toBeTruthy();
    expect((await f.act(world.id,{...closeInput(statement,report,'missing-timing-ack'),acknowledged_timing_item_ids:[]})).status).toBe(409);expect((await f.act(world.id,closeInput(statement,report,'operator-cannot-attest'),mercury)).status).toBe(403);okay(await f.act(world.id,closeInput(statement,report,'independent-source-close')));
    state=await f.state(world.id);expect(state.world.bankStatements[0].status).toBe('closed');const durable=structuredClone(state.world),port=Number(new URL(f.base).port);expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);
    await f.close();f=await start(database,port);expect((await f.state(world.id)).world).toStrictEqual(durable);expect((await f.call(prefix+'/records?system=mercury&feed=bank-statement',undefined,mercury)).status).toBe(200);expect((await f.call(prefix+'/audit/verify')).data.valid).toBe(true);
  }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

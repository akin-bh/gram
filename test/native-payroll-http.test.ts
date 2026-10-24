import {test,expect} from 'bun:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {hash} from '../src/store.ts';
import {start} from './integration-fixture.ts';
const okay=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r.data));return r.data.result;};
test('Gusto native preparation, calculation and submission persist original responses atomically through approvals, outages and restart',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'gram-gusto-native-')),database=join(folder,'world.sqlite');let f=await start(database);
 try{
  const w=await f.create(),id=w.id,agent=f.agent(id),prefix=`/providers/gusto/worlds/${id}/v1/companies/${id}/payrolls`,originalCash=JSON.stringify(w.bankTransactions),originalBooks=JSON.stringify(w.journals);
  const native=async(method:string,path:string,body?:any,key?:string,token:string=agent)=>{const r=await fetch(f.base+path,{method,headers:{Authorization:`Bearer ${token}`,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),headers:r.headers};};
  const readOnly=await f.grant(id,'read');expect((await native('GET',prefix+'?processing_statuses=unprocessed&payroll_types=off_cycle',undefined,undefined,readOnly)).status).toBe(200);
  const create={off_cycle:true,off_cycle_reason:'Adhoc',start_date:w.payrollTimeRecords[0].period_start,end_date:w.payrollTimeRecords[0].period_end,employee_uuids:w.employees.map((e:any)=>e.id),finance_world:{policy_id:w.payrollPolicies[0].id,time_record_ids:w.payrollTimeRecords.map((t:any)=>t.id)}};
  expect((await native('POST',prefix,create,'read-cannot-prepare',readOnly)).status).toBe(403);
  await f.connect(id,'gusto');await f.connect(id,'bank');await f.connect(id,'netsuite');
  expect((await native('POST',prefix,create)).status).toBe(400);
  const prepared=await native('POST',prefix,create,'native-prepare');expect(prepared.status).toBe(200);const runId=prepared.data.uuid,detail=prefix+'/'+runId;
  expect(prepared.data.finance_world.canonical_status).toBe('draft');expect(prepared.data.calculated_at).toBeNull();expect(prepared.data.processed).toBe(false);let current=f.server.store.world(id);expect(current.payrollRuns).toHaveLength(1);expect(JSON.stringify(current.bankTransactions)).toBe(originalCash);expect(JSON.stringify(current.journals)).toBe(originalBooks);
  const calcBody={finance_world:{version:prepared.data.finance_world.version}},parallel=await Promise.all([native('PUT',detail+'/calculate',calcBody,'native-calculate'),native('PUT',detail+'/calculate',calcBody,'native-calculate')]);
  expect(parallel.map(x=>x.status)).toEqual([202,202]);expect(parallel[0].data).toEqual(parallel[1].data);expect(parallel.some(x=>x.headers.get('idempotent-replayed')==='true')).toBe(true);const calculated=parallel[0].data;
  expect(calculated.uuid).toBe(runId);expect(calculated.finance_world.canonical_status).toBe('calculated');expect(calculated.employee_compensations.every((row:any)=>row.net_pay===null)).toBe(true);current=f.server.store.world(id);expect(current.payrollRuns).toHaveLength(1);expect(current.documents.filter((d:any)=>d.type==='payroll-calculation')).toHaveLength(1);expect(current.operations).toHaveLength(0);
  expect((await native('PUT',detail+'/calculate',{finance_world:{version:calculated.finance_world.version}},'native-calculate')).status).toBe(409);
  const beforeStale=JSON.stringify(f.server.store.world(id));expect((await native('PUT',detail+'/calculate',calcBody,'new-stale-key')).status).toBe(409);expect(JSON.stringify(f.server.store.world(id))).toBe(beforeStale);
  const submitBody={finance_world:{version:calculated.finance_world.version}},submitted=await native('PUT',detail+'/submit',submitBody,'native-submit');expect(submitted.status).toBe(202);expect(submitted.data.processed).toBe(false);expect(submitted.data.finance_world.canonical_status).toBe('awaiting_approval');
  const repeat=await native('PUT',detail+'/submit',submitBody,'native-submit');expect(repeat.status).toBe(202);expect(repeat.data).toEqual(submitted.data);expect(repeat.headers.get('idempotent-replayed')).toBe('true');expect(f.server.store.world(id).approvals).toHaveLength(1);
  const approval=submitted.data.finance_world.approval_id;expect((await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'},agent)).status).toBe(403);
  okay(await f.act(id,{type:'decide_approval',approval_id:approval,decision:'approve'}));okay(await f.act(id,{type:'set_fault',system:'bank',mode:'offline'}));okay(await f.act(id,{type:'advance_time',hours:1}));
  const blocked=await native('GET',detail);expect(blocked.data.processed).toBe(false);expect(blocked.data.processing_request.status).toBe('submitting');expect(blocked.data.finance_world.settlement_status).toBe('pending');expect(JSON.stringify(f.server.store.world(id).bankTransactions)).toBe(originalCash);
  okay(await f.act(id,{type:'set_fault',system:'bank',mode:'healthy'}));okay(await f.act(id,{type:'advance_time',hours:1}));const paid=await native('GET',detail);expect(paid.data.processed).toBe(true);expect(paid.data.finance_world.wages_paid).toBe(true);expect(paid.data.finance_world.tax_remitted).toBe(false);expect(paid.data.employee_compensations.every((row:any)=>typeof row.net_pay==='string'&&/^\d+\.\d{2}$/.test(row.net_pay))).toBe(true);
  const lateRetry=await native('PUT',detail+'/submit',submitBody,'native-submit');expect(lateRetry.data).toEqual(submitted.data);expect(lateRetry.data.processed).toBe(false); // Original accepted response; fresh GET alone proves later receipt.
  current=f.server.store.world(id);expect(current.bankTransactions.length).toBe(w.bankTransactions.length+1);expect(f.server.store.verify(id).valid).toBe(true);
  const exact=hash(JSON.stringify(current)),port=Number(new URL(f.base).port);await f.close();f=await start(database,port);expect(hash(JSON.stringify(f.server.store.world(id)))).toBe(exact);
  const persistedRetry=await native('PUT',detail+'/calculate',calcBody,'native-calculate',f.agent(id));expect(persistedRetry.status).toBe(202);expect(persistedRetry.data).toEqual(calculated);expect(persistedRetry.headers.get('idempotent-replayed')).toBe('true');expect(hash(JSON.stringify(f.server.store.world(id)))).toBe(exact);expect(f.server.store.verify(id).valid).toBe(true);
 }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

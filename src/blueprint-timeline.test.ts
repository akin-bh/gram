import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createWorld} from './world.ts';
import {nativeBankBalance} from './treasury.ts';
import {validateBlueprint,materializeBlueprint} from './blueprint.ts';

const funding=(opening_at:string)=>({version:1,opening_at,bank_accounts:[{ref:'reserve',name:'Reserve',currency:'USD'}],historical_funding:[{ref:'funding',from_account_ref:'operating',to_account_ref:'reserve',amount_minor:1,fee_minor:0,reason:'Recorded reserve funding'}]});
test('derived construction clock rejects unsupported years before any source action and accepts the exact final boundary',()=>{
  const input=funding('2100-12-31T23:30:00.000Z'),snapshot=structuredClone(input);
  assert.throws(()=>validateBlueprint(input),(error:any)=>error.code==='invalid_blueprint_timeline'&&error.details.as_of==='2101-01-01T00:30:00.000Z');
  let calls=0;const world=createWorld({kind:'saas-collections',orderCount:1}),before=structuredClone(world);
  assert.throws(()=>materializeBlueprint(world,input,{perform:()=>{calls++;throw new Error('No action should run');}}));assert.equal(calls,0);assert.deepEqual(input,snapshot);assert.deepEqual(world,before);
  const accepted=createWorld({kind:'treasury-fx',startingCashMinor:2,blueprint:funding('2100-12-31T22:59:59.999Z') as any});
  assert.equal(accepted.now,'2100-12-31T23:59:59.999Z');assert.equal(accepted.treasuryTransfers[0].status,'settled');assert.equal(nativeBankBalance(accepted,accepted.blueprintManifest.refs.reserve.id),1);
});

test('explicit construction horizons use bounded real clock transitions and cannot skip completed funding or leave a federal tax year',()=>{
  const input={...funding('2024-01-01T09:00:00.125Z'),as_of:'2026-01-01T09:00:00.126Z'};
  const a=createWorld({kind:'treasury-fx',startingCashMinor:2,blueprint:input as any},'a'),b=createWorld({kind:'treasury-fx',startingCashMinor:2,blueprint:input as any},'b');
  assert.equal(a.now,input.as_of);assert.deepEqual({...a,id:'portable'},{...b,id:'portable'});
  assert.equal(a.treasuryTransfers[0].settled_at,'2024-01-01T10:00:00.125Z');
  const clocks=a.generationHistory.filter((row:any)=>row.action.type==='advance_to');assert.ok(clocks.length>=3);
  for(const step of clocks){const event=step.events.find((row:any)=>row.type==='simulation.time_advanced');assert.ok(event.elapsed_ms>0&&event.elapsed_ms<=365*86400000);assert.equal(step.action.at,step.at);}
  assert.throws(()=>validateBlueprint({...funding('2026-10-24T09:00:00.000Z'),as_of:'2026-10-24T09:59:59.999Z'}),(error:any)=>error.code==='invalid_blueprint_timeline');
  const federal={version:1,opening_at:'2026-10-24T09:00:00.000Z',as_of:'2027-01-01T00:00:00.000Z',payroll_policy:{ref:'policy',name:'Federal',mode:'us-federal-2026',tax_year:2026,jurisdiction:'US-federal',pay_frequency:'monthly'}};
  assert.throws(()=>validateBlueprint(federal),(error:any)=>error.code==='incompatible_blueprint_payroll_year'&&error.details.path==='as_of');
});

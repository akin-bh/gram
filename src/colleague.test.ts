import {test,expect} from 'bun:test';
import {createWorld,applyAction} from './world.ts';
import type {World,Actor} from './world.ts';
import {colleagueTick} from './colleague.ts';

const agent:Actor={id:'agent-world:test',role:'agent'},controller:Actor={id:'controller-local',role:'controller'};
const caseFile=async(_situation:string,_what:string,truth:string)=>({text:truth,phrased_by:'case-file' as const});
function harness(){
  const w=createWorld({kind:'cash-application',seed:42},'world-sim'),act=(input:any,actor:Actor)=>applyAction(w,input,actor).result;
  const work=(_world:string,input:any,actor:any)=>({result:act(input,actor)});
  return {w,act,tick:()=>colleagueTick('world-sim',w,work,caseFile),item:(reference:string)=>w.workItems.find((row:any)=>row.id===w.bankReceipts.find((receipt:any)=>receipt.bank_reference===reference)?.work_item_id)};
}

test('simulated colleagues act only when switched on, under sim: identities, from the case file',async()=>{
  const h=harness();h.act({type:'advance_time',hours:48},controller);
  const pine=h.item('JPM-88310502');
  h.act({type:'work_ask',work_item_id:pine.id,to_role:'accountant',question:'Pine & Post short-paid INV-2014 by $310. What happened?'},agent);
  expect(await h.tick()).toBeNull();
  h.act({type:'seat_configure',colleagues:true},controller);
  const answered=await h.tick();
  expect(answered!.phrased_by).toBe('case-file');
  const question=h.w.questions.at(-1);
  expect(question).toMatchObject({status:'answered',answered_by:'sim:dana.ruiz'});expect(question.answer).toMatch(/damaged half-barrel/);
  // A proposal that matches the case file is approved; one that does not is refused with the facts.
  h.act({type:'work_propose',work_item_id:pine.id,allocations:[{invoice_id:'INV-2014',amount_minor:189000}],adjustments:[{invoice_id:'INV-2014',kind:'bank_fee',amount_minor:31000}],confidence:0.6,reason:'Book the difference as a bank fee.'},agent);
  await h.tick();
  expect(h.item('JPM-88310502')).toMatchObject({state:'rejected',last_rejection:{by:'sim:dana.ruiz'}});
  expect(h.item('JPM-88310502').last_rejection.reason).toMatch(/credit memo/);
  h.act({type:'work_propose',work_item_id:pine.id,allocations:[{invoice_id:'INV-2014',amount_minor:189000}],adjustments:[{invoice_id:'INV-2014',kind:'deduction_pending',amount_minor:31000}],confidence:0.8,reason:'Hold the $310 as a deduction pending the credit memo.'},agent);
  await h.tick();
  expect(h.item('JPM-88310502')).toMatchObject({state:'posted',decision:{by:'sim:dana.ruiz',kind:'human'}});
  // Escalations are resolved the way the AR lead would, as a correction.
  const unidentified=h.item('JPM-88310519')??(h.act({type:'advance_time',hours:24},controller),h.item('JPM-88310519'));
  h.act({type:'work_escalate',work_item_id:unidentified.id,reason:'No payer or memo; two invoices match the amount.'},agent);
  await h.tick();
  expect(h.item('JPM-88310519')).toMatchObject({state:'posted',decision:{corrected:true}});
  expect(h.w.cashApplications.at(-1).allocations).toStrictEqual([{invoice_id:'INV-2015',amount_minor:275000}]);
  // The simulated controller approves clean policies and refuses ones with contrary history.
  h.act({type:'policy_propose',rule:{kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:20000,channels:['wire']},title:'Write off wire gaps up to $200',rationale:'Wires often arrive short; absorb the gap.',evidence:{queries:[{sql:'SELECT COUNT(*) FROM applied_lines',finding:'many short wires'}]}},agent);
  await h.tick();
  expect(h.w.policies.at(-1)).toMatchObject({status:'rejected',decided_by:'sim:controller'});expect(h.w.policies.at(-1).decision_reason).toMatch(/contrary/);
  h.act({type:'policy_propose',rule:{kind:'short_pay_writeoff',adjustment:'bank_fee',max_gap_minor:4500,channels:['wire']},title:'Wire fees up to $45',rationale:'Every wire short by $15 to $45 was booked to bank fees.',evidence:{queries:[{sql:'SELECT COUNT(*) FROM applied_lines',finding:'77 of 77'}]}},agent);
  await h.tick();
  expect(h.w.policies.at(-1)).toMatchObject({status:'active',decided_by:'sim:controller'});
  expect(await h.tick()).toBeNull();
});

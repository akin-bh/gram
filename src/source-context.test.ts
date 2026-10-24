import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createWorld} from './world.ts';
import {applySourceContext,validateSourceContext} from './source-context.ts';
const fixture=()=>createWorld({kind:'saas-collections',orderCount:2,name:'Collections'});
const context=(world:any)=>({parties:[{collection:'customers',id:world.customers[0].id,name:'Northstar Studio',email:world.customers[0].email}],documents:[{id:'context-service-acceptance',name:'Service review',body:'The team can inspect the linked invoice and recorded contract before collection.',source_refs:[world.invoices[0].id,world.contracts[0].id]}],messages:[{from:world.customers[0].email,to:['finance@simulation.test'],subject:'Invoice review',body:'Please review the invoice against our recorded agreement.',source_refs:[world.invoices[0].id,'context-service-acceptance']}]});
const economics=(w:any)=>structuredClone({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts,invoices:w.invoices,bills:w.bills,operations:w.operations,contracts:w.contracts,approvals:w.approvals});
test('generated context binds real source IDs while preserving every financial record and verified route',()=>{
  const w=fixture(),input=context(w),before=economics(w),originalEmail=w.customers[0].email,documents=w.documents.length,messages=w.messages.length;
  applySourceContext(w,input);assert.deepEqual(economics(w),before);assert.equal(w.customers[0].name,'Northstar Studio');assert.equal(w.customers[0].email,originalEmail);
  assert.equal(w.documents.length,documents+1);assert.equal(w.messages.length,messages+1);assert.equal(w.documents.at(-1).authority,'context-only');assert.equal(w.messages.at(-1).generated,true);
  assert.equal(w.documents.at(-1).record_facts[w.invoices[0].id].amount_minor,w.invoices[0].amount_minor);assert.match(w.sourceContext.digest,/^[a-f0-9]{64}$/);
});
test('hallucinated references, existing-record replacement, route changes and injected financial fields fail atomically',()=>{
  const w=fixture(),before=structuredClone(w),base=context(w);
  const variants=[{...base,parties:[{...base.parties[0],email:'redirect@fraud.test'}]},{...base,parties:[{...base.parties[0],id:'unknown-party'}]},{...base,parties:[{...base.parties[0],balance_minor:1}]},{...base,documents:[{...base.documents[0],source_refs:['invented-invoice']}]},{...base,documents:[{...base.documents[0],id:w.documents[0].id}]},{...base,documents:[{...base.documents[0],authority:'controller-approved'}]},{...base,messages:[{...base.messages[0],from:'real@example.com'}]},{...base,messages:[{...base.messages[0],subject:'Review\r\nBcc: attacker@fraud.test'}]}];
  for(const value of variants){assert.throws(()=>applySourceContext(w,value));assert.deepEqual(w,before);}
});
test('context documents cannot corroborate each other without canonical evidence or be applied twice',()=>{
  const w=fixture(),base=context(w);assert.throws(()=>validateSourceContext(w,{...base,documents:[{...base.documents[0],source_refs:[base.documents[0].id]}]}));
  assert.throws(()=>validateSourceContext(w,{...base,parties:[...base.parties,...base.parties]}));
  assert.throws(()=>validateSourceContext(w,{...base,documents:[...base.documents,...base.documents]}));
  applySourceContext(w,base);const before=structuredClone(w);assert.throws(()=>applySourceContext(w,base));assert.deepEqual(w,before);
});
test('generated documents cannot impersonate mail identities, thread identities or existing source titles',()=>{
  const w=fixture(),base=context(w),before=structuredClone(w);
  for(const id of ['context-mail-1','context-mail-future','context-thread-1','context-thread-future']){assert.throws(()=>applySourceContext(w,{...base,documents:[{...base.documents[0],id}],messages:[{...base.messages[0],source_refs:[id]}]}),/reserved message or thread namespaces/);assert.deepEqual(w,before);}
  const sourceName=w.documents[0].name;for(const name of [sourceName,sourceName.toUpperCase(),` ${sourceName} `]){assert.throws(()=>applySourceContext(w,{...base,documents:[{...base.documents[0],name}]}),/titles cannot duplicate/);assert.deepEqual(w,before);}
  assert.throws(()=>applySourceContext(w,{...base,documents:[base.documents[0],{...base.documents[0],id:'context-second-review',name:base.documents[0].name.toUpperCase()}]}),/titles cannot duplicate/);assert.deepEqual(w,before);
  const unicodeTitle='Ｐａｙｒｏｌｌ';w.documents.push({id:'source-payroll-title',name:'Payroll'});assert.throws(()=>validateSourceContext(w,{...base,documents:[{...base.documents[0],name:unicodeTitle}]}),/titles cannot duplicate/);
});

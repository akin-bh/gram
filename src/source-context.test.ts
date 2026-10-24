import {test,expect} from 'bun:test';
import {createWorld} from './world.ts';
import {applySourceContext,validateSourceContext} from './source-context.ts';
const fixture=()=>createWorld({kind:'saas-collections',orderCount:2,name:'Collections'});
const context=(world:any)=>({parties:[{collection:'customers',id:world.customers[0].id,name:'Northstar Studio',email:world.customers[0].email}],documents:[{id:'context-service-acceptance',name:'Service review',body:'The team can inspect the linked invoice and recorded contract before collection.',source_refs:[world.invoices[0].id,world.contracts[0].id]}],messages:[{from:world.customers[0].email,to:['finance@simulation.test'],subject:'Invoice review',body:'Please review the invoice against our recorded agreement.',source_refs:[world.invoices[0].id,'context-service-acceptance']}]});
const economics=(w:any)=>structuredClone({bank:w.bankTransactions,journals:w.journals,accounts:w.accounts,invoices:w.invoices,bills:w.bills,operations:w.operations,contracts:w.contracts,approvals:w.approvals});
test('generated context binds real source IDs while preserving every financial record and verified route',()=>{
  const w=fixture(),input=context(w),before=economics(w),originalEmail=w.customers[0].email,documents=w.documents.length,messages=w.messages.length;
  applySourceContext(w,input);expect(economics(w)).toStrictEqual(before);expect(w.customers[0].name).toBe('Northstar Studio');expect(w.customers[0].email).toBe(originalEmail);
  expect(w.documents.length).toBe(documents+1);expect(w.messages.length).toBe(messages+1);expect(w.documents.at(-1).authority).toBe('context-only');expect(w.messages.at(-1).generated).toBe(true);
  expect(w.documents.at(-1).record_facts[w.invoices[0].id].amount_minor).toBe(w.invoices[0].amount_minor);expect(w.sourceContext.digest).toMatch(/^[a-f0-9]{64}$/);
});
test('hallucinated references, existing-record replacement, route changes and injected financial fields fail atomically',()=>{
  const w=fixture(),before=structuredClone(w),base=context(w);
  const variants=[{...base,parties:[{...base.parties[0],email:'redirect@fraud.test'}]},{...base,parties:[{...base.parties[0],id:'unknown-party'}]},{...base,parties:[{...base.parties[0],balance_minor:1}]},{...base,documents:[{...base.documents[0],source_refs:['invented-invoice']}]},{...base,documents:[{...base.documents[0],id:w.documents[0].id}]},{...base,documents:[{...base.documents[0],authority:'controller-approved'}]},{...base,messages:[{...base.messages[0],from:'real@example.com'}]},{...base,messages:[{...base.messages[0],subject:'Review\r\nBcc: attacker@fraud.test'}]}];
  for(const value of variants){expect(()=>applySourceContext(w,value)).toThrow();expect(w).toStrictEqual(before);}
});
test('context documents cannot corroborate each other without canonical evidence or be applied twice',()=>{
  const w=fixture(),base=context(w);expect(()=>validateSourceContext(w,{...base,documents:[{...base.documents[0],source_refs:[base.documents[0].id]}]})).toThrow();
  expect(()=>validateSourceContext(w,{...base,parties:[...base.parties,...base.parties]})).toThrow();
  expect(()=>validateSourceContext(w,{...base,documents:[...base.documents,...base.documents]})).toThrow();
  applySourceContext(w,base);const before=structuredClone(w);expect(()=>applySourceContext(w,base)).toThrow();expect(w).toStrictEqual(before);
});
test('generated documents cannot impersonate mail identities, thread identities or existing source titles',()=>{
  const w=fixture(),base=context(w),before=structuredClone(w);
  for(const id of ['context-mail-1','context-mail-future','context-thread-1','context-thread-future']){expect(()=>applySourceContext(w,{...base,documents:[{...base.documents[0],id}],messages:[{...base.messages[0],source_refs:[id]}]})).toThrow(/reserved message or thread namespaces/);expect(w).toStrictEqual(before);}
  const sourceName=w.documents[0].name;for(const name of [sourceName,sourceName.toUpperCase(),` ${sourceName} `]){expect(()=>applySourceContext(w,{...base,documents:[{...base.documents[0],name}]})).toThrow(/titles cannot duplicate/);expect(w).toStrictEqual(before);}
  expect(()=>applySourceContext(w,{...base,documents:[base.documents[0],{...base.documents[0],id:'context-second-review',name:base.documents[0].name.toUpperCase()}]})).toThrow(/titles cannot duplicate/);expect(w).toStrictEqual(before);
  const unicodeTitle='Ｐａｙｒｏｌｌ';w.documents.push({id:'source-payroll-title',name:'Payroll'});expect(()=>validateSourceContext(w,{...base,documents:[{...base.documents[0],name:unicodeTitle}]})).toThrow(/titles cannot duplicate/);
});

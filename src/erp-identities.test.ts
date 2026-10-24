import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createWorld,DomainError} from './world.ts';
import type {World} from './world.ts';
import {erpIdentityAction,erpNativeKey,erpCanonicalIdentity,requireErpIdentitySpace,syncErpIdentities} from './erp-identities.ts';
const controller={id:'sap-controller',role:'controller'} as const;
function configure(w:World,action:any={type:'configure_erp',system:'sap-b1',external_event_id:'sap-config-source'},actor:any=controller){const events:any[]=[];const result=erpIdentityAction(w,action,actor,{id:prefix=>`${prefix}_${w.nextId++}`,fail:(code,message,status=400)=>{throw new DomainError(status,code,message);},emit:(type,data)=>events.push({type,data})});return {result:result.result,events};}
const fresh=()=>createWorld({kind:'saas-collections',orderCount:2});
const economic=(w:World)=>structuredClone({bank:w.bankTransactions,accounts:w.accounts,journals:w.journals,invoices:w.invoices,bills:w.bills,operations:w.operations});

test('SAP numeric identity reads require explicit controller configuration and never migrate legacy worlds',()=>{
 const w=fresh(),before=structuredClone(w);for(const read of [()=>requireErpIdentitySpace(w),()=>erpNativeKey(w,'Invoices','invoices',w.invoices[0].id),()=>erpCanonicalIdentity(w,'Invoices',1)])assert.throws(read,(e:any)=>e.code==='erp_configuration_required'&&e.status===409);syncErpIdentities(w);assert.deepEqual(w,before);assert.equal(Object.hasOwn(w,'erpConfigurations'),false);
 for(const actor of [{id:'operator',role:'operator'},{id:'agent',role:'agent'}])assert.throws(()=>configure(w,undefined,actor),(e:any)=>e.status===403);assert.deepEqual(w,before);
});

test('controller configuration creates one source identity and preserves every financial source',()=>{
 const w=fresh(),before=economic(w),out=configure(w);assert.deepEqual(economic(w),before);assert.equal(out.events.length,1);assert.equal(out.events[0].type,'erp.configured');assert.equal(w.erpConfigurations.length,1);assert.equal(out.result.configuration.id,w.erpIdentityRegistry.systems['sap-b1'].configuration_id);assert.equal(out.result.configuration.system,'sap-b1');assert.equal(out.result.identity_space.namespaces.Invoices.next_key,3);
 out.result.configuration.system='other';out.result.identity_space.namespaces.Invoices.entries[0].key=90;assert.equal(w.erpConfigurations[0].system,'sap-b1');assert.equal(erpNativeKey(w,'Invoices','invoices',w.invoices[0].id),1);
 const snapshot=structuredClone(w),again=configure(w,{type:'configure_erp',system:'sap-b1',external_event_id:'different-observation'});assert.deepEqual(w,snapshot);assert.equal(again.result.already_configured,true);assert.equal(again.events.length,0);assert.equal(again.result.configuration.external_event_id,'sap-config-source');
});

test('source collection identity prevents USD and foreign collisions and preserves keys after later insertions',()=>{
 const w=fresh();w.foreignInvoices=[{id:w.invoices[0].id},{id:'foreign-invoice-extra'}];configure(w);const foreignKey=erpNativeKey(w,'Invoices','foreignInvoices',w.invoices[0].id);assert.equal(foreignKey,3);assert.equal(erpNativeKey(w,'Invoices','invoices',w.invoices[0].id),1);
 w.invoices.unshift({id:'new-usd-source'});w.foreignInvoices.reverse();syncErpIdentities(w);assert.equal(erpNativeKey(w,'Invoices','invoices','new-usd-source'),5);assert.equal(erpNativeKey(w,'Invoices','foreignInvoices',w.invoices[1].id),foreignKey);
 const restored=JSON.parse(JSON.stringify(w));assert.deepEqual(requireErpIdentitySpace(restored),requireErpIdentitySpace(w));assert.deepEqual(erpCanonicalIdentity(restored,'Invoices',foreignKey),{key:3,source_collection:'foreignInvoices',source_id:w.invoices[1].id});
});

test('only posted journal sources receive keys; pending proposals and ordinary reads cannot allocate',()=>{
 const w=fresh();configure(w);const before=requireErpIdentitySpace(w),id='journal-posted-later';w.manualJournals=[{id:'manual-proposal',status:'awaiting_approval'}];syncErpIdentities(w);assert.deepEqual(requireErpIdentitySpace(w),before);
 w.journals.push({id});const snapshot=structuredClone(w);assert.throws(()=>erpNativeKey(w,'JournalEntries','journals',id),(e:any)=>e.code==='erp_identity_unassigned');assert.deepEqual(w,snapshot);syncErpIdentities(w);assert.equal(erpNativeKey(w,'JournalEntries','journals',id),before.namespaces.JournalEntries.next_key);assert.equal(erpCanonicalIdentity(w,'JournalEntries',before.namespaces.JournalEntries.next_key).source_id,id);
});

test('configuration and sync are atomic when canonical sources are malformed or namespace is exhausted',()=>{
 const w=fresh();w.invoices.push({...w.invoices[0]});const before=structuredClone(w);assert.throws(()=>configure(w),(e:any)=>e.code==='invalid_erp_identity_source');assert.deepEqual(w,before);
 const configured=fresh();configure(configured);const original=structuredClone(configured.erpIdentityRegistry);configured.invoices.push({id:'valid-addition'});configured.foreignBills=[{id:'bad'},{id:'bad'}];assert.throws(()=>syncErpIdentities(configured),(e:any)=>e.code==='invalid_erp_identity_source');assert.deepEqual(configured.erpIdentityRegistry,original);
 const exhausted=fresh();exhausted.invoices=exhausted.invoices.slice(0,1);configure(exhausted);exhausted.erpIdentityRegistry.systems['sap-b1'].namespaces.Invoices={next_key:2147483648,entries:[{key:2147483647,source_collection:'invoices',source_id:exhausted.invoices[0].id}]};exhausted.invoices.push({id:'cannot-allocate'});const map=structuredClone(exhausted.erpIdentityRegistry);assert.throws(()=>syncErpIdentities(exhausted),(e:any)=>e.code==='erp_identity_exhausted');assert.deepEqual(exhausted.erpIdentityRegistry,map);
});

test('registry integrity rejects missing sources, duplicate assignments, counter rewrites and source config mismatch',()=>{
 const w=fresh();configure(w);for(const mutate of [(x:World)=>x.invoices.shift(),(x:World)=>x.erpIdentityRegistry.systems['sap-b1'].namespaces.Invoices.entries.push({...x.erpIdentityRegistry.systems['sap-b1'].namespaces.Invoices.entries[0]}),(x:World)=>x.erpIdentityRegistry.systems['sap-b1'].namespaces.Invoices.next_key++,(x:World)=>x.erpConfigurations[0].external_event_id='changed',(x:World)=>x.erpConfigurations.push({...x.erpConfigurations[0]})]){const bad=structuredClone(w);mutate(bad);const before=structuredClone(bad);assert.throws(()=>requireErpIdentitySpace(bad),DomainError);assert.deepEqual(bad,before);}
 for(const key of [0,-1,1.2,NaN,Infinity,2147483648])assert.throws(()=>erpCanonicalIdentity(w,'Invoices',key),(e:any)=>e.code==='invalid_erp_native_key');assert.throws(()=>erpCanonicalIdentity(w,'Invoices',999),(e:any)=>e.status===404);
 for(const action of [{type:'configure_erp',system:'xero',external_event_id:'x'},{type:'configure_erp',system:'sap-b1',external_event_id:''},{type:'configure_erp',system:'sap-b1',external_event_id:'x',reset:true}])assert.throws(()=>configure(fresh(),action),DomainError);
});

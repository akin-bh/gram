import {test,expect} from 'bun:test';
import {createWorld,DomainError} from './world.ts';
import type {World} from './world.ts';
import {erpIdentityAction,erpNativeKey,erpCanonicalIdentity,requireErpIdentitySpace,syncErpIdentities} from './erp-identities.ts';
const controller={id:'sap-controller',role:'controller'} as const;
function configure(w:World,action:any={type:'configure_erp',system:'sap-b1',external_event_id:'sap-config-source'},actor:any=controller){const events:any[]=[];const result=erpIdentityAction(w,action,actor,{id:prefix=>`${prefix}_${w.nextId++}`,fail:(code,message,status=400)=>{throw new DomainError(status,code,message);},emit:(type,data)=>events.push({type,data})});return {result:result.result,events};}
const fresh=()=>createWorld({kind:'saas-collections',orderCount:2});
const economic=(w:World)=>structuredClone({bank:w.bankTransactions,accounts:w.accounts,journals:w.journals,invoices:w.invoices,bills:w.bills,operations:w.operations});

test('SAP numeric identity reads require explicit controller configuration and never migrate legacy worlds',()=>{
 const w=fresh(),before=structuredClone(w);for(const read of [()=>requireErpIdentitySpace(w),()=>erpNativeKey(w,'Invoices','invoices',w.invoices[0].id),()=>erpCanonicalIdentity(w,'Invoices',1)])expect(read).toThrowSatisfying((e:any)=>e.code==='erp_configuration_required'&&e.status===409);syncErpIdentities(w);expect(w).toStrictEqual(before);expect(Object.hasOwn(w,'erpConfigurations')).toBe(false);
 for(const actor of [{id:'operator',role:'operator'},{id:'agent',role:'agent'}])expect(()=>configure(w,undefined,actor)).toThrowSatisfying((e:any)=>e.status===403);expect(w).toStrictEqual(before);
});

test('controller configuration creates one source identity and preserves every financial source',()=>{
 const w=fresh(),before=economic(w),out=configure(w);expect(economic(w)).toStrictEqual(before);expect(out.events.length).toBe(1);expect(out.events[0].type).toBe('erp.configured');expect(w.erpConfigurations.length).toBe(1);expect(out.result.configuration.id).toBe(w.erpIdentityRegistry.systems['sap-b1'].configuration_id);expect(out.result.configuration.system).toBe('sap-b1');expect(out.result.identity_space.namespaces.Invoices.next_key).toBe(3);
 out.result.configuration.system='other';out.result.identity_space.namespaces.Invoices.entries[0].key=90;expect(w.erpConfigurations[0].system).toBe('sap-b1');expect(erpNativeKey(w,'Invoices','invoices',w.invoices[0].id)).toBe(1);
 const snapshot=structuredClone(w),again=configure(w,{type:'configure_erp',system:'sap-b1',external_event_id:'different-observation'});expect(w).toStrictEqual(snapshot);expect(again.result.already_configured).toBe(true);expect(again.events.length).toBe(0);expect(again.result.configuration.external_event_id).toBe('sap-config-source');
});

test('source collection identity prevents USD and foreign collisions and preserves keys after later insertions',()=>{
 const w=fresh();w.foreignInvoices=[{id:w.invoices[0].id},{id:'foreign-invoice-extra'}];configure(w);const foreignKey=erpNativeKey(w,'Invoices','foreignInvoices',w.invoices[0].id);expect(foreignKey).toBe(3);expect(erpNativeKey(w,'Invoices','invoices',w.invoices[0].id)).toBe(1);
 w.invoices.unshift({id:'new-usd-source'});w.foreignInvoices.reverse();syncErpIdentities(w);expect(erpNativeKey(w,'Invoices','invoices','new-usd-source')).toBe(5);expect(erpNativeKey(w,'Invoices','foreignInvoices',w.invoices[1].id)).toBe(foreignKey);
 const restored=JSON.parse(JSON.stringify(w));expect(requireErpIdentitySpace(restored)).toStrictEqual(requireErpIdentitySpace(w));expect(erpCanonicalIdentity(restored,'Invoices',foreignKey)).toStrictEqual({key:3,source_collection:'foreignInvoices',source_id:w.invoices[1].id});
});

test('only posted journal sources receive keys; pending proposals and ordinary reads cannot allocate',()=>{
 const w=fresh();configure(w);const before=requireErpIdentitySpace(w),id='journal-posted-later';w.manualJournals=[{id:'manual-proposal',status:'awaiting_approval'}];syncErpIdentities(w);expect(requireErpIdentitySpace(w)).toStrictEqual(before);
 w.journals.push({id});const snapshot=structuredClone(w);expect(()=>erpNativeKey(w,'JournalEntries','journals',id)).toThrowSatisfying((e:any)=>e.code==='erp_identity_unassigned');expect(w).toStrictEqual(snapshot);syncErpIdentities(w);expect(erpNativeKey(w,'JournalEntries','journals',id)).toBe(before.namespaces.JournalEntries.next_key);expect(erpCanonicalIdentity(w,'JournalEntries',before.namespaces.JournalEntries.next_key).source_id).toBe(id);
});

test('configuration and sync are atomic when canonical sources are malformed or namespace is exhausted',()=>{
 const w=fresh();w.invoices.push({...w.invoices[0]});const before=structuredClone(w);expect(()=>configure(w)).toThrowSatisfying((e:any)=>e.code==='invalid_erp_identity_source');expect(w).toStrictEqual(before);
 const configured=fresh();configure(configured);const original=structuredClone(configured.erpIdentityRegistry);configured.invoices.push({id:'valid-addition'});configured.foreignBills=[{id:'bad'},{id:'bad'}];expect(()=>syncErpIdentities(configured)).toThrowSatisfying((e:any)=>e.code==='invalid_erp_identity_source');expect(configured.erpIdentityRegistry).toStrictEqual(original);
 const exhausted=fresh();exhausted.invoices=exhausted.invoices.slice(0,1);configure(exhausted);exhausted.erpIdentityRegistry.systems['sap-b1'].namespaces.Invoices={next_key:2147483648,entries:[{key:2147483647,source_collection:'invoices',source_id:exhausted.invoices[0].id}]};exhausted.invoices.push({id:'cannot-allocate'});const map=structuredClone(exhausted.erpIdentityRegistry);expect(()=>syncErpIdentities(exhausted)).toThrowSatisfying((e:any)=>e.code==='erp_identity_exhausted');expect(exhausted.erpIdentityRegistry).toStrictEqual(map);
});

test('registry integrity rejects missing sources, duplicate assignments, counter rewrites and source config mismatch',()=>{
 const w=fresh();configure(w);for(const mutate of [(x:World)=>x.invoices.shift(),(x:World)=>x.erpIdentityRegistry.systems['sap-b1'].namespaces.Invoices.entries.push({...x.erpIdentityRegistry.systems['sap-b1'].namespaces.Invoices.entries[0]}),(x:World)=>x.erpIdentityRegistry.systems['sap-b1'].namespaces.Invoices.next_key++,(x:World)=>x.erpConfigurations[0].external_event_id='changed',(x:World)=>x.erpConfigurations.push({...x.erpConfigurations[0]})]){const bad=structuredClone(w);mutate(bad);const before=structuredClone(bad);expect(()=>requireErpIdentitySpace(bad)).toThrow(DomainError);expect(bad).toStrictEqual(before);}
 for(const key of [0,-1,1.2,NaN,Infinity,2147483648])expect(()=>erpCanonicalIdentity(w,'Invoices',key)).toThrowSatisfying((e:any)=>e.code==='invalid_erp_native_key');expect(()=>erpCanonicalIdentity(w,'Invoices',999)).toThrowSatisfying((e:any)=>e.status===404);
 for(const action of [{type:'configure_erp',system:'xero',external_event_id:'x'},{type:'configure_erp',system:'sap-b1',external_event_id:''},{type:'configure_erp',system:'sap-b1',external_event_id:'x',reset:true}])expect(()=>configure(fresh(),action)).toThrow(DomainError);
});

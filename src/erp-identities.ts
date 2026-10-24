/** Native integer identities are durable vendor-space metadata. Reads never
 * allocate keys, and configuration does not alter source or financial rows. */
import {DomainError} from './world.ts';
import type {World,Action,Actor} from './world.ts';

export const erpIdentityRequirements={configure_erp:{role:'controller',system:'sap-b1',external:true}} as const;
export type SapEntity='Invoices'|'PurchaseInvoices'|'JournalEntries';
export type SapSourceCollection='invoices'|'foreignInvoices'|'bills'|'foreignBills'|'journals';
export type ErpIdentityEntry={key:number;source_collection:SapSourceCollection;source_id:string};
export type ErpIdentityNamespace={next_key:number;entries:ErpIdentityEntry[]};
export type ErpIdentitySpace={configuration_id:string;configured_at:string;configured_by:string;external_event_id:string;namespaces:Record<SapEntity,ErpIdentityNamespace>};
export type ErpIdentityRegistry={version:1;systems:{'sap-b1':ErpIdentitySpace}};
export type ErpIdentityHooks={id:(prefix:string)=>string;fail:(code:string,message:string,status?:number)=>never;emit:(type:string,data?:any)=>void};
const sources:Record<SapEntity,readonly SapSourceCollection[]>={Invoices:['invoices','foreignInvoices'],PurchaseInvoices:['bills','foreignBills'],JournalEntries:['journals']};
const entities=Object.keys(sources) as SapEntity[],MAX_KEY=2147483647;
function fail(code:string,message:string,status=409):never{throw new DomainError(status,code,message);}
const identity=(collection:string,id:string)=>JSON.stringify([collection,id]);
function exactFields(value:any,allowed:string[]){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));}
function sourceRows(w:World,entity:SapEntity){
 const rows:{source_collection:SapSourceCollection;source_id:string}[]=[];
 for(const collection of sources[entity]){
  const values=w[collection]??[];if(!Array.isArray(values))fail('invalid_erp_identity_source','Canonical ERP source collection must be an array');
  const seen=new Set<string>();for(const record of values){if(!record||typeof record.id!=='string'||!record.id||record.id.length>200||seen.has(record.id))fail('invalid_erp_identity_source','Canonical ERP sources require unique immutable record IDs');seen.add(record.id);rows.push({source_collection:collection,source_id:record.id});}
 }return rows;
}
function checked(w:World):ErpIdentitySpace{
 const registry=w.erpIdentityRegistry as ErpIdentityRegistry|undefined;
 if(registry===undefined)fail('erp_configuration_required','Configure SAP Business One identity space through the controller before reading native numeric entities');
 if(!exactFields(registry,['version','systems'])||registry.version!==1||!exactFields(registry.systems,['sap-b1'])||!registry.systems['sap-b1'])fail('invalid_erp_identity_registry','Unsupported ERP identity registry');
 const space=registry.systems['sap-b1'];
 if(!exactFields(space,['configuration_id','configured_at','configured_by','external_event_id','namespaces'])||![space.configuration_id,space.configured_at,space.configured_by,space.external_event_id].every(value=>typeof value==='string'&&value.length>0)||!exactFields(space.namespaces,entities)||entities.some(entity=>!space.namespaces[entity]))fail('invalid_erp_identity_registry','ERP identity configuration is incomplete');
 const configurations=w.erpConfigurations;if(!Array.isArray(configurations)||configurations.filter((row:any)=>row?.system==='sap-b1').length!==1)fail('invalid_erp_identity_registry','ERP identity registry requires one immutable configuration source');
 const configuration=configurations.find((row:any)=>row.id===space.configuration_id);if(!configuration||configuration.system!=='sap-b1'||configuration.configured_at!==space.configured_at||configuration.configured_by!==space.configured_by||configuration.external_event_id!==space.external_event_id)fail('invalid_erp_identity_registry','ERP identity configuration source does not match its registry');
 for(const entity of entities){
  const namespace=space.namespaces[entity];if(!exactFields(namespace,['next_key','entries'])||!Number.isInteger(namespace.next_key)||namespace.next_key<1||namespace.next_key>MAX_KEY+1||!Array.isArray(namespace.entries))fail('invalid_erp_identity_registry','Native identity counter is invalid');
  const keys=new Set<number>(),mapped=new Set<string>(),existing=new Set(sourceRows(w,entity).map(row=>identity(row.source_collection,row.source_id)));let maximum=0;
  for(const entry of namespace.entries){
   if(!exactFields(entry,['key','source_collection','source_id'])||!Number.isInteger(entry.key)||entry.key<1||entry.key>MAX_KEY||!sources[entity].includes(entry.source_collection)||typeof entry.source_id!=='string'||!entry.source_id)fail('invalid_erp_identity_registry','Native identity entry is invalid');
   const source=identity(entry.source_collection,entry.source_id);if(keys.has(entry.key)||mapped.has(source))fail('invalid_erp_identity_registry','Native identities cannot be duplicated or reassigned');if(!existing.has(source))fail('erp_identity_source_missing','A native identity cannot outlive or be reassigned from its canonical source');keys.add(entry.key);mapped.add(source);maximum=Math.max(maximum,entry.key);
  }
  if(namespace.next_key!==maximum+1)fail('invalid_erp_identity_registry','Native identity allocation must retain its exact monotonic counter');
 }
 return space;
}

/** Returns a detached view. No read path assigns a key or fills missing rows. */
export function requireErpIdentitySpace(w:World):ErpIdentitySpace{return structuredClone(checked(w));}
export function erpNativeKey(w:World,entity:SapEntity,collection:SapSourceCollection,id:string):number{
 if(!Object.hasOwn(sources,entity)||!sources[entity].includes(collection))fail('invalid_erp_identity_namespace','Invalid SAP native entity/source namespace');
 const entry=checked(w).namespaces[entity].entries.find(row=>row.source_collection===collection&&row.source_id===id);
 return entry?.key??fail('erp_identity_unassigned','Canonical source does not yet have a native identity; no key is allocated by this read');
}
export function erpCanonicalIdentity(w:World,entity:SapEntity,key:number):ErpIdentityEntry{
 if(!Object.hasOwn(sources,entity)||!Number.isInteger(key)||key<1||key>MAX_KEY)fail('invalid_erp_native_key','SAP native entity keys must be positive Int32 values',400);
 const entry=checked(w).namespaces[entity].entries.find(row=>row.key===key);if(!entry)fail('resource_missing','Native entity does not exist in this world',404);return structuredClone(entry);
}

/** Called only by the domain after a successful mutation. Build and validate
 * a detached map before committing any new keys; proposals are not journals. */
export type ErpIdentityAssignment=ErpIdentityEntry&{entity:SapEntity};
export function syncErpIdentities(w:World):ErpIdentityAssignment[]{
 if(w.erpIdentityRegistry===undefined)return [];
 const existing=checked(w),space=structuredClone(existing),assigned:ErpIdentityAssignment[]=[];
 for(const entity of entities){const namespace=space.namespaces[entity],known=new Set(namespace.entries.map(row=>identity(row.source_collection,row.source_id)));for(const row of sourceRows(w,entity)){if(known.has(identity(row.source_collection,row.source_id)))continue;if(namespace.next_key>MAX_KEY)fail('erp_identity_exhausted','SAP native identity namespace exhausted');const entry={key:namespace.next_key++,...row};namespace.entries.push(entry);assigned.push({entity,...entry});known.add(identity(row.source_collection,row.source_id));}}
 w.erpIdentityRegistry={version:1,systems:{'sap-b1':space}} satisfies ErpIdentityRegistry;return assigned;
}

export function erpIdentityAction(w:World,action:Action,actor:Actor,h:ErpIdentityHooks):{handled:boolean;result?:any}{
 if((action.type??action.action)!=='configure_erp')return {handled:false};
 if(actor.role!=='controller')h.fail('controller_required','ERP identity space configuration is an independent controller source fact',403);
 if(!exactFields(action,['type','action','system','external_event_id'])||action.system!=='sap-b1'||typeof action.external_event_id!=='string'||!action.external_event_id.trim()||action.external_event_id.length>200)h.fail('invalid_erp_configuration','Configure only system sap-b1 with a stable external_event_id');
 if(w.erpIdentityRegistry!==undefined){const space=requireErpIdentitySpace(w);return {handled:true,result:{system:'sap-b1',configured:true,already_configured:true,configuration:structuredClone(w.erpConfigurations.find((row:any)=>row.id===space.configuration_id)),identity_space:space}};}
 if(w.erpConfigurations!==undefined&&(!Array.isArray(w.erpConfigurations)||w.erpConfigurations.some((row:any)=>row.system==='sap-b1')))h.fail('invalid_erp_configuration','Existing ERP configuration cannot be replaced');
 const originalConfigurations=w.erpConfigurations,originalNextId=w.nextId,configuration={id:h.id('erp-config'),system:'sap-b1',configured_at:w.now,configured_by:actor.id,external_event_id:action.external_event_id};
 w.erpConfigurations=[...(w.erpConfigurations??[]),configuration];w.erpIdentityRegistry={version:1,systems:{'sap-b1':{configuration_id:configuration.id,configured_at:w.now,configured_by:actor.id,external_event_id:action.external_event_id,namespaces:Object.fromEntries(entities.map(entity=>[entity,{next_key:1,entries:[]}]))}}};
 try{syncErpIdentities(w);}catch(error){delete w.erpIdentityRegistry;if(originalConfigurations===undefined)delete w.erpConfigurations;else w.erpConfigurations=originalConfigurations;w.nextId=originalNextId;throw error;}
 const space=requireErpIdentitySpace(w);h.emit('erp.configured',{configuration_id:configuration.id,system:'sap-b1',counts:Object.fromEntries(entities.map(entity=>[entity,space.namespaces[entity].entries.length]))});return {handled:true,result:{system:'sap-b1',configured:true,already_configured:false,configuration:structuredClone(configuration),identity_space:space}};
}

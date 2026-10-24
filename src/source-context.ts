import {z} from 'zod';
import {validateMailContent} from './mail.ts';
import type {World} from './world.ts';

const ref=z.string().min(1).max(200);
const refs=z.array(ref).min(1).max(30);
const text=z.string().trim().min(1).max(12000);
const email=z.string().email().max(254).regex(/^[^\s<>]+@[^\s<>]+\.test$/i,'Use synthetic .test email addresses');
export const sourceContextSchema=z.object({
  parties:z.array(z.object({collection:z.enum(['customers','vendors','employees']),id:ref,name:z.string().trim().min(1).max(120),email:email.optional()}).strict()).max(300),
  documents:z.array(z.object({id:ref,name:z.string().trim().min(1).max(120),body:text,source_refs:refs}).strict()).max(40),
  messages:z.array(z.object({from:email,to:z.array(email).min(1).max(10),subject:z.string().trim().min(1).max(200),body:text,source_refs:refs}).strict()).max(60),
}).strict();
export type SourceContext=z.infer<typeof sourceContextSchema>;
const MAX_BYTES=384*1024;
function fail(message:string):never{throw new Error(message);}
function recordIndex(world:World){
  const records=new Map<string,any>();
  // Source references name actual canonical records, never arbitrary strings
  // inside prose, an actor identifier, or a value invented by the generator.
  for(const [collection,values] of Object.entries(world))if(Array.isArray(values)&&collection!=='generationHistory'&&collection!=='externalEvents'){
    for(const value of values)if(value&&typeof value.id==='string')records.set(value.id,value);
  }
  return records;
}
export function validateSourceContext(world:World,input:unknown):SourceContext{
  const parsed=sourceContextSchema.parse(input);
  if(Buffer.byteLength(JSON.stringify(parsed),'utf8')>MAX_BYTES)fail('Generated source context exceeds the 384 KiB combined limit');
  const records=recordIndex(world),partyIds=new Set<string>(),documentIds=new Set<string>();
  const normalizedName=(name:string)=>name.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const documentNames=new Set(world.documents.filter(row=>typeof row.name==='string').map(row=>normalizedName(row.name)));
  for(const party of parsed.parties){
    const key=party.collection+':'+party.id;if(partyIds.has(key))fail('A source party may be named only once');partyIds.add(key);
    const original=(world[party.collection]??[]).find((record:any)=>record.id===party.id);
    if(!original)fail(`Unknown ${party.collection} source: ${party.id}`);
    if(party.email!==undefined&&party.email!==original.email)fail('Generated context cannot replace a verified source email or payment route');
  }
  for(const doc of parsed.documents){
    if(!/^context-[a-z0-9][a-z0-9-]{0,180}$/.test(doc.id))fail('Generated document IDs must use the context- namespace');
    if(/^context-(?:mail|thread)-/.test(doc.id))fail('Generated document IDs cannot use reserved message or thread namespaces');
    if(records.has(doc.id)||documentIds.has(doc.id))fail('Generated documents cannot replace an existing source record');documentIds.add(doc.id);
    const name=normalizedName(doc.name);if(documentNames.has(name))fail('Generated document titles cannot duplicate an existing source or another context document');documentNames.add(name);
  }
  const checkRefs=(ids:string[],requireCanonical:boolean)=>{
    if(new Set(ids).size!==ids.length)fail('Generated source references must be distinct');
    if(ids.some(id=>!records.has(id)&&!documentIds.has(id)))fail('Generated source references must resolve to actual records');
    if(requireCanonical&&!ids.some(id=>records.has(id)))fail('Each generated document must cite an existing canonical source');
  };
  for(const doc of parsed.documents)checkRefs(doc.source_refs,true);
  for(const [index,message] of parsed.messages.entries()){
    checkRefs(message.source_refs,false);
    if(records.has(`context-mail-${index+1}`)||records.has(`context-thread-${index+1}`))fail('Generated message identity already exists');
    validateMailContent({from:message.from,to:message.to,subject:message.subject,body:message.body,direction:'inbound'});
  }
  return parsed;
}
/** Adds context to a not-yet-persisted world. Economic authority remains in
 * canonical source facts and domain actions; generated prose grants none.
 */
export function applySourceContext(world:World,input:unknown):World{
  const context=validateSourceContext(world,input),records=recordIndex(world);
  const facts=(ids:string[])=>Object.fromEntries(ids.filter(id=>records.has(id)).map(id=>{
    const row=records.get(id),fields=Object.fromEntries(Object.entries(row).filter(([key,value])=>['id','type','status','currency','posted_at','created_at','period_start','period_end','kind'].includes(key)||(key.endsWith('_minor')&&Number.isSafeInteger(value))));
    return [id,fields];
  }));
  const documents=context.documents.map(doc=>({...doc,type:'generated-context',created_at:world.now,authority:'context-only',generated:true,record_facts:facts(doc.source_refs)}));
  const messages=context.messages.map((message,index)=>({id:`context-mail-${index+1}`,thread_id:`context-thread-${index+1}`,...validateMailContent({...message,direction:'inbound'}),created_at:world.now,direction:'inbound',labelIds:['INBOX','UNREAD'],delivery_status:'delivered',source_refs:[...message.source_refs],authority:'context-only',generated:true,record_facts:facts(message.source_refs)}));
  for(const party of context.parties){const row=world[party.collection].find((item:any)=>item.id===party.id);row[party.collection==='employees'?'display_name':'name']=party.name;}
  world.documents.push(...documents);world.messages.push(...messages);
  world.sourceContext={...context,digest:new Bun.CryptoHasher('sha256').update(JSON.stringify(context)).digest('hex'),authority:'context-only'};
  return world;
}

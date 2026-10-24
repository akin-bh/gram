/** Prepared manual adjustments are immutable proposals, not economic receipts.
 * They never reserve cash or defer an accepted posting: a distinct controller
 * posts synchronously only when the dated source proposal is still valid.
 */
import {createHash} from 'node:crypto';
import {requireErpIdentitySpace} from './erp-identities.ts';
import {DomainError,type Action,type Actor,type World} from './world.ts';

export const manualJournalSystems=['xero','zoho-books','sage-intacct','sap-b1'] as const;
export function manualJournalOrigin(record:any){return record.accounting_system===undefined?'xero':record.accounting_system;}
/** The requested connector is bounded before authorization; an existing proposal
 * must then match it. A healthy mirror never grants posting authority. */
export function manualJournalProvider(action:Action):string|undefined{
  if(!['prepare_manual_journal','submit_manual_journal','approve_manual_journal'].includes(action.type??action.action??''))return undefined;
  const system=action.accounting_system===undefined?'xero':action.accounting_system;
  if(!manualJournalSystems.includes(system))throw new DomainError(400,'unsupported_accounting_system','Choose a declared journal accounting system');
  return system;
}
export const manualJournalCollections={'manual-journal':'manualJournals','journal-register':'manualJournalRegisters'};
export const manualJournalFeeds=Object.keys(manualJournalCollections);
export const manualJournalRequirements:Record<string,{role:'operator'|'controller';system:string;systems?:readonly string[];internal?:boolean;external?:boolean}>={
  prepare_manual_journal:{role:'operator',system:'xero',systems:manualJournalSystems},submit_manual_journal:{role:'operator',system:'xero',systems:manualJournalSystems},
  record_journal_register:{role:'controller',system:'sage-intacct',external:true},
  approve_manual_journal:{role:'operator',system:'xero',systems:manualJournalSystems,internal:true},
};
export type ManualJournalHooks={
  id:(prefix:string)=>string;fail:(code:string,message:string,status?:number)=>never;
  available:(systems:string[])=>void;emit:(type:string,data?:any)=>void;
  validate:(lines:any[])=>void;post:(lines:any[],sourceId:string,description:string)=>any;
};
export function normalizeManualJournals(w:World){w.manualJournals??=[];w.manualJournalRegisters??=[];}
const canonical=(value:any):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const hash=(value:any)=>createHash('sha256').update(canonical(value)).digest('hex');
export const manualJournalVersion=(record:any)=>hash(record);
const sourceVersion=(record:any)=>hash({...(record.accounting_system!==undefined?{accounting_system:record.accounting_system}:{}),...(record.erp_configuration_id!==undefined?{erp_configuration_id:record.erp_configuration_id,erp_configuration_snapshot:record.erp_configuration_snapshot}:{}),...(record.journal_register_id!==undefined?{journal_register_id:record.journal_register_id,journal_register_snapshot:record.journal_register_snapshot}:{}),description:record.description,date:record.date,currency:record.currency,lines:record.lines,total_minor:record.total_minor,source_document_ids:record.source_document_ids,source_documents:record.source_documents});
function fields(value:any,allowed:string[],h:ManualJournalHooks){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))h.fail('invalid_manual_journal_field','Manual journal contains an unsupported field');}
function text(value:any,name:string,limit:number,h:ManualJournalHooks){if(typeof value!=='string'||!value.trim()||value.length>limit)h.fail('invalid_text',`${name} must be nonempty text of at most ${limit} characters`);return value.trim();}
function lines(raw:any,h:ManualJournalHooks){
  if(!Array.isArray(raw)||raw.length<2||raw.length>100)h.fail('invalid_journal','A journal needs 2–100 lines');
  let debit=0n,credit=0n;
  const normalized=raw.map((line:any)=>{
    fields(line,['account_id','debit_minor','credit_minor','currency','description'],h);
    const account_id=text(line.account_id,'account_id',200,h),debit_minor=line.debit_minor===undefined?0:line.debit_minor,credit_minor=line.credit_minor===undefined?0:line.credit_minor;
    for(const amount of [debit_minor,credit_minor])if(!Number.isSafeInteger(amount)||amount<0||amount>1e12)h.fail('invalid_integer','Journal amounts must be integer USD cents in 0..1000000000000');
    if((!debit_minor&&!credit_minor)||(debit_minor&&credit_minor))h.fail('invalid_journal','Every line must have exactly one debit or credit');
    if(line.currency!==undefined&&line.currency!=='USD')h.fail('unsupported_currency','Prepared manual journals support USD only');
    debit+=BigInt(debit_minor);credit+=BigInt(credit_minor);
    return {account_id,debit_minor,credit_minor,currency:'USD',...(line.description!==undefined?{description:text(line.description,'line description',500,h)}:{})};
  });
  if(debit!==credit)h.fail('unbalanced_journal','Journal debits must equal credits');
  if(debit>1000000000000n)h.fail('invalid_integer','Journal total must not exceed 1000000000000 USD cents');
  const effects=new Map<string,bigint>();for(const line of normalized)effects.set(line.account_id,(effects.get(line.account_id)??0n)+BigInt(line.debit_minor)-BigInt(line.credit_minor));
  if([...effects.values()].every(value=>value===0n))h.fail('invalid_journal','A manual journal must change at least one account balance');
  h.validate(normalized);return {lines:normalized,total_minor:Number(debit)};
}
function assertSource(w:World,record:any,h:ManualJournalHooks){
  if(sourceVersion(record)!==record.source_version)h.fail('manual_journal_source_changed','Immutable journal proposal does not match its source fingerprint',409);
  for(let i=0;i<record.source_document_ids.length;i++){
    const current=w.documents.find(row=>row.id===record.source_document_ids[i]);
    if(!current||hash(current)!==hash(record.source_documents[i]))h.fail('manual_journal_source_changed','A cited document changed; prepare a new proposal and reject any pending approval for this one',409);
  }
  if(manualJournalOrigin(record)==='sap-b1'){const space=requireErpIdentitySpace(w),configuration=w.erpConfigurations.find((row:any)=>row.id===space.configuration_id);if(configuration?.id!==record.erp_configuration_id||hash(configuration)!==hash(record.erp_configuration_snapshot))h.fail('manual_journal_configuration_changed','ERP configuration changed since preparation',409);}
  if(record.journal_register_id){const register=w.manualJournalRegisters?.find((row:any)=>row.id===record.journal_register_id);if(!register||hash(register)!==hash(record.journal_register_snapshot))h.fail('manual_journal_register_changed','Journal register changed since preparation',409);}
  if(record.date!==w.now.slice(0,10))h.fail('manual_journal_date_changed','Journal date is no longer the current simulation day; prepare a new proposal and reject any pending approval for this one',409);
}
function ready(w:World,record:any,h:ManualJournalHooks){h.available([manualJournalOrigin(record),'ledger']);if(w.periodClosed)h.fail('period_closed','Reopen the accounting period before submitting or posting',409);assertSource(w,record,h);h.validate(record.lines);}
function response(w:World,record:any){return {manual_journal:record,version:manualJournalVersion(record),status:record.status,...(record.approval_id?{approval_id:record.approval_id}:{}),...(record.journal_id?{journal:w.journals.find(row=>row.id===record.journal_id)}:{})};}
function submit(w:World,record:any,actor:Actor,h:ManualJournalHooks){
  if(record.status==='awaiting_approval')return response(w,record);
  if(record.status!=='draft')h.fail('manual_journal_not_draft','Only a draft manual journal can be submitted',409);
  ready(w,record,h);
  const approval={id:h.id('approval'),status:'pending',requested_by:actor.id,requester_role:actor.role,action:{type:'approve_manual_journal',manual_journal_id:record.id,source_version:record.source_version,...(record.accounting_system!==undefined?{accounting_system:record.accounting_system}:{})},amount_minor:record.total_minor,created_at:w.now};
  record.status='awaiting_approval';record.approval_id=approval.id;record.submitted_by=actor.id;record.submitted_at=w.now;w.approvals.push(approval);
  h.emit('manual_journal.submitted',{manual_journal_id:record.id,approval_id:approval.id});h.emit('approval.requested',{approval_id:approval.id,manual_journal_id:record.id,amount_minor:record.total_minor});
  return response(w,record);
}
export function manualJournalAction(w:World,action:Action,actor:Actor,h:ManualJournalHooks,approved?:string):{handled:boolean;result?:any}{
  const type=action.type??action.action;if(!type||!manualJournalRequirements[type])return {handled:false};
  const result=(value:any)=>({handled:true,result:value});
  if(type==='record_journal_register'){
    if(actor.role!=='controller')h.fail('controller_required','Only a controller may configure a journal register',403);
    fields(action,['type','action','accounting_system','code','name','external_event_id'],h);
    if(action.accounting_system!=='sage-intacct')h.fail('unsupported_accounting_system','Journal registers are supported for Sage Intacct');
    const code=text(action.code,'code',20,h),name=text(action.name,'name',120,h);
    if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/.test(code))h.fail('invalid_journal_register','Use a simple journal register code');
    if(w.manualJournalRegisters.some((row:any)=>row.accounting_system===action.accounting_system&&row.code.toLowerCase()===code.toLowerCase()))h.fail('journal_register_exists','This register code already exists',409);
    const register={id:h.id('journal-register'),accounting_system:'sage-intacct',code,name,currency:'USD',created_by:actor.id,created_at:w.now,external_event_id:action.external_event_id};
    w.manualJournalRegisters.push(register);h.emit('journal_register.recorded',{journal_register:register});return result({journal_register:register});
  }
  if(type==='prepare_manual_journal'){
    fields(action,['type','action','description','date','lines','source_document_ids','submit','accounting_system','journal_register_id'],h);const accounting_system=manualJournalProvider(action)!;h.available([accounting_system]);
    let register:any;if(accounting_system==='sage-intacct'){register=w.manualJournalRegisters.find((row:any)=>row.id===action.journal_register_id&&row.accounting_system===accounting_system)??h.fail('journal_register_required','Select an existing controller-recorded Sage journal register',409);}else if(action.journal_register_id!==undefined)h.fail('unsupported_journal_register','This provider does not use a Sage journal register');
    let configuration:any;if(accounting_system==='sap-b1'){const space=requireErpIdentitySpace(w);configuration=w.erpConfigurations.find((row:any)=>row.id===space.configuration_id);}
    const description=text(action.description,'description',2000,h),date=action.date===undefined?w.now.slice(0,10):action.date;
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date!==w.now.slice(0,10))h.fail('invalid_manual_journal_date','Journal date must equal the current simulation date');
    if(action.submit!==undefined&&typeof action.submit!=='boolean')h.fail('invalid_manual_journal_field','submit must be boolean');
    const ids=action.source_document_ids;if(!Array.isArray(ids)||ids.length<1||ids.length>20||new Set(ids).size!==ids.length)h.fail('invalid_source_documents','Cite 1–20 distinct existing source document IDs');
    const source_document_ids=ids.map(id=>{if(typeof id!=='string'||!/^[^\s\u0000-\u001f\u007f]{1,200}$/.test(id))h.fail('invalid_source_documents','Source document IDs must be exact nonempty identifiers without whitespace');return id as string;}).sort();
    const source_documents=source_document_ids.map(id=>structuredClone(w.documents.find(row=>row.id===id)??h.fail('not_found','Source document not found in this world',404)));
    if(Buffer.byteLength(canonical(source_documents))>1048576)h.fail('source_documents_too_large','Combined source snapshots exceed 1 MiB',413);
    const normalized=lines(action.lines,h),record:any={id:h.id('manual-journal'),status:'draft',accounting_system,...(configuration?{erp_configuration_id:configuration.id,erp_configuration_snapshot:structuredClone(configuration)}:{}),...(register?{journal_register_id:register.id,journal_register_snapshot:structuredClone(register)}:{}),description,date,currency:'USD',...normalized,source_document_ids,source_documents,created_by:actor.id,created_at:w.now};record.source_version=sourceVersion(record);
    w.manualJournals.push(record);h.emit('manual_journal.prepared',{manual_journal_id:record.id,source_document_ids,source_version:record.source_version});
    return result(action.submit?submit(w,record,actor,h):response(w,record));
  }
  fields(action,type==='submit_manual_journal'?['type','action','manual_journal_id','version','accounting_system']:['type','action','manual_journal_id','source_version','accounting_system'],h);
  const record=w.manualJournals.find((row:any)=>row.id===action.manual_journal_id)??h.fail('not_found','Manual journal not found in this world',404);
  if(manualJournalProvider(action)!==manualJournalOrigin(record))h.fail('manual_journal_provider_mismatch','Use the proposal’s original accounting system',409);
  if(type==='submit_manual_journal'){
    h.available([manualJournalOrigin(record)]);if(typeof action.version!=='string'||!/^([a-f0-9]{64})$/.test(action.version))h.fail('invalid_manual_journal_version','version must be a lowercase SHA-256 digest');
    if(action.version!==manualJournalVersion(record))h.fail('manual_journal_version_conflict','Manual journal version changed; read the current record before submitting',409);
    return result(submit(w,record,actor,h));
  }
  const approval=w.approvals.find(row=>row.id===approved);
  if(!approval||approval.id!==record.approval_id||approval.status!=='approved'||approval.requested_by===approval.decided_by||record.created_by===approval.decided_by||approval.requested_by!==record.submitted_by||approval.action.manual_journal_id!==record.id||manualJournalProvider(approval.action)!==manualJournalOrigin(record)||record.status!=='awaiting_approval'||action.source_version!==record.source_version)h.fail('separate_controller_required','Posting requires a controller distinct from both the preparer and submitter',403);
  ready(w,record,h);
  const entry=h.post(record.lines,record.id,record.description);record.status='posted';record.journal_id=entry.id;record.posted_at=w.now;record.approved_by=approval.decided_by;
  h.emit('ledger.posted',{manual_journal_id:record.id,journal_id:entry.id});h.emit('manual_journal.posted',{manual_journal_id:record.id,journal_id:entry.id,approval_id:approval.id});return result(response(w,record));
}
export function manualJournalApprovalRejected(w:World,approval:any){if(approval.action.type!=='approve_manual_journal')return;const record=w.manualJournals?.find((row:any)=>row.id===approval.action.manual_journal_id);if(record?.approval_id===approval.id&&record.status==='awaiting_approval'){record.status='rejected';record.rejected_at=approval.decided_at;record.rejected_by=approval.decided_by;}}

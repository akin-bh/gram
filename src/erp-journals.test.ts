import {test,expect} from 'bun:test';
import {applyAction,createWorld,recordsFor} from './world.ts';
import {manualJournalVersion} from './manual-journals.ts';
import {erpNativeKey,requireErpIdentitySpace} from './erp-identities.ts';
const controller={id:'source-controller',role:'controller'} as const,operator={id:'source-operator',role:'operator'} as const;
const act=(w:any,a:any,actor:any=operator)=>applyAction(w,a,actor).result;
const draft=(w:any,system:string,extra:any={})=>({type:'prepare_manual_journal',accounting_system:system,description:'Classify sourced cost',source_document_ids:[w.documents[0].id],lines:[{account_id:'bank-fee-expense',debit_minor:1},{account_id:'expenses',credit_minor:1}],...extra});
const rejected=(w:any,a:any,code:string,actor:any=operator)=>{const before=JSON.stringify(w);try{act(w,a,actor);throw Error('Expected rejection');}catch(e:any){expect(e.code).toBe(code);}expect(JSON.stringify(w)).toBe(before);};

test('journal origins bind requests, approval, source versions and recovery independently of healthy mirrors',()=>{
 for(const system of ['xero','zoho-books','sage-intacct','sap-b1']){
  const w=createWorld({kind:'saas-collections',orderCount:1}),extra:any={};
  if(system==='sage-intacct')extra.journal_register_id=act(w,{type:'record_journal_register',accounting_system:system,code:'GJ',name:'General',external_event_id:'register'},controller).journal_register.id;
  if(system==='sap-b1')act(w,{type:'configure_erp',system,external_event_id:'erp'},controller);
  const created=act(w,draft(w,system,extra)),record=created.manual_journal;
  const submit={type:'submit_manual_journal',manual_journal_id:record.id,version:created.version,accounting_system:system};
  rejected(w,{...submit,accounting_system:system==='xero'?'zoho-books':'xero'},'manual_journal_provider_mismatch');
  const pending=act(w,submit),before=w.journals.length;
  act(w,{type:'set_fault',system,mode:'offline'},controller);
  rejected(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'approve'},'connection_unavailable',controller);
  expect(w.approvals.at(-1).status).toBe('pending');expect(w.journals.length).toBe(before);
  act(w,{type:'set_fault',system,mode:'healthy'},controller);
  const posted=act(w,{type:'decide_approval',approval_id:pending.approval_id,decision:'approve'},controller);
  expect(posted.manual_journal.accounting_system).toBe(system);expect(w.journals.length).toBe(before+1);expect(posted.journal.source_id).toBe(record.id);
  if(system==='sap-b1')expect(erpNativeKey(w,'JournalEntries','journals',posted.journal.id)).toBeGreaterThan(0);
 }
});

test('register and native identity source facts require controllers and cannot be supplied by a journal proposal',()=>{
 const w=createWorld({kind:'saas-collections',orderCount:1}),register={type:'record_journal_register',accounting_system:'sage-intacct',code:'GJ',name:'General',external_event_id:'register'};
 rejected(w,register,'controller_required');rejected(w,{type:'configure_erp',system:'sap-b1',external_event_id:'erp'},'controller_required');
 rejected(w,draft(w,'sage-intacct'),'journal_register_required');rejected(w,draft(w,'sap-b1'),'erp_configuration_required');
 const result=act(w,register,controller),count=w.manualJournalRegisters.length;
 expect(act(w,register,controller).replayed).toBe(true);expect(w.manualJournalRegisters.length).toBe(count);
 rejected(w,{...register,external_event_id:'other-register'},'journal_register_exists',controller);
 rejected(w,draft(w,'xero',{journal_register_id:result.journal_register.id}),'unsupported_journal_register');
 rejected(w,draft(w,'mercury'),'unsupported_accounting_system');
 const proposal=act(w,draft(w,'sage-intacct',{journal_register_id:result.journal_register.id}));w.manualJournalRegisters[0].name='Altered source';
 rejected(w,{type:'submit_manual_journal',accounting_system:'sage-intacct',manual_journal_id:proposal.manual_journal.id,version:proposal.version},'manual_journal_register_changed');
});

test('native numeric identity assignment is an auditable part of committed posting, never a draft read',()=>{
 const w=createWorld({kind:'saas-collections',orderCount:1});const financial=JSON.stringify({journals:w.journals,accounts:w.accounts,bank:w.bankTransactions,invoices:w.invoices,bills:w.bills});
 const configuration=act(w,{type:'configure_erp',system:'sap-b1',external_event_id:'erp-source'},controller).configuration;
 expect(JSON.stringify({journals:w.journals,accounts:w.accounts,bank:w.bankTransactions,invoices:w.invoices,bills:w.bills})).toBe(financial);
 expect(recordsFor(w,'sap-b1','erp-configuration')[0].id).toBe(configuration.id);
 const keys=JSON.stringify(requireErpIdentitySpace(w)),r=act(w,draft(w,'sap-b1',{submit:true}));
 expect(JSON.stringify(requireErpIdentitySpace(w))).toBe(keys);
 const posted=applyAction(w,{type:'decide_approval',approval_id:r.approval_id,decision:'approve'},controller);
 const allocated=posted.events.find(e=>e.type==='erp.identities_assigned')!;expect(allocated.assignments).toHaveLength(1);expect(allocated.assignments[0].source_id).toBe(posted.result.journal.id);
 const before=JSON.stringify(w);recordsFor(w,'ledger','erp-configuration');recordsFor(w,'sage-intacct','journal-register');requireErpIdentitySpace(w);expect(JSON.stringify(w)).toBe(before);
 expect(manualJournalVersion(w.manualJournals[0])).toBe(posted.result.version);
});

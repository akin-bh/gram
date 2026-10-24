import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError,recordsFor,actionRequirements} from './world.ts';
import type {World,Action,Actor} from './world.ts';
import {manualJournalVersion} from './manual-journals.ts';
const operator:Actor={id:'journal-preparer',role:'operator'},controller:Actor={id:'journal-controller',role:'controller'},other:Actor={id:'journal-submitter',role:'operator'};
const act=(w:World,a:Action,actor=operator)=>applyAction(w,a,actor).result;
const fresh=()=>createWorld({kind:'saas-collections',orderCount:1,approvalThresholdMinor:1e12});
const proposal=(amount=1)=>({type:'prepare_manual_journal',description:'Source-backed expense reclassification',source_document_ids:['policy-payments'],lines:[{account_id:'expenses',debit_minor:amount,description:'Recognize sourced operating cost'},{account_id:'equity',credit_minor:amount,description:'Controller reviewed source adjustment'}]});
const financial=(w:World)=>structuredClone({accounts:w.accounts,journals:w.journals,operations:w.operations,bank:w.bankTransactions});
const fail=(w:World,a:Action,code:string,actor=operator)=>{const before=structuredClone(w);expect(()=>act(w,a,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&error.code===code);expect(w,'Failed action must be atomic').toStrictEqual(before);};
const submit=(w:World,id:string)=>act(w,{type:'submit_manual_journal',manual_journal_id:id,version:manualJournalVersion(w.manualJournals.find((row:any)=>row.id===id))});
const decide=(w:World,id:string,decision='approve')=>act(w,{type:'decide_approval',approval_id:id,decision},controller);

test('draft source/version remains immutable and a one-cent posting still requires independent approval',()=>{
  const w=fresh(),before=financial(w),r=act(w,proposal()),id=r.manual_journal.id,snapshot=structuredClone(r.manual_journal.source_documents);
  expect(r.status).toBe('draft');expect(r.version).toBe(manualJournalVersion(r.manual_journal));expect(r.manual_journal.source_version).toMatch(/^[a-f0-9]{64}$/);expect(financial(w)).toStrictEqual(before);expect(w.approvals.length).toBe(0);
  act(w,{type:'send_email',to:['audit@simulation.test'],subject:'Unrelated communication',body:'Not a source change'});
  expect(manualJournalVersion(w.manualJournals[0])).toBe(r.version);
  const request=submit(w,id);expect(request.status).toBe('awaiting_approval');expect(financial(w)).toStrictEqual(before);expect(w.approvals.length).toBe(1);
  const replay=submit(w,id);expect(replay.approval_id).toBe(request.approval_id);expect(w.approvals.length).toBe(1);
  fail(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'controller_required');
  fail(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'separate_controller_required',{...operator,role:'controller'});
  const posted=decide(w,request.approval_id);expect(posted.status).toBe('posted');expect(posted.manual_journal.id).toBe(id);expect(posted.journal.id).toBe(posted.manual_journal.journal_id);expect(posted.journal.source_type).toBe('manual_journal');expect(posted.journal.source_id).toBe(id);expect(posted.journal.posted_at).toBe(w.now);expect(posted.journal.lines[0].description).toBe(proposal().lines[0].description);
  expect(posted.manual_journal.source_documents).toStrictEqual(snapshot);expect(w.journals.length).toBe(before.journals.length+1);expect(w.bankTransactions).toStrictEqual(before.bank);expect(w.operations).toStrictEqual(before.operations);
  expect(w.accounts.find(row=>row.id==='expenses').balance_minor).toBe(before.accounts.find(row=>row.id==='expenses').balance_minor+1);
  expect(w.accounts.reduce((sum:bigint,row:any)=>sum+BigInt(row.balance_minor),0n)).toBe(0n);
  fail(w,{type:'submit_manual_journal',manual_journal_id:id,version:posted.version},'manual_journal_not_draft');
  fail(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'approval_already_decided',controller);
});

test('strict malformed lines, source references, arithmetic, date and arbitrary fields reject without creating records',()=>{
  const w=fresh();const p=proposal();
  for(const [patch,code] of [
    [{force:true},'invalid_manual_journal_field'],[{description:'x'.repeat(2001)},'invalid_text'],[{date:'2026-10-23'},'invalid_manual_journal_date'],[{date:w.now},'invalid_manual_journal_date'],[{submit:'true'},'invalid_manual_journal_field'],
    [{source_document_ids:[]},'invalid_source_documents'],[{source_document_ids:['policy-payments','policy-payments']},'invalid_source_documents'],[{source_document_ids:[' policy-payments']},'invalid_source_documents'],[{source_document_ids:['unknown-source']},'not_found'],[{source_document_ids:[null]},'invalid_source_documents'],
    [{lines:[p.lines[0]]},'invalid_journal'],[{lines:[{account_id:'expenses',debit_minor:0},p.lines[1]]},'invalid_journal'],[{lines:[{account_id:'expenses',debit_minor:1,credit_minor:1},p.lines[1]]},'invalid_journal'],[{lines:[{account_id:'expenses',debit_minor:1.5},p.lines[1]]},'invalid_integer'],[{lines:[{account_id:'expenses',debit_minor:-1},p.lines[1]]},'invalid_integer'],[{lines:[{...p.lines[0],currency:'EUR'},p.lines[1]]},'unsupported_currency'],[{lines:[{...p.lines[0],tax_rate:0},p.lines[1]]},'invalid_manual_journal_field'],[{lines:[{...p.lines[0],description:'x'.repeat(501)},p.lines[1]]},'invalid_text'],[{lines:[{account_id:'expenses',debit_minor:2},p.lines[1]]},'unbalanced_journal'],[{lines:[p.lines[0],{account_id:'expenses',credit_minor:1}]},'invalid_journal'],[{lines:[{account_id:'expenses',debit_minor:1e12},{account_id:'expenses',debit_minor:1},{account_id:'equity',credit_minor:1e12},{account_id:'equity',credit_minor:1}]},'invalid_integer'],
  ] as [any,string][])fail(w,{...p,...patch},code);
  const r=act(w,p);fail(w,{type:'submit_manual_journal',manual_journal_id:r.manual_journal.id,version:'1'},'invalid_manual_journal_version');fail(w,{type:'submit_manual_journal',manual_journal_id:r.manual_journal.id,version:'0'.repeat(64)},'manual_journal_version_conflict');
  fail(w,{type:'submit_manual_journal',manual_journal_id:r.manual_journal.id,version:r.version,lines:p.lines},'invalid_manual_journal_field');
  const cap=act(w,proposal(1e12));expect(cap.manual_journal.total_minor).toBe(1e12);
});

test('explicit null is never treated as an omitted date, amount, submit flag or currency',()=>{
  const w=fresh(),p=proposal();
  fail(w,{...p,date:null},'invalid_manual_journal_date');fail(w,{...p,submit:null},'invalid_manual_journal_field');
  fail(w,{...p,lines:[{...p.lines[0],credit_minor:null},p.lines[1]]},'invalid_integer');
  fail(w,{...p,lines:[p.lines[0],{...p.lines[1],debit_minor:null}]},'invalid_integer');
  fail(w,{...p,lines:[{...p.lines[0],currency:null},p.lines[1]]},'unsupported_currency');
  expect(w.manualJournals.length).toBe(0);
});

test('full control account protections apply to drafts and legacy post_journal without changing its threshold semantics',()=>{
  const w=createWorld({kind:'treasury-fx',orderCount:1});
  const protectedIds=['cash-bank','cash-processor','receivables','payables','ticket-liability','refunds-payable','dispute-suspense','inventory','grni','wages-payable','employee-withholding-payable','employer-payroll-tax-payable','bank-suspense','fixed-asset-cost','accumulated-depreciation','fx-realized-gain-loss','fx-unrealized-gain-loss',...w.bankAccounts.map((row:any)=>row.gl_account_id),...w.accounts.filter(row=>row.id.startsWith('foreign-')).map(row=>row.id)];
  for(const id of new Set(protectedIds)){const lines=[{account_id:id,debit_minor:1},{account_id:'equity',credit_minor:1}];fail(w,{...proposal(),lines},'control_account_locked');fail(w,{type:'post_journal',lines},'control_account_locked');}
  const legacy=act(w,{type:'post_journal',lines:proposal().lines});expect(legacy.id).toBeTruthy();expect(legacy.source_type).toBe('manual');expect(w.manualJournals.length).toBe(0);
  expect(actionRequirements.approve_manual_journal.internal).toBe(true);
  const draft=act(w,proposal());fail(w,{type:'approve_manual_journal',manual_journal_id:draft.manual_journal.id,source_version:draft.manual_journal.source_version},'separate_controller_required',controller);
});

test('atomic create-and-submit and final approval respect Xero/ledger faults, closed periods and retry without duplicates',()=>{
  const w=fresh();act(w,{type:'close_period'},controller);act(w,{type:'set_fault',system:'ledger',mode:'offline'},controller);
  const draft=act(w,proposal());expect(draft.status).toBe('draft');
  fail(w,{...proposal(),submit:true},'connection_unavailable');expect(w.manualJournals.length).toBe(1);
  act(w,{type:'set_fault',system:'ledger',mode:'healthy'},controller);fail(w,{...proposal(),submit:true},'period_closed');act(w,{type:'reopen_period'},controller);
  const request=submit(w,draft.manual_journal.id),before=financial(w);
  for(const system of ['xero','ledger']){act(w,{type:'set_fault',system,mode:'offline'},controller);fail(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'connection_unavailable',controller);expect(w.approvals.at(-1).status).toBe('pending');act(w,{type:'set_fault',system,mode:'healthy'},controller);}
  act(w,{type:'close_period'},controller);fail(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'period_closed',controller);expect(financial(w)).toStrictEqual(before);act(w,{type:'reopen_period'},controller);
  decide(w,request.approval_id);expect(w.journals.length).toBe(before.journals.length+1);expect(w.operations.length).toBe(before.operations.length);act(w,{type:'advance_time',hours:1},controller);expect(w.journals.length).toBe(before.journals.length+1);
  const otherRequest=act(w,{...proposal(),submit:true});expect(otherRequest.status).toBe('awaiting_approval');expect(w.manualJournals.length).toBe(2);
});

test('rejected, changed-source and stale-day proposals preserve history and require a fresh draft',()=>{
  const w=fresh(),request=act(w,{...proposal(),submit:true}),snapshot=structuredClone(request.manual_journal.source_documents);
  w.documents.find(row=>row.id==='policy-payments').name='Changed metadata';
  fail(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'manual_journal_source_changed',controller);
  decide(w,request.approval_id,'reject');expect(w.manualJournals[0].status).toBe('rejected');expect(w.manualJournals[0].source_documents).toStrictEqual(snapshot);fail(w,{type:'submit_manual_journal',manual_journal_id:request.manual_journal.id,version:manualJournalVersion(w.manualJournals[0])},'manual_journal_not_draft');
  const replacement=act(w,{...proposal(),submit:true});act(w,{type:'advance_time',hours:24},controller);fail(w,{type:'decide_approval',approval_id:replacement.approval_id,decision:'approve'},'manual_journal_date_changed',controller);decide(w,replacement.approval_id,'reject');
  const current=act(w,{...proposal(),submit:true});const posted=decide(w,current.approval_id);expect(posted.journal.posted_at).toBe(w.now);expect(posted.manual_journal.date).toBe(w.now.slice(0,10));expect(w.manualJournals.length).toBe(3);
});

test('a preparer cannot bypass independence by asking a different actor to submit the same draft',()=>{
  const w=fresh(),r=act(w,proposal(),controller);const request=act(w,{type:'submit_manual_journal',manual_journal_id:r.manual_journal.id,version:r.version},other);
  fail(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'separate_controller_required',controller);act(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},{id:'independent-second-controller',role:'controller'});expect(w.manualJournals[0].status).toBe('posted');
});

test('reading old snapshots is additive-free, while a mutation initializes only the empty new collection',()=>{
  const w=fresh();delete w.manualJournals;const before=structuredClone(w);expect(recordsFor(w,'xero','manual-journal')).toStrictEqual([]);expect(w).toStrictEqual(before);expect(recordsFor(w,'ledger','manualJournals')).toStrictEqual([]);expect(w).toStrictEqual(before);
  const r=act(w,proposal());expect(w.manualJournals.length).toBe(1);const rows=recordsFor(w,'xero','manual-journal');expect(rows[0].id).toBe(r.manual_journal.id);rows[0].description='Do not mutate source';expect(w.manualJournals[0].description).not.toBe(rows[0].description);
});

test('approval revalidates ordered deferred posting headroom even when issue and return later net to zero',()=>{
  const w=createWorld({kind:'procurement-matching',orderCount:1,initialCashMinor:0}),lot=w.inventoryLots[0],value=lot.unit_cost_minor,opening=BigInt(Number.MAX_SAFE_INTEGER)-2n*BigInt(value);let remaining=opening;
  // Build supported history through public, independently reviewed journals.
  while(remaining>0n){const lines:any[]=[];for(let n=0;n<50&&remaining>0n;n++){const amount=Number(remaining>1000000000000n?1000000000000n:remaining);lines.push({account_id:'inventory-expense',debit_minor:amount},{account_id:'equity',credit_minor:amount});remaining-=BigInt(amount);}const r=act(w,{type:'post_journal',lines});if(r.approval_id)decide(w,r.approval_id);}
  const amount=Math.floor(value*1.5),request=act(w,{...proposal(amount),lines:[{account_id:'inventory-expense',debit_minor:amount},{account_id:'equity',credit_minor:amount}],submit:true});
  act(w,{type:'close_period'},controller);const authority=act(w,{type:'authorize_inventory_issue',lines:[{item_id:lot.item_id,quantity:1}],purpose:'Approved field use',external_event_id:'manual-prefix-authority'},controller).authorization;
  const issue=act(w,{type:'issue_inventory',authorization_id:authority.id,lines:[{item_id:lot.item_id,quantity:1}]}).movement;const returned=act(w,{type:'return_inventory',issue_id:issue.id,lines:[{item_id:lot.item_id,quantity:1}],reason:'Unused original-cost stock',external_event_id:'manual-prefix-return'},controller).movement;
  act(w,{type:'set_fault',system:'ledger',mode:'offline'},controller);act(w,{type:'reopen_period'},controller);act(w,{type:'set_fault',system:'ledger',mode:'healthy'},controller);
  expect(w.operations.filter(row=>row.status==='settled'&&!row.journal_id).map(row=>row.id)).toStrictEqual([issue.operation_id,returned.operation_id]);
  fail(w,{type:'decide_approval',approval_id:request.approval_id,decision:'approve'},'money_overflow',controller);expect(w.approvals.find(row=>row.id===request.approval_id).status).toBe('pending');
  const prior=w.journals.length;act(w,{type:'advance_time',hours:1},controller);expect(w.journals.slice(prior).map(row=>row.source_id)).toStrictEqual([issue.operation_id,returned.operation_id]);const posted=decide(w,request.approval_id);expect(posted.status).toBe('posted');expect(BigInt(w.accounts.find(row=>row.id==='inventory-expense').balance_minor)).toBe(opening+BigInt(amount));expect(w.accounts.reduce((sum:bigint,row:any)=>sum+BigInt(row.balance_minor),0n)).toBe(0n);
},30000);

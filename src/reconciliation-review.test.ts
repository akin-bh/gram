import {test,expect} from 'bun:test';
import {applyAction,createWorld,DomainError} from './world.ts';
import type {Action,Actor,World} from './world.ts';

const operator:Actor={id:'reconciliation-review-operator',role:'agent'};
const controller:Actor={id:'reconciliation-review-controller',role:'controller'};
const act=(w:World,input:Action,actor:Actor=controller)=>applyAction(w,input,actor).result;
let sequence=0;
const reference=(prefix:string)=>`${prefix}-${++sequence}`;
function rejects(w:World,input:Action,actor:Actor=operator,code?:string){
  const before=structuredClone(w);
  expect(()=>act(w,input,actor)).toThrowSatisfying((error:any)=>error instanceof DomainError&&(!code||error.code===code));
  expect(w,'Rejected reconciliation actions must be atomic').toStrictEqual(before);
}
const economics=(w:World)=>structuredClone({bank:w.bankTransactions,accounts:w.accounts,journals:w.journals,operations:w.operations,invoices:w.invoices,bills:w.bills});
const bankBalanceAt=(w:World,at:string)=>w.bankTransactions.filter(row=>row.account_id==='cash-bank'&&row.status==='posted'&&row.posted_at<=at).reduce((sum,row)=>sum+row.amount_minor,0);
const bookBalanceAt=(w:World,at:string)=>w.journals.filter(journal=>journal.posted_at<=at).flatMap(journal=>journal.lines).filter(line=>line.account_id==='cash-bank').reduce((sum,line)=>sum+line.debit_minor-line.credit_minor,0);
const bankWindow=(w:World,start:string,end:string)=>w.bankTransactions.filter(row=>row.account_id==='cash-bank'&&row.status==='posted'&&row.amount_minor!==0&&row.posted_at>start&&row.posted_at<=end);
function fixture(){
  const w=createWorld({kind:'supplier-fraud',orderCount:3,seed:'reconciliation-review',initialCashMinor:250_000,approvalThresholdMinor:1_000_000_000});
  const start=w.now;
  for(const invoice of w.invoices.slice(0,2))act(w,{type:'collect_invoice',invoice_id:invoice.id,amount_minor:5000},operator);
  act(w,{type:'pay_bill',bill_id:w.bills[0].id,amount_minor:1000},operator);
  act(w,{type:'advance_time',hours:1});
  return {w,start,end:w.now,rows:bankWindow(w,start,w.now)};
}
function statementInput(w:World,start:string,end:string,overrides:any={}){
  return {type:'record_bank_statement',source_statement_id:reference('statement-source'),account_id:'cash-bank',currency:'USD',start_at:start,end_at:end,opening_balance_minor:bankBalanceAt(w,start),closing_balance_minor:bankBalanceAt(w,end),lines:bankWindow(w,start,end).map(row=>({source_line_id:`line-${row.id}`,posted_at:row.posted_at,amount_minor:row.amount_minor,source_refs:[row.id]})),external_event_id:reference('statement-event'),...overrides};
}
const record=(w:World,input:Action)=>act(w,input).statement;
const match=(w:World,statement:any,line:any,ids:string[])=>act(w,{type:'match_statement_line',statement_id:statement.id,line_id:line.id,bank_transaction_ids:ids},operator);
const prepare=(w:World,statement:any)=>act(w,{type:'prepare_reconciliation',statement_id:statement.id},operator).report;
const closeInput=(statement:any,report:any)=>({type:'close_reconciliation',statement_id:statement.id,report_id:report.id,source_fingerprint:report.source_fingerprint,acknowledged_timing_item_ids:report.timing_items.map((item:any)=>item.id),external_event_id:reference('close')});
function matchAll(w:World,statement:any){
  for(const line of statement.lines){
    const rows=w.bankTransactions.filter(row=>line.source_refs.some((ref:string)=>[row.id,row.source_id,row.receipt_id].includes(ref)));
    match(w,statement,line,rows.map(row=>row.id));
  }
}

test('source-backed same-sign grouped matching and closure never change cash or accounting',()=>{
  const {w,start,end,rows}=fixture(),incoming=rows.filter(row=>row.amount_minor>0),outgoing=rows.find(row=>row.amount_minor<0),before=economics(w);
  const statement=record(w,statementInput(w,start,end,{lines:[{source_line_id:'incoming-batch',posted_at:end,amount_minor:10_000,source_refs:[incoming[0].source_id,incoming[1].receipt_id]},{source_line_id:'outgoing',posted_at:end,amount_minor:-1000,source_refs:[outgoing.id]}]}));
  match(w,statement,statement.lines[0],incoming.map(row=>row.id));match(w,statement,statement.lines[1],[outgoing.id]);
  const report=prepare(w,statement);expect(report.can_close).toBe(true);expect(report.bank_opening_minor).toBe(250_000);expect(report.bank_closing_minor).toBe(259_000);expect(report.book_closing_minor).toBe(259_000);expect(report.adjusted_difference_minor).toBe(0);
  act(w,closeInput(statement,report));expect(economics(w)).toStrictEqual(before);
});

test('equal amounts cannot substitute another source reference and match cannot use mixed-sign offsets',()=>{
  const {w,start,end,rows}=fixture(),incoming=rows.filter(row=>row.amount_minor>0),outgoing=rows.find(row=>row.amount_minor<0);
  const statement=record(w,statementInput(w,start,end));
  const first=statement.lines.find((line:any)=>line.source_refs.includes(incoming[0].id));
  rejects(w,{type:'match_statement_line',statement_id:statement.id,line_id:first.id,bank_transaction_ids:[incoming[1].id]});
  rejects(w,{type:'match_statement_line',statement_id:statement.id,line_id:first.id,bank_transaction_ids:[incoming[0].id,incoming[0].id]});
  const offset=record(w,statementInput(w,start,end,{lines:[{source_line_id:'offset-net',posted_at:end,amount_minor:4000,source_refs:[incoming[0].id,outgoing.id]},{source_line_id:'other-incoming',posted_at:end,amount_minor:5000,source_refs:[incoming[1].id]}]}));
  rejects(w,{type:'match_statement_line',statement_id:offset.id,line_id:offset.lines[0].id,bank_transaction_ids:[incoming[0].id,outgoing.id]});
  const surplus=record(w,statementInput(w,start,end,{lines:[{source_line_id:'unused-reference',posted_at:end,amount_minor:5000,source_refs:[incoming[0].id,incoming[1].id]},{source_line_id:'remaining',posted_at:end,amount_minor:4000,source_refs:[incoming[1].id,outgoing.id]}]}));
  rejects(w,{type:'match_statement_line',statement_id:surplus.id,line_id:surplus.lines[0].id,bank_transaction_ids:[incoming[0].id]});
});

test('timestamp parsing is strict and the statement window excludes start but includes end',()=>{
  const {w,start,end,rows}=fixture();
  for(const invalid of ['2026-10-24','2026-10-24T09:00:00Z','2026-10-24T09:00:00.000+00:00','2026-02-30T09:00:00.000Z'])rejects(w,statementInput(w,start,end,{start_at:invalid}),controller);
  rejects(w,statementInput(w,start,end,{end_at:'2026-10-25T00:00:00.000Z'}),controller);
  rejects(w,statementInput(w,end,start),controller);
  const atStart=statementInput(w,start,end);atStart.lines[0].posted_at=start;rejects(w,atStart,controller);
  const statement=record(w,statementInput(w,start,end));matchAll(w,statement);
  const report=prepare(w,statement);expect(report.can_close).toBe(true);expect(report.bank_opening_minor).toBe(250_000);expect(report.bank_closing_minor).toBe(250_000+rows.reduce((sum,row)=>sum+row.amount_minor,0));
  expect(report.unmatched_bank_transaction_ids.includes('bank-opening')).toBe(false);
});

test('statement arithmetic and actual bank-window balances must both agree',()=>{
  const {w,start,end}=fixture();
  rejects(w,statementInput(w,start,end,{closing_balance_minor:259_001}),controller);
  const falseBalance=record(w,statementInput(w,start,end,{opening_balance_minor:250_001,closing_balance_minor:259_001}));
  matchAll(w,falseBalance);const report=prepare(w,falseBalance);
  expect(report.bank_opening_minor).toBe(250_000);expect(report.bank_closing_minor).toBe(259_000);expect(report.can_close).toBe(false);expect(report.blockers.length>0).toBeTruthy();
  rejects(w,closeInput(falseBalance,report),controller);
});

test('missing statement items remain unresolved even if the submitted statement balances internally',()=>{
  const {w,start,end,rows}=fixture(),input=statementInput(w,start,end);input.lines=input.lines.slice(1);input.closing_balance_minor-=rows[0].amount_minor;
  const statement=record(w,input);matchAll(w,statement);const report=prepare(w,statement);
  expect(report.can_close).toBe(false);expect(report.unmatched_bank_transaction_ids.includes(rows[0].id)).toBeTruthy();expect(report.blockers.length>0).toBeTruthy();rejects(w,closeInput(statement,report),controller);
});

test('reconciliation requires exact linked cash journal amounts rather than mere journal presence',()=>{
  const {w,start,end,rows}=fixture(),row=rows[0],statement=record(w,statementInput(w,start,end)),line=statement.lines.find((item:any)=>item.source_refs.includes(row.id));
  const journal=w.journals.find(item=>item.source_type==='operation'&&item.source_id===row.source_id);
  for(const invalid of ['amount','cash-account','missing']){
    const damaged=structuredClone(w),entry=damaged.journals.find(item=>item.id===journal.id);
    if(invalid==='missing')damaged.journals=damaged.journals.filter(item=>item.id!==journal.id);
    else if(invalid==='cash-account')entry.lines.find((item:any)=>item.account_id==='cash-bank').account_id='cash-processor';
    else for(const item of entry.lines){if(item.debit_minor)item.debit_minor++;if(item.credit_minor)item.credit_minor++;}
    matchAll(damaged,statement);const report=prepare(damaged,statement);
    expect(report.can_close).toBe(false);expect(report.blockers.some((blocker:any)=>invalid==='amount'?blocker.code==='cash_journal_amount_mismatch':blocker.code==='missing_cash_journal')).toBeTruthy();
    rejects(damaged,closeInput(statement,report),controller);
  }
});

test('consumed bank transactions cannot be reused across different statements',()=>{
  const {w,start,end,rows}=fixture(),first=record(w,statementInput(w,start,end)),second=record(w,statementInput(w,start,end));
  match(w,first,first.lines[0],[rows[0].id]);
  rejects(w,{type:'match_statement_line',statement_id:second.id,line_id:second.lines[0].id,bank_transaction_ids:[rows[0].id]});
});

test('late posting is a separate timing item and never rewrites the historical ledger cutoff',()=>{
  const w=createWorld({kind:'saas-collections',orderCount:1,initialCashMinor:100_000}),start=w.now;
  act(w,{type:'close_period'});const operation=act(w,{type:'collect_invoice',invoice_id:w.invoices[0].id,amount_minor:5000},operator).operation;
  act(w,{type:'advance_time',hours:1});const cutoff=w.now,statement=record(w,statementInput(w,start,cutoff)),row=bankWindow(w,start,cutoff)[0];
  matchAll(w,statement);
  const unposted=prepare(w,statement);expect(unposted.can_close).toBe(false);rejects(w,closeInput(statement,unposted),controller);
  act(w,{type:'advance_time',hours:1});act(w,{type:'reopen_period'});
  rejects(w,closeInput(statement,unposted),controller,'stale_reconciliation');matchAll(w,statement);
  const report=prepare(w,statement),entry=w.journals.find(journal=>journal.source_id===operation.id);
  expect(entry.posted_at).toBe(w.now);expect(entry.posted_at>cutoff).toBeTruthy();expect(report.book_closing_minor).toBe(bookBalanceAt(w,cutoff));expect(report.book_closing_minor).toBe(100_000);expect(report.bank_closing_minor).toBe(105_000);
  expect(report.bank_book_difference_minor).toBe(5000);expect(report.later_posted_cash_minor).toBe(5000);expect(report.adjusted_difference_minor).toBe(0);expect(report.can_close).toBe(true);
  expect(report.timing_items.length).toBe(1);expect(report.timing_items[0].journal_id).toBe(entry.id);expect(report.timing_items[0].bank_transaction_ids).toStrictEqual([row.id]);expect(report.timing_items[0].kind).toBe('posted_after_cutoff');
  rejects(w,{...closeInput(statement,report),acknowledged_timing_item_ids:[]},controller);
  rejects(w,{...closeInput(statement,report),acknowledged_timing_item_ids:['invented-timing-item']},controller);
  rejects(w,{...closeInput(statement,report),acknowledged_timing_item_ids:[report.timing_items[0].id,report.timing_items[0].id]},controller);
  const before=economics(w);act(w,closeInput(statement,report));expect(economics(w)).toStrictEqual(before);expect(bookBalanceAt(w,cutoff)).toBe(100_000);
});

test('closure requires distinct controller and current match evidence, while unrelated actions do not stale it',()=>{
  const {w,start,end}=fixture(),statement=record(w,statementInput(w,start,end));matchAll(w,statement);const report=prepare(w,statement);
  rejects(w,closeInput(statement,report),operator);
  rejects(w,closeInput(statement,report),{id:operator.id,role:'controller'});
  act(w,{type:'receive_email',from:'review@simulation.test',subject:'Unrelated review note',body:'This changes no reconciliation source.'});
  const original=closeInput(statement,report);act(w,original);
  act(w,{type:'reopen_reconciliation',statement_id:statement.id,reason:'Review a match again',external_event_id:reference('reopen')});
  expect(act(w,original).replayed).toBe(true);
  expect(w.bankStatements.find((row:any)=>row.id===statement.id).status).not.toBe('closed');
  rejects(w,{...original,external_event_id:reference('old-report')},controller);
  const fresh=prepare(w,statement);
  act(w,{type:'unmatch_statement_line',statement_id:statement.id,line_id:statement.lines[0].id,reason:'Confirm original evidence'},operator);
  const ids=w.bankTransactions.filter(row=>statement.lines[0].source_refs.includes(row.id)).map(row=>row.id);match(w,statement,statement.lines[0],ids);
  rejects(w,closeInput(statement,fresh),controller);
  const current=prepare(w,statement);expect(current.source_fingerprint).not.toBe(fresh.source_fingerprint);act(w,closeInput(statement,current));
});

test('foreign statement, line, bank transaction and report IDs cannot manufacture a local reconciliation',()=>{
  const {w,start,end}=fixture(),statement=record(w,statementInput(w,start,end));
  for(const input of [
    {type:'match_statement_line',statement_id:'other-world-statement',line_id:statement.lines[0].id,bank_transaction_ids:['other-world-bank']},
    {type:'match_statement_line',statement_id:statement.id,line_id:'other-world-line',bank_transaction_ids:[w.bankTransactions[1].id]},
    {type:'match_statement_line',statement_id:statement.id,line_id:statement.lines[0].id,bank_transaction_ids:['other-world-bank']},
  ])rejects(w,input);
  matchAll(w,statement);const report=prepare(w,statement);
  rejects(w,{...closeInput(statement,report),report_id:'other-world-report'},controller);
});

test('reopening and supersession retain old closure and match history while releasing source consumption',()=>{
  const {w,start,end}=fixture(),statement=record(w,statementInput(w,start,end)),before=economics(w);matchAll(w,statement);const report=prepare(w,statement);act(w,closeInput(statement,report));
  const oldMatchIds=w.reconciliationMatches.filter((row:any)=>row.statement_id===statement.id).map((row:any)=>row.id);
  const replacement={...statementInput(w,start,end),type:'replace_bank_statement',statement_id:statement.id,reason:'Bank supplied a revised statement envelope'};
  rejects(w,replacement,controller);
  act(w,{type:'reopen_reconciliation',statement_id:statement.id,reason:'Review revised bank evidence',external_event_id:reference('reopen-for-replacement')});
  const revised=act(w,replacement).statement;
  expect(revised.supersedes_id).toBe(statement.id);expect(w.bankStatements.find((row:any)=>row.id===statement.id).superseded_by_id).toBe(revised.id);expect(w.bankStatements.find((row:any)=>row.id===statement.id).status).toBe('superseded');
  expect(w.reconciliationReports.some((row:any)=>row.id===report.id)).toBeTruthy();
  for(const id of oldMatchIds)expect(w.reconciliationMatches.find((row:any)=>row.id===id).status).toBe('superseded');
  rejects(w,closeInput(statement,report),controller);
  rejects(w,{type:'match_statement_line',statement_id:statement.id,line_id:statement.lines[0].id,bank_transaction_ids:[w.bankTransactions[1].id]});
  matchAll(w,revised);const next=prepare(w,revised);expect(next.can_close).toBe(true);act(w,closeInput(revised,next));expect(economics(w)).toStrictEqual(before);
});

test('zero-funded opening bank row is an explicit no-op and does not require a nonexistent journal',()=>{
  const w=createWorld({kind:'saas-collections',orderCount:1,initialCashMinor:0}),start='2026-10-24T08:00:00.000Z';
  expect(w.bankTransactions[0].amount_minor).toBe(0);
  const statement=record(w,statementInput(w,start,w.now)),report=prepare(w,statement);
  expect(report.bank_closing_minor).toBe(0);expect(report.book_closing_minor).toBe(0);expect(report.can_close).toBe(true);expect(report.unmatched_bank_transaction_ids).toStrictEqual([]);act(w,closeInput(statement,report));
});

test('new cutoff cash activity invalidates a prepared report even when existing matches remain unchanged',()=>{
  const {w,start,end}=fixture(),statement=record(w,statementInput(w,start,end));matchAll(w,statement);const report=prepare(w,statement);
  const payment=w.payments.find(row=>row.status==='succeeded');
  act(w,{type:'open_dispute',payment_id:payment.id,amount_minor:1,reason:'Processor fact received at the cutoff',external_event_id:reference('cutoff-dispute')});
  rejects(w,closeInput(statement,report),controller,'stale_reconciliation');
  const refreshed=prepare(w,statement);expect(refreshed.can_close).toBe(false);expect(refreshed.source_fingerprint).not.toBe(report.source_fingerprint);expect(refreshed.unmatched_bank_transaction_ids.length>0).toBeTruthy();
});

test('new cash activity after cutoff leaves a prior period report valid and its historical balances unchanged',()=>{
  const {w,start,end}=fixture(),statement=record(w,statementInput(w,start,end));matchAll(w,statement);const report=prepare(w,statement),historical=report.bank_closing_minor;
  act(w,{type:'advance_time',hours:1});act(w,{type:'collect_invoice',invoice_id:w.invoices[2].id,amount_minor:700},operator);act(w,{type:'advance_time',hours:1});
  expect(bankBalanceAt(w,w.now)).toBe(historical+700);expect(bookBalanceAt(w,end)).toBe(historical);
  act(w,closeInput(statement,report));
  const retained=w.reconciliationReports.find((row:any)=>row.id===report.id);expect(retained.bank_closing_minor).toBe(historical);expect(retained.book_closing_minor).toBe(historical);
});

test('future and ambiguous journals cannot satisfy statement cash proof',()=>{
  const {w,start,end,rows}=fixture(),statement=record(w,statementInput(w,start,end));matchAll(w,statement);
  const entry=w.journals.find(journal=>journal.source_type==='operation'&&journal.source_id===rows[0].source_id);
  for(const variant of ['future','duplicate']){
    const damaged=structuredClone(w),journal=damaged.journals.find(row=>row.id===entry.id);
    if(variant==='future')journal.posted_at='2026-10-25T00:00:00.000Z';
    else damaged.journals.push({...structuredClone(journal),id:'duplicate-cash-journal'});
    const report=prepare(damaged,statement);expect(report.can_close).toBe(false);expect(report.blockers.some((blocker:any)=>blocker.code===(variant==='future'?'future_cash_journal':'ambiguous_cash_journal'))).toBeTruthy();rejects(damaged,closeInput(statement,report),controller);
  }
});

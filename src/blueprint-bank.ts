/** Independent bank source facts for an unsaved blueprint world.
 * Statement amounts are never calculated from, or repaired against, the world.
 * Importing evidence leaves classification, valuation and reconciliation open.
 */
import {z} from 'zod';
import {DomainError,type World} from './world.ts';
import {blueprintRef as ref,blueprintTimestamp as timestamp} from './blueprint-support.ts';
import type {BlueprintValidationHooks,BlueprintMaterializationHooks} from './blueprint-support.ts';

const sourceId=z.string().min(1).max(200).refine(value=>value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value),'Use a nonempty source identifier without surrounding whitespace or control characters');
const description=z.string().trim().min(1).max(2000);
const amount=z.number().int().min(1).max(1e12);
const signedAmount=z.number().int().min(-1e12).max(1e12).refine(value=>value!==0,'Statement cash lines must be nonzero');
const balance=z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const currency=z.enum(['USD','EUR','GBP','JPY','KWD']);
const reservedBankIdentity=/^(?:(?:op|receipt|banktx|bank-activity|bank-account|pi)_\d+|banktx-op_\d+|bank-opening|bank-sale-\d+|opening:bank-account_\d+)$/;

export const blueprintBankSourceReference=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('opening')}).strict(),
  z.object({kind:z.literal('funding'),ref}).strict(),
  z.object({kind:z.literal('bank_activity'),ref}).strict(),
  z.object({kind:z.literal('processor_payout'),ref}).strict(),
  z.object({kind:z.literal('processor_topup'),ref}).strict(),
  z.object({kind:z.literal('external'),identifier:sourceId.refine(value=>!reservedBankIdentity.test(value),'Use typed source aliases instead of generated canonical bank identities')}).strict(),
]);
const closingQuote=z.object({ref,base_currency:z.enum(['EUR','GBP','JPY','KWD']),quote_currency:z.literal('USD'),numerator:z.string().regex(/^[1-9][0-9]{0,17}$/),denominator:z.string().regex(/^[1-9][0-9]{0,17}$/),observed_at:timestamp,expires_at:timestamp}).strict();
const activity=z.object({ref,source_transaction_id:sourceId.refine(value=>!reservedBankIdentity.test(value),'External bank sources cannot use generated canonical identity namespaces'),account_ref:z.literal('operating'),currency:z.literal('USD'),kind:z.enum(['fee','interest']),amount_minor:amount,posted_at:timestamp,description}).strict();
const statementLine=z.object({ref,source_line_id:sourceId,posted_at:timestamp,amount_minor:signedAmount,source_refs:z.array(blueprintBankSourceReference).min(1).max(200)}).strict();
const statement=z.object({ref,source_statement_id:sourceId,account_ref:ref,currency,start_at:timestamp,end_at:timestamp,opening_balance_minor:balance,closing_balance_minor:balance,lines:z.array(statementLine).max(200)}).strict();

// Optional, with no defaults: older blueprint inputs retain their exact digest.
export const bankBlueprintShape={
  closing_fx_quotes:z.array(closingQuote).max(40).optional(),
  bank_activities:z.array(activity).max(100).optional(),
  bank_statements:z.array(statement).max(20).optional(),
};
const bankSchema=z.object(bankBlueprintShape).strict();
export type BlueprintBankInput=z.infer<typeof bankSchema>;
type BankSourceReference=z.infer<typeof blueprintBankSourceReference>;

export function registerBlueprintBankRefs(input:BlueprintBankInput,h:BlueprintValidationHooks){
  // Closing quotes deliberately have a different kind: opening recognition and
  // historical funding cannot use quotes which are recorded only at as_of.
  for(const row of input.closing_fx_quotes??[])h.add(row,'closing_quote');
  for(const row of input.bank_activities??[])h.add(row,'bank_activity');
  for(const row of input.bank_statements??[]){h.add(row,'bank_statement');for(const line of row.lines)h.add(line,'statement_line',true);}
}
export function validateBlueprintBank(input:BlueprintBankInput,h:BlueprintValidationHooks){
  const transactionIds=new Set<string>(),statementIds=new Set<string>();
  for(const row of input.closing_fx_quotes??[]){
    if(row.observed_at>h.asOf||row.expires_at<=row.observed_at||Date.parse(row.expires_at)-Date.parse(row.observed_at)>31*86400000)h.fail('invalid_blueprint_closing_quote',`Closing quote ${row.ref} must be observed by as_of and expire within 31 days after observation`,{ref:row.ref,as_of:h.asOf});
  }
  for(const row of input.bank_activities??[]){
    const owner=h.use(row.account_ref,'bank_account',`${row.ref}.account_ref`);
    if(row.account_ref!=='operating'||owner.currency!=='USD'||row.currency!=='USD')h.fail('unsupported_blueprint_bank_activity',`${row.ref} requires the USD operating bank account`,{ref:row.ref});
    if(row.posted_at<h.openingAt||row.posted_at>h.asOf)h.fail('invalid_blueprint_bank_activity_time',`${row.ref}.posted_at must be between opening_at and as_of`,{ref:row.ref,posted_at:row.posted_at});
    if(transactionIds.has(row.source_transaction_id))h.fail('duplicate_blueprint_bank_source',`Repeated bank transaction source: ${row.source_transaction_id}`,{ref:row.ref});
    transactionIds.add(row.source_transaction_id);
  }
  for(const row of input.bank_statements??[]){
    const owner=h.use(row.account_ref,'bank_account',`${row.ref}.account_ref`);
    if(owner.currency!==row.currency)h.fail('invalid_blueprint_statement_currency',`Statement ${row.ref} must use its bank account's native currency`,{ref:row.ref});
    if(row.start_at>=row.end_at||row.end_at>h.asOf)h.fail('invalid_blueprint_statement_period',`Statement ${row.ref} needs start_at < end_at <= as_of`,{ref:row.ref});
    if(statementIds.has(row.source_statement_id))h.fail('duplicate_blueprint_statement_source',`Repeated statement source: ${row.source_statement_id}`,{ref:row.ref});
    statementIds.add(row.source_statement_id);
    const lineIds=new Set<string>();let closing=BigInt(row.opening_balance_minor);
    for(const line of row.lines){
      if(line.posted_at<=row.start_at||line.posted_at>row.end_at)h.fail('invalid_blueprint_statement_line_time',`Statement line ${line.ref} must be within (start_at,end_at]`,{ref:line.ref});
      if(lineIds.has(line.source_line_id))h.fail('duplicate_blueprint_statement_line',`Repeated line source in ${row.ref}: ${line.source_line_id}`,{ref:line.ref});
      lineIds.add(line.source_line_id);closing+=BigInt(line.amount_minor);
      const identities=new Set<string>();
      for(const source of line.source_refs){
        let identity:string;
        if(source.kind==='funding'){h.use(source.ref,'funding',`${line.ref}.source_refs`);identity=`funding:${source.ref}`;}
        else if(source.kind==='bank_activity'){const activity=h.use(source.ref,'bank_activity',`${line.ref}.source_refs`);identity=`literal:${activity.source_transaction_id}`;}
        else if(source.kind==='processor_payout'||source.kind==='processor_topup'){const movement=h.use(source.ref,source.kind,`${line.ref}.source_refs`);identity=`literal:${movement.source_bank_transaction_id}`;}
        else if(source.kind==='opening')identity='literal:bank-opening';
        else identity=`literal:${source.identifier}`;
        if(identities.has(identity))h.fail('duplicate_blueprint_statement_reference',`Statement line ${line.ref} repeats the same cash source`,{ref:line.ref});
        identities.add(identity);
      }
    }
    if(closing>BigInt(Number.MAX_SAFE_INTEGER)||closing<BigInt(Number.MIN_SAFE_INTEGER))h.fail('blueprint_statement_overflow',`Statement ${row.ref} arithmetic exceeds exact integer bounds`,{ref:row.ref});
    if(closing!==BigInt(row.closing_balance_minor))h.fail('unbalanced_blueprint_statement',`Statement ${row.ref} opening balance plus its explicit signed lines must equal its explicit closing balance`,{ref:row.ref});
    // Deliberately do not compare a line, reference, or statement balance with
    // canonical cash. Independent source disagreement is valid unresolved work.
  }
}

function atAsOf(w:World,h:BlueprintMaterializationHooks){if(w.now!==h.asOf)throw new DomainError(400,'blueprint_bank_clock_mismatch','Bank closing sources must be recorded at the explicit blueprint as_of clock');}
export function materializeBlueprintClosingQuotes(w:World,input:BlueprintBankInput,h:BlueprintMaterializationHooks){
  if(!input.closing_fx_quotes?.length)return;
  atAsOf(w,h);
  for(const row of input.closing_fx_quotes){const {ref:alias,...facts}=row;h.bind(alias,h.source(alias,{type:'record_fx_quote',...facts,source_quote_id:`blueprint-closing-quote-${alias}`}).quote,'closing_quote');}
}
export function materializeBlueprintBankActivity(w:World,input:BlueprintBankInput,h:BlueprintMaterializationHooks){
  if(!input.bank_activities?.length)return;
  atAsOf(w,h);
  for(const row of input.bank_activities){const {ref:alias,account_ref,...facts}=row;h.bind(alias,h.source(alias,{type:'record_bank_activity',...facts,account_id:h.id(account_ref)}).bank_activity,'bank_activity');}
}
function sourceIdentity(w:World,source:BankSourceReference,h:BlueprintMaterializationHooks):string{
  if(source.kind==='external')return source.identifier;
  if(source.kind==='opening'){
    if(!w.bankTransactions.some(row=>row.id==='bank-opening'&&row.account_id==='cash-bank'&&row.currency==='USD'))throw new DomainError(400,'invalid_blueprint_bank_source','Opening cash source is missing');
    return 'bank-opening';
  }
  const id=h.id(source.ref);
  if(source.kind==='bank_activity'){
    const row=(w.bankActivities??[]).find((entry:any)=>entry.id===id);
    if(!row?.source_transaction_id||!row.bank_transaction_id||!w.bankTransactions.some(entry=>entry.id===row.bank_transaction_id&&entry.source_transaction_id===row.source_transaction_id))throw new DomainError(400,'invalid_blueprint_bank_source',`Bank activity ${source.ref} has no observed cash receipt`);
    return row.source_transaction_id;
  }
  if(source.kind==='processor_payout'||source.kind==='processor_topup'){
    const rows=source.kind==='processor_payout'?w.processorPayouts:w.processorTopups,row=(rows??[]).find((entry:any)=>entry.id===id),operation=w.operations.find(entry=>entry.id===row?.operation_id);
    if(!row?.receipt_id||operation?.status!=='settled'||operation.receipt_id!==row.receipt_id||!w.bankTransactions.some(entry=>entry.source_id===operation.id&&entry.receipt_id===row.receipt_id&&entry.source_transaction_id===row.source_bank_transaction_id))throw new DomainError(400,'invalid_blueprint_bank_source',`Processor movement ${source.ref} has no observed bank receipt`);
    return row.source_bank_transaction_id;
  }
  const transfer=(w.treasuryTransfers??[]).find((entry:any)=>entry.id===id),operation=w.operations.find(entry=>entry.id===transfer?.operation_id);
  if(transfer?.status!=='settled'||!transfer.receipt_id||operation?.status!=='settled'||operation.receipt_id!==transfer.receipt_id||!w.bankTransactions.some(entry=>entry.source_id===operation.id&&entry.receipt_id===transfer.receipt_id))throw new DomainError(400,'invalid_blueprint_bank_source',`Historical funding ${source.ref} has no settled cash receipt`);
  return transfer.receipt_id;
}
export function materializeBlueprintBankStatements(w:World,input:BlueprintBankInput,h:BlueprintMaterializationHooks){
  if(!input.bank_statements?.length)return;
  atAsOf(w,h);
  for(const row of input.bank_statements){
    const {ref:alias,account_ref,lines,...facts}=row;
    const result=h.source(alias,{type:'record_bank_statement',...facts,account_id:h.id(account_ref),lines:lines.map(({ref:_lineRef,source_refs,...line})=>({...line,source_refs:source_refs.map(source=>sourceIdentity(w,source,h))}))});
    const recorded=h.bind(alias,result.statement,'bank_statement');
    for(const line of lines)h.bind(line.ref,recorded.lines.find((entry:any)=>entry.source_line_id===line.source_line_id),'statement_line');
  }
}

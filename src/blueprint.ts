import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Action,Actor,World} from './world.ts';
import {assetBlueprintShape,registerBlueprintAssetRefs,validateBlueprintAssets,materializeBlueprintAssets,materializeBlueprintAssetDisposalTerms} from './blueprint-assets.ts';
import {bankBlueprintShape,registerBlueprintBankRefs,validateBlueprintBank,materializeBlueprintClosingQuotes,materializeBlueprintBankActivity,materializeBlueprintBankStatements} from './blueprint-bank.ts';
import {blueprintTimestamp} from './blueprint-support.ts';
import {ticketingBlueprintShape,registerBlueprintTicketingRefs,validateBlueprintTicketing,materializeBlueprintTicketing,TICKETING_BLUEPRINT_GENERATION_GUIDANCE} from './blueprint-ticketing.ts';
import type {BlueprintValidationHooks,BlueprintMaterializationHooks} from './blueprint-support.ts';

const ref=z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const name=z.string().trim().min(1).max(120);
const prose=z.string().trim().min(1).max(2000);
const email=z.string().email().max(254).regex(/^[^\s<>]+@[^\s<>]+\.test$/i);
const amount=z.number().int().min(1).max(1e12),nonnegative=z.number().int().min(0).max(1e12);
const currency=z.enum(['USD','EUR','GBP','JPY','KWD']),foreignCurrency=z.enum(['EUR','GBP','JPY','KWD']);
const timestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value&&Number(value.slice(0,4))>=2000&&Number(value.slice(0,4))<=2100,'Use an exact UTC timestamp in years 2000–2100');
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Use a real calendar date');
const list=<T extends z.ZodType>(schema:T,max=100)=>z.array(schema).max(max).default([]);
const party=z.object({ref,name,email}).strict();
const obligation=z.object({ref,contract_ref:ref,invoice_number:name,amount_minor:amount,issued_at:timestamp,due_at:timestamp,service_completed_at:timestamp,completion_reference:name}).strict();
const contract=z.object({ref,counterparty_kind:z.enum(['customer','vendor']),counterparty_ref:ref,amount_minor:amount,description:prose,signed_at:timestamp}).strict();
const w4=z.object({form_year:z.number().int().min(2020).max(2026),filing_status:z.enum(['single_or_married_filing_separately','married_filing_jointly','head_of_household']),step2_checked:z.boolean(),annual_credits_minor:nonnegative,other_income_minor:nonnegative,deductions_minor:nonnegative,extra_withholding_minor:nonnegative}).strict();
const priorYtd=z.object({social_security_wages_minor:nonnegative,medicare_wages_minor:nonnegative,futa_wages_minor:nonnegative}).strict();
const policy=z.discriminatedUnion('mode',[
  z.object({ref,name,mode:z.literal('synthetic'),employee_withholding_bps:z.number().int().min(0).max(9999),employer_tax_bps:z.number().int().min(0).max(10000)}).strict(),
  z.object({ref,name,mode:z.literal('us-federal-2026'),tax_year:z.literal(2026),jurisdiction:z.literal('US-federal'),pay_frequency:z.enum(['semiannual','quarterly','monthly','semimonthly','biweekly','weekly','daily'])}).strict(),
]);
const poLine=z.object({ref,item_ref:ref,quantity:z.number().int().min(1).max(1e6),unit_price_minor:z.number().int().min(1).max(1e9),max_unit_price_minor:z.number().int().min(1).max(1e9)}).strict();
const receivedLine=z.object({line_ref:ref,quantity:z.number().int().min(1).max(1e6)}).strict();

/** Sources, never a serialized World or a model-selected action program. */
export const blueprintSchema=z.object({
  version:z.literal(1),opening_at:timestamp,as_of:blueprintTimestamp.optional(),period_closed:z.boolean().default(false),
  ...assetBlueprintShape,...bankBlueprintShape,...ticketingBlueprintShape,
  erp_configurations:z.array(z.object({ref,system:z.literal('sap-b1')}).strict()).max(1).optional(),
  journal_registers:z.array(z.object({ref,accounting_system:z.literal('sage-intacct'),code:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/),name}).strict()).max(20).optional(),
  customers:list(party),vendors:list(party),inventory_items:list(z.object({ref,sku:name,name}).strict()),
  service_contracts:list(contract),service_invoices:list(obligation),service_bills:list(obligation),
  payroll_policy:policy.optional(),
  employees:list(z.object({ref,name,hourly_rate_minor:z.number().int().min(1).max(1e9),route_enabled:z.boolean().default(true),
    time_records:list(z.object({ref,period_start:date,period_end:date,minutes:z.number().int().min(1).max(60000)}).strict(),12),
    tax_profile:z.object({ref,as_of_date:date,w4,prior_ytd:priorYtd}).strict().optional(),
  }).strict(),100),
  bank_accounts:list(z.object({ref,name,currency}).strict(),20),
  fx_quotes:list(z.object({ref,base_currency:foreignCurrency,quote_currency:z.literal('USD'),numerator:z.string().regex(/^[1-9][0-9]{0,17}$/),denominator:z.string().regex(/^[1-9][0-9]{0,17}$/),observed_at:timestamp,expires_at:timestamp}).strict(),40),
  foreign_counterparties:list(party.extend({kind:z.enum(['customer','vendor']),currency:foreignCurrency}).strict()),
  foreign_contracts:list(z.object({ref,counterparty_ref:ref,amount_minor:amount,description:prose,signed_at:timestamp}).strict()),
  foreign_invoices:list(obligation.extend({quote_ref:ref}).strict()),foreign_bills:list(obligation.extend({quote_ref:ref}).strict()),
  purchase_orders:list(z.object({ref,vendor_ref:ref,purpose:prose,approval:z.enum(['pending','approved']),lines:z.array(poLine).min(1).max(50),
    receipts:list(z.object({ref,reference:name,lines:z.array(receivedLine).min(1).max(50)}).strict(),40),
    invoices:list(z.object({ref,invoice_number:name,due_at:timestamp,lines:z.array(receivedLine.extend({unit_price_minor:z.number().int().min(1).max(1e9)}).strict()).min(1).max(50)}).strict(),40),
  }).strict(),50),
  historical_funding:list(z.object({ref,from_account_ref:ref,to_account_ref:ref,amount_minor:amount,fee_minor:nonnegative,quote_ref:ref.optional(),reason:prose}).strict(),20),
}).strict();
export type Blueprint=z.infer<typeof blueprintSchema>;
export const BLUEPRINT_GENERATION_GUIDANCE=`For custom enterprise sources, supply blueprint version1 instead of only preset counts/flags. The explicit source graph replaces ALL preset seed records; kind is a descriptive workflow label and orderCount never resizes a blueprint. Omit every family-specific control and set cancelEvent=false. Set startingCashMinor explicitly, including zero; it is the sole opening USD equity/cash source. If the user did not specify capital, disclose the chosen simulation assumption. opening_at is an exact UTC timestamp with milliseconds in years2000..2100; federal payroll still requires2026. Initial faults apply only after construction.
For SAP Business One native workflows, explicitly provide erp_configurations:[{ref,system:'sap-b1'}]. The controller records a first-class configuration and the host assigns durable numeric native keys as canonical sources are created. Do not supply numeric keys or infer configuration from prose. Sage Intacct manual journals require journal_registers:[{ref,accounting_system:'sage-intacct',code,name}], recording real configured general journal containers in the single USD ledger; these are not separate legal entities or statutory books. These optional arrays are source facts; they do not create manual journal amounts, balances or approval decisions. Omit them when these ERP configurations are not needed.
Blueprint aliases use lowercase letters/digits/hyphens, start with a letter, maximum48characters, and are globally unique. They are not canonical IDs. The reserved bank alias operating identifies the USD operating account. The host creates all canonical IDs, verified routes and deterministic external event IDs; never supply balances, journals, approvals, operations or beneficiary strings. Source parties require .test email contacts. SKU maximum80characters. Monetary quantities are integers: USD/EUR/GBP cents, JPY yen, KWD thousandths; quotes express foreign-major to USD-major units as positive rational numerator/denominator strings, never floating rates.
Use customers/vendors/inventory_items plus service_contracts/service_invoices/service_bills for customized USD completed services. Contract counterparty_kind and counterparty_ref must agree. Every invoice/bill needs contract_ref, unique invoice_number, amount_minor, service_completed_at, completion_reference, issued_at and due_at. Signed <= completed <= issued <= opening_at; due >= issued. Cumulative source invoices cannot exceed the contract. A signed contract alone creates no balance; source recognition creates AR/AP and no payment.
For payroll, supply payroll_policy (synthetic explicit withholding/employer basis points, or us-federal-2026 with pay_frequency) and exact employees with hourly_rate_minor, route_enabled and time_records. Each time record has its own ref, completed inclusive period_start/period_end and whole minutes; periods are1..31days, cannot overlap per employee, and end before opening_at. Minutes cannot exceed actual period minutes or60000. Use a common period for employees requested in one payroll. Missing time or tax profiles remain real blockers; do not silently omit an employee to hide a blocker. Federal profiles contain explicit W-4 and separate prior YTD Social Security/Medicare/FUTA wages plus as_of_date before current work. Federal opening_at, both work-period endpoints and profile as_of_date must be in2026; each historical funding action advances one hour and must also finish within2026. An older valid2020–2026 W-4 form remains supported. Synthetic policies can use other simulation years but cannot use statutory profiles. No payroll is calculated, paid or remitted by blueprint construction.
Purchase orders cite a vendor_ref and exact item lines with local line refs, quantities, unit prices and authorization ceilings. approval pending leaves a genuine pending review and cannot have receipts/invoices. approval approved creates and independently approves a real historical PO. Receipts cite that PO's line_ref and actual quantity; supplier invoices cite line_ref, quantity and claimed unit price. Receipt quantities cannot exceed the approved order. A price or quantity mismatch may remain an unresolved supplier claim. Unless explicitly referenced by asset_acquisitions, supplier invoices remain unmatched and unpaid; an asset acquisition must pass actual matching and never creates payment. Inventory starts at zero and comes only from receiving.
Foreign counterparts/contracts/invoices/bills use their explicit foreign_* arrays, EUR/GBP/JPY/KWD currency and the same completed-service evidence. Contracts refer to the foreign party, obligations refer to a same-currency quote_ref covering issued_at. Bank accounts start at zero. fx_quotes must have observed_at <= opening_at, expiry after observation and at most31days later. historical_funding is optional real setup history: from_account_ref/to_account_ref, source-native amount_minor, fee_minor, quote_ref when converting, reason. Every funding request is independently approved and actually settled after one simulated hour; insufficient cash, expired quotes or invalid routes reject the whole blueprint. Do not claim foreign opening balances without that history. Other obligations remain unpaid.
Use optional as_of for the final simulation observation time. It must be at or after opening_at plus one hour for every historical_funding entry. Without as_of, that last funding settlement is the final clock. The host advances precise timestamps through real controller clock actions, retaining every source transition and settlement; never supply World.now or manually backdate a ledger entry. A federal2026 payroll blueprint must also finish in2026.
For exact equipment sources, provide asset_policies with ref/name/useful_life_months1..600/salvage_bps0..9999 and asset_acquisitions with ref/name/policy_ref/supplier_invoice_ref/allocations[{receipt_ref,po_line_ref,quantity}]. Every allocation must belong to the same approved PO and actually match its supplier invoice; quantities and costs are derived from original receiving. The host records a real invoice match and controller acquisition authority, leaving the bill unpaid. Optional asset_capitalizations[{ref,acquisition_ref,capitalized_at,in_service_at?}] explicitly request historical capitalization and service facts within opening_at..as_of; these run at their exact dates. An acquisition without capitalization remains unused authority and physical inventory. Do not supply asset cost, depreciation, net book value or journals. Book depreciation begins the full calendar month after service and remains future operator work; set as_of after completed months if that work is requested. Optional asset_disposal_terms record current binding sale or retirement terms only: sale needs buyer_ref for an existing customer with a signed contract and positive proceeds_minor; retirement has proceeds_minor0 and no buyer. Each has ref/asset_ref/kind/reason. Disposal review, actual physical completion, book removal and collection are never assumed completed.
For closing FX observations after historical funding, use closing_fx_quotes with the same source-rate fields as fx_quotes. They are recorded at as_of; observed_at<=as_of and expiry is after observation within31days. Existing fx_quotes still provide opening recognition/funding authority. Closing quote aliases cannot fund historical transfers or recognize opening obligations; valuation remains future operator work.
Bank sources are independent observed evidence. bank_activities[{ref,source_transaction_id,account_ref:'operating',currency:'USD',kind:'fee'|'interest',amount_minor,posted_at,description}] record actual external USD cash at as_of, with posted_at between opening_at and as_of. They create unclassified suspense, never a second payment or automatic classification. bank_statements include ref/source_statement_id/account_ref/currency/start_at/end_at/opening_balance_minor/closing_balance_minor and lines[{ref,source_line_id,posted_at,amount_minor,source_refs}]. The window is(start_at,end_at], end_at<=as_of, each signed nonzero line is explicit, and opening plus lines must equal closing exactly. Never copy or repair balances from canonical cash to make reconciliation pass. source_refs use typed objects: {kind:'opening'} for the USD opening source, {kind:'funding',ref} for an actual settled historical transfer, {kind:'bank_activity',ref} for an observed fee/interest, or {kind:'external',identifier} for genuinely unmatched external evidence. Do not guess canonical IDs. A differing source amount/account/reference, missing line or unknown external source stays unresolved. Statements are imported open; no matching, preparation, closure or classification occurs. A source bank timestamp before as_of does not backdate the observed ledger posting; later-posting items must remain visible. Context should cite canonical statement/document IDs, not nested statement-line IDs.
period_closed=true closes accounting after the opening-capital entry and before source recognition/receiving/funding; actual source effects retain deferred journals. Blueprint limits are200 source records,400 combined PO/receipt/invoice/asset-allocation/statement lines and96KiB. Unsupported requested facts belong in limitations; never claim prose supplied financial evidence. Source documents and mail are generated separately from the materialized records.
${TICKETING_BLUEPRINT_GENERATION_GUIDANCE}`;
export class BlueprintError extends Error {
  status=400;
  constructor(public code:string,message:string,public details?:unknown){super(message);this.name='BlueprintError';}
}
const fail=(code:string,message:string,details?:unknown):never=>{throw new BlueprintError(code,message,details);};
const canonical=(value:any):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);

/** Validate shape, identity, topology and budgets before any source action. */
export function validateBlueprint(input:unknown):Blueprint {
  const parsed=blueprintSchema.safeParse(input);
  if(!parsed.success)fail('invalid_blueprint','Blueprint source schema is invalid',{phase:'schema',issues:parsed.error.issues});
  const b=parsed.data!;
  const fundingEnd=new Date(Date.parse(b.opening_at)+b.historical_funding.length*3600000).toISOString(),asOf=b.as_of??fundingEnd;
  if(!blueprintTimestamp.safeParse(fundingEnd).success||!blueprintTimestamp.safeParse(asOf).success)fail('invalid_blueprint_timeline','The derived construction clock must remain in years 2000–2100',{opening_at:b.opening_at,earliest_as_of:fundingEnd,as_of:asOf});
  if(asOf<b.opening_at||asOf<fundingEnd)fail('invalid_blueprint_timeline','as_of must cover the opening clock and every historical funding settlement',{opening_at:b.opening_at,earliest_as_of:fundingEnd,as_of:asOf});
  if(Buffer.byteLength(JSON.stringify(b))>96*1024)fail('blueprint_too_large','Blueprint exceeds 96 KiB');
  const refs=new Map<string,{kind:string;row:any}>([['operating',{kind:'bank_account',row:{currency:'USD'}}]]);
  let records=0,lines=0;
  const add=(row:any,kind:string,line=false)=>{if(refs.has(row.ref))fail('duplicate_blueprint_ref',`Duplicate or reserved blueprint ref: ${row.ref}`,{ref:row.ref});refs.set(row.ref,{kind,row});if(line)lines++;else records++;};
  const use=(value:string,kind:string,path:string)=>{const entry=refs.get(value);if(!entry||entry.kind!==kind)fail('invalid_blueprint_ref',`${path} needs a ${kind} ref: ${value}`,{path,ref:value,expected:kind});return entry!.row;};
  const hooks:BlueprintValidationHooks={openingAt:b.opening_at,asOf,add,use,fail,countLines:count=>{lines+=count;}};
  const groups=[['customers','customer'],['vendors','vendor'],['inventory_items','item'],['service_contracts','service_contract'],['service_invoices','service_invoice'],['service_bills','service_bill'],['employees','employee'],['bank_accounts','bank_account'],['fx_quotes','quote'],['foreign_counterparties','foreign_counterparty'],['foreign_contracts','foreign_contract'],['foreign_invoices','foreign_invoice'],['foreign_bills','foreign_bill'],['purchase_orders','purchase_order'],['historical_funding','funding']] as const;
  for(const [collection,kind] of groups)for(const row of b[collection])add(row,kind);
  for(const row of b.erp_configurations??[])add(row,'erp_configuration');for(const row of b.journal_registers??[])add(row,'journal_register');
  if(b.payroll_policy)add(b.payroll_policy,'payroll_policy');
  for(const employee of b.employees){for(const row of employee.time_records)add(row,'time');if(employee.tax_profile)add(employee.tax_profile,'tax_profile');}
  for(const po of b.purchase_orders){for(const line of po.lines)add(line,'po_line',true);for(const receipt of po.receipts){add(receipt,'receipt');lines+=receipt.lines.length;}for(const invoice of po.invoices){add(invoice,'supplier_invoice');lines+=invoice.lines.length;}}
  registerBlueprintAssetRefs(b,hooks);registerBlueprintBankRefs(b,hooks);registerBlueprintTicketingRefs(b,hooks);
  if(!records)fail('empty_blueprint','A blueprint needs at least one explicit source record');
  if(records>200||lines>400)fail('blueprint_too_large','Blueprint exceeds 200 source records or 400 combined lines',{records,lines});

  for(const row of b.service_contracts)use(row.counterparty_ref,row.counterparty_kind,`${row.ref}.counterparty_ref`);
  for(const [rows,kind] of [[b.service_invoices,'customer'],[b.service_bills,'vendor']] as const)for(const row of rows){const source=use(row.contract_ref,'service_contract',`${row.ref}.contract_ref`);if(source.counterparty_kind!==kind)fail('invalid_blueprint_ref',`${row.ref} requires a ${kind} contract`);}
  for(const row of b.foreign_contracts)use(row.counterparty_ref,'foreign_counterparty',`${row.ref}.counterparty_ref`);
  for(const [rows,kind] of [[b.foreign_invoices,'customer'],[b.foreign_bills,'vendor']] as const)for(const row of rows){const source=use(row.contract_ref,'foreign_contract',`${row.ref}.contract_ref`),party=use(source.counterparty_ref,'foreign_counterparty',`${source.ref}.counterparty_ref`),quote=use(row.quote_ref,'quote',`${row.ref}.quote_ref`);if(party.kind!==kind||party.currency!==quote.base_currency)fail('invalid_blueprint_ref',`${row.ref} requires the correct party kind and source quote currency`);}
  if(b.employees.length&&!b.payroll_policy)fail('missing_blueprint_policy','Employees require an explicit payroll policy');
  if(b.payroll_policy?.mode==='synthetic'&&b.employees.some(row=>row.tax_profile))fail('incompatible_blueprint_payroll','Statutory employee sources require a statutory policy');
  if(b.payroll_policy?.mode==='us-federal-2026'){
    const policy=b.payroll_policy;
    const requireYear=(value:string,path:string,sourceRef:string)=>{
      const year=Number(value.slice(0,4));
      if(year!==policy.tax_year)fail('incompatible_blueprint_payroll_year',`Blueprint ${path} (${sourceRef}) is in ${year}; payroll policy ${policy.ref} supports only ${policy.tax_year}`,{phase:'payroll_year',policy_ref:policy.ref,source_ref:sourceRef,path,expected_year:policy.tax_year,actual_year:year,value});
    };
    requireYear(b.opening_at,'opening_at',policy.ref);
    for(const [employeeIndex,employee] of b.employees.entries()){
      if(employee.tax_profile)requireYear(employee.tax_profile.as_of_date,`employees[${employeeIndex}].tax_profile.as_of_date`,employee.tax_profile.ref);
      for(const [timeIndex,time] of employee.time_records.entries())for(const field of ['period_start','period_end'] as const)requireYear(time[field],`employees[${employeeIndex}].time_records[${timeIndex}].${field}`,time.ref);
    }
    // Construction settles each historical transfer sequentially after exactly
    // one hour. Reject a year change before any source facts are materialized.
    for(const [index,funding] of b.historical_funding.entries())requireYear(new Date(Date.parse(b.opening_at)+(index+1)*3600000).toISOString(),`historical_funding[${index}].settled_at`,funding.ref);
    if(b.as_of)requireYear(b.as_of,'as_of',policy.ref);
  }
  for(const po of b.purchase_orders){use(po.vendor_ref,'vendor',`${po.ref}.vendor_ref`);const local=new Set(po.lines.map(line=>line.ref));for(const line of po.lines)use(line.item_ref,'item',`${line.ref}.item_ref`);for(const row of [...po.receipts,...po.invoices])for(const line of row.lines)if(!local.has(line.line_ref))fail('invalid_blueprint_ref',`${row.ref} cites a line outside its purchase order`,{ref:row.ref,line_ref:line.line_ref});if(po.approval==='pending'&&(po.receipts.length||po.invoices.length))fail('unapproved_blueprint_purchase','Pending purchase orders cannot have receiving or invoice facts');}
  for(const funding of b.historical_funding){use(funding.from_account_ref,'bank_account',`${funding.ref}.from_account_ref`);use(funding.to_account_ref,'bank_account',`${funding.ref}.to_account_ref`);if(funding.quote_ref)use(funding.quote_ref,'quote',`${funding.ref}.quote_ref`);}
  validateBlueprintAssets(b,hooks);validateBlueprintBank(b,hooks);validateBlueprintTicketing(b,hooks);
  return b;
}

export type BlueprintHooks={perform:(action:Action,actor:Actor)=>{result:any;events:any[]};document?:(type:string,name:string,body:string,refs:any)=>any;mail?:(message:any)=>any};
/** Called only during construction of an unsaved world. A failed transition
 * rejects that complete constructor; no partial world is returned or saved. */
export function materializeBlueprint(w:World,input:unknown,h:BlueprintHooks){
  const b=validateBlueprint(input),digest=createHash('sha256').update(canonical(b)).digest('hex');
  const controller:Actor={id:'blueprint-source-controller',role:'controller'},operator:Actor={id:'blueprint-historical-operator',role:'operator'},reviewer:Actor={id:'blueprint-review-controller',role:'controller'};
  const refs:Record<string,{id:string;kind:string}>={operating:{id:'cash-bank',kind:'bank_account'}};
  w.generationHistory=[];
  const id=(alias:string)=>refs[alias]?.id??fail('unresolved_blueprint_ref',`Source ref was not materialized: ${alias}`,{ref:alias});
  const bind=(alias:string,row:any,kind:string)=>{if(!row||typeof row.id!=='string')fail('invalid_blueprint_source_result',`Domain returned no ${kind} identity for ${alias}`);refs[alias]={id:row.id,kind};return row;};
  const external=(alias:string,step:string)=>`blueprint-${digest.slice(0,16)}-${alias}-${step}`;
  const perform=(alias:string,action:Action,actor=controller)=>{
    try{const output=h.perform(action,actor);w.generationHistory.push({id:`blueprint-step-${w.generationHistory.length+1}`,sequence:w.generationHistory.length+1,ref:alias,at:w.now,actor:structuredClone(actor),action:structuredClone(action),result:structuredClone(output.result),events:structuredClone(output.events)});return output.result;}
    catch(error){if(error instanceof BlueprintError)throw error;fail('blueprint_source_rejected',`Blueprint source ${alias} (${action.type}) failed: ${error instanceof Error?error.message:String(error)}`,{ref:alias,action:action.type,source_code:(error as any)?.code??'domain_error',step:w.generationHistory.length+1});}
  };
  const source=(alias:string,action:Action)=>perform(alias,{...action,external_event_id:external(alias,String(action.type))});
  const asOf=b.as_of??new Date(Date.parse(b.opening_at)+b.historical_funding.length*3600000).toISOString();
  const scheduled:{at:string;ref:string;run:()=>void;priority:number;sequence:number}[]=[];
  const schedule=(at:string,ref:string,run:()=>void,priority=20)=>{
    if(!blueprintTimestamp.safeParse(at).success||at<b.opening_at||at>asOf)fail('invalid_blueprint_timeline','Scheduled source must fall within the declared construction window',{ref,at,opening_at:b.opening_at,as_of:asOf});
    scheduled.push({at,ref,run,priority,sequence:scheduled.length});
  };
  const advanceTo=(at:string,ref:string)=>{
    if(at<w.now)fail('invalid_blueprint_timeline','Historical source order would move the simulation clock backwards',{ref,at,current_at:w.now});
    while(w.now<at){const target=new Date(Math.min(Date.parse(at),Date.parse(w.now)+365*24*3600000)).toISOString();perform(ref,{type:'advance_to',at:target});}
  };
  const hooks:BlueprintMaterializationHooks={openingAt:b.opening_at,asOf,operator,reviewer,id,bind,source,perform,schedule};
  if(w.now!==b.opening_at)fail('blueprint_clock_mismatch','Blueprint constructor must set its validated opening clock before materialization');
  if(b.period_closed)perform('accounting',{type:'close_period'});
  for(const row of b.erp_configurations??[])bind(row.ref,source(row.ref,{type:'configure_erp',system:row.system}).configuration,'erp_configuration');
  for(const row of b.journal_registers??[])bind(row.ref,source(row.ref,{type:'record_journal_register',accounting_system:row.accounting_system,code:row.code,name:row.name}).journal_register,'journal_register');
  for(const row of b.customers)bind(row.ref,source(row.ref,{type:'record_customer',external_customer_id:external(row.ref,'customer'),name:row.name,email:row.email}).customer,'customer');
  for(const row of b.vendors)bind(row.ref,source(row.ref,{type:'record_vendor',external_vendor_id:external(row.ref,'vendor'),name:row.name,email:row.email}).vendor,'vendor');
  for(const row of b.inventory_items)bind(row.ref,source(row.ref,{type:'record_inventory_item',external_item_id:external(row.ref,'item'),sku:row.sku,name:row.name}).item,'item');
  for(const row of b.bank_accounts)bind(row.ref,source(row.ref,{type:'record_bank_account',external_account_id:external(row.ref,'bank-account'),name:row.name,currency:row.currency}).bank_account,'bank_account');
  for(const row of b.fx_quotes){const {ref:alias,...quote}=row;bind(alias,source(alias,{type:'record_fx_quote',...quote,source_quote_id:external(alias,'quote')}).quote,'quote');}
  if(b.payroll_policy){const {ref:alias,mode,...fields}=b.payroll_policy;bind(alias,source(alias,{type:mode==='synthetic'?'record_payroll_policy':'record_statutory_payroll_policy',...fields}).policy,'payroll_policy');}
  for(const employee of b.employees){bind(employee.ref,source(employee.ref,{type:'record_employee',employee_id:`bp-employee-${employee.ref}`,display_name:employee.name,hourly_rate_minor:employee.hourly_rate_minor,route_enabled:employee.route_enabled}).employee,'employee');if(employee.tax_profile){const {ref:alias,...profile}=employee.tax_profile;bind(alias,source(alias,{type:'record_employee_tax_profile',employee_id:id(employee.ref),tax_year:2026,jurisdiction:'US-federal',...profile}).tax_profile,'tax_profile');}for(const time of employee.time_records){const {ref:alias,...facts}=time;bind(alias,source(alias,{type:'record_payroll_time',employee_id:id(employee.ref),...facts}).time_record,'time');}}
  for(const row of b.service_contracts){const {ref:alias,counterparty_ref,...facts}=row;bind(alias,source(alias,{type:'record_service_contract',external_contract_id:external(alias,'contract'),counterparty_id:id(counterparty_ref),...facts}).contract,'service_contract');}
  for(const [rows,type,key] of [[b.service_invoices,'record_service_invoice','invoice'],[b.service_bills,'record_service_bill','bill']] as const)for(const row of rows){const {ref:alias,contract_ref,invoice_number,...facts}=row;bind(alias,source(alias,{type,contract_id:id(contract_ref),source_invoice_id:invoice_number,...facts})[key],`service_${key}`);}
  for(const row of b.foreign_counterparties){const {ref:alias,...facts}=row;bind(alias,source(alias,{type:'record_foreign_counterparty',external_counterparty_id:external(alias,'counterparty'),...facts}).counterparty,'foreign_counterparty');}
  for(const row of b.foreign_contracts){const {ref:alias,counterparty_ref,...facts}=row;bind(alias,source(alias,{type:'record_foreign_contract',external_contract_id:external(alias,'contract'),counterparty_id:id(counterparty_ref),...facts}).contract,'foreign_contract');}
  for(const [rows,type,key] of [[b.foreign_invoices,'record_foreign_invoice','invoice'],[b.foreign_bills,'record_foreign_bill','bill']] as const)for(const row of rows){const {ref:alias,contract_ref,invoice_number,quote_ref,...facts}=row;bind(alias,source(alias,{type,contract_id:id(contract_ref),source_invoice_id:invoice_number,quote_id:id(quote_ref),...facts})[key],`foreign_${key}`);}
  for(const po of b.purchase_orders){
    const authority=source(po.ref,{type:'authorize_purchase',vendor_id:id(po.vendor_ref),lines:po.lines.map(line=>({item_id:id(line.item_ref),quantity:line.quantity,max_unit_price_minor:line.max_unit_price_minor})),purpose:po.purpose}).requisition;
    const requested=perform(po.ref,{type:'create_purchase_order',vendor_id:id(po.vendor_ref),lines:po.lines.map(line=>({item_id:id(line.item_ref),quantity:line.quantity,unit_price_minor:line.unit_price_minor})),document_ids:[authority.document_id],reason:po.purpose},operator);
    const order=bind(po.ref,requested.purchase_order,'purchase_order');po.lines.forEach((line,index)=>bind(line.ref,order.lines[index],'po_line'));
    if(po.approval==='approved')perform(po.ref,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},reviewer);
    for(const row of po.receipts)bind(row.ref,source(row.ref,{type:'receive_goods',purchase_order_id:id(po.ref),reference:row.reference,lines:row.lines.map(line=>({po_line_id:id(line.line_ref),quantity:line.quantity}))}).receipt,'receipt');
    for(const row of po.invoices)bind(row.ref,source(row.ref,{type:'receive_supplier_invoice',purchase_order_id:id(po.ref),vendor_id:id(po.vendor_ref),invoice_number:row.invoice_number,due_at:row.due_at,lines:row.lines.map(line=>({po_line_id:id(line.line_ref),quantity:line.quantity,unit_price_minor:line.unit_price_minor}))}).supplier_invoice,'supplier_invoice');
  }
  materializeBlueprintTicketing(w,b,hooks);
  materializeBlueprintAssets(w,b,hooks);
  const requestFunding=(row:Blueprint['historical_funding'][number])=>{
    const requested=perform(row.ref,{type:'request_treasury_transfer',from_account_id:id(row.from_account_ref),to_account_id:id(row.to_account_ref),amount_minor:row.amount_minor,fee_minor:row.fee_minor,...(row.quote_ref?{quote_id:id(row.quote_ref)}:{}),reason:row.reason},operator);
    bind(row.ref,requested.transfer,'funding');perform(row.ref,{type:'decide_approval',approval_id:requested.approval_id,decision:'approve'},reviewer);
  };
  const verifyFunding=(row:Blueprint['historical_funding'][number])=>{const settled=w.treasuryTransfers.find((transfer:any)=>transfer.id===id(row.ref));if(settled?.status!=='settled')fail('blueprint_funding_unsettled',`Historical funding ${row.ref} did not actually settle`,{ref:row.ref,status:settled?.status});};
  if(b.as_of!==undefined||scheduled.length){
    // Every funding retains its original one-hour settlement. Other dated
    // source events may occur between request and receipt without backdating.
    for(const [index,row] of b.historical_funding.entries()){
      const start=new Date(Date.parse(b.opening_at)+index*3600000).toISOString(),end=new Date(Date.parse(start)+3600000).toISOString();
      schedule(start,row.ref,()=>requestFunding(row),10);schedule(end,row.ref,()=>verifyFunding(row),0);
    }
    for(const step of scheduled.sort((a,b)=>a.at.localeCompare(b.at)||a.priority-b.priority||a.sequence-b.sequence)){advanceTo(step.at,step.ref);step.run();}
    advanceTo(asOf,'as-of');
  }else{
    // Existing source blueprints retain their original history and digest.
    for(const row of b.historical_funding){requestFunding(row);perform(row.ref,{type:'advance_time',hours:1});verifyFunding(row);}
  }
  materializeBlueprintAssetDisposalTerms(w,b,hooks);
  materializeBlueprintClosingQuotes(w,b,hooks);
  materializeBlueprintBankActivity(w,b,hooks);
  materializeBlueprintBankStatements(w,b,hooks);
  w.blueprint=structuredClone(b);w.blueprintManifest={version:1,digest,refs:structuredClone(refs),action_count:w.generationHistory.length,opening_at:b.opening_at,materialized_at:w.now,source_authority:'synthetic controller facts and actual domain transitions; not external provider success'};
  return structuredClone(w.blueprintManifest);
}

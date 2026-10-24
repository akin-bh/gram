import {providerMercuryRoutes} from './provider-mercury.ts';
import {providerStripeRoutes} from './provider-stripe.ts';
import {providerSapRoutes} from './provider-sap.ts';
import {providerZohoRoutes} from './provider-zoho.ts';
import {providerIntacctRoutes} from './provider-intacct.ts';
import {providerPathParameters,matchProviderPath,formatProviderPath} from './provider-paths.ts';
import {providerDocumentRoutes} from './provider-documents.ts';
import {providerPayrollRoutes} from './provider-payroll.ts';
import {providerXeroRoutes} from './provider-xero.ts';
/** Route-level access is independent of HTTP verb: some vendor reads use POST.
 * One registry controls discovery, authenticated dispatch and the SDK tool.
 * These are declared subsets, never a claim of complete vendor parity. */
export type ProviderContract={id:string;system:string;method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE';path:string;access:'read'|'write';description:string;documentation?:readonly string[];limitations?:readonly string[]};
const route=(id:string,system:string,method:ProviderContract['method'],path:string,access:ProviderContract['access'],description:string):ProviderContract=>({id,system,method,path,access,description});
const read=(system:string,id:string,path:string,description:string)=>route(`${system}.${id}`,system,'GET',path,'read',description);
const legacy:ProviderContract[]=[
 ...['payment_intents','charges','refunds','customers','invoices','disputes','credit_notes'].flatMap(resource=>[read('stripe',`${resource}.list`,`/v1/${resource}`,`List ${resource} with explicit supported filters and cursor pagination.`),read('stripe',`${resource}.get`,`/v1/${resource}/:id`,`Read a canonical ${resource} record.`)]),
 read('stripe','balance.get','/v1/balance','Read actual available/pending processor funds independently of deferred GL. Local refund reservations and spendable funds are disclosed separately in finance_world.'),
 route('stripe.refunds.create','stripe','POST','/v1/refunds','write','Request a source-authorized refund; independent approval may be required.'),
 route('stripe.disputes.update','stripe','POST','/v1/disputes/:id','write','Submit canonical source documents as dispute evidence.'),
 ...['messages','threads'].flatMap(resource=>[read('gmail',`${resource}.list`,`/gmail/v1/users/:user/${resource}`,`List mailbox ${resource}.`),read('gmail',`${resource}.get`,`/gmail/v1/users/:user/${resource}/:id`,`Read mailbox ${resource}; MIME formats are explicit.`)]),
 read('gmail','attachments.get','/gmail/v1/users/:user/messages/:message_id/attachments/:attachment_id','Read original attachment bytes encoded as base64url.'),
 route('gmail.messages.send','gmail','POST','/gmail/v1/users/:user/messages/send','write','Send a simulated MIME message through the connected mailbox.'),
 route('plaid.accounts.get','plaid','POST','/accounts/get','read','Read verified native accounts; local OAuth supplies authentication.'),
 route('plaid.transactions.sync','plaid','POST','/transactions/sync','read','Read incremental canonical bank transactions; no cash movement.'),
 read('quickbooks','query','/v3/company/:company_id/query','Query documented local entities with exact supported SQL subset.'),
 ...['invoice','purchaseorder','bill','item'].map(resource=>read('quickbooks',`${resource}.get`,`/v3/company/:company_id/${resource}/:id`,`Read ${resource} using native transaction currency.`)),
 ...['invoice','journalEntry','purchaseOrder','itemReceipt','vendorBill','inventoryItem'].flatMap(resource=>[read('netsuite',`${resource}.list`,`/services/rest/record/v1/${resource}`,`List ${resource} record links.`),read('netsuite',`${resource}.get`,`/services/rest/record/v1/${resource}/:id`,`Read ${resource} source and accounting facts.`)]),
 read('ramp','bills.list','/developer/v1/bills','Read supplier obligations and actual payment status.'),read('ramp','bills.get','/developer/v1/bills/:id','Read one supplier obligation.'),
];
export const providerContracts:readonly ProviderContract[]=Object.freeze([...legacy,...providerStripeRoutes,...providerMercuryRoutes,...providerDocumentRoutes,...providerPayrollRoutes,...providerXeroRoutes,...providerZohoRoutes,...providerIntacctRoutes,...providerSapRoutes].map(row=>Object.freeze(row)));
export class ProviderContractError extends Error{constructor(public code:string,message:string){super(message);this.name='ProviderContractError';}}
const fail=(code:string,message:string):never=>{throw new ProviderContractError(code,message);};
export function matchProviderContract(system:string,method:string,path:string):ProviderContract|undefined{return providerContracts.find(contract=>contract.system===system&&contract.method===method&&matchProviderPath(contract.path,path));}
const credentials=new Set(['authorization','accesstoken','refreshtoken','idtoken','clientsecret','clientid','secret','apikey','password','token','cookie','setcookie']);
/** Provider credentials come only from the scoped local gateway. Business
 * content may mention tokens; credential field names cannot carry them. */
export function assertNoProviderCredentials(value:unknown,depth=0):void{
 if(depth>16)fail('invalid_provider_input','Provider input nesting exceeds 16 levels');
 if(Array.isArray(value)){if(value.length>1000)fail('invalid_provider_input','Provider arrays exceed 1000 entries');for(const row of value)assertNoProviderCredentials(row,depth+1);}
 else if(value&&typeof value==='object')for(const [key,row] of Object.entries(value)){if(credentials.has(key.replace(/[-_]/g,'').toLowerCase()))fail('provider_credentials_forbidden','Provider credentials are supplied by the scoped gateway');assertNoProviderCredentials(row,depth+1);}
}
export function resolveProviderOperation(operationId:string,worldId:string,params:Record<string,string>={},query:Record<string,string|string[]>={}):{contract:ProviderContract;path:string}{
 const contract=providerContracts.find(row=>row.id===operationId)??fail('unsupported_provider_operation','Unknown native provider operation');
 if(!/^[A-Za-z0-9_-]{1,160}$/.test(worldId))fail('invalid_world_id','Invalid current world identity');
 if(!params||typeof params!=='object'||Array.isArray(params)||!query||typeof query!=='object'||Array.isArray(query))fail('invalid_provider_input','Path parameters and query must be objects');
 const names=providerPathParameters(contract.path);
 if(Object.keys(params).some(key=>!names.includes(key)))fail('unexpected_provider_parameter','Unknown provider path parameter');
 const reserved=new Set(['world','world_id','company_id']);
 const values={...params};for(const name of names)if(reserved.has(name)){if(params[name]!==undefined&&params[name]!==worldId)fail('provider_world_mismatch','Provider company must equal the current world');values[name]=worldId;}
 let native:string;try{native=formatProviderPath(contract.path,values);}catch(error){if((error as any)?.code==='invalid_provider_parameter')fail('invalid_provider_parameter',(error as Error).message);throw error;}
 assertNoProviderCredentials(query);if(contract.system==='zoho-books'){if(query.organization_id!==undefined&&query.organization_id!==worldId)fail('provider_world_mismatch','Zoho organization must equal the current world');query={...query,organization_id:worldId};}const search=new URLSearchParams();
 if(Object.keys(query).length>32)fail('invalid_provider_query','Too many provider query parameters');
 for(const [key,value] of Object.entries(query)){if(!key||key.length>100||/[\u0000-\u001f\u007f]/.test(key))fail('invalid_provider_query','Invalid query key');const values=Array.isArray(value)?value:[value];if(!values.length||values.length>100)fail('invalid_provider_query','Query arrays require 1–100 values');for(const item of values){if(typeof item!=='string'||item.length>8000||/[\u0000\r\n]/.test(item))fail('invalid_provider_query','Invalid query value');search.append(key,item);}}
 if(search.toString().length>16000)fail('invalid_provider_query','Provider query exceeds 16000 encoded bytes');
 return {contract,path:`/providers/${contract.system}/worlds/${encodeURIComponent(worldId)}${native}${search.size?'?'+search:''}`};
}
export function providerRouteCatalog(){return Object.fromEntries([...new Set(providerContracts.map(row=>row.system))].map(system=>[system,providerContracts.filter(row=>row.system===system).map(row=>`${row.method} ${row.path}`)]));}

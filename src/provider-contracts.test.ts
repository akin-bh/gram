import {test,expect} from 'bun:test';
import {providerContracts,matchProviderContract,resolveProviderOperation,assertNoProviderCredentials,ProviderContractError} from './provider-contracts.ts';
const reject=(fn:()=>unknown,code:string)=>{try{fn();throw new Error('Expected rejection');}catch(error){expect(error).toBeInstanceOf(ProviderContractError);expect((error as ProviderContractError).code).toBe(code);}};
test('native contracts retain read-only POST semantics and isolate the current company',()=>{
 const plaid=resolveProviderOperation('plaid.transactions.sync','world-a');expect(plaid.contract.method).toBe('POST');expect(plaid.contract.access).toBe('read');expect(plaid.path).toBe('/providers/plaid/worlds/world-a/transactions/sync');
 const qb=resolveProviderOperation('quickbooks.query','world-a',{}, {query:"SELECT * FROM Invoice WHERE Id = 'invoice-1'"});expect(qb.path).toContain('/v3/company/world-a/query?query=');expect(new URL('http://127.0.0.1'+qb.path).searchParams.get('query')).toContain("Id = 'invoice-1'");
 reject(()=>resolveProviderOperation('quickbooks.query','world-a',{company_id:'world-b'}),'provider_world_mismatch');
 expect(resolveProviderOperation('stripe.refunds.create','world-a').contract.access).toBe('write');
});
test('provider resolution rejects arbitrary paths, extra parameters and credential-bearing inputs',()=>{
 for(const id of ['..','.', '../world-b','a/b','a\\b','https://evil.test','a?key=x','a#frag','%2f','a\nvalue'])reject(()=>resolveProviderOperation('stripe.invoices.get','world-a',{id}),'invalid_provider_parameter');
 reject(()=>resolveProviderOperation('stripe.invoices.get','world-a',{id:'invoice-1',world:'world-b'}),'unexpected_provider_parameter');
 reject(()=>resolveProviderOperation('stripe.invoices.get','world-a',{}),'invalid_provider_parameter');
 reject(()=>resolveProviderOperation('https://evil.test','world-a'),'unsupported_provider_operation');
 reject(()=>resolveProviderOperation('stripe.invoices.list','world-a',{}, {access_token:'secret'}),'provider_credentials_forbidden');
 reject(()=>assertNoProviderCredentials({data:[{headers:{Authorization:'Bearer hidden'}}]}),'provider_credentials_forbidden');
 expect(()=>assertNoProviderCredentials({description:'The source document mentions an access_token field as text.'})).not.toThrow();
});
test('every registered native operation matches only its method and complete path',()=>{
 expect(new Set(providerContracts.map(row=>row.id)).size).toBe(providerContracts.length);
 for(const contract of providerContracts){const path=contract.path.replace(/\(:[A-Za-z_][A-Za-z0-9_]*\)/g,'(1)').replace(/:[A-Za-z_][A-Za-z0-9_]*/g,'record-1');expect(matchProviderContract(contract.system,contract.method,path)?.id).toBe(contract.id);expect(matchProviderContract(contract.system,contract.method,path+'/ignored/ignored/ignored')).toBeUndefined();expect(matchProviderContract('unrecognized',contract.method,path)).toBeUndefined();}
 for(const path of ['/v1/invoices/../refunds','/v1/invoices/%2Fother','/v1/invoices/%252Fother','/v1/invoices/id?x=1','//v1/invoices'])expect(matchProviderContract('stripe','GET',path)).toBeUndefined();
 expect(matchProviderContract('stripe','DELETE','/v1/refunds')).toBeUndefined();expect(matchProviderContract('plaid','GET','/transactions/sync')).toBeUndefined();
});

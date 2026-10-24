import {test,expect} from 'bun:test';
import {formatProviderPath,matchProviderPath,providerPathParameters} from './provider-paths.ts';
import {resolveProviderOperation,providerContracts} from './provider-contracts.ts';
import {createNativeProviderRequester} from './agent.ts';

test('OData keys preserve their native syntax and reject escaping, traversal and ambiguous integer forms',()=>{
 const numeric='/b1s/v2/JournalEntries(:JdtNum)',text="/b1s/v2/ChartOfAccounts(':Code')";
 expect(providerPathParameters(numeric)).toEqual(['JdtNum']);expect(formatProviderPath(numeric,{JdtNum:'23'})).toBe('/b1s/v2/JournalEntries(23)');
 expect(matchProviderPath(numeric,'/b1s/v2/JournalEntries(23)')).toBe(true);expect(formatProviderPath(text,{Code:'bank-fee-expense'})).toBe("/b1s/v2/ChartOfAccounts('bank-fee-expense')");
 expect(matchProviderPath(text,"/b1s/v2/ChartOfAccounts(%27bank-fee-expense%27)")).toBe(true);
 for(const JdtNum of ['0','01','-1','1.0','1e2','2147483648','1)/Invoices(2','1%29','1/2','1\n'])expect(()=>formatProviderPath(numeric,{JdtNum})).toThrow();
 for(const Code of ["expenses')/JournalEntries(1)",'a/b','..','a b','a%27','a\n',"x'y",'x'.repeat(201)])expect(()=>formatProviderPath(text,{Code})).toThrow();
 for(const path of ["/b1s/v2/ChartOfAccounts('expenses')/ignored","/b1s/v2/ChartOfAccounts('x%27y')","/b1s/v2/ChartOfAccounts('x%252Fy')",'/b1s/v2/JournalEntries(1)/','/b1s/v2/JournalEntries(01)']){
  if(path==='/b1s/v2/JournalEntries(1)/')expect(matchProviderPath(numeric,path)).toBe(true);else expect(matchProviderPath(path.includes('Chart')?text:numeric,path)).toBe(false);
 }
 expect(matchProviderPath(text,"/b1s/v2/ChartOfAccounts('"+'x'.repeat(200)+"')")).toBe(true);
});

test('Zoho organization and authentication are derived from host scope before transport',async()=>{
 const op=providerContracts.find(row=>row.system==='zoho-books'&&row.method==='GET')!;
 const resolved=resolveProviderOperation(op.id,'world-current');expect(new URL('http://local'+resolved.path).searchParams.get('organization_id')).toBe('world-current');
 for(const organization_id of ['other-world',['world-current'],['world-current','world-current']])expect(()=>resolveProviderOperation(op.id,'world-current',{}, {organization_id})).toThrow();
 const calls:any[]=[];const request=createNativeProviderRequester({worldId:'world-current',baseUrl:'http://127.0.0.1:9123',token:'host-secret',onEvent:()=>{},transport:(async(url:any,options:any)=>{calls.push({url,options});return Response.json({code:0});}) as typeof fetch});
 const result=await request({operation_id:op.id});expect(result.isError).toBe(false);expect(new Headers(calls[0].options.headers).get('Authorization')).toBe('Zoho-oauthtoken host-secret');
 expect(new URL(calls[0].url).searchParams.getAll('organization_id')).toEqual(['world-current']);
 const denied=await request({operation_id:op.id,query:{organization_id:'other-world'}});expect(denied.isError).toBe(true);expect(calls).toHaveLength(1);
});

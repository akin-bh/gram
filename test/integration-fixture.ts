import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {hash} from '../src/store.ts';

export async function start(database:string,port=0){
  const server=await startServer({database,port,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  let cookie:string;
  try{
    const home=await fetch(base,{headers:{Connection:'close'}});expect(home.status).toBe(200);
    cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  }catch(error){await server.close();throw error;}
  const call=async(path:string,input?:any,token?:string,key:string=crypto.randomUUID(),anonymous=false)=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:(anonymous?{}:{Cookie:cookie})),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const connect=async(world:string,system:string)=>{
    const started=await call(`/api/worlds/${world}/connect/${system}`,{});expect(started.status,JSON.stringify(started.data)).toBe(200);
    const url=new URL(started.data.authorization_url);
    const consent=await fetch(`${base}/oauth/${system}/consent${url.search}`,{headers:{Cookie:cookie}});expect(consent.status).toBe(200);
    const info=await consent.json();expect(info.world).toBe(world);expect(info.provider.id).toBe(system);expect(info.scopes).toStrictEqual(['read','write']);
    const params=new URLSearchParams(url.search);params.set('decision','allow');
    const allowed=await fetch(base+url.pathname,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});expect(allowed.status).toBe(303);await allowed.text();
    const callback=await fetch(allowed.headers.get('location')!,{headers:{Cookie:cookie},redirect:'manual'});expect(callback.status).toBe(303);await callback.text();
  };
  const grant=async(world:string,scope:string)=>{
    const redirect='http://127.0.0.1:9123/payroll-test-callback',registered=await call('/api/oauth/clients',{name:'Payroll HTTP scope verification',redirect_uris:[redirect]});expect(registered.status).toBe(201);
    const client=registered.data.client_id,verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
    const form=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope,state:crypto.randomUUID(),world_id:world,code_challenge:new Bun.CryptoHasher('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
    const accepted=await fetch(base+'/oauth/gusto/authorize',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});expect(accepted.status).toBe(303);await accepted.text();
    const code=new URL(accepted.headers.get('location')!).searchParams.get('code');
    const token=await call('/oauth/gusto/token',{grant_type:'authorization_code',client_id:client,redirect_uri:redirect,code,code_verifier:verifier},undefined,crypto.randomUUID(),true);expect(token.status,JSON.stringify(token.data)).toBe(200);return token.data.access_token as string;
  };
  const create=async(input:any={})=>{const created=await call('/api/worlds',{kind:'payroll-close',name:'Payroll HTTP verification',seed:17,orderCount:2,approvalThresholdMinor:100000000,payrollControls:{missingTime:false,disabledRoute:false},...input});expect(created.status,JSON.stringify(created.data)).toBe(201);return created.data.world;};
  const agent=(world:string)=>{const token=crypto.randomUUID();server.store.put('agent-tokens',hash(token),{world,actor:`agent-world:${world}`,expires_at:Date.now()+60000});return token;};
  const act=(world:string,input:any,token?:string,key?:string)=>call(`/api/worlds/${world}/actions`,input,token,key);
  return {server,base,call,connect,grant,create,agent,act,close:()=>server.close()};
}
async function fixture(){
  const folder=mkdtempSync(join(tmpdir(),'finance-payroll-http-')),database=join(folder,'world.sqlite');
  try{const f=await start(database);return {...f,folder,database,dispose:async()=>{await f.close();rmSync(folder,{recursive:true,force:true});}};}catch(error){rmSync(folder,{recursive:true,force:true});throw error;}
}

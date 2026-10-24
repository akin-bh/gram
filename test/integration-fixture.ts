import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server.ts';
import {hash} from '../src/store.ts';

export async function start(database:string,port=0){
  const server=await startServer({database,port,agentEnabled:false,deliveryIntervalMs:0}),base=server.baseUrl;
  let cookie:string;
  try{
    const home=await fetch(base,{headers:{Connection:'close'}});assert.equal(home.status,200);
    cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
  }catch(error){await server.close();throw error;}
  const call=async(path:string,input?:any,token?:string,key:string=randomUUID(),anonymous=false)=>{
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:(anonymous?{}:{Cookie:cookie})),...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,data:await response.json()};
  };
  const connect=async(world:string,system:string)=>{
    const started=await call(`/api/worlds/${world}/connect/${system}`,{});assert.equal(started.status,200,JSON.stringify(started.data));
    const url=new URL(started.data.authorization_url);
    const consent=await fetch(`${base}/oauth/${system}/consent${url.search}`,{headers:{Cookie:cookie}});assert.equal(consent.status,200);
    const info=await consent.json();assert.equal(info.world,world);assert.equal(info.provider.id,system);assert.deepEqual(info.scopes,['read','write']);
    const params=new URLSearchParams(url.search);params.set('decision','allow');
    const allowed=await fetch(base+url.pathname,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:params,redirect:'manual'});assert.equal(allowed.status,303);await allowed.text();
    const callback=await fetch(allowed.headers.get('location')!,{headers:{Cookie:cookie},redirect:'manual'});assert.equal(callback.status,303);await callback.text();
  };
  const grant=async(world:string,scope:string)=>{
    const redirect='http://127.0.0.1:9123/payroll-test-callback',registered=await call('/api/oauth/clients',{name:'Payroll HTTP scope verification',redirect_uris:[redirect]});assert.equal(registered.status,201);
    const client=registered.data.client_id,verifier=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
    const form=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope,state:randomUUID(),world_id:world,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
    const accepted=await fetch(base+'/oauth/gusto/authorize',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});assert.equal(accepted.status,303);await accepted.text();
    const code=new URL(accepted.headers.get('location')!).searchParams.get('code');
    const token=await call('/oauth/gusto/token',{grant_type:'authorization_code',client_id:client,redirect_uri:redirect,code,code_verifier:verifier},undefined,randomUUID(),true);assert.equal(token.status,200,JSON.stringify(token.data));return token.data.access_token as string;
  };
  const create=async(input:any={})=>{const created=await call('/api/worlds',{kind:'payroll-close',name:'Payroll HTTP verification',seed:17,orderCount:2,approvalThresholdMinor:100000000,payrollControls:{missingTime:false,disabledRoute:false},...input});assert.equal(created.status,201,JSON.stringify(created.data));return created.data.world;};
  const agent=(world:string)=>{const token=randomUUID();server.store.put('agent-tokens',hash(token),{world,actor:`agent-world:${world}`,expires_at:Date.now()+60000});return token;};
  const act=(world:string,input:any,token?:string,key?:string)=>call(`/api/worlds/${world}/actions`,input,token,key);
  return {server,base,call,connect,grant,create,agent,act,close:()=>server.close()};
}
async function fixture(){
  const folder=mkdtempSync(join(tmpdir(),'finance-payroll-http-')),database=join(folder,'world.sqlite');
  try{const f=await start(database);return {...f,folder,database,dispose:async()=>{await f.close();rmSync(folder,{recursive:true,force:true});}};}catch(error){rmSync(folder,{recursive:true,force:true});throw error;}
}

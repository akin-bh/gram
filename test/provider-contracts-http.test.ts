import {test,expect} from 'bun:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {start} from './integration-fixture.ts';
async function grant(f:Awaited<ReturnType<typeof start>>,world:string,system:string,scope:string){
 const home=await fetch(f.base);const cookie=home.headers.get('set-cookie')!.split(';')[0];await home.text();
 const redirect='http://127.0.0.1:9123/native-provider-callback',client=(await f.call('/api/oauth/clients',{name:'Native provider test',redirect_uris:[redirect]})).data.client_id,verifier=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
 const form=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope,state:randomUUID(),world_id:world,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',decision:'allow'});
 const consent=await fetch(`${f.base}/oauth/${system}/authorize`,{method:'POST',headers:{Cookie:cookie,Origin:f.base,'Content-Type':'application/x-www-form-urlencoded'},body:form,redirect:'manual'});assert.equal(consent.status,303);await consent.text();const code=new URL(consent.headers.get('location')!).searchParams.get('code');
 const token=await f.call(`/oauth/${system}/token`,{grant_type:'authorization_code',client_id:client,redirect_uri:redirect,code,code_verifier:verifier},undefined,randomUUID(),true);assert.equal(token.status,200,JSON.stringify(token.data));return token.data.access_token;
}
test('native source documents retain exact bytes, OAuth scope, world isolation and conditional HTTP evidence',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'gram-native-http-'));const f=await start(join(folder,'world.sqlite'));
 try{
  const world=await f.create(),other=await f.create({name:'Other'}),agent=f.agent(world.id),prefix=`/providers/google-drive/worlds/${world.id}/drive/v3/files`,doc=world.documents[0];
  expect((await f.call(prefix,undefined,agent)).status).toBe(401);
  const token=await grant(f,world.id,'google-drive','read'),get=(path:string,headers:Record<string,string>={})=>fetch(f.base+path,{headers:{Authorization:`Bearer ${token}`,...headers}});
  const list=await get(prefix+'?pageSize=2&fields=files(id,name),nextPageToken');expect(list.status).toBe(200);const body=await list.json();expect(body.files).toHaveLength(2);expect(body.nextPageToken).toBeString();
  const media=await get(`${prefix}/${doc.id}?alt=media`);expect(media.status).toBe(200);expect(media.headers.get('content-type')).toBe('text/plain; charset=utf-8');expect(media.headers.get('x-request-id')).toBeString();expect(Buffer.from(await media.arrayBuffer())).toEqual(Buffer.from(doc.body,'utf8'));
  const etag=media.headers.get('etag')!;expect(etag).toBe('"'+createHash('sha256').update(doc.body).digest('hex')+'"');
  const unchanged=await get(`${prefix}/${doc.id}?alt=media`,{'If-None-Match':etag});expect(unchanged.status).toBe(304);expect(await unchanged.text()).toBe('');
  const wrongEtag=await get(`${prefix}/${doc.id}?alt=media`,{'If-Match':'"wrong"'});expect(wrongEtag.status).toBe(412);await wrongEtag.text();
  const cross=await get(`/providers/google-drive/worlds/${other.id}/drive/v3/files/${doc.id}?alt=media`);expect(cross.status).toBe(403);await cross.text();
  const write=await fetch(f.base+prefix+'/'+doc.id,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name:'Changed'})});expect(write.status).toBe(403);await write.text();
  const noExport=await get(`${prefix}/${doc.id}/export?mimeType=text/plain`);expect(noExport.status).toBe(403);await noExport.text();
  const state=f.server.store.world(world.id);expect(JSON.stringify(state)).toBe(JSON.stringify(world));expect(f.server.store.verify(world.id).valid).toBe(true);
  await f.connect(world.id,'sharepoint');const site=(await f.call(`/providers/sharepoint/worlds/${world.id}/v1.0/sites/root`,undefined,agent)).data;
  const drives=(await f.call(`/providers/sharepoint/worlds/${world.id}/v1.0/sites/${site.id}/drives`,undefined,agent)).data;
  const content=await fetch(`${f.base}/providers/sharepoint/worlds/${world.id}/v1.0/drives/${drives.value[0].id}/items/${doc.id}/content`,{headers:{Authorization:`Bearer ${agent}`}});expect(content.status).toBe(200);expect(await content.text()).toBe(doc.body);
  const caps=(await f.call('/api/capabilities')).data;expect(caps.provider_contracts.some((r:any)=>r.id==='drive.files.get'&&r.access==='read')).toBe(true);expect(caps.coverage.rest_subset_providers).toContain('sharepoint');
 }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});
test('native POST reads honor read-only OAuth without idempotency or financial effects',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'gram-native-read-'));const f=await start(join(folder,'world.sqlite'));
 try{
  const w=await f.create(),token=await grant(f,w.id,'plaid','read'),prefix=`/providers/plaid/worlds/${w.id}`;
  const read=await fetch(f.base+prefix+'/transactions/sync',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'});expect(read.status).toBe(200);const result=await read.json();expect(result.added.length).toBe(w.bankTransactions.length);
  const noRoute=await fetch(f.base+prefix+'/transactions/delete',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'});expect(noRoute.status).toBe(403);await noRoute.text();
  expect(JSON.stringify(f.server.store.world(w.id))).toBe(JSON.stringify(w));expect(f.server.store.verify(w.id).valid).toBe(true);
 }finally{await f.close();rmSync(folder,{recursive:true,force:true});}
});

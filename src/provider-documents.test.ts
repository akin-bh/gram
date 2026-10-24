import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWorld,DomainError} from './world.ts';
import type {World} from './world.ts';
import {providerDocuments,providerDocumentIdentity,providerDocumentRoutes} from './provider-documents.ts';

function fixture(id='documents-one'){
  const w=createWorld({orderCount:1},id);
  w.documents=[
    {id:'doc-alpha',type:'purchase-requisition',name:'Alpha policy',body:'Authorized source\r\n£125.00 — café\n',created_at:w.now,vendor_id:'vendor-one'},
    {id:'doc-beta',type:'generated-context',name:'Beta narrative',body:'Context is not authority.',created_at:w.now,authority:'context-only',generated:true,source_refs:['doc-alpha'],record_facts:{'doc-alpha':{type:'purchase-requisition'}}},
    {id:'doc-gamma',type:'policy',name:"Gamma's \\ notes",body:'Trailing newline\n',created_at:w.now,authority:'Requires separate controller approval'},
  ];return w;
}
function request(w:World,system:string,path:string,method='GET',headers?:Headers){const url=new URL(path,'http://local.test:24300'),prefix=`/providers/${system}/worlds/${encodeURIComponent(w.id)}`,route=url.pathname.startsWith(prefix)?url.pathname.slice(prefix.length):url.pathname;return providerDocuments({world:w,system,route,url,method,headers,execute:()=>{throw new Error('Document read unexpectedly executed a domain action');}});}
function error(fn:()=>unknown,code:string,status?:number){assert.throws(fn,(e:any)=>e instanceof DomainError&&e.code===code&&(status===undefined||e.status===status));}
const media=(w:World,id='doc-alpha',headers?:Headers)=>request(w,'google-drive',`/drive/v3/files/${id}?alt=media`,'GET',headers)!;

test('Drive bytes preserve Unicode, CRLF and trailing newline without mutating source authority',()=>{
  const w=fixture(),before=JSON.stringify(w),r=media(w),bytes=Buffer.from(r.rawBody as Uint8Array);
  assert.deepEqual(bytes,Buffer.from(w.documents[0].body,'utf8'));assert.equal(r.headers?.['Content-Length'],String(bytes.length));assert.equal(r.headers?.['Content-Type'],'text/plain; charset=utf-8');assert.equal(r.headers?.ETag,'"'+createHash('sha256').update(bytes).digest('hex')+'"');assert.equal(r.headers?.['Cache-Control'],'private, no-store');assert.equal(r.body,undefined);
  const meta=request(w,'google-drive','/drive/v3/files/doc-alpha?fields=*')!.body;
  assert.equal(meta.size,String(bytes.length));assert.equal(meta.md5Checksum,createHash('md5').update(bytes).digest('hex'));assert.equal(meta.finance_world_source.record_refs.vendor_id,'vendor-one');assert.equal(meta.owners,undefined);assert.equal(meta.permissions,undefined);assert.equal(meta.webContentLink,undefined);assert.equal(meta.mimeType,'text/plain');
  (r.rawBody as Uint8Array)[0]=0;assert.deepEqual(Buffer.from(media(w).rawBody as Uint8Array),Buffer.from(w.documents[0].body));assert.equal(JSON.stringify(w),before);
});

test('Drive generated-context metadata stays context-only and mailbox messages are not promoted to documents',()=>{
  const w=fixture(),doc=request(w,'google-drive','/drive/v3/files/doc-beta?fields=id,mimeType,finance_world_source')!.body;
  assert.deepEqual(doc.finance_world_source,{document_id:'doc-beta',type:'generated-context',authority:'context-only',generated:true,source_refs:['doc-alpha'],record_refs:{},record_facts:{'doc-alpha':{type:'purchase-requisition'}}});
  error(()=>request(w,'google-drive',`/drive/v3/files/${w.messages[0].id}`),'resource_missing',404);
  const page=request(w,'google-drive','/drive/v3/files?fields=files(id)')!.body;assert.deepEqual(page,{files:w.documents.map(d=>({id:d.id}))});
});

test('Drive field masks select exact nested properties and reject missing, unsupported and malformed fields',()=>{
  const w=fixture();assert.deepEqual(request(w,'google-drive','/drive/v3/files?fields=files(id,finance_world_source(type,generated)),nextPageToken')!.body,{files:w.documents.map(d=>({id:d.id,finance_world_source:{type:d.type,generated:d.generated===true}}))});
  assert.deepEqual(request(w,'google-drive','/drive/v3/files?fields=files/id')!.body,{files:w.documents.map(d=>({id:d.id}))});
  for(const fields of ['files(owners)','files(permissions)','files(__proto__)','files(constructor)','not_real'])error(()=>request(w,'google-drive','/drive/v3/files?fields='+encodeURIComponent(fields)),'unsupported_field',501);
  for(const fields of ['', 'files(', 'files(id,)', 'files(id),','files(id))','files(id),files(name)','files(id(foo))'])error(()=>request(w,'google-drive','/drive/v3/files?fields='+encodeURIComponent(fields)),'invalid_fields');
  error(()=>request(w,'google-drive','/drive/v3/files?fields=id&fields=name'),'duplicate_parameter');
});

test('Drive query subset has exact prefix, equality, quoting, trash and parent semantics',()=>{
  const w=fixture(),query=(q:string)=>request(w,'google-drive','/drive/v3/files?fields=files(id)&q='+encodeURIComponent(q))!.body.files.map((d:any)=>d.id);
  assert.deepEqual(query("name contains 'Alpha' and mimeType = 'text/plain' and trashed = false and 'root' in parents"),['doc-alpha']);
  assert.deepEqual(query("name contains 'policy'"),[]);assert.deepEqual(query("name = 'ALPHA POLICY'"),['doc-alpha']);assert.deepEqual(query("name != 'Alpha policy' and trashed != true"),['doc-beta','doc-gamma']);
  assert.deepEqual(query("name = 'Gamma\\'s \\\\ notes'"),['doc-gamma']);assert.deepEqual(query("'missing' in parents"),[]);assert.deepEqual(query('trashed = true'),[]);
  for(const q of ["name = 'Alpha policy' or trashed = false","fullText contains 'source'","name contains 'a' or 1=1","mimeType contains 'text'","name matches 'Alpha'"])error(()=>query(q),'unsupported_filter',501);
  error(()=>query("name = 'Alpha policy' and"),'invalid_filter');error(()=>query(''),'invalid_filter');error(()=>query("name = 'unterminated"),'unsupported_filter');
});

test('Drive pagination traverses one immutable snapshot and binds query, world and source bytes',()=>{
  const w=fixture(),base='/drive/v3/files?pageSize=1&orderBy=name%20desc&fields=nextPageToken,files(id)',ids:string[]=[];let token:string|undefined;
  do{const p=request(w,'google-drive',base+(token?'&pageToken='+token:''))!.body;ids.push(p.files[0].id);token=p.nextPageToken;}while(token);
  assert.deepEqual(ids,['doc-gamma','doc-beta','doc-alpha']);const first=request(w,'google-drive',base)!.body,second=base+'&pageToken='+first.nextPageToken;
  const other=fixture('documents-two');error(()=>request(other,'google-drive',second),'invalid_cursor');error(()=>request(w,'google-drive',second.replace('pageSize=1','pageSize=2')),'invalid_cursor');
  w.now='2026-10-25T09:00:00.000Z';w.revision++;assert.equal(request(w,'google-drive',second)!.body.files[0].id,'doc-beta');w.documents[0].body+='changed';error(()=>request(w,'google-drive',second),'invalid_cursor');
  for(const value of ['0','-1','1.1','1001','1e2',''])error(()=>request(w,'google-drive','/drive/v3/files?pageSize='+value),'invalid_parameter');
  error(()=>request(w,'google-drive','/drive/v3/files?pageToken=garbage'),'invalid_cursor');error(()=>request(w,'google-drive','/drive/v3/files?orderBy=name_natural'),'unsupported_filter');
});

test('Drive export and media respect source format and do not invent PDF or Workspace conversion',()=>{
  const w=fixture();error(()=>request(w,'google-drive','/drive/v3/files/doc-alpha/export?mimeType=text/plain'),'fileNotExportable',403);
  w.documents.push({id:'native-doc',name:'Explicit native text',body:'A text-only native document\n',mimeType:'application/vnd.google-apps.document',type:'test-native-text',created_at:w.now});
  assert.equal(request(w,'google-drive','/drive/v3/files/native-doc?fields=*')!.body.size,undefined);error(()=>media(w,'native-doc'),'fileNotDownloadable',403);
  assert.equal(Buffer.from(request(w,'google-drive','/drive/v3/files/native-doc/export?mimeType=text/plain')!.rawBody as Uint8Array).toString(),w.documents.at(-1).body);
  error(()=>request(w,'google-drive','/drive/v3/files/native-doc/export?mimeType=application/pdf'),'unsupported_export',501);
  error(()=>request(w,'google-drive','/drive/v3/files/doc-alpha?alt=media&fields=id'),'invalid_parameter');error(()=>request(w,'google-drive','/drive/v3/files/doc-alpha?alt=html'),'invalid_parameter');
});

test('Content conditional requests, byte bounds and filenames do not weaken authentication or headers',()=>{
  const w=fixture();w.documents[0].name='Résumé\r\nX-Injected: yes';const first=media(w),etag=first.headers!.ETag;
  assert.ok(!first.headers!['Content-Disposition'].includes('\r'));assert.ok(!first.headers!['Content-Disposition'].includes('\n'));assert.ok(first.headers!['Content-Disposition'].includes('%C3%A9'));
  const unchanged=media(w,'doc-alpha',new Headers({'If-None-Match':`"unrelated", W/${etag}`}));assert.equal(unchanged.status,304);assert.equal(unchanged.rawBody,undefined);assert.equal(unchanged.body,undefined);assert.equal(unchanged.headers!['Content-Length'],undefined);
  error(()=>media(w,'doc-alpha',new Headers({'If-Match':'"wrong"'})),'precondition_failed',412);error(()=>media(w,'doc-alpha',new Headers({Range:'bytes=0-1'})),'unsupported_header',501);
  w.documents[0].body='x'.repeat(1024*1024);assert.equal(Buffer.byteLength(media(w).rawBody as Uint8Array),1024*1024);w.documents[0].body+='x';error(()=>media(w),'document_too_large',413);
});

test('Graph site/drive discovery is synthetic, world-bound and contains no owner or unauthenticated URLs',()=>{
  const w=fixture(),ids=providerDocumentIdentity(w),site=request(w,'sharepoint','/v1.0/sites/root')!.body;
  assert.equal(site.id,ids.siteId);assert.equal(site.siteCollection.hostname,'simulation.test');assert.equal(site.webUrl,undefined);assert.equal(site.owner,undefined);
  const drives=request(w,'sharepoint',`/v1.0/sites/${encodeURIComponent(site.id)}/drives?$select=id,driveType`)!.body;assert.deepEqual(drives.value,[{id:ids.driveId,driveType:'documentLibrary'}]);
  error(()=>request(fixture('another'),'sharepoint',`/v1.0/sites/${encodeURIComponent(site.id)}/drives`),'resource_missing',404);
  error(()=>request(fixture('another'),'sharepoint',`/v1.0/drives/${ids.driveId}/root/children`),'resource_missing',404);
  error(()=>request(w,'sharepoint',`/v1.0/sites/${encodeURIComponent(site.id)}/drives?$select=owner`),'unsupported_field',501);
});

test('Graph pagination and $select remain inside the same authenticated provider world',()=>{
  const w=fixture(),{driveId}=providerDocumentIdentity(w),path=`/v1.0/drives/${driveId}/root/children?$top=1&$orderby=name%20desc&$select=id,name`,ids:string[]=[];let next:string|undefined=path;
  while(next){const p:any=request(w,'sharepoint',next)!.body;ids.push(...p.value.map((v:any)=>v.id));assert.deepEqual(Object.keys(p.value[0]).sort(),['id','name']);next=p['@odata.nextLink'];if(next){const u=new URL(next);assert.equal(u.origin,'http://local.test:24300');assert.equal(u.pathname,`/providers/sharepoint/worlds/${w.id}/v1.0/drives/${driveId}/root/children`);assert.equal(u.searchParams.get('access_token'),null);}}
  assert.deepEqual(ids,['doc-gamma','doc-beta','doc-alpha']);
  const first=request(w,'sharepoint',path)!.body,altered=new URL(first['@odata.nextLink']);altered.searchParams.set('$top','2');error(()=>request(w,'sharepoint',altered.href),'invalid_cursor');
  for(const query of ['$filter=name%20eq%20%27Alpha%27','$expand=children','$select=permissions','$select=@microsoft.graph.downloadUrl','$select=file/mimeType'])assert.throws(()=>request(w,'sharepoint',`/v1.0/drives/${driveId}/root/children?${query}`),(e:any)=>e instanceof DomainError&&e.status===501);
});

test('Graph item metadata and direct authenticated content are real source bytes, not mail or arbitrary URL proxies',()=>{
  const w=fixture(),{driveId}=providerDocumentIdentity(w),base=`/v1.0/drives/${driveId}/items/doc-beta`,meta=request(w,'sharepoint',base)!.body,content=request(w,'sharepoint',base+'/content')!;
  assert.equal(meta.file.mimeType,'text/plain');assert.equal(meta.finance_world_source.authority,'context-only');assert.equal(meta.finance_world_source.generated,true);assert.equal(meta['@microsoft.graph.downloadUrl'],undefined);assert.equal(meta.webUrl,undefined);assert.equal(meta.size,Buffer.byteLength(w.documents[1].body));assert.equal(content.status??200,200);assert.equal(Buffer.from(content.rawBody as Uint8Array).toString(),w.documents[1].body);assert.equal(content.headers?.Location,undefined);
  error(()=>request(w,'sharepoint',base+'/content?url=https://evil.test'),'unsupported_filter');error(()=>request(w,'sharepoint',`/v1.0/drives/${driveId}/items/missing/content`),'resource_missing',404);
  assert.equal(request(w,'sharepoint','/v1.0/shares/arbitrary/driveItem/content'),undefined);
});

test('Both adapters reject writes and unsupported parameters without executing actions or mutating records',()=>{
  const w=fixture(),before=JSON.stringify(w),{driveId}=providerDocumentIdentity(w);
  for(const method of ['POST','PUT','PATCH','DELETE']){error(()=>request(w,'google-drive','/drive/v3/files/doc-alpha',method),'unsupported_operation',501);error(()=>request(w,'sharepoint',`/v1.0/drives/${driveId}/items/doc-alpha/content`,method),'unsupported_operation',501);}
  for(const q of ['includeItemsFromAllDrives=true','spaces=appDataFolder','corpora=allDrives','orderBy=name&orderBy=id'])assert.throws(()=>request(w,'google-drive','/drive/v3/files?'+q),DomainError);
  error(()=>request(w,'google-drive','/drive/v3/files/%ZZ'),'invalid_parameter');error(()=>request(w,'google-drive','/drive/v3/files/%2e%2e%2fdoc-alpha'),'invalid_parameter');assert.equal(request(w,'gmail','/drive/v3/files'),undefined);assert.equal(JSON.stringify(w),before);
  assert.equal(providerDocumentRoutes.length,8);assert.ok(providerDocumentRoutes.every(r=>r.method==='GET'&&r.access==='read'));assert.ok(providerDocumentRoutes.find(r=>r.id==='sharepoint.items.content')!.limitations!.some(s=>s.includes('authenticated 200')));
});

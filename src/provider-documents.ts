/** Read-only, world-scoped Drive v3 / Graph v1.0 document subsets.
 * Canonical text is never converted into a vendor-native format by implication.
 * Authentication and read scope enforcement belong to the provider gateway.
 */
import {createHash} from 'node:crypto';
import {DomainError} from './world.ts';
import type {World} from './world.ts';
import type {ProviderRequest,ProviderResponse} from './provider-adapters.ts';

const DRIVE='https://developers.google.com/workspace/drive/api/reference/rest/v3/files/';
const GRAPH='https://learn.microsoft.com/en-us/graph/api/';
export const providerDocumentRoutes = [
  {id:'drive.files.list',system:'google-drive',method:'GET',path:'/drive/v3/files',access:'read',description:'List canonical source files; bounded q, orderBy, fields and snapshot pagination.',documentation:[DRIVE+'list'],limitations:['Flat source document collection. No owner, permission or shared-drive model.']},
  {id:'drive.files.get',system:'google-drive',method:'GET',path:'/drive/v3/files/:fileId',access:'read',description:'Read source metadata or exact UTF-8 bytes with alt=media.',documentation:[DRIVE+'get'],limitations:['Canonical text/plain sources only; finance_world_source preserves source authority. No download links.']},
  {id:'drive.files.export',system:'google-drive',method:'GET',path:'/drive/v3/files/:fileId/export',access:'read',description:'Export explicitly Google-Docs-formatted text sources as text/plain.',documentation:[DRIVE+'export'],limitations:['Plain text files are not exportable: use alt=media. PDF, Office and spreadsheet conversion unsupported.']},
  {id:'sharepoint.site.get',system:'sharepoint',method:'GET',path:'/v1.0/sites/root',access:'read',description:'Discover the synthetic world-scoped SharePoint site.',documentation:[GRAPH+'site-get?view=graph-rest-1.0']},
  {id:'sharepoint.drives.list',system:'sharepoint',method:'GET',path:'/v1.0/sites/:siteId/drives',access:'read',description:'List the world source-document drive.',documentation:[GRAPH+'drive-list?view=graph-rest-1.0'],limitations:['One flat synthetic document library; no tenant ownership or ACL claims.']},
  {id:'sharepoint.children.list',system:'sharepoint',method:'GET',path:'/v1.0/drives/:driveId/root/children',access:'read',description:'List source items with $select, $top, $skiptoken and $orderby.',documentation:[GRAPH+'driveitem-list-children?view=graph-rest-1.0'],limitations:['No nested folders, $expand or $filter. Pagination links require the same world-scoped authentication.']},
  {id:'sharepoint.items.get',system:'sharepoint',method:'GET',path:'/v1.0/drives/:driveId/items/:itemId',access:'read',description:'Read immutable source item metadata.',documentation:[GRAPH+'driveitem-get?view=graph-rest-1.0']},
  {id:'sharepoint.items.content',system:'sharepoint',method:'GET',path:'/v1.0/drives/:driveId/items/:itemId/content',access:'read',description:'Read exact source UTF-8 bytes through the authenticated gateway.',documentation:[GRAPH+'driveitem-get-content?view=graph-rest-1.0'],limitations:['Local deviation: authenticated 200 content instead of Graph 302 to a preauthenticated URL. No @microsoft.graph.downloadUrl or public links.']},
] as const;

function fail(code:string,message:string,status=400):never{throw new DomainError(status,code,message);}
const hash=(value:string|Uint8Array,algorithm='sha256')=>createHash(algorithm).update(value).digest('hex');
const MAX_CONTENT_BYTES=1024*1024;
const NATIVE_DOC='application/vnd.google-apps.document';
type Source={row:any;bytes:Buffer;mime:string;name:string;source:Record<string,unknown>};
function sources(w:World):Source[]{
  return w.documents.map(row=>{
    if(typeof row.id!=='string'||!row.id||typeof row.body!=='string'||typeof row.name!=='string')fail('unsupported_document','Source document must have an ID, name and canonical text body',501);
    const mime=row.mimeType??row.mime_type??'text/plain';
    if(!['text/plain',NATIVE_DOC].includes(mime))fail('unsupported_document_format',`Unsupported canonical document format: ${mime}`,501);
    const bytes=Buffer.from(row.body,'utf8');if(bytes.length>MAX_CONTENT_BYTES)fail('document_too_large','Document exceeds the 1 MiB read limit',413);
    const refs=Object.fromEntries(Object.entries(row).filter(([key,value])=>key!=='id'&&key.endsWith('_id')&&typeof value==='string'));
    const source={document_id:row.id,type:row.type??null,authority:row.authority??null,generated:row.generated===true,source_refs:structuredClone(row.source_refs??[]),record_refs:refs,...(row.record_facts?{record_facts:structuredClone(row.record_facts)}:{})};
    return {row,bytes,mime,name:row.name,source};
  });
}
function getSource(rows:Source[],id:string){return rows.find(x=>x.row.id===id)??fail('resource_missing','Source document not found in this world',404);}
function decode(value:string){try{const id=decodeURIComponent(value);if(!id||/[\u0000-\u001f\u007f/\\]/.test(id))fail('invalid_parameter','Invalid source identifier');return id;}catch(error){if(error instanceof DomainError)throw error;return fail('invalid_parameter','Malformed source identifier');}}
function query(url:URL,allowed:string[]){for(const key of url.searchParams.keys()){if(!allowed.includes(key))fail('unsupported_filter',`Unsupported query parameter: ${key}`,501);if(url.searchParams.getAll(key).length!==1)fail('duplicate_parameter',`Repeated query parameter: ${key}`);}}
function integer(value:string|null,name:string,fallback:number,max:number){if(value===null)return fallback;if(!/^[1-9]\d*$/.test(value))fail('invalid_parameter',`${name} must be an integer in 1..${max}`);const n=Number(value);if(!Number.isSafeInteger(n)||n>max)fail('invalid_parameter',`${name} must be an integer in 1..${max}`);return n;}

type Mask={ [key:string]:Mask|true };
/** Partial-response selectors: comma lists, nested parentheses and slash paths. */
function parseMask(input:string):Mask{
  if(!input||input.length>2048)fail('invalid_fields','Empty or oversized field selection');let at=0;
  const merge=(into:Mask,key:string,value:Mask|true)=>{if(Object.hasOwn(into,key))fail('invalid_fields',`Repeated field selection: ${key}`);into[key]=value;};
  const parse=(depth:number):Mask=>{
    if(depth>5)fail('invalid_fields','Field selection is too deeply nested');const out:Mask=Object.create(null);
    while(at<input.length){while(input[at]===' ')at++;const match=/^(\*|[A-Za-z_][A-Za-z0-9_.]*)(?:\/(\*|[A-Za-z_][A-Za-z0-9_.]*))?/.exec(input.slice(at));if(!match)fail('invalid_fields','Malformed field selection');at+=match[0].length;let value:Mask|true=true;
      if(input[at]==='('){at++;value=parse(depth+1);if(input[at]!==')')fail('invalid_fields','Unclosed field selection');at++;}
      if(match[2]){if(value!==true)fail('invalid_fields','Combine nested selections with parentheses');value={[match[2]]:true};}
      merge(out,match[1],value);while(input[at]===' ')at++;if(input[at]===','){at++;if(at===input.length||input[at]===')')fail('invalid_fields','Trailing field separator');continue;}break;
    }return out;
  };
  const result=parse(0);if(at!==input.length)fail('invalid_fields','Malformed field selection');return result;
}
function validateMask(mask:Mask,schema:Record<string,any>){for(const [key,nested] of Object.entries(mask)){if(key==='*'){if(nested!==true)fail('invalid_fields','Wildcard cannot have children');continue;}if(!Object.hasOwn(schema,key))fail('unsupported_field',`Unsupported selected field: ${key}`,501);if(nested!==true){if(schema[key]===true)fail('invalid_fields',`${key} has no selectable child fields`);validateMask(nested,schema[key]);}}}
function project(value:any,mask:Mask):any{if(Array.isArray(value))return value.map(item=>project(item,mask));const out:any={};for(const [key,nested] of Object.entries(mask)){if(key==='*'){Object.assign(out,structuredClone(value));continue;}if(Object.hasOwn(value,key))out[key]=nested===true?structuredClone(value[key]):project(value[key],nested);}return out;}
const sourceSchema={document_id:true,type:true,authority:true,generated:true,source_refs:true,record_refs:true,record_facts:true};
const driveSchema={kind:true,id:true,name:true,mimeType:true,createdTime:true,modifiedTime:true,trashed:true,parents:true,size:true,md5Checksum:true,sha256Checksum:true,finance_world_source:sourceSchema};
function select(value:any,input:string|null,schema:Record<string,any>,fallback?:string){if(input===null&&!fallback)return structuredClone(value);const mask=parseMask(input??fallback!);validateMask(mask,schema);return project(value,mask);}
function driveFile(s:Source){return {kind:'drive#file',id:s.row.id,name:s.name,mimeType:s.mime,...(s.row.created_at?{createdTime:s.row.created_at,modifiedTime:s.row.created_at}:{}),trashed:false,parents:['root'],...(s.mime===NATIVE_DOC?{}:{size:String(s.bytes.length),md5Checksum:hash(s.bytes,'md5'),sha256Checksum:hash(s.bytes)}),finance_world_source:s.source};}

function filterDrive(rows:any[],q:string|null){
  if(q===null)return rows;if(!q.trim()||q.length>2048)fail('invalid_filter','Empty or oversized Drive query');
  const tokens:string[]=[];let at=0;
  while(at<q.length){if(/\s/.test(q[at])){at++;continue;}const token=/^(?:'(?:[^'\\]|\\['\\])*'|!=|=|[A-Za-z_][A-Za-z0-9_]*)/.exec(q.slice(at));if(!token)fail('unsupported_filter','Unsupported Drive query syntax',501);tokens.push(token[0]);at+=token[0].length;}
  const string=(value:string|undefined)=>{if(!value?.startsWith("'"))fail('invalid_filter','Expected a quoted string');return value.slice(1,-1).replace(/\\(['\\])/g,'$1');};
  for(let i=0;i<tokens.length;){const field=tokens[i++],op=tokens[i++],value=tokens[i++];if(value===undefined)fail('invalid_filter','Incomplete Drive predicate');
    if(field==='name'&&['=','!=','contains'].includes(op)){const text=string(value).toLocaleLowerCase('en-US');rows=rows.filter(r=>op==='contains'?r.name.toLocaleLowerCase('en-US').startsWith(text):(r.name.toLocaleLowerCase('en-US')===text)===(op==='='));}
    else if(field==='mimeType'&&['=','!='].includes(op)){const text=string(value);rows=rows.filter(r=>(r.mimeType===text)===(op==='='));}
    else if(field==='trashed'&&['=','!='].includes(op)&&['true','false'].includes(value)){rows=rows.filter(r=>(r.trashed===(value==='true'))===(op==='='));}
    else if(field.startsWith("'")&&op==='in'&&value==='parents'){const parent=string(field);rows=rows.filter(r=>r.parents.includes(parent));}
    else fail('unsupported_filter','Supported Drive predicates: name =/!=/contains (prefix), mimeType =/!=, trashed =/!=, and parent in parents',501);
    if(i<tokens.length&&tokens[i++]!=='and')fail('unsupported_filter','Only conjunctions (and) are supported',501);if(i===tokens.length&&tokens.at(-1)==='and')fail('invalid_filter','Incomplete Drive conjunction');
  }return rows;
}
function order(rows:any[],input:string|null,fields:string[]){
  const orders=(input??'name').split(',').map(term=>{const match=/^([A-Za-z]+)(?: (asc|desc))?$/.exec(term.trim());if(!match||!fields.includes(match[1]))fail('unsupported_filter','Unsupported sort order',501);return {key:match[1],descending:match[2]==='desc'};});
  if(orders.length>3||new Set(orders.map(x=>x.key)).size!==orders.length)fail('invalid_parameter','Repeated or excessive sort fields');
  const cmp=(a:any,b:any)=>a===b?0:a===undefined?-1:b===undefined?1:a<b?-1:1;
  return rows.toSorted((a,b)=>{for(const o of orders){const c=cmp(a[o.key],b[o.key]);if(c)return o.descending?-c:c;}return cmp(a.id,b.id);});
}
function page(ctx:ProviderRequest,url:URL,rows:any[],size:number,cursorName:string){
  const params=[...url.searchParams.entries()].filter(([key])=>key!==cursorName).sort(([a],[b])=>a.localeCompare(b));
  const signature=hash(JSON.stringify({world:ctx.world.id,system:ctx.system,route:ctx.route,params,rows,source_digest:hash(JSON.stringify(ctx.world.documents))}));let offset=0;const cursor=url.searchParams.get(cursorName);
  if(cursor!==null){if(cursor.length>1024||!/^[-_A-Za-z0-9]+$/.test(cursor))fail('invalid_cursor','Malformed document cursor');try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(value.v!==1||value.signature!==signature||!Number.isSafeInteger(value.offset)||value.offset<1||value.offset>=rows.length||Object.keys(value).sort().join(',')!=='offset,signature,v')fail('invalid_cursor','Document cursor does not match this world, query or source snapshot');offset=value.offset;}catch(error){if(error instanceof DomainError)throw error;fail('invalid_cursor','Malformed document cursor');}}
  const next=offset+size<rows.length?Buffer.from(JSON.stringify({v:1,signature,offset:offset+size})).toString('base64url'):undefined;
  return {rows:rows.slice(offset,offset+size),next};
}
function raw(ctx:ProviderRequest,s:Source):ProviderResponse{
  if(ctx.headers?.has('range')||ctx.headers?.has('if-range'))fail('unsupported_header','Partial content ranges are not implemented',501);
  const filename=Buffer.from(s.name.slice(0,200),'utf8').toString('utf8');
  const etag='"'+hash(s.bytes)+'"',headers={'Content-Type':'text/plain; charset=utf-8','Content-Length':String(s.bytes.length),'ETag':etag,'Cache-Control':'private, no-store','Content-Disposition':`attachment; filename="document.txt"; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`};
  const matches=(value:string)=>value.split(',').some(item=>item.trim()==='*'||item.trim().replace(/^W\//,'')===etag);
  if(ctx.headers?.has('if-match')&&!matches(ctx.headers.get('if-match')!))fail('precondition_failed','Document ETag does not match',412);
  if(ctx.headers?.has('if-none-match')&&matches(ctx.headers.get('if-none-match')!)){const {'Content-Length':_,...rest}=headers;return {status:304,headers:rest};}
  return {rawBody:Buffer.from(s.bytes),headers};
}
function drive(ctx:ProviderRequest,url:URL):ProviderResponse|undefined{
  const match=/^\/drive\/v3\/files(?:\/([^/]+)(\/export)?)?$/.exec(ctx.route);if(!match)return undefined;
  if(ctx.method!=='GET')fail('unsupported_operation','Source documents are read-only',501);const rows=sources(ctx.world);
  if(!match[1]){
    query(url,['pageSize','pageToken','q','orderBy','fields','spaces','corpora']);if(url.searchParams.has('spaces')&&url.searchParams.get('spaces')!=='drive')fail('unsupported_filter','Only spaces=drive is supported',501);if(url.searchParams.has('corpora')&&url.searchParams.get('corpora')!=='user')fail('unsupported_filter','Only corpora=user is supported',501);
    const sorted=order(filterDrive(rows.map(driveFile),url.searchParams.get('q')),url.searchParams.get('orderBy'),['name','createdTime','modifiedTime']),p=page(ctx,url,sorted,integer(url.searchParams.get('pageSize'),'pageSize',100,1000),'pageToken');
    return {body:select({kind:'drive#fileList',incompleteSearch:false,files:p.rows,...(p.next?{nextPageToken:p.next}:{})},url.searchParams.get('fields'),{kind:true,incompleteSearch:true,files:driveSchema,nextPageToken:true},'kind,incompleteSearch,nextPageToken,files(kind,id,name,mimeType)')};
  }
  const source=getSource(rows,decode(match[1]));
  if(match[2]){query(url,['mimeType']);if(source.mime!==NATIVE_DOC)fail('fileNotExportable','Plain text source files use files.get with alt=media',403);if(url.searchParams.get('mimeType')!=='text/plain')fail('unsupported_export','Only text/plain export is supported',501);return raw(ctx,source);}
  query(url,['fields','alt']);const alt=url.searchParams.get('alt')??'json';if(!['json','media'].includes(alt))fail('invalid_parameter','alt must be json or media');
  if(alt==='media'){if(url.searchParams.has('fields'))fail('invalid_parameter','fields cannot select from raw content');if(source.mime===NATIVE_DOC)fail('fileNotDownloadable','Google Docs sources require files.export',403);return raw(ctx,source);}
  return {body:select(driveFile(source),url.searchParams.get('fields'),driveSchema,'kind,id,name,mimeType')};
}

export function providerDocumentIdentity(w:World){const key=hash(w.id).slice(0,32),guid=(s:string)=>`${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20,32)}`;return {siteId:`simulation.test,${guid(key)},${guid(hash('site:'+w.id).slice(0,32))}`,driveId:`source-drive-${key}`};}
const graphSchema={id:true,name:true,size:true,createdDateTime:true,lastModifiedDateTime:true,eTag:true,cTag:true,file:{mimeType:true,hashes:{sha1Hash:true}},parentReference:{driveId:true,driveType:true,id:true},finance_world_source:sourceSchema};
function graphFile(s:Source,driveId:string){return {id:s.row.id,name:s.name,size:s.bytes.length,...(s.row.created_at?{createdDateTime:s.row.created_at,lastModifiedDateTime:s.row.created_at}:{}),eTag:'"'+hash(JSON.stringify([s.row,s.bytes.toString('base64')]))+'"',cTag:'"'+hash(s.bytes)+'"',file:{mimeType:'text/plain',hashes:{sha1Hash:hash(s.bytes,'sha1')}},parentReference:{driveId,driveType:'documentLibrary',id:'root'},finance_world_source:s.source};}
function graphSelect(value:any,url:URL,schema:Record<string,any>){const input=url.searchParams.get('$select');if(input!==null&&/[()/*@]/.test(input))fail('unsupported_field','Graph $select supports a comma-separated list of top-level properties',501);return select(value,input,schema);}
function graph(ctx:ProviderRequest,url:URL):ProviderResponse|undefined{
  const site=/^\/v1\.0\/sites\/([^/]+)(\/drives)?$/.exec(ctx.route),items=/^\/v1\.0\/drives\/([^/]+)\/(root\/children|items\/([^/]+)(\/content)?)$/.exec(ctx.route);
  if(!site&&!items)return undefined;if(ctx.method!=='GET')fail('unsupported_operation','Source documents are read-only',501);
  const {siteId,driveId}=providerDocumentIdentity(ctx.world);
  if(site){if(site[2]){if(decode(site[1])!==siteId&&site[1]!=='root')fail('resource_missing','SharePoint site not found in this world',404);query(url,['$select','$top','$skiptoken']);integer(url.searchParams.get('$top'),'$top',200,1000);const rows=[{id:driveId,name:'Source documents',driveType:'documentLibrary'}],p=page(ctx,url,rows,1,'$skiptoken');return {body:{value:p.rows.map(row=>graphSelect(row,url,{id:true,name:true,driveType:true}))}};}
    if(site[1]!=='root')return undefined;query(url,['$select']);return {body:graphSelect({id:siteId,name:'sources',displayName:ctx.world.name,siteCollection:{hostname:'simulation.test'}},url,{id:true,name:true,displayName:true,siteCollection:{hostname:true}})};
  }
  if(decode(items![1])!==driveId)fail('resource_missing','Source drive not found in this world',404);const rows=sources(ctx.world);
  if(items![2]==='root/children'){
    query(url,['$select','$top','$skiptoken','$orderby']);const sorted=order(rows.map(s=>graphFile(s,driveId)),url.searchParams.get('$orderby'),['name','size','createdDateTime','lastModifiedDateTime']),p=page(ctx,url,sorted,integer(url.searchParams.get('$top'),'$top',200,1000),'$skiptoken');
    const next=new URL(`/providers/sharepoint/worlds/${encodeURIComponent(ctx.world.id)}${ctx.route}`,url.origin);next.search=url.search;next.searchParams.set('$skiptoken',p.next??'');
    return {body:{value:p.rows.map(row=>graphSelect(row,url,graphSchema)),...(p.next?{'@odata.nextLink':next.href}:{})}};
  }
  const source=getSource(rows,decode(items![3]));if(items![4]){query(url,[]);return raw(ctx,source);}query(url,['$select']);return {body:graphSelect(graphFile(source,driveId),url,graphSchema)};
}

export function providerDocuments(ctx:ProviderRequest):ProviderResponse|undefined{
  const url=typeof ctx.url==='string'?new URL(ctx.url):ctx.url;
  if(ctx.system==='google-drive')return drive(ctx,url);if(ctx.system==='sharepoint')return graph(ctx,url);return undefined;
}

import PostalMime, { addressParser, decodeWords } from 'postal-mime';
import { createHash } from 'node:crypto';

/** Bounded synthetic mail, never an SMTP transport or an HTML rendering surface. */
export const MAIL_LIMITS = Object.freeze({
  rawBytes: 512 * 1024, textBytes: 128 * 1024, headerBytes: 32 * 1024,
  attachments: 20, attachmentBytes: 256 * 1024, totalAttachmentBytes: 384 * 1024,
  recipients: 50, parts: 64, nesting: 12,
});
export type MailHeader = { name: string; value: string };
export type MailAttachment = { id: string; filename: string; mimeType: string; size: number; data: string; disposition: 'attachment' | 'inline'; contentId?: string };
export type MailContent = {
  from: string; to: string[]; cc: string[]; subject: string; body: string; html?: string;
  attachments: MailAttachment[]; headers?: MailHeader[]; message_id?: string;
  in_reply_to?: string; references?: string[]; date?: string; raw?: string;
};
export class MailError extends Error {
  status: number; code: string;
  constructor(code: string, message: string, status = 400) { super(message); this.name = 'MailError'; this.code = code; this.status = status; }
}
function fail(code: string, message: string, status = 400): never { throw new MailError(code, message, status); }
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const b64 = (data: string | Buffer) => Buffer.from(data).toString('base64url');
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const singletons = new Set(['from','sender','to','cc','bcc','reply-to','subject','date','message-id','in-reply-to','references','mime-version','content-type','content-disposition','content-transfer-encoding','content-id']);
const reservedHeaders = new Set(['from','sender','to','cc','bcc','subject','date','message-id','in-reply-to','references','mime-version','content-type','content-disposition','content-transfer-encoding','content-id']);

function headerText(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || /[\r\n]/.test(value) || control.test(value)) fail('invalid_mail_header', `${name} must be a bounded single-line header value`);
  return value;
}
function checkEncodedHeader(value: string) {
  // Some tolerant MIME parsers unfold encoded CR/LF. Reject it before decoding so
  // the evidence cannot hide a header injection behind RFC 2047 encoding.
  for (const match of value.matchAll(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi)) {
    const bytes = match[2].toLowerCase() === 'b' ? Buffer.from(match[3], 'base64') : quotedPrintable(Buffer.from(match[3].replaceAll('_', ' '), 'ascii'));
    if (bytes.includes(10) || bytes.includes(13) || bytes.includes(0)) fail('invalid_mail_header', 'Encoded header values may not contain line breaks or NUL');
  }
}
function decodedHeader(value: string, name: string) { checkEncodedHeader(value); return headerText(decodeWords(value), name); }

export function decodeBase64url(value: unknown, name: string, max: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 + 2) fail('mail_too_large', `${name} exceeds its byte limit`, 413);
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value) || value.replace(/=+$/, '').length % 4 === 1) fail('invalid_base64url', `${name} must be valid base64url`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > max) fail('mail_too_large', `${name} exceeds its byte limit`, 413);
  if (bytes.toString('base64url') !== value.replace(/=+$/, '')) fail('invalid_base64url', `${name} must be canonical base64url`);
  return bytes;
}
function emailAddress(value: string): string {
  headerText(value, 'email address', 254);
  const split = value.lastIndexOf('@'), local = value.slice(0, split), domain = value.slice(split + 1).toLowerCase();
  if (split < 1 || value.indexOf('@') !== split || local.length > 64 || !/^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain.includes('.') || domain.split('.').some(label => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) fail('invalid_recipient', `Invalid email address: ${value}`);
  return `${local}@${domain}`;
}
function addresses(input: unknown, name: string, defaultValue: string[] = []): string[] {
  if (input === undefined || input === null) return [...defaultValue];
  const values = typeof input === 'string' ? [input] : Array.isArray(input) ? input : fail('invalid_recipient', `${name} must be addresses or an address list`);
  if (values.length > MAIL_LIMITS.recipients) fail('too_many_recipients', 'Too many email recipients');
  const out: string[] = [];
  for (const value of values) {
    headerText(value, name);
    const parsed = addressParser(value as string, { flatten: true });
    if (!parsed.length && value) fail('invalid_recipient', `Invalid ${name} header`);
    for (const mailbox of parsed) {
      if (!mailbox.address) fail('invalid_recipient', 'Empty addresses and address groups are not valid recipients');
      out.push(emailAddress(mailbox.address));
    }
  }
  if (out.length > MAIL_LIMITS.recipients) fail('too_many_recipients', 'Too many email recipients');
  return [...new Set(out)];
}
function messageId(value: unknown, name: string): string {
  const text = headerText(value, name, 998);
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(text)) fail('invalid_mail_header', `${name} must contain one RFC message ID`);
  return text;
}
function referenceIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.length > 50) fail('invalid_mail_header', 'At most 50 message references are allowed');
    return value.map(id => messageId(id, 'References'));
  }
  const text = headerText(value, 'References');
  const refs = text.match(/<[^<>]*>/g) ?? [];
  if (text.replace(/<[^<>]*>/g, '').trim()) fail('invalid_mail_header', 'References must contain RFC message IDs');
  return referenceIds(refs);
}
function textContent(value: unknown, name: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.includes('\0')) fail('invalid_mail_content', `${name} must be text without NUL`);
  if (Buffer.byteLength(value) > MAIL_LIMITS.textBytes) fail('mail_too_large', `${name} exceeds ${MAIL_LIMITS.textBytes} bytes`, 413);
  return value;
}
function filename(value: unknown): string {
  const text = headerText(value, 'filename', 512);
  if (!text || text === '.' || text === '..' || /[\\/]/.test(text)) fail('invalid_attachment', 'Attachment filenames cannot contain paths');
  return text;
}
function mimeType(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value) || value.length > 120) fail('invalid_attachment', 'Attachment MIME type must be a media type without parameters');
  return value.toLowerCase();
}
function normalizedAttachments(input: unknown): MailAttachment[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAIL_LIMITS.attachments) fail('too_many_attachments', `At most ${MAIL_LIMITS.attachments} attachments are supported`, 413);
  let total = 0;
  return input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('invalid_attachment', 'Attachment must be an object');
    const data = decodeBase64url(item.data, 'attachment data', MAIL_LIMITS.attachmentBytes);
    total += data.length; if (total > MAIL_LIMITS.totalAttachmentBytes) fail('mail_too_large', 'Combined attachments exceed the byte limit', 413);
    if (item.size !== undefined && item.size !== data.length) fail('invalid_attachment', 'Attachment size does not match decoded bytes');
    const name = filename(item.filename ?? `attachment-${index + 1}`), type = mimeType(item.mimeType ?? 'application/octet-stream');
    const disposition = item.disposition ?? 'attachment';
    if (!['attachment', 'inline'].includes(disposition)) fail('unsupported_mime', 'Only attachment and inline dispositions are supported', 415);
    const id = `att-${index}-${digest(Buffer.concat([Buffer.from(`${name}\0${type}\0`), data])).slice(0, 24)}`;
    return { id, filename: name, mimeType: type, size: data.length, data: data.toString('base64url'), disposition, ...(item.contentId ? {contentId: messageId(item.contentId, 'Content-ID')} : {}) };
  });
}

/** Plain-text fallback only. The original HTML remains untrusted stored evidence. */
export function htmlToText(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<\/(?:p|div|li|tr|h[1-6])\s*>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_all, entity: string) => {
    const named: Record<string, string> = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] || '';
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : parseInt(entity.slice(1),10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

type MimeNode = {headers: MailHeader[]; mimeType: string; params: Record<string,string>; disposition?: string; dispositionParams: Record<string,string>; bytes: Buffer; children: MimeNode[]; attachment: boolean};
type ScanBudget = {parts: number; headerBytes: number};
function splitParameters(value: string): {type: string; params: Record<string,string>} {
  const chunks: string[] = []; let current = '', quoted = false, escaped = false;
  for (const c of value) { if (escaped) { current += c; escaped = false; continue; } if (c === '\\' && quoted) { current += c; escaped = true; continue; } if (c === '"') quoted = !quoted; if (c === ';' && !quoted) {chunks.push(current);current='';} else current += c; }
  if (quoted || escaped) fail('invalid_mime','Unterminated MIME parameter'); chunks.push(current);
  const type = chunks.shift()!.trim().toLowerCase(), params: Record<string,string> = {};
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const match = /^\s*([a-zA-Z0-9!*_-]+)\s*=\s*(.*)\s*$/.exec(chunk) ?? fail('invalid_mime','Malformed MIME parameter');
    const key = match[1].toLowerCase(); if (key in params) fail('invalid_mime',`Duplicate MIME parameter ${key}`);
    const value = match[2].trim(); params[key] = value.startsWith('"') ? value.slice(1,-1).replace(/\\(.)/g,'$1') : value;
  }
  return {type,params};
}
function parameterText(params:Record<string,string>,name:string):string|undefined {
  let encoded=params[`${name}*`];
  if(encoded===undefined&&params[`${name}*0*`]!==undefined){let index=0;encoded='';while(params[`${name}*${index}*`]!==undefined){encoded+=params[`${name}*${index}*`];index++;}if(Object.keys(params).some(key=>new RegExp(`^${name}\\*\\d+\\*?$`).test(key)&&Number(key.match(/\d+/)![0])>=index))fail('invalid_mime','Noncontiguous RFC 2231 parameter');}
  if(encoded!==undefined){
    const match=/^([^']*)'[^']*'(.*)$/.exec(encoded)??fail('invalid_mime','Malformed RFC 2231 parameter');
    const source=match[2],bytes:number[]=[];
    for(let i=0;i<source.length;i++){if(source[i]==='%'){const pair=source.slice(i+1,i+3);if(!/^[a-f0-9]{2}$/i.test(pair))fail('invalid_mime','Malformed RFC 2231 escape');bytes.push(parseInt(pair,16));i+=2;}else{if(source.charCodeAt(i)>127)fail('invalid_mime','RFC 2231 parameter must percent-encode Unicode');bytes.push(source.charCodeAt(i));}}
    let value:string;try{value=new TextDecoder(match[1]||'utf-8',{fatal:true}).decode(Buffer.from(bytes));}catch{return fail('unsupported_mime','Unsupported or invalid RFC 2231 parameter charset',415);}return headerText(value,name);
  }
  return params[name]===undefined?undefined:decodedHeader(params[name],name);
}
function headerValue(headers: MailHeader[], name: string) { return headers.find(h => h.name.toLowerCase() === name)?.value; }
function parseHeaders(buffer: Buffer, budget: ScanBudget): MailHeader[] {
  budget.headerBytes += buffer.length; if (budget.headerBytes > MAIL_LIMITS.headerBytes) fail('mail_too_large', 'MIME headers exceed the byte limit', 413);
  let block: string; try {block = new TextDecoder('utf-8', {fatal:true}).decode(buffer);} catch {return fail('invalid_mime','Headers must use ASCII, UTF-8 or RFC encoded words');}
  if (/\r(?!\n)/.test(block) || control.test(block)) fail('invalid_mail_header','Invalid control byte in message headers');
  const lines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {if (!lines.length) fail('invalid_mail_header','Header continuation has no preceding field'); lines[lines.length-1] += ' ' + line.trim();}
    else lines.push(line);
  }
  const headers: MailHeader[] = [], seen = new Set<string>();
  for (const line of lines) {
    const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[ \t]*(.*)$/.exec(line) ?? fail('invalid_mail_header','Malformed MIME header');
    const key = match[1].toLowerCase(); if (seen.has(key) && singletons.has(key)) fail('invalid_mail_header',`Duplicate ${key} header`); seen.add(key);
    const value = headerText(match[2], match[1]); checkEncodedHeader(value); headers.push({name:match[1],value});
  }
  return headers;
}
function quotedPrintable(bytes: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]; if (b !== 61) {out.push(b);continue;}
    if (bytes[i+1] === 13 && bytes[i+2] === 10) {i+=2;continue;}
    if (bytes[i+1] === 10) {i++;continue;}
    const pair = bytes.subarray(i+1,i+3).toString('ascii');
    if (!/^[0-9a-f]{2}$/i.test(pair)) fail('invalid_mime','Malformed quoted-printable escape');
    out.push(parseInt(pair,16));i+=2;
  }
  return Buffer.from(out);
}
function decodeTransfer(bytes: Buffer, encoding: string): Buffer {
  if (encoding === 'base64') {
    const value = bytes.toString('ascii').replace(/[\r\n\t ]/g,'');
    if (bytes.some(b => b > 127) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('invalid_mime','Malformed MIME base64 payload');
    const decoded = Buffer.from(value,'base64'); if (decoded.toString('base64') !== value) fail('invalid_mime','Noncanonical MIME base64 payload'); return decoded;
  }
  if (encoding === 'quoted-printable') return quotedPrintable(bytes);
  if (!['7bit','8bit'].includes(encoding)) fail('unsupported_mime',`Unsupported MIME transfer encoding: ${encoding}`,415);
  if (encoding === '7bit' && bytes.some(b=>b>127)) fail('invalid_mime','7bit content contains non-ASCII bytes');
  return bytes;
}
function scanMime(buffer: Buffer, budget: ScanBudget = {parts:0,headerBytes:0}, depth = 0): MimeNode {
  if (++budget.parts > MAIL_LIMITS.parts || depth > MAIL_LIMITS.nesting) fail('mail_too_large','MIME structure exceeds part or nesting limit',413);
  const source = buffer.toString('latin1'), separator = /\r?\n\r?\n/.exec(source) ?? fail('invalid_mime','Message headers and body must be separated by a blank line');
  const headers = parseHeaders(buffer.subarray(0,separator.index),budget), rawBody = buffer.subarray(separator.index + separator[0].length);
  const contentType = splitParameters(headerValue(headers,'content-type') ?? 'text/plain; charset=us-ascii'), disposition = splitParameters(headerValue(headers,'content-disposition') ?? '');
  const namedFile=parameterText(disposition.params,'filename')??parameterText(contentType.params,'name');
  if(namedFile!==undefined)filename(namedFile);
  const type = mimeType(contentType.type), attachment = disposition.type === 'attachment' || namedFile!==undefined || !type.startsWith('multipart/') && !['text/plain','text/html'].includes(type);
  if (disposition.type && !['attachment','inline'].includes(disposition.type)) fail('unsupported_mime',`Unsupported MIME disposition: ${disposition.type}`,415);
  const encoding = (headerValue(headers,'content-transfer-encoding') ?? '8bit').toLowerCase();
  const node: MimeNode = {headers,mimeType:type,params:contentType.params,disposition:disposition.type || undefined,dispositionParams:disposition.params,bytes:Buffer.alloc(0),children:[],attachment};
  if (type.startsWith('multipart/')) {
    if (!['multipart/mixed','multipart/alternative','multipart/related'].includes(type)) fail('unsupported_mime',`Unsupported MIME container: ${type}`,415);
    if (!['7bit','8bit'].includes(encoding)) fail('invalid_mime','Multipart containers cannot be transfer-encoded');
    const boundary = contentType.params.boundary;
    if (!boundary || boundary.length > 70 || /[^\x20-\x7e]|[\r\n]/.test(boundary) || boundary.endsWith(' ')) fail('invalid_mime','Multipart boundary is missing or malformed');
    let current: number | null = null, closed = false;
    const escaped=boundary.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),delimiters=new RegExp(`^--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`,'gm');
    for(const match of rawBody.toString('latin1').matchAll(delimiters)){
      if(current!==null){let end=match.index;if(rawBody[end-1]===10)end--;if(rawBody[end-1]===13)end--;if(end<=current)fail('invalid_mime','Multipart contains an empty part');node.children.push(scanMime(rawBody.subarray(current,end),budget,depth+1));}
      if(match[1]){closed=true;current=null;break;}
      current=match.index+match[0].length;
    }
    if (!closed || !node.children.length) fail('invalid_mime','Malformed or unterminated multipart boundary');
  } else {
    if (type.startsWith('message/') || type === 'application/pkcs7-mime' || type === 'application/x-pkcs7-mime') fail('unsupported_mime','Nested RFC822 and encrypted mail are not implemented',415);
    node.bytes = decodeTransfer(rawBody,encoding);
  }
  return node;
}
const leaves = (node: MimeNode): MimeNode[] => node.children.length ? node.children.flatMap(leaves) : [node];
function decodeText(node: MimeNode): string {
  const charset = (node.params.charset || 'utf-8').toLowerCase();
  if (!['utf-8','utf8','us-ascii','ascii','iso-8859-1','latin1','windows-1252'].includes(charset)) fail('unsupported_mime',`Unsupported text charset: ${charset}`,415);
  if (['us-ascii','ascii'].includes(charset) && node.bytes.some(b=>b>127)) fail('invalid_mime','ASCII content contains non-ASCII bytes');
  try {return new TextDecoder(charset === 'utf8' ? 'utf-8' : charset, {fatal:true}).decode(node.bytes);} catch {return fail('invalid_mime','Text body does not match its declared charset');}
}
function bodyParts(root: MimeNode) {
  const parts = leaves(root).filter(n=>!n.attachment), html = parts.filter(n=>n.mimeType==='text/html').map(decodeText).join('\n');
  const text = parts.filter(n=>n.mimeType==='text/plain').map(decodeText).join('\n');
  return {body:text || (html ? htmlToText(html) : ''), ...(html ? {html} : {})};
}
function assertRawMatches(raw: Buffer, input: MailContent): MimeNode {
  const root = scanMime(raw), headers=root.headers;
  const from = addresses(headerValue(headers,'from'),'From',['finance@simulation.test']);
  if (from.length!==1 || from[0]!==input.from || JSON.stringify(addresses(headerValue(headers,'to'),'To'))!==JSON.stringify(input.to) || JSON.stringify(addresses(headerValue(headers,'cc'),'Cc'))!==JSON.stringify(input.cc)) fail('raw_content_mismatch','Raw MIME sender and recipients must match canonical mail');
  if(headerValue(headers,'bcc')!==undefined)fail('unsupported_mime','Bcc is not implemented; use To or Cc',415);
  if(headerValue(headers,'sender')!==undefined&&JSON.stringify(addresses(headerValue(headers,'sender'),'Sender'))!==JSON.stringify(from))fail('unsupported_sender','Sender must match From',403);
  if (decodedHeader(headerValue(headers,'subject') ?? '', 'Subject') !== input.subject) fail('raw_content_mismatch','Raw MIME subject must match canonical mail');
  const bodies=bodyParts(root); if (bodies.body!==input.body || (bodies.html||'')!==(input.html||'')) fail('raw_content_mismatch','Raw MIME text and HTML must match canonical mail');
  const parts=leaves(root).filter(n=>n.attachment);
  if (parts.length!==input.attachments.length || parts.some((node,i)=>node.bytes.toString('base64url')!==input.attachments[i].data || node.mimeType!==input.attachments[i].mimeType)) fail('raw_content_mismatch','Raw MIME attachments must match canonical mail');
  parts.forEach((node,index)=>{
    const attachment=input.attachments[index],name=parameterText(node.dispositionParams,'filename')??parameterText(node.params,'name');
    if(name!==undefined&&name!==attachment.filename)fail('raw_content_mismatch','Raw MIME filename differs from canonical attachment');
    if((node.disposition??'attachment')!==attachment.disposition)fail('raw_content_mismatch','Raw MIME disposition differs from canonical attachment');
    const header=headerValue(node.headers,'content-id'),contentId=header===undefined?undefined:messageId(header,'Content-ID');
    if(contentId!==attachment.contentId)fail('raw_content_mismatch','Raw MIME Content-ID differs from canonical attachment');
  });
  if(input.headers&&JSON.stringify(input.headers)!==JSON.stringify(headers))fail('raw_content_mismatch','Raw MIME headers must match canonical headers');
  return root;
}

/** Pure synchronous boundary used by the domain for every generated/injected email. */
export function validateMailContent(input: any): MailContent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_mail_content','Mail content must be an object');
  const from=addresses(input.from,'From',['finance@simulation.test']); if(from.length!==1)fail('invalid_sender','One sender is required');
  if(input.direction==='outbound'&&from[0].toLowerCase()!=='finance@simulation.test')fail('unsupported_sender','Outbound sender must be finance@simulation.test',403);
  const to=addresses(input.to,'To',['finance@simulation.test']),cc=addresses(input.cc,'Cc');
  if (!to.length&&!cc.length || to.length+cc.length>MAIL_LIMITS.recipients) fail('invalid_recipient',`Provide 1–${MAIL_LIMITS.recipients} recipients`);
  const subject=headerText(input.subject??'','Subject',998),html=input.html===undefined?undefined:textContent(input.html,'HTML');
  const body=textContent(input.body??(html?htmlToText(html):''),'body'),attachments=normalizedAttachments(input.attachments);
  if (!body && !html && !attachments.length) fail('invalid_mail_content','An email needs text, HTML or an attachment');
  const content:MailContent={from:from[0],to,cc,subject,body,...(html!==undefined?{html}:{}),attachments};
  if (input.message_id !== undefined) content.message_id=messageId(input.message_id,'Message-ID');
  if (input.in_reply_to !== undefined) content.in_reply_to=messageId(input.in_reply_to,'In-Reply-To');
  if (input.references !== undefined) content.references=referenceIds(input.references);
  if (input.date !== undefined) {const date=headerText(input.date,'Date',100);if(!Number.isFinite(Date.parse(date)))fail('invalid_mail_header','Date must be a valid timestamp');content.date=new Date(date).toISOString();}
  if (input.headers !== undefined) {
    if(!Array.isArray(input.headers)||input.headers.length>100)fail('invalid_mail_header','At most 100 headers are supported');
    let bytes=0;const seen=new Set<string>();
    content.headers=input.headers.map((h:any)=>{
      if(!h||typeof h.name!=='string'||!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(h.name))fail('invalid_mail_header','Invalid header name');
      const value=headerText(h.value,h.name),key=h.name.toLowerCase();checkEncodedHeader(value);
      if(seen.has(key)&&singletons.has(key))fail('invalid_mail_header',`Duplicate ${key} header`);seen.add(key);
      bytes+=Buffer.byteLength(h.name+value);if(bytes>MAIL_LIMITS.headerBytes)fail('mail_too_large','Headers exceed byte limit',413);
      return {name:h.name,value};
    });
    for(const h of content.headers!) {
      const key=h.name.toLowerCase();
      if(key==='bcc')fail('unsupported_mime','Bcc is not implemented; use To or Cc',415);
      if(key==='from'&&JSON.stringify(addresses(h.value,'From'))!==JSON.stringify([content.from]))fail('raw_content_mismatch','From header differs from canonical sender');
      if(key==='sender'&&JSON.stringify(addresses(h.value,'Sender'))!==JSON.stringify([content.from]))fail('unsupported_sender','Sender must match From',403);
      if(key==='to'&&JSON.stringify(addresses(h.value,'To'))!==JSON.stringify(content.to))fail('raw_content_mismatch','To header differs from canonical recipients');
      if(key==='cc'&&JSON.stringify(addresses(h.value,'Cc'))!==JSON.stringify(content.cc))fail('raw_content_mismatch','Cc header differs from canonical recipients');
      if(key==='subject'&&decodedHeader(h.value,'Subject')!==content.subject)fail('raw_content_mismatch','Subject header differs from canonical subject');
      if(key==='reply-to')addresses(h.value,'Reply-To');
      if(key==='message-id'||key==='in-reply-to'){
        const id=messageId(h.value,h.name),field=key==='message-id'?'message_id':'in_reply_to';
        if(content[field]!==undefined&&content[field]!==id)fail('raw_content_mismatch',`${h.name} differs from canonical metadata`);content[field]=id;
      }
      if(key==='references'){
        const ids=referenceIds(h.value);if(content.references&&JSON.stringify(content.references)!==JSON.stringify(ids))fail('raw_content_mismatch','References differ from canonical metadata');content.references=ids;
      }
      if(key==='date'){
        if(!Number.isFinite(Date.parse(h.value)))fail('invalid_mail_header','Date must be a valid timestamp');const value=new Date(h.value).toISOString();
        if(content.date&&content.date!==value)fail('raw_content_mismatch','Date differs from canonical metadata');content.date=value;
      }
      if(input.raw===undefined&&['content-type','content-disposition','content-transfer-encoding','content-id','mime-version'].includes(key))fail('unsupported_mime','For structured mail, provide body/html/attachments instead of raw MIME structure headers',415);
    }
  }
  if (input.raw !== undefined) {
    const raw=decodeBase64url(input.raw,'raw MIME',MAIL_LIMITS.rawBytes),root=assertRawMatches(raw,content);content.raw=raw.toString('base64url');content.headers=root.headers;
    for(const [name,key] of [['message-id','message_id'],['in-reply-to','in_reply_to']] as const){const value=headerValue(root.headers,name);if(value!==undefined){const id=messageId(value,name);if(content[key]!==undefined&&content[key]!==id)fail('raw_content_mismatch',`${name} differs from canonical metadata`);content[key]=id;}}
    const references=headerValue(root.headers,'references');if(references!==undefined){const ids=referenceIds(references);if(content.references&&JSON.stringify(ids)!==JSON.stringify(content.references))fail('raw_content_mismatch','References differ from canonical metadata');content.references=ids;}
    const sentAt=headerValue(root.headers,'date');if(sentAt!==undefined){if(!Number.isFinite(Date.parse(sentAt)))fail('invalid_mail_header','Date must be a valid timestamp');const date=new Date(sentAt).toISOString();if(content.date&&content.date!==date)fail('raw_content_mismatch','Date differs from canonical metadata');content.date=date;}
  } else encodeCanonicalMail(content,input); // Validate the eventual serialized size before storing it.
  return content;
}

/** Parse provider raw MIME with PostalMime, then retain original bytes and validated canonical content. */
export async function parseMimeMessage(raw: unknown, direction: 'inbound'|'outbound' = 'outbound'): Promise<MailContent> {
  const bytes=decodeBase64url(raw,'raw MIME',MAIL_LIMITS.rawBytes);if(!bytes.length)fail('invalid_mime','raw MIME cannot be empty');
  const root=scanMime(bytes), bodies=bodyParts(root);
  let parsed:Awaited<ReturnType<typeof PostalMime.parse>>;
  try {parsed=await PostalMime.parse(bytes,{attachmentEncoding:'arraybuffer',maxNestingDepth:MAIL_LIMITS.nesting,maxPartCount:MAIL_LIMITS.parts,maxHeadersSize:MAIL_LIMITS.headerBytes,maxRfc822NestingDepth:0,maxForwardedAddresses:MAIL_LIMITS.recipients});}
  catch(error:any){throw new MailError('invalid_mime',`MIME parser rejected message: ${error.code||error.message}`,String(error.code).startsWith('EMAX')?413:400);}
  const attachments=parsed.attachments.map((a,index)=>{
    const data=typeof a.content==='string'?Buffer.from(a.content,a.encoding==='base64'?'base64':'utf8'):Buffer.from(a.content as Uint8Array);
    return {filename:a.filename||`attachment-${index+1}`,mimeType:a.mimeType,size:data.length,data:data.toString('base64url'),disposition:a.disposition||'attachment',...(a.contentId?{contentId:a.contentId}:{})};
  });
  const get=(name:string)=>headerValue(root.headers,name);
  return validateMailContent({direction,from:get('from')??'finance@simulation.test',to:get('to')??[],cc:get('cc')??[],subject:parsed.subject??'',...bodies,attachments,headers:root.headers,...(parsed.messageId?{message_id:parsed.messageId}:{}),...(parsed.inReplyTo?{in_reply_to:parsed.inReplyTo}:{}),...(parsed.references?{references:referenceIds(parsed.references)}:{}),...(parsed.date?{date:parsed.date}:{}),raw:bytes.toString('base64url')});
}

function encodedWord(value:string) {return /[^\x20-\x7e]/.test(value)?`=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`:value;}
const wrapBase64=(data:Buffer)=>data.toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
function encodeCanonicalMail(content:MailContent,message:any):Buffer {
  const tag=digest(String(message.id??'mail')+content.subject).slice(0,24),mixed=`fw-mixed-${tag}`,alternative=`fw-alt-${tag}`;
  const headers=[`From: ${content.from}`,`To: ${content.to.join(', ')}`,...(content.cc.length?[`Cc: ${content.cc.join(', ')}`]:[]),`Subject: ${encodedWord(content.subject)}`,`Date: ${new Date(content.date??message.created_at??'2026-10-24T09:00:00Z').toUTCString()}`,`Message-ID: ${content.message_id??`<${message.id??tag}@simulation.test>`}`,...(content.in_reply_to?[`In-Reply-To: ${content.in_reply_to}`]:[]),...(content.references?.length?[`References: ${content.references.join(' ')}`]:[]),...(content.headers??[]).filter(h=>!reservedHeaders.has(h.name.toLowerCase())).map(h=>`${h.name}: ${encodedWord(h.value)}`),'MIME-Version: 1.0'];
  const textPart=(type:string,text:string)=>`Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapBase64(Buffer.from(text))}`;
  let body=content.html!==undefined?`Content-Type: multipart/alternative; boundary="${alternative}"\r\n\r\n--${alternative}\r\n${textPart('text/plain',content.body)}\r\n--${alternative}\r\n${textPart('text/html',content.html)}\r\n--${alternative}--`:textPart('text/plain',content.body);
  if(content.attachments.length){
    const parts=content.attachments.map(a=>`Content-Type: ${a.mimeType}\r\nContent-Disposition: ${a.disposition}; filename*=UTF-8''${encodeURIComponent(a.filename)}\r\n${a.contentId?`Content-ID: ${a.contentId}\r\n`:''}Content-Transfer-Encoding: base64\r\n\r\n${wrapBase64(Buffer.from(a.data,'base64url'))}`);
    body=`Content-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n--${mixed}\r\n${[body,...parts].join(`\r\n--${mixed}\r\n`)}\r\n--${mixed}--`;
  }
  const raw=Buffer.from(headers.join('\r\n')+'\r\n'+body);if(raw.length>MAIL_LIMITS.rawBytes)fail('mail_too_large','Generated MIME exceeds raw message byte limit',413);return raw;
}
export function rawMailBytes(message:any):Buffer {return message.raw?decodeBase64url(message.raw,'raw MIME',MAIL_LIMITS.rawBytes):encodeCanonicalMail(validateMailContent(message),message);}
export function mailHeaders(message:any):MailHeader[] {
  const root=scanMime(rawMailBytes(message));
  return root.headers.map(h=>({name:h.name,value:decodedHeader(h.value,h.name)}));
}
export function gmailMimePayload(message:any):any {
  const root=scanMime(rawMailBytes(message));let attachmentIndex=0;
  function shape(node:MimeNode,partId:string):any {
    const headers=node.headers.map(h=>({name:h.name,value:decodedHeader(h.value,h.name)}));
    if(node.children.length)return {partId,mimeType:node.mimeType,filename:'',headers,body:{size:0},parts:node.children.map((child,index)=>shape(child,partId?`${partId}.${index}`:String(index)))};
    if(node.attachment){const attachment=message.attachments?.[attachmentIndex++];if(!attachment)fail('invalid_mail_content','Stored attachment metadata does not match MIME');return {partId,mimeType:node.mimeType,filename:attachment.filename,headers,body:{size:attachment.size,attachmentId:attachment.id}};}
    return {partId,mimeType:node.mimeType,filename:'',headers,body:{size:node.bytes.length,data:b64(node.bytes)}};
  }
  return shape(root,'');
}

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { MAIL_LIMITS, MailError, validateMailContent, parseMimeMessage, rawMailBytes, gmailMimePayload, htmlToText } from './mail.ts';
import { createWorld, applyAction } from './world.ts';
import { providerRequest } from './provider-adapters.ts';

const encode=(value:string|Buffer)=>Buffer.from(value).toString('base64url');
const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const html='<html><body><p>Amount due: <strong>$100.00</strong></p><p>Invoice attached.</p></body></html>';
function fixture(){return [
  'From: Finance team <finance@simulation.test>',
  'To: "Fan, One" <fan1@example.test>, fan2@example.test',
  'Cc: Accounts <accounts@example.test>',
  'Subject: =?UTF-8?Q?October_invoice_=E2=9C=93?=',
  'Date: Sat, 24 Oct 2026 09:00:00 +0000',
  'Message-ID: <invoice-october@simulation.test>',
  'References: <prior@simulation.test>',
  'X-Simulation-Record: invoice-100',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer-invoice"','',
  'This is a multipart company message.',
  '--outer-invoice','Content-Type: multipart/alternative; boundary="alternative-invoice"','',
  '--alternative-invoice','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: quoted-printable','',
  'Amount due: =24100=2E00\r\nInvoice attached.',
  '--alternative-invoice','Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',
  Buffer.from(html).toString('base64'),
  '--alternative-invoice--',
  '--outer-invoice','Content-Type: application/pdf',"Content-Disposition: attachment; filename*=UTF-8''invoice%E2%80%94october.pdf",'Content-Transfer-Encoding: base64','',
  pdf.toString('base64'),
  '--outer-invoice--','End of message.',
].join('\r\n');}
const actor={id:'mail-agent',role:'agent'} as const;
function request(world:any,path:string,method='GET',input?:any){const url=new URL(path,'http://mail.test');return providerRequest({world,system:'gmail',route:url.pathname,url,method,input,execute:action=>applyAction(world,action,actor).result});}

test('PostalMime parses nested alternative bodies, encoded words, CC, references and Unicode PDF filenames',async()=>{
  const raw=fixture(),mail=await parseMimeMessage(encode(raw));
  assert.equal(mail.from,'finance@simulation.test');assert.deepEqual(mail.to,['fan1@example.test','fan2@example.test']);assert.deepEqual(mail.cc,['accounts@example.test']);
  assert.equal(mail.subject,'October invoice ✓');assert.equal(mail.body,'Amount due: $100.00\r\nInvoice attached.');assert.equal(mail.html,html);
  assert.equal(mail.date,'2026-10-24T09:00:00.000Z');assert.equal(mail.message_id,'<invoice-october@simulation.test>');assert.deepEqual(mail.references,['<prior@simulation.test>']);
  assert.equal(mail.attachments.length,1);assert.equal(mail.attachments[0].filename,'invoice—october.pdf');assert.equal(mail.attachments[0].mimeType,'application/pdf');assert.equal(mail.attachments[0].size,pdf.length);assert.deepEqual(Buffer.from(mail.attachments[0].data,'base64url'),pdf);
  assert.deepEqual(rawMailBytes(mail),Buffer.from(raw));assert.ok(mail.headers?.some(h=>h.name==='X-Simulation-Record'&&h.value==='invoice-100'));
});

test('canonical HTML and attachments serialize to valid MIME without losing binary bytes',async()=>{
  const content=validateMailContent({direction:'outbound',to:['fan@example.test'],cc:'accounts@example.test',subject:'Invoice ✓',body:'Invoice attached.',html,attachments:[{filename:'billing—明細.csv',mimeType:'text/csv',data:encode('id,amount\ninv_1,100.00\n')}]});
  const raw=rawMailBytes({...content,id:'mail-generated',created_at:'2026-10-24T09:00:00Z'}),parsed=await parseMimeMessage(raw.toString('base64url'));
  assert.equal(parsed.body,content.body);assert.equal(parsed.html,html);assert.deepEqual(parsed.attachments,content.attachments);assert.deepEqual(parsed.cc,content.cc);
  assert.equal(parsed.message_id,'<mail-generated@simulation.test>');
  const payload=gmailMimePayload({...parsed,id:'mail-generated'});assert.equal(payload.mimeType,'multipart/mixed');assert.equal(payload.parts[0].mimeType,'multipart/alternative');assert.equal(payload.parts[1].body.attachmentId,content.attachments[0].id);
});

test('HTML-only messages retain original untrusted HTML and expose an inert plain-text fallback',async()=>{
  const source='<html><body><script>fetch("https://evil.test")</script><p>Pay &amp; review &#36;100.</p><img src="https://evil.test/pixel"></body></html>';
  const raw=`From: finance@simulation.test\r\nTo: fan@example.test\r\nSubject: HTML notice\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${source}`;
  const mail=await parseMimeMessage(encode(raw));assert.equal(mail.html,source);assert.equal(mail.body,'Pay & review $100.');assert.doesNotMatch(mail.body,/fetch|evil/);assert.equal(htmlToText('<p>&#x1f4b5;</p>'),'💵');
  assert.equal(gmailMimePayload(mail).mimeType,'text/html');
});

test('multipart related inline images retain Content-ID and attachment bytes',async()=>{
  const image=Buffer.from([137,80,78,71,13,10,26,10,0,255,13,10]);
  const raw=['From: finance@simulation.test','To: fan@example.test','Subject: Receipt','Content-Type: multipart/related; boundary=related','',
    '--related','Content-Type: text/html; charset=utf-8','','<p>Receipt</p><img src="cid:logo@simulation.test">',
    '--related','Content-Type: image/png','Content-Disposition: inline; filename="logo.png"','Content-ID: <logo@simulation.test>','Content-Transfer-Encoding: base64','',image.toString('base64'),'--related--'].join('\r\n');
  const mail=await parseMimeMessage(encode(raw));assert.equal(mail.attachments[0].disposition,'inline');assert.equal(mail.attachments[0].contentId,'<logo@simulation.test>');assert.deepEqual(Buffer.from(mail.attachments[0].data,'base64url'),image);
});

test('raw attachment Content-ID and disposition cannot disagree with canonical metadata',async()=>{
  const original=validateMailContent({direction:'outbound',to:'fan@example.test',subject:'Inline receipt',html:'<p>Receipt</p><img src="cid:logo@simulation.test">',attachments:[{filename:'logo.png',mimeType:'image/png',data:encode('image bytes'),disposition:'inline',contentId:'<logo@simulation.test>'}]});
  const raw=rawMailBytes({...original,id:'mail-inline',created_at:'2026-10-24T09:00:00Z'}),mail=await parseMimeMessage(encode(raw));
  for(const patch of [{contentId:'<different@simulation.test>'},{contentId:undefined},{disposition:'attachment'}])assert.throws(()=>validateMailContent({...mail,attachments:mail.attachments.map(a=>({...a,...patch}))}),/Raw MIME (Content-ID|disposition) differs/);
  const withoutId=await parseMimeMessage(encode(raw.toString().replace('Content-ID: <logo@simulation.test>\r\n','')));
  assert.throws(()=>validateMailContent({...withoutId,attachments:withoutId.attachments.map(a=>({...a,contentId:'<invented@simulation.test>'}))}),/Raw MIME Content-ID differs/);
  assert.deepEqual(rawMailBytes(validateMailContent(mail)),raw);
  assert.deepEqual(Buffer.from(mail.attachments[0].data,'base64url'),Buffer.from('image bytes'));
});

test('raw eight-bit attachment content keeps original line endings rather than normalizing bytes',async()=>{
  const bytes=Buffer.from('line one\nline two\r\nline three');
  const raw=Buffer.concat([Buffer.from('From: finance@simulation.test\r\nTo: fan@example.test\r\nSubject: CSV\r\nContent-Type: multipart/mixed; boundary=rawbytes\r\n\r\n--rawbytes\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename="raw.csv"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),bytes,Buffer.from('\r\n--rawbytes--')]);
  const mail=await parseMimeMessage(encode(raw));assert.deepEqual(Buffer.from(mail.attachments[0].data,'base64url'),bytes);assert.equal(mail.body,'');
});

test('direct field and encoded-header CRLF injection, address ambiguity and sender spoofing are rejected',async()=>{
  const base={direction:'outbound',to:'fan@example.test',subject:'Notice',body:'Evidence'};
  for(const patch of [{subject:'Notice\r\nBcc: thief@example.test'},{to:'fan@example.test\nCc: thief@example.test'},{from:'treasury@bank.test'},{to:'a..b@example.test'},{headers:[{name:'X-Record',value:'a\r\nb'}]},{attachments:[{filename:'invoice\r\nBcc: x',data:encode('a')}]}])assert.throws(()=>validateMailContent({...base,...patch}),MailError);
  const encoded=Buffer.from('Notice\r\nBcc: thief@example.test').toString('base64');
  await assert.rejects(()=>parseMimeMessage(encode(`From: finance@simulation.test\r\nTo: fan@example.test\r\nSubject: =?UTF-8?B?${encoded}?=\r\n\r\nBody`)),/Encoded header/);
  await assert.rejects(()=>parseMimeMessage(encode('From: finance@simulation.test\r\nFrom: thief@example.test\r\nTo: fan@example.test\r\nSubject: Notice\r\n\r\nBody')),/Duplicate from/);
  await assert.rejects(()=>parseMimeMessage(encode('From: finance@simulation.test\r\nSender: thief@example.test\r\nTo: fan@example.test\r\nSubject: Notice\r\n\r\nBody')),/Sender must match/);
  assert.equal(validateMailContent({...base,direction:'inbound',from:'supplier@example.test'}).from,'supplier@example.test');
});

test('raw MIME cannot disagree with canonical evidence fields',async()=>{
  const mail=await parseMimeMessage(encode(fixture()));
  assert.throws(()=>validateMailContent({...mail,body:'Different obligation.'}),/Raw MIME text/);
  assert.throws(()=>validateMailContent({...mail,subject:'Unrelated'}),/Subject header differs|Raw MIME subject/);
  assert.throws(()=>validateMailContent({...mail,attachments:[{...mail.attachments[0],filename:'different.pdf'}]}),/Raw MIME filename/);
  assert.throws(()=>validateMailContent({...mail,message_id:'<other@simulation.test>'}),/message-id differs|Message-ID differs/);
});

test('structured header metadata round-trips dates and references without overriding MIME structure',async()=>{
  const content=validateMailContent({direction:'outbound',to:'fan@example.test',subject:'Follow-up',body:'Recorded.',headers:[{name:'Date',value:'Fri, 23 Oct 2026 12:00:00 -0700'},{name:'Message-ID',value:'<header-only@simulation.test>'},{name:'In-Reply-To',value:'<old@simulation.test>'},{name:'References',value:'<older@simulation.test> <old@simulation.test>'}]});
  assert.equal(content.date,'2026-10-23T19:00:00.000Z');assert.equal(content.message_id,'<header-only@simulation.test>');
  const parsed=await parseMimeMessage(rawMailBytes(content).toString('base64url'));assert.equal(parsed.date,content.date);assert.deepEqual(parsed.references,content.references);assert.equal(parsed.in_reply_to,content.in_reply_to);
  assert.throws(()=>validateMailContent({to:'fan@example.test',subject:'Mismatch',body:'Text',headers:[{name:'Content-Type',value:'application/pdf'}]}),/body\/html\/attachments/);
  const injected=fixture().replace("invoice%E2%80%94october.pdf","invoice%0D%0ABcc%3Aevil.pdf");await assert.rejects(()=>parseMimeMessage(encode(injected)),/single-line header/);
});

test('malformed base64, quoted-printable, multipart closures and unsupported encryption fail before storage',async()=>{
  const prefix='From: finance@simulation.test\r\nTo: fan@example.test\r\nSubject: Invalid\r\n';
  const malformed=[
    prefix+'Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nBody',
    prefix+'Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8! ',
    prefix+'Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nBad=GG',
    prefix+'Content-Type: multipart/encrypted; boundary=x\r\n\r\n--x--',
    prefix+'Content-Type: message/rfc822\r\n\r\nFrom: other@example.test\r\n\r\nBody',
    prefix+'Bcc: hidden@example.test\r\n\r\nBody',
  ];
  for(const raw of malformed)await assert.rejects(()=>parseMimeMessage(encode(raw)),MailError);
  await assert.rejects(()=>parseMimeMessage('not!base64'),/base64url/);
});

test('message, decoded attachment, attachment count and serialized size limits are enforced',async()=>{
  const base={to:'fan@example.test',subject:'File',body:'Attached'};
  await assert.rejects(()=>parseMimeMessage(encode(Buffer.alloc(MAIL_LIMITS.rawBytes+1,65))),(e:any)=>e.status===413);
  assert.throws(()=>validateMailContent({...base,body:'x'.repeat(MAIL_LIMITS.textBytes+1)}),(e:any)=>e.status===413);
  assert.throws(()=>validateMailContent({...base,attachments:Array.from({length:MAIL_LIMITS.attachments+1},()=>({filename:'a.txt',data:encode('a')}))}),(e:any)=>e.status===413);
  assert.throws(()=>validateMailContent({...base,attachments:[{filename:'a.pdf',data:encode(Buffer.alloc(MAIL_LIMITS.attachmentBytes+1))}]}),(e:any)=>e.status===413);
  assert.throws(()=>validateMailContent({...base,attachments:[0,1].map(i=>({filename:`${i}.pdf`,data:encode(Buffer.alloc(200*1024))}))}),(e:any)=>e.status===413);
  assert.throws(()=>validateMailContent({...base,body:'x'.repeat(90000),attachments:[0,1].map(i=>({filename:`${i}.pdf`,data:encode(Buffer.alloc(170*1024))}))}),/Generated MIME exceeds/);
  assert.throws(()=>validateMailContent({...base,attachments:[{filename:'a.pdf',data:encode('abc'),size:99}]}),/size does not match/);
});

test('Gmail send/full/raw/attachment endpoints return the same MIME and binary evidence',async()=>{
  const world=createWorld({orderCount:1}),raw=fixture();
  const sent=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:encode(raw)}),id=sent!.body.id,stored=world.messages.at(-1);
  assert.equal(stored.html,html);assert.deepEqual(stored.cc,['accounts@example.test']);assert.equal(stored.attachments.length,1);
  const full=await request(world,`/gmail/v1/users/me/messages/${id}?format=full`),attachment=full!.body.payload.parts[1];
  assert.equal(attachment.filename,'invoice—october.pdf');assert.equal(attachment.body.attachmentId,stored.attachments[0].id);
  const downloaded=await request(world,`/gmail/v1/users/me/messages/${id}/attachments/${attachment.body.attachmentId}`);assert.equal(downloaded!.body.size,pdf.length);assert.deepEqual(Buffer.from(downloaded!.body.data,'base64url'),pdf);
  const recovered=await request(world,`/gmail/v1/users/me/messages/${id}?format=raw`);assert.deepEqual(Buffer.from(recovered!.body.raw,'base64url'),Buffer.from(raw));
  const metadata=await request(world,`/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Cc`);assert.equal(metadata!.body.payload.body,undefined);assert.equal(metadata!.body.payload.headers.length,2);
  const search=await request(world,'/gmail/v1/users/me/messages?q='+encodeURIComponent('has:attachment filename:october cc:accounts@example.test'));assert.equal(search!.body.messages[0].id,id);
  await assert.rejects(()=>request(world,`/gmail/v1/users/me/messages/${id}/attachments/missing`),(e:any)=>e.status===404);
  await assert.rejects(()=>request(world,'/gmail/v1/users/me/messages/missing/attachments/missing'),(e:any)=>e.status===404);
  const before=world.messages.length;await assert.rejects(()=>request(world,'/gmail/v1/users/me/messages/send','POST',{raw:encode('To: a@example.test\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x')}));assert.equal(world.messages.length,before);
});

test('reply metadata links messages to the original thread and rejects conflicting explicit threads',async()=>{
  const world=createWorld({orderCount:1}),first=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:encode(fixture())});
  const reply=['From: finance@simulation.test','To: fan1@example.test','Cc: accounts@example.test','Subject: Re: October invoice','Message-ID: <invoice-followup@simulation.test>','In-Reply-To: <invoice-october@simulation.test>','References: <prior@simulation.test> <invoice-october@simulation.test>','Content-Type: text/plain; charset=utf-8','','Attached invoice received.'].join('\r\n');
  const second=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:encode(reply)});assert.equal(second!.body.threadId,first!.body.threadId);
  const thread=await request(world,`/gmail/v1/users/me/threads/${first!.body.threadId}`);assert.equal(thread!.body.messages.length,2);assert.equal(world.messages.at(-1).in_reply_to,'<invoice-october@simulation.test>');
  const otherThread=world.messages[0].thread_id;await assert.rejects(()=>request(world,'/gmail/v1/users/me/messages/send','POST',{raw:encode(reply),threadId:otherThread}),/conflicts with reply/);
});

test('reply threading prioritizes In-Reply-To then the last matching reference, independent of message insertion order',async()=>{
  const world=createWorld({orderCount:1});
  const raw=(id:string,headers:string[]=[])=>encode(['From: finance@simulation.test','To: fan@example.test','Subject: Conversation',`Message-ID: <${id}@simulation.test>`,...headers,'Content-Type: text/plain; charset=utf-8','','Reply content.'].join('\r\n'));
  const a=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('thread-a')}),b=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('thread-b')});
  assert.notEqual(a!.body.threadId,b!.body.threadId);
  const headers=['References: <thread-a@simulation.test> <thread-b@simulation.test>','In-Reply-To: <thread-b@simulation.test>'];
  const automatic=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('automatic',headers)});assert.equal(automatic!.body.threadId,b!.body.threadId);
  const explicit=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('explicit',headers),threadId:b!.body.threadId});assert.equal(explicit!.body.threadId,b!.body.threadId);
  const referencesOnly=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('references-only',[headers[0]])});assert.equal(referencesOnly!.body.threadId,b!.body.threadId);
  const immediateParent=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('immediate-parent',[headers[0],'In-Reply-To: <thread-a@simulation.test>'])});assert.equal(immediateParent!.body.threadId,a!.body.threadId);
  await assert.rejects(()=>request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('wrong',headers),threadId:a!.body.threadId}),/conflicts with reply/);
});

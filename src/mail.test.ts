import { test, expect } from 'bun:test';
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
  expect(mail.from).toBe('finance@simulation.test');expect(mail.to).toStrictEqual(['fan1@example.test','fan2@example.test']);expect(mail.cc).toStrictEqual(['accounts@example.test']);
  expect(mail.subject).toBe('October invoice ✓');expect(mail.body).toBe('Amount due: $100.00\r\nInvoice attached.');expect(mail.html).toBe(html);
  expect(mail.date).toBe('2026-10-24T09:00:00.000Z');expect(mail.message_id).toBe('<invoice-october@simulation.test>');expect(mail.references).toStrictEqual(['<prior@simulation.test>']);
  expect(mail.attachments.length).toBe(1);expect(mail.attachments[0].filename).toBe('invoice—october.pdf');expect(mail.attachments[0].mimeType).toBe('application/pdf');expect(mail.attachments[0].size).toBe(pdf.length);expect(Buffer.from(mail.attachments[0].data,'base64url')).toStrictEqual(pdf);
  expect(rawMailBytes(mail)).toStrictEqual(Buffer.from(raw));expect(mail.headers?.some(h=>h.name==='X-Simulation-Record'&&h.value==='invoice-100')).toBeTruthy();
});

test('canonical HTML and attachments serialize to valid MIME without losing binary bytes',async()=>{
  const content=validateMailContent({direction:'outbound',to:['fan@example.test'],cc:'accounts@example.test',subject:'Invoice ✓',body:'Invoice attached.',html,attachments:[{filename:'billing—明細.csv',mimeType:'text/csv',data:encode('id,amount\ninv_1,100.00\n')}]});
  const raw=rawMailBytes({...content,id:'mail-generated',created_at:'2026-10-24T09:00:00Z'}),parsed=await parseMimeMessage(raw.toString('base64url'));
  expect(parsed.body).toBe(content.body);expect(parsed.html).toBe(html);expect(parsed.attachments).toStrictEqual(content.attachments);expect(parsed.cc).toStrictEqual(content.cc);
  expect(parsed.message_id).toBe('<mail-generated@simulation.test>');
  const payload=gmailMimePayload({...parsed,id:'mail-generated'});expect(payload.mimeType).toBe('multipart/mixed');expect(payload.parts[0].mimeType).toBe('multipart/alternative');expect(payload.parts[1].body.attachmentId).toBe(content.attachments[0].id);
});

test('HTML-only messages retain original untrusted HTML and expose an inert plain-text fallback',async()=>{
  const source='<html><body><script>fetch("https://evil.test")</script><p>Pay &amp; review &#36;100.</p><img src="https://evil.test/pixel"></body></html>';
  const raw=`From: finance@simulation.test\r\nTo: fan@example.test\r\nSubject: HTML notice\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${source}`;
  const mail=await parseMimeMessage(encode(raw));expect(mail.html).toBe(source);expect(mail.body).toBe('Pay & review $100.');expect(mail.body).not.toMatch(/fetch|evil/);expect(htmlToText('<p>&#x1f4b5;</p>')).toBe('💵');
  expect(gmailMimePayload(mail).mimeType).toBe('text/html');
});

test('multipart related inline images retain Content-ID and attachment bytes',async()=>{
  const image=Buffer.from([137,80,78,71,13,10,26,10,0,255,13,10]);
  const raw=['From: finance@simulation.test','To: fan@example.test','Subject: Receipt','Content-Type: multipart/related; boundary=related','',
    '--related','Content-Type: text/html; charset=utf-8','','<p>Receipt</p><img src="cid:logo@simulation.test">',
    '--related','Content-Type: image/png','Content-Disposition: inline; filename="logo.png"','Content-ID: <logo@simulation.test>','Content-Transfer-Encoding: base64','',image.toString('base64'),'--related--'].join('\r\n');
  const mail=await parseMimeMessage(encode(raw));expect(mail.attachments[0].disposition).toBe('inline');expect(mail.attachments[0].contentId).toBe('<logo@simulation.test>');expect(Buffer.from(mail.attachments[0].data,'base64url')).toStrictEqual(image);
});

test('raw attachment Content-ID and disposition cannot disagree with canonical metadata',async()=>{
  const original=validateMailContent({direction:'outbound',to:'fan@example.test',subject:'Inline receipt',html:'<p>Receipt</p><img src="cid:logo@simulation.test">',attachments:[{filename:'logo.png',mimeType:'image/png',data:encode('image bytes'),disposition:'inline',contentId:'<logo@simulation.test>'}]});
  const raw=rawMailBytes({...original,id:'mail-inline',created_at:'2026-10-24T09:00:00Z'}),mail=await parseMimeMessage(encode(raw));
  for(const patch of [{contentId:'<different@simulation.test>'},{contentId:undefined},{disposition:'attachment'}])expect(()=>validateMailContent({...mail,attachments:mail.attachments.map(a=>({...a,...patch}))})).toThrow(/Raw MIME (Content-ID|disposition) differs/);
  const withoutId=await parseMimeMessage(encode(raw.toString().replace('Content-ID: <logo@simulation.test>\r\n','')));
  expect(()=>validateMailContent({...withoutId,attachments:withoutId.attachments.map(a=>({...a,contentId:'<invented@simulation.test>'}))})).toThrow(/Raw MIME Content-ID differs/);
  expect(rawMailBytes(validateMailContent(mail))).toStrictEqual(raw);
  expect(Buffer.from(mail.attachments[0].data,'base64url')).toStrictEqual(Buffer.from('image bytes'));
});

test('raw eight-bit attachment content keeps original line endings rather than normalizing bytes',async()=>{
  const bytes=Buffer.from('line one\nline two\r\nline three');
  const raw=Buffer.concat([Buffer.from('From: finance@simulation.test\r\nTo: fan@example.test\r\nSubject: CSV\r\nContent-Type: multipart/mixed; boundary=rawbytes\r\n\r\n--rawbytes\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename="raw.csv"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),bytes,Buffer.from('\r\n--rawbytes--')]);
  const mail=await parseMimeMessage(encode(raw));expect(Buffer.from(mail.attachments[0].data,'base64url')).toStrictEqual(bytes);expect(mail.body).toBe('');
});

test('direct field and encoded-header CRLF injection, address ambiguity and sender spoofing are rejected',async()=>{
  const base={direction:'outbound',to:'fan@example.test',subject:'Notice',body:'Evidence'};
  for(const patch of [{subject:'Notice\r\nBcc: thief@example.test'},{to:'fan@example.test\nCc: thief@example.test'},{from:'treasury@bank.test'},{to:'a..b@example.test'},{headers:[{name:'X-Record',value:'a\r\nb'}]},{attachments:[{filename:'invoice\r\nBcc: x',data:encode('a')}]}])expect(()=>validateMailContent({...base,...patch})).toThrow(MailError);
  const encoded=Buffer.from('Notice\r\nBcc: thief@example.test').toString('base64');
  await expect(parseMimeMessage(encode(`From: finance@simulation.test\r\nTo: fan@example.test\r\nSubject: =?UTF-8?B?${encoded}?=\r\n\r\nBody`))).rejects.toThrow(/Encoded header/);
  await expect(parseMimeMessage(encode('From: finance@simulation.test\r\nFrom: thief@example.test\r\nTo: fan@example.test\r\nSubject: Notice\r\n\r\nBody'))).rejects.toThrow(/Duplicate from/);
  await expect(parseMimeMessage(encode('From: finance@simulation.test\r\nSender: thief@example.test\r\nTo: fan@example.test\r\nSubject: Notice\r\n\r\nBody'))).rejects.toThrow(/Sender must match/);
  expect(validateMailContent({...base,direction:'inbound',from:'supplier@example.test'}).from).toBe('supplier@example.test');
});

test('raw MIME cannot disagree with canonical evidence fields',async()=>{
  const mail=await parseMimeMessage(encode(fixture()));
  expect(()=>validateMailContent({...mail,body:'Different obligation.'})).toThrow(/Raw MIME text/);
  expect(()=>validateMailContent({...mail,subject:'Unrelated'})).toThrow(/Subject header differs|Raw MIME subject/);
  expect(()=>validateMailContent({...mail,attachments:[{...mail.attachments[0],filename:'different.pdf'}]})).toThrow(/Raw MIME filename/);
  expect(()=>validateMailContent({...mail,message_id:'<other@simulation.test>'})).toThrow(/message-id differs|Message-ID differs/);
});

test('structured header metadata round-trips dates and references without overriding MIME structure',async()=>{
  const content=validateMailContent({direction:'outbound',to:'fan@example.test',subject:'Follow-up',body:'Recorded.',headers:[{name:'Date',value:'Fri, 23 Oct 2026 12:00:00 -0700'},{name:'Message-ID',value:'<header-only@simulation.test>'},{name:'In-Reply-To',value:'<old@simulation.test>'},{name:'References',value:'<older@simulation.test> <old@simulation.test>'}]});
  expect(content.date).toBe('2026-10-23T19:00:00.000Z');expect(content.message_id).toBe('<header-only@simulation.test>');
  const parsed=await parseMimeMessage(rawMailBytes(content).toString('base64url'));expect(parsed.date).toBe(content.date);expect(parsed.references).toStrictEqual(content.references);expect(parsed.in_reply_to).toBe(content.in_reply_to);
  expect(()=>validateMailContent({to:'fan@example.test',subject:'Mismatch',body:'Text',headers:[{name:'Content-Type',value:'application/pdf'}]})).toThrow(/body\/html\/attachments/);
  const injected=fixture().replace("invoice%E2%80%94october.pdf","invoice%0D%0ABcc%3Aevil.pdf");await expect(parseMimeMessage(encode(injected))).rejects.toThrow(/single-line header/);
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
  for(const raw of malformed)await expect(parseMimeMessage(encode(raw))).rejects.toThrow(MailError);
  await expect(parseMimeMessage('not!base64')).rejects.toThrow(/base64url/);
});

test('message, decoded attachment, attachment count and serialized size limits are enforced',async()=>{
  const base={to:'fan@example.test',subject:'File',body:'Attached'};
  await expect(parseMimeMessage(encode(Buffer.alloc(MAIL_LIMITS.rawBytes+1,65)))).rejects.toThrowSatisfying((e:any)=>e.status===413);
  expect(()=>validateMailContent({...base,body:'x'.repeat(MAIL_LIMITS.textBytes+1)})).toThrowSatisfying((e:any)=>e.status===413);
  expect(()=>validateMailContent({...base,attachments:Array.from({length:MAIL_LIMITS.attachments+1},()=>({filename:'a.txt',data:encode('a')}))})).toThrowSatisfying((e:any)=>e.status===413);
  expect(()=>validateMailContent({...base,attachments:[{filename:'a.pdf',data:encode(Buffer.alloc(MAIL_LIMITS.attachmentBytes+1))}]})).toThrowSatisfying((e:any)=>e.status===413);
  expect(()=>validateMailContent({...base,attachments:[0,1].map(i=>({filename:`${i}.pdf`,data:encode(Buffer.alloc(200*1024))}))})).toThrowSatisfying((e:any)=>e.status===413);
  expect(()=>validateMailContent({...base,body:'x'.repeat(90000),attachments:[0,1].map(i=>({filename:`${i}.pdf`,data:encode(Buffer.alloc(170*1024))}))})).toThrow(/Generated MIME exceeds/);
  expect(()=>validateMailContent({...base,attachments:[{filename:'a.pdf',data:encode('abc'),size:99}]})).toThrow(/size does not match/);
});

test('Gmail send/full/raw/attachment endpoints return the same MIME and binary evidence',async()=>{
  const world=createWorld({orderCount:1}),raw=fixture();
  const sent=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:encode(raw)}),id=sent!.body.id,stored=world.messages.at(-1);
  expect(stored.html).toBe(html);expect(stored.cc).toStrictEqual(['accounts@example.test']);expect(stored.attachments.length).toBe(1);
  const full=await request(world,`/gmail/v1/users/me/messages/${id}?format=full`),attachment=full!.body.payload.parts[1];
  expect(attachment.filename).toBe('invoice—october.pdf');expect(attachment.body.attachmentId).toBe(stored.attachments[0].id);
  const downloaded=await request(world,`/gmail/v1/users/me/messages/${id}/attachments/${attachment.body.attachmentId}`);expect(downloaded!.body.size).toBe(pdf.length);expect(Buffer.from(downloaded!.body.data,'base64url')).toStrictEqual(pdf);
  const recovered=await request(world,`/gmail/v1/users/me/messages/${id}?format=raw`);expect(Buffer.from(recovered!.body.raw,'base64url')).toStrictEqual(Buffer.from(raw));
  const metadata=await request(world,`/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Cc`);expect(metadata!.body.payload.body).toBeUndefined();expect(metadata!.body.payload.headers.length).toBe(2);
  const search=await request(world,'/gmail/v1/users/me/messages?q='+encodeURIComponent('has:attachment filename:october cc:accounts@example.test'));expect(search!.body.messages[0].id).toBe(id);
  await expect(request(world,`/gmail/v1/users/me/messages/${id}/attachments/missing`)).rejects.toThrowSatisfying((e:any)=>e.status===404);
  await expect(request(world,'/gmail/v1/users/me/messages/missing/attachments/missing')).rejects.toThrowSatisfying((e:any)=>e.status===404);
  const before=world.messages.length;await expect(request(world,'/gmail/v1/users/me/messages/send','POST',{raw:encode('To: a@example.test\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x')})).rejects.toThrow();expect(world.messages.length).toBe(before);
});

test('reply metadata links messages to the original thread and rejects conflicting explicit threads',async()=>{
  const world=createWorld({orderCount:1}),first=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:encode(fixture())});
  const reply=['From: finance@simulation.test','To: fan1@example.test','Cc: accounts@example.test','Subject: Re: October invoice','Message-ID: <invoice-followup@simulation.test>','In-Reply-To: <invoice-october@simulation.test>','References: <prior@simulation.test> <invoice-october@simulation.test>','Content-Type: text/plain; charset=utf-8','','Attached invoice received.'].join('\r\n');
  const second=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:encode(reply)});expect(second!.body.threadId).toBe(first!.body.threadId);
  const thread=await request(world,`/gmail/v1/users/me/threads/${first!.body.threadId}`);expect(thread!.body.messages.length).toBe(2);expect(world.messages.at(-1).in_reply_to).toBe('<invoice-october@simulation.test>');
  const otherThread=world.messages[0].thread_id;await expect(request(world,'/gmail/v1/users/me/messages/send','POST',{raw:encode(reply),threadId:otherThread})).rejects.toThrow(/conflicts with reply/);
});

test('reply threading prioritizes In-Reply-To then the last matching reference, independent of message insertion order',async()=>{
  const world=createWorld({orderCount:1});
  const raw=(id:string,headers:string[]=[])=>encode(['From: finance@simulation.test','To: fan@example.test','Subject: Conversation',`Message-ID: <${id}@simulation.test>`,...headers,'Content-Type: text/plain; charset=utf-8','','Reply content.'].join('\r\n'));
  const a=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('thread-a')}),b=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('thread-b')});
  expect(a!.body.threadId).not.toBe(b!.body.threadId);
  const headers=['References: <thread-a@simulation.test> <thread-b@simulation.test>','In-Reply-To: <thread-b@simulation.test>'];
  const automatic=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('automatic',headers)});expect(automatic!.body.threadId).toBe(b!.body.threadId);
  const explicit=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('explicit',headers),threadId:b!.body.threadId});expect(explicit!.body.threadId).toBe(b!.body.threadId);
  const referencesOnly=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('references-only',[headers[0]])});expect(referencesOnly!.body.threadId).toBe(b!.body.threadId);
  const immediateParent=await request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('immediate-parent',[headers[0],'In-Reply-To: <thread-a@simulation.test>'])});expect(immediateParent!.body.threadId).toBe(a!.body.threadId);
  await expect(request(world,'/gmail/v1/users/me/messages/send','POST',{raw:raw('wrong',headers),threadId:a!.body.threadId})).rejects.toThrow(/conflicts with reply/);
});

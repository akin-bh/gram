import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.ts';
import { hash } from '../src/store.ts';

const base = 'http://127.0.0.1:24300';
async function fixture(database = ':memory:') {
  const service = await createService({ database, baseUrl: base, agentEnabled: false });
  const page = await service.fetch(new Request(base)); expect(page.status).toBe(200);
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, input?: any, extra: Record<string, string> = {}, anonymous = false) => {
    const response = await service.fetch(new Request(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(anonymous ? {} : { Cookie: cookie }), ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }), ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }));
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { response, data };
  };
  const create = async (input: any = {}) => {
    const result = await call('/api/worlds', { name: 'Integration test world', seed: 11, orderCount: 3, ...input });
    expect(result.response.status, JSON.stringify(result.data)).toBe(201); return result.data.world;
  };
  const connect = async (world: string, system: string) => {
    const started = await call(`/api/worlds/${world}/connect/${system}`, {}); expect(started.response.status, JSON.stringify(started.data)).toBe(200);
    const url = new URL(started.data.authorization_url);
    const consent = await service.fetch(new Request(url, { headers: { Cookie: cookie } })); expect(consent.status).toBe(200); expect(await consent.text()).toMatch(/<html/i);
    const consentInfo = await service.fetch(new Request(url.origin + `/oauth/${system}/consent` + url.search, { headers: { Cookie: cookie } }));
    expect(consentInfo.status).toBe(200); const consentData = await consentInfo.json();
    expect(consentData.provider.id).toBe(system); expect(consentData.world).toBe(world); expect(consentData.scopes).toStrictEqual(['read', 'write']);
    const params = new URLSearchParams(url.search); params.set('decision', 'allow');
    const accepted = await service.fetch(new Request(url.origin + url.pathname, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: params }));
    expect(accepted.status).toBe(303);
    const callback = await service.fetch(new Request(accepted.headers.get('location')!, { headers: { Cookie: cookie } }));
    expect(callback.status, await callback.text()).toBe(303);
    expect(callback.headers.get('location')!).toMatch(/connected=/);
    return { callbackUrl: accepted.headers.get('location')!, url };
  };
  return { service, cookie, call, create, connect };
}

test('real consent and PKCE callback connect a world; replay and cross-session callbacks fail', async () => {
  const f = await fixture();
  try {
    const world = await f.create();
    expect((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payments`)).response.status).toBe(401);
    const flow = await f.connect(world.id, 'stripe');
    const payments = await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payments`);
    expect(payments.response.status).toBe(200); expect(payments.data.data.length).toBe(3);
    expect((await f.service.fetch(new Request(flow.callbackUrl, { headers: { Cookie: f.cookie } }))).status).toBe(400);
    const started = await f.call(`/api/worlds/${world.id}/connect/gmail`, {}), u = new URL(started.data.authorization_url), p = new URLSearchParams(u.search); p.set('decision', 'allow');
    const accepted = await f.service.fetch(new Request(u.origin + u.pathname, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: p }));
    const other = await f.service.fetch(new Request(base));
    expect((await f.service.fetch(new Request(accepted.headers.get('location')!, { headers: { Cookie: other.headers.get('set-cookie')!.split(';')[0] } }))).status).toBe(400);
  } finally { await f.service.close(); }
});

test('public OAuth code is bound to PKCE/client/world/system; refresh rotates and revoke denies access', async () => {
  const f = await fixture();
  try {
    const world = await f.create(), otherWorld = await f.create({ name: 'Other world' }); expect(world.id).not.toBe(otherWorld.id);
    const registered = await f.call('/api/oauth/clients', { name: 'SDK integration', redirect_uris: ['http://127.0.0.1:9123/callback'] });
    const client = registered.data.client_id, verifier = 'a'.repeat(64), challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({ client_id: client, redirect_uri: 'http://127.0.0.1:9123/callback', response_type: 'code', scope: 'read', state: 'external-client-state', world_id: world.id, code_challenge: challenge, code_challenge_method: 'S256', decision: 'allow' });
    const accepted = await f.service.fetch(new Request(base + '/oauth/stripe/authorize', { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params }));
    const code = new URL(accepted.headers.get('location')!).searchParams.get('code');
    const request = { grant_type: 'authorization_code', client_id: client, redirect_uri: 'http://127.0.0.1:9123/callback', code, code_verifier: verifier };
    expect((await f.call('/oauth/stripe/token', { ...request, code_verifier: 'b'.repeat(64) }, {}, true)).response.status).toBe(400);
    expect((await f.call('/oauth/gmail/token', request, {}, true)).response.status).toBe(400);
    const token = await f.call('/oauth/stripe/token', request, {}, true); expect(token.response.status).toBe(200);
    const auth = { Authorization: 'Bearer ' + token.data.access_token };
    expect((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payments`, undefined, auth, true)).response.status).toBe(200);
    expect((await f.call(`/api/worlds/${otherWorld.id}/records?system=stripe&feed=payments`, undefined, auth, true)).response.status).toBe(403);
    expect((await f.call(`/api/worlds/${world.id}/records?system=gmail&feed=messages`, undefined, auth, true)).response.status).toBe(403);
    expect((await f.call(`/api/worlds/${world.id}/actions`, { type: 'refund', payment_id: 'pi_1', amount_minor: 100 }, auth, true)).response.status).toBe(403);
    expect((await f.call('/oauth/stripe/token', request, {}, true)).response.status).toBe(400);
    const rotated = await f.call('/oauth/stripe/token', { grant_type: 'refresh_token', refresh_token: token.data.refresh_token, client_id: client }, {}, true); expect(rotated.response.status).toBe(200);
    expect((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payments`, undefined, auth, true)).response.status).toBe(401);
    expect((await f.call('/oauth/stripe/token', { grant_type: 'refresh_token', refresh_token: token.data.refresh_token, client_id: client }, {}, true)).response.status).toBe(400);
    await f.call('/oauth/stripe/revoke', { token: rotated.data.access_token, client_id: client }, {}, true);
    expect((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payments`, undefined, { Authorization: 'Bearer ' + rotated.data.access_token }, true)).response.status).toBe(401);
    const logs = JSON.stringify(f.service.store.events(world.id, 0, 1000));
    for (const value of [token.data.access_token, token.data.refresh_token, code, verifier]) expect(!logs.includes(value), 'Audit must redact OAuth secrets').toBeTruthy();
  } finally { await f.service.close(); }
});

test('refund API is durable, concurrent idempotency prevents duplicates, outages and period locks reconcile across providers', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'finance-world-test-')), database = join(folder, 'world.sqlite');
  let f = await fixture(database);
  try {
    const w = await f.create(), id = w.id;
    for (const system of ['stripe', 'mercury', 'netsuite', 'gmail']) await f.connect(id, system);
    const key = 'one-economic-refund', input = { type: 'refund', payment_id: 'pi_1', amount_minor: 1500 };
    const results = await Promise.all(Array.from({ length: 8 }, () => f.call(`/api/worlds/${id}/actions`, input, { 'Idempotency-Key': key })));
    expect(results.every(r => r.response.status === 200), JSON.stringify(results.map(r => r.data))).toBeTruthy();
    expect(f.service.store.world(id).refunds.length).toBe(1);
    expect((await f.call(`/api/worlds/${id}/actions`, { ...input, amount_minor: 1600 }, { 'Idempotency-Key': key })).response.status).toBe(409);
    await f.call(`/api/worlds/${id}/actions`, { type: 'set_fault', system: 'stripe', mode: 'offline' });
    expect((await f.call(`/api/worlds/${id}/records?system=stripe&feed=payments`)).response.status).toBe(503);
    await f.call(`/api/worlds/${id}/actions`, { type: 'advance_time', hours: 2 });
    expect(f.service.store.world(id).refunds[0].status).toBe('pending');
    await f.call(`/api/worlds/${id}/actions`, { type: 'set_fault', system: 'stripe', mode: 'healthy' });
    await f.call(`/api/worlds/${id}/actions`, { type: 'close_period' });
    await f.call(`/api/worlds/${id}/actions`, { type: 'advance_time', hours: 1 });
    let s = (await f.call(`/api/worlds/${id}`)).data; expect(s.world.refunds[0].status).toBe('succeeded'); expect(s.summary.unposted_settlements).toBe(1);
    await f.call(`/api/worlds/${id}/actions`, { type: 'reopen_period' });
    s = (await f.call(`/api/worlds/${id}`)).data; expect(s.summary.reconciliation.bank_ledger_difference_minor).toBe(0); expect(s.summary.reconciliation.balanced).toBe(true);
    const mail = await f.call(`/providers/gmail/worlds/${id}/gmail/v1/users/me/messages`); expect(mail.response.status).toBe(200); expect(mail.data.messages.length >= 2).toBeTruthy();
    const sent = s.world.messages.find((m: any) => m.direction === 'outbound');
    const detail = await f.call(`/providers/gmail/worlds/${id}/gmail/v1/users/me/messages/${sent.id}`); expect(Buffer.from(detail.data.payload.body.data, 'base64url').toString()).toMatch(/15.00/);
    expect(f.service.store.verify(id).valid).toBe(true);
    await f.service.close(); f = await fixture(database);
    const persisted = (await f.call(`/api/worlds/${id}`)).data;
    expect(persisted.world.refunds.length).toBe(1); expect(persisted.world.refunds[0].status).toBe('succeeded');
    expect((await f.call(`/api/worlds/${id}/actions`, input, { 'Idempotency-Key': key })).data.replayed).toBe(true);
    expect(f.service.store.verify(id).valid).toBe(true);
  } finally { await f.service.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('agent capabilities cannot access judge truth, other worlds, approvals or controller actions', async () => {
  const f = await fixture();
  try {
    const w = await f.create(), other = await f.create(), token = 'scoped-agent-test-token';
    f.service.store.put('agent-tokens', hash(token), { actor: 'agent-test', world: w.id, expires_at: Date.now() + 60000 });
    const auth = { Authorization: 'Bearer ' + token };
    expect((await f.call(`/api/worlds/${w.id}/context`, undefined, auth, true)).response.status).toBe(200);
    for (const p of [`/api/worlds/${w.id}`, `/api/worlds/${w.id}/audit`, `/api/worlds/${other.id}/context`]) expect((await f.call(p, undefined, auth, true)).response.status).toBe(403);
    for (const type of ['advance_time', 'set_fault', 'decide_approval', 'close_period']) expect((await f.call(`/api/worlds/${w.id}/actions`, { type }, auth, true)).response.status).toBe(403);
    expect((await f.call(`/api/worlds/${w.id}/connect/gmail`, {}, auth, true)).response.status).toBe(403);
    expect((await f.call(`/api/worlds/${w.id}/records?system=stripe&feed=payments`, undefined, auth, true)).response.status).toBe(401);
    await f.connect(w.id, 'stripe');
    expect((await f.call(`/api/worlds/${w.id}/actions`, { type: 'refund', payment_id: 'pi_1', amount_minor: 100 }, auth, true)).response.status).toBe(200);
  } finally { await f.service.close(); }
});

test('untrusted origins and hosts are rejected; audit export is finite and detects tampering', async () => {
  const f = await fixture();
  try {
    const w = await f.create();
    expect((await f.call('/api/worlds', {}, { Origin: 'https://attacker.example' })).response.status).toBe(403);
    expect((await f.call('/api/worlds', {}, { Host: 'attacker.example' })).response.status).toBe(403);
    expect((await f.call('/api/bootstrap', undefined, {}, true)).response.status).toBe(403);
    for (let n = 0; n < 5; n++) await f.call(`/api/worlds/${w.id}/audit`);
    const exported = await f.call(`/api/worlds/${w.id}/audit/export`); expect(exported.data.length < 100000, 'Audit reads must not recursively embed the entire audit').toBeTruthy();
    expect(f.service.store.verify(w.id).valid).toBe(true);
    f.service.store.db.prepare('UPDATE audit SET value=? WHERE seq=(SELECT MIN(seq) FROM audit WHERE world=?)').run('{}', w.id);
    expect(f.service.store.verify(w.id).valid).toBe(false);
  } finally { await f.service.close(); }
});

test('expired OAuth connection recovers after fresh consent; an offline rail remains offline', async () => {
  const f = await fixture();
  try {
    const world = await f.create(); await f.connect(world.id, 'stripe');
    await f.call(`/api/worlds/${world.id}/actions`, { type: 'set_fault', system: 'stripe', mode: 'expired' });
    expect((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payment`)).response.status).toBe(401);
    await f.connect(world.id, 'stripe');
    expect((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payment`)).response.status).toBe(200);
    await f.call(`/api/worlds/${world.id}/actions`, { type: 'set_fault', system: 'stripe', mode: 'offline' });
    await f.connect(world.id, 'stripe');
    expect((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payment`)).response.status).toBe(503);
    await f.call(`/api/worlds/${world.id}/connections/stripe/revoke`, {});
    expect(f.service.oauth.connections(world.id).find(c => c.system === 'stripe')?.status).toBe('disconnected');
  } finally { await f.service.close(); }
});

test('fresh agent shifts share idempotency ownership and cannot repay a lost acknowledgement', async () => {
  const f = await fixture();
  try {
    const w = await f.create(); await f.connect(w.id, 'stripe');
    const principal = `agent-world:${w.id}`;
    for (const token of ['shift-one', 'shift-two']) f.service.store.put('agent-tokens', hash(token), { actor: principal, runId: token, world: w.id, expires_at: Date.now() + 60000 });
    const input = { type: 'refund', payment_id: 'pi_1', amount_minor: 1000 }, headers = { 'Idempotency-Key': 'stable-finance-intent' };
    expect((await f.call(`/api/worlds/${w.id}/actions`, input, { ...headers, Authorization: 'Bearer shift-one' }, true)).response.status).toBe(200);
    const replay = await f.call(`/api/worlds/${w.id}/actions`, input, { ...headers, Authorization: 'Bearer shift-two' }, true);
    expect(replay.data.replayed).toBe(true); expect(f.service.store.world(w.id).refunds.length).toBe(1);
  } finally { await f.service.close(); }
});

test('browser entry navigation is allowed while cross-site API calls remain denied', async () => {
  const f = await fixture();
  try {
    const entry = await f.service.fetch(new Request(base + '/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } }));
    expect(entry.status).toBe(200); expect(entry.headers.get('referrer-policy')).toBe('same-origin');
    expect((await f.call('/api/bootstrap', undefined, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' })).response.status).toBe(403);
  } finally { await f.service.close(); }
});

test('provider HTTP contracts project canonical amounts and enforce read-only POST scopes', async () => {
  const f = await fixture();
  try {
    const w = await f.create({ kind: 'saas-collections', orderCount: 2 });
    for (const system of ['stripe', 'mercury', 'netsuite', 'gmail', 'quickbooks', 'ramp', 'plaid']) await f.connect(w.id, system);
    const stripe = await f.call(`/providers/stripe/worlds/${w.id}/v1/invoices`);
    expect(stripe.data.data[0].object).toBe('invoice'); expect(stripe.data.data[0].total).toBe(w.invoices[0].amount_minor); expect(stripe.data.data[0].currency).toBe('usd');
    const qb = await f.call(`/providers/quickbooks/worlds/${w.id}/v3/company/${w.id}/query?query=SELECT%20*%20FROM%20Invoice`);
    expect(qb.data.QueryResponse.Invoice[0].TotalAmt * 100).toBe(w.invoices[0].amount_minor);
    const ns = await f.call(`/providers/netsuite/worlds/${w.id}/services/rest/record/v1/invoice/inv_1`);
    expect(ns.data.total * 100).toBe(w.invoices[0].amount_minor);
    const bank = await f.call(`/providers/mercury/worlds/${w.id}/api/v1/accounts`); expect(bank.data.accounts[0].currentBalance).toBe(20000);
    const tokens = f.service.oauth.mint({ world: w.id, system: 'plaid', client_id: 'test-client', actor: 'tester', scopes: ['read'] });
    const auth = { Authorization: 'Bearer ' + tokens.access_token };
    const accounts = await f.call(`/providers/plaid/worlds/${w.id}/accounts/get`, {}, auth, true); expect(accounts.response.status).toBe(200); expect(accounts.data.accounts[0].balances.current).toBe(20000);
    const synced = await f.call(`/providers/plaid/worlds/${w.id}/transactions/sync`, { count: 1 }, auth, true); expect(synced.response.status).toBe(200); expect(synced.data.added.length).toBe(1);
    const unsupported = await f.call(`/providers/stripe/worlds/${w.id}/v1/invoices?unknown=123`); expect(unsupported.response.status).toBe(501);
    const deniedWrite = await f.call(`/providers/ramp/worlds/${w.id}/developer/v1/bills`, { amount: 100 }); expect(deniedWrite.response.status).toBe(404);
    const email = Buffer.from('To: finance-review@simulation.test\r\nSubject: API receipt\r\n\r\nThis is an API-created email.').toString('base64url');
    const sent = await f.call(`/providers/gmail/worlds/${w.id}/gmail/v1/users/me/messages/send`, { raw: email }); expect(sent.response.status).toBe(200);
    const message = await f.call(`/providers/gmail/worlds/${w.id}/gmail/v1/users/me/messages/${sent.data.id}?format=raw`); expect(Buffer.from(message.data.raw, 'base64url').toString()).toMatch(/API-created email/);
    const log = f.service.store.events(w.id, 0, 1000).find(e => e.data?.response?.error?.code === 'unsupported_filter'); expect(log, 'Error codes remain observable after secret redaction').toBeTruthy();
  } finally { await f.service.close(); }
});

test('exception gateway separates provider facts from operator decisions and keeps credits coherent', async () => {
  const f = await fixture();
  try {
    const w = await f.create({kind:'saas-collections',orderCount:2}), path = `/api/worlds/${w.id}`;
    for (const system of ['stripe','netsuite','gmail']) await f.connect(w.id,system);
    const operatorToken = 'exception-test-agent';
    f.service.store.put('agent-tokens',hash(operatorToken),{world:w.id,actor:'agent-exception-test',expires_at:Date.now()+60000});
    const auth = {Authorization:`Bearer ${operatorToken}`};
    for (const type of ['issue_credit_note','open_dispute','resolve_dispute','return_bill_payment']) {
      const denied = await f.call(path+'/actions',{type,external_event_id:'forged'},auth,true);
      expect(denied.response.status,JSON.stringify(denied.data)).toBe(403);
      expect(denied.data.error.code).toBe('controller_required');
    }
    const collected = await f.call(path+'/actions',{type:'collect_invoice',invoice_id:w.invoices[0].id});
    expect(collected.response.status,JSON.stringify(collected.data)).toBe(200);
    await f.call(path+'/actions',{type:'advance_time',hours:1});
    const payment = f.service.store.world(w.id).payments.find((p:any)=>p.invoice_id===w.invoices[0].id);
    const creditInput = {type:'issue_credit_note',invoice_id:w.invoices[0].id,payment_id:payment.id,amount_minor:1200,reason:'Authenticated service adjustment',external_event_id:'credit-reference-1'};
    const credit = await f.call(path+'/actions',creditInput); expect(credit.response.status,JSON.stringify(credit.data)).toBe(200);
    const replay = await f.call(path+'/actions',creditInput); expect(replay.response.status).toBe(200); expect(replay.data.result.replayed).toBe(true);
    expect(f.service.store.world(w.id).creditNotes.length).toBe(1);
    expect((await f.call(path+'/actions',{...creditInput,amount_minor:1300})).response.status).toBe(409);
    expect((await f.call(path+'/actions',{type:'refund',payment_id:payment.id,amount_minor:1200},auth,true)).data.error.code).toBe('credit_note_required');
    const note = f.service.store.world(w.id).creditNotes[0];
    const refund = await f.call(path+'/actions',{type:'refund',payment_id:payment.id,credit_note_id:note.id,amount_minor:1200},auth,true); expect(refund.response.status,JSON.stringify(refund.data)).toBe(200);
    await f.call(path+'/actions',{type:'advance_time',hours:1});
    const snapshot = (await f.call(path)).data;
    expect(snapshot.world.creditNotes[0].status).toBe('refunded');
    expect(snapshot.summary.customer_credits_payable_minor).toBe(0);
    expect(snapshot.summary.reconciliation.bank_ledger_difference_minor).toBe(0);
    expect(snapshot.summary.reconciliation.balanced).toBe(true);
    // A provider fact is still observable while the provider API is unavailable.
    await f.call(path+'/actions',{type:'set_fault',system:'stripe',mode:'offline'});
    const opened = await f.call(path+'/actions',{type:'open_dispute',payment_id:payment.id,amount_minor:500,reason:'Customer dispute',external_event_id:'dispute-reference-1'});
    expect(opened.response.status,JSON.stringify(opened.data)).toBe(200);
    const dispute = f.service.store.world(w.id).disputes[0];
    const evidenceInput = {type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:[w.documents[0].id],statement:'Signed services contract supports original collection.'};
    expect((await f.call(path+'/actions',evidenceInput,auth,true)).response.status).toBe(503);
    await f.call(path+'/actions',{type:'set_fault',system:'stripe',mode:'healthy'});
    expect((await f.call(path+'/actions',evidenceInput,auth,true)).response.status).toBe(200);
    const resolved = await f.call(path+'/actions',{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'dispute-outcome-1'});
    expect(resolved.response.status,JSON.stringify(resolved.data)).toBe(200);
    expect((await f.call(path)).data.summary.reconciliation.bank_ledger_difference_minor).toBe(0);
    expect(f.service.store.verify(w.id).valid).toBe(true);
  } finally { await f.service.close(); }
});

test('multipart Gmail retains original bytes, scoped attachment reads and safe judge downloads', async () => {
  const f = await fixture();
  try {
    const w = await f.create(), path = `/api/worlds/${w.id}`, gmail = `/providers/gmail/worlds/${w.id}/gmail/v1/users/me/messages`;
    await f.connect(w.id,'gmail');
    const csv = 'invoice_id,amount_minor\ninv_1,1200\n';
    const raw = ['From: finance@simulation.test','To: auditor@example.test','Subject: Evidence packet','MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="evidence-boundary"','','--evidence-boundary','Content-Type: multipart/alternative; boundary="body-boundary"','','--body-boundary','Content-Type: text/plain; charset=utf-8','','Review attached evidence.','--body-boundary','Content-Type: text/html; charset=utf-8','','<p>Review attached evidence.</p><script>untrusted()</script>','--body-boundary--','--evidence-boundary','Content-Type: text/csv; charset=utf-8','Content-Disposition: attachment; filename="evidence.csv"','Content-Transfer-Encoding: base64','',Buffer.from(csv).toString('base64'),'--evidence-boundary--',''].join('\r\n');
    const send = await f.call(gmail+'/send',{raw:Buffer.from(raw).toString('base64url')});
    expect(send.response.status,JSON.stringify(send.data)).toBe(200);
    const id=send.data.id, canonical=f.service.store.world(w.id).messages.find((m:any)=>m.id===id), attachment=canonical.attachments[0];
    expect(canonical.body).toBe('Review attached evidence.'); expect(canonical.html).toMatch(/<script>/); expect(attachment.filename).toBe('evidence.csv');
    const original=await f.call(gmail+`/${id}?format=raw`);
    expect(Buffer.from(original.data.raw,'base64url').toString()).toBe(raw);
    const providerFile=await f.call(gmail+`/${id}/attachments/${attachment.id}`); expect(Buffer.from(providerFile.data.data,'base64url').toString()).toBe(csv);
    const operatorToken='mime-test-agent'; f.service.store.put('agent-tokens',hash(operatorToken),{world:w.id,actor:'mime-test-agent',expires_at:Date.now()+60000});
    const auth={Authorization:`Bearer ${operatorToken}`};
    const content=await f.call(path+`/attachment-content/${id}/${attachment.id}?limit=10`,undefined,auth,true);
    expect(content.response.status).toBe(200); expect(content.data.text).toBe(csv.slice(0,10)); expect(content.data.next_offset).toBe(10); expect(content.data.data).toBeUndefined();
    const rest=await f.call(path+`/attachment-content/${id}/${attachment.id}?offset=10`,undefined,auth,true); expect(content.data.text+rest.data.text).toBe(csv);
    const download=await f.call(path+`/messages/${id}/attachments/${attachment.id}`); expect(download.data).toBe(csv); expect(download.response.headers.get('content-type')).toBe('application/octet-stream'); expect(download.response.headers.get('content-disposition')!).toMatch(/attachment/);
    expect((await f.call(path+`/messages/${id}/attachments/${attachment.id}`,undefined,auth,true)).response.status).toBe(403);
    const before=f.service.store.world(w.id).messages.length;
    const injection=await f.call(gmail+'/send',{raw:Buffer.from(raw.replace('Subject: Evidence packet','Subject: =?utf-8?Q?Evidence=0D=0ABcc:_intruder@example.test?=')).toString('base64url')}); expect(injection.response.status).toBe(400);
    expect(f.service.store.world(w.id).messages.length).toBe(before);
    await f.call(path+'/connections/gmail/revoke',{});
    expect((await f.call(path+`/attachment-content/${id}/${attachment.id}`,undefined,auth,true)).response.status).toBe(401);
    expect(f.service.store.verify(w.id).valid).toBe(true);
  } finally { await f.service.close(); }
});

test('attachment evidence refuses invalid UTF-8 and paginates complete Unicode characters', async () => {
  const f=await fixture();
  try {
    const w=await f.create(),path=`/api/worlds/${w.id}`;await f.connect(w.id,'gmail');
    const bad=Buffer.from([0x43,0x61,0x66,0xe9]),good=Buffer.from('A😀éB');
    const result=await f.call(path+'/actions',{type:'receive_email',from:'audit@example.test',to:['finance@simulation.test'],subject:'Encoding evidence',body:'Preserve original evidence bytes',attachments:[{filename:'latin1.txt',mimeType:'text/plain',size:bad.length,data:bad.toString('base64url')},{filename:'unicode.txt',mimeType:'text/plain',size:good.length,data:good.toString('base64url')}]});
    expect(result.response.status,JSON.stringify(result.data)).toBe(200);
    const message=f.service.store.world(w.id).messages.at(-1),[first,second]=message.attachments;
    const unsupported=await f.call(path+`/attachment-content/${message.id}/${first.id}`);
    expect(unsupported.response.status).toBe(200);expect(unsupported.data.extraction).toBe('unsupported-encoding');expect(unsupported.data.text).toBeUndefined();
    const page1=await f.call(path+`/attachment-content/${message.id}/${second.id}?limit=2`),page2=await f.call(path+`/attachment-content/${message.id}/${second.id}?offset=2&limit=2`);
    expect(page1.data.text).toBe('A😀');expect(page1.data.total_characters).toBe(4);expect(page1.data.next_offset).toBe(2);expect(page2.data.text).toBe('éB');expect(page2.data.next_offset).toBeNull();
    expect(f.service.store.world(w.id).messages.at(-1).attachments[0].data).toBe(bad.toString('base64url'));
  }finally{await f.service.close();}
});

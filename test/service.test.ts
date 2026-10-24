import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createService } from '../src/server.ts';
import { hash } from '../src/store.ts';

const base = 'http://127.0.0.1:24300';
async function fixture(database = ':memory:') {
  const service = await createService({ database, baseUrl: base, agentEnabled: false });
  const page = await service.fetch(new Request(base)); assert.equal(page.status, 200);
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, input?: any, extra: Record<string, string> = {}, anonymous = false) => {
    const response = await service.fetch(new Request(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(anonymous ? {} : { Cookie: cookie }), ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }));
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { response, data };
  };
  const create = async (input: any = {}) => {
    const result = await call('/api/worlds', { name: 'Integration test world', seed: 11, orderCount: 3, ...input });
    assert.equal(result.response.status, 201, JSON.stringify(result.data)); return result.data.world;
  };
  const connect = async (world: string, system: string) => {
    const started = await call(`/api/worlds/${world}/connect/${system}`, {}); assert.equal(started.response.status, 200, JSON.stringify(started.data));
    const url = new URL(started.data.authorization_url);
    const consent = await service.fetch(new Request(url, { headers: { Cookie: cookie } })); assert.equal(consent.status, 200); assert.match(await consent.text(), /<html/i);
    const consentInfo = await service.fetch(new Request(url.origin + `/oauth/${system}/consent` + url.search, { headers: { Cookie: cookie } }));
    assert.equal(consentInfo.status, 200); const consentData = await consentInfo.json();
    assert.equal(consentData.provider.id, system); assert.equal(consentData.world, world); assert.deepEqual(consentData.scopes, ['read', 'write']);
    const params = new URLSearchParams(url.search); params.set('decision', 'allow');
    const accepted = await service.fetch(new Request(url.origin + url.pathname, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body: params }));
    assert.equal(accepted.status, 303);
    const callback = await service.fetch(new Request(accepted.headers.get('location')!, { headers: { Cookie: cookie } }));
    assert.equal(callback.status, 303, await callback.text());
    assert.match(callback.headers.get('location')!, /connected=/);
    return { callbackUrl: accepted.headers.get('location')!, url };
  };
  return { service, cookie, call, create, connect };
}

test('real consent and PKCE callback connect a world; replay and cross-session callbacks fail', async () => {
  const f = await fixture();
  try {
    const world = await f.create();
    assert.equal((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payments`)).response.status, 401);
    const flow = await f.connect(world.id, 'stripe');
    const payments = await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payments`);
    assert.equal(payments.response.status, 200); assert.equal(payments.data.data.length, 3);
    assert.equal((await f.service.fetch(new Request(flow.callbackUrl, { headers: { Cookie: f.cookie } }))).status, 400);
    const started = await f.call(`/api/worlds/${world.id}/connect/gmail`, {}), u = new URL(started.data.authorization_url), p = new URLSearchParams(u.search); p.set('decision', 'allow');
    const accepted = await f.service.fetch(new Request(u.origin + u.pathname, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: p }));
    const other = await f.service.fetch(new Request(base));
    assert.equal((await f.service.fetch(new Request(accepted.headers.get('location')!, { headers: { Cookie: other.headers.get('set-cookie')!.split(';')[0] } }))).status, 400);
  } finally { await f.service.close(); }
});

test('public OAuth code is bound to PKCE/client/world/system; refresh rotates and revoke denies access', async () => {
  const f = await fixture();
  try {
    const world = await f.create(), otherWorld = await f.create({ name: 'Other world' }); assert.notEqual(world.id, otherWorld.id);
    const registered = await f.call('/api/oauth/clients', { name: 'SDK integration', redirect_uris: ['http://127.0.0.1:9123/callback'] });
    const client = registered.data.client_id, verifier = 'a'.repeat(64), challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({ client_id: client, redirect_uri: 'http://127.0.0.1:9123/callback', response_type: 'code', scope: 'read', state: 'external-client-state', world_id: world.id, code_challenge: challenge, code_challenge_method: 'S256', decision: 'allow' });
    const accepted = await f.service.fetch(new Request(base + '/oauth/stripe/authorize', { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params }));
    const code = new URL(accepted.headers.get('location')!).searchParams.get('code');
    const request = { grant_type: 'authorization_code', client_id: client, redirect_uri: 'http://127.0.0.1:9123/callback', code, code_verifier: verifier };
    assert.equal((await f.call('/oauth/stripe/token', { ...request, code_verifier: 'b'.repeat(64) }, {}, true)).response.status, 400);
    assert.equal((await f.call('/oauth/gmail/token', request, {}, true)).response.status, 400);
    const token = await f.call('/oauth/stripe/token', request, {}, true); assert.equal(token.response.status, 200);
    const auth = { Authorization: 'Bearer ' + token.data.access_token };
    assert.equal((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payments`, undefined, auth, true)).response.status, 200);
    assert.equal((await f.call(`/api/worlds/${otherWorld.id}/records?system=stripe&feed=payments`, undefined, auth, true)).response.status, 403);
    assert.equal((await f.call(`/api/worlds/${world.id}/records?system=gmail&feed=messages`, undefined, auth, true)).response.status, 403);
    assert.equal((await f.call(`/api/worlds/${world.id}/actions`, { type: 'refund', payment_id: 'pi_1', amount_minor: 100 }, auth, true)).response.status, 403);
    assert.equal((await f.call('/oauth/stripe/token', request, {}, true)).response.status, 400);
    const rotated = await f.call('/oauth/stripe/token', { grant_type: 'refresh_token', refresh_token: token.data.refresh_token, client_id: client }, {}, true); assert.equal(rotated.response.status, 200);
    assert.equal((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payments`, undefined, auth, true)).response.status, 401);
    assert.equal((await f.call('/oauth/stripe/token', { grant_type: 'refresh_token', refresh_token: token.data.refresh_token, client_id: client }, {}, true)).response.status, 400);
    await f.call('/oauth/stripe/revoke', { token: rotated.data.access_token, client_id: client }, {}, true);
    assert.equal((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payments`, undefined, { Authorization: 'Bearer ' + rotated.data.access_token }, true)).response.status, 401);
    const logs = JSON.stringify(f.service.store.events(world.id, 0, 1000));
    for (const value of [token.data.access_token, token.data.refresh_token, code, verifier]) assert.ok(!logs.includes(value), 'Audit must redact OAuth secrets');
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
    assert.ok(results.every(r => r.response.status === 200), JSON.stringify(results.map(r => r.data)));
    assert.equal(f.service.store.world(id).refunds.length, 1);
    assert.equal((await f.call(`/api/worlds/${id}/actions`, { ...input, amount_minor: 1600 }, { 'Idempotency-Key': key })).response.status, 409);
    await f.call(`/api/worlds/${id}/actions`, { type: 'set_fault', system: 'stripe', mode: 'offline' });
    assert.equal((await f.call(`/api/worlds/${id}/records?system=stripe&feed=payments`)).response.status, 503);
    await f.call(`/api/worlds/${id}/actions`, { type: 'advance_time', hours: 2 });
    assert.equal(f.service.store.world(id).refunds[0].status, 'pending');
    await f.call(`/api/worlds/${id}/actions`, { type: 'set_fault', system: 'stripe', mode: 'healthy' });
    await f.call(`/api/worlds/${id}/actions`, { type: 'close_period' });
    await f.call(`/api/worlds/${id}/actions`, { type: 'advance_time', hours: 1 });
    let s = (await f.call(`/api/worlds/${id}`)).data; assert.equal(s.world.refunds[0].status, 'succeeded'); assert.equal(s.summary.unposted_settlements, 1);
    await f.call(`/api/worlds/${id}/actions`, { type: 'reopen_period' });
    s = (await f.call(`/api/worlds/${id}`)).data; assert.equal(s.summary.reconciliation.bank_ledger_difference_minor, 0); assert.equal(s.summary.reconciliation.balanced, true);
    const mail = await f.call(`/providers/gmail/worlds/${id}/gmail/v1/users/me/messages`); assert.equal(mail.response.status, 200); assert.ok(mail.data.messages.length >= 2);
    const sent = s.world.messages.find((m: any) => m.direction === 'outbound');
    const detail = await f.call(`/providers/gmail/worlds/${id}/gmail/v1/users/me/messages/${sent.id}`); assert.match(Buffer.from(detail.data.payload.body.data, 'base64url').toString(), /15.00/);
    assert.equal(f.service.store.verify(id).valid, true);
    await f.service.close(); f = await fixture(database);
    const persisted = (await f.call(`/api/worlds/${id}`)).data;
    assert.equal(persisted.world.refunds.length, 1); assert.equal(persisted.world.refunds[0].status, 'succeeded');
    assert.equal((await f.call(`/api/worlds/${id}/actions`, input, { 'Idempotency-Key': key })).data.replayed, true);
    assert.equal(f.service.store.verify(id).valid, true);
  } finally { await f.service.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('agent capabilities cannot access judge truth, other worlds, approvals or controller actions', async () => {
  const f = await fixture();
  try {
    const w = await f.create(), other = await f.create(), token = 'scoped-agent-test-token';
    f.service.store.put('agent-tokens', hash(token), { actor: 'agent-test', world: w.id, expires_at: Date.now() + 60000 });
    const auth = { Authorization: 'Bearer ' + token };
    assert.equal((await f.call(`/api/worlds/${w.id}/context`, undefined, auth, true)).response.status, 200);
    for (const p of [`/api/worlds/${w.id}`, `/api/worlds/${w.id}/audit`, `/api/worlds/${other.id}/context`]) assert.equal((await f.call(p, undefined, auth, true)).response.status, 403);
    for (const type of ['advance_time', 'set_fault', 'decide_approval', 'close_period']) assert.equal((await f.call(`/api/worlds/${w.id}/actions`, { type }, auth, true)).response.status, 403);
    assert.equal((await f.call(`/api/worlds/${w.id}/connect/gmail`, {}, auth, true)).response.status, 403);
    assert.equal((await f.call(`/api/worlds/${w.id}/records?system=stripe&feed=payments`, undefined, auth, true)).response.status, 401);
    await f.connect(w.id, 'stripe');
    assert.equal((await f.call(`/api/worlds/${w.id}/actions`, { type: 'refund', payment_id: 'pi_1', amount_minor: 100 }, auth, true)).response.status, 200);
  } finally { await f.service.close(); }
});

test('untrusted origins and hosts are rejected; audit export is finite and detects tampering', async () => {
  const f = await fixture();
  try {
    const w = await f.create();
    assert.equal((await f.call('/api/worlds', {}, { Origin: 'https://attacker.example' })).response.status, 403);
    assert.equal((await f.call('/api/worlds', {}, { Host: 'attacker.example' })).response.status, 403);
    assert.equal((await f.call('/api/bootstrap', undefined, {}, true)).response.status, 403);
    for (let n = 0; n < 5; n++) await f.call(`/api/worlds/${w.id}/audit`);
    const exported = await f.call(`/api/worlds/${w.id}/audit/export`); assert.ok(exported.data.length < 100000, 'Audit reads must not recursively embed the entire audit');
    assert.equal(f.service.store.verify(w.id).valid, true);
    f.service.store.db.prepare('UPDATE audit SET value=? WHERE seq=(SELECT MIN(seq) FROM audit WHERE world=?)').run('{}', w.id);
    assert.equal(f.service.store.verify(w.id).valid, false);
  } finally { await f.service.close(); }
});

test('expired OAuth connection recovers after fresh consent; an offline rail remains offline', async () => {
  const f = await fixture();
  try {
    const world = await f.create(); await f.connect(world.id, 'stripe');
    await f.call(`/api/worlds/${world.id}/actions`, { type: 'set_fault', system: 'stripe', mode: 'expired' });
    assert.equal((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payment`)).response.status, 401);
    await f.connect(world.id, 'stripe');
    assert.equal((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payment`)).response.status, 200);
    await f.call(`/api/worlds/${world.id}/actions`, { type: 'set_fault', system: 'stripe', mode: 'offline' });
    await f.connect(world.id, 'stripe');
    assert.equal((await f.call(`/api/worlds/${world.id}/records?system=stripe&feed=payment`)).response.status, 503);
    await f.call(`/api/worlds/${world.id}/connections/stripe/revoke`, {});
    assert.equal(f.service.oauth.connections(world.id).find(c => c.system === 'stripe')?.status, 'disconnected');
  } finally { await f.service.close(); }
});

test('fresh agent shifts share idempotency ownership and cannot repay a lost acknowledgement', async () => {
  const f = await fixture();
  try {
    const w = await f.create(); await f.connect(w.id, 'stripe');
    const principal = `agent-world:${w.id}`;
    for (const token of ['shift-one', 'shift-two']) f.service.store.put('agent-tokens', hash(token), { actor: principal, runId: token, world: w.id, expires_at: Date.now() + 60000 });
    const input = { type: 'refund', payment_id: 'pi_1', amount_minor: 1000 }, headers = { 'Idempotency-Key': 'stable-finance-intent' };
    assert.equal((await f.call(`/api/worlds/${w.id}/actions`, input, { ...headers, Authorization: 'Bearer shift-one' }, true)).response.status, 200);
    const replay = await f.call(`/api/worlds/${w.id}/actions`, input, { ...headers, Authorization: 'Bearer shift-two' }, true);
    assert.equal(replay.data.replayed, true); assert.equal(f.service.store.world(w.id).refunds.length, 1);
  } finally { await f.service.close(); }
});

test('browser entry navigation is allowed while cross-site API calls remain denied', async () => {
  const f = await fixture();
  try {
    const entry = await f.service.fetch(new Request(base + '/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } }));
    assert.equal(entry.status, 200); assert.equal(entry.headers.get('referrer-policy'), 'same-origin');
    assert.equal((await f.call('/api/bootstrap', undefined, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' })).response.status, 403);
  } finally { await f.service.close(); }
});

test('provider HTTP contracts project canonical amounts and enforce read-only POST scopes', async () => {
  const f = await fixture();
  try {
    const w = await f.create({ kind: 'saas-collections', orderCount: 2 });
    for (const system of ['stripe', 'mercury', 'netsuite', 'gmail', 'quickbooks', 'ramp', 'plaid']) await f.connect(w.id, system);
    const stripe = await f.call(`/providers/stripe/worlds/${w.id}/v1/invoices`);
    assert.equal(stripe.data.data[0].object, 'invoice'); assert.equal(stripe.data.data[0].total, w.invoices[0].amount_minor); assert.equal(stripe.data.data[0].currency, 'usd');
    const qb = await f.call(`/providers/quickbooks/worlds/${w.id}/v3/company/${w.id}/query?query=SELECT%20*%20FROM%20Invoice`);
    assert.equal(qb.data.QueryResponse.Invoice[0].TotalAmt * 100, w.invoices[0].amount_minor);
    const ns = await f.call(`/providers/netsuite/worlds/${w.id}/services/rest/record/v1/invoice/inv_1`);
    assert.equal(ns.data.total * 100, w.invoices[0].amount_minor);
    const bank = await f.call(`/providers/mercury/worlds/${w.id}/api/v1/accounts`); assert.equal(bank.data.accounts[0].currentBalance, 20000);
    const tokens = f.service.oauth.mint({ world: w.id, system: 'plaid', client_id: 'test-client', actor: 'tester', scopes: ['read'] });
    const auth = { Authorization: 'Bearer ' + tokens.access_token };
    const accounts = await f.call(`/providers/plaid/worlds/${w.id}/accounts/get`, {}, auth, true); assert.equal(accounts.response.status, 200); assert.equal(accounts.data.accounts[0].balances.current, 20000);
    const synced = await f.call(`/providers/plaid/worlds/${w.id}/transactions/sync`, { count: 1 }, auth, true); assert.equal(synced.response.status, 200); assert.equal(synced.data.added.length, 1);
    const unsupported = await f.call(`/providers/stripe/worlds/${w.id}/v1/invoices?unknown=123`); assert.equal(unsupported.response.status, 501);
    const deniedWrite = await f.call(`/providers/ramp/worlds/${w.id}/developer/v1/bills`, { amount: 100 }); assert.equal(deniedWrite.response.status, 404);
    const email = Buffer.from('To: finance-review@simulation.test\r\nSubject: API receipt\r\n\r\nThis is an API-created email.').toString('base64url');
    const sent = await f.call(`/providers/gmail/worlds/${w.id}/gmail/v1/users/me/messages/send`, { raw: email }); assert.equal(sent.response.status, 200);
    const message = await f.call(`/providers/gmail/worlds/${w.id}/gmail/v1/users/me/messages/${sent.data.id}?format=raw`); assert.match(Buffer.from(message.data.raw, 'base64url').toString(), /API-created email/);
    const log = f.service.store.events(w.id, 0, 1000).find(e => e.data?.response?.error?.code === 'unsupported_filter'); assert.ok(log, 'Error codes remain observable after secret redaction');
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
      assert.equal(denied.response.status,403,JSON.stringify(denied.data));
      assert.equal(denied.data.error.code,'controller_required');
    }
    const collected = await f.call(path+'/actions',{type:'collect_invoice',invoice_id:w.invoices[0].id});
    assert.equal(collected.response.status,200,JSON.stringify(collected.data));
    await f.call(path+'/actions',{type:'advance_time',hours:1});
    const payment = f.service.store.world(w.id).payments.find((p:any)=>p.invoice_id===w.invoices[0].id);
    const creditInput = {type:'issue_credit_note',invoice_id:w.invoices[0].id,payment_id:payment.id,amount_minor:1200,reason:'Authenticated service adjustment',external_event_id:'credit-reference-1'};
    const credit = await f.call(path+'/actions',creditInput); assert.equal(credit.response.status,200,JSON.stringify(credit.data));
    const replay = await f.call(path+'/actions',creditInput); assert.equal(replay.response.status,200); assert.equal(replay.data.result.replayed,true);
    assert.equal(f.service.store.world(w.id).creditNotes.length,1);
    assert.equal((await f.call(path+'/actions',{...creditInput,amount_minor:1300})).response.status,409);
    assert.equal((await f.call(path+'/actions',{type:'refund',payment_id:payment.id,amount_minor:1200},auth,true)).data.error.code,'credit_note_required');
    const note = f.service.store.world(w.id).creditNotes[0];
    const refund = await f.call(path+'/actions',{type:'refund',payment_id:payment.id,credit_note_id:note.id,amount_minor:1200},auth,true); assert.equal(refund.response.status,200,JSON.stringify(refund.data));
    await f.call(path+'/actions',{type:'advance_time',hours:1});
    const snapshot = (await f.call(path)).data;
    assert.equal(snapshot.world.creditNotes[0].status,'refunded');
    assert.equal(snapshot.summary.customer_credits_payable_minor,0);
    assert.equal(snapshot.summary.reconciliation.bank_ledger_difference_minor,0);
    assert.equal(snapshot.summary.reconciliation.balanced,true);
    // A provider fact is still observable while the provider API is unavailable.
    await f.call(path+'/actions',{type:'set_fault',system:'stripe',mode:'offline'});
    const opened = await f.call(path+'/actions',{type:'open_dispute',payment_id:payment.id,amount_minor:500,reason:'Customer dispute',external_event_id:'dispute-reference-1'});
    assert.equal(opened.response.status,200,JSON.stringify(opened.data));
    const dispute = f.service.store.world(w.id).disputes[0];
    const evidenceInput = {type:'submit_dispute_evidence',dispute_id:dispute.id,document_ids:[w.documents[0].id],statement:'Signed services contract supports original collection.'};
    assert.equal((await f.call(path+'/actions',evidenceInput,auth,true)).response.status,503);
    await f.call(path+'/actions',{type:'set_fault',system:'stripe',mode:'healthy'});
    assert.equal((await f.call(path+'/actions',evidenceInput,auth,true)).response.status,200);
    const resolved = await f.call(path+'/actions',{type:'resolve_dispute',dispute_id:dispute.id,outcome:'won',external_event_id:'dispute-outcome-1'});
    assert.equal(resolved.response.status,200,JSON.stringify(resolved.data));
    assert.equal((await f.call(path)).data.summary.reconciliation.bank_ledger_difference_minor,0);
    assert.equal(f.service.store.verify(w.id).valid,true);
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
    assert.equal(send.response.status,200,JSON.stringify(send.data));
    const id=send.data.id, canonical=f.service.store.world(w.id).messages.find((m:any)=>m.id===id), attachment=canonical.attachments[0];
    assert.equal(canonical.body,'Review attached evidence.'); assert.match(canonical.html,/<script>/); assert.equal(attachment.filename,'evidence.csv');
    const original=await f.call(gmail+`/${id}?format=raw`);
    assert.equal(Buffer.from(original.data.raw,'base64url').toString(),raw);
    const providerFile=await f.call(gmail+`/${id}/attachments/${attachment.id}`); assert.equal(Buffer.from(providerFile.data.data,'base64url').toString(),csv);
    const operatorToken='mime-test-agent'; f.service.store.put('agent-tokens',hash(operatorToken),{world:w.id,actor:'mime-test-agent',expires_at:Date.now()+60000});
    const auth={Authorization:`Bearer ${operatorToken}`};
    const content=await f.call(path+`/attachment-content/${id}/${attachment.id}?limit=10`,undefined,auth,true);
    assert.equal(content.response.status,200); assert.equal(content.data.text,csv.slice(0,10)); assert.equal(content.data.next_offset,10); assert.equal(content.data.data,undefined);
    const rest=await f.call(path+`/attachment-content/${id}/${attachment.id}?offset=10`,undefined,auth,true); assert.equal(content.data.text+rest.data.text,csv);
    const download=await f.call(path+`/messages/${id}/attachments/${attachment.id}`); assert.equal(download.data,csv); assert.equal(download.response.headers.get('content-type'),'application/octet-stream'); assert.match(download.response.headers.get('content-disposition')!,/attachment/);
    assert.equal((await f.call(path+`/messages/${id}/attachments/${attachment.id}`,undefined,auth,true)).response.status,403);
    const before=f.service.store.world(w.id).messages.length;
    const injection=await f.call(gmail+'/send',{raw:Buffer.from(raw.replace('Subject: Evidence packet','Subject: =?utf-8?Q?Evidence=0D=0ABcc:_intruder@example.test?=')).toString('base64url')}); assert.equal(injection.response.status,400);
    assert.equal(f.service.store.world(w.id).messages.length,before);
    await f.call(path+'/connections/gmail/revoke',{});
    assert.equal((await f.call(path+`/attachment-content/${id}/${attachment.id}`,undefined,auth,true)).response.status,401);
    assert.equal(f.service.store.verify(w.id).valid,true);
  } finally { await f.service.close(); }
});

test('attachment evidence refuses invalid UTF-8 and paginates complete Unicode characters', async () => {
  const f=await fixture();
  try {
    const w=await f.create(),path=`/api/worlds/${w.id}`;await f.connect(w.id,'gmail');
    const bad=Buffer.from([0x43,0x61,0x66,0xe9]),good=Buffer.from('A😀éB');
    const result=await f.call(path+'/actions',{type:'receive_email',from:'audit@example.test',to:['finance@simulation.test'],subject:'Encoding evidence',body:'Preserve original evidence bytes',attachments:[{filename:'latin1.txt',mimeType:'text/plain',size:bad.length,data:bad.toString('base64url')},{filename:'unicode.txt',mimeType:'text/plain',size:good.length,data:good.toString('base64url')}]});
    assert.equal(result.response.status,200,JSON.stringify(result.data));
    const message=f.service.store.world(w.id).messages.at(-1),[first,second]=message.attachments;
    const unsupported=await f.call(path+`/attachment-content/${message.id}/${first.id}`);
    assert.equal(unsupported.response.status,200);assert.equal(unsupported.data.extraction,'unsupported-encoding');assert.equal(unsupported.data.text,undefined);
    const page1=await f.call(path+`/attachment-content/${message.id}/${second.id}?limit=2`),page2=await f.call(path+`/attachment-content/${message.id}/${second.id}?offset=2&limit=2`);
    assert.equal(page1.data.text,'A😀');assert.equal(page1.data.total_characters,4);assert.equal(page1.data.next_offset,2);assert.equal(page2.data.text,'éB');assert.equal(page2.data.next_offset,null);
    assert.equal(f.service.store.world(w.id).messages.at(-1).attachments[0].data,bad.toString('base64url'));
  }finally{await f.service.close();}
});

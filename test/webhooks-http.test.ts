import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { hash } from '../src/store.ts';

async function start(database: string, port = 0) {
  const server = await startServer({ database, port, agentEnabled: false, deliveryIntervalMs: 0 });
  const base = server.baseUrl;
  let cookie: string;
  try {
    const home = await fetch(base + '/', { keepalive: false, headers: { Connection: 'close' } });
    expect(home.status).toBe(200); expect(home.headers.get('set-cookie')).toBeTruthy();
    cookie = home.headers.get('set-cookie')!.split(';')[0]!; await home.text();
  } catch (error) { await server.close(); throw error; }
  const call = async (path: string, input?: unknown, extra: Record<string, string> = {}, anonymous = false) => {
    const response = await fetch(base + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(anonymous ? {} : { Cookie: cookie }), ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }), ...extra },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const data = await response.json(); return { response, data };
  };
  const create = async () => {
    const result = await call('/api/worlds', { name: 'HTTP webhook verification', kind: 'ticket-cancellation', seed: 11, orderCount: 3 });
    expect(result.response.status).toBe(201); return result.data.world;
  };
  const connect = async (world: string, system: string) => {
    const started = await call(`/api/worlds/${world}/connect/${system}`, {}); expect(started.response.status).toBe(200);
    const url = new URL(started.data.authorization_url);
    const consent = await fetch(url, { headers: { Cookie: cookie } }); expect(consent.status).toBe(200); expect(await consent.text()).toMatch(/<html/i);
    const consentInfo = await fetch(url.origin + `/oauth/${system}/consent` + url.search, { headers: { Cookie: cookie } });
    expect(consentInfo.status).toBe(200); const details = await consentInfo.json();
    expect(details.provider.id).toBe(system); expect(details.world).toBe(world); expect(details.scopes).toStrictEqual(['read', 'write']);
    const form = new URLSearchParams(url.search); form.set('decision', 'allow');
    const accepted = await fetch(url.origin + url.pathname, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
    expect(accepted.status).toBe(303); await accepted.text();
    const callback = await fetch(accepted.headers.get('location')!, { headers: { Cookie: cookie }, redirect: 'manual' });
    expect(callback.status).toBe(303); await callback.text();
  };
  return { server, base, cookie, call, create, connect, close: () => server.close() };
}

async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'finance-webhooks-http-'));
  const database = join(folder, 'world.sqlite');
  const f = await start(database);
  return { ...f, folder, database, dispose: async () => { await f.close(); rmSync(folder, { recursive: true, force: true }); } };
}

function signedHeaders(subscription: { id: string; secret: string }, delivery: any, invalid = false) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = invalid ? '0'.repeat(64) : new Bun.CryptoHasher('sha256', subscription.secret).update(`${timestamp}.${delivery.request_body}`).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Finance-World-Subscription-Id': subscription.id,
    'X-Finance-World-Delivery-Id': delivery.id,
    'X-Finance-World-Event-Id': delivery.event_id,
    'X-Finance-World-Timestamp': timestamp,
    'X-Finance-World-Signature': `v1=${signature}`,
  };
}

test('HTTP refund produces one outbox event; receiver failure, retry, signed receipt and replay remain coherent', async () => {
  const f = await fixture();
  try {
    const world = await f.create(), prefix = `/api/worlds/${world.id}`;
    await f.connect(world.id, 'stripe');
    const registered = await f.call(prefix + '/webhooks', { events: ['operation.*'], signingStyle: 'stripe' });
    expect(registered.response.status).toBe(201);
    const sub = registered.data;
    expect(sub.url).toBe(`${f.base}/receivers/${world.id}`); expect(sub.secret).toMatch(/^whsec_/);
    expect((await f.call(prefix + '/webhooks/receiver', { mode: 'fail' })).response.status).toBe(200);
    const action = { type: 'refund', payment_id: 'pi_1', amount_minor: 1500 }, key = 'same-http-refund';
    const submitted = await Promise.all(Array.from({ length: 5 }, () => f.call(prefix + '/actions', action, { 'Idempotency-Key': key })));
    expect(submitted.every(r => r.response.status === 200)).toBeTruthy();
    expect(submitted.filter(r => !r.data.replayed).length).toBe(1);
    let snapshot = (await f.call(prefix)).data;
    expect(snapshot.world.refunds.length).toBe(1); expect(snapshot.webhooks.deliveries.data.length).toBe(1);
    const first = snapshot.webhooks.deliveries.data[0];
    expect(first.event.type).toBe('operation.created');
    expect(first.event.data.object.operation_id).toBe(snapshot.world.operations[0].id);
    expect(first.event.data.object.amount_minor).toBe(1500);
    const badAction = await f.call(prefix + '/actions', { type: 'refund', payment_id: 'pi_1', amount_minor: 1_000_000_000 });
    expect(badAction.response.status).toBe(409);
    expect((await f.call(prefix + '/webhooks/deliveries')).data.data.length, 'Rejected financial actions must not enqueue notifications').toBe(1);
    const failed = await f.call(prefix + '/webhooks/dispatch', {});
    expect(failed.response.status).toBe(200); expect(failed.data.attempted).toBe(1); expect(failed.data.failed).toBe(1);
    let delivery = (await f.call(prefix + '/webhooks/deliveries')).data.data[0];
    expect(delivery.status).toBe('retrying'); expect(delivery.last_status).toBe(503); expect(delivery.attempts).toBe(1);
    expect((await f.call(prefix)).data.webhooks.receiver.receipts.length).toBe(0);
    await f.call(prefix + '/webhooks/receiver', { mode: 'accept' });
    expect((await f.call(prefix + `/webhooks/deliveries/${delivery.id}/retry`, {})).response.status).toBe(200);
    expect((await f.call(prefix + '/webhooks/dispatch', {})).data.delivered).toBe(1);
    snapshot = (await f.call(prefix)).data; delivery = snapshot.webhooks.deliveries.data[0];
    expect(delivery.status).toBe('delivered'); expect(delivery.attempts).toBe(2); expect(delivery.id).toBe(first.id);
    expect(delivery.request_body).toBe(first.request_body);
    expect(snapshot.webhooks.receiver.receipts.length).toBe(1);
    expect(snapshot.webhooks.receiver.receipts[0].event_id).toBe(first.event_id);
    expect(snapshot.webhooks.receiver.receipts[0].delivery_id).toBe(first.id);

    const invalid = await fetch(sub.url, { method: 'POST', headers: signedHeaders(sub, delivery, true), body: delivery.request_body });
    expect(invalid.status).toBe(401); expect((await invalid.json()).error.code).toBe('invalid_webhook_signature');
    const replay = await fetch(sub.url, { method: 'POST', headers: signedHeaders(sub, delivery), body: delivery.request_body });
    expect(replay.status).toBe(200); expect((await replay.json()).duplicate).toBe(true);
    expect((await f.call(prefix)).data.webhooks.receiver.receipts.length, 'Signed replay must not duplicate receiver effects').toBe(1);

    const advanced = await f.call(prefix + '/actions', { type: 'advance_time', hours: 2 }); expect(advanced.response.status).toBe(200);
    const second = (await f.call(prefix + '/webhooks/deliveries')).data.data;
    expect(second.length).toBe(2); expect(second[1].event.type).toBe('operation.settled');
    expect((await f.call(prefix + '/webhooks/dispatch', {})).data.delivered).toBe(1);
    snapshot = (await f.call(prefix)).data;
    expect(snapshot.world.refunds[0].status).toBe('succeeded');
    expect(snapshot.webhooks.receiver.receipts.length).toBe(2);
    expect(snapshot.summary.reconciliation.bank_ledger_difference_minor).toBe(0);
    const listed = await f.call(prefix + '/webhooks'); expect(listed.data.data[0].secret).toBeUndefined();
    const audit = await f.call(prefix + '/audit?limit=1000');
    expect(!JSON.stringify({ snapshot, listed: listed.data, audit: audit.data }).includes(sub.secret), 'Signing secret must not persist in public snapshots or HTTP audit').toBeTruthy();
    expect((await f.call(prefix + '/audit/verify')).data.valid).toBe(true);
  } finally { await f.dispose(); }
});

test('HTTP action failure to enqueue atomically rolls back economic state, event, and idempotency result', async () => {
  const f = await fixture();
  try {
    const world = await f.create(), prefix = `/api/worlds/${world.id}`;
    await f.connect(world.id, 'stripe'); await f.call(prefix + '/webhooks', { events: ['operation.created'] });
    f.server.store.db.exec("CREATE TRIGGER reject_webhook_insert BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT, 'injected outbox storage failure'); END;");
    const input = { type: 'refund', payment_id: 'pi_1', amount_minor: 1200 }, extra = { 'Idempotency-Key': 'rollback-original-key' };
    const failed = await f.call(prefix + '/actions', input, extra); expect(failed.response.status).toBe(500);
    let snapshot = (await f.call(prefix)).data;
    expect(snapshot.world.revision).toBe(world.revision); expect(snapshot.world.refunds.length).toBe(0); expect(snapshot.world.operations.length).toBe(0);
    expect(snapshot.webhooks.deliveries.data.length).toBe(0);
    expect((f.server.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get() as any).n).toBe(0);
    f.server.store.db.exec('DROP TRIGGER reject_webhook_insert');
    const recovered = await f.call(prefix + '/actions', input, extra); expect(recovered.response.status).toBe(200); expect(recovered.data.replayed).toBeUndefined();
    snapshot = (await f.call(prefix)).data;
    expect(snapshot.world.refunds.length).toBe(1); expect(snapshot.webhooks.deliveries.data.length).toBe(1);
  } finally { await f.dispose(); }
});

test('webhook management is controller-only and unauthorized receivers cannot create verified receipts', async () => {
  const f = await fixture();
  try {
    const world = await f.create(), prefix = `/api/worlds/${world.id}`;
    const sub = (await f.call(prefix + '/webhooks', { events: ['connection.changed'] })).data;
    await f.call(prefix + '/actions', { type: 'set_fault', system: 'stripe', mode: 'offline' });
    const delivery = (await f.call(prefix + '/webhooks/deliveries')).data.data[0];
    const token = 'http-webhook-agent-fixture';
    f.server.store.put('agent-tokens', hash(token), { actor: 'scoped-agent', world: world.id, expires_at: Date.now() + 60000 });
    const auth = { Authorization: `Bearer ${token}` };
    const cases: [string, unknown?][] = [
      [prefix + '/webhooks'], [prefix + '/webhooks', {}], [prefix + '/webhooks/deliveries'],
      [prefix + '/webhooks/dispatch', {}], [prefix + '/webhooks/receiver', { mode: 'fail' }],
      [prefix + `/webhooks/${sub.id}/disable`, {}], [prefix + `/webhooks/deliveries/${delivery.id}/retry`, {}],
    ];
    for (const [path, body] of cases) {
      expect((await f.call(path, body, auth, true)).response.status, path).toBe(403);
      expect((await f.call(path, body, {}, true)).response.status, path).toBe(401);
    }
    const unsigned = await fetch(`${f.base}/receivers/${world.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: delivery.request_body });
    expect(unsigned.status >= 400).toBeTruthy(); await unsigned.text();
    expect((await f.call(prefix)).data.webhooks.receiver.receipts.length).toBe(0);
    for (const url of ['http://localhost:24300/receiver', 'https://example.com/receiver']) expect((await f.call(prefix + '/webhooks', { url })).response.status).toBe(400);
    expect((await f.call(prefix + '/webhooks')).data.data.length).toBe(1);
    expect((await f.call(prefix + `/webhooks/${sub.id}/disable`, {})).response.status).toBe(200);
    await f.call(prefix + '/actions', { type: 'set_fault', system: 'stripe', mode: 'healthy' });
    expect((await f.call(prefix + '/webhooks/deliveries')).data.data.length).toBe(1);
    expect((await f.call(prefix + '/webhooks/deliveries')).data.data[0].status).toBe('cancelled');
  } finally { await f.dispose(); }
});

test('HTTP webhook queue survives a real service restart and retains signed payload and receipt identity', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'webhooks-http-restart-')), database = join(folder, 'state.sqlite');
  let f = await start(database), closed = false;
  try {
    const world = await f.create(), prefix = `/api/worlds/${world.id}`;
    const sub = (await f.call(prefix + '/webhooks', { events: ['connection.changed'] })).data;
    await f.call(prefix + '/webhooks/receiver', { mode: 'fail' });
    await f.call(prefix + '/actions', { type: 'set_fault', system: 'stripe', mode: 'offline' });
    expect((await f.call(prefix + '/webhooks/dispatch', {})).data.failed).toBe(1);
    const original = (await f.call(prefix + '/webhooks/deliveries')).data.data[0], port = Number(new URL(f.base).port);
    await f.close(); closed = true;
    f = await start(database, port); closed = false;
    const persisted = (await f.call(prefix + '/webhooks/deliveries')).data.data[0];
    expect(persisted.id).toBe(original.id); expect(persisted.event_id).toBe(original.event_id); expect(persisted.request_body).toBe(original.request_body);
    expect(persisted.status).toBe('retrying'); expect(persisted.attempts).toBe(1);
    expect((await f.call(prefix + '/webhooks')).data.data[0].secret).toBeUndefined();
    await f.call(prefix + '/webhooks/receiver', { mode: 'accept' });
    await f.call(prefix + `/webhooks/deliveries/${persisted.id}/retry`, {});
    expect((await f.call(prefix + '/webhooks/dispatch', {})).data.delivered).toBe(1);
    const snapshot = (await f.call(prefix)).data;
    expect(snapshot.webhooks.deliveries.data[0].attempts).toBe(2);
    expect(snapshot.webhooks.receiver.receipts.length).toBe(1);
    expect(snapshot.webhooks.receiver.receipts[0].delivery_id).toBe(original.id);
    const replay = await fetch(sub.url, { method: 'POST', headers: signedHeaders(sub, persisted), body: persisted.request_body });
    expect(replay.status).toBe(200); expect((await replay.json()).duplicate).toBe(true);
    expect((await f.call(prefix + '/audit/verify')).data.valid).toBe(true);
  } finally { if (!closed) await f.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('judge snapshot contains the latest 50 deliveries while ascending HTTP pagination retains history', async () => {
  const f = await fixture();
  try {
    const world = await f.create(), prefix = `/api/worlds/${world.id}`;
    await f.call(prefix + '/webhooks', { events: ['connection.changed'] });
    for (let i = 0; i < 55; i++) expect((await f.call(prefix + '/actions', { type: 'set_fault', system: 'stripe', mode: i % 2 ? 'healthy' : 'offline' })).response.status).toBe(200);
    const all = (await f.call(prefix + '/webhooks/deliveries?limit=100')).data.data;
    expect(all.length).toBe(55);
    const snapshot = (await f.call(prefix)).data.webhooks.deliveries.data;
    expect(snapshot.length).toBe(50); expect(snapshot[0].id).toBe(all[5].id); expect(snapshot.at(-1).id).toBe(all[54].id);
    const first = (await f.call(prefix + '/webhooks/deliveries?limit=10')).data;
    expect(first.data[0].id).toBe(all[0].id); expect(first.next_cursor).toBe(all[9].seq);
    const second = (await f.call(prefix + `/webhooks/deliveries?limit=10&after=${first.next_cursor}`)).data;
    expect(second.data[0].id).toBe(all[10].id);
  } finally { await f.dispose(); }
});

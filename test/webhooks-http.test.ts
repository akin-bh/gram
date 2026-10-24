import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
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
    assert.equal(home.status, 200); assert.ok(home.headers.get('set-cookie'));
    cookie = home.headers.get('set-cookie')!.split(';')[0]!; await home.text();
  } catch (error) { await server.close(); throw error; }
  const call = async (path: string, input?: unknown, extra: Record<string, string> = {}, anonymous = false) => {
    const response = await fetch(base + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(anonymous ? {} : { Cookie: cookie }), ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), ...extra },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const data = await response.json(); return { response, data };
  };
  const create = async () => {
    const result = await call('/api/worlds', { name: 'HTTP webhook verification', kind: 'ticket-cancellation', seed: 11, orderCount: 3 });
    assert.equal(result.response.status, 201); return result.data.world;
  };
  const connect = async (world: string, system: string) => {
    const started = await call(`/api/worlds/${world}/connect/${system}`, {}); assert.equal(started.response.status, 200);
    const url = new URL(started.data.authorization_url);
    const consent = await fetch(url, { headers: { Cookie: cookie } }); assert.equal(consent.status, 200); assert.match(await consent.text(), /<html/i);
    const consentInfo = await fetch(url.origin + `/oauth/${system}/consent` + url.search, { headers: { Cookie: cookie } });
    assert.equal(consentInfo.status, 200); const details = await consentInfo.json();
    assert.equal(details.provider.id, system); assert.equal(details.world, world); assert.deepEqual(details.scopes, ['read', 'write']);
    const form = new URLSearchParams(url.search); form.set('decision', 'allow');
    const accepted = await fetch(url.origin + url.pathname, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
    assert.equal(accepted.status, 303); await accepted.text();
    const callback = await fetch(accepted.headers.get('location')!, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(callback.status, 303); await callback.text();
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
  const signature = invalid ? '0'.repeat(64) : createHmac('sha256', subscription.secret).update(`${timestamp}.${delivery.request_body}`).digest('hex');
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
    assert.equal(registered.response.status, 201);
    const sub = registered.data;
    assert.equal(sub.url, `${f.base}/receivers/${world.id}`); assert.match(sub.secret, /^whsec_/);
    assert.equal((await f.call(prefix + '/webhooks/receiver', { mode: 'fail' })).response.status, 200);
    const action = { type: 'refund', payment_id: 'pi_1', amount_minor: 1500 }, key = 'same-http-refund';
    const submitted = await Promise.all(Array.from({ length: 5 }, () => f.call(prefix + '/actions', action, { 'Idempotency-Key': key })));
    assert.ok(submitted.every(r => r.response.status === 200));
    assert.equal(submitted.filter(r => !r.data.replayed).length, 1);
    let snapshot = (await f.call(prefix)).data;
    assert.equal(snapshot.world.refunds.length, 1); assert.equal(snapshot.webhooks.deliveries.data.length, 1);
    const first = snapshot.webhooks.deliveries.data[0];
    assert.equal(first.event.type, 'operation.created');
    assert.equal(first.event.data.object.operation_id, snapshot.world.operations[0].id);
    assert.equal(first.event.data.object.amount_minor, 1500);
    const badAction = await f.call(prefix + '/actions', { type: 'refund', payment_id: 'pi_1', amount_minor: 1_000_000_000 });
    assert.equal(badAction.response.status, 409);
    assert.equal((await f.call(prefix + '/webhooks/deliveries')).data.data.length, 1, 'Rejected financial actions must not enqueue notifications');
    const failed = await f.call(prefix + '/webhooks/dispatch', {});
    assert.equal(failed.response.status, 200); assert.equal(failed.data.attempted, 1); assert.equal(failed.data.failed, 1);
    let delivery = (await f.call(prefix + '/webhooks/deliveries')).data.data[0];
    assert.equal(delivery.status, 'retrying'); assert.equal(delivery.last_status, 503); assert.equal(delivery.attempts, 1);
    assert.equal((await f.call(prefix)).data.webhooks.receiver.receipts.length, 0);
    await f.call(prefix + '/webhooks/receiver', { mode: 'accept' });
    assert.equal((await f.call(prefix + `/webhooks/deliveries/${delivery.id}/retry`, {})).response.status, 200);
    assert.equal((await f.call(prefix + '/webhooks/dispatch', {})).data.delivered, 1);
    snapshot = (await f.call(prefix)).data; delivery = snapshot.webhooks.deliveries.data[0];
    assert.equal(delivery.status, 'delivered'); assert.equal(delivery.attempts, 2); assert.equal(delivery.id, first.id);
    assert.equal(delivery.request_body, first.request_body);
    assert.equal(snapshot.webhooks.receiver.receipts.length, 1);
    assert.equal(snapshot.webhooks.receiver.receipts[0].event_id, first.event_id);
    assert.equal(snapshot.webhooks.receiver.receipts[0].delivery_id, first.id);

    const invalid = await fetch(sub.url, { method: 'POST', headers: signedHeaders(sub, delivery, true), body: delivery.request_body });
    assert.equal(invalid.status, 401); assert.equal((await invalid.json()).error.code, 'invalid_webhook_signature');
    const replay = await fetch(sub.url, { method: 'POST', headers: signedHeaders(sub, delivery), body: delivery.request_body });
    assert.equal(replay.status, 200); assert.equal((await replay.json()).duplicate, true);
    assert.equal((await f.call(prefix)).data.webhooks.receiver.receipts.length, 1, 'Signed replay must not duplicate receiver effects');

    const advanced = await f.call(prefix + '/actions', { type: 'advance_time', hours: 2 }); assert.equal(advanced.response.status, 200);
    const second = (await f.call(prefix + '/webhooks/deliveries')).data.data;
    assert.equal(second.length, 2); assert.equal(second[1].event.type, 'operation.settled');
    assert.equal((await f.call(prefix + '/webhooks/dispatch', {})).data.delivered, 1);
    snapshot = (await f.call(prefix)).data;
    assert.equal(snapshot.world.refunds[0].status, 'succeeded');
    assert.equal(snapshot.webhooks.receiver.receipts.length, 2);
    assert.equal(snapshot.summary.reconciliation.bank_ledger_difference_minor, 0);
    const listed = await f.call(prefix + '/webhooks'); assert.equal(listed.data.data[0].secret, undefined);
    const audit = await f.call(prefix + '/audit?limit=1000');
    assert.ok(!JSON.stringify({ snapshot, listed: listed.data, audit: audit.data }).includes(sub.secret), 'Signing secret must not persist in public snapshots or HTTP audit');
    assert.equal((await f.call(prefix + '/audit/verify')).data.valid, true);
  } finally { await f.dispose(); }
});

test('HTTP action failure to enqueue atomically rolls back economic state, event, and idempotency result', async () => {
  const f = await fixture();
  try {
    const world = await f.create(), prefix = `/api/worlds/${world.id}`;
    await f.connect(world.id, 'stripe'); await f.call(prefix + '/webhooks', { events: ['operation.created'] });
    f.server.store.db.exec("CREATE TRIGGER reject_webhook_insert BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT, 'injected outbox storage failure'); END;");
    const input = { type: 'refund', payment_id: 'pi_1', amount_minor: 1200 }, extra = { 'Idempotency-Key': 'rollback-original-key' };
    const failed = await f.call(prefix + '/actions', input, extra); assert.equal(failed.response.status, 500);
    let snapshot = (await f.call(prefix)).data;
    assert.equal(snapshot.world.revision, world.revision); assert.equal(snapshot.world.refunds.length, 0); assert.equal(snapshot.world.operations.length, 0);
    assert.equal(snapshot.webhooks.deliveries.data.length, 0);
    assert.equal((f.server.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get() as any).n, 0);
    f.server.store.db.exec('DROP TRIGGER reject_webhook_insert');
    const recovered = await f.call(prefix + '/actions', input, extra); assert.equal(recovered.response.status, 200); assert.equal(recovered.data.replayed, undefined);
    snapshot = (await f.call(prefix)).data;
    assert.equal(snapshot.world.refunds.length, 1); assert.equal(snapshot.webhooks.deliveries.data.length, 1);
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
      assert.equal((await f.call(path, body, auth, true)).response.status, 403, path);
      assert.equal((await f.call(path, body, {}, true)).response.status, 401, path);
    }
    const unsigned = await fetch(`${f.base}/receivers/${world.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: delivery.request_body });
    assert.ok(unsigned.status >= 400); await unsigned.text();
    assert.equal((await f.call(prefix)).data.webhooks.receiver.receipts.length, 0);
    for (const url of ['http://localhost:24300/receiver', 'https://example.com/receiver']) assert.equal((await f.call(prefix + '/webhooks', { url })).response.status, 400);
    assert.equal((await f.call(prefix + '/webhooks')).data.data.length, 1);
    assert.equal((await f.call(prefix + `/webhooks/${sub.id}/disable`, {})).response.status, 200);
    await f.call(prefix + '/actions', { type: 'set_fault', system: 'stripe', mode: 'healthy' });
    assert.equal((await f.call(prefix + '/webhooks/deliveries')).data.data.length, 1);
    assert.equal((await f.call(prefix + '/webhooks/deliveries')).data.data[0].status, 'cancelled');
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
    assert.equal((await f.call(prefix + '/webhooks/dispatch', {})).data.failed, 1);
    const original = (await f.call(prefix + '/webhooks/deliveries')).data.data[0], port = Number(new URL(f.base).port);
    await f.close(); closed = true;
    f = await start(database, port); closed = false;
    const persisted = (await f.call(prefix + '/webhooks/deliveries')).data.data[0];
    assert.equal(persisted.id, original.id); assert.equal(persisted.event_id, original.event_id); assert.equal(persisted.request_body, original.request_body);
    assert.equal(persisted.status, 'retrying'); assert.equal(persisted.attempts, 1);
    assert.equal((await f.call(prefix + '/webhooks')).data.data[0].secret, undefined);
    await f.call(prefix + '/webhooks/receiver', { mode: 'accept' });
    await f.call(prefix + `/webhooks/deliveries/${persisted.id}/retry`, {});
    assert.equal((await f.call(prefix + '/webhooks/dispatch', {})).data.delivered, 1);
    const snapshot = (await f.call(prefix)).data;
    assert.equal(snapshot.webhooks.deliveries.data[0].attempts, 2);
    assert.equal(snapshot.webhooks.receiver.receipts.length, 1);
    assert.equal(snapshot.webhooks.receiver.receipts[0].delivery_id, original.id);
    const replay = await fetch(sub.url, { method: 'POST', headers: signedHeaders(sub, persisted), body: persisted.request_body });
    assert.equal(replay.status, 200); assert.equal((await replay.json()).duplicate, true);
    assert.equal((await f.call(prefix + '/audit/verify')).data.valid, true);
  } finally { if (!closed) await f.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('judge snapshot contains the latest 50 deliveries while ascending HTTP pagination retains history', async () => {
  const f = await fixture();
  try {
    const world = await f.create(), prefix = `/api/worlds/${world.id}`;
    await f.call(prefix + '/webhooks', { events: ['connection.changed'] });
    for (let i = 0; i < 55; i++) assert.equal((await f.call(prefix + '/actions', { type: 'set_fault', system: 'stripe', mode: i % 2 ? 'healthy' : 'offline' })).response.status, 200);
    const all = (await f.call(prefix + '/webhooks/deliveries?limit=100')).data.data;
    assert.equal(all.length, 55);
    const snapshot = (await f.call(prefix)).data.webhooks.deliveries.data;
    assert.equal(snapshot.length, 50); assert.equal(snapshot[0].id, all[5].id); assert.equal(snapshot.at(-1).id, all[54].id);
    const first = (await f.call(prefix + '/webhooks/deliveries?limit=10')).data;
    assert.equal(first.data[0].id, all[0].id); assert.equal(first.next_cursor, all[9].seq);
    const second = (await f.call(prefix + `/webhooks/deliveries?limit=10&after=${first.next_cursor}`)).data;
    assert.equal(second.data[0].id, all[10].id);
  } finally { await f.dispose(); }
});

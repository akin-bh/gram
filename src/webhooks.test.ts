import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { Webhooks } from './webhooks.ts';
import type { WebhookOptions } from './webhooks.ts';

const worldId = 'webhook-test-world';
const baseUrl = 'http://127.0.0.1:24300';
const financialEvent = { type: 'operation.settled', operation_id: 'op-17', receipt_id: 'receipt-17', amount_minor: 12345, currency: 'USD', occurred_at: '2026-10-25T10:00:00.000Z' };

type TestResponse = { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void };
async function receiver(handler: (req: { headers: Record<string, string> }, res: TestResponse, raw: string) => void | Promise<void>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    async fetch(request) {
      const raw = await request.text();
      return new Promise<Response>(resolve => {
        let status = 200, headers: Record<string, string> = {};
        const response: TestResponse = {
          writeHead(code, values = {}) { status = code; headers = values; },
          end(body = '') { resolve(new Response(body, { status, headers })); },
        };
        request.signal.addEventListener('abort', () => resolve(new Response(null, { status: 499 })), { once: true });
        Promise.resolve(handler({ headers: Object.fromEntries(request.headers) }, response, raw))
          .catch(error => resolve(new Response(String(error), { status: 500 })));
      });
    },
  });
  return { port: server.port!, url: `http://127.0.0.1:${server.port}/receive`, close: () => server.stop(true) };
}
function fixture(options: Partial<WebhookOptions> = {}, database = ':memory:') {
  const store = new Store(database);
  if (!store.worlds().length) store.save({ id: worldId, revision: 1, name: 'Webhook integration world' });
  const hooks = new Webhooks(store, { baseUrl, ...options });
  const emit = (revision = 2, events = [financialEvent]) => store.once(worldId, 'agent-stable', `event-revision-${revision}`, { revision, events }, () => {
    const world = store.world(worldId); world.revision = revision; store.save(world);
    return hooks.enqueue(worldId, events, { revision, requestId: `request-${revision}`, actor: 'agent-stable' });
  });
  return { store, hooks, emit, close: async () => { await hooks.close(); store.close(); } };
}

test('durable financial outbox delivers raw body signed with generic and Stripe-compatible HMAC', async () => {
  let hooks: Webhooks, signingSecret = '', verified: any, received = 0;
  const endpoint = await receiver((req, res, raw) => {
    received++;
    const timestamp = String(req.headers['x-finance-world-timestamp']);
    const expected = createHmac('sha256', signingSecret).update(`${timestamp}.${raw}`).digest('hex');
    assert.equal(req.headers['x-finance-world-signature'], `v1=${expected}`);
    assert.equal(req.headers['stripe-signature'], `t=${timestamp},v1=${expected}`);
    verified = hooks.verify(worldId, new Headers(req.headers as HeadersInit), raw);
    assert.equal(verified.event.data.object.operation_id, 'op-17');
    assert.equal(verified.event.data.object.amount_minor, 12345);
    res.writeHead(202); res.end('accepted');
  });
  const f = fixture({ allowedPorts: [endpoint.port] }); hooks = f.hooks;
  try {
    const sub = hooks.register(worldId, { url: endpoint.url, events: ['operation.*'], signingStyle: 'stripe' }); signingSecret = sub.secret;
    const emitted = f.emit(), replay = f.emit();
    assert.deepEqual(replay.event_ids, emitted.event_ids); assert.equal(replay.replayed, true);
    assert.equal(hooks.deliveries(worldId).data.length, 1);
    const result = await hooks.deliverDue(worldId);
    assert.equal(result.delivered, 1); assert.equal(received, 1);
    const delivery = hooks.deliveries(worldId).data[0]!;
    assert.equal(delivery.status, 'delivered'); assert.equal(delivery.attempts, 1);
    assert.equal(verified.delivery_id, delivery.id); assert.equal(verified.event_id, emitted.event_ids[0]);
    assert.equal(delivery.event.context.revision, 2);
    assert.equal((await hooks.deliverDue()).attempted, 0);
    const publicData = JSON.stringify({ subscriptions: hooks.list(worldId), deliveries: hooks.deliveries(worldId), audit: f.store.events(worldId, 0, 1000) });
    assert.ok(!publicData.includes(signingSecret)); assert.ok(!publicData.includes('signing_secret'));
    assert.equal(f.store.verify(worldId).valid, true);
  } finally { await f.close(); await endpoint.close(); }
});

test('event enqueue and business state roll back together; event identity rejects conflicting facts', async () => {
  const f = fixture();
  try {
    f.hooks.register(worldId, { url: baseUrl + '/receiver', events: ['operation.settled'] });
    assert.throws(() => f.store.once(worldId, 'agent', 'rolled-back', {}, () => {
      const world = f.store.world(worldId); world.revision = 99; f.store.save(world);
      f.hooks.enqueue(worldId, [financialEvent], { revision: 99 });
      throw Error('economic transaction rejected');
    }), /economic transaction rejected/);
    assert.equal(f.store.world(worldId).revision, 1); assert.equal(f.hooks.deliveries(worldId).data.length, 0);
    assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get() as any).n, 0);
    const first = f.emit();
    assert.deepEqual(f.hooks.enqueue(worldId, [financialEvent], { revision: 2, requestId: 'another-request' }).event_ids, first.event_ids);
    assert.throws(() => f.hooks.enqueue(worldId, [{ ...financialEvent, amount_minor: 999 }], { revision: 2 }), { code: 'webhook_event_conflict' });
    assert.equal(f.hooks.deliveries(worldId).data[0]!.event.data.object.amount_minor, 12345);
    assert.throws(() => f.hooks.enqueue(worldId, [financialEvent], {}), { code: 'webhook_event_identity_required' });
    assert.throws(() => f.hooks.enqueue(worldId, [{} as any], { revision: 3 }), { code: 'invalid_webhook_event_type' });
  } finally { await f.close(); }
});

test('failure, durable restart, backoff, and explicit redelivery preserve event and delivery IDs', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'webhook-restart-')), database = join(folder, 'state.sqlite');
  let now = Date.now(), accept = false; const requests: { id: string; raw: string }[] = [];
  const endpoint = await receiver((req, res, raw) => { requests.push({ id: String(req.headers['x-finance-world-delivery-id']), raw }); res.writeHead(accept ? 200 : 503); res.end(accept ? 'accepted' : 'retry later'); });
  let f = fixture({ allowedPorts: [endpoint.port], now: () => now, baseRetryMs: 1000 }, database);
  try {
    f.hooks.register(worldId, { url: endpoint.url }); const original = f.emit();
    assert.equal((await f.hooks.deliverDue()).failed, 1);
    let delivery = f.hooks.deliveries(worldId).data[0]!;
    assert.equal(delivery.status, 'retrying'); assert.equal(delivery.attempts, 1); assert.equal(delivery.next_attempt_at, now + 1000);
    assert.equal((await f.hooks.deliverDue()).attempted, 0, 'Backoff cannot be bypassed by polling');
    await f.close(); f = fixture({ allowedPorts: [endpoint.port], now: () => now }, database);
    now += 1000; accept = true;
    assert.equal((await f.hooks.deliverDue()).delivered, 1);
    delivery = f.hooks.deliveries(worldId).data[0]!;
    assert.equal(delivery.attempts, 2); assert.equal(delivery.id, original.delivery_ids[0]); assert.equal(delivery.event.id, original.event_ids[0]);
    assert.equal(requests[0]!.raw, requests[1]!.raw); assert.equal(requests[0]!.id, requests[1]!.id);
    f.hooks.retry(worldId, delivery.id); await f.hooks.deliverDue();
    assert.equal(requests[2]!.id, delivery.id); assert.equal(requests[2]!.raw, requests[0]!.raw);
    assert.equal(f.hooks.deliveries(worldId).data[0]!.attempts, 3);
  } finally { await f.close(); await endpoint.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('expired claims recover after restart; an unexpired claim cannot be sent twice', async () => {
  let now = Date.now(), deliveries = 0;
  const endpoint = await receiver((_req, res) => { deliveries++; res.end('ok'); });
  const f = fixture({ allowedPorts: [endpoint.port], now: () => now });
  try {
    f.hooks.register(worldId, { url: endpoint.url }); const result = f.emit(), id = result.delivery_ids[0]!;
    f.store.db.prepare("UPDATE webhook_deliveries SET status='inflight',claim_owner='dead-process',lease_until=?,attempts=1,cycle_attempts=1 WHERE id=?").run(now + 5000, id);
    assert.equal((await f.hooks.deliverDue()).attempted, 0); assert.equal(deliveries, 0);
    now += 5001; await f.hooks.close();
    const resumed = new Webhooks(f.store, { baseUrl, allowedPorts: [endpoint.port], now: () => now });
    try {
      assert.equal((await resumed.deliverDue()).delivered, 1); assert.equal(deliveries, 1);
      const delivery = resumed.deliveries(worldId).data[0]!; assert.equal(delivery.id, id); assert.equal(delivery.attempts, 2);
      assert.ok(f.store.events(worldId, 0, 1000).some(e => e.type === 'webhook.attempt_started' && e.data.lease_recovered));
    } finally { await resumed.close(); }
  } finally { await f.close(); await endpoint.close(); }
});

test('maximum attempts dead-letter durably; explicit retry and disabling have clear effects', async () => {
  let now = Date.now();
  const endpoint = await receiver((_req, res) => { res.writeHead(500); res.end('temporary failure'); });
  const f = fixture({ allowedPorts: [endpoint.port], maxAttempts: 2, baseRetryMs: 10, now: () => now });
  try {
    const sub = f.hooks.register(worldId, { url: endpoint.url }); const first = f.emit();
    await f.hooks.deliverDue(); now += 10; await f.hooks.deliverDue();
    let delivery = f.hooks.deliveries(worldId).data[0]!;
    assert.equal(delivery.status, 'dead'); assert.equal(delivery.attempts, 2); now += 10000;
    assert.equal((await f.hooks.deliverDue()).attempted, 0);
    f.hooks.retry(worldId, delivery.id); await f.hooks.deliverDue();
    delivery = f.hooks.deliveries(worldId).data[0]!;
    assert.equal(delivery.id, first.delivery_ids[0]); assert.equal(delivery.status, 'retrying'); assert.equal(delivery.attempts, 3);
    f.hooks.disable(worldId, sub.id);
    assert.equal(f.hooks.deliveries(worldId).data[0]!.status, 'cancelled');
    assert.throws(() => f.hooks.retry(worldId, delivery.id), { code: 'webhook_subscription_disabled' });
    f.emit(3); assert.equal(f.hooks.deliveries(worldId).data.length, 1);
  } finally { await f.close(); await endpoint.close(); }
});

test('callback validation rejects DNS, credentials, alternate loopback spellings, and unlisted ports', async () => {
  const f = fixture();
  try {
    for (const url of ['https://127.0.0.1:24300/callback', 'http://localhost:24300/callback', 'http://[::1]:24300/callback', 'http://127.1:24300/callback', 'http://2130706433:24300/callback', 'http://127.0.0.1:24301/callback', 'http://user:password@127.0.0.1:24300/callback', 'http://127.0.0.1:24300/callback#fragment', 'http://169.254.169.254:24300/callback']) {
      assert.throws(() => f.hooks.register(worldId, { url }), /callback|Callback|URL|destination|loopback/i, url);
    }
    assert.throws(() => f.hooks.register(worldId, { url: baseUrl + '/receiver', events: ['operation.*.*'] }), { code: 'invalid_webhook_events' });
  } finally { await f.close(); }
});

test('redirect responses are never followed and receiver bodies are bounded', async () => {
  let targetHits = 0, serveHugeBody = false;
  const target = await receiver((_req, res) => { targetHits++; res.end('unexpected'); });
  const endpoint = await receiver((_req, res) => {
    if (serveHugeBody) { res.writeHead(503); res.end('x'.repeat(100000)); }
    else { res.writeHead(307, { Location: target.url }); res.end('redirect'); }
  });
  const f = fixture({ allowedPorts: [endpoint.port], maxResponseBytes: 128 });
  try {
    f.hooks.register(worldId, { url: endpoint.url }); f.emit();
    await f.hooks.deliverDue();
    let delivery = f.hooks.deliveries(worldId).data[0]!;
    assert.equal(targetHits, 0); assert.equal(delivery.last_error, 'redirect_refused'); assert.equal(delivery.last_status, 307);
    serveHugeBody = true; f.hooks.retry(worldId, delivery.id); await f.hooks.deliverDue();
    delivery = f.hooks.deliveries(worldId).data[0]!;
    assert.equal(delivery.response_excerpt!.length, 128); assert.equal(delivery.response_truncated, 1); assert.equal(targetHits, 0);
  } finally { await f.close(); await endpoint.close(); await target.close(); }
});

test('timeouts and graceful close leave durable retryable work instead of hanging', async () => {
  let requestStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const endpoint = await receiver((_req, _res) => { requestStarted?.(); });
  const f = fixture({ allowedPorts: [endpoint.port], timeoutMs: 30, baseRetryMs: 1 });
  try {
    f.hooks.register(worldId, { url: endpoint.url }); f.emit();
    const run = f.hooks.deliverDue(); await started; await run;
    let delivery = f.hooks.deliveries(worldId).data[0]!;
    assert.equal(delivery.status, 'retrying'); assert.equal(delivery.last_error, 'delivery_timeout');
    f.hooks.retry(worldId, delivery.id);
    const pending = f.hooks.deliverDue(); await f.hooks.close(); await pending;
    delivery = f.hooks.deliveries(worldId).data[0]!;
    assert.equal(delivery.status, 'retrying'); assert.equal(delivery.last_error, 'service_stopping');
    await assert.rejects(f.hooks.deliverDue(), { code: 'webhooks_closed' });
  } finally { await f.close(); await endpoint.close(); }
});

test('verification binds body, subscription, world, ID and timestamp and excludes secrets from audits', async () => {
  let captured: { headers: Headers; raw: string } | undefined;
  const endpoint = await receiver((req, res, raw) => { captured = { headers: new Headers(req.headers as HeadersInit), raw }; res.end('ok'); });
  let now = Date.now();
  const f = fixture({ allowedPorts: [endpoint.port], now: () => now });
  try {
    const sub = f.hooks.register(worldId, { url: endpoint.url }); f.emit(); await f.hooks.deliverDue();
    assert.ok(captured); const { headers, raw } = captured;
    assert.equal(f.hooks.verify(worldId, headers, raw).event.data.object.operation_id, 'op-17');
    assert.throws(() => f.hooks.verify(worldId, headers, raw + ' '), { code: 'invalid_webhook_body' });
    assert.throws(() => f.hooks.verify('other-world', headers, raw), { code: 'webhook_subscription_not_found' });
    const wrong = new Headers(headers); wrong.set('x-finance-world-signature', 'v1=' + '0'.repeat(64));
    assert.throws(() => f.hooks.verify(worldId, wrong, raw), { code: 'invalid_webhook_signature' });
    const wrongId = new Headers(headers); wrongId.set('x-finance-world-delivery-id', 'delivery-from-another-event');
    assert.throws(() => f.hooks.verify(worldId, wrongId, raw), { code: 'invalid_webhook_identity' });
    now += 301000; assert.throws(() => f.hooks.verify(worldId, headers, raw), { code: 'expired_webhook_signature' });
    assert.ok(!JSON.stringify(f.store.events(worldId, 0, 1000)).includes(sub.secret));
  } finally { await f.close(); await endpoint.close(); }
});

test('concurrent dispatchers honor the durable claim and do not deliver an active lease twice', async () => {
  let acknowledge: (() => void) | undefined, markStarted: (() => void) | undefined, received = 0;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const endpoint = await receiver(async (_req, res) => {
    received++; markStarted?.();
    await new Promise<void>(resolve => { acknowledge = resolve; });
    res.end('accepted');
  });
  const f = fixture({ allowedPorts: [endpoint.port] });
  const second = new Webhooks(f.store, { baseUrl, allowedPorts: [endpoint.port] });
  try {
    f.hooks.register(worldId, { url: endpoint.url }); f.emit();
    const first = f.hooks.deliverDue(); await started;
    assert.equal((await second.deliverDue()).attempted, 0);
    acknowledge?.(); assert.equal((await first).delivered, 1);
    assert.equal(received, 1); assert.equal(f.hooks.deliveries(worldId).data[0]!.attempts, 1);
  } finally { acknowledge?.(); await second.close(); await f.close(); await endpoint.close(); }
});

test('receiver errors cannot echo the signing secret or JSON credentials into delivery audit', async () => {
  let signingSecret = '';
  const endpoint = await receiver((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Debug: ' + signingSecret, access_token: 'receiver-access-credential', client_secret: 'receiver-client-credential' }));
  });
  const f = fixture({ allowedPorts: [endpoint.port] });
  try {
    signingSecret = f.hooks.register(worldId, { url: endpoint.url }).secret; f.emit(); await f.hooks.deliverDue();
    const serialized = JSON.stringify({ deliveries: f.hooks.deliveries(worldId), audit: f.store.events(worldId, 0, 1000) });
    for (const credential of [signingSecret, 'receiver-access-credential', 'receiver-client-credential']) assert.ok(!serialized.includes(credential));
  } finally { await f.close(); await endpoint.close(); }
});

test('simultaneous world-specific dispatches return and deliver only their requested world', async () => {
  let acknowledge: (() => void) | undefined, markStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const observed: string[] = [];
  const endpoint = await receiver(async (_req, res, raw) => {
    const event = JSON.parse(raw); observed.push(event.world_id);
    if (event.world_id === worldId) { markStarted?.(); await new Promise<void>(resolve => { acknowledge = resolve; }); }
    res.end('accepted');
  });
  const f = fixture({ allowedPorts: [endpoint.port] });
  const secondWorld = 'second-webhook-world';
  try {
    f.store.save({ id: secondWorld, revision: 1 });
    for (const id of [worldId, secondWorld]) {
      f.hooks.register(id, { url: endpoint.url });
      f.hooks.enqueue(id, [{ ...financialEvent, operation_id: id }], { revision: 2 });
    }
    const first = f.hooks.deliverDue(worldId); await started;
    const second = f.hooks.deliverDue(secondWorld), duplicate = f.hooks.deliverDue(secondWorld);
    acknowledge?.();
    const [a, b, same] = await Promise.all([first, second, duplicate]);
    assert.deepEqual(a.data.map(row => row.world), [worldId]);
    assert.deepEqual(b.data.map(row => row.world), [secondWorld]);
    assert.deepEqual(same.data.map(row => row.id), b.data.map(row => row.id));
    assert.deepEqual(observed, [worldId, secondWorld]);
    assert.equal(f.hooks.deliveries(secondWorld).data[0]!.status, 'delivered');
    assert.equal(f.hooks.deliveries(secondWorld).data[0]!.attempts, 1);
  } finally { acknowledge?.(); await f.close(); await endpoint.close(); }
});

test('a scoped request waits behind a background batch without inheriting other-world results', async () => {
  const endpoint = await receiver((_req, res) => { res.end('accepted'); });
  const f = fixture({ allowedPorts: [endpoint.port] });
  const secondWorld = 'second-background-world';
  try {
    f.store.save({ id: secondWorld });
    for (const id of [worldId, secondWorld]) { f.hooks.register(id, { url: endpoint.url }); f.hooks.enqueue(id, [financialEvent], { revision: 2 }); }
    const [background, scoped] = await Promise.all([f.hooks.deliverDue(undefined, { limit: 1 }), f.hooks.deliverDue(secondWorld)]);
    assert.equal(background.data[0]!.world, worldId);
    assert.deepEqual(scoped.data.map(row => row.world), [secondWorld]);
    assert.equal(scoped.delivered, 1);
  } finally { await f.close(); await endpoint.close(); }
});

test('shutdown aborts an active batch and rejects queued scoped dispatch without new sends', async () => {
  let markStarted: (() => void) | undefined; const started = new Promise<void>(resolve => { markStarted = resolve; });
  let received = 0;
  const endpoint = await receiver((_req, _res) => { received++; markStarted?.(); });
  const f = fixture({ allowedPorts: [endpoint.port], timeoutMs: 5000 });
  const secondWorld = 'queued-shutdown-world';
  try {
    f.store.save({ id: secondWorld });
    for (const id of [worldId, secondWorld]) { f.hooks.register(id, { url: endpoint.url }); f.hooks.enqueue(id, [financialEvent], { revision: 2 }); }
    const active = f.hooks.deliverDue(worldId); await started;
    const queued = f.hooks.deliverDue(secondWorld);
    const rejected = assert.rejects(queued, { code: 'webhooks_closed' });
    await f.hooks.close(); await active; await rejected;
    assert.equal(received, 1);
    assert.equal(f.hooks.deliveries(worldId).data[0]!.status, 'retrying');
    assert.equal(f.hooks.deliveries(secondWorld).data[0]!.status, 'pending');
    assert.equal(f.hooks.deliveries(secondWorld).data[0]!.attempts, 0);
  } finally { await f.close(); await endpoint.close(); }
});

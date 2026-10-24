import { test, expect } from 'bun:test';
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
    const expected = new Bun.CryptoHasher('sha256', signingSecret).update(`${timestamp}.${raw}`).digest('hex');
    expect(req.headers['x-finance-world-signature']).toBe(`v1=${expected}`);
    expect(req.headers['stripe-signature']).toBe(`t=${timestamp},v1=${expected}`);
    verified = hooks.verify(worldId, new Headers(req.headers as HeadersInit), raw);
    expect(verified.event.data.object.operation_id).toBe('op-17');
    expect(verified.event.data.object.amount_minor).toBe(12345);
    res.writeHead(202); res.end('accepted');
  });
  const f = fixture({ allowedPorts: [endpoint.port] }); hooks = f.hooks;
  try {
    const sub = hooks.register(worldId, { url: endpoint.url, events: ['operation.*'], signingStyle: 'stripe' }); signingSecret = sub.secret;
    const emitted = f.emit(), replay = f.emit();
    expect(replay.event_ids).toStrictEqual(emitted.event_ids); expect(replay.replayed).toBe(true);
    expect(hooks.deliveries(worldId).data.length).toBe(1);
    const result = await hooks.deliverDue(worldId);
    expect(result.delivered).toBe(1); expect(received).toBe(1);
    const delivery = hooks.deliveries(worldId).data[0]!;
    expect(delivery.status).toBe('delivered'); expect(delivery.attempts).toBe(1);
    expect(verified.delivery_id).toBe(delivery.id); expect(verified.event_id).toBe(emitted.event_ids[0]);
    expect(delivery.event.context.revision).toBe(2);
    expect((await hooks.deliverDue()).attempted).toBe(0);
    const publicData = JSON.stringify({ subscriptions: hooks.list(worldId), deliveries: hooks.deliveries(worldId), audit: f.store.events(worldId, 0, 1000) });
    expect(!publicData.includes(signingSecret)).toBeTruthy(); expect(!publicData.includes('signing_secret')).toBeTruthy();
    expect(f.store.verify(worldId).valid).toBe(true);
  } finally { await f.close(); await endpoint.close(); }
});

test('event enqueue and business state roll back together; event identity rejects conflicting facts', async () => {
  const f = fixture();
  try {
    f.hooks.register(worldId, { url: baseUrl + '/receiver', events: ['operation.settled'] });
    expect(() => f.store.once(worldId, 'agent', 'rolled-back', {}, () => {
      const world = f.store.world(worldId); world.revision = 99; f.store.save(world);
      f.hooks.enqueue(worldId, [financialEvent], { revision: 99 });
      throw Error('economic transaction rejected');
    })).toThrow(/economic transaction rejected/);
    expect(f.store.world(worldId).revision).toBe(1); expect(f.hooks.deliveries(worldId).data.length).toBe(0);
    expect((f.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get() as any).n).toBe(0);
    const first = f.emit();
    expect(f.hooks.enqueue(worldId, [financialEvent], { revision: 2, requestId: 'another-request' }).event_ids).toStrictEqual(first.event_ids);
    expect(() => f.hooks.enqueue(worldId, [{ ...financialEvent, amount_minor: 999 }], { revision: 2 })).toThrow(expect.objectContaining({ code: 'webhook_event_conflict' }));
    expect(f.hooks.deliveries(worldId).data[0]!.event.data.object.amount_minor).toBe(12345);
    expect(() => f.hooks.enqueue(worldId, [financialEvent], {})).toThrow(expect.objectContaining({ code: 'webhook_event_identity_required' }));
    expect(() => f.hooks.enqueue(worldId, [{} as any], { revision: 3 })).toThrow(expect.objectContaining({ code: 'invalid_webhook_event_type' }));
  } finally { await f.close(); }
});

test('failure, durable restart, backoff, and explicit redelivery preserve event and delivery IDs', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'webhook-restart-')), database = join(folder, 'state.sqlite');
  let now = Date.now(), accept = false; const requests: { id: string; raw: string }[] = [];
  const endpoint = await receiver((req, res, raw) => { requests.push({ id: String(req.headers['x-finance-world-delivery-id']), raw }); res.writeHead(accept ? 200 : 503); res.end(accept ? 'accepted' : 'retry later'); });
  let f = fixture({ allowedPorts: [endpoint.port], now: () => now, baseRetryMs: 1000 }, database);
  try {
    f.hooks.register(worldId, { url: endpoint.url }); const original = f.emit();
    expect((await f.hooks.deliverDue()).failed).toBe(1);
    let delivery = f.hooks.deliveries(worldId).data[0]!;
    expect(delivery.status).toBe('retrying'); expect(delivery.attempts).toBe(1); expect(delivery.next_attempt_at).toBe(now + 1000);
    expect((await f.hooks.deliverDue()).attempted, 'Backoff cannot be bypassed by polling').toBe(0);
    await f.close(); f = fixture({ allowedPorts: [endpoint.port], now: () => now }, database);
    now += 1000; accept = true;
    expect((await f.hooks.deliverDue()).delivered).toBe(1);
    delivery = f.hooks.deliveries(worldId).data[0]!;
    expect(delivery.attempts).toBe(2); expect(delivery.id).toBe(original.delivery_ids[0]); expect(delivery.event.id).toBe(original.event_ids[0]);
    expect(requests[0]!.raw).toBe(requests[1]!.raw); expect(requests[0]!.id).toBe(requests[1]!.id);
    f.hooks.retry(worldId, delivery.id); await f.hooks.deliverDue();
    expect(requests[2]!.id).toBe(delivery.id); expect(requests[2]!.raw).toBe(requests[0]!.raw);
    expect(f.hooks.deliveries(worldId).data[0]!.attempts).toBe(3);
  } finally { await f.close(); await endpoint.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('expired claims recover after restart; an unexpired claim cannot be sent twice', async () => {
  let now = Date.now(), deliveries = 0;
  const endpoint = await receiver((_req, res) => { deliveries++; res.end('ok'); });
  const f = fixture({ allowedPorts: [endpoint.port], now: () => now });
  try {
    f.hooks.register(worldId, { url: endpoint.url }); const result = f.emit(), id = result.delivery_ids[0]!;
    f.store.db.prepare("UPDATE webhook_deliveries SET status='inflight',claim_owner='dead-process',lease_until=?,attempts=1,cycle_attempts=1 WHERE id=?").run(now + 5000, id);
    expect((await f.hooks.deliverDue()).attempted).toBe(0); expect(deliveries).toBe(0);
    now += 5001; await f.hooks.close();
    const resumed = new Webhooks(f.store, { baseUrl, allowedPorts: [endpoint.port], now: () => now });
    try {
      expect((await resumed.deliverDue()).delivered).toBe(1); expect(deliveries).toBe(1);
      const delivery = resumed.deliveries(worldId).data[0]!; expect(delivery.id).toBe(id); expect(delivery.attempts).toBe(2);
      expect(f.store.events(worldId, 0, 1000).some(e => e.type === 'webhook.attempt_started' && e.data.lease_recovered)).toBeTruthy();
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
    expect(delivery.status).toBe('dead'); expect(delivery.attempts).toBe(2); now += 10000;
    expect((await f.hooks.deliverDue()).attempted).toBe(0);
    f.hooks.retry(worldId, delivery.id); await f.hooks.deliverDue();
    delivery = f.hooks.deliveries(worldId).data[0]!;
    expect(delivery.id).toBe(first.delivery_ids[0]); expect(delivery.status).toBe('retrying'); expect(delivery.attempts).toBe(3);
    f.hooks.disable(worldId, sub.id);
    expect(f.hooks.deliveries(worldId).data[0]!.status).toBe('cancelled');
    expect(() => f.hooks.retry(worldId, delivery.id)).toThrow(expect.objectContaining({ code: 'webhook_subscription_disabled' }));
    f.emit(3); expect(f.hooks.deliveries(worldId).data.length).toBe(1);
  } finally { await f.close(); await endpoint.close(); }
});

test('callback validation rejects DNS, credentials, alternate loopback spellings, and unlisted ports', async () => {
  const f = fixture();
  try {
    for (const url of ['https://127.0.0.1:24300/callback', 'http://localhost:24300/callback', 'http://[::1]:24300/callback', 'http://127.1:24300/callback', 'http://2130706433:24300/callback', 'http://127.0.0.1:24301/callback', 'http://user:password@127.0.0.1:24300/callback', 'http://127.0.0.1:24300/callback#fragment', 'http://169.254.169.254:24300/callback']) {
      expect(() => f.hooks.register(worldId, { url }), url).toThrow(/callback|Callback|URL|destination|loopback/i);
    }
    expect(() => f.hooks.register(worldId, { url: baseUrl + '/receiver', events: ['operation.*.*'] })).toThrow(expect.objectContaining({ code: 'invalid_webhook_events' }));
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
    expect(targetHits).toBe(0); expect(delivery.last_error).toBe('redirect_refused'); expect(delivery.last_status).toBe(307);
    serveHugeBody = true; f.hooks.retry(worldId, delivery.id); await f.hooks.deliverDue();
    delivery = f.hooks.deliveries(worldId).data[0]!;
    expect(delivery.response_excerpt!.length).toBe(128); expect(delivery.response_truncated).toBe(1); expect(targetHits).toBe(0);
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
    expect(delivery.status).toBe('retrying'); expect(delivery.last_error).toBe('delivery_timeout');
    f.hooks.retry(worldId, delivery.id);
    const pending = f.hooks.deliverDue(); await f.hooks.close(); await pending;
    delivery = f.hooks.deliveries(worldId).data[0]!;
    expect(delivery.status).toBe('retrying'); expect(delivery.last_error).toBe('service_stopping');
    await expect(f.hooks.deliverDue()).rejects.toMatchObject({ code: 'webhooks_closed' });
  } finally { await f.close(); await endpoint.close(); }
});

test('verification binds body, subscription, world, ID and timestamp and excludes secrets from audits', async () => {
  let captured: { headers: Headers; raw: string } | undefined;
  const endpoint = await receiver((req, res, raw) => { captured = { headers: new Headers(req.headers as HeadersInit), raw }; res.end('ok'); });
  let now = Date.now();
  const f = fixture({ allowedPorts: [endpoint.port], now: () => now });
  try {
    const sub = f.hooks.register(worldId, { url: endpoint.url }); f.emit(); await f.hooks.deliverDue();
    expect(captured).toBeTruthy(); const { headers, raw } = captured!;
    expect(f.hooks.verify(worldId, headers, raw).event.data.object.operation_id).toBe('op-17');
    expect(() => f.hooks.verify(worldId, headers, raw + ' ')).toThrow(expect.objectContaining({ code: 'invalid_webhook_body' }));
    expect(() => f.hooks.verify('other-world', headers, raw)).toThrow(expect.objectContaining({ code: 'webhook_subscription_not_found' }));
    const wrong = new Headers(headers); wrong.set('x-finance-world-signature', 'v1=' + '0'.repeat(64));
    expect(() => f.hooks.verify(worldId, wrong, raw)).toThrow(expect.objectContaining({ code: 'invalid_webhook_signature' }));
    const wrongId = new Headers(headers); wrongId.set('x-finance-world-delivery-id', 'delivery-from-another-event');
    expect(() => f.hooks.verify(worldId, wrongId, raw)).toThrow(expect.objectContaining({ code: 'invalid_webhook_identity' }));
    now += 301000; expect(() => f.hooks.verify(worldId, headers, raw)).toThrow(expect.objectContaining({ code: 'expired_webhook_signature' }));
    expect(!JSON.stringify(f.store.events(worldId, 0, 1000)).includes(sub.secret)).toBeTruthy();
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
    expect((await second.deliverDue()).attempted).toBe(0);
    acknowledge?.(); expect((await first).delivered).toBe(1);
    expect(received).toBe(1); expect(f.hooks.deliveries(worldId).data[0]!.attempts).toBe(1);
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
    for (const credential of [signingSecret, 'receiver-access-credential', 'receiver-client-credential']) expect(!serialized.includes(credential)).toBeTruthy();
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
    expect(a.data.map(row => row.world)).toStrictEqual([worldId]);
    expect(b.data.map(row => row.world)).toStrictEqual([secondWorld]);
    expect(same.data.map(row => row.id)).toStrictEqual(b.data.map(row => row.id));
    expect(observed).toStrictEqual([worldId, secondWorld]);
    expect(f.hooks.deliveries(secondWorld).data[0]!.status).toBe('delivered');
    expect(f.hooks.deliveries(secondWorld).data[0]!.attempts).toBe(1);
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
    expect(background.data[0]!.world).toBe(worldId);
    expect(scoped.data.map(row => row.world)).toStrictEqual([secondWorld]);
    expect(scoped.delivered).toBe(1);
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
    // Capture the rejection now; the shutdown below is what rejects it.
    const rejection = queued.then(() => undefined, (error: unknown) => error);
    await f.hooks.close(); await active;
    expect(await rejection).toMatchObject({ code: 'webhooks_closed' });
    expect(received).toBe(1);
    expect(f.hooks.deliveries(worldId).data[0]!.status).toBe('retrying');
    expect(f.hooks.deliveries(secondWorld).data[0]!.status).toBe('pending');
    expect(f.hooks.deliveries(secondWorld).data[0]!.attempts).toBe(0);
  } finally { await f.close(); await endpoint.close(); }
});

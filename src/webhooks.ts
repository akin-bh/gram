import { Store, ServiceError, canonical, hash, redact } from './store.ts';

export type WebhookOptions = {
  baseUrl: string;
  allowedPorts?: number[];
  timeoutMs?: number;
  maxAttempts?: number;
  baseRetryMs?: number;
  leaseMs?: number;
  maxResponseBytes?: number;
  signatureToleranceSeconds?: number;
  /** Testable wall clock. Business simulation time never controls delivery. */
  now?: () => number;
};
export type WebhookSubscriptionInput = { url: string; events?: string[]; signingStyle?: 'generic' | 'stripe' };
export type WebhookContext = { revision?: number; requestId?: string; actor?: string; idempotencyKey?: string };
export type WebhookEvent = { type: string; [key: string]: unknown };
export type WebhookEnvelope = {
  id: string;
  object: 'event';
  type: string;
  created: number;
  world_id: string;
  data: { object: WebhookEvent };
  context: { revision: number | null; actor: string; request_id: string | null };
};
type Subscription = {
  id: string; world: string; url: string; events: string; signing_secret: string;
  signing_style: 'generic' | 'stripe'; active: number; created_at: number;
};
type Delivery = {
  seq: number; id: string; world: string; event_id: string; subscription_id: string;
  status: 'pending' | 'inflight' | 'retrying' | 'delivered' | 'dead' | 'cancelled';
  attempts: number; cycle_attempts: number; max_attempts: number; next_attempt_at: number;
  lease_until: number | null; claim_owner: string | null; last_status: number | null;
  last_error: string | null; response_excerpt: string | null; response_truncated: number;
  created_at: number; updated_at: number; delivered_at: number | null;
};
type PublicDelivery = Omit<Delivery, 'claim_owner' | 'lease_until'> & { event: WebhookEnvelope; request_body: string; url: string };
type DeliveryResult = { attempted: number; delivered: number; failed: number; data: PublicDelivery[] };

const bounded = (value: number | undefined, fallback: number, min: number, max: number, label: string) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new ServiceError(400, 'invalid_webhook_option', `${label} must be an integer between ${min} and ${max}.`);
  return result;
};
const eventPattern = /^(?:\*|[a-z][a-z0-9_.-]{0,99}(?:\.\*)?)$/;
const eventType = /^[a-z][a-z0-9_.-]{0,99}$/;
const matches = (pattern: string, type: string) => pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)));
const signature = (secret: string, timestamp: number, raw: string) => new Bun.CryptoHasher('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');

/**
 * Transactional local webhook outbox. enqueue() is synchronous and deliberately
 * joins the caller's transaction, so events and economic effects commit together.
 * Delivery is at least once: receivers must deduplicate the stable delivery/event
 * IDs when an acknowledgement is lost. No claim promises exactly-once HTTP.
 */
export class Webhooks {
  private store: Store;
  private allowedPorts: Set<number>;
  private now: () => number;
  private timeoutMs: number;
  private maxAttempts: number;
  private baseRetryMs: number;
  private leaseMs: number;
  private maxResponseBytes: number;
  private signatureToleranceSeconds: number;
  private owner = crypto.randomUUID();
  private stopped = false;
  private pumping?: Promise<DeliveryResult>;
  private pumpingWorld?: string;
  private active = new Map<string, { controller: AbortController; subscription: string }>();

  constructor(store: Store, options: WebhookOptions) {
    this.store = store;
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port) throw new ServiceError(400, 'invalid_webhook_base_url', 'Webhooks require an explicit loopback HTTP service port.');
    this.allowedPorts = new Set([Number(base.port), ...(options.allowedPorts ?? [])]);
    for (const port of this.allowedPorts) bounded(port, 0, 1024, 65535, 'Allowed callback port');
    this.now = options.now ?? Date.now;
    this.timeoutMs = bounded(options.timeoutMs, 5000, 10, 30000, 'timeoutMs');
    this.maxAttempts = bounded(options.maxAttempts, 5, 1, 10, 'maxAttempts');
    this.baseRetryMs = bounded(options.baseRetryMs, 1000, 1, 60000, 'baseRetryMs');
    this.leaseMs = bounded(options.leaseMs, this.timeoutMs + 10000, this.timeoutMs + 1000, 120000, 'leaseMs');
    this.maxResponseBytes = bounded(options.maxResponseBytes, 4096, 32, 65536, 'maxResponseBytes');
    this.signatureToleranceSeconds = bounded(options.signatureToleranceSeconds, 300, 1, 900, 'signatureToleranceSeconds');
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions(
        id TEXT PRIMARY KEY, world TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL,
        signing_secret TEXT NOT NULL, signing_style TEXT NOT NULL, active INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS webhook_subscriptions_world ON webhook_subscriptions(world,active);
      CREATE TABLE IF NOT EXISTS webhook_events(
        id TEXT PRIMARY KEY, world TEXT NOT NULL, source_key TEXT NOT NULL, type TEXT NOT NULL,
        fingerprint TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(world,source_key)
      );
      CREATE TABLE IF NOT EXISTS webhook_deliveries(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, world TEXT NOT NULL,
        event_id TEXT NOT NULL, subscription_id TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, cycle_attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
        lease_until INTEGER, claim_owner TEXT, last_status INTEGER, last_error TEXT,
        response_excerpt TEXT, response_truncated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered_at INTEGER,
        UNIQUE(event_id,subscription_id)
      );
      CREATE INDEX IF NOT EXISTS webhook_delivery_due ON webhook_deliveries(status,next_attempt_at,lease_until);
      CREATE INDEX IF NOT EXISTS webhook_delivery_world ON webhook_deliveries(world,seq);
    `);
  }

  private assertOpen() { if (this.stopped) throw new ServiceError(503, 'webhooks_closed'); }
  private validateUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2000 || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}(?:\/|\?|$)/.test(value)) {
      throw new ServiceError(400, 'invalid_webhook_url', 'Use an explicitly allowlisted http://127.0.0.1:PORT callback.');
    }
    let url: URL;
    try { url = new URL(value); } catch { throw new ServiceError(400, 'invalid_webhook_url'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash || !this.allowedPorts.has(Number(url.port))) {
      throw new ServiceError(400, 'webhook_destination_not_allowed', 'Callback ports must be explicitly allowlisted; credentials, fragments, DNS names, and non-loopback hosts are forbidden.');
    }
    return url.href;
  }
  private publicSubscription(row: Subscription) {
    return { id: row.id, world: row.world, url: row.url, events: JSON.parse(row.events) as string[], signingStyle: row.signing_style, active: Boolean(row.active), created_at: new Date(row.created_at).toISOString(), clock: 'wall' };
  }
  private subscription(world: string, id: string): Subscription {
    const row = this.store.db.prepare('SELECT * FROM webhook_subscriptions WHERE id=? AND world=?').get(id, world) as Subscription | undefined;
    if (!row) throw new ServiceError(404, 'webhook_subscription_not_found');
    return row;
  }

  register(world: string, input: WebhookSubscriptionInput) {
    this.assertOpen(); this.store.world(world);
    const url = this.validateUrl(input?.url);
    const events = input.events ?? ['*'];
    if (!Array.isArray(events) || !events.length || events.length > 100 || events.some(e => typeof e !== 'string' || !eventPattern.test(e))) throw new ServiceError(400, 'invalid_webhook_events', 'Choose exact event names, a namespace such as refund.*, or *.');
    const signingStyle = input.signingStyle ?? 'generic';
    if (!['generic', 'stripe'].includes(signingStyle)) throw new ServiceError(400, 'invalid_webhook_signing_style');
    return this.store.transaction(() => {
      const count = this.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_subscriptions WHERE world=? AND active=1').get(world) as { n: number };
      if (count.n >= 100) throw new ServiceError(409, 'webhook_subscription_limit');
      const row: Subscription = { id: `whsub_${crypto.randomUUID()}`, world, url, events: JSON.stringify([...new Set(events)]), signing_secret: `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`, signing_style: signingStyle, active: 1, created_at: this.now() };
      this.store.db.prepare('INSERT INTO webhook_subscriptions(id,world,url,events,signing_secret,signing_style,active,created_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id, world, row.url, row.events, row.signing_secret, row.signing_style, row.active, row.created_at);
      this.store.audit(world, 'webhook.registered', this.publicSubscription(row));
      return { ...this.publicSubscription(row), secret: row.signing_secret, secret_note: 'Save this signing secret now. It is not returned by list or delivery APIs.' };
    });
  }

  list(world: string) {
    this.store.world(world);
    return (this.store.db.prepare('SELECT * FROM webhook_subscriptions WHERE world=? ORDER BY created_at,id').all(world) as Subscription[]).map(row => this.publicSubscription(row));
  }

  disable(world: string, id: string) {
    this.assertOpen(); const row = this.subscription(world, id);
    const result = this.store.transaction(() => {
      this.store.db.prepare('UPDATE webhook_subscriptions SET active=0 WHERE id=?').run(id);
      this.store.db.prepare("UPDATE webhook_deliveries SET status='cancelled',updated_at=?,last_error='subscription_disabled' WHERE subscription_id=? AND status IN ('pending','retrying')").run(this.now(), id);
      this.store.audit(world, 'webhook.disabled', { subscription_id: id });
      return { ...this.publicSubscription(row), active: false };
    });
    for (const job of this.active.values()) if (job.subscription === id) job.controller.abort(new Error('Subscription disabled.'));
    return result;
  }

  /** Call inside the same Store.once transaction that saves the changed world. */
  enqueue(world: string, events: WebhookEvent[], context: WebhookContext = {}): { event_ids: string[]; delivery_ids: string[] } {
    this.assertOpen();
    if (!this.store.db.inTransaction) return this.store.transaction(() => this.enqueue(world, events, context));
    this.store.world(world);
    if (!Array.isArray(events) || events.length > 10000) throw new ServiceError(400, 'invalid_webhook_event_batch');
    if (context.revision !== undefined && (!Number.isSafeInteger(context.revision) || context.revision < 1)) throw new ServiceError(400, 'invalid_webhook_revision');
    const source = context.revision !== undefined ? `revision:${context.revision}` : context.idempotencyKey ? `key:${context.idempotencyKey}` : context.requestId ? `request:${context.requestId}` : null;
    if (!source) throw new ServiceError(400, 'webhook_event_identity_required', 'Supply the world revision, idempotency key, or original request ID.');
    const subscriptions = this.store.db.prepare('SELECT * FROM webhook_subscriptions WHERE world=? AND active=1').all(world) as Subscription[];
    const ids: string[] = [], deliveryIds: string[] = [];
    for (const [index, event] of events.entries()) {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string' || !eventType.test(event.type)) throw new ServiceError(400, 'invalid_webhook_event_type');
      const data = redact(event) as WebhookEvent, fingerprint = hash(canonical(data)), sourceKey = `${source}:${index}`;
      const existing = this.store.db.prepare('SELECT id,fingerprint FROM webhook_events WHERE world=? AND source_key=?').get(world, sourceKey) as { id: string; fingerprint: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ServiceError(409, 'webhook_event_conflict', 'The same event identity cannot describe different facts.');
        ids.push(existing.id);
        deliveryIds.push(...(this.store.db.prepare('SELECT id FROM webhook_deliveries WHERE event_id=? ORDER BY seq').all(existing.id) as { id: string }[]).map(row => row.id));
        continue;
      }
      const id = `evt_${hash(`${world}\0${sourceKey}`).slice(0, 40)}`, now = this.now();
      const envelope: WebhookEnvelope = { id, object: 'event', type: event.type, created: Math.floor(now / 1000), world_id: world, data: { object: data }, context: { revision: context.revision ?? null, actor: context.actor ?? 'system', request_id: context.requestId ?? null } };
      const body = canonical(envelope);
      if (Buffer.byteLength(body) > 1_048_576) throw new ServiceError(413, 'webhook_event_too_large');
      this.store.db.prepare('INSERT INTO webhook_events(id,world,source_key,type,fingerprint,body,created_at) VALUES(?,?,?,?,?,?,?)').run(id, world, sourceKey, event.type, fingerprint, body, now);
      ids.push(id);
      for (const sub of subscriptions) {
        if (!(JSON.parse(sub.events) as string[]).some(pattern => matches(pattern, event.type))) continue;
        const deliveryId = `whd_${hash(`${id}\0${sub.id}`).slice(0, 40)}`;
        this.store.db.prepare("INSERT INTO webhook_deliveries(id,world,event_id,subscription_id,status,max_attempts,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?,?)").run(deliveryId, world, id, sub.id, this.maxAttempts, now, now, now);
        deliveryIds.push(deliveryId);
        this.store.audit(world, 'webhook.queued', { event_id: id, delivery_id: deliveryId, subscription_id: sub.id, event_type: event.type, body_sha256: hash(body) }, context.actor, context.requestId);
      }
    }
    return { event_ids: ids, delivery_ids: deliveryIds };
  }

  deliveries(world: string, options: { after?: number; limit?: number; status?: string } = {}) {
    this.store.world(world);
    const after = bounded(options.after, 0, 0, Number.MAX_SAFE_INTEGER, 'after'), limit = bounded(options.limit, 50, 1, 200, 'limit');
    const states = ['pending', 'inflight', 'retrying', 'delivered', 'dead', 'cancelled'];
    if (options.status && !states.includes(options.status)) throw new ServiceError(400, 'invalid_webhook_status');
    const rows = options.status
      ? this.store.db.prepare('SELECT * FROM webhook_deliveries WHERE world=? AND seq>? AND status=? ORDER BY seq LIMIT ?').all(world, after, options.status, limit) as Delivery[]
      : this.store.db.prepare('SELECT * FROM webhook_deliveries WHERE world=? AND seq>? ORDER BY seq LIMIT ?').all(world, after, limit) as Delivery[];
    const data = rows.map(row => this.publicDelivery(row));
    return { data, next_cursor: rows.length === limit ? rows.at(-1)!.seq : null };
  }

  /** Latest bounded window in chronological order; cursor pagination stays in deliveries(). */
  recent(world: string, limit = 50) {
    this.store.world(world);
    const count = bounded(limit, 50, 1, 200, 'limit');
    const rows = this.store.db.prepare('SELECT * FROM webhook_deliveries WHERE world=? ORDER BY seq DESC LIMIT ?').all(world, count) as Delivery[];
    return { data: rows.reverse().map(row => this.publicDelivery(row)), next_cursor: null };
  }

  private publicDelivery(row: Delivery): PublicDelivery {
    const event = this.store.db.prepare('SELECT body FROM webhook_events WHERE id=?').get(row.event_id) as { body: string };
    const sub = this.subscription(row.world, row.subscription_id);
    const { claim_owner: _owner, lease_until: _lease, ...rest } = row;
    return { ...rest, event: JSON.parse(event.body), request_body: event.body, url: sub.url };
  }

  retry(world: string, id: string) {
    this.assertOpen();
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM webhook_deliveries WHERE world=? AND id=?').get(world, id) as Delivery | undefined;
      if (!row) throw new ServiceError(404, 'webhook_delivery_not_found');
      if (!this.subscription(world, row.subscription_id).active) throw new ServiceError(409, 'webhook_subscription_disabled');
      if (row.status === 'inflight' && (row.lease_until ?? 0) > this.now()) throw new ServiceError(409, 'webhook_delivery_inflight');
      this.store.db.prepare("UPDATE webhook_deliveries SET status='pending',cycle_attempts=0,next_attempt_at=?,lease_until=NULL,claim_owner=NULL,updated_at=? WHERE id=?").run(this.now(), this.now(), id);
      this.store.audit(world, 'webhook.retry_requested', { delivery_id: id, event_id: row.event_id, previous_status: row.status, prior_attempts: row.attempts });
      return this.publicDelivery(this.store.db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(id) as Delivery);
    });
  }

  verify(world: string, headers: Headers, raw: string): { event: WebhookEnvelope; event_id: string; delivery_id: string; subscription_id: string; timestamp: number } {
    const subId = headers.get('x-finance-world-subscription-id') ?? '', deliveryId = headers.get('x-finance-world-delivery-id') ?? '', eventId = headers.get('x-finance-world-event-id') ?? '';
    const sub = this.subscription(world, subId);
    if (!sub.active) throw new ServiceError(401, 'webhook_subscription_disabled');
    const row = this.store.db.prepare('SELECT * FROM webhook_deliveries WHERE id=? AND world=? AND subscription_id=? AND event_id=?').get(deliveryId, world, subId, eventId) as Delivery | undefined;
    if (!row) throw new ServiceError(401, 'invalid_webhook_identity');
    const stored = this.store.db.prepare('SELECT body FROM webhook_events WHERE id=?').get(eventId) as { body: string };
    if (Buffer.byteLength(raw) > 1_048_576 || raw !== stored.body) throw new ServiceError(401, 'invalid_webhook_body');
    const stripeParts = (headers.get('stripe-signature') ?? '').split(',');
    const stripeTime = stripeParts.find(part => part.startsWith('t='))?.slice(2);
    const timestampText = headers.get('x-finance-world-timestamp') ?? stripeTime ?? '';
    if (!/^\d{1,12}$/.test(timestampText)) throw new ServiceError(401, 'invalid_webhook_timestamp');
    const timestamp = Number(timestampText);
    if (Math.abs(Math.floor(this.now() / 1000) - timestamp) > this.signatureToleranceSeconds || (stripeTime && stripeTime !== timestampText)) throw new ServiceError(401, 'expired_webhook_signature');
    const generic = headers.get('x-finance-world-signature');
    const signatures = generic ? [generic.replace(/^v1=/, '')] : stripeParts.filter(part => part.startsWith('v1=')).map(part => part.slice(3));
    const expected = Buffer.from(signature(sub.signing_secret, timestamp, raw), 'hex');
    if (!signatures.some(candidate => /^[a-f0-9]{64}$/i.test(candidate) && crypto.timingSafeEqual(expected, Buffer.from(candidate, 'hex')))) throw new ServiceError(401, 'invalid_webhook_signature');
    const event = JSON.parse(raw) as WebhookEnvelope;
    return { event, event_id: eventId, delivery_id: deliveryId, subscription_id: subId, timestamp };
  }

  private claim(world?: string): Delivery | undefined {
    return this.store.transaction(() => {
      const now = this.now();
      // A process can die after the receiver accepts but before it records the
      // acknowledgement. Lease expiry makes that same delivery eligible again.
      const condition = "((status IN ('pending','retrying') AND next_attempt_at<=?) OR (status='inflight' AND lease_until<=?))";
      const rows = (world
        ? this.store.db.prepare(`SELECT * FROM webhook_deliveries WHERE world=? AND ${condition} ORDER BY seq LIMIT 100`).all(world, now, now)
        : this.store.db.prepare(`SELECT * FROM webhook_deliveries WHERE ${condition} ORDER BY seq LIMIT 100`).all(now, now)) as Delivery[];
      for (const row of rows) {
        if (!this.subscription(row.world, row.subscription_id).active) {
          this.store.db.prepare("UPDATE webhook_deliveries SET status='cancelled',updated_at=?,last_error='subscription_disabled',lease_until=NULL,claim_owner=NULL WHERE id=?").run(now, row.id); continue;
        }
        if (row.cycle_attempts >= row.max_attempts) {
          this.store.db.prepare("UPDATE webhook_deliveries SET status='dead',updated_at=?,last_error='attempt_limit_after_lost_acknowledgement',lease_until=NULL,claim_owner=NULL WHERE id=?").run(now, row.id);
          this.store.audit(row.world, 'webhook.dead_letter', { delivery_id: row.id, event_id: row.event_id, attempts: row.attempts, reason: 'Unacknowledged final attempt; explicit retry required.' }); continue;
        }
        this.store.db.prepare("UPDATE webhook_deliveries SET status='inflight',attempts=attempts+1,cycle_attempts=cycle_attempts+1,lease_until=?,claim_owner=?,updated_at=? WHERE id=?").run(now + this.leaseMs, this.owner, now, row.id);
        this.store.audit(row.world, 'webhook.attempt_started', { delivery_id: row.id, event_id: row.event_id, subscription_id: row.subscription_id, attempt: row.attempts + 1, lease_recovered: row.status === 'inflight' });
        return this.store.db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(row.id) as Delivery;
      }
      return undefined;
    });
  }

  async deliverDue(world?: string, options: { limit?: number } = {}): Promise<DeliveryResult> {
    this.assertOpen();
    if (world) this.store.world(world);
    const limit = bounded(options.limit, 20, 1, 100, 'limit');
    if (this.pumping) {
      // Background polls may join any current batch, and identical scoped polls
      // may share it. A different world's management request must run its own
      // batch: returning another world's result would falsely report delivery.
      if (world === undefined || this.pumpingWorld === world) return this.pumping;
      await this.pumping;
      this.assertOpen();
      return this.deliverDue(world, options);
    }
    const run = async () => {
      const data: PublicDelivery[] = [];
      while (!this.stopped && data.length < limit) {
        const row = this.claim(world); if (!row) break;
        data.push(await this.deliver(row));
      }
      return { attempted: data.length, delivered: data.filter(row => row.status === 'delivered').length, failed: data.filter(row => row.status !== 'delivered').length, data };
    };
    this.pumpingWorld = world;
    const pumping = run();
    this.pumping = pumping;
    try { return await pumping; }
    finally { if (this.pumping === pumping) { this.pumping = undefined; this.pumpingWorld = undefined; } }
  }

  private async deliver(row: Delivery): Promise<PublicDelivery> {
    const sub = this.subscription(row.world, row.subscription_id), stored = this.store.db.prepare('SELECT body FROM webhook_events WHERE id=?').get(row.event_id) as { body: string };
    const controller = new AbortController();
    this.active.set(row.id, { controller, subscription: row.subscription_id });
    const timestamp = Math.floor(this.now() / 1000), digest = signature(sub.signing_secret, timestamp, stored.body);
    let status: number | null = null, error: string | null = null, excerpt = '', truncated = false, retryAfterMs = 0;
    const started = this.now();
    const timer = setTimeout(() => controller.abort(new Error('Webhook delivery timeout.')), this.timeoutMs); timer.unref();
    try {
      this.validateUrl(sub.url); // Recheck persisted destinations after configuration changes.
      const response = await fetch(sub.url, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: {
          'Content-Type': 'application/json', 'User-Agent': 'finance-world-webhooks/0.1.0',
          'X-Finance-World-Subscription-Id': sub.id, 'X-Finance-World-Event-Id': row.event_id,
          'X-Finance-World-Delivery-Id': row.id, 'X-Finance-World-Timestamp': String(timestamp),
          'X-Finance-World-Signature': `v1=${digest}`,
          ...(sub.signing_style === 'stripe' ? { 'Stripe-Signature': `t=${timestamp},v1=${digest}` } : {}),
        }, body: stored.body,
      });
      status = response.status;
      const retry = response.headers.get('retry-after');
      if (retry && /^\d+$/.test(retry)) retryAfterMs = Math.min(Number(retry) * 1000, 900000);
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      if (reader) {
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break;
            const remaining = this.maxResponseBytes - bytes;
            chunks.push(next.value.subarray(0, Math.max(remaining, 0))); bytes += Math.min(next.value.byteLength, Math.max(remaining, 0));
            if (next.value.byteLength > remaining || bytes === this.maxResponseBytes) { truncated = true; await reader.cancel(); break; }
          }
        } finally { reader.releaseLock(); }
      }
      excerpt = Buffer.concat(chunks).toString('utf8').split(sub.signing_secret).join('[REDACTED]');
      excerpt = redact(excerpt);
      try { excerpt = JSON.stringify(redact(JSON.parse(excerpt))); } catch { /* Plain text or capped response. */ }
      if (!response.ok) error = status >= 300 && status < 400 ? 'redirect_refused' : `http_${status}`;
    } catch (caught) {
      error = controller.signal.aborted ? this.stopped ? 'service_stopping' : !this.subscription(row.world, row.subscription_id).active ? 'subscription_disabled' : 'delivery_timeout' : caught instanceof ServiceError ? caught.code : 'network_error';
    } finally { clearTimeout(timer); this.active.delete(row.id); }
    return this.store.transaction(() => {
      const current = this.store.db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(row.id) as Delivery;
      if (current.claim_owner !== this.owner || current.status !== 'inflight') return this.publicDelivery(current);
      const now = this.now(), active = this.subscription(row.world, row.subscription_id).active;
      const nextStatus = !active ? 'cancelled' : !error ? 'delivered' : row.cycle_attempts >= row.max_attempts ? 'dead' : 'retrying';
      const delay = Math.max(Math.min(this.baseRetryMs * 2 ** Math.max(row.cycle_attempts - 1, 0), 60000), retryAfterMs);
      this.store.db.prepare('UPDATE webhook_deliveries SET status=?,next_attempt_at=?,lease_until=NULL,claim_owner=NULL,last_status=?,last_error=?,response_excerpt=?,response_truncated=?,updated_at=?,delivered_at=? WHERE id=?').run(nextStatus, this.stopped ? now : now + delay, status, error, excerpt, truncated ? 1 : 0, now, nextStatus === 'delivered' ? now : current.delivered_at, row.id);
      this.store.audit(row.world, nextStatus === 'delivered' ? 'webhook.delivered' : nextStatus === 'dead' ? 'webhook.dead_letter' : 'webhook.delivery_failed', { delivery_id: row.id, event_id: row.event_id, subscription_id: sub.id, attempt: row.attempts, status_code: status, status: nextStatus, error, response_excerpt: excerpt, response_truncated: truncated, duration_ms: Math.max(0, now - started), next_attempt_at: nextStatus === 'retrying' ? new Date(this.stopped ? now : now + delay).toISOString() : null });
      return this.publicDelivery(this.store.db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(row.id) as Delivery);
    });
  }

  async close() {
    this.stopped = true;
    for (const job of this.active.values()) job.controller.abort(new Error('Webhook service stopping.'));
    if (this.pumping) await this.pumping;
  }
}

import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const hash = (value: string|Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
export const secret = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret|code[_-]?verifier|token|(?:[a-z0-9]+[_-])*api[_-]?key|password|secret)$/i;
export function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, (sensitive.test(k) || (k === 'code' && (/^[a-f0-9]{64}$/i.test(String(v)) || 'code_verifier' in value || 'state' in value || value.grant_type === 'authorization_code'))) ? '[REDACTED]' : redact(v)]));
  return typeof value === 'string' ? value.replace(/AIza[A-Za-z0-9_-]{20,}|sk-ant-[a-zA-Z0-9_-]+/g, '[REDACTED]') : value;
}
export class ServiceError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message = code) { super(message); this.status = status; this.code = code; }
}
export type AuditQuery = { order: 'asc' | 'desc'; after?: number; before?: number; snapshot?: number; limit: number; scope: 'all' | 'activity' | 'errors'; q?: string };
const auditFailureType = /(?:^|[._])(failed|failure|error|denied|blocked|rejected|interrupted|dead_letter)$/;
function auditInScope(event: any, scope: string) {
  const data = event.data ?? {};
  const failedStatus = (status: unknown) => typeof status === 'number' ? status >= 400 : ['failed', 'blocked', 'rejected', 'denied', 'dead', 'interrupted'].includes(String(status));
  const failure = auditFailureType.test(event.type) || auditFailureType.test(data.type ?? '')
    || failedStatus(data.status) || failedStatus(data.status_code)
    || ['reject', 'rejected', 'deny', 'denied'].includes(data.decision)
    || Boolean(data.error) || data.is_error === true;
  if (scope === 'errors') return failure;
  const successfulRead = event.type === 'http.request' && ['GET', 'HEAD'].includes(data.method) && data.status >= 200 && data.status < 400;
  return failure || (event.type !== 'agent.trace' && !successfulRead);
}
export class Store {
  db: Database;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename, { strict: true });
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS worlds(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, world TEXT NOT NULL, value TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_world ON audit(world,seq);
      CREATE TABLE IF NOT EXISTS idempotency(world TEXT NOT NULL, actor TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(world,actor,key));
      CREATE TABLE IF NOT EXISTS kv(namespace TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,id));`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  world<T = any>(id: string): T {
    const row = this.db.prepare('SELECT value FROM worlds WHERE id=?').get(id) as any;
    if (!row) throw new ServiceError(404, 'world_not_found');
    return JSON.parse(row.value);
  }
  worlds(): any[] { return (this.db.prepare('SELECT value FROM worlds ORDER BY rowid DESC').all() as any[]).map(r => JSON.parse(r.value)); }
  save(world: any) { this.db.prepare('INSERT INTO worlds(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(world.id, JSON.stringify(world)); }
  get<T = any>(namespace: string, id: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE namespace=? AND id=?').get(namespace, id) as any;
    return r ? JSON.parse(r.value) : undefined;
  }
  put(namespace: string, id: string, value: any) { this.db.prepare('INSERT INTO kv(namespace,id,value) VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET value=excluded.value').run(namespace, id, JSON.stringify(value)); }
  delete(namespace: string, id: string) { this.db.prepare('DELETE FROM kv WHERE namespace=? AND id=?').run(namespace, id); }
  all<T = any>(namespace: string): T[] { return (this.db.prepare('SELECT value FROM kv WHERE namespace=? ORDER BY rowid').all(namespace) as any[]).map(r => JSON.parse(r.value)); }
  audit(world: string, type: string, data: any, actor = 'system', requestId?: string) {
    const previous = this.db.prepare('SELECT hash FROM audit WHERE world=? ORDER BY seq DESC LIMIT 1').get(world) as any;
    const previous_hash = previous?.hash ?? '0'.repeat(64);
    const value = { world_id: world, type, actor, at: new Date().toISOString(), request_id: requestId ?? null, data: redact(data) };
    const digest = hash(previous_hash + '\n' + canonical(value));
    const inserted = this.db.prepare('INSERT INTO audit(world,value,previous_hash,hash) VALUES(?,?,?,?)').run(world, JSON.stringify(value), previous_hash, digest);
    return { ...value, seq: Number(inserted.lastInsertRowid), previous_hash, hash: digest };
  }
  events(world: string, after = 0, limit = 200): any[] {
    return (this.db.prepare('SELECT * FROM audit WHERE world=? AND seq>? ORDER BY seq LIMIT ?').all(world, after, limit) as any[])
      .map(r => ({ ...JSON.parse(r.value), seq: r.seq, previous_hash: r.previous_hash, hash: r.hash }));
  }
  queryEvents(world: string, query: AuditQuery) {
    const head = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM audit WHERE world=?').get(world) as any).seq);
    const snapshot = Math.min(query.snapshot ?? head, head);
    const descending = query.order === 'desc', term = query.q?.toLowerCase(), matches: any[] = [];
    let cursor = descending ? query.before : query.after ?? 0;
    // Scan indexed keyset batches so filtering precedes pagination without loading
    // the whole audit. JavaScript case folding also handles Unicode search text.
    while (matches.length <= query.limit) {
      const where = ['world=?', 'seq<=?'], params: (string | number)[] = [world, snapshot];
      if (cursor !== undefined) { where.push(descending ? 'seq<?' : 'seq>?'); params.push(cursor); }
      const batch = this.db.prepare(`SELECT * FROM audit WHERE ${where.join(' AND ')} ORDER BY seq ${descending ? 'DESC' : 'ASC'} LIMIT 64`).all(...params) as any[];
      for (const row of batch) {
        if (term && !row.value.toLowerCase().includes(term)) continue;
        const event = JSON.parse(row.value);
        if (query.scope !== 'all' && !auditInScope(event, query.scope)) continue;
        matches.push({ ...event, seq: row.seq, previous_hash: row.previous_hash, hash: row.hash });
        if (matches.length > query.limit) break;
      }
      if (batch.length < 64) break;
      cursor = batch.at(-1).seq;
    }
    const data = matches.slice(0, query.limit);
    return { data, next_cursor: matches.length > query.limit ? String(data.at(-1).seq) : null, head_seq: head, snapshot_seq: snapshot };
  }
  event(world: string, seq: number) {
    const row = this.db.prepare('SELECT * FROM audit WHERE world=? AND seq=?').get(world, seq) as any;
    if (!row) throw new ServiceError(404, 'audit_event_not_found');
    return { ...JSON.parse(row.value), seq: row.seq, previous_hash: row.previous_hash, hash: row.hash };
  }
  verify(world: string) {
    const rows = this.db.prepare('SELECT * FROM audit WHERE world=? ORDER BY seq').all(world) as any[];
    let previous = '0'.repeat(64);
    for (const row of rows) {
      if (row.previous_hash !== previous || row.hash !== hash(previous + '\n' + canonical(JSON.parse(row.value)))) return { valid: false, checked: rows.length, broken_at: row.seq };
      previous = row.hash;
    }
    return { valid: true, checked: rows.length, head: previous, note: 'Local hash chain; externally anchor the head to detect a full database rewrite.' };
  }
  replay(world:string,actor:string,key:string,input:any){
    if(!key||key.length>200)throw new ServiceError(400,'idempotency_key_required');
    const old=this.db.prepare('SELECT * FROM idempotency WHERE world=? AND actor=? AND key=?').get(world,actor,key) as any;
    if(!old)return undefined;
    if(old.fingerprint!==hash(canonical(input)))throw new ServiceError(409,'idempotency_conflict','Use the original key only for the original request.');
    return {...JSON.parse(old.value),replayed:true};
  }
  once(world: string, actor: string, key: string, input: any, fn: () => any) {
    return this.transaction(() => {
      const replay=this.replay(world,actor,key,input);if(replay)return replay;
      const value = fn();
      this.db.prepare('INSERT INTO idempotency(world,actor,key,fingerprint,value) VALUES(?,?,?,?,?)').run(world, actor, key, hash(canonical(input)), JSON.stringify(value));
      return value;
    });
  }
  close() { this.db.close(); }
}

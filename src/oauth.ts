import { Store, ServiceError, hash, secret } from './store.ts';

export type Actor = { id: string; role: 'controller' | 'agent' | 'operator' | 'accountant' | 'system'; world?: string; system?: string; scopes?: string[]; runId?: string };
export type Grant = { id: string; family: string; world: string; system: string; client_id: string; actor: string; scopes: string[]; expires_at: number; refresh_expires_at: number; revoked: boolean; access_hash: string; refresh_hash: string };
const time = () => Date.now();
const fail = (code: string, message = code) => { throw new ServiceError(400, code, message); };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export class OAuth {
  store: Store; baseUrl: string; systems: { id: string; name: string }[];
  constructor(store: Store, baseUrl: string, systems: { id: string; name: string }[]) {
    this.store = store; this.baseUrl = baseUrl; this.systems = systems;
    store.put('clients', 'finance-world-console', { id: 'finance-world-console', name: 'gram console', redirect_uris: [baseUrl + '/oauth/callback'] });
  }
  system(id: string) { const s = this.systems.find(s => s.id === id); if (!s) throw new ServiceError(404, 'unknown_system'); return s; }
  register(input: any) {
    if (!input || typeof input.name !== 'string' || !Array.isArray(input.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 5) fail('invalid_client');
    for (const uri of input.redirect_uris) {
      let u: URL; try { u = new URL(uri); } catch { return fail('invalid_redirect_uri'); }
      if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.hash) fail('invalid_redirect_uri', 'Register an exact loopback HTTP callback.');
    }
    const client = { id: 'client-' + crypto.randomUUID(), name: input.name.slice(0, 120), redirect_uris: input.redirect_uris };
    this.store.put('clients', client.id, client);
    return { client_id: client.id, client_name: client.name, redirect_uris: client.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] };
  }
  start(world: string, system: string, session: string) {
    this.system(system); this.store.world(world);
    const state = secret(), verifier = secret();
    this.store.put('pending-oauth', hash(state), { world, system, session, verifier, expires_at: time() + 600_000 });
    const u = new URL(`${this.baseUrl}/oauth/${system}/authorize`);
    const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
    u.search = new URLSearchParams({ client_id: 'finance-world-console', redirect_uri: this.baseUrl + '/oauth/callback', response_type: 'code', scope: 'read write', state, world_id: world, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    this.store.audit(world, 'oauth.started', { system }, 'controller');
    return { authorization_url: u.href };
  }
  parameters(system: string, params: URLSearchParams) {
    this.system(system);
    const client_id = params.get('client_id') ?? '', redirect_uri = params.get('redirect_uri') ?? '';
    const client = this.store.get('clients', client_id);
    if (!client || !client.redirect_uris.includes(redirect_uri)) fail('invalid_client_or_redirect');
    if (params.get('response_type') !== 'code') fail('unsupported_response_type');
    const challenge = params.get('code_challenge') ?? '';
    if (params.get('code_challenge_method') !== 'S256' || !/^[a-zA-Z0-9_-]{43}$/.test(challenge)) fail('pkce_required', 'An S256 PKCE challenge is required.');
    const state = params.get('state') ?? ''; if (!state || state.length > 500) fail('state_required');
    const scopes = [...new Set((params.get('scope') ?? 'read').split(' ').filter(Boolean))];
    if (!scopes.length || scopes.some(s => !['read', 'write'].includes(s))) fail('invalid_scope');
    const world = params.get('world_id') ?? ''; this.store.world(world);
    return { client_id, redirect_uri, challenge, state, scopes, world, client };
  }
  consent(system: string, params: URLSearchParams) {
    const p = this.parameters(system, params);
    return { provider: this.system(system), company: this.store.world(p.world).name, world: p.world, client: p.client.name, scopes: p.scopes };
  }
  async consentPage(system: string, params: URLSearchParams) {
    this.parameters(system, params);
    return (await Bun.file(new URL('../web/index.html', import.meta.url)).text()).replace(/<title>[^<]*<\/title>/, '<title>Allow connection · gram</title>');
  }
  authorize(system: string, params: URLSearchParams, actor: Actor) {
    const p = this.parameters(system, params), redirect = new URL(p.redirect_uri);
    redirect.searchParams.set('state', p.state);
    if (params.get('decision') !== 'allow') {
      redirect.searchParams.set('error', 'access_denied');
      this.store.audit(p.world, 'oauth.denied', { system, client_id: p.client_id }, actor.id);
    } else {
      const code = secret();
      this.store.put('codes', hash(code), { ...p, client: undefined, actor: actor.id, system, expires_at: time() + 120_000 });
      redirect.searchParams.set('code', code);
      this.store.audit(p.world, 'oauth.consent', { system, client_id: p.client_id, scopes: p.scopes }, actor.id);
    }
    return redirect.href;
  }
  mint(data: { world: string; system: string; client_id: string; actor: string; scopes: string[]; family?: string }) {
    const access = secret(), refresh = secret();
    const grant: Grant = { ...data, id: crypto.randomUUID(), family: data.family ?? crypto.randomUUID(), expires_at: time() + 3600_000, refresh_expires_at: time() + 30 * 86400_000, revoked: false, access_hash: hash(access), refresh_hash: hash(refresh) };
    this.store.put('grants', grant.id, grant);
    this.store.put('access', grant.access_hash, { grant: grant.id });
    this.store.put('refresh', grant.refresh_hash, { grant: grant.id });
    this.store.put('connections', `${data.world}:${data.system}`, { world: data.world, system: data.system, grant: grant.id, family: grant.family, connected_at: time() });
    const world = this.store.world(data.world);
    if (world.faults?.[data.system]?.mode === 'expired') {
      world.faults[data.system] = { mode: 'healthy', since: world.now }; world.revision++; this.store.save(world);
      this.store.audit(data.world, 'oauth.expired_connection_recovered', { system: data.system }, data.actor);
    }
    this.store.audit(data.world, 'oauth.token_issued', { system: data.system, scopes: data.scopes, grant_id: grant.id, expires_at: grant.expires_at }, data.actor);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: data.scopes.join(' ') };
  }
  token(system: string, input: Record<string, string>) {
    this.system(system);
    return this.store.transaction(() => {
      if (input.grant_type === 'authorization_code') {
        const p = this.store.get('codes', hash(input.code ?? ''));
        if (!p || p.expires_at < time() || p.system !== system || input.client_id !== p.client_id || input.redirect_uri !== p.redirect_uri) fail('invalid_grant');
        if (!/^[a-zA-Z0-9._~-]{43,128}$/.test(input.code_verifier ?? '') || new Bun.CryptoHasher('sha256').update(input.code_verifier).digest('base64url') !== p.challenge) fail('invalid_grant', 'PKCE verifier does not match.');
        this.store.delete('codes', hash(input.code));
        return this.mint({ world: p.world, system, client_id: p.client_id, actor: p.actor, scopes: p.scopes });
      }
      if (input.grant_type === 'refresh_token') {
        const entry = this.store.get('refresh', hash(input.refresh_token ?? '')), grant = entry && this.store.get<Grant>('grants', entry.grant);
        if (!grant || grant.system !== system || grant.client_id !== input.client_id || grant.revoked || grant.refresh_expires_at < time()) fail('invalid_grant');
        grant.revoked = true; this.store.put('grants', grant.id, grant);
        return this.mint({ world: grant.world, system, client_id: grant.client_id, actor: grant.actor, scopes: grant.scopes, family: grant.family });
      }
      return fail('unsupported_grant_type');
    });
  }
  callback(params: URLSearchParams, session: string) {
    const state = params.get('state') ?? '', pending = this.store.get('pending-oauth', hash(state));
    if (!pending || pending.session !== session || pending.expires_at < time()) fail('invalid_state');
    this.store.delete('pending-oauth', hash(state));
    if (params.get('error')) return `${this.baseUrl}/?world=${encodeURIComponent(pending.world)}&oauth_error=access_denied`;
    this.token(pending.system, { grant_type: 'authorization_code', client_id: 'finance-world-console', redirect_uri: this.baseUrl + '/oauth/callback', code: params.get('code') ?? '', code_verifier: pending.verifier });
    return `${this.baseUrl}/?world=${encodeURIComponent(pending.world)}&connected=${encodeURIComponent(pending.system)}`;
  }
  bearer(token: string): Actor | undefined {
    const entry = this.store.get('access', hash(token)), grant = entry && this.store.get<Grant>('grants', entry.grant);
    if (!grant || grant.revoked || grant.expires_at < time()) return;
    return { id: `oauth:${grant.client_id}`, role: 'operator', world: grant.world, system: grant.system, scopes: grant.scopes };
  }
  connections(world: string) {
    const faults = this.store.world(world).faults ?? {};
    return this.systems.map(s => {
      const c = this.store.get('connections', `${world}:${s.id}`), grant = c && this.store.get<Grant>('grants', c.grant);
      return { system: s.id, name: s.name, provider_status: faults[s.id]?.mode ?? 'healthy', expires_at_clock: 'wall', oauth_status: !grant || grant.revoked ? 'disconnected' : grant.expires_at < time() ? 'expired' : 'connected', status: !grant || grant.revoked ? 'disconnected' : grant.expires_at < time() ? 'expired' : 'connected', scopes: grant?.scopes ?? [], expires_at: grant ? new Date(grant.expires_at).toISOString() : null, connected_at: c ? new Date(c.connected_at).toISOString() : null };
    });
  }
  require(world: string, system: string, scope: string, actor: Actor) {
    this.system(system);
    if (actor.world && actor.world !== world) throw new ServiceError(403, 'world_scope_mismatch');
    if (actor.system) {
      if (actor.system !== system || !actor.scopes?.includes(scope)) throw new ServiceError(403, 'insufficient_scope');
    } else {
      const c = this.connections(world).find(c => c.system === system)!;
      if (c.status !== 'connected') throw new ServiceError(401, 'connection_required', `Connect ${system} using OAuth before accessing its API.`);
      if (!c.scopes.includes(scope)) throw new ServiceError(403, 'insufficient_scope');
    }
    const fault = this.store.world(world).faults?.[system];
    const mode = typeof fault === 'string' ? fault : fault?.mode;
    if (mode === 'offline') throw new ServiceError(503, 'provider_offline', `${system} is disconnected by the scenario.`);
    if (mode === 'rate_limit') throw new ServiceError(429, 'provider_rate_limit', `${system} is rate limited.`);
    if (mode === 'expired') throw new ServiceError(401, 'provider_token_expired', `Reconnect ${system} using OAuth.`);
  }
  revoke(world: string, system: string) {
    this.system(system);
    for (const grant of this.store.all<Grant>('grants')) if (grant.world === world && grant.system === system) { grant.revoked = true; this.store.put('grants', grant.id, grant); }
    this.store.audit(world, 'oauth.revoked', { system }, 'controller');
    return { system, status: 'disconnected' };
  }
  revokeToken(system: string, input: Record<string, string>) {
    const digest = hash(input.token ?? ''), entry = this.store.get('access', digest) ?? this.store.get('refresh', digest), grant = entry && this.store.get<Grant>('grants', entry.grant);
    if (grant && grant.system === system && input.client_id === grant.client_id) {
      for (const related of this.store.all<Grant>('grants')) if (related.family === grant.family) { related.revoked = true; this.store.put('grants', related.id, related); }
      this.store.audit(grant.world, 'oauth.revoked', { system, client_id: grant.client_id }, grant.actor);
    }
    return {};
  }
}

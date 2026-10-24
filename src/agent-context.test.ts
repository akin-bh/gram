import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {AGENT_CONTEXT_MAX_BYTES, buildAgentContextOverview, buildAgentProviderContext} from './agent-context.ts';
import type {AgentContextInput} from './agent-context.ts';
import {agentContextPath, agentContextRequestSchema} from './agent.ts';
import {actionRequirements, createWorld, DomainError, systemCatalog} from './world.ts';
import {providerContracts} from './provider-contracts.ts';
import {manualJournalSystems} from './manual-journals.ts';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const clock = '2026-10-24T09:00:00.000Z';
const fixture = (): AgentContextInput => ({
  world: {id: 'context-world', name: 'Cedar', kind: 'supplier-fraud', now: clock, revision: 42},
  systems: structuredClone(systemCatalog),
  providerContracts: structuredClone(providerContracts),
  connections: systemCatalog.map(system => ({
    system: system.id, oauth_status: 'connected', provider_status: 'healthy', scopes: ['read', 'write'],
    expires_at: '2026-10-24T10:00:00.000Z', expires_at_clock: 'wall', connected_at: clock,
  })),
  actionProviders: {refund: 'stripe', pay_bill: 'mercury', collect_invoice: 'stripe', post_journal: 'netsuite', send_email: 'gmail',
    ...Object.fromEntries(Object.entries(actionRequirements).filter(([, entry]) => entry.role === 'operator' && !entry.internal).map(([name, entry]) => [name, entry.system]))},
  actionProviderOptions: {prepare_manual_journal: [...manualJournalSystems], submit_manual_journal: [...manualJournalSystems]},
  wallNow: '2026-10-24T10:37:00.000Z',
  mandate: 'Read original provider records before effects. Independent controller approval is required where specified. Pending is not settled. OAuth expires on wall time; settlement follows simulation time. Use native account currency minor units and functional USD cents for the ledger.',
});
function rejects(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, error => error instanceof DomainError && error.status === status && error.code === code);
}

test('overview fits every current system and operator mapping without embedding source records or route descriptions', () => {
  const input = fixture(), result = buildAgentContextOverview(input);
  assert.equal(result.systems.length, 49);
  assert.ok(bytes(result) <= AGENT_CONTEXT_MAX_BYTES);
  assert.deepEqual(result.systems.map(row => row.id), systemCatalog.map(row => row.id));
  assert.deepEqual(result.action_providers, input.actionProviders);
  assert.deepEqual(result.action_provider_options, input.actionProviderOptions);
  assert.deepEqual(result.available_actions, Object.keys(input.actionProviders));
  assert.deepEqual(result.world, input.world);
  assert.equal(result.clock_domains.simulation, clock);
  assert.equal(result.clock_domains.wall, input.wallNow);
  assert.equal(result.clock_domains.oauth_expiry, 'wall');
  for (const row of result.systems) {
    assert.equal(row.feed_count, systemCatalog.find(system => system.id === row.id)!.feeds.length);
    assert.equal(row.native_count, providerContracts.filter(contract => contract.system === row.id).length);
    assert.deepEqual(row.connection, {oauth_status: 'connected', provider_status: 'healthy', scopes: ['read', 'write']});
    assert.equal('feeds' in row, false);
  }
  assert.equal('provider_contracts' in result, false);
  assert.equal('connections' in result, false);
});

test('all real native contracts are discoverable exactly once at both page limits, including systems with no native routes', () => {
  const input = fixture();
  for (const limit of [5, 10]) {
    const found: string[] = [];
    for (const system of systemCatalog) {
      const expected = providerContracts.filter(row => row.system === system.id);
      let cursor = 0, seen = 0;
      do {
        const page = buildAgentProviderContext(input, {system: system.id, cursor, limit});
        assert.ok(bytes(page) <= AGENT_CONTEXT_MAX_BYTES, `${system.id} offset ${cursor}`);
        assert.deepEqual(page.system.feeds, system.feeds);
        assert.equal(page.total, expected.length);
        assert.equal(page.cursor, cursor);
        assert.equal(page.limit, limit);
        assert.deepEqual(page.provider_contracts, expected.slice(cursor, cursor + page.provider_contracts.length));
        found.push(...page.provider_contracts.map(row => row.id));
        seen += page.provider_contracts.length;
        if (page.next_cursor === null) break;
        assert.ok(page.next_cursor > cursor, 'A nonterminal page must advance.');
        assert.equal(page.next_cursor, seen);
        cursor = page.next_cursor;
      } while (true);
      assert.equal(seen, expected.length);
    }
    assert.equal(found.length, providerContracts.length);
    assert.equal(new Set(found).size, providerContracts.length);
    assert.deepEqual([...found].sort(), providerContracts.map(row => row.id).sort());
  }
  const projected = buildAgentProviderContext(input, {system: 'assettiger'});
  assert.ok(projected.system.feeds.length > 0);
  assert.deepEqual(projected.provider_contracts, []);
  assert.equal(projected.total, 0);
  assert.equal(projected.next_cursor, null);
});

test('largest real provider page reduces row count without dropping contract instructions or authority semantics', () => {
  const input = fixture();
  const page = buildAgentProviderContext(input, {system: 'sap-b1', limit: 10});
  assert.ok(page.provider_contracts.length > 0 && page.provider_contracts.length < 10);
  assert.ok(bytes(page) <= AGENT_CONTEXT_MAX_BYTES);
  assert.equal(page.next_cursor, page.provider_contracts.length);
  assert.deepEqual(page.provider_contracts, providerContracts.filter(row => row.system === 'sap-b1').slice(0, page.provider_contracts.length));
  const plaid = buildAgentProviderContext(input, {system: 'plaid'});
  assert.ok(plaid.provider_contracts.some(row => row.method === 'POST' && row.access === 'read'));
  assert.deepEqual(plaid.provider_contracts, providerContracts.filter(row => row.system === 'plaid'));
});

test('byte budgeting counts multibyte UTF-8 and returns whole contracts across smaller pages', () => {
  const input = fixture();
  input.systems = [{id: 'unicode', name: 'Unicode provider', category: 'Documents', feeds: ['document']}];
  const description = '界'.repeat(3000);
  input.providerContracts = [0, 1].map(index => ({id: `unicode.read-${index}`, system: 'unicode', method: 'GET', path: `/documents/${index}`, access: 'read', description, limitations: ['Preserve this entire constraint.']}));
  const first = buildAgentProviderContext(input, {system: 'unicode', limit: 10});
  assert.equal(first.provider_contracts.length, 1);
  assert.equal(first.next_cursor, 1);
  assert.equal(first.provider_contracts[0].description, description);
  assert.ok(bytes(first) <= AGENT_CONTEXT_MAX_BYTES);
  const second = buildAgentProviderContext(input, {system: 'unicode', cursor: first.next_cursor, limit: 10});
  assert.equal(second.next_cursor, null);
  assert.deepEqual([...first.provider_contracts, ...second.provider_contracts], input.providerContracts);
});

test('an indivisible oversized row or metadata fails explicitly instead of truncating or returning a nonadvancing page', () => {
  const input = fixture();
  input.providerContracts = [{id: 'plaid.huge', system: 'plaid', method: 'POST', path: '/large', access: 'read', description: 'x'.repeat(AGENT_CONTEXT_MAX_BYTES)}];
  rejects(() => buildAgentProviderContext(input, {system: 'plaid'}), 413, 'context_metadata_too_large');
  input.systems = [{id: 'plaid', name: 'Plaid', category: 'Banking', feeds: ['x'.repeat(AGENT_CONTEXT_MAX_BYTES)]}];
  input.providerContracts = [];
  rejects(() => buildAgentProviderContext(input, {system: 'plaid'}), 413, 'context_metadata_too_large');
  input.mandate = 'x'.repeat(AGENT_CONTEXT_MAX_BYTES);
  rejects(() => buildAgentContextOverview(input), 413, 'context_metadata_too_large');
});

test('provider queries reject unknown systems and invalid bounds while permitting explicit end cursors', () => {
  const input = fixture();
  rejects(() => buildAgentProviderContext(input, {system: 'unknown-system'}), 404, 'unknown_context_system');
  for (const cursor of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 999999, '0' as any]) {
    rejects(() => buildAgentProviderContext(input, {system: 'plaid', cursor}), 400, 'invalid_context_cursor');
  }
  for (const limit of [0, -1, 0.5, 11, NaN, Infinity, '5' as any]) {
    rejects(() => buildAgentProviderContext(input, {system: 'plaid', limit}), 400, 'invalid_context_limit');
  }
  const total = providerContracts.filter(row => row.system === 'plaid').length;
  const end = buildAgentProviderContext(input, {system: 'plaid', cursor: total});
  assert.deepEqual(end.provider_contracts, []);
  assert.equal(end.next_cursor, null);
  assert.equal(end.limit, 5);
});

test('builders leave legacy worlds and all metadata untouched and return independently mutable copies', () => {
  const input = fixture(), world = createWorld({kind: 'supplier-fraud', orderCount: 1}, 'legacy-context-world');
  delete world.supplierRoutes;
  delete world.supplierRouteHolds;
  delete world.billPaymentOutcomes;
  input.world = world;
  const before = JSON.stringify(input);
  const overview = buildAgentContextOverview(input), detail = buildAgentProviderContext(input, {system: 'sap-b1'});
  assert.equal(JSON.stringify(input), before);
  overview.world.name = 'Mutated returned name';
  overview.systems[0].connection.scopes.push('untrusted-scope');
  overview.action_providers.refund = 'different';
  overview.action_provider_options.prepare_manual_journal.push('different');
  detail.system.feeds.push('different');
  detail.connection.scopes.push('different');
  detail.provider_contracts[0].description = 'different';
  (detail.provider_contracts[0].limitations as string[])?.push('different');
  (detail.provider_contracts[0].documentation as string[])?.push('different');
  assert.equal(JSON.stringify(input), before);
  assert.equal('supplierRoutes' in world, false);
});

test('only public metadata fields are copied; OAuth status, provider status and scope remain distinct', () => {
  const input = fixture();
  Object.assign(input.world, {bankTransactions: [{amount_minor: 123, secret: 'financial-secret'}], messages: ['private-message'], approvals: ['private-approval']});
  input.connections = [{system: 'mercury', oauth_status: 'expired', provider_status: 'offline', scopes: ['read'], expires_at: clock, expires_at_clock: 'wall', connected_at: clock, access_token: 'private-token', refresh_token: 'private-refresh', grant_id: 'private-grant', actor: 'private-principal'} as any];
  input.systems = input.systems.map(system => ({...system, secret: 'system-secret'}));
  input.providerContracts = input.providerContracts.map(row => ({...row, secret: 'contract-secret'}));
  const overview = buildAgentContextOverview(input), detail = buildAgentProviderContext(input, {system: 'mercury', limit: 10});
  const text = JSON.stringify({overview, detail});
  for (const forbidden of ['financial-secret', 'private-message', 'private-approval', 'private-token', 'private-refresh', 'private-grant', 'private-principal', 'system-secret', 'contract-secret']) assert.equal(text.includes(forbidden), false);
  assert.deepEqual(overview.systems.find(row => row.id === 'mercury')!.connection, {oauth_status: 'expired', provider_status: 'offline', scopes: ['read']});
  assert.equal(detail.connection.expires_at_clock, 'wall');
  assert.equal(detail.connection.expires_at, clock);
  assert.deepEqual(detail.connection.scopes, ['read']);
  assert.deepEqual(overview.systems.find(row => row.id === 'plaid')!.connection, {oauth_status: 'disconnected', provider_status: 'unknown', scopes: []});
  assert.ok(detail.provider_contracts.some(row => row.access === 'write'), 'Discovery metadata does not grant write authorization.');
});

test('SDK context defaults to the bounded overview and derives each provider page without caller-selected routes', () => {
  assert.deepEqual(agentContextRequestSchema.parse({}), {});
  assert.equal(agentContextPath({}), '/context?view=overview');
  for (const system of systemCatalog) {
    const input = {system: system.id, cursor: '0', limit: 5}, before = JSON.stringify(input);
    const parsed = new URL(agentContextPath(input), 'http://127.0.0.1');
    assert.equal(parsed.pathname, '/context');
    assert.deepEqual([...parsed.searchParams], [['view', 'provider'], ['system', system.id], ['cursor', '0'], ['limit', '5']]);
    assert.equal(parsed.hash, '');
    assert.equal(JSON.stringify(input), before);
    assert.equal(agentContextPath({system: system.id}), `/context?view=provider&system=${system.id}`);
  }
});

test('SDK shape validation cannot bypass the callback requirement that pagination selects a system', () => {
  // The SDK receives .shape, so object-level conditions must also be enforced
  // by the actual callback path builder, after the SDK accepts each field.
  const sdkShape = z.object(agentContextRequestSchema.shape);
  for (const input of [{cursor: '0'}, {limit: 1}, {cursor: '5', limit: 10}]) {
    const validatedBySdk = sdkShape.parse(input);
    rejects(() => agentContextPath(validatedBySdk), 400, 'invalid_context_query');
  }
  assert.equal(agentContextPath(sdkShape.parse({system: 'mercury', cursor: '5', limit: 10})), '/context?view=provider&system=mercury&cursor=5&limit=10');
});

test('SDK context schema rejects malformed pages and extra capability or source arguments', () => {
  for (const value of [undefined, null, [], 'mercury', {system: ''}, {system: 'x'.repeat(161)}, {system: null}]) {
    assert.equal(agentContextRequestSchema.safeParse(value).success, false);
    assert.throws(() => agentContextPath(value));
  }
  for (const cursor of ['', '-1', '0.5', '+1', ' 1', '1 ', '1e3', '1\n', '１', '9007199254740992', 0, 1, null]) {
    const value = {system: 'mercury', cursor};
    assert.equal(agentContextRequestSchema.safeParse(value).success, false, String(cursor));
    assert.throws(() => agentContextPath(value));
  }
  for (const limit of [0, -1, 0.5, 11, Infinity, NaN, '5', null]) {
    assert.equal(agentContextRequestSchema.safeParse({system: 'mercury', limit}).success, false);
  }
  for (const extra of [
    {view: 'full'}, {world_id: 'other-company'}, {url: 'https://external.test'}, {path: '/actions'},
    {headers: {Authorization: 'Bearer private'}}, {token: 'private'}, {feed: 'bank-transaction'},
    {method: 'POST'}, {body: {type: 'decide_approval'}}, {query: {view: 'overview'}},
  ]) {
    assert.equal(agentContextRequestSchema.safeParse({system: 'mercury', ...extra}).success, false);
    assert.throws(() => agentContextPath({system: 'mercury', ...extra}));
  }
});

test('context path construction encodes hostile system text as one query value, never another endpoint or authority', () => {
  for (const system of ['mercury&view=overview', 'mercury#fragment', '../actions?type=pay_bill', 'https://external.test/path', 'mercury%26cursor=0', 'mercury\nledger']) {
    const parsed = new URL(agentContextPath({system, cursor: '0', limit: 1}), 'http://127.0.0.1:1234');
    assert.equal(parsed.origin, 'http://127.0.0.1:1234');
    assert.equal(parsed.pathname, '/context');
    assert.equal(parsed.hash, '');
    assert.equal(parsed.searchParams.get('system'), system);
    assert.deepEqual(parsed.searchParams.getAll('view'), ['provider']);
    assert.deepEqual([...parsed.searchParams.keys()], ['view', 'system', 'cursor', 'limit']);
    rejects(() => buildAgentProviderContext(fixture(), {system}), 404, 'unknown_context_system');
  }
});

test('SDK string cursors traverse every byte-bounded provider page without a full-context fallback', () => {
  const input = fixture();
  for (const system of systemCatalog) {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL(agentContextPath({system: system.id, cursor, limit: 10}), 'http://127.0.0.1');
      assert.equal(url.searchParams.get('view'), 'provider');
      const page = buildAgentProviderContext(input, {system: url.searchParams.get('system')!, cursor: url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : undefined, limit: Number(url.searchParams.get('limit'))});
      assert.ok(bytes(page) <= AGENT_CONTEXT_MAX_BYTES);
      seen.push(...page.provider_contracts.map(row => row.id));
      if (page.next_cursor === null) break;
      cursor = String(page.next_cursor);
    } while (true);
    assert.deepEqual(seen, providerContracts.filter(row => row.system === system.id).map(row => row.id));
  }
});

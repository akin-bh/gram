import {DomainError} from './world.ts';
import type {World} from './world.ts';
import type {ProviderContract} from './provider-contracts.ts';

/** Bound the complete UTF-8 JSON response, not characters or individual fields. */
export const AGENT_CONTEXT_MAX_BYTES = 16000;

export type SystemMetadata = {
  id: string;
  name: string;
  category: string;
  feeds: readonly string[];
  implementation?: string;
  vendor_api_compatible?: boolean;
};
export type ConnectionMetadata = {
  system: string;
  oauth_status?: string;
  provider_status?: string;
  scopes?: readonly string[];
  expires_at?: string | null;
  expires_at_clock?: string;
  connected_at?: string | null;
};
export type AgentContextInput = {
  world: Pick<World, 'id' | 'name' | 'kind' | 'now' | 'revision'>;
  systems: readonly SystemMetadata[];
  providerContracts: readonly ProviderContract[];
  connections: readonly ConnectionMetadata[];
  actionProviders: Readonly<Record<string, string>>;
  actionProviderOptions?: Readonly<Record<string, readonly string[]>>;
  wallNow: string;
  mandate: string;
};

const fail = (status: number, code: string, message: string): never => {
  throw new DomainError(status, code, message);
};
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function bounded<T>(value: T): T {
  if (byteSize(value) > AGENT_CONTEXT_MAX_BYTES) {
    fail(413, 'context_metadata_too_large', 'Complete context metadata exceeds the response byte limit. No fields or source rows were truncated.');
  }
  return value;
}
function connection(input: AgentContextInput, system: string) {
  const source = input.connections.find(row => row.system === system);
  return {
    system,
    oauth_status: source?.oauth_status ?? 'disconnected',
    provider_status: source?.provider_status ?? 'unknown',
    scopes: [...(source?.scopes ?? [])],
    expires_at: source?.expires_at ?? null,
    expires_at_clock: source?.expires_at_clock ?? 'wall',
    connected_at: source?.connected_at ?? null,
  };
}
function contract(row: ProviderContract): ProviderContract {
  return {
    id: row.id,
    system: row.system,
    method: row.method,
    path: row.path,
    access: row.access,
    description: row.description,
    ...(row.documentation === undefined ? {} : {documentation: [...row.documentation]}),
    ...(row.limitations === undefined ? {} : {limitations: [...row.limitations]}),
  };
}
const contextPath = (id: string) => `/api/worlds/${encodeURIComponent(id)}/context`;
const recordsPath = (id: string) => `/api/worlds/${encodeURIComponent(id)}/records`;

/** Discover every system without embedding all feeds and native route descriptions. */
export function buildAgentContextOverview(input: AgentContextInput) {
  const {id, name, kind, now, revision} = input.world;
  const actionProviders = {...input.actionProviders};
  return bounded({
    view: 'overview' as const,
    world: {id, name, kind, now, revision},
    clock_domains: {simulation: now, wall: input.wallNow, oauth_expiry: 'wall', financial_settlement: 'simulation'},
    mandate: input.mandate,
    systems: input.systems.map(system => {
      const state = connection(input, system.id);
      return {
        id: system.id,
        name: system.name,
        category: system.category,
        feed_count: system.feeds.length,
        native_count: input.providerContracts.filter(row => row.system === system.id).length,
        connection: {oauth_status: state.oauth_status, provider_status: state.provider_status, scopes: state.scopes},
      };
    }),
    action_providers: actionProviders,
    action_provider_options: Object.fromEntries(Object.entries(input.actionProviderOptions ?? {}).map(([action, systems]) => [action, [...systems]])),
    available_actions: Object.keys(actionProviders),
    records_endpoint: `${recordsPath(id)}?system=SYSTEM&feed=FEED`,
    provider_context_endpoint: `${contextPath(id)}?view=provider&system=SYSTEM`,
    note: 'Metadata only. Inspect the selected provider to discover its complete feeds and paginated native operations, then read authorized source records. A connection grant is distinct from provider availability; no source facts are included here.',
  });
}

/** Return full feed metadata and whole native contracts, with byte-aware pagination. */
export function buildAgentProviderContext(input: AgentContextInput, query: {system: string; cursor?: number; limit?: number}) {
  const selected = input.systems.find(row => row.id === query.system);
  if (!selected) return fail(404, 'unknown_context_system', 'The requested system is not in the system catalog.');
  const cursor = query.cursor ?? 0;
  const limit = query.limit ?? 5;
  if (!Number.isSafeInteger(cursor) || cursor < 0) fail(400, 'invalid_context_cursor', 'Context cursor must be a nonnegative integer offset.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) fail(400, 'invalid_context_limit', 'Context limit must be an integer between 1 and 10.');
  const rows = input.providerContracts.filter(row => row.system === selected.id);
  if (cursor > rows.length) fail(400, 'invalid_context_cursor', 'Context cursor exceeds the number of native operations for this system.');
  const metadata = {
    view: 'provider' as const,
    world_id: input.world.id,
    system: {
      id: selected.id,
      name: selected.name,
      category: selected.category,
      feeds: [...selected.feeds],
      ...(selected.implementation === undefined ? {} : {implementation: selected.implementation}),
      ...(selected.vendor_api_compatible === undefined ? {} : {vendor_api_compatible: selected.vendor_api_compatible}),
    },
    connection: connection(input, selected.id),
    cursor,
    limit,
    total: rows.length,
    records_endpoint: `${recordsPath(input.world.id)}?system=${encodeURIComponent(selected.id)}&feed=FEED`,
    note: 'Metadata only; native routes are explicitly supported subsets. Feeds are complete for this system. Follow next_cursor until null to discover every native operation. Page size may be smaller than limit to preserve complete rows within the byte limit. Source access still requires its own OAuth scope and healthy provider.',
  };
  const page: ProviderContract[] = [];
  const output = () => ({...metadata, provider_contracts: page, next_cursor: cursor + page.length < rows.length ? cursor + page.length : null});
  bounded(output());
  for (const row of rows.slice(cursor, cursor + limit)) {
    page.push(contract(row));
    if (byteSize(output()) > AGENT_CONTEXT_MAX_BYTES) {
      page.pop();
      if (!page.length) fail(413, 'context_metadata_too_large', 'One complete native operation and its provider metadata exceed the response byte limit. No row was truncated.');
      break;
    }
  }
  return bounded(output());
}

/** Connect (or reconnect) every system for every company through the real OAuth flow.
 * Grants expire after an hour, so run this right before a demo: `bun scripts/connect-demo.ts`. */
const BASE = process.env.FINANCE_WORLD_URL ?? `http://127.0.0.1:${process.env.FINANCE_WORLD_PORT ?? '24300'}`;
const CORE = ['stripe', 'mercury', 'netsuite', 'gmail', 'google-drive', 'ticketing', 'ledger', 'bank', 'quickbooks'];
let cookie = '';

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(BASE + path, { ...init, redirect: 'manual', headers: { Origin: BASE, ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) } });
  const set = response.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map(value => value.split(';')[0]).join('; ');
  return response;
}
async function json(path: string, init: RequestInit = {}) {
  const response = await call(path, init);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(path + ' → ' + response.status + ' ' + (await response.text()).slice(0, 200));
  return response.json() as Promise<any>;
}

await call('/'); // mints the controller session cookie
const boot = await json('/api/bootstrap');
const catalog = new Set(boot.systems.map((s: any) => s.id));

for (const world of boot.worlds) {
  const snapshot = await json('/api/worlds/' + world.id);
  const status = await json('/api/worlds/' + world.id + '/work/status');
  const connected = new Set(snapshot.connections.filter((c: any) => c.status === 'connected').map((c: any) => c.system));
  const wanted = [...new Set([...(status?.systems ?? []), ...CORE.filter(s => catalog.has(s))])].sort();
  const todo = wanted.filter(s => !connected.has(s));
  console.log(`\n${world.name} (${world.kind}): ${connected.size} connected, ${todo.length} to connect`);
  for (const system of todo) {
    const start = await json(`/api/worlds/${world.id}/connect/${system}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const params = new URL(start.authorization_url).searchParams;
    params.set('decision', 'allow');
    const authorize = await call(`/oauth/${system}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    if (authorize.status !== 303) throw new Error(system + ': authorize → ' + authorize.status);
    const callback = await call(new URL(authorize.headers.get('Location')!).pathname + new URL(authorize.headers.get('Location')!).search);
    if (callback.status !== 303) throw new Error(system + ': callback → ' + callback.status);
    const landed = new URL(callback.headers.get('Location')!).searchParams;
    console.log(`  ${system}: ${landed.get('connected') === system ? 'connected' : 'FAILED ' + landed}`);
  }
}

console.log('\n--- verification ---');
for (const world of boot.worlds) {
  const snapshot = await json('/api/worlds/' + world.id);
  const status = await json('/api/worlds/' + world.id + '/work/status');
  console.log(`${world.name}: ${snapshot.connections.filter((c: any) => c.status === 'connected').map((c: any) => c.system).sort().join(', ')}`);
  if (status) console.log(`  seat on_duty=${status.on_duty} missing=${JSON.stringify(status.missing_connections)} agent=${status.agent_available ? status.model : 'UNAVAILABLE'}`);
}

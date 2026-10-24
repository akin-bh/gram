import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.ts';
import { createWorld } from '../src/world.ts';
import { beancountLedger, beancountAccounts, Books } from '../src/books.ts';
import { favaSocket, locateFava } from '../src/fava.ts';

const base = 'http://127.0.0.1:24300';
const fava = locateFava();

async function fixture(options: { fava?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gram-books-'));
  const books = { dir: join(dir, 'books'), ...(options.fava ? { fava: { python: fava.python!, socket: favaSocket('test-' + process.pid), ledgers: join(dir, 'books') } } : { favaReason: 'Fava is off in this test.' }) };
  const service = await createService({ database: join(dir, 'worlds.sqlite'), baseUrl: base, agentEnabled: false, slack: false, seatIntervalMs: 0, deliveryIntervalMs: 0, books });
  const page = await service.fetch(new Request(base)); const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const get = (path: string, init: RequestInit = {}) => service.fetch(new Request(base + path, { ...init, headers: { Cookie: cookie, ...init.headers } }));
  const post = (path: string, input: any) => get(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(input) });
  const create = async (input: any) => { const response = await post('/api/worlds', input); expect(response.status).toBe(201); return (await response.json()).world; };
  return { service, dir, get, post, create, async close() { await service.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('every journal is exported balanced, with gram\'s balances asserted after the last posting', () => {
  const w = createWorld({ kind: 'settlement-exceptions', seed: 3 }, 'world-books-unit');
  const exported = beancountLedger(w), names = beancountAccounts(w);
  expect(exported.journals).toBe(w.journals.length);
  expect(exported.text).toContain('option "operating_currency" "USD"');
  for (const journal of w.journals) expect(exported.text).toContain(`gram-journal: "${journal.id}"`);
  for (const account of w.accounts) {
    expect(names.get(account.id)).toMatch(/^(Assets|Liabilities|Equity|Income|Expenses):[A-Z0-9][A-Za-z0-9-]*$/);
    const minor = Math.abs(account.balance_minor), shown = `${account.balance_minor < 0 ? '-' : ''}${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')} USD`;
    expect(exported.text).toMatch(new RegExp(`balance ${names.get(account.id)!.replace(/[-]/g, '\\-')} +${shown.replace('.', '\\.')}\n`));
  }
  // Every transaction's postings net to zero.
  for (const block of exported.text.split('\n\n').filter(block => /^\d{4}-\d\d-\d\d \*/.test(block))) {
    const amounts = [...block.matchAll(/ (-?\d+\.\d\d) USD$/gm)].map(match => Math.round(Number(match[1]) * 100));
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(0);
  }
  expect(beancountLedger(w).sha256).toBe(exported.sha256);
});

test('a seat company\'s books are in its own currency, from its go-live, with the work that posted them', () => {
  const w = createWorld({ kind: 'tour-settlements', seed: 5 }, 'world-books-tour');
  expect(w.journals.find((journal: any) => journal.source_type === 'opening').posted_at).toBe(w.now);
  const exported = beancountLedger(w);
  expect(exported.currency).toBe('USD');
  expect(exported.text).toContain('Assets:Cash-Bank');
  expect(exported.text).toMatch(/ USD$/m);
  expect(exported.text).not.toMatch(/ CAD$/m);
  expect(exported.text).toContain('query "Posted under policy, no person"');
  // A posting by the seat's gateway names its work item and who approved it.
  const item = { id: 'WI-1', refs: [w.journals[1].id], approval: 'policy' };
  const linked = beancountLedger({ ...w, workItems: [item] } as any).text;
  expect(linked).toMatch(new RegExp(`#posted-under-policy \\^WI-1\\n  gram-journal: "${w.journals[1].id}"`));
});

test('a ledger file is rewritten atomically and only when the books change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gram-books-')), books = new Books(dir);
  try {
    const w = createWorld({ kind: 'cash-application', seed: 2 }, 'world-books-file');
    expect(books.write(w).changed).toBe(true);
    expect(books.write(w).changed).toBe(false);
    expect(new Books(dir).write(w).changed).toBe(false);
    w.name = 'Kestrel Brewing (renamed)';
    expect(books.write(w).changed).toBe(true);
    expect(readFileSync(books.file(w.id), 'utf8')).toContain('option "title" "Kestrel Brewing (renamed)"');
    expect(() => books.file('../escape')).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the console downloads the books; Fava is reachable only through gram, read-only, behind the session', async () => {
  const f = await fixture();
  try {
    const world = await f.create({ kind: 'tour-settlements' });
    const status = await (await f.get(`/api/worlds/${world.id}/books`)).json();
    expect(status).toMatchObject({ available: true, read_only: true, journals: world.journals.length, fava: { state: 'unavailable', reason: 'Fava is off in this test.' } });
    const download = await f.get(status.download);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain(`${world.id}.beancount`);
    expect(await download.text()).toContain('option "title" "Live Nation Concerts"');
    expect((await f.get(`/fava/${world.id}/`)).status).toBe(503);
    expect((await f.get(`/fava/${world.id}/x/api/source`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(405);
    expect((await f.service.fetch(new Request(`${base}/fava/${world.id}/`))).status).toBe(403);
    expect((await f.service.fetch(new Request(`${base}/api/worlds/${world.id}/books.beancount`))).status).toBe(401);
  } finally { await f.close(); }
});

test('the books follow every committed action', async () => {
  const f = await fixture();
  try {
    const world = await f.create({ kind: 'ticket-cancellation', seed: 9 });
    const before = (await (await f.get(`/api/worlds/${world.id}/books`)).json()).sha256;
    const response = await f.post(`/api/worlds/${world.id}/actions`, { type: 'rename_company', name: 'Arena Holdings' });
    expect(response.status).toBe(200);
    await Bun.sleep(0);
    const after = await (await f.get(`/api/worlds/${world.id}/books`)).json();
    expect(after.sha256).not.toBe(before);
    expect(await (await f.get(after.download)).text()).toContain('option "title" "Arena Holdings"');
  } finally { await f.close(); }
});

test.skipIf(!fava.python)('Fava serves the exported books under /fava/, framed only by the console, and sees new postings', async () => {
  const f = await fixture({ fava: true });
  try {
    const world = await f.create({ kind: 'calhacks' });
    const status = await (await f.get(`/api/worlds/${world.id}/books`)).json();
    expect(status.fava).toMatchObject({ state: 'running', slug: 'cal-hacks-130', errors: 0, url: `/fava/${world.id}/cal-hacks-130/` });
    const root = await f.get(`/fava/${world.id}/`);
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe(`${status.fava.url}balance_sheet/`);
    const page = await f.get(status.fava.url + 'journal/');
    expect(page.status).toBe(200);
    expect(page.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(await page.text()).toContain(`/fava/${world.id}/static/app.js`);
    expect((await f.get(`/api/worlds/${world.id}`)).headers.get('x-frame-options')).toBe('DENY');
    // A posting in gram reaches Fava: its change check flips and the new journal is in its query results.
    const changed = async () => (await (await f.get(status.fava.url + 'api/changed')).json()).data;
    await changed();
    await Bun.sleep(5);
    expect((await f.post(`/api/worlds/${world.id}/actions`, { type: 'rename_company', name: 'Cal Hacks 13.0 Foundation books' })).status).toBe(200);
    await Bun.sleep(0);
    expect(await changed()).toBe(true);
    const renamed = await (await f.get(`/api/worlds/${world.id}/books`)).json();
    expect(renamed.fava).toMatchObject({ slug: 'cal-hacks-130-foundation-books', errors: 0 });
  } finally { await f.close(); }
}, 60_000);

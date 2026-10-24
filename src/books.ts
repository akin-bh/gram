/**
 * The books as Beancount: every journal gram's gateway posted, written as a Beancount
 * ledger that Fava reads. The file is a projection, rewritten after each commit; gram
 * stays the only writer of the books, so nothing entered elsewhere can post.
 */
import { mkdirSync, renameSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatMinor, currencyMinorUnits } from './money.ts';
import { hash } from './store.ts';
import type { World } from './world.ts';

/** gram's account types and the Beancount root each one sits under. */
export const BEANCOUNT_ROOTS: Record<string, string> = { asset: 'Assets', contra_asset: 'Assets', liability: 'Liabilities', equity: 'Equity', revenue: 'Income', expense: 'Expenses' };
const component = (id: string) => id.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join('-') || 'Account';
const quote = (text: unknown) => '"' + String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const link = (id: unknown) => String(id ?? '').replace(/[^A-Za-z0-9\-_/.]/g, '-').replace(/^-+|-+$/g, '');
const humanize = (id: string) => id.replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());
const day = (iso: string) => String(iso).slice(0, 10);
const nextDay = (date: string) => new Date(Date.parse(date + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);

/** Beancount account names for every gram account, unique within the world. */
export function beancountAccounts(w: World): Map<string, string> {
  const names = new Map<string, string>(), used = new Set<string>();
  for (const account of w.accounts) {
    const root = BEANCOUNT_ROOTS[account.type];
    if (!root) throw new Error(`Account ${account.id} has type ${account.type}, which has no Beancount root`);
    let name = `${root}:${component(account.id)}`, n = 2;
    while (used.has(name)) name = `${root}:${component(account.id)}-${n++}`;
    used.add(name); names.set(account.id, name);
  }
  return names;
}

/** Who and what stands behind a journal: the operation it settled, the work item and
 * posting that produced it, and the record it was for. Found from the world's own links. */
function provenance(w: World) {
  const byId = new Map<string, any>(), postingsByOperation = new Map<string, any>(), postingsByJournal = new Map<string, any>(), itemsByJournal = new Map<string, any>();
  for (const [key, rows] of Object.entries(w)) {
    if (!Array.isArray(rows) || key === 'journals') continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue;
      if (!byId.has(row.id)) byId.set(row.id, row);
      if (row.work_item_id && typeof row.operation_id === 'string') postingsByOperation.set(row.operation_id, row);
      if (row.work_item_id && typeof row.journal_id === 'string') postingsByJournal.set(row.journal_id, row);
    }
  }
  // A reversal's journal is on both the item it reverses and the item the reversal reopens.
  for (const item of w.workItems ?? []) for (const ref of item.refs ?? []) if (typeof ref === 'string' && ref.startsWith('journal_')) itemsByJournal.set(ref, [...(itemsByJournal.get(ref) ?? []), item]);
  const operations = new Map(w.operations.map((operation: any) => [operation.id, operation]));
  return (journal: any) => {
    const operation = journal.source_type === 'operation' ? operations.get(journal.source_id) : undefined;
    const posting = postingsByJournal.get(journal.id) ?? (operation ? postingsByOperation.get(operation.id) : undefined);
    const items: any[] = itemsByJournal.get(journal.id) ?? (posting ? (w.workItems ?? []).filter((row: any) => row.id === posting.work_item_id) : []), item = items[0];
    // A settlement's operation targets its posting; the counterparty is on the record the work item is about.
    const payee = [operation?.target_id && byId.get(operation.target_id), item?.subject_id && byId.get(item.subject_id), byId.get(journal.source_id)]
      .map(row => row?.payer_name ?? row?.vendor_name ?? row?.payee_name ?? row?.customer_name).find(name => typeof name === 'string');
    return { operation, posting, item, items, payee: payee as string | undefined };
  };
}

export type BooksExport = { text: string; currency: string; journals: number; accounts: number; through: string; sha256: string };

/** The whole ledger, deterministic for a given world state. */
export function beancountLedger(w: World): BooksExport {
  const currency = w.currency ?? 'USD';
  if (!Object.hasOwn(currencyMinorUnits, currency)) throw new Error(`Unsupported functional currency ${currency}`);
  const names = beancountAccounts(w), find = provenance(w);
  const journals = [...w.journals].sort((a, b) => a.posted_at.localeCompare(b.posted_at) || a.id.localeCompare(b.id));
  const opened = day(journals[0]?.posted_at ?? w.now), through = [...journals.map(j => day(j.posted_at)), day(w.now)].sort().at(-1)!;
  const width = Math.max(...[...names.values()].map(name => name.length)) + 4;
  const amount = (minor: number) => formatMinor(minor, currency).padStart(16) + ' ' + currency;
  const out: string[] = [
    `; ${w.name} · books exported by gram from its posted journals (${w.id}).`,
    '; Read-only projection: gram rewrites this file after every posting. Change the books in gram, not here.',
    '',
    `option "title" ${quote(w.name)}`,
    `option "operating_currency" ${quote(currency)}`,
    `${opened} custom "fava-option" "auto-reload" "true"`,
    `${opened} custom "fava-option" "invert-income-liabilities-equity" "true"`,
    `${opened} custom "fava-option" "default-page" "balance_sheet/"`,
    // gram's chart carries every scenario family's accounts; show the ones this company has used.
    `${opened} custom "fava-option" "show-accounts-with-zero-transactions" "false"`,
    '',
    `${opened} commodity ${currency}`,
    '',
    // Saved queries in Fava's sidebar: the questions a controller asks of a seat's books.
    `${opened} query "Posted under policy, no person" "SELECT date, payee, narration, account, position WHERE 'posted-under-policy' IN tags ORDER BY date"`,
    `${opened} query "Approved by a person" "SELECT date, entry_meta('approved-by') AS approver, payee, narration, account, position WHERE 'approved-by-person' IN tags ORDER BY date"`,
    `${opened} query "Postings by work item" "SELECT entry_meta('gram-work-item') AS work_item, date, narration, account, position WHERE entry_meta('gram-work-item') IS NOT NULL ORDER BY work_item, date"`,
    ...(names.has('cash-bank') ? [`${opened} query "Operating bank movements" "SELECT date, payee, narration, position, balance WHERE account = '${names.get('cash-bank')}' ORDER BY date"`] : []),
    '',
  ];
  for (const account of w.accounts) {
    out.push(`${opened} open ${names.get(account.id)} ${currency}`);
    out.push(`  name: ${quote(account.name)}`, `  gram-account: ${quote(account.id)}`, `  gram-type: ${quote(account.type)}`);
  }
  for (const journal of journals) {
    const { operation, posting, item, items, payee } = find(journal);
    const approval = posting?.approval ?? item?.approval;
    const tags = [approval === 'policy' ? '#posted-under-policy' : approval === 'human' ? '#approved-by-person' : '', /revers/i.test(journal.source_type + ' ' + (operation?.type ?? '')) ? '#reversal' : ''].filter(Boolean);
    // gram's generic "<operation> settled" reads better as the operation and the work item it closed.
    const narration = operation && journal.description === `${operation.type} settled` ? humanize(operation.type) + (item ? ' · ' + (payee ? item.id : item.title) : '') : journal.description || journal.source_type;
    const links = [...new Set([...items.map(row => row.id), posting?.id].filter(Boolean).map(link).filter(Boolean))].map(id => '^' + id);
    out.push('', [day(journal.posted_at), '*', ...(payee ? [quote(payee)] : []), quote(narration), ...tags, ...links].join(' '));
    out.push(`  gram-journal: ${quote(journal.id)}`, `  gram-source: ${quote(journal.source_type + ':' + journal.source_id)}`, `  posted-at: ${quote(journal.posted_at)}`);
    if (operation) out.push(`  gram-operation: ${quote(operation.type)}`);
    if (item) out.push(`  gram-work-item: ${quote(item.id)}`);
    if (posting?.approved_by) out.push(`  approved-by: ${quote(posting.approved_by)}`);
    if (Array.isArray(posting?.policies) && posting.policies.length) out.push(`  policies: ${quote(posting.policies.map((policy: any) => policy?.id ?? policy).join(', '))}`);
    for (const line of journal.lines) {
      const minor = (line.debit_minor ?? 0) - (line.credit_minor ?? 0);
      out.push(`  ${names.get(line.account_id)!.padEnd(width)}${amount(minor)}`);
      if (line.description) out.push(`    memo: ${quote(line.description)}`);
    }
  }
  // gram's own account balances, asserted after the last posting: Fava reports any account
  // whose journals do not add up to the balance gram holds for it.
  const asserted = nextDay(through);
  out.push('', `; Balances held by gram at ${w.now}.`);
  for (const account of w.accounts) out.push(`${asserted} balance ${names.get(account.id)!.padEnd(width)}${amount(account.balance_minor)}`);
  const text = out.join('\n') + '\n';
  return { text, currency, journals: journals.length, accounts: w.accounts.length, through, sha256: hash(text) };
}

/** One ledger file per company, written atomically and only when its content changed. */
export class Books {
  readonly dir: string;
  private written = new Map<string, { sha256: string; journals: number; accounts: number; through: string; written_at: string }>();
  constructor(dir: string) { this.dir = dir; mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  file(worldId: string) {
    if (!/^[A-Za-z0-9-]{1,200}$/.test(worldId)) throw new Error('Unsafe world id for a ledger file');
    return join(this.dir, worldId + '.beancount');
  }
  write(w: World) {
    const exported = beancountLedger(w), file = this.file(w.id), previous = this.written.get(w.id);
    if (previous?.sha256 === exported.sha256 && existsSync(file)) return { file, changed: false, ...previous };
    if (!previous && existsSync(file) && hash(readFileSync(file, 'utf8')) === exported.sha256) {
      const record = { sha256: exported.sha256, journals: exported.journals, accounts: exported.accounts, through: exported.through, written_at: new Date().toISOString() };
      this.written.set(w.id, record); return { file, changed: false, ...record };
    }
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, exported.text, { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, file);
    const record = { sha256: exported.sha256, journals: exported.journals, accounts: exported.accounts, through: exported.through, written_at: new Date().toISOString() };
    this.written.set(w.id, record);
    return { file, changed: true, ...record };
  }
  status(worldId: string) { return this.written.get(worldId); }
}

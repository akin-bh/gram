import { test } from 'bun:test';
import assert from 'node:assert/strict';
// This browser-native module intentionally has no build-time TypeScript dependency.
// @ts-ignore TS7016: JavaScript is also imported directly by the browser entrypoint.
import { WorkspaceStore, initialized } from '../web/workspace.js';

type Tab = { id: string; kind: string; view?: string; collection?: string; recordId?: string; title: string; pinned?: boolean; ui?: Record<string, any> };
type Pane = { id: string; column: number; row: number; tabs: Tab[]; activeTabId: string };
type Space = { panes: Pane[]; activePaneId: string; columnWidths: number[]; rowWeights: Record<number, number[]>; favorites: unknown[]; savedSearches: unknown[]; assistantDraft: string };
class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
const key = 'workspace-test';
const makeStore = (storage = new MemoryStorage()) => ({ store: new WorkspaceStore({ storage, key }), storage });
const current = (space: Space) => space.panes.find(pane => pane.id === space.activePaneId)!;
function validLayout(space: Space) {
  assert.ok(space.panes.length >= 1 && space.panes.length <= 6);
  assert.ok(space.panes.some(pane => pane.id === space.activePaneId));
  assert.equal(new Set(space.panes.map(pane => `${pane.column}:${pane.row}`)).size, space.panes.length);
  assert.equal(new Set(space.panes.flatMap(pane => pane.tabs.map(tab => tab.id))).size, space.panes.reduce((sum, pane) => sum + pane.tabs.length, 0));
  const columns = [...new Set(space.panes.map(pane => pane.column))].sort();
  assert.deepEqual(columns, columns.map((_, index) => index));
  assert.equal(space.columnWidths.length, columns.length);
  assert.ok(Math.abs(space.columnWidths.reduce((sum, width) => sum + width, 0) - 100) < 0.00001);
  for (const column of columns) {
    const panes = space.panes.filter(pane => pane.column === column);
    assert.deepEqual(panes.map(pane => pane.row), panes.map((_, index) => index));
    assert.ok(panes.length <= 2);
    assert.equal(space.rowWeights[column]!.length, panes.length);
    assert.ok(Math.abs(space.rowWeights[column]!.reduce((sum, height) => sum + height, 0) - 100) < 0.00001);
    for (const pane of panes) {
      assert.ok(pane.tabs.length > 0);
      assert.ok(pane.tabs.some(tab => tab.id === pane.activeTabId));
    }
  }
}

test('company workspaces isolate tabs, drafts, favorites, searches, and reopen history', () => {
  const { store, storage } = makeStore();
  const north: Space = store.getSpace('north');
  const south: Space = store.getSpace('south');
  store.updateAssistantDraft('north', 'Review vendor approvals.');
  const record = { collection: 'invoices', recordId: 'invoice-1', title: 'Invoice 1', view: 'finance' };
  const a = store.openRecord('north', record);
  const b = store.openRecord('south', record);
  assert.notEqual(a.id, b.id);
  const compose = store.openCompose('north');
  store.updateTab('north', compose.id, { ui: { draft: { to: 'vendor@example.test', body: 'North draft' } } });
  store.toggleFavorite('north', record);
  store.saveSearch('north', 'unpaid invoices');
  store.closeTab('north', north.activePaneId, a.id);
  assert.equal(store.reopenTab('south'), null);
  assert.equal(south.favorites.length, 0);
  assert.equal(south.savedSearches.length, 0);
  assert.equal(north.assistantDraft, 'Review vendor approvals.');
  assert.equal(south.assistantDraft, '');
  assert.equal(current(south).tabs.length, 2);
  const restored = initialized({ storage, key });
  assert.equal(restored.reopenTab('north').recordId, 'invoice-1');
  assert.equal(current(restored.getSpace('north')).tabs.find(tab => tab.id === compose.id)?.ui?.draft.body, 'North draft');
  assert.equal(current(restored.getSpace('south')).tabs.some(tab => tab.kind === 'compose'), false);
  assert.equal(restored.getSpace('north').favorites.length, 1);
  assert.equal(restored.getSpace('south').favorites.length, 0);
  assert.equal(restored.getSpace('north').assistantDraft, 'Review vendor approvals.');
  assert.equal(restored.getSpace('south').assistantDraft, '');
});

test('views and records deduplicate within the active pane; compose tabs remain independent', () => {
  const { store } = makeStore();
  const space: Space = store.getSpace('world');
  const pane = current(space);
  const record = { collection: 'invoices', recordId: 'same-id', title: 'Invoice', view: 'finance' };
  const first = store.openRecord('world', record);
  store.openView('world', 'mailbox', 'Mail');
  assert.equal(store.openRecord('world', { ...record, title: 'Updated title' }).id, first.id);
  assert.equal(pane.activeTabId, first.id);
  const mailbox = store.openView('world', 'mailbox', 'Mail');
  assert.equal(pane.tabs.filter(tab => tab.view === 'mailbox').length, 1);
  assert.equal(pane.activeTabId, mailbox.id);
  assert.notEqual(store.openRecord('world', { ...record, collection: 'payments' }).id, first.id);
  assert.notEqual(store.openCompose('world').id, store.openCompose('world').id);
  const target = store.splitTab('world', pane.id, first.id);
  store.activateTab('world', pane.id, mailbox.id);
  const second = store.openRecord('world', record);
  assert.notEqual(first.id, second.id);
  assert.equal(store.moveTab('world', pane.id, target.id, second.id, 0), true);
  assert.equal(target.tabs.filter((tab: Tab) => tab.recordId === record.recordId).length, 1);
  assert.equal(target.activeTabId, first.id);
  validLayout(space);
});

test('closing the final tab produces Overview and reopening restores its draft', () => {
  const { store } = makeStore();
  const space: Space = store.getSpace('world');
  const pane = current(space);
  const defaultId = pane.activeTabId;
  const compose = store.openCompose('world');
  store.updateTab('world', compose.id, { ui: { draft: { subject: 'Restored' } } });
  store.closeTab('world', pane.id, defaultId);
  store.closeTab('world', pane.id, compose.id);
  assert.equal(space.panes.length, 1);
  assert.equal(current(space).tabs[0]!.view, 'overview');
  const reopened = store.reopenTab('world');
  assert.equal(reopened.id, compose.id);
  assert.equal(reopened.ui.draft.subject, 'Restored');
  assert.equal(current(space).activeTabId, compose.id);
  store.reopenTab('world');
  assert.equal(current(space).tabs.filter(tab => tab.view === 'overview').length, 1);
  validLayout(space);
});

test('directional splits support three columns and two rows, with valid refs after moves and closes', () => {
  const { store, storage } = makeStore();
  const space: Space = store.getSpace('world');
  const first = current(space);
  const mail = store.openView('world', 'mailbox', 'Mail');
  const right = store.splitTab('world', first.id, mail.id, 'right');
  assert.equal(right.column, 1);
  const finance = store.openView('world', 'finance', 'Finance');
  const left = store.splitTab('world', right.id, finance.id, 'left');
  assert.equal(left.column, 1);
  assert.equal(right.column, 2);
  assert.equal(store.splitTab('world', right.id, mail.id, 'right'), null);
  const bottom = store.splitTab('world', first.id, first.activeTabId, 'bottom');
  assert.equal(bottom.row, 1);
  const top = store.splitTab('world', right.id, mail.id, 'top');
  assert.equal(top.row, 0);
  assert.equal(right.row, 1);
  assert.equal(store.splitTab('world', bottom.id, bottom.activeTabId, 'bottom'), null);
  const middleBottom = store.splitTab('world', left.id, finance.id, 'bottom');
  assert.equal(space.panes.length, 6);
  validLayout(space);
  store.updateLayout('world', { columnWidths: [5, 10, 85], rowWeights: { 0: [90, 10], 1: [1, 1], 2: [10, 90] } });
  assert.ok(space.columnWidths.every(width => width >= 22));
  assert.deepEqual(space.rowWeights[0], [67, 33]);
  assert.deepEqual(space.rowWeights[2], [33, 67]);
  store.updateLayout('world', { columnWidths: [Number.MAX_VALUE, Number.MAX_VALUE, 1] });
  validLayout(space);
  assert.ok(space.columnWidths.every(width => Number.isFinite(width) && width >= 22));
  assert.equal(store.moveTab('world', middleBottom.id, top.id, finance.id, 1), true);
  assert.equal(space.panes.some(pane => pane.id === middleBottom.id), false);
  store.closeTab('world', left.id, left.activeTabId);
  assert.equal(space.columnWidths.length, 2);
  assert.equal(top.column, 1);
  validLayout(space);
  store.closeTab('world', top.id, top.activeTabId);
  validLayout(space);
  const restored: Space = new WorkspaceStore({ storage, key }).getSpace('world');
  assert.deepEqual(restored, space);
  validLayout(restored);
});

test('pinning, reordering, and settings survive reload without persisting server or credential data', () => {
  const { store, storage } = makeStore();
  const space: Space = store.getSpace('world');
  const pane = current(space);
  const mail = store.openView('world', 'mailbox', 'Mail');
  const finance = store.openView('world', 'finance', 'Finance');
  store.togglePin('world', pane.id, finance.id);
  assert.equal(pane.tabs[0]!.id, finance.id);
  store.reorderTab('world', pane.id, mail.id, 0);
  assert.equal(pane.tabs[1]!.id, mail.id);
  const cyclic: Record<string, unknown> = { search: 'invoices', page: 2, draft: { body: 'Plain draft', password: 'not-a-preference' }, authToken: 'no', snapshot: { balance: 1000 }, bad: Infinity };
  cyclic.self = cyclic;
  store.updateTab('world', mail.id, { id: 'replacement', recordId: 'backend', snapshot: { balance: 4 }, ui: cyclic });
  store.updateSettings({ assistantWidth: 999 });
  assert.equal(store.settings.assistantWidth, 600);
  store.updateSettings({ assistantWidth: 100 });
  assert.equal(store.settings.assistantWidth, 300);
  store.updateSettings({ theme: 'dark', sidebarWidth: 310, sidebarCollapsed: true, assistantOpen: true, assistantWidth: 450, authToken: 'no' });
  store.updateSettings({ theme: 'unknown', sidebarWidth: Infinity, sidebarCollapsed: 'yes', assistantWidth: Infinity });
  const serialized = storage.getItem(key)!;
  assert.equal(serialized.includes('not-a-preference'), false);
  assert.equal(serialized.includes('authToken'), false);
  assert.equal(serialized.includes('snapshot'), false);
  assert.equal(serialized.includes('replacement'), false);
  const restored = new WorkspaceStore({ storage, key });
  assert.deepEqual(restored.settings, { theme: 'dark', sidebarWidth: 310, sidebarCollapsed: true, assistantOpen: true, assistantWidth: 450 });
  const restoredMail = current(restored.getSpace('world')).tabs.find(tab => tab.id === mail.id)!;
  assert.equal(restoredMail.ui?.draft.body, 'Plain draft');
  assert.equal(restoredMail.ui?.bad, undefined);
  assert.equal(current(restored.getSpace('world')).tabs[0]!.id, finance.id);
});

test('resize previews keep valid live dimensions and save only the completed gesture', () => {
  class CountingStorage extends MemoryStorage {
    writes = 0;
    setItem(key: string, value: string) { super.setItem(key, value); this.writes++; }
  }
  const storage = new CountingStorage(), { store } = makeStore(storage);
  const space: Space = store.getSpace('world'), first = current(space);
  const mail = store.openView('world', 'mailbox', 'Mail');
  store.splitTab('world', first.id, mail.id, 'right');
  const saved = storage.getItem(key);
  storage.writes = 0;
  for (let i = 0; i < 60; i++) {
    store.updateSettings({ sidebarWidth: 256 + i, assistantWidth: 394 + i }, { persist: false });
    store.updateLayout('world', { columnWidths: [50 + i / 4, 50 - i / 4] }, { persist: false });
  }
  assert.equal(storage.writes, 0);
  assert.equal(storage.getItem(key), saved);
  assert.equal(store.settings.sidebarWidth, 315);
  assert.deepEqual(space.columnWidths, [64.75, 35.25]);
  validLayout(space);
  store.updateSettings({ sidebarWidth: 999, assistantWidth: 100 }, { persist: false });
  store.updateLayout('world', { columnWidths: [1, 99] }, { persist: false });
  assert.equal(store.settings.sidebarWidth, 400);
  assert.equal(store.settings.assistantWidth, 300);
  assert.deepEqual(space.columnWidths, [22, 78]);
  assert.equal(storage.writes, 0);
  assert.equal(store.persist(), true);
  assert.equal(storage.writes, 1);
  const restored = new WorkspaceStore({ storage, key });
  assert.equal(restored.settings.sidebarWidth, 400);
  assert.equal(restored.settings.assistantWidth, 300);
  assert.deepEqual(restored.getSpace('world').columnWidths, [22, 78]);
  store.updateSettings({ sidebarWidth: 0 });
  assert.equal(storage.writes, 2);
  assert.equal(new WorkspaceStore({ storage, key }).settings.sidebarWidth, 240);
});

test('invalid or unavailable storage falls back safely and malformed references are repaired', () => {
  for (const serialized of ['{', 'null', '[]', '{"version":999,"spaces":{"world":{}}}']) {
    const storage = new MemoryStorage();
    storage.setItem(key, serialized);
    const store = new WorkspaceStore({ storage, key });
    assert.deepEqual(store.settings, { theme: 'light', sidebarWidth: 256, sidebarCollapsed: false, assistantOpen: false, assistantWidth: 394 });
    validLayout(store.getSpace('world'));
  }
  const unavailable = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  const store = new WorkspaceStore({ storage: unavailable, key });
  assert.equal(store.openView('world', 'finance', 'Finance').view, 'finance');
  assert.equal(store.updateAssistantDraft('world', 'a'.repeat(21000)).length, 20000);
  assert.equal(store.persist(), false);
  validLayout(store.getSpace('world'));
  const storage = new MemoryStorage();
  storage.setItem(key, JSON.stringify({ version: 1, settings: { theme: 'unknown', sidebarWidth: -20, assistantOpen: 'yes' }, spaces: { world: {
    panes: [{ id: 'pane', column: 2, row: 1, activeTabId: 'missing', tabs: [
      { id: 'tab', kind: 'view', view: 'overview', title: 'Overview' },
      { id: 'tab', kind: 'compose', title: 'Duplicate ID' },
      { id: 'bad', kind: 'record', title: 'Missing ref' },
    ] }], activePaneId: 'missing', columnWidths: [0, 0, 100], rowWeights: { 2: [10, 90] }, favorites: [{ secret: 'no' }], savedSearches: [null], assistantDraft: 'b'.repeat(21000),
  } } }));
  const repaired = new WorkspaceStore({ storage, key });
  const space: Space = repaired.getSpace('world');
  validLayout(space);
  assert.equal(current(space).tabs.length, 1);
  assert.equal(space.favorites.length, 0);
  assert.equal(space.savedSearches.length, 0);
  assert.equal(space.assistantDraft.length, 20000);
  assert.equal(repaired.settings.theme, 'light');
  assert.equal(repaired.settings.sidebarWidth, 240);
});

test('prototype-like world IDs remain separate and saved searches and favorites deduplicate', () => {
  const { store, storage } = makeStore();
  const reference = { collection: 'vendors', recordId: 'vendor-1', title: 'Vendor' };
  store.toggleFavorite('__proto__', reference);
  store.saveSearch('__proto__', '  vendor  ');
  const saved = store.saveSearch('__proto__', 'VENDOR');
  assert.equal(store.getSpace('__proto__').savedSearches.length, 1);
  assert.equal(store.getSpace('constructor').favorites.length, 0);
  const restored = new WorkspaceStore({ storage, key });
  assert.equal(restored.getSpace('__proto__').favorites.length, 1);
  assert.equal(restored.toggleFavorite('__proto__', reference), false);
  assert.equal(restored.getSpace('__proto__').favorites.length, 0);
  assert.equal(restored.removeSearch('__proto__', saved.id), true);
  assert.equal(restored.getSpace('__proto__').savedSearches.length, 0);
});

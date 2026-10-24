import { test, expect } from 'bun:test';
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
  expect(space.panes.length >= 1 && space.panes.length <= 6).toBeTruthy();
  expect(space.panes.some(pane => pane.id === space.activePaneId)).toBeTruthy();
  expect(new Set(space.panes.map(pane => `${pane.column}:${pane.row}`)).size).toBe(space.panes.length);
  expect(new Set(space.panes.flatMap(pane => pane.tabs.map(tab => tab.id))).size).toBe(space.panes.reduce((sum, pane) => sum + pane.tabs.length, 0));
  const columns = [...new Set(space.panes.map(pane => pane.column))].sort();
  expect(columns).toStrictEqual(columns.map((_, index) => index));
  expect(space.columnWidths.length).toBe(columns.length);
  expect(Math.abs(space.columnWidths.reduce((sum, width) => sum + width, 0) - 100) < 0.00001).toBeTruthy();
  for (const column of columns) {
    const panes = space.panes.filter(pane => pane.column === column);
    expect(panes.map(pane => pane.row)).toStrictEqual(panes.map((_, index) => index));
    expect(panes.length <= 2).toBeTruthy();
    expect(space.rowWeights[column]!.length).toBe(panes.length);
    expect(Math.abs(space.rowWeights[column]!.reduce((sum, height) => sum + height, 0) - 100) < 0.00001).toBeTruthy();
    for (const pane of panes) {
      expect(pane.tabs.length > 0).toBeTruthy();
      expect(pane.tabs.some(tab => tab.id === pane.activeTabId)).toBeTruthy();
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
  expect(a.id).not.toBe(b.id);
  const compose = store.openCompose('north');
  store.updateTab('north', compose.id, { ui: { draft: { to: 'vendor@example.test', body: 'North draft' } } });
  store.toggleFavorite('north', record);
  store.saveSearch('north', 'unpaid invoices');
  store.closeTab('north', north.activePaneId, a.id);
  expect(store.reopenTab('south')).toBeNull();
  expect(south.favorites.length).toBe(0);
  expect(south.savedSearches.length).toBe(0);
  expect(north.assistantDraft).toBe('Review vendor approvals.');
  expect(south.assistantDraft).toBe('');
  expect(current(south).tabs.length).toBe(2);
  const restored = initialized({ storage, key });
  expect(restored.reopenTab('north').recordId).toBe('invoice-1');
  expect(current(restored.getSpace('north')).tabs.find(tab => tab.id === compose.id)?.ui?.draft.body).toBe('North draft');
  expect(current(restored.getSpace('south')).tabs.some(tab => tab.kind === 'compose')).toBe(false);
  expect(restored.getSpace('north').favorites.length).toBe(1);
  expect(restored.getSpace('south').favorites.length).toBe(0);
  expect(restored.getSpace('north').assistantDraft).toBe('Review vendor approvals.');
  expect(restored.getSpace('south').assistantDraft).toBe('');
});

test('views and records deduplicate within the active pane; compose tabs remain independent', () => {
  const { store } = makeStore();
  const space: Space = store.getSpace('world');
  const pane = current(space);
  const record = { collection: 'invoices', recordId: 'same-id', title: 'Invoice', view: 'finance' };
  const first = store.openRecord('world', record);
  store.openView('world', 'mailbox', 'Mail');
  expect(store.openRecord('world', { ...record, title: 'Updated title' }).id).toBe(first.id);
  expect(pane.activeTabId).toBe(first.id);
  const mailbox = store.openView('world', 'mailbox', 'Mail');
  expect(pane.tabs.filter(tab => tab.view === 'mailbox').length).toBe(1);
  expect(pane.activeTabId).toBe(mailbox.id);
  expect(store.openRecord('world', { ...record, collection: 'payments' }).id).not.toBe(first.id);
  expect(store.openCompose('world').id).not.toBe(store.openCompose('world').id);
  const target = store.splitTab('world', pane.id, first.id);
  store.activateTab('world', pane.id, mailbox.id);
  const second = store.openRecord('world', record);
  expect(first.id).not.toBe(second.id);
  expect(store.moveTab('world', pane.id, target.id, second.id, 0)).toBe(true);
  expect(target.tabs.filter((tab: Tab) => tab.recordId === record.recordId).length).toBe(1);
  expect(target.activeTabId).toBe(first.id);
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
  expect(space.panes.length).toBe(1);
  expect(current(space).tabs[0]!.view).toBe('overview');
  const reopened = store.reopenTab('world');
  expect(reopened.id).toBe(compose.id);
  expect(reopened.ui.draft.subject).toBe('Restored');
  expect(current(space).activeTabId).toBe(compose.id);
  store.reopenTab('world');
  expect(current(space).tabs.filter(tab => tab.view === 'overview').length).toBe(1);
  validLayout(space);
});

test('directional splits support three columns and two rows, with valid refs after moves and closes', () => {
  const { store, storage } = makeStore();
  const space: Space = store.getSpace('world');
  const first = current(space);
  const mail = store.openView('world', 'mailbox', 'Mail');
  const right = store.splitTab('world', first.id, mail.id, 'right');
  expect(right.column).toBe(1);
  const finance = store.openView('world', 'finance', 'Finance');
  const left = store.splitTab('world', right.id, finance.id, 'left');
  expect(left.column).toBe(1);
  expect(right.column).toBe(2);
  expect(store.splitTab('world', right.id, mail.id, 'right')).toBeNull();
  const bottom = store.splitTab('world', first.id, first.activeTabId, 'bottom');
  expect(bottom.row).toBe(1);
  const top = store.splitTab('world', right.id, mail.id, 'top');
  expect(top.row).toBe(0);
  expect(right.row).toBe(1);
  expect(store.splitTab('world', bottom.id, bottom.activeTabId, 'bottom')).toBeNull();
  const middleBottom = store.splitTab('world', left.id, finance.id, 'bottom');
  expect(space.panes.length).toBe(6);
  validLayout(space);
  store.updateLayout('world', { columnWidths: [5, 10, 85], rowWeights: { 0: [90, 10], 1: [1, 1], 2: [10, 90] } });
  expect(space.columnWidths.every(width => width >= 22)).toBeTruthy();
  expect(space.rowWeights[0]).toStrictEqual([67, 33]);
  expect(space.rowWeights[2]).toStrictEqual([33, 67]);
  store.updateLayout('world', { columnWidths: [Number.MAX_VALUE, Number.MAX_VALUE, 1] });
  validLayout(space);
  expect(space.columnWidths.every(width => Number.isFinite(width) && width >= 22)).toBeTruthy();
  expect(store.moveTab('world', middleBottom.id, top.id, finance.id, 1)).toBe(true);
  expect(space.panes.some(pane => pane.id === middleBottom.id)).toBe(false);
  store.closeTab('world', left.id, left.activeTabId);
  expect(space.columnWidths.length).toBe(2);
  expect(top.column).toBe(1);
  validLayout(space);
  store.closeTab('world', top.id, top.activeTabId);
  validLayout(space);
  const restored: Space = new WorkspaceStore({ storage, key }).getSpace('world');
  expect(restored).toStrictEqual(space);
  validLayout(restored);
});

test('pinning, reordering, and settings survive reload without persisting server or credential data', () => {
  const { store, storage } = makeStore();
  const space: Space = store.getSpace('world');
  const pane = current(space);
  const mail = store.openView('world', 'mailbox', 'Mail');
  const finance = store.openView('world', 'finance', 'Finance');
  store.togglePin('world', pane.id, finance.id);
  expect(pane.tabs[0]!.id).toBe(finance.id);
  store.reorderTab('world', pane.id, mail.id, 0);
  expect(pane.tabs[1]!.id).toBe(mail.id);
  const cyclic: Record<string, unknown> = { search: 'invoices', page: 2, draft: { body: 'Plain draft', password: 'not-a-preference' }, authToken: 'no', snapshot: { balance: 1000 }, bad: Infinity };
  cyclic.self = cyclic;
  store.updateTab('world', mail.id, { id: 'replacement', recordId: 'backend', snapshot: { balance: 4 }, ui: cyclic });
  store.updateSettings({ assistantWidth: 999 });
  expect(store.settings.assistantWidth).toBe(600);
  store.updateSettings({ assistantWidth: 100 });
  expect(store.settings.assistantWidth).toBe(300);
  store.updateSettings({ theme: 'dark', sidebarWidth: 310, sidebarCollapsed: true, assistantOpen: true, assistantWidth: 450, authToken: 'no' });
  store.updateSettings({ theme: 'unknown', sidebarWidth: Infinity, sidebarCollapsed: 'yes', assistantWidth: Infinity });
  const serialized = storage.getItem(key)!;
  expect(serialized.includes('not-a-preference')).toBe(false);
  expect(serialized.includes('authToken')).toBe(false);
  expect(serialized.includes('snapshot')).toBe(false);
  expect(serialized.includes('replacement')).toBe(false);
  const restored = new WorkspaceStore({ storage, key });
  expect(restored.settings).toStrictEqual({ theme: 'dark', sidebarWidth: 310, sidebarCollapsed: true, assistantOpen: true, assistantWidth: 450 });
  const restoredMail = current(restored.getSpace('world')).tabs.find(tab => tab.id === mail.id)!;
  expect(restoredMail.ui?.draft.body).toBe('Plain draft');
  expect(restoredMail.ui?.bad).toBeUndefined();
  expect(current(restored.getSpace('world')).tabs[0]!.id).toBe(finance.id);
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
  expect(storage.writes).toBe(0);
  expect(storage.getItem(key)).toBe(saved);
  expect(store.settings.sidebarWidth).toBe(315);
  expect(space.columnWidths).toStrictEqual([64.75, 35.25]);
  validLayout(space);
  store.updateSettings({ sidebarWidth: 999, assistantWidth: 100 }, { persist: false });
  store.updateLayout('world', { columnWidths: [1, 99] }, { persist: false });
  expect(store.settings.sidebarWidth).toBe(400);
  expect(store.settings.assistantWidth).toBe(300);
  expect(space.columnWidths).toStrictEqual([22, 78]);
  expect(storage.writes).toBe(0);
  expect(store.persist()).toBe(true);
  expect(storage.writes).toBe(1);
  const restored = new WorkspaceStore({ storage, key });
  expect(restored.settings.sidebarWidth).toBe(400);
  expect(restored.settings.assistantWidth).toBe(300);
  expect(restored.getSpace('world').columnWidths).toStrictEqual([22, 78]);
  store.updateSettings({ sidebarWidth: 0 });
  expect(storage.writes).toBe(2);
  expect(new WorkspaceStore({ storage, key }).settings.sidebarWidth).toBe(240);
});

test('invalid or unavailable storage falls back safely and malformed references are repaired', () => {
  for (const serialized of ['{', 'null', '[]', '{"version":999,"spaces":{"world":{}}}']) {
    const storage = new MemoryStorage();
    storage.setItem(key, serialized);
    const store = new WorkspaceStore({ storage, key });
    expect(store.settings).toStrictEqual({ theme: 'light', sidebarWidth: 256, sidebarCollapsed: false, assistantOpen: false, assistantWidth: 394 });
    validLayout(store.getSpace('world'));
  }
  const unavailable = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  const store = new WorkspaceStore({ storage: unavailable, key });
  expect(store.openView('world', 'finance', 'Finance').view).toBe('finance');
  expect(store.updateAssistantDraft('world', 'a'.repeat(21000)).length).toBe(20000);
  expect(store.persist()).toBe(false);
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
  expect(current(space).tabs.length).toBe(1);
  expect(space.favorites.length).toBe(0);
  expect(space.savedSearches.length).toBe(0);
  expect(space.assistantDraft.length).toBe(20000);
  expect(repaired.settings.theme).toBe('light');
  expect(repaired.settings.sidebarWidth).toBe(240);
});

test('prototype-like world IDs remain separate and saved searches and favorites deduplicate', () => {
  const { store, storage } = makeStore();
  const reference = { collection: 'vendors', recordId: 'vendor-1', title: 'Vendor' };
  store.toggleFavorite('__proto__', reference);
  store.saveSearch('__proto__', '  vendor  ');
  const saved = store.saveSearch('__proto__', 'VENDOR');
  expect(store.getSpace('__proto__').savedSearches.length).toBe(1);
  expect(store.getSpace('constructor').favorites.length).toBe(0);
  const restored = new WorkspaceStore({ storage, key });
  expect(restored.getSpace('__proto__').favorites.length).toBe(1);
  expect(restored.toggleFavorite('__proto__', reference)).toBe(false);
  expect(restored.getSpace('__proto__').favorites.length).toBe(0);
  expect(restored.removeSearch('__proto__', saved.id)).toBe(true);
  expect(restored.getSpace('__proto__').savedSearches.length).toBe(0);
});

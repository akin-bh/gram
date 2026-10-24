// Browser-only workspace preferences. Records themselves remain on the server.
const VERSION = 1;
const DEFAULT_KEY = 'finance-world-workspaces-v1';
const MAX_COLUMNS = 3;
const MAX_ROWS = 2;
const MAX_TABS = 100;
const MAX_CLOSED = 20;
export const RESIZE_LIMITS = Object.freeze({
  sidebar: Object.freeze({ min: 240, max: 400, default: 256 }),
  assistant: Object.freeze({ min: 300, max: 600, default: 394 }),
});
const DEFAULT_SETTINGS = Object.freeze({ theme: 'light', sidebarWidth: RESIZE_LIMITS.sidebar.default, sidebarCollapsed: false, assistantOpen: false, assistantWidth: RESIZE_LIMITS.assistant.default });
const OMIT = Symbol('omit');
let sequence = 0;

const plain = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const string = (value, limit = 256) => typeof value === 'string' && value.trim() ? value.slice(0, limit) : null;
const identifier = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++sequence).toString(36)}`}`;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const indexAt = (value, length) => Number.isFinite(value) ? clamp(Math.trunc(value), 0, length) : length;
const forbiddenKey = key => /^(?:__proto__|prototype|constructor|auth|authorization|authentication|credentials?|password|secret|cookies?|session(?:[-_]?id)?|snapshot|records|response|backend|api[-_]?key|(?:access|refresh|id|auth)?[-_]?token)$/i.test(key);

function safeValue(value, depth = 0, seen = new WeakSet(), budget = { remaining: 65536 }) {
  if (budget.remaining <= 0 || depth > 6) return OMIT;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : OMIT;
  if (typeof value === 'string') {
    const result = value.slice(0, Math.min(20000, budget.remaining));
    budget.remaining -= result.length;
    return result;
  }
  if ((!plain(value) && !Array.isArray(value)) || seen.has(value)) return OMIT;
  seen.add(value);
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value.slice(0, 100)) {
      const safe = safeValue(item, depth + 1, seen, budget);
      if (safe !== OMIT) result.push(safe);
    }
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const key of Object.keys(value).slice(0, 100)) {
    if (!/^[a-z0-9_-]{1,64}$/i.test(key) || forbiddenKey(key)) continue;
    budget.remaining -= key.length;
    const safe = safeValue(value[key], depth + 1, seen, budget);
    if (safe !== OMIT) result[key] = safe;
  }
  seen.delete(value);
  return result;
}

function safeUi(value) {
  return plain(value) ? safeValue(value) : {};
}

function cleanSettings(value) {
  const result = { ...DEFAULT_SETTINGS };
  if (!plain(value)) return result;
  if (value.theme === 'light' || value.theme === 'dark') result.theme = value.theme;
  if (Number.isFinite(value.sidebarWidth)) result.sidebarWidth = clamp(Math.round(value.sidebarWidth), RESIZE_LIMITS.sidebar.min, RESIZE_LIMITS.sidebar.max);
  if (Number.isFinite(value.assistantWidth)) result.assistantWidth = clamp(Math.round(value.assistantWidth), RESIZE_LIMITS.assistant.min, RESIZE_LIMITS.assistant.max);
  for (const key of ['sidebarCollapsed', 'assistantOpen']) if (typeof value[key] === 'boolean') result[key] = value[key];
  return result;
}

function cleanReference(value) {
  if (!plain(value)) return null;
  const collection = string(value.collection, 128);
  const recordId = string(value.recordId);
  if (!collection || !recordId) return null;
  const result = { collection, recordId, title: string(value.title, 160) ?? recordId };
  const view = string(value.view, 128);
  if (view) result.view = view;
  return result;
}

function cleanTab(value) {
  if (!plain(value) || !['view', 'record', 'compose'].includes(value.kind)) return null;
  const result = { id: string(value.id) ?? identifier('tab'), kind: value.kind, title: string(value.title, 160) ?? 'Untitled', pinned: value.pinned === true };
  if (value.kind === 'view') {
    const view = string(value.view, 128);
    if (!view) return null;
    result.view = view;
  } else if (value.kind === 'record') {
    const reference = cleanReference(value);
    if (!reference) return null;
    Object.assign(result, reference);
  }
  if (plain(value.ui)) result.ui = safeUi(value.ui);
  return result;
}

const overview = () => ({ id: identifier('tab'), kind: 'view', view: 'overview', title: 'Overview', pinned: false });
function makePane(tab = overview(), column = 0, row = 0) {
  return { id: identifier('pane'), column, row, tabs: [tab], activeTabId: tab.id };
}
function makeSpace() {
  const pane = makePane();
  return { panes: [pane], activePaneId: pane.id, favorites: [], savedSearches: [], assistantDraft: '', columnWidths: [100], rowWeights: { 0: [100] } };
}

// Store percentages, while accepting either percentage values or relative weights.
function weights(value, count, minimum) {
  if (count < 2) return [100];
  const raw = Array.from({ length: count }, (_, i) => Array.isArray(value) && Number.isFinite(value[i]) && value[i] > 0 ? value[i] : 1);
  if (raw.every(weight => weight >= minimum) && Math.abs(raw.reduce((sum, weight) => sum + weight, 0) - 100) < 0.00000001) return raw;
  const largest = Math.max(...raw);
  const input = raw.map(weight => weight / largest);
  const result = Array(count).fill(0);
  let pending = input.map((_, i) => i);
  let remaining = 100;
  while (pending.length) {
    const total = pending.reduce((sum, i) => sum + input[i], 0);
    const below = pending.filter(i => input[i] / total * remaining < minimum);
    if (!below.length) {
      for (const i of pending) result[i] = input[i] / total * remaining;
      break;
    }
    for (const i of below) { result[i] = minimum; remaining -= minimum; }
    pending = pending.filter(i => !below.includes(i));
  }
  return result;
}

function normalize(space) {
  space.panes = space.panes.filter(pane => pane.tabs.length > 0);
  if (!space.panes.length) space.panes.push(makePane());
  const columns = [...new Set(space.panes.map(pane => pane.column))].sort((a, b) => a - b);
  const oldWidths = space.columnWidths;
  const oldRows = space.rowWeights;
  const rowWeights = {};
  for (const [column, previous] of columns.entries()) {
    const panes = space.panes.filter(pane => pane.column === previous).sort((a, b) => a.row - b.row);
    rowWeights[column] = weights(oldRows?.[previous], panes.length, 33);
    for (const [row, pane] of panes.entries()) { pane.column = column; pane.row = row; }
  }
  space.columnWidths = weights(columns.map(column => oldWidths?.[column]), columns.length, 22);
  space.rowWeights = rowWeights;
  space.panes.sort((a, b) => a.column - b.column || a.row - b.row);
  for (const pane of space.panes) {
    pane.tabs = [...pane.tabs.filter(tab => tab.pinned), ...pane.tabs.filter(tab => !tab.pinned)];
    if (!pane.tabs.some(tab => tab.id === pane.activeTabId)) pane.activeTabId = pane.tabs[0].id;
  }
  if (!space.panes.some(pane => pane.id === space.activePaneId)) space.activePaneId = space.panes[0].id;
  return space;
}

function cleanSpace(value) {
  if (!plain(value) || !Array.isArray(value.panes)) return makeSpace();
  const panes = [];
  const paneIds = new Set();
  const tabIds = new Set();
  const occupied = new Set();
  for (const raw of value.panes.slice(0, MAX_COLUMNS * MAX_ROWS)) {
    if (!plain(raw) || !Array.isArray(raw.tabs)) continue;
    const column = Number.isInteger(raw.column) && raw.column >= 0 && raw.column < MAX_COLUMNS ? raw.column : 0;
    const row = Number.isInteger(raw.row) && raw.row >= 0 && raw.row < MAX_ROWS ? raw.row : 0;
    if (occupied.has(`${column}:${row}`)) continue;
    const tabs = [];
    for (const item of raw.tabs.slice(0, MAX_TABS)) {
      const tab = cleanTab(item);
      if (!tab || tabIds.has(tab.id) || tabs.some(existing => sameTab(existing, tab))) continue;
      tabIds.add(tab.id);
      tabs.push(tab);
    }
    if (!tabs.length) continue;
    let id = string(raw.id) ?? identifier('pane');
    if (paneIds.has(id)) id = identifier('pane');
    paneIds.add(id);
    occupied.add(`${column}:${row}`);
    panes.push({ id, column, row, tabs, activeTabId: string(raw.activeTabId) ?? tabs[0].id });
  }
  const favorites = [];
  for (const raw of Array.isArray(value.favorites) ? value.favorites.slice(0, 100) : []) {
    const reference = cleanReference(raw);
    if (reference && !favorites.some(item => sameRecord(item, reference))) favorites.push({ id: string(raw.id) ?? identifier('favorite'), ...reference });
  }
  const savedSearches = [];
  for (const raw of Array.isArray(value.savedSearches) ? value.savedSearches.slice(0, 50) : []) {
    const query = plain(raw) && string(raw.query, 500)?.trim();
    if (query && !savedSearches.some(item => item.query.toLowerCase() === query.toLowerCase())) savedSearches.push({ id: string(raw.id) ?? identifier('search'), query });
  }
  return normalize({ panes, activePaneId: string(value.activePaneId), favorites, savedSearches, assistantDraft: typeof value.assistantDraft === 'string' ? value.assistantDraft.slice(0, 20000) : '', columnWidths: value.columnWidths, rowWeights: plain(value.rowWeights) ? value.rowWeights : {} });
}

const sameRecord = (a, b) => a.collection === b.collection && a.recordId === b.recordId;
const sameTab = (a, b) => a.kind === b.kind && (a.kind === 'view' ? a.view === b.view : a.kind === 'record' && sameRecord(a, b));
function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export class WorkspaceStore {
  constructor({ storage = defaultStorage(), key = DEFAULT_KEY } = {}) {
    this.storage = storage;
    this.key = string(key) ?? DEFAULT_KEY;
    this._settings = { ...DEFAULT_SETTINGS };
    this._spaces = Object.create(null);
    this._closed = Object.create(null);
    try {
      const serialized = storage?.getItem(this.key);
      if (typeof serialized !== 'string' || serialized.length > 2000000) return;
      const data = JSON.parse(serialized);
      if (!plain(data) || data.version !== VERSION) return;
      this._settings = cleanSettings(data.settings);
      if (plain(data.spaces)) for (const worldId of Object.keys(data.spaces).slice(0, 100)) {
        if (!string(worldId) || worldId.length > 256) continue;
        this._spaces[worldId] = cleanSpace(data.spaces[worldId]);
        const entries = plain(data.closedTabs) && own(data.closedTabs, worldId) && Array.isArray(data.closedTabs[worldId]) ? data.closedTabs[worldId] : [];
        this._closed[worldId] = entries.slice(-MAX_CLOSED).flatMap(entry => {
          const tab = plain(entry) && cleanTab(entry.tab);
          return tab ? [{ tab, paneId: string(entry.paneId), index: indexAt(entry.index, MAX_TABS) }] : [];
        });
      }
    } catch { /* Malformed or unavailable storage must not prevent opening the app. */ }
  }

  get settings() { return this._settings; }

  getSpace(worldId) {
    if (typeof worldId !== 'string' || !worldId.trim() || worldId.length > 256) throw new TypeError('worldId must be a non-empty string of at most 256 characters.');
    if (!own(this._spaces, worldId)) {
      this._spaces[worldId] = makeSpace();
      this._closed[worldId] = [];
      this.persist();
    }
    return this._spaces[worldId];
  }

  _pane(space, paneId = space.activePaneId) { return space.panes.find(pane => pane.id === paneId); }
  _commit(space) { normalize(space); this.persist(); }
  _open(worldId, value) {
    const space = this.getSpace(worldId);
    const pane = this._pane(space);
    const existing = pane.tabs.find(tab => sameTab(tab, value));
    if (existing) {
      pane.activeTabId = existing.id;
      this.persist();
      return existing;
    }
    if (pane.tabs.length >= MAX_TABS) return null;
    const tab = cleanTab({ id: identifier('tab'), ...value });
    if (!tab) return null;
    pane.tabs.push(tab);
    pane.activeTabId = tab.id;
    this._commit(space);
    return tab;
  }

  openView(worldId, view, title = view) {
    return string(view, 128) ? this._open(worldId, { kind: 'view', view, title }) : null;
  }

  openRecord(worldId, reference) {
    const safe = cleanReference(reference);
    return safe ? this._open(worldId, { kind: 'record', ...safe }) : null;
  }

  openCompose(worldId, title = 'New message') {
    return this._open(worldId, { kind: 'compose', title });
  }

  activateTab(worldId, paneId, tabId) {
    const space = this.getSpace(worldId);
    const pane = this._pane(space, paneId);
    if (!pane?.tabs.some(tab => tab.id === tabId)) return false;
    pane.activeTabId = tabId;
    space.activePaneId = pane.id;
    this.persist();
    return true;
  }

  closeTab(worldId, paneId, tabId) {
    const space = this.getSpace(worldId);
    const pane = this._pane(space, paneId);
    const index = pane?.tabs.findIndex(tab => tab.id === tabId) ?? -1;
    if (index < 0) return false;
    const [tab] = pane.tabs.splice(index, 1);
    this._closed[worldId].push({ tab, paneId, index });
    this._closed[worldId] = this._closed[worldId].slice(-MAX_CLOSED);
    if (pane.activeTabId === tabId) pane.activeTabId = pane.tabs[Math.min(index, pane.tabs.length - 1)]?.id ?? null;
    this._commit(space);
    return true;
  }

  reopenTab(worldId) {
    const space = this.getSpace(worldId);
    const entry = this._closed[worldId].pop();
    if (!entry) return null;
    const pane = this._pane(space, entry.paneId) ?? this._pane(space);
    const existing = pane.tabs.find(tab => sameTab(tab, entry.tab) || tab.id === entry.tab.id);
    if (!existing && pane.tabs.length >= MAX_TABS) {
      this._closed[worldId].push(entry);
      return null;
    }
    const tab = existing ?? cleanTab(entry.tab);
    if (!existing) pane.tabs.splice(indexAt(entry.index, pane.tabs.length), 0, tab);
    pane.activeTabId = tab.id;
    space.activePaneId = pane.id;
    this._commit(space);
    return tab;
  }

  splitTab(worldId, paneId, tabId, direction = 'right') {
    const space = this.getSpace(worldId);
    const source = this._pane(space, paneId);
    const tabIndex = source?.tabs.findIndex(tab => tab.id === tabId) ?? -1;
    if (tabIndex < 0 || !['right', 'left', 'top', 'bottom'].includes(direction)) return null;
    const vertical = direction === 'top' || direction === 'bottom';
    const columnCount = space.columnWidths.length;
    const siblings = space.panes.filter(pane => pane.column === source.column);
    if (vertical ? siblings.length >= MAX_ROWS : columnCount >= MAX_COLUMNS) return null;
    const [tab] = source.tabs.splice(tabIndex, 1);
    if (!source.tabs.length) source.tabs.push(overview());
    if (source.activeTabId === tabId) source.activeTabId = source.tabs[Math.min(tabIndex, source.tabs.length - 1)].id;
    let column = source.column;
    let row = direction === 'bottom' ? 1 : 0;
    if (vertical) {
      source.row = direction === 'top' ? 1 : 0;
      space.rowWeights[column] = [50, 50];
    } else {
      column += direction === 'right' ? 1 : 0;
      const widths = [...space.columnWidths];
      widths[source.column] /= 2;
      widths.splice(column, 0, widths[source.column]);
      const rowWeights = {};
      for (const [previous, values] of Object.entries(space.rowWeights)) rowWeights[Number(previous) >= column ? Number(previous) + 1 : previous] = values;
      rowWeights[column] = [100];
      for (const pane of space.panes) if (pane.column >= column) pane.column++;
      space.columnWidths = widths;
      space.rowWeights = rowWeights;
    }
    const target = makePane(tab, column, row);
    space.panes.push(target);
    space.activePaneId = target.id;
    this._commit(space);
    return target;
  }

  moveTab(worldId, fromPaneId, toPaneId, tabId, index) {
    if (fromPaneId === toPaneId) return this.reorderTab(worldId, fromPaneId, tabId, index);
    const space = this.getSpace(worldId);
    const from = this._pane(space, fromPaneId);
    const to = this._pane(space, toPaneId);
    const previousIndex = from?.tabs.findIndex(tab => tab.id === tabId) ?? -1;
    if (!to || previousIndex < 0) return false;
    const original = from.tabs[previousIndex];
    const existing = to.tabs.find(tab => sameTab(tab, original));
    if (!existing && to.tabs.length >= MAX_TABS) return false;
    from.tabs.splice(previousIndex, 1);
    if (!existing) to.tabs.splice(indexAt(index, to.tabs.length), 0, original);
    if (from.activeTabId === tabId) from.activeTabId = from.tabs[Math.min(previousIndex, from.tabs.length - 1)]?.id ?? null;
    to.activeTabId = (existing ?? original).id;
    space.activePaneId = to.id;
    this._commit(space);
    return true;
  }

  reorderTab(worldId, paneId, tabId, index) {
    const space = this.getSpace(worldId);
    const pane = this._pane(space, paneId);
    const previousIndex = pane?.tabs.findIndex(tab => tab.id === tabId) ?? -1;
    if (previousIndex < 0) return false;
    const [tab] = pane.tabs.splice(previousIndex, 1);
    const pinnedCount = pane.tabs.filter(item => item.pinned).length;
    const targetIndex = tab.pinned ? clamp(indexAt(index, pane.tabs.length), 0, pinnedCount) : clamp(indexAt(index, pane.tabs.length), pinnedCount, pane.tabs.length);
    pane.tabs.splice(targetIndex, 0, tab);
    this._commit(space);
    return true;
  }

  togglePin(worldId, paneId, tabId) {
    const space = this.getSpace(worldId);
    const tab = this._pane(space, paneId)?.tabs.find(item => item.id === tabId);
    if (!tab) return false;
    tab.pinned = !tab.pinned;
    this._commit(space);
    return tab.pinned;
  }

  updateTab(worldId, tabId, patch) {
    const space = this.getSpace(worldId);
    const tab = space.panes.flatMap(pane => pane.tabs).find(item => item.id === tabId);
    if (!tab || !plain(patch)) return null;
    if (string(patch.title, 160)) tab.title = string(patch.title, 160);
    if (typeof patch.pinned === 'boolean') tab.pinned = patch.pinned;
    if (plain(patch.ui)) tab.ui = safeUi({ ...tab.ui, ...patch.ui });
    this._commit(space);
    return tab;
  }

  updateSettings(patch, { persist = true } = {}) {
    if (plain(patch)) {
      const safe = {};
      if (patch.theme === 'light' || patch.theme === 'dark') safe.theme = patch.theme;
      if (Number.isFinite(patch.sidebarWidth)) safe.sidebarWidth = patch.sidebarWidth;
      if (Number.isFinite(patch.assistantWidth)) safe.assistantWidth = patch.assistantWidth;
      for (const field of ['sidebarCollapsed', 'assistantOpen']) if (typeof patch[field] === 'boolean') safe[field] = patch[field];
      this._settings = cleanSettings({ ...this._settings, ...safe });
    }
    if (persist) this.persist();
    return this._settings;
  }

  updateAssistantDraft(worldId, instruction) {
    const space = this.getSpace(worldId);
    if (typeof instruction === 'string') {
      space.assistantDraft = instruction.slice(0, 20000);
      this.persist();
    }
    return space.assistantDraft;
  }

  updateLayout(worldId, patch, { persist = true } = {}) {
    const space = this.getSpace(worldId);
    if (!plain(patch)) return space;
    if (Array.isArray(patch.columnWidths)) space.columnWidths = weights(patch.columnWidths, space.columnWidths.length, 22);
    if (plain(patch.rowWeights) || Array.isArray(patch.rowWeights)) {
      for (let column = 0; column < space.columnWidths.length; column++) {
        if (own(patch.rowWeights, column)) space.rowWeights[column] = weights(patch.rowWeights[column], space.panes.filter(pane => pane.column === column).length, 33);
      }
    }
    normalize(space);
    if (persist) this.persist();
    return space;
  }

  toggleFavorite(worldId, reference) {
    const space = this.getSpace(worldId);
    const safe = cleanReference(reference);
    if (!safe) return false;
    const index = space.favorites.findIndex(item => sameRecord(item, safe));
    if (index >= 0) space.favorites.splice(index, 1);
    else if (space.favorites.length < 100) space.favorites.push({ id: identifier('favorite'), ...safe });
    else return false;
    this.persist();
    return index < 0;
  }

  saveSearch(worldId, query) {
    const space = this.getSpace(worldId);
    const safe = string(query, 500)?.trim();
    if (!safe) return null;
    const existing = space.savedSearches.find(item => item.query.toLowerCase() === safe.toLowerCase());
    if (existing) return existing;
    const result = { id: identifier('search'), query: safe };
    space.savedSearches.push(result);
    space.savedSearches = space.savedSearches.slice(-50);
    this.persist();
    return result;
  }

  removeSearch(worldId, id) {
    const space = this.getSpace(worldId);
    const index = space.savedSearches.findIndex(item => item.id === id);
    if (index < 0) return false;
    space.savedSearches.splice(index, 1);
    this.persist();
    return true;
  }

  persist() {
    try {
      if (!this.storage || typeof this.storage.setItem !== 'function') return false;
      const spaces = Object.create(null);
      const closedTabs = Object.create(null);
      for (const [worldId, space] of Object.entries(this._spaces)) {
        spaces[worldId] = cleanSpace(space);
        closedTabs[worldId] = this._closed[worldId].slice(-MAX_CLOSED).map(entry => ({ tab: cleanTab(entry.tab), paneId: entry.paneId, index: entry.index }));
      }
      this.storage.setItem(this.key, JSON.stringify({ version: VERSION, settings: cleanSettings(this._settings), spaces, closedTabs }));
      return true;
    } catch { return false; }
  }
}

export const initialized = options => new WorkspaceStore(options);

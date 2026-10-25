import { Folder, TextControl, SelectControl, ButtonGroup, Slider, Toggle } from 'dialkit/vanilla';
import { WorkspaceStore, RESIZE_LIMITS } from './workspace.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { renderAuditView, renderAuditRecord, cachedAuditEvent, invalidateAudit } from './audit-view.js';
import { describeAuditEvent } from './audit-tree.js';
import { mountAgentStatus, describeAgentStatus } from './agent-status.js';
import { renderWork, renderWorkItem } from './work-view.js';
import { renderBooks, syncBooksFrames } from './books-view.js';
import 'dialkit/vanilla/styles.css';
import './style.css';

// DialKit owns the controls; the workbench gives them company-scoped context.
let renderContext = null;
const folderStates = new Map();
class Surface {
  constructor(host, key = '', context = renderContext) { this.host = host; this.children = []; this.key = key; this.context = context; this.controlCounts = new Map(); }
  identify(node, type, label) {
    const name = type + ':' + label, count = this.controlCounts.get(name) || 0; this.controlCounts.set(name, count + 1);
    node.dataset.focusKey = (this.context?.world || 'shell') + ':' + this.key + ':' + name + ':' + count;
    return node;
  }
  keep(component) { this.children.push(component); return component; }
  slot(className = '') { const node = document.createElement('div'); node.className = className; this.host.append(node); return node; }
  clear() { this.children.splice(0).reverse().forEach(child => child.destroy()); this.host.replaceChildren(); this.controlCounts.clear(); }
  destroy() { this.clear(); }
  folder(title, { root = false, open = true, wide = false } = {}) {
    const host = this.slot(root ? 'panel-host' + (wide ? ' span-all' : '') : '');
    const key = this.key + '/' + title;
    const component = this.keep(Folder(host, { title, isRoot: root, inline: true, defaultOpen: folderStates.get(key) ?? open, onOpenChange: value => folderStates.set(key, value) }));
    if (root) { const heading = host.querySelector('.dialkit-folder-title-root'); heading.setAttribute('role', 'heading'); heading.setAttribute('aria-level', '2'); }
    const header = host.querySelector('.dialkit-folder-header-top[role="button"]'); if (header) this.identify(header, 'folder', title);
    const surface = new Surface(component.body, key, this.context); this.keep(surface); return surface;
  }
  text(label, value, onChange, placeholder = '') {
    const host = this.slot(onChange ? 'editable' : 'read-only');
    const props = { label, value: printable(value), onChange: value => { if (onChange) contextual(this.context, () => { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); host.removeAttribute('data-invalid'); if (state.noticeError) notify('Ready'); onChange(value); }); }, placeholder };
    const component = this.keep(TextControl(host, props));
    const input = host.querySelector('textarea');
    input.setAttribute('aria-label', label); this.identify(input, 'text', label);
    if (!onChange) { input.readOnly = true; input.tabIndex = -1; input.setAttribute('aria-readonly', 'true'); }
    return { set(value) { props.value = printable(value); component.update(props); }, input, host };
  }
  select(label, value, options, onChange) {
    const host = this.slot();
    let props = { label, value, options, onChange: value => { if (state.busy) return; props.value = value; component.update(props); contextual(this.context, () => onChange(value)); } };
    const component = this.keep(SelectControl(host, props));
    this.identify(host.querySelector('button'), 'select', label);
    return component;
  }
  slider(label, value, min, max, step, onChange) {
    const host = this.slot();
    let props = { label, value, min, max, step, onChange: value => { if (state.busy) return; props.value = value; component.update(props); contextual(this.context, () => onChange(value)); } };
    const component = this.keep(Slider(host, props)); host.querySelectorAll('input, [role="slider"]').forEach((node, i) => this.identify(node, 'slider-' + i, label)); return component;
  }
  toggle(label, checked, onChange) {
    const host = this.slot();
    let props = { label, checked, onChange: value => { if (state.busy) return; props.checked = value; component.update(props); contextual(this.context, () => onChange(value)); } };
    const component = this.keep(Toggle(host, props)); host.querySelectorAll('button, [role="switch"]').forEach((node, i) => this.identify(node, 'toggle-' + i, label)); return component;
  }
  buttons(items) {
    const host = this.slot();
    this.keep(ButtonGroup(host, { buttons: items.map(item => ({ label: item[0], onClick: () => {
      if (!item[2]) void perform(item[0], () => contextual(this.context, item[1], true), host);
    } })) }));
    host.querySelectorAll('button').forEach((button, i) => { button.type = 'button'; button.disabled = Boolean(items[i][2]); this.identify(button, 'button', items[i][0]); });
    return host;
  }
  action(label, onClick, options = {}) {
    const host = this.buttons([[label, onClick, options.disabled]]);
    host.className = options.className || 'nav-item';
    const button = host.querySelector('button');
    const text = document.createElement('span'); text.className = 'button-label'; text.textContent = label;
    button.replaceChildren(...(options.icon ? [icon(options.icon)] : []), text);
    button.title = options.title || label; button.setAttribute('aria-label', options.title || label);
    if (options.meta !== undefined) { const meta = document.createElement('span'); meta.className = 'button-meta'; meta.textContent = options.meta; button.append(meta); }
    if (options.active) { host.classList.add('active'); button.setAttribute('aria-current', 'page'); }
    return button;
  }
}
const printable = value => value === undefined || value === null ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const pretty = value => String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, c => c.toUpperCase());
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100);
const list = value => Array.isArray(value) ? value : [];
const root = new Surface(document.querySelector('#app'));
const state = { boot: null, snapshot: null, world: '', view: 'overview', busy: false, notice: 'Loading…', draft: {}, finance: 'payments', recordSystem: 'gmail', recordFeed: 'message', records: null, detail: null, page: {}, search: {}, compose: null, generated: null, files: [] };
const views = ['overview', 'work', 'connections', 'mailbox', 'finance', 'books', 'procurement', 'sources', 'agent', 'delivery', 'audit', 'create', 'documents', 'favorites', 'settings'];
const labels = { overview: 'Overview', work: 'Work', connections: 'Connections', mailbox: 'Inbox', finance: 'Money', books: 'Books', procurement: 'Purchasing', sources: 'Data sources', agent: 'Agent', delivery: 'Notifications', audit: 'Audit trail', create: 'New company', documents: 'Files', favorites: 'Favorites', settings: 'Settings' };
let rail, content, statusControl, detailSurface, resultControl;
const workspace = new WorkspaceStore();
const tabState = new Map(), transientRecords = new Map();
const tabStripScroll = new Map();
const scrollPositions = new Map(), assistantViews = new Map();
const agentStatusViews = new Set(), stoppingRuns = new Set();
const uiKeys = ['draft', 'finance', 'recordSystem', 'recordFeed', 'page', 'search', 'compose', 'generated', 'mailFilter', 'scroll', 'booksPath'];
const runtimeKeys = [...uiKeys, 'files', 'records', 'detail'];
let activeContext = null, rendering = false, menuSurface = null, searchSurface = null, toastTimer, pendingFocus = null, focusSelectedTab = false, deferredRender = false, forceFocus = false;
const narrowScreen = matchMedia('(max-width: 799px)');
const compactScreen = matchMedia('(max-width: 1015px)');
let mobileRailOpen = false;
function updateResponsiveLayout() {
  mobileRailOpen = false;
  if (!state.boot) return;
  if (state.busy) { deferredRender = true; return; }
  const input = searchSurface?.host.querySelector('textarea[aria-label="Search"]');
  const search = input && { query: input.value, start: input.selectionStart, end: input.selectionEnd, origin: searchSurface.returnFocus };
  render();
  if (search) { openSearch(search.query); searchSurface.returnFocus = search.origin; searchSurface.host.querySelector('textarea[aria-label="Search"]').setSelectionRange(search.start, search.end); }
}
narrowScreen.addEventListener('change', updateResponsiveLayout);
compactScreen.addEventListener('change', updateResponsiveLayout);
const spaceId = () => state.world || 'new-company';
const space = () => workspace.getSpace(spaceId());
const activePane = () => space().panes.find(p => p.id === space().activePaneId) || space().panes[0];
const currentTab = () => activePane()?.tabs.find(t => t.id === activePane().activeTabId);
const interacting = () => document.body.classList.contains('is-resizing') || searchSurface || menuSurface || document.querySelector('.dialkit-select-dropdown') || document.activeElement?.matches('textarea:not([readonly]), input') || (getSelection()?.rangeCount && !getSelection().isCollapsed);
const getTab = context => workspace.getSpace(context.world).panes.find(p => p.id === context.pane)?.tabs.find(t => t.id === context.tab);
function saveContext() {
  if (!activeContext || activeContext.world !== spaceId()) return;
  const saved = Object.fromEntries(runtimeKeys.map(key => [key, state[key]]));
  tabState.set(activeContext.world + ':' + activeContext.tab, saved);
  workspace.updateTab(activeContext.world, activeContext.tab, { ui: Object.fromEntries(uiKeys.map(key => [key, state[key]])) });
}
function useContext(context, activate = false) {
  if (!context || context.world !== spaceId() || !getTab(context)) return;
  saveContext();
  const tab = getTab(context), key = context.world + ':' + context.tab;
  let saved = tabState.get(key);
  if (!saved) { saved = { draft: {}, finance: records('payments').length ? 'payments' : records('bills').length ? 'bills' : 'bankTransactions', recordSystem: 'gmail', recordFeed: 'message', page: {}, search: {}, compose: null, generated: null, mailFilter: 'all', ...tab.ui, files: [], records: null, detail: null }; tabState.set(key, saved); }
  Object.assign(state, saved); state.view = tab.kind === 'view' ? tab.view : tab.kind === 'compose' ? 'mailbox' : tab.view || 'finance';
  activeContext = context; renderContext = context;
  if (activate) workspace.activateTab(context.world, context.pane, context.tab);
}
function contextual(context, work, whileBusy = false) {
  if (state.busy && !whileBusy) return;
  if (context && (context.world !== spaceId() || !getTab(context))) return;
  if (context) useContext(context, true);
  const result = work(); saveContext();
  if (result?.then) return result.finally(saveContext);
  return result;
}
function child(parent, className, key = '', context = parent.context) { const s = new Surface(parent.slot(className), key || parent.key + '/' + className.split(' ')[0], context); parent.keep(s); return s; }
function trackScroll(surface, key, label) {
  const node = surface.host, saved = key ? scrollPositions.get(key) || 0 : node.scrollTop;
  if (key) node.dataset.scrollKey = key;
  surface.identify(node, 'scroll', label);
  if (!node.hasAttribute('role')) node.setAttribute('role', 'region'); node.setAttribute('aria-label', label);
  node.tabIndex = -1;
  const update = () => {
    const overflows = node.scrollHeight > node.clientHeight + 1;
    node.dataset.scrollable = String(overflows); node.dataset.scrolled = String(node.scrollTop > 1);
    node.dataset.atEnd = String(node.scrollTop + node.clientHeight >= node.scrollHeight - 2);
    node.tabIndex = overflows ? 0 : -1;
  };
  const scroll = () => { if (key && node.getClientRects().length) scrollPositions.set(key, node.scrollTop); update(); };
  node.addEventListener('scroll', scroll, { passive: true });
  const observer = new ResizeObserver(update); observer.observe(node);
  for (const child of node.children) observer.observe(child);
  const frame = requestAnimationFrame(() => { node.scrollTop = saved; update(); });
  surface.keep({ destroy() { cancelAnimationFrame(frame); observer.disconnect(); node.removeEventListener('scroll', scroll); } });
}
function captureFocus() {
  const node = document.activeElement;
  if (!node?.dataset.focusKey) return null;
  const pane = node.closest('.workspace-pane'), tab = pane?.querySelector('[role="tab"][aria-selected="true"]')?.closest('[data-tab]')?.dataset.tab;
  return { key: node.dataset.focusKey, tab: tab || currentTab()?.id, world: spaceId(), start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection };
}
function restoreFocus(saved) {
  if (state.busy) return;
  if (searchSurface || menuSurface) { pendingFocus = null; focusSelectedTab = false; forceFocus = false; return; }
  const existing = document.activeElement;
  if (!forceFocus && !focusSelectedTab && existing && existing !== document.body && existing.isConnected && existing.getClientRects().length && getComputedStyle(existing).visibility !== 'hidden' && !existing.closest('[inert]')) { pendingFocus = null; return; }
  let target;
  if (!focusSelectedTab && saved && saved.tab === currentTab()?.id && saved.world === spaceId()) target = [...document.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === saved.key && !node.disabled && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[inert], [hidden], [aria-hidden="true"]'));
  if (narrowScreen.matches && mobileRailOpen) target = document.querySelector('.rail button');
  if (!target && (focusSelectedTab || saved)) target = document.querySelector('.active-pane [role="tab"][aria-selected="true"]');
  target?.focus({ preventScroll: true });
  if (forceFocus && target?.getAttribute('aria-invalid') === 'true') target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (target && saved && target.dataset.focusKey === saved.key && typeof saved.start === 'number' && typeof target.setSelectionRange === 'function') target.setSelectionRange(saved.start, saved.end, saved.direction);
  pendingFocus = null; focusSelectedTab = false; forceFocus = false;
}
function recordTitle(row) { return row.subject || row.name || row.invoice_number || row.description || row.reference || (row.type ? pretty(row.type) : '') || row.id || 'Record'; }
function recordRef(value, title) {
  if (Number.isSafeInteger(value?.seq) && value.world_id === spaceId() && value.type) return { collection: 'audit', recordId: String(value.seq), title: describeAuditEvent(value).title, view: 'audit' };
  for (const [collection, rows] of Object.entries(world())) if (Array.isArray(rows) && value?.id && rows.some(r => r.id === value.id)) return { collection, recordId: value.id, title: recordTitle(value), view: collection === 'messages' ? 'mailbox' : collection === 'documents' ? 'documents' : 'finance' };
  if (value?.id && state.snapshot?.runs.some(r => r.id === value.id)) return { collection: 'runs', recordId: value.id, title: title || 'Agent run', view: 'agent' };
  const id = crypto.randomUUID(); transientRecords.set(spaceId() + ':' + id, value); return { collection: 'inspection', recordId: id, title: title || 'Details', view: state.view };
}
function resolveRecord(tab) {
  if (tab.collection === 'audit') return cachedAuditEvent(spaceId(), Number(tab.recordId));
  if (tab.collection === 'inspection') return transientRecords.get(spaceId() + ':' + tab.recordId);
  if (tab.collection === 'runs') return state.snapshot?.runs.find(r => r.id === tab.recordId);
  return records(tab.collection).find(r => String(r.id) === tab.recordId);
}
const world = () => state.snapshot?.world || {};
const records = key => list(world()[key]);
const systems = () => list(state.boot?.systems);
const path = suffix => { if (!state.world) throw Error('Create or select a world first.'); return '/api/worlds/' + encodeURIComponent(state.world) + (suffix || ''); };
const choices = rows => rows.map(row => ({ value: row.id, label: row.name || row.subject || row.id }));
const draft = (key, defaults) => state.draft[key] ||= { ...defaults };
function notify(message, error = false) {
  state.notice = message; state.noticeError = error; statusControl?.set(message);
  const announcement = document.querySelector('#gram-announcement'); if (announcement) { announcement.setAttribute('aria-live', error ? 'assertive' : 'polite'); announcement.textContent = message === 'Ready' ? '' : message; }
  const toast = document.querySelector('.status-toast');
  if (toast) { toast.classList.toggle('quiet', message === 'Ready'); toast.dataset.error = String(error); }
  clearTimeout(toastTimer);
  if (message !== 'Ready' && !error) toastTimer = setTimeout(() => { if (state.notice === message && !state.noticeError) notify('Ready'); }, 5000);
}
function invalid(field, message) { throw Object.assign(Error(message), { field }); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(45000), headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => { throw Error('Unreadable service response (' + response.status + ').'); });
  if (!response.ok) {
    const error = Error(data.error?.message || 'Request failed'); error.status = response.status; error.code = data.error?.code;
    // The service was restarted on another database: the session is gone. Start one again, once.
    if (response.status === 401 && data.error?.code === 'authentication_required' && !sessionStorage.getItem('gram-reauth')) { sessionStorage.setItem('gram-reauth', '1'); location.assign('/'); }
    throw error;
  }
  if (url === '/api/bootstrap') sessionStorage.removeItem('gram-reauth');
  return data;
}
const post = (url, data = {}, options = {}) => api(url, { method: 'POST', body: JSON.stringify(data), ...options });
async function perform(label, work, host) {
  if (state.busy) return;
  pendingFocus = captureFocus();
  state.busy = true; const buttons = [...(host?.querySelectorAll('button') || [])]; const disabled = buttons.map(b => b.disabled);
  document.querySelector('.workspace')?.setAttribute('inert', '');
  buttons.forEach(b => { b.disabled = true; });
  const busyTimer = setTimeout(() => buttons.forEach(b => { if (b.isConnected) b.setAttribute('aria-busy', 'true'); }), 150);
  try { await work(); }
  catch (error) {
    notify(error.message === error.code ? pretty(error.code) : error.message, true);
    const field = error.field && [...document.querySelectorAll('.active-pane textarea:not([readonly])')].find(input => input.getAttribute('aria-label') === error.field);
    if (field) { field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', 'gram-announcement'); field.closest('.editable')?.setAttribute('data-invalid', 'true'); pendingFocus = { key: field.dataset.focusKey, world: spaceId(), tab: currentTab()?.id, start: 0, end: field.value.length, direction: 'none' }; focusSelectedTab = false; forceFocus = true; }
  }
  finally { clearTimeout(busyTimer); state.busy = false; document.querySelector('.workspace')?.toggleAttribute('inert', Boolean(searchSurface)); buttons.forEach((b, i) => { b.disabled = disabled[i]; b.removeAttribute('aria-busy'); }); if (deferredRender) { deferredRender = false; render(); } restoreFocus(pendingFocus); }
}
const uncertain = new Map();
async function act(input) {
  const identity = state.world + ':' + JSON.stringify(input);
  const key = uncertain.get(identity) || crypto.randomUUID(); uncertain.set(identity, key);
  const result = await post(path('/actions'), input, { headers: { 'Idempotency-Key': key } });
  uncertain.delete(identity); state.lastResult = result;
  await refresh();
  notify(pretty(input.type) + ' · ' + (result.result?.operation?.status || result.result?.status || 'saved'));
  return result;
}
/** The snapshot, plus the seat's dispatcher and Slack status for companies with a seat. */
async function loadSnapshot(id) {
  const snapshot = await api(path()); if (state.world !== id) return;
  const [status, slack] = snapshot.world.seat ? await Promise.all([api(path('/work/status')), api(path('/work/slack'))]) : [null, null];
  if (state.world !== id) return;
  state.snapshot = snapshot; state.seatStatus = status; state.slackStatus = slack; return snapshot;
}
async function refresh(background = false) {
  const id = state.world;
  if (!background && id) invalidateAudit(id);
  if (id) {
    const snapshot = await loadSnapshot(id); if (!snapshot) return;
    for (const run of snapshot.runs) if (run.status !== 'running') stoppingRuns.delete(run.id);
    for (const entry of agentStatusViews) {
      if (entry.world !== id) continue;
      const run = snapshot.runs.find(run => run.id === entry.id);
      if (run) entry.component.update(run);
    }
  }
  if (background && (state.busy || interacting())) { deferredRender = true; return; }
  deferredRender = false;
  render();
}
async function chooseWorld(id) {
  focusSelectedTab = true;
  mobileRailOpen = false;
  saveContext(); activeContext = null; renderContext = null;
  state.world = id; state.snapshot = null; state.detail = null; state.records = null; state.draft = {}; state.files = []; state.page = {}; state.lastResult = null;
  localStorage.setItem('finance-world-id', id);
  const url = new URL(location.href); url.search = new URLSearchParams({ world: id, view: state.view }).toString(); history.replaceState({}, '', url);
  await refresh();
}
async function go(view) {
  focusSelectedTab = true;
  mobileRailOpen = false;
  saveContext(); state.view = view; workspace.openView(spaceId(), view, labels[view] || view); state.detail = null; localStorage.setItem('finance-world-tab', view);
  const url = new URL(location.href); url.searchParams.set('view', view); ['connected', 'error', 'oauth_error'].forEach(key => url.searchParams.delete(key)); history.replaceState({}, '', url);
  render();
}
function inspect(value, title = 'Record details') { openRecord(recordRef(value, title)); }
function openRecord(reference) { focusSelectedTab = true; mobileRailOpen = false; saveContext(); workspace.openRecord(spaceId(), reference); render(); }
function renderDetails() {
  if (!detailSurface) return;
  detailSurface.clear();
  if (!state.detail) return;
  const pane = detailSurface.folder(state.detail?.title || 'Record details', { root: true });
  const value = state.detail.value;
  const primary = new Set(['from', 'to', 'body', 'text', 'content', 'status', 'amount_minor', 'balance_minor', 'refundable_minor', 'reason', 'description', 'output', 'error', 'quantity', 'quantity_on_hand', 'inventory_value_minor', 'valid', 'checked']);
  const metadata = {};
  Object.entries(value && typeof value === 'object' ? value : { value }).forEach(([key, value]) => {
    if (key === 'attachments' && Array.isArray(value)) return;
    if (!primary.has(key)) { metadata[key] = value; return; }
    pane.text(pretty(key.replace(/_minor$/, '')), key.endsWith('_minor') ? money(value) : Array.isArray(value) && value.every(v => typeof v === 'string') ? value.join(', ') : value);
  });
  const details = pane.folder('Details', { open: false }); if (Object.keys(metadata).length) details.text('Fields', metadata);
  details.action('Copy JSON', async () => { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); notify('Copied'); }, { icon: 'copy' });
  for (const attachment of list(value?.attachments)) {
    const folder = pane.folder(attachment.filename, { open: false });
    folder.text('File', { id: attachment.id, type: attachment.mimeType, bytes: attachment.size });
    folder.buttons([['Download ' + attachment.filename, () => download(path('/messages/' + encodeURIComponent(value.id) + '/attachments/' + encodeURIComponent(attachment.id)), attachment.filename)]]);
  }
}
async function download(url, filename) {
  const response = await fetch(url); if (!response.ok) { const error = await response.json(); throw Error(error.error?.message || 'Download failed'); }
  const href = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = href; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
}
function browse(parent, title, allRows, key, describe) {
  const pane = parent.folder(title, { root: true, wide: true }); pane.host.closest('.panel-host').classList.add('record-list');
  const search = state.search[key] || '';
  const filter = child(pane, 'list-filter');
  const field = filter.text('Search ' + title.toLowerCase(), search, value => { state.search[key] = value; }, 'Filter ' + title.toLowerCase() + '…');
  field.input.addEventListener('keydown', event => { if (event.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); contextual(pane.context, () => { state.page[key] = 0; render(); }); } });
  filter.action('Apply filter', () => { state.page[key] = 0; render(); }, { icon: 'search', className: 'icon-button' });
  const rows = allRows.filter(row => !search || JSON.stringify(row).toLowerCase().includes(search.toLowerCase()));
  const page = Math.min(state.page[key] || 0, Math.max(0, Math.ceil(rows.length / 12) - 1)); state.page[key] = page;
  if (!rows.length) pane.text('Records', 'No matching records');
  for (const row of rows.slice(page * 12, page * 12 + 12)) {
    const label = row.subject || row.name || (describe ? describe(row) : row.description || row.invoice_number || row.id || row.seq);
    const meta = [row.amount_minor !== undefined ? money(row.amount_minor) : '', row.status || row.direction || ''].filter(Boolean).join(' · ');
    pane.action(label || 'Record', () => inspect(row, title.replace(/s$/, '') + ' details'), { icon: key === 'messages' ? 'mail' : key === 'documents' ? 'file' : 'finance', className: 'record-row', meta });
  }
  if (rows.length > 12) {
    const pagination = child(pane, 'compact-actions pagination');
    pagination.action('Previous page', () => { state.page[key]--; render(); }, { icon: 'arrow-left', className: 'icon-button', disabled: page === 0 });
    pagination.text('Records', (page * 12 + 1) + '–' + Math.min(rows.length, (page + 1) * 12) + ' of ' + rows.length);
    pagination.action('Next page', () => { state.page[key]++; render(); }, { icon: 'arrow-right', className: 'icon-button', disabled: (page + 1) * 12 >= rows.length });
  }
  return pane;
}
function render() {
  if (rendering) return;
  rendering = true; deferredRender = false;
  try {
  if (state.noticeError && focusSelectedTab) notify('Ready');
  pendingFocus ||= captureFocus();
  saveContext();
  const scrolls = new Map([...document.querySelectorAll('.pane-scroll')].map(node => [node.dataset.tab, node.scrollTop]));
  // Capture before disposing siblings: removing the composer changes the reader's height.
  document.querySelectorAll('[data-scroll-key]').forEach(node => { if (node.getClientRects().length) scrollPositions.set(node.dataset.scrollKey, node.scrollTop); });
  root.clear(); menuSurface = null; searchSurface = null; renderContext = null;
  root.host.dataset.theme = workspace.settings.theme;
  document.documentElement.style.colorScheme = workspace.settings.theme;
  const sidebarCollapsed = narrowScreen.matches ? !mobileRailOpen : workspace.settings.sidebarCollapsed || compactScreen.matches && workspace.settings.assistantOpen;
  const layout = child(root, 'workspace' + (sidebarCollapsed ? ' sidebar-collapsed' : ''), 'shell', null);
  layout.host.style.setProperty('--sidebar-width', workspace.settings.sidebarWidth + 'px');
  layout.host.style.setProperty('--assistant-width', workspace.settings.assistantWidth + 'px');
  if (state.busy) layout.host.setAttribute('inert', '');
  rail = child(layout, 'rail', 'rail', null); renderSidebar();
  if (narrowScreen.matches && mobileRailOpen) { layout.action('Close sidebar', toggleSidebar, { className: 'sidebar-backdrop' }); rail.host.setAttribute('role', 'dialog'); rail.host.setAttribute('aria-modal', 'true'); rail.host.setAttribute('aria-label', 'Navigation'); }
  const workbench = child(layout, 'workbench', 'workbench', null);
  if (narrowScreen.matches && mobileRailOpen) workbench.host.inert = true;
  workbench.host.setAttribute('aria-label', 'Workspace');
  const currentSpace = space();
  for (let column = 0; column < currentSpace.columnWidths.length; column++) {
    const col = child(workbench, 'pane-column', 'column-' + column, null);
    col.host.style.flex = currentSpace.columnWidths[column] + ' 1 0';
    const panes = currentSpace.panes.filter(p => p.column === column);
    panes.forEach((pane, row) => {
      const tab = pane.tabs.find(t => t.id === pane.activeTabId) || pane.tabs[0];
      const context = { world: spaceId(), pane: pane.id, tab: tab.id }; useContext(context);
      const frame = child(col, 'workspace-pane' + (pane.id === currentSpace.activePaneId ? ' active-pane' : ''), tab.id, context);
      frame.host.dataset.pane = pane.id; frame.host.style.flex = (currentSpace.rowWeights[column]?.[row] || 100) + ' 1 0';
      renderTabs(frame, pane);
      const toolbar = child(frame, 'pane-toolbar');
      toolbar.action('Toggle sidebar', toggleSidebar, { icon: 'sidebar', className: 'icon-button sidebar-toggle' });
      const title = toolbar.text('View', tab.title); title.host.classList.add('toolbar-title');
      const actions = child(toolbar, 'toolbar-actions');
      if (tab.kind === 'record') {
        const favorite = currentSpace.favorites.some(f => f.collection === tab.collection && f.recordId === tab.recordId);
        actions.action(favorite ? 'Remove favorite' : 'Add favorite', () => { workspace.toggleFavorite(spaceId(), tab); render(); }, { icon: 'star', className: 'icon-button', active: favorite, disabled: tab.collection === 'inspection' });
      }
      if (tab.view === 'mailbox' || tab.collection === 'messages') actions.action('Compose', () => openCompose(), { icon: 'compose', className: 'icon-button' });
      actions.action('Refresh', refresh, { icon: 'refresh', className: 'icon-button' });
      const menu = actions.action('Tab options', () => openTabMenu(pane.id, tab.id, menu), { icon: 'more', className: 'icon-button' });
      const scroller = child(frame, 'pane-scroll'); scroller.host.dataset.tab = tab.id; scroller.host.setAttribute('role', 'tabpanel'); scroller.host.setAttribute('aria-label', tab.title);
      content = child(scroller, 'content', tab.id); detailSurface = null;
      try {
        if (!state.snapshot && !['create', 'settings'].includes(tab.view)) renderStart();
        else if (tab.kind === 'record') renderRecord(tab);
        else if (tab.kind === 'compose') { state.compose ||= 'send_email'; const composer = content.folder('New message', { root: true, wide: true }); composer.host.parentElement.classList.add('composer'); renderMailForm(composer); }
        else ({ overview: renderOverview, work: renderWorkView, connections: renderConnections, mailbox: renderMailbox, finance: renderFinance, books: renderBooksView, procurement: renderProcurement, sources: renderSources, agent: renderAgent, delivery: renderDelivery, audit: renderAudit, create: renderCreate, documents: renderDocuments, favorites: renderFavorites, settings: renderSettings })[tab.view]?.() ?? (tab.view.startsWith('start-') ? renderStart() : undefined);
      } catch (error) { const errorCard = content.folder('Unable to open view', { root: true }); errorCard.text('Error', error.message); errorCard.buttons([['Retry', refresh]]); }
      scroller.host.scrollTop = scrolls.get(tab.id) || tab.ui?.scroll || 0;
      scroller.host.addEventListener('scroll', () => { const scroll = scroller.host.scrollTop, runtime = tabState.get(context.world + ':' + tab.id); if (runtime) runtime.scroll = scroll; if (activeContext?.tab === tab.id) state.scroll = scroll; workspace.updateTab(context.world, tab.id, { ui: { scroll } }); }, { passive: true });
      trackScroll(scroller, null, tab.title);
      const activatePane = () => { if (!state.busy) { useContext(context, true); document.querySelectorAll('.workspace-pane').forEach(p => p.classList.toggle('active-pane', p.dataset.pane === pane.id)); } };
      frame.host.addEventListener('pointerdown', activatePane, { capture: true }); frame.host.addEventListener('focusin', activatePane);
      installPaneDrop(frame.host, pane);
      if (row < panes.length - 1) resizeHandle(frame, 'pane-resize', 'Resize rows', 'vertical', (delta, start, options) => {
        const heights = [...start.rowWeights[column]], sum = heights[row] + heights[row + 1]; heights[row] = Math.max(33, Math.min(sum - 33, heights[row] + delta / start.extent * 100)); heights[row + 1] = sum - heights[row];
        workspace.updateLayout(start.worldId, { rowWeights: { ...start.rowWeights, [column]: heights } }, options);
        [...col.host.querySelectorAll(':scope > .workspace-pane')].forEach((node, i) => node.style.flex = heights[i] + ' 1 0');
      });
    });
    if (column < currentSpace.columnWidths.length - 1) resizeHandle(col, 'column-resize', 'Resize columns', 'horizontal', (delta, start, options) => {
      const widths = [...start.columnWidths], sum = widths[column] + widths[column + 1]; widths[column] = Math.max(22, Math.min(sum - 22, widths[column] + delta / start.extent * 100)); widths[column + 1] = sum - widths[column];
      workspace.updateLayout(start.worldId, { columnWidths: widths }, options);
      [...workbench.host.querySelectorAll(':scope > .pane-column')].forEach((node, i) => node.style.flex = widths[i] + ' 1 0');
    });
  }
  const selected = activePane(); useContext({ world: spaceId(), pane: selected.id, tab: selected.activeTabId });
  if (workspace.settings.assistantOpen && state.snapshot && !world().seat && !(narrowScreen.matches && mobileRailOpen)) renderAssistant(layout);
  const toast = child(root, 'status-toast' + (state.notice === 'Ready' ? ' quiet' : ''), 'status', null); toast.host.dataset.error = String(Boolean(state.noticeError)); statusControl = toast.text('Activity', state.notice);
  toast.action('Dismiss', () => notify('Ready'), { icon: 'close', className: 'icon-button' });
  const announcement = root.slot('sr-only'); announcement.id = 'gram-announcement'; announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', state.noticeError ? 'assertive' : 'polite'); announcement.textContent = state.notice === 'Ready' ? '' : state.notice;
  document.title = (currentTab()?.title || 'Workspace') + ' · gram';
  const url = new URL(location.href); url.searchParams.set('view', state.view); url.searchParams.set('tab', currentTab()?.id || ''); if (state.world) url.searchParams.set('world', state.world); history.replaceState({}, '', url);
  saveContext();
  // Fava frames sit outside the redrawn tree; lay them over this render's slots now and after layout settles.
  syncBooksFrames(); requestAnimationFrame(syncBooksFrames);
  } finally { rendering = false; if (!state.busy) restoreFocus(pendingFocus); }
}
function toggleSidebar() {
  const revealNavigation = !narrowScreen.matches && compactScreen.matches && workspace.settings.assistantOpen;
  if (narrowScreen.matches) mobileRailOpen = !mobileRailOpen;
  else if (revealNavigation) workspace.updateSettings({ assistantOpen: false, sidebarCollapsed: false });
  else workspace.updateSettings({ sidebarCollapsed: !workspace.settings.sidebarCollapsed });
  render();
  if (revealNavigation) {
    const target = document.querySelector('.rail button');
    pendingFocus = { key: target.dataset.focusKey, world: spaceId(), tab: currentTab()?.id }; forceFocus = true; focusSelectedTab = false;
    if (!state.busy) restoreFocus(pendingFocus);
  }
}
function toggleAssistant() {
  const open = !workspace.settings.assistantOpen;
  workspace.updateSettings({ assistantOpen: open });
  if (open && narrowScreen.matches) mobileRailOpen = false;
  render();
  const target = open ? document.querySelector('.assistant-compose textarea:not([aria-hidden])') : document.querySelector('.rail button[aria-label="Toggle assistant"]');
  if (target) { pendingFocus = { key: target.dataset.focusKey, world: spaceId(), tab: currentTab()?.id }; forceFocus = true; focusSelectedTab = false; if (!state.busy) restoreFocus(pendingFocus); }
}
function renderSidebar() {
  const head = child(rail, 'rail-header');
  head.action('gram', () => go(state.world ? 'overview' : 'create'), { className: 'brand', icon: 'logo' });
  const actions = child(head, 'rail-actions');
  actions.action('Collapse sidebar', toggleSidebar, { icon: 'sidebar', className: 'icon-button' });
  actions.action('Search workspace', () => openSearch(), { icon: 'search', className: 'icon-button', title: 'Search workspace · ⌘K' });
  if (!world().seat) actions.action('Toggle assistant', toggleAssistant, { icon: 'agent', className: 'icon-button', active: workspace.settings.assistantOpen, disabled: !state.world });
  const company = child(rail, 'space-select');
  company.select('Company', state.world, choices(list(state.boot?.worlds)), id => void perform('Switch company', () => chooseWorld(id)));
  rail.action('New message', () => openCompose(), { icon: 'plus', disabled: !state.world });
  const scroll = child(rail, 'rail-scroll');
  const nav = child(scroll, 'rail-nav');
  const selected = currentTab();
  for (const view of (world().seat ? ['work', 'mailbox', 'finance', 'books', 'audit'] : ['overview', 'mailbox', 'documents', 'finance', 'books', 'procurement'])) {
    const count = view === 'work' ? records('workItems').filter(item => ['proposed', 'needs_info', 'escalated'].includes(item.state)).length || undefined : view === 'mailbox' ? records('messages').length : view === 'documents' ? records('documents').length : view === 'favorites' ? space().favorites.length : undefined;
    nav.action(labels[view], () => go(view), { icon: view === 'documents' ? 'files' : view === 'favorites' ? 'star' : view, active: selected?.view === view && selected.kind === 'view', meta: count, disabled: !state.world && view !== 'overview' });
  }
  const tools = scroll.folder('Tools', { open: false }); tools.host.classList.add('rail-nav');
  for (const view of (world().seat ? ['connections'] : ['connections', 'sources', 'agent', 'delivery', 'audit'])) tools.action(labels[view], () => go(view), { icon: view === 'connections' ? 'external' : view, disabled: !state.world });
  if (space().favorites.length) {
    const favorites = scroll.folder('Favorites'); favorites.host.classList.add('rail-nav');
    for (const favorite of space().favorites.slice(0, 8)) favorites.action(favorite.title, () => openRecord(favorite), { icon: favorite.collection === 'messages' ? 'mail' : 'file' });
  }
  const inbox = scroll.folder('Recent mail'); inbox.host.classList.add('rail-nav', 'inbox-nav');
  for (const message of records('messages').slice(-12).reverse()) inbox.action(message.subject || '(No subject)', () => openRecord(recordRef(message)), { icon: 'mail', active: selected?.recordId === message.id, title: message.subject || 'Message' });
  if (space().savedSearches.length) {
    const saved = scroll.folder('Saved searches'); saved.host.classList.add('rail-nav');
    for (const search of space().savedSearches) saved.action(search.query, () => openSearch(search.query), { icon: 'search' });
  }
  trackScroll(scroll, spaceId() + ':sidebar', 'Navigation');
  const dock = child(rail, 'rail-dock');
  for (const [label, name, view] of [['Settings', 'settings', 'settings'], ['Inbox', 'mail', 'mailbox'], ['Finance', 'finance', 'finance'], ['Files', 'file', 'documents'], ['New company', 'plus', 'create']]) dock.action(label, () => go(view), { icon: name, className: 'icon-button' });
  resizeHandle(rail, 'sidebar-resize', 'Resize sidebar', 'horizontal', (delta, start, options) => { workspace.updateSettings({ sidebarWidth: start.sidebarWidth + delta }, options); rail.host.parentElement.style.setProperty('--sidebar-width', workspace.settings.sidebarWidth + 'px'); });
}
function renderTabs(frame, pane) {
  const strip = child(frame, 'tab-strip'); strip.host.setAttribute('role', 'tablist'); strip.host.setAttribute('aria-label', 'Open tabs');
  pane.tabs.forEach((tab, index) => {
    const item = child(strip, 'tab-item' + (tab.id === pane.activeTabId ? ' active' : '') + (tab.pinned ? ' pinned' : ''));
    item.host.dataset.tab = tab.id; item.host.draggable = true;
    const button = item.action(tab.title, () => { focusSelectedTab = true; saveContext(); workspace.activateTab(spaceId(), pane.id, tab.id); render(); }, { icon: tab.pinned ? 'pin' : tab.kind === 'compose' ? 'compose' : tab.collection === 'messages' ? 'mail' : tab.kind === 'record' ? 'file' : tab.view, className: 'tab-button' });
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab.id === pane.activeTabId)); button.tabIndex = tab.id === pane.activeTabId ? 0 : -1;
    button.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? pane.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + pane.tabs.length) % pane.tabs.length; saveContext(); workspace.activateTab(spaceId(), pane.id, pane.tabs[next].id); render(); document.querySelector('[data-tab="' + pane.tabs[next].id + '"] [role="tab"]')?.focus(); });
    if (!tab.pinned) {
      const closeButton = item.action('Close ' + tab.title, () => closeTab(pane.id, tab.id), { icon: 'close', className: 'tab-close icon-button' });
      closeButton.tabIndex = tab.id === pane.activeTabId ? 0 : -1;
    }
    item.host.addEventListener('contextmenu', event => { event.preventDefault(); openTabMenu(pane.id, tab.id, item.host); });
    item.host.addEventListener('dragstart', event => { saveContext(); event.dataTransfer.setData('application/finance-world-tab', JSON.stringify({ world: spaceId(), pane: pane.id, tab: tab.id })); event.dataTransfer.effectAllowed = 'move'; item.host.classList.add('dragging'); });
    item.host.addEventListener('dragend', () => { item.host.classList.remove('dragging'); document.querySelectorAll('[data-drop]').forEach(node => delete node.dataset.drop); });
    item.host.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('application/finance-world-tab')) { event.preventDefault(); event.stopPropagation(); item.host.dataset.drop = 'tab'; } });
    item.host.addEventListener('dragleave', () => delete item.host.dataset.drop);
    item.host.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); const source = readTabDrop(event); if (source) { workspace.moveTab(spaceId(), source.pane, pane.id, source.tab, index); render(); } });
  });
  strip.action('New tab', newTab, { icon: 'plus', className: 'tab-add icon-button' });
  let geometryFrame;
  function measure(keepVisible = false) {
    const active = strip.host.querySelector('.tab-item.active'); if (!active) return;
    let bounds = strip.host.getBoundingClientRect(), rect = active.getBoundingClientRect();
    if (keepVisible) { if (rect.left < bounds.left) strip.host.scrollLeft -= bounds.left - rect.left; else if (rect.right > bounds.right) strip.host.scrollLeft += rect.right - bounds.right; rect = active.getBoundingClientRect(); }
    const intersects = rect.right > bounds.left && rect.left < bounds.right;
    frame.host.dataset.tabFlush = [intersects && rect.left <= bounds.left + .5 ? 'start' : '', intersects && rect.right >= bounds.right - .5 ? 'end' : ''].filter(Boolean).join(' ') || 'none';
    tabStripScroll.set(pane.id, strip.host.scrollLeft);
  }
  const schedule = () => { cancelAnimationFrame(geometryFrame); geometryFrame = requestAnimationFrame(() => measure(true)); };
  const onScroll = () => measure(); strip.host.addEventListener('scroll', onScroll, { passive: true });
  const observer = new ResizeObserver(schedule); observer.observe(strip.host);
  geometryFrame = requestAnimationFrame(() => { strip.host.scrollLeft = tabStripScroll.get(pane.id) || 0; measure(true); });
  frame.keep({ destroy() { cancelAnimationFrame(geometryFrame); observer.disconnect(); strip.host.removeEventListener('scroll', onScroll); } });
}
function newTab() { focusSelectedTab = true; saveContext(); workspace.openView(spaceId(), 'start-' + crypto.randomUUID(), 'New tab'); render(); }
function closeTab(paneId, tabId) { focusSelectedTab = true; saveContext(); workspace.closeTab(spaceId(), paneId, tabId); activeContext = null; render(); }
function readTabDrop(event) { try { const source = JSON.parse(event.dataTransfer.getData('application/finance-world-tab')); return source.world === spaceId() ? source : null; } catch { return null; } }
function installPaneDrop(node, pane) {
  node.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('application/finance-world-tab') || event.target.closest('.tab-item')) return;
    event.preventDefault(); const rect = node.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
    node.dataset.drop = x < .18 ? 'left' : x > .82 ? 'right' : y > .78 ? 'bottom' : y < .18 ? 'top' : 'center';
  });
  node.addEventListener('dragleave', event => { if (!node.contains(event.relatedTarget)) delete node.dataset.drop; });
  node.addEventListener('drop', event => {
    event.preventDefault(); const source = readTabDrop(event), direction = node.dataset.drop; delete node.dataset.drop;
    if (!source) return;
    focusSelectedTab = true;
    if (direction && direction !== 'center') {
      const target = space().panes.find(p => p.id === pane.id), rows = space().panes.filter(p => p.column === target.column).length;
      if (['left', 'right'].includes(direction) ? space().columnWidths.length >= 3 : rows >= 2) { notify('Pane limit reached'); return; }
      let movedTabId = source.tab;
      if (source.pane !== pane.id) { workspace.moveTab(spaceId(), source.pane, pane.id, source.tab, target.tabs.length); movedTabId = target.activeTabId; }
      if (!workspace.splitTab(spaceId(), pane.id, movedTabId, direction)) notify('Unable to split this pane');
    } else workspace.moveTab(spaceId(), source.pane, pane.id, source.tab, pane.tabs.length);
    render();
  });
}
function resizeHandle(parent, className, label, axis, change) {
  const handle = parent.action(label, () => {}, { className, icon: undefined });
  const host = handle.closest('.' + className), worldId = spaceId();
  const pixels = className === 'sidebar-resize' || className === 'assistant-resize';
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', axis === 'horizontal' ? 'vertical' : 'horizontal');
  handle.title = label + ' · Arrow keys to adjust · Double-click to reset';
  const position = () => {
    if (pixels) {
      const sidebar = className === 'sidebar-resize', limits = RESIZE_LIMITS[sidebar ? 'sidebar' : 'assistant'];
      return { value: workspace.settings[sidebar ? 'sidebarWidth' : 'assistantWidth'], ...limits, reset: limits.default, unit: 'px' };
    }
    const current = workspace.getSpace(worldId), paneId = parent.host.dataset.pane || parent.host.querySelector('.workspace-pane')?.dataset.pane;
    const pane = current.panes.find(p => p.id === paneId), rows = className === 'pane-resize';
    const values = rows ? current.rowWeights[pane.column] : current.columnWidths, index = rows ? pane.row : pane.column;
    const value = values[index], sum = value + values[index + 1], min = rows ? 33 : 22;
    return { value, min, max: sum - min, reset: sum / 2, unit: '%' };
  };
  const announce = () => {
    const { value, min, max, unit } = position();
    handle.setAttribute('aria-valuemin', min); handle.setAttribute('aria-valuemax', max); handle.setAttribute('aria-valuenow', value); handle.setAttribute('aria-valuetext', Math.round(value) + unit);
  };
  const sync = () => { announce(); if (className === 'sidebar-resize') document.dispatchEvent(new Event('sidebar-width-change')); };
  if (className === 'sidebar-resize') document.addEventListener('sidebar-width-change', announce);
  announce();
  const snapshot = () => {
    const current = workspace.getSpace(worldId), selector = className === 'pane-resize' ? ':scope > .workspace-pane' : ':scope > .pane-column';
    const extent = pixels ? 1 : [...parent.host.parentElement.querySelectorAll(selector)].reduce((sum, node) => sum + node.getBoundingClientRect()[axis === 'horizontal' ? 'width' : 'height'], 0);
    return { worldId, columnWidths: [...current.columnWidths], rowWeights: structuredClone(current.rowWeights), sidebarWidth: workspace.settings.sidebarWidth, assistantWidth: workspace.settings.assistantWidth, extent: Math.max(1, extent) };
  };
  const coordinate = event => axis === 'horizontal' ? event.clientX : event.clientY;
  let drag = null, frame;
  const flush = () => {
    if (frame !== undefined) { cancelAnimationFrame(frame); frame = undefined; }
    if (!drag || drag.delta === drag.applied) return;
    change(drag.delta, drag.start, { persist: false }); drag.applied = drag.delta; drag.changed = true; sync();
  };
  const stop = (event, flushPending = true) => {
    if (!drag || event?.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    if (event?.type === 'pointerup') drag.delta = coordinate(event) - drag.initial;
    const finished = drag;
    if (flushPending) flush(); else if (frame !== undefined) { cancelAnimationFrame(frame); frame = undefined; }
    drag = null;
    document.body.classList.remove('is-resizing'); delete document.body.dataset.resizeAxis; delete host.dataset.resizing;
    if (handle.hasPointerCapture(finished.pointerId)) handle.releasePointerCapture(finished.pointerId);
    if (finished.changed) workspace.persist();
  };
  handle.addEventListener('pointerdown', event => {
    if (state.busy || event.button !== 0 || !event.isPrimary || document.body.classList.contains('is-resizing')) return;
    event.preventDefault(); event.stopPropagation();
    try { handle.setPointerCapture(event.pointerId); } catch { return; }
    handle.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, initial: coordinate(event), start: snapshot(), delta: 0, applied: 0, changed: false };
    document.body.classList.add('is-resizing'); document.body.dataset.resizeAxis = axis; host.dataset.resizing = 'true';
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.delta = coordinate(event) - drag.initial;
    if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; flush(); });
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, stop);
  window.addEventListener('blur', stop);
  parent.keep({ destroy() { stop(undefined, false); window.removeEventListener('blur', stop); if (className === 'sidebar-resize') document.removeEventListener('sidebar-width-change', announce); } });
  // A separator uses the native button's focus and hit area without its action lifecycle.
  handle.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); }, { capture: true });
  handle.addEventListener('keydown', event => {
    if (state.busy || drag || event.altKey || event.metaKey || event.ctrlKey) return;
    const arrows = axis === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (!arrows.includes(event.key) && !(pixels && ['Home', 'End'].includes(event.key))) return;
    event.preventDefault(); event.stopPropagation();
    const start = snapshot(), current = position(), direction = className === 'assistant-resize' ? -1 : 1;
    const delta = arrows.includes(event.key) ? (event.key === arrows[0] ? -1 : 1) * (event.shiftKey ? 24 : 8) : ((event.key === 'Home' ? current.min : current.max) - current.value) * direction;
    change(delta, start); sync();
  });
  handle.addEventListener('dblclick', event => {
    if (state.busy || drag) return;
    event.preventDefault(); event.stopPropagation();
    const start = snapshot(), current = position(), scale = pixels ? className === 'assistant-resize' ? -1 : 1 : start.extent / 100;
    change((current.reset - current.value) * scale, start); sync();
  });
}
function openTabMenu(paneId, tabId, anchor) {
  closeMenu(); const tab = space().panes.find(p => p.id === paneId)?.tabs.find(t => t.id === tabId); if (!tab) return;
  menuSurface = child(root, 'context-menu', 'menu', null); menuSurface.host.setAttribute('role', 'menu');
  menuSurface.returnFocus = anchor.matches('button') ? anchor : anchor.querySelector('button');
  const rect = anchor.getBoundingClientRect(); menuSurface.host.style.left = Math.max(8, Math.min(innerWidth - 230, rect.left)) + 'px'; menuSurface.host.style.top = Math.min(innerHeight - 300, rect.bottom + 5) + 'px';
  const action = (label, name, work, disabled = false) => { const b = menuSurface.action(label, () => { closeMenu(); focusSelectedTab = true; saveContext(); work(); render(); }, { icon: name, disabled }); b.setAttribute('role', 'menuitem'); };
  action(tab.pinned ? 'Unpin tab' : 'Pin tab', 'pin', () => workspace.togglePin(spaceId(), paneId, tabId));
  action('Split right', 'split-right', () => workspace.splitTab(spaceId(), paneId, tabId, 'right'), space().columnWidths.length >= 3);
  const selected = space().panes.find(p => p.id === paneId);
  action('Split below', 'split-down', () => workspace.splitTab(spaceId(), paneId, tabId, 'bottom'), space().panes.filter(p => p.column === selected.column).length >= 2);
  for (const other of space().panes.filter(p => p.id !== paneId)) action('Move to pane ' + (space().panes.indexOf(other) + 1), 'arrow-right', () => workspace.moveTab(spaceId(), paneId, other.id, tabId, other.tabs.length));
  action('Reopen closed tab', 'refresh', () => workspace.reopenTab(spaceId()));
  action('Close tab', 'close', () => { workspace.closeTab(spaceId(), paneId, tabId); activeContext = null; });
  menuSurface.host.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
    const buttons = [...menuSurface.host.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  });
  menuSurface.host.querySelector('button')?.focus();
}
function closeMenu(restore = false) { if (menuSurface) { const origin = menuSurface.returnFocus; menuSurface.destroy(); menuSurface.host.remove(); menuSurface = null; pendingFocus = null; focusSelectedTab = false; if (restore && origin?.isConnected) origin.focus({ preventScroll: true }); } }
function renderStart() {
  const pane = content.folder(state.world ? 'Open a view' : 'Your workspace', { root: true, wide: true }); pane.host.parentElement.classList.add('empty-state');
  for (const view of state.world ? ['overview', 'mailbox', 'finance', 'procurement', 'documents', 'agent'] : ['create']) pane.action(labels[view], () => go(view), { icon: view });
  if (state.world) pane.action('Search records', () => openSearch(), { icon: 'search', meta: '⌘ K' });
}
function renderDocuments() { browse(content, 'Files', records('documents'), 'documents'); }
function renderFavorites() {
  const pane = content.folder('Favorites', { root: true, wide: true });
  if (!space().favorites.length) pane.text('Saved items', 'No favorites yet');
  for (const ref of space().favorites) { pane.action(ref.title, () => openRecord(ref), { icon: ref.collection === 'messages' ? 'mail' : 'file' }); }
}
function renderSettings() {
  const pane = content.folder('Appearance', { root: true });
  pane.select('Theme', workspace.settings.theme, ['light', 'dark'].map(value => ({ value, label: pretty(value) })), theme => { workspace.updateSettings({ theme }); render(); });
  const host = pane.slot(), props = { label: 'Sidebar width', value: workspace.settings.sidebarWidth, min: RESIZE_LIMITS.sidebar.min, max: RESIZE_LIMITS.sidebar.max, step: 1, onChange: sidebarWidth => {
    if (state.busy) return;
    contextual(pane.context, () => {
      workspace.updateSettings({ sidebarWidth }); document.querySelector('.workspace').style.setProperty('--sidebar-width', workspace.settings.sidebarWidth + 'px');
      document.dispatchEvent(new Event('sidebar-width-change'));
    });
  } };
  const slider = pane.keep(Slider(host, props));
  host.querySelectorAll('input, [role="slider"]').forEach((node, i) => pane.identify(node, 'slider-' + i, props.label));
  const sync = () => { props.value = workspace.settings.sidebarWidth; slider.update(props); };
  document.addEventListener('sidebar-width-change', sync);
  pane.keep({ destroy() { document.removeEventListener('sidebar-width-change', sync); } });
  const shortcuts = content.folder('Keyboard shortcuts', { root: true });
  for (const [label, key] of [['Search', '⌘ / Ctrl K'], ['New tab', 'Alt N'], ['Close tab', 'Alt W'], ['Reopen tab', '⌘ / Ctrl Shift T'], ['Toggle sidebar', 'Alt B']]) shortcuts.text(label, key);
}
function renderRecord(tab) {
  if (tab.collection === 'audit') { renderAuditRecord(content, { ...auditOptions(draft('audit-record', { raw: false }), content), seq: Number(tab.recordId), openEvent: null }); return; }
  const value = resolveRecord(tab);
  if (!value) { const missing = content.folder(tab.collection === 'inspection' ? tab.title : 'Record unavailable', { root: true, wide: true }); if (tab.collection !== 'inspection') missing.text('Record', tab.recordId); missing.buttons([['Open source', () => go(tab.view || 'overview')]]); return; }
  if (tab.collection === 'workItems') { renderWorkItem(content, workContext(), tab.recordId); return; }
  if (tab.collection === 'runs') {
    const reader = content.folder('Agent', { root: true, wide: true });
    renderAgentResponse(reader, value);
    return;
  }
  if (tab.collection === 'messages') {
    const thread = records('messages').filter(message => message.id === value.id || value.thread_id && message.thread_id === value.thread_id);
    for (const message of thread) {
      const card = content.folder(message.from || 'Message', { root: true, wide: true }); card.host.parentElement.closest('.panel-host').classList.add('message-card');
      const meta = child(card, 'message-meta'); meta.text('To', list(message.to).join(', ') || message.to); meta.text('Sent', message.created_at ? new Date(message.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
      const body = card.text('Message', message.body || message.text || '(No message body)'); body.host.classList.add('prose', 'record-body');
      if (list(message.attachments).length) for (const file of message.attachments) card.action(file.filename, () => download(path('/messages/' + encodeURIComponent(message.id) + '/attachments/' + encodeURIComponent(file.id)), file.filename), { icon: 'download', meta: Math.ceil(file.size / 1024) + ' KB' });
      const details = card.folder('Details', { open: false }); details.text('ID', message.id); details.text('Delivery', message.delivery_status || message.direction); if (message.source_refs?.length) details.text('Sources', message.source_refs);
    }
    const reply = content.folder('Reply', { root: true, wide: true }); reply.host.parentElement.closest('.panel-host').classList.add('composer');
    const d = draft('reply-' + value.thread_id, { body: '', to: value.direction === 'outbound' ? list(value.to).join(', ') : value.from });
    reply.text('To', d.to, text => d.to = text);
    reply.text('Message', d.body, text => d.body = text, 'Write a reply…').host.classList.add('compose-body');
    reply.action('Send reply', async () => {
      if (!d.to.trim()) invalid('To', 'Enter a recipient.'); if (!d.body.trim()) invalid('Message', 'Write a reply.');
      await act({ type: 'send_email', to: d.to.split(',').map(s => s.trim()).filter(Boolean), subject: /^re:/i.test(value.subject) ? value.subject : 'Re: ' + value.subject, body: d.body, thread_id: value.thread_id }); d.body = ''; render();
    }, { icon: 'send', className: 'send-action' });
    return;
  }
  detailSurface = content; state.detail = { value, title: tab.title }; renderDetails(); detailSurface = null;
  content.host.classList.add('record-reader');
  content.host.querySelectorAll('textarea[aria-label="Content"], textarea[aria-label="Body"], textarea[aria-label="Output"]').forEach(input => input.closest('.read-only')?.classList.add('prose', 'record-body'));
}
function openCompose(type = 'send_email') {
  focusSelectedTab = true;
  mobileRailOpen = false;
  saveContext(); const tab = workspace.openCompose(spaceId(), type === 'receive_email' ? 'Incoming message' : 'New message');
  workspace.updateTab(spaceId(), tab.id, { ui: { compose: type } }); render();
}
function runReference(run) { return { collection: 'runs', recordId: run.id, title: 'Agent response', view: 'agent' }; }
function runDate(run) { return run.started_at ? new Date(run.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
function focusAssistantReading() {
  const target = document.querySelector('.assistant-body .agent-history-row button') || document.querySelector('.assistant-body');
  if (!target) return;
  pendingFocus = { key: target.dataset.focusKey, world: spaceId(), tab: currentTab()?.id }; forceFocus = true; focusSelectedTab = false;
  if (!state.busy) restoreFocus(pendingFocus);
}
async function stopAgent(run) {
  if (stoppingRuns.has(run.id)) return;
  stoppingRuns.add(run.id);
  try { await post(path('/agent/' + encodeURIComponent(run.id) + '/cancel')); await refresh(); }
  catch (error) { stoppingRuns.delete(run.id); throw error; }
}
function renderAgentResponse(parent, run, onReadTask) {
  const thread = child(parent, 'agent-thread');
  if (run.instruction && onReadTask) thread.action(run.instruction, onReadTask, { icon: 'arrow-right', title: 'View task', className: 'agent-task-preview' });
  const meta = child(thread, 'agent-response-meta');
  const status = meta.slot('agent-status');
  const component = mountAgentStatus(status, run, { dark: workspace.settings.theme === 'dark', size: run.output ? 20 : 64 });
  const entry = { world: spaceId(), id: run.id, component }; agentStatusViews.add(entry);
  meta.keep({ destroy() { agentStatusViews.delete(entry); component.destroy(); } });
  if (run.started_at) { const time = document.createElement('time'); time.dateTime = run.started_at; time.textContent = runDate(run); meta.host.append(time); }
  if (run.status === 'running' && !onReadTask) meta.action(stoppingRuns.has(run.id) ? 'Stopping…' : 'Stop', () => stopAgent(run), { icon: 'stop', className: 'agent-stop', disabled: stoppingRuns.has(run.id) });
  if (run.output) { const response = thread.slot('agent-response markdown'); renderMarkdown(response, run.output); }
  if (run.error) { const error = thread.slot('agent-error'); error.textContent = run.error; }
  if (!run.output && !run.error && run.status !== 'running') { const empty = thread.slot('agent-response-empty'); empty.textContent = 'No response recorded'; }
  if (run.output) thread.action('Copy response', async () => { await navigator.clipboard.writeText(run.output); notify('Copied'); }, { icon: 'copy', className: 'agent-copy icon-button' });
  if (run.instruction && !onReadTask) {
    const task = thread.slot('agent-original-task'), heading = document.createElement('h3'), prompt = document.createElement('p');
    heading.textContent = 'Task'; prompt.textContent = run.instruction; task.append(heading, prompt);
  }
  return thread;
}
function renderAssistant(layout) {
  const assistant = child(layout, 'assistant', 'assistant', null);
  resizeHandle(assistant, 'assistant-resize', 'Resize assistant', 'horizontal', (delta, start, options) => { workspace.updateSettings({ assistantWidth: start.assistantWidth - delta }, options); layout.host.style.setProperty('--assistant-width', workspace.settings.assistantWidth + 'px'); });
  let view = assistantViews.get(spaceId()); if (!view) { view = { runId: null, history: false }; assistantViews.set(spaceId(), view); }
  const runs = state.snapshot.runs.slice().reverse(), selected = runs.find(run => run.id === view.runId) || runs[0], running = runs.find(run => run.status === 'running');
  if (selected) view.runId = selected.id;
  const head = child(assistant, 'assistant-header'); head.text('Assistant', view.history ? 'History' : view.task ? 'Task' : 'Agent');
  const headActions = child(head, 'assistant-header-actions');
  if (runs.length) headActions.action(view.history || view.task ? 'Back to response' : 'Run history', () => { view.history = !(view.history || view.task); view.task = false; render(); focusAssistantReading(); }, { icon: view.history || view.task ? 'arrow-left' : 'clock', className: 'icon-button' });
  if (selected && !view.history) headActions.action('Open full response', () => { workspace.updateSettings({ assistantOpen: false }); openRecord(runReference(selected)); }, { icon: 'external', className: 'icon-button' });
  headActions.action('Close assistant', toggleAssistant, { icon: 'close', className: 'icon-button' });
  const body = child(assistant, 'assistant-body');
  if (view.history && runs.length) {
    for (const run of runs) body.action(run.instruction || describeAgentStatus(run).label, () => { view.runId = run.id; view.history = false; view.task = false; render(); focusAssistantReading(); }, { icon: 'agent', className: 'agent-history-row', meta: describeAgentStatus(run).label + ' · ' + runDate(run), active: run.id === selected?.id });
  } else if (selected && view.task) { const task = body.slot('agent-task'); task.textContent = selected.instruction; }
  else if (selected) renderAgentResponse(body, selected, () => { view.task = true; render(); focusAssistantReading(); });
  else {
    const suggestions = child(body, 'assistant-suggestions');
    for (const [label, prompt] of [['Does the bank match our books?', 'Reconcile payments, bank activity, and the ledger. Report unresolved items with evidence.'], ['What needs my attention?', 'Review pending operations and approval requests. Summarize unresolved items with evidence.'], ['Any billing mismatches?', 'Review supplier invoices against purchase orders and goods receipts. Identify match exceptions with source evidence.']]) suggestions.action(label, () => { workspace.updateAssistantDraft(spaceId(), prompt); render(); }, { icon: 'agent' });
  }
  trackScroll(body, spaceId() + ':agent:' + (view.history ? 'history' : (view.task ? 'task:' : '') + (selected?.id || 'empty')), view.history ? 'Run history' : view.task ? 'Original task' : 'Agent response');
  const composer = child(assistant, 'assistant-compose');
  const d = { instruction: space().assistantDraft }, config = state.boot.agent;
  const unavailable = !config.available || Boolean(running);
  let start;
  composer.text('Task', d.instruction, value => { d.instruction = value; workspace.updateAssistantDraft(spaceId(), value); if (start) start.disabled = unavailable || !value.trim(); }, 'Ask about this company…').host.classList.add('compose-body');
  const controls = child(composer, 'compact-actions');
  if (running) controls.action(stoppingRuns.has(running.id) ? 'Stopping…' : 'Stop', () => stopAgent(running), { icon: 'stop', className: 'agent-stop', disabled: stoppingRuns.has(running.id) });
  else start = controls.action('Start agent', async () => { if (!d.instruction.trim()) return; await post(path('/agent'), { instruction: d.instruction }); workspace.updateAssistantDraft(spaceId(), ''); view.runId = null; view.history = false; view.task = false; await refresh(); focusAssistantReading(); }, { icon: 'arrow-right', className: 'icon-button', disabled: unavailable || !d.instruction.trim() });
  if (!config.available) composer.text('Unavailable', config.reason || 'Agent is not configured');
}
function openSearch(initial = '') {
  closeMenu(); closeSearch();
  const origin = document.activeElement;
  searchSurface = child(root, 'modal-backdrop', 'search', null);
  document.querySelector('.workspace')?.setAttribute('inert', '');
  const backdrop = searchSurface.host, dialog = child(searchSurface, 'command-dialog'); dialog.host.setAttribute('role', 'dialog'); dialog.host.setAttribute('aria-modal', 'true'); dialog.host.setAttribute('aria-label', 'Search workspace');
  const header = child(dialog, 'command-header');
  let query = initial, matches = [], searchTimer;
  const field = header.text('Search', query, value => { query = value; clearTimeout(searchTimer); searchTimer = setTimeout(updateResults, 100); }, 'Search this company…');
  header.action('Close search', closeSearch, { icon: 'close', className: 'icon-button' });
  const searchBody = child(dialog, 'command-body');
  const results = child(searchBody, 'command-results'), preview = child(searchBody, 'command-preview'); const footer = child(dialog, 'command-footer');
  const execute = result => { closeSearch(); if (result.view && !result.collection) return go(result.view); return openRecord(result); };
  function updateResults() {
    if (!backdrop.isConnected) return;
    results.clear(); footer.clear(); preview.clear(); preview.host.hidden = true; dialog.host.classList.remove('has-preview'); const q = query.trim().toLowerCase(); matches = [];
    const viewRows = Object.entries(labels).filter(([view, label]) => !view.startsWith('start-') && (!q || label.toLowerCase().includes(q))).map(([view, title]) => ({ view, title }));
    if (q) {
      for (const [collection, rows] of Object.entries(world())) {
        if (!Array.isArray(rows) || ['audit', 'externalEvents'].includes(collection)) continue;
        for (const row of rows) {
          if (!row?.id) continue;
          const title = recordTitle(row), text = Object.values(row).filter(v => typeof v === 'string' || typeof v === 'number' || Array.isArray(v)).map(v => Array.isArray(v) ? v.filter(item => typeof item === 'string').join(' ') : v).join(' ').toLowerCase();
          if (text.includes(q)) matches.push({ collection, recordId: row.id, title, score: title.toLowerCase().includes(q) ? 0 : String(row.id).toLowerCase().includes(q) ? 1 : 2, view: collection === 'messages' ? 'mailbox' : collection === 'documents' ? 'documents' : 'finance' });
        }
      }
      matches.sort((a, b) => a.score - b.score);
      matches = [...viewRows, ...matches].slice(0, 40);
    } else matches = [...viewRows.slice(0, 7), ...records('messages').slice(-4).reverse().map(row => recordRef(row))];
    if (!q && space().savedSearches.length) {
      const saved = results.folder('Saved searches');
      for (const item of space().savedSearches) {
        const row = child(saved, 'saved-search-row'); row.action(item.query, () => { query = item.query; field.set(query); updateResults(); field.input.focus(); }, { icon: 'search' });
        row.action('Remove ' + item.query, () => { workspace.removeSearch(spaceId(), item.id); updateResults(); field.input.focus(); }, { icon: 'close', className: 'icon-button' });
      }
    }
    function showPreview(result) {
      if (!result.collection || !q) { preview.host.hidden = true; dialog.host.classList.remove('has-preview'); return; }
      const record = resolveRecord(result); if (!record) return;
      preview.clear(); preview.host.hidden = false; dialog.host.classList.add('has-preview');
      preview.text('Record', result.title).host.classList.add('preview-title');
      if (record.from) preview.text('From', record.from);
      if (record.status) preview.text('Status', pretty(record.status));
      if (record.amount_minor !== undefined) preview.text('Amount', money(record.amount_minor));
      const body = record.body || record.content || record.text || record.description;
      if (body && String(body).trim() !== result.title.trim()) preview.text('Preview', String(body).slice(0, 1400)).host.classList.add('prose');
      preview.action('Open record', () => execute(result), { icon: 'external' });
    }
    for (const result of matches) {
      const button = results.action(result.title, () => execute(result), { icon: result.collection === 'messages' ? 'mail' : result.collection ? 'file' : result.view, className: 'record-row', meta: result.collection ? pretty(result.collection) : 'View' });
      button.addEventListener('focus', () => showPreview(result)); button.addEventListener('pointerenter', () => showPreview(result));
    }
    const firstRecord = matches.find(result => result.collection); if (firstRecord) showPreview(firstRecord);
    if (!matches.length) results.text('Results', 'No matches');
    if (q) footer.action('Save search', () => { workspace.saveSearch(spaceId(), query.trim()); notify('Search saved'); updateResults(); field.input.focus(); }, { icon: 'star', disabled: space().savedSearches.some(item => item.query.toLowerCase() === q) });
  }
  updateResults();
  field.input.addEventListener('keydown', event => { if (event.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); clearTimeout(searchTimer); updateResults(); if (matches[0]) void perform('Open result', () => execute(matches[0]), field.host, true); } if (event.key === 'ArrowDown') { event.preventDefault(); clearTimeout(searchTimer); updateResults(); results.host.querySelector('button:not(:disabled)')?.focus(); } });
  results.host.addEventListener('keydown', event => {
    if (event.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
    const buttons = [...results.host.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowUp' && index === 0) { field.input.focus(); return; }
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  backdrop.addEventListener('click', event => { if (event.target === backdrop) closeSearch(); });
  dialog.host.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.host.querySelectorAll('button:not(:disabled), textarea:not([readonly]), [tabindex="0"]')].filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible' && !node.closest('[hidden], [inert], [aria-hidden="true"]'));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  searchSurface.returnFocus = origin; field.input.focus(); field.input.setSelectionRange(query.length, query.length);
}
function closeSearch() { if (searchSurface) { const origin = searchSurface.returnFocus; searchSurface.destroy(); searchSurface.host.remove(); searchSurface = null; document.querySelector('.workspace')?.toggleAttribute('inert', state.busy); pendingFocus = origin?.dataset.focusKey ? { key: origin.dataset.focusKey, world: spaceId(), tab: currentTab()?.id } : null; focusSelectedTab = false; forceFocus = Boolean(pendingFocus); if (!state.busy) restoreFocus(pendingFocus); } }
document.addEventListener('pointerdown', event => { if (menuSurface && !menuSurface.host.contains(event.target)) closeMenu(); });
document.addEventListener('keydown', event => {
  if (/^\/oauth\//.test(location.pathname) || state.busy || !state.boot || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
  if (event.key === 'Escape') {
    if (searchSurface) { event.preventDefault(); closeSearch(); }
    else if (menuSurface) { event.preventDefault(); closeMenu(true); }
    else if (narrowScreen.matches && mobileRailOpen) { event.preventDefault(); toggleSidebar(); }
    return;
  }
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
  else if (event.altKey && !modifier && event.code === 'KeyN') { event.preventDefault(); newTab(); }
  else if (event.altKey && !modifier && event.code === 'KeyW') { event.preventDefault(); closeTab(activePane().id, currentTab().id); }
  else if (modifier && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); focusSelectedTab = true; saveContext(); workspace.reopenTab(spaceId()); render(); }
  else if (event.altKey && !modifier && event.code === 'KeyB') { event.preventDefault(); toggleSidebar(); }
});
function renderOverview() {
  const w = world(), s = state.snapshot.summary;
  const company = content.folder(w.name, { root: true, wide: true });
  const metrics = child(company, 'metrics');
  company.text('At a glance', 'The company\'s money right now: cash in the bank, what customers owe us, and what we owe others.').host.classList.add('prose');
  for (const [label, value] of [['Cash on hand', money(s.available_cash_minor ?? s.cash_minor)], ['Customers owe us', money(s.receivables_minor)], ['We owe others', money(s.payables_minor)], ['Pending actions', s.pending_operations]]) metrics.text(label, value).host.classList.add('metric');
  const context = company.folder('Company details', { open: false });
  context.text('Scenario', state.boot.scenarios.find(item => item.kind === w.kind)?.name || pretty(w.kind));
  if (w.narrative || w.description) context.text('Context', w.narrative || w.description);
  context.text('Reserved cash', money(s.reserved_minor)); context.text('Refunds we may owe', money(s.refundable_minor)); context.text('Sales not yet in the books', s.unposted_settlements || 0);
  context.folder('Bank matching (reconciliation)', { open: false }).text('Summary', s);
  const control = company.folder('Simulation', { open: false });
  control.text('Time', new Date(w.now).toISOString().replace('T', ' ').replace(':00.000Z', ' UTC'));
  control.buttons([['Advance 1 hour', () => act({ type: 'advance_time', hours: 1 })], ['Advance 24 hours', () => act({ type: 'advance_time', hours: 24 })]]);
  control.text('Period', w.periodClosed ? 'Locked' : 'Open');
  control.buttons([[w.periodClosed ? 'Reopen period' : 'Lock period', () => act({ type: w.periodClosed ? 'reopen_period' : 'close_period' })]]);
  const fault = draft('fault', { system: 'stripe', mode: 'offline' });
  control.select('System', fault.system, choices(systems()), value => fault.system = value);
  control.select('Availability', fault.mode, ['healthy', 'offline', 'rate_limit', 'expired'].map(value => ({ value, label: pretty(value) })), value => fault.mode = value);
  control.buttons([['Apply availability', () => act({ type: 'set_fault', ...fault })]]);
  control.folder('Current faults', { open: false }).text('Provider states', w.faults);
  const events = records('events').filter(event => event.status !== 'cancelled');
  if (events.length) {
    const d = draft('cancel', { event_id: events[0].id, reason: 'The performance is cancelled. Refund admission and admission tax to original captured payments under the signed terms. Service fees remain nonrefundable.' });
    const event = control.folder('Cancel an event', { open: false });
    event.select('Scheduled event', d.event_id, choices(events), value => d.event_id = value);
    event.text('Cancellation notice', d.reason, value => d.reason = value);
    event.buttons([['Confirm cancellation', () => act({ type: 'cancel_event', ...d })]]);
  }
  const approvals = content.folder('Approvals', { root: true, wide: true });
  const pending = records('approvals').filter(item => item.status === 'pending');
  if (!pending.length) approvals.text('Status', 'No pending approvals').host.classList.add('prose');
  for (const approval of pending) {
    const item = approvals.folder(pretty(approval.action?.type || 'Request') + ' · ' + money(approval.amount_minor));
    item.text('Requested by', approval.requested_by); item.text('Request', approval.action);
    const own = approval.requested_by === 'controller-local', d = draft('approval-' + approval.id, { reason: '' });
    if (own) item.text('Review', 'Independent controller required');
    item.text('Reason', d.reason, value => d.reason = value, 'Recorded with the decision; required to reject');
    item.buttons([['Approve', () => act({ type: 'decide_approval', approval_id: approval.id, decision: 'approve', ...(d.reason.trim() ? { reason: d.reason.trim() } : {}) }), own], ['Reject', () => { if (d.reason.trim().length < 3) invalid('Reason', 'Say why; the agent and the audit read it.'); return act({ type: 'decide_approval', approval_id: approval.id, decision: 'reject', reason: d.reason.trim() }); }, own]]);
  }
}
function queueKey() { return 'finance-world-connect-queue:' + state.world; }
async function connect(system) {
  const result = await post(path('/connect/' + encodeURIComponent(system)));
  sessionStorage.setItem('finance-world-return-view', state.view); location.assign(result.authorization_url);
}
function renderConnections() {
  // A seat company reaches only the systems its seat reads; the wider catalog belongs to the older simulations.
  const seatSystems = world().seat ? (state.seatStatus?.systems || []) : null, available = () => seatSystems ? systems().filter(s => seatSystems.includes(s.id)) : systems();
  const pane = content.folder('Connections', { root: true });
  if (seatSystems) pane.text('This seat', 'Reads ' + seatSystems.join(' and ') + ' through connections the controller grants. Writes go through the gateway after approval. Revoke a source and the seat can neither read it nor be launched; the attempt is audited.').host.classList.add('prose');
  pane.buttons([['Connect ' + (seatSystems ? 'the seat\'s systems' : 'core systems'), async () => {
    const queue = (seatSystems || [...['stripe', 'mercury', 'netsuite', 'gmail', 'google-drive', 'ticketing', 'ledger', 'bank'], ...(world().kind === 'procurement-matching' ? ['zip'] : [])]).filter(id => systems().some(system => system.id === id) && !state.snapshot.connections.some(c => c.system === id && c.status === 'connected'));
    if (!queue.length) { notify('All ' + (seatSystems ? 'of the seat\'s' : 'core') + ' systems are connected.'); return; }
    sessionStorage.setItem(queueKey(), JSON.stringify(queue)); await connect(queue[0]);
  }]]);
  const d = draft('connection', { system: seatSystems?.[0] || 'stripe' });
  if (seatSystems && !seatSystems.includes(d.system)) d.system = seatSystems[0];
  pane.select('Source system', d.system, choices(available()), value => { d.system = value; render(); });
  const system = systems().find(s => s.id === d.system), connection = state.snapshot.connections.find(c => c.system === d.system);
  pane.text('Connection', connection?.status || 'disconnected'); pane.text('Availability', world().faults[d.system]?.mode || 'healthy');
  pane.folder('Feeds', { open: false }).text('Available', system?.feeds.join(', '));
  pane.buttons([['Connect ' + system.name, () => connect(d.system)], ['Revoke access', async () => { await post(path('/connections/' + d.system + '/revoke')); await refresh(); notify(system.name + ' access revoked.'); }, connection?.status !== 'connected']]);
  const inventory = content.folder('Connection inventory', { root: true });
  for (const category of [...new Set(available().map(s => s.category))]) {
    const group = inventory.folder(category, { open: false });
    for (const system of available().filter(s => s.category === category)) {
      const c = state.snapshot.connections.find(c => c.system === system.id);
      group.buttons([[system.name + ' · ' + (c?.status || 'disconnected'), () => { d.system = system.id; render(); }]]);
    }
  }
}
function renderMailbox() {
  const actions = child(content, 'compact-actions span-all mailbox-actions');
  for (const [value, label] of [['all', 'All mail'], ['inbound', 'Inbox'], ['outbound', 'Sent']]) actions.action(label, () => { state.mailFilter = value; render(); }, { active: state.mailFilter === value });
  actions.action('Compose', () => openCompose(), { icon: 'compose' });
  actions.action('Receive message', () => openCompose('receive_email'), { icon: 'plus', className: 'icon-button' });
  browse(content, 'Messages', records('messages').slice().reverse().filter(m => state.mailFilter === 'all' || m.direction === state.mailFilter), 'messages');
}
function renderMailForm(parent) {
  const type = state.compose, incoming = type === 'receive_email';
  const d = draft(type, { from: 'operations@promoter.test', to: 'finance@simulation.test', subject: '', body: '', html: '' });
  const pane = parent.folder(incoming ? 'Incoming message' : 'Compose message');
  if (incoming) pane.text('From', d.from, value => d.from = value);
  ['to', 'subject', 'body'].forEach(key => pane.text(key === 'body' ? 'Message' : pretty(key), d[key], value => d[key] = value));
  const extra = pane.folder('Attachments & HTML', { open: false });
  extra.text('HTML', d.html, value => d.html = value);
  if (state.files.length) extra.text('Files', state.files.map(file => file.name).join('\n'));
  extra.buttons([['Choose attachments', () => {
    // Only the operating system file picker is used; the visible trigger is DialKit.
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
    input.addEventListener('change', () => { state.files = [...input.files]; render(); }); input.click();
  }], ['Clear attachments', () => { state.files = []; render(); }, !state.files.length]]);
  pane.buttons([[incoming ? 'Receive message' : 'Send message', async () => {
    if (!d.to.trim()) invalid('To', 'Enter a recipient.'); if (!d.subject.trim()) invalid('Subject', 'Enter a subject.');
    if (state.files.length > 20 || state.files.reduce((n, f) => n + f.size, 0) > 393216 || state.files.some(f => f.size > 262144)) throw Error('Use up to 20 files, 256 KiB each and 384 KiB total.');
    const attachments = await Promise.all(state.files.map(async file => { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return { filename: file.name, mimeType: file.type || 'application/octet-stream', data: btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }; }));
    await act({ type, ...(incoming ? { from: d.from } : {}), to: d.to.split(',').map(v => v.trim()).filter(Boolean), subject: d.subject, body: d.body, ...(d.html ? { html: d.html } : {}), attachments });
    state.compose = null; state.files = []; delete state.draft[type];
    const tab = currentTab(); if (tab?.kind === 'compose') closeTab(activePane().id, tab.id); else render();
    await go('mailbox');
  }], ['Close draft', () => { const tab = currentTab(); if (tab?.kind === 'compose') closeTab(activePane().id, tab.id); else { state.compose = null; render(); } }]]);
}
const financeCollections = ['payments', 'refunds', 'bankTransactions', 'journals', 'accounts', 'invoices', 'bills', 'operations', 'creditNotes', 'disputes', 'paymentReturns'];
const financeLabels = { payments: 'Money in (payments)', refunds: 'Refunds', bankTransactions: 'Bank activity', journals: 'Bookkeeping entries (journals)', accounts: 'Accounts', invoices: 'Invoices we sent', bills: 'Bills we owe', operations: 'Pending operations', creditNotes: 'Credit notes', disputes: 'Disputes', paymentReturns: 'Bounced payments' };
function renderFinance() {
  const pane = content.folder('Money', { root: true, wide: true });
  pane.text('What this is', 'Every money record in one place. Pick a list below; plain names first, the accounting term in parentheses.').host.classList.add('prose');
  pane.select('Show', state.finance, financeCollections.map(value => ({ value, label: financeLabels[value] || pretty(value) })), value => { state.finance = value; state.detail = null; render(); });
  renderFinancialAction(pane);
  browse(content, financeLabels[state.finance] || pretty(state.finance), records(state.finance), 'finance-' + state.finance);
}
function amount(value, field = 'Amount (USD)') { const cents = Math.round(Number(value) * 100); if (!/^\d+(\.\d{1,2})?$/.test(String(value)) || !Number.isSafeInteger(cents) || cents <= 0) invalid(field, 'Enter a positive amount with up to two decimal places.'); return cents; }
function renderFinancialAction(parent) {
  const kinds = ['refund', 'pay_bill', 'collect_invoice', 'post_journal', 'issue_credit_note', 'open_dispute', 'submit_dispute_evidence', 'resolve_dispute', 'return_bill_payment'];
  const d = draft('financial-action', { type: 'refund', amount: '', reason: '', description: '', document_ids: '', external_event_id: 'controller-' + crypto.randomUUID(), outcome: 'won', return_code: 'R03' });
  const pane = parent.folder('New financial action', { open: false });
  pane.select('Action', d.type, kinds.map(value => ({ value, label: pretty(value) })), value => { d.type = value; render(); });
  const text = (label, key) => pane.text(label, d[key] || '', value => d[key] = value);
  const pick = (label, key, rows) => { if (!rows.some(row => row.id === d[key])) d[key] = rows[0]?.id || ''; pane.select(label, d[key], choices(rows), value => { d[key] = value; if (key === 'payment_id') render(); }); };
  if (['refund', 'issue_credit_note', 'open_dispute'].includes(d.type)) pick('Original payment', 'payment_id', records('payments').filter(p => p.status === 'succeeded'));
  if (d.type === 'refund') {
    const notes = records('creditNotes').filter(n => n.payment_id === d.payment_id);
    pick('Credit authorization', 'credit_note_id', [{ id: '', name: 'Ticket refund · no credit note' }, ...notes]);
  }
  if (d.type === 'pay_bill') pick('Supplier bill', 'bill_id', records('bills').filter(b => b.status !== 'paid'));
  if (d.type === 'collect_invoice') pick('Customer invoice', 'invoice_id', records('invoices').filter(i => i.status !== 'paid'));
  if (['submit_dispute_evidence', 'resolve_dispute'].includes(d.type)) pick('Open dispute', 'dispute_id', records('disputes').filter(x => !['won', 'lost'].includes(x.status)));
  if (d.type === 'return_bill_payment') pick('Settled bill payment', 'operation_id', records('operations').filter(x => x.type === 'pay_bill' && x.status === 'settled'));
  if (['refund', 'issue_credit_note', 'open_dispute', 'return_bill_payment', 'post_journal'].includes(d.type)) text('Amount (USD)', 'amount');
  if (['issue_credit_note', 'open_dispute', 'return_bill_payment'].includes(d.type)) text('Reason', 'reason');
  if (['issue_credit_note', 'open_dispute', 'resolve_dispute', 'return_bill_payment'].includes(d.type)) text('External event reference', 'external_event_id');
  if (d.type === 'return_bill_payment') text('Return code', 'return_code');
  if (d.type === 'submit_dispute_evidence') { text('Evidence statement', 'reason'); text('Document IDs, comma-separated', 'document_ids'); }
  if (d.type === 'resolve_dispute') pane.select('Outcome', d.outcome, ['won', 'lost'], value => d.outcome = value);
  if (d.type === 'post_journal') {
    text('Journal description', 'description'); const accounts = records('accounts').filter(a => !['cash-bank', 'cash-processor', 'receivables', 'payables', 'ticket-liability', 'refunds-payable', 'dispute-suspense', 'inventory', 'grni', 'wages-payable', 'employee-withholding-payable', 'employer-payroll-tax-payable', 'bank-suspense'].includes(a.id));
    pick('Debit account', 'debit', accounts); pick('Credit account', 'credit', accounts);
  }
  pane.buttons([['Submit ' + pretty(d.type).toLowerCase(), async () => {
    let input = { type: d.type };
    if (d.type === 'refund') Object.assign(input, { payment_id: d.payment_id, ...(d.credit_note_id ? { credit_note_id: d.credit_note_id } : {}), amount_minor: amount(d.amount) });
    if (d.type === 'pay_bill') input.bill_id = d.bill_id;
    if (d.type === 'collect_invoice') input.invoice_id = d.invoice_id;
    if (d.type === 'issue_credit_note') Object.assign(input, { payment_id: d.payment_id, invoice_id: records('payments').find(p => p.id === d.payment_id)?.invoice_id, amount_minor: amount(d.amount), reason: d.reason, external_event_id: d.external_event_id });
    if (d.type === 'open_dispute') Object.assign(input, { payment_id: d.payment_id, amount_minor: amount(d.amount), reason: d.reason, external_event_id: d.external_event_id });
    if (d.type === 'return_bill_payment') Object.assign(input, { operation_id: d.operation_id, amount_minor: amount(d.amount), reason: d.reason, return_code: d.return_code, external_event_id: d.external_event_id });
    if (d.type === 'submit_dispute_evidence') Object.assign(input, { dispute_id: d.dispute_id, statement: d.reason, document_ids: d.document_ids.split(',').map(v => v.trim()).filter(Boolean) });
    if (d.type === 'resolve_dispute') Object.assign(input, { dispute_id: d.dispute_id, outcome: d.outcome, external_event_id: d.external_event_id });
    if (d.type === 'post_journal') { const cents = amount(d.amount); if (d.debit === d.credit) throw Error('Choose different debit and credit accounts.'); Object.assign(input, { description: d.description, lines: [{ account_id: d.debit, debit_minor: cents, credit_minor: 0, currency: 'USD' }, { account_id: d.credit, debit_minor: 0, credit_minor: cents, currency: 'USD' }] }); }
    await act(input);
  }]]);
}
const procurementCollections = { orders: 'Purchase orders', authority: 'Purchase authority', matching: 'Invoice matching', receipts: 'Goods receipts', stock: 'Inventory', movements: 'Issues & returns' };
const procurementActions = { authorize_purchase: 'Record purchase authority', create_purchase_order: 'Create purchase order', receive_goods: 'Record goods receipt', receive_supplier_invoice: 'Record supplier invoice', correct_supplier_invoice: 'Correct supplier invoice', authorize_inventory_issue: 'Authorize stock issue', issue_inventory: 'Issue inventory', return_inventory: 'Record inventory return' };
const procurementItem = id => records('inventoryItems').find(item => item.id === id);
const procurementItemName = id => { const item = procurementItem(id); return item ? (item.sku || item.id) + ' · ' + item.name : id || 'Unknown item'; };
const procurementVendor = id => records('vendors').find(vendor => vendor.id === id)?.name || id || 'Unknown supplier';
function procurementDocuments(pane, ...sources) {
  const ids = [...new Set(sources.filter(Boolean).flatMap(source => [source.document_id, ...list(source.document_ids)]).filter(Boolean))];
  if (!ids.length) return;
  const evidence = pane.folder('Source evidence', { open: false });
  for (const id of ids) {
    const document = records('documents').find(record => record.id === id);
    evidence.buttons([[(document?.name || id) + ' · ' + id, () => inspect(document || { id, message: 'Document is not present in this snapshot.' }, document?.name || 'Source document')]]);
  }
}
function procurementLineDetails(pane, lines, fields) {
  for (const [index, line] of list(lines).entries()) {
    const item = pane.folder((index + 1) + '. ' + procurementItemName(line.item_id), { open: false });
    if (line.id || line.po_line_id) item.text('Line reference', line.po_line_id || line.id);
    for (const [label, get] of fields) item.text(label, get(line));
  }
}
function procurementSelect(pane, label, rows, key, description) {
  const d = draft('procurement-selection', {});
  if (!rows.length) { pane.text(label, 'No records.'); return null; }
  if (!rows.some(row => row.id === d[key])) d[key] = rows[0].id;
  pane.select(label, d[key], rows.map(row => ({ value: row.id, label: description ? description(row) : row.id })), value => { d[key] = value; state.detail = null; render(); });
  return rows.find(row => row.id === d[key]);
}
function openProcurementForm(type, selected) {
  const d = draft('procurement-workspace', { collection: 'orders', action: 'create_purchase_order' });
  d.action = type;
  if (selected) Object.assign(draft('procurement-form-' + type, {}), selected, { lineSource: null });
  folderStates.set(activeContext.tab + '/Actions/' + procurementActions[type], true);
  render();
}
function renderProcurement() {
  const d = draft('procurement-workspace', { collection: 'orders', action: 'create_purchase_order' }), s = state.snapshot.summary || {};
  const overview = content.folder('Procurement & inventory', { root: true, wide: true });
  overview.text('Purchase orders', records('purchaseOrders').filter(order => order.status === 'awaiting_approval').length + ' awaiting approval · ' + records('purchaseOrders').length + ' total');
  overview.text('Invoices', records('supplierInvoices').filter(invoice => invoice.status === 'blocked').length + ' blocked · ' + records('supplierInvoices').filter(invoice => invoice.status === 'matched').length + ' matched · ' + records('supplierInvoices').filter(invoice => invoice.status === 'received').length + ' awaiting match');
  overview.text('Stock', (s.inventory_quantity ?? records('inventoryItems').reduce((total, item) => total + Number(item.quantity_on_hand || 0), 0)) + ' units · ' + money(s.inventory_value_minor ?? records('inventoryItems').reduce((total, item) => total + Number(item.inventory_value_minor || 0), 0)));
  overview.text('Uninvoiced receipts', money(s.grni_minor));
  overview.select('View', d.collection, Object.entries(procurementCollections).map(([value, label]) => ({ value, label })), value => {
    d.collection = value; d.action = { orders: 'create_purchase_order', authority: 'authorize_purchase', matching: 'receive_supplier_invoice', receipts: 'receive_goods', stock: 'authorize_inventory_issue', movements: 'issue_inventory' }[value]; state.detail = null; render();
  });
  ({ orders: renderProcurementOrders, authority: renderProcurementAuthority, matching: renderProcurementMatching, receipts: renderProcurementReceipts, stock: renderProcurementStock, movements: renderProcurementMovements })[d.collection]();
  renderProcurementForm(d);
}
function renderProcurementOrders() {
  const pane = content.folder('Purchase orders', { root: true });
  const order = procurementSelect(pane, 'Purchase order', records('purchaseOrders'), 'order', row => row.id + ' · ' + procurementVendor(row.vendor_id) + ' · ' + pretty(row.status));
  if (!order) return;
  pane.text('Supplier', procurementVendor(order.vendor_id)); pane.text('Committed amount', money(order.amount_minor)); pane.text('Status', pretty(order.status));
  const approval = records('approvals').find(record => record.id === order.approval_id);
  if (approval) {
    const review = pane.folder('Approval', { open: approval.status === 'pending' });
    review.text('Decision', pretty(approval.status)); review.text('Requested by', approval.requested_by);
    if (approval.status === 'pending') {
      const own = approval.requested_by === (state.boot.actor?.id || state.boot.actor_id || 'controller-local');
      if (own) review.text('Blocked', 'Requester cannot approve this order.');
      review.buttons([['Approve order', () => act({ type: 'decide_approval', approval_id: approval.id, decision: 'approve' }), own], ['Reject order', () => act({ type: 'decide_approval', approval_id: approval.id, decision: 'reject' }), own]]);
    }
    review.buttons([['Inspect approval', () => inspect(approval, 'Purchase order approval')]]);
  }
  procurementLineDetails(pane, order.lines, [['Ordered / received / invoiced', line => [line.quantity, line.received_quantity || 0, line.billed_quantity || 0].join(' / ')], ['Unit price', line => money(line.unit_price_minor)], ['Line amount', line => money(line.amount_minor)]]);
  procurementDocuments(pane, order, records('purchaseRequisitions').find(record => record.id === order.requisition_id));
  pane.buttons([['Inspect purchase order', () => inspect(order, order.id)], ['Record receipt', () => openProcurementForm('receive_goods', { purchase_order_id: order.id }), !['approved', 'partially_received'].includes(order.status)]]);
  const related = pane.folder('Linked invoices & receipts', { open: false });
  for (const receipt of records('goodsReceipts').filter(record => record.purchase_order_id === order.id)) related.buttons([[receipt.id + ' · ' + (receipt.reference || 'Goods receipt'), () => inspect(receipt, 'Goods receipt')]]);
  for (const invoice of records('supplierInvoices').filter(record => record.purchase_order_id === order.id)) related.buttons([[(invoice.invoice_number || invoice.id) + ' · ' + pretty(invoice.status), () => { draft('procurement-selection', {}).invoice = invoice.id; Object.assign(draft('procurement-workspace', {}), {collection: 'matching', action: 'receive_supplier_invoice'}); render(); }]]);
}
function requisitionRemaining(requisition, line) {
  const used = records('purchaseOrders').filter(order => order.requisition_id === requisition.id && order.status !== 'rejected').flatMap(order => list(order.lines)).filter(item => item.item_id === line.item_id).reduce((total, item) => total + Number(item.quantity), 0);
  return Math.max(0, Number(line.quantity) - used);
}
function renderProcurementAuthority() {
  const pane = content.folder('Purchase authority', { root: true });
  const requisition = procurementSelect(pane, 'Purchase requisition', records('purchaseRequisitions'), 'requisition', row => row.id + ' · ' + procurementVendor(row.vendor_id));
  if (!requisition) return;
  pane.text('Purpose', requisition.purpose); pane.text('Supplier', procurementVendor(requisition.vendor_id)); pane.text('Issued by', requisition.issued_by);
  procurementLineDetails(pane, requisition.lines, [['Authorized', line => line.quantity], ['Available to order', line => requisitionRemaining(requisition, line)], ['Price ceiling', line => money(line.max_unit_price_minor)]]);
  procurementDocuments(pane, requisition);
  pane.buttons([['Create order from authority', () => openProcurementForm('create_purchase_order', { requisition_id: requisition.id }), !list(requisition.lines).some(line => requisitionRemaining(requisition, line) > 0)], ['Inspect requisition', () => inspect(requisition, 'Purchase requisition')]]);
}
function renderProcurementMatching() {
  const pane = content.folder('Invoice matching', { root: true });
  const invoices = records('supplierInvoices').slice().sort((a, b) => Number(b.status === 'blocked') - Number(a.status === 'blocked'));
  const invoice = procurementSelect(pane, 'Supplier invoice', invoices, 'invoice', row => (row.invoice_number || row.id) + ' · ' + pretty(row.status) + ' · ' + money(row.amount_minor));
  if (!invoice) return;
  const order = records('purchaseOrders').find(record => record.id === invoice.purchase_order_id), bill = records('bills').find(record => record.id === invoice.bill_id);
  pane.text('Supplier / PO', procurementVendor(invoice.vendor_id) + ' · ' + (invoice.purchase_order_id || 'Missing purchase order'));
  pane.text('Status', pretty(invoice.status));
  const issues = list(invoice.issues);
  if (issues.length) {
    const exceptions = pane.folder(issues.length + ' match exceptions');
    for (const issue of issues) exceptions.text(pretty(issue.code) + (issue.po_line_id ? ' · ' + issue.po_line_id : ''), issue.message);
  }
  for (const line of list(invoice.lines)) {
    const poLine = list(order?.lines).find(item => item.id === line.po_line_id);
    const row = pane.folder(procurementItemName(line.item_id || poLine?.item_id));
    row.text('PO line', line.po_line_id);
    row.text('Ordered / received / this invoice', [poLine?.quantity ?? '—', poLine?.received_quantity ?? '—', line.quantity].join(' / '));
    row.text('Billed on PO', poLine?.billed_quantity ?? '—');
    row.text('Unbilled receipts', poLine ? Math.max(0, (poLine.received_quantity || 0) - (poLine.billed_quantity || 0)) : '—');
    row.text('PO price / invoice price', (poLine ? money(poLine.unit_price_minor) : '—') + ' / ' + money(line.unit_price_minor));
  }
  procurementDocuments(pane, invoice, order, ...records('goodsReceipts').filter(receipt => receipt.purchase_order_id === invoice.purchase_order_id));
  const deliveries = records('supplierInvoiceDeliveries').filter(delivery => delivery.supplier_invoice_id === invoice.id);
  if (deliveries.length) {
    const history = pane.folder('Delivery history', {open: false});
    for (const delivery of deliveries) {
      const row = history.folder((delivery.duplicate ? 'Duplicate delivery' : delivery.correction ? 'Supplier correction' : 'Original delivery') + ' · ' + delivery.id, {open: false});
      row.text('Received at', delivery.received_at); row.text('Invoice revision', delivery.revision);
      procurementDocuments(row, delivery); row.buttons([['Inspect delivery evidence', () => inspect(delivery, 'Invoice delivery')]]);
    }
  }
  pane.buttons([['Run invoice match', () => act({ type: 'match_supplier_invoice', supplier_invoice_id: invoice.id }), invoice.status === 'matched'], ['Correct supplier invoice', () => openProcurementForm('correct_supplier_invoice', { supplier_invoice_id: invoice.id }), !['received', 'blocked'].includes(invoice.status)]]);
  pane.buttons([['Record missing goods', () => openProcurementForm('receive_goods', { purchase_order_id: order.id }), !order || !['approved', 'partially_received'].includes(order.status)], ['Inspect invoice', () => inspect(invoice, 'Supplier invoice')]]);
  if (bill) {
    const payable = pane.folder('Matched payable');
    payable.text('Bill', bill.id); payable.text('Payment status', bill.status); payable.text('Remaining amount', money(Math.max(0, bill.amount_minor - (bill.amount_paid_minor || 0))));
    payable.buttons([['Pay matched bill', () => act({ type: 'pay_bill', bill_id: bill.id }), bill.status === 'paid' || bill.status === 'pending' || bill.amount_minor <= (bill.amount_paid_minor || 0)], ['Inspect payable', () => inspect(bill, 'Matched supplier bill')]]);
  }
}
function renderProcurementReceipts() {
  const pane = content.folder('Goods received', { root: true });
  const receipt = procurementSelect(pane, 'Goods receipt', records('goodsReceipts').slice().reverse(), 'receipt', row => row.id + ' · ' + (row.reference || row.purchase_order_id));
  if (!receipt) return;
  pane.text('Purchase order', receipt.purchase_order_id); pane.text('Received at', receipt.received_at); pane.text('Delivery reference', receipt.reference);
  procurementLineDetails(pane, receipt.lines, [['Received quantity', line => line.quantity], ['Matched to invoice', line => line.billed_quantity || 0], ['Unit cost', line => money(line.unit_cost_minor)], ['Receipt value', line => money(line.amount_minor)]]);
  procurementDocuments(pane, receipt);
  pane.buttons([['Inspect receipt', () => inspect(receipt, 'Goods receipt')], ['Inspect purchase order', () => inspect(records('purchaseOrders').find(order => order.id === receipt.purchase_order_id), 'Purchase order')]]);
}
function renderProcurementStock() {
  const pane = content.folder('Inventory on hand', { root: true });
  if (!records('inventoryItems').length) pane.text('Inventory', 'No items.');
  for (const item of records('inventoryItems')) {
    const row = pane.folder(procurementItemName(item.id));
    row.text('On hand', item.quantity_on_hand); row.text('Carrying value', money(item.inventory_value_minor));
    const lots = row.folder('Receipt lots', {open: false});
    for (const lot of records('inventoryLots').filter(lot => lot.item_id === item.id)) {
      const source = lots.folder(lot.id, {open: false});
      source.text('On hand / received', lot.quantity_on_hand + ' / ' + lot.quantity_received); source.text('Unit cost', money(lot.unit_cost_minor)); source.text('Goods receipt', lot.receipt_id);
      source.buttons([['Inspect receipt lot', () => inspect(lot, 'Inventory receipt lot')]]);
    }
    row.buttons([['Inspect stock item', () => inspect(item, item.name)]]);
  }
  const authority = pane.folder('Stock issue authority');
  const authorization = procurementSelect(authority, 'Issue authorization', records('inventoryAuthorizations'), 'authorization', row => row.id + ' · ' + row.purpose);
  if (authorization) {
    authority.text('Purpose', authorization.purpose);
    procurementLineDetails(authority, authorization.lines, [['Authorized / issued / remaining', line => [line.quantity, line.issued_quantity || 0, Math.max(0, line.quantity - (line.issued_quantity || 0))].join(' / ')]]);
    procurementDocuments(authority, authorization);
    authority.buttons([['Issue authorized stock', () => openProcurementForm('issue_inventory', { authorization_id: authorization.id }), !list(authorization.lines).some(line => line.quantity > (line.issued_quantity || 0))]]);
  }
}
function renderProcurementMovements() {
  const pane = content.folder('Inventory issues & returns', { root: true });
  const movement = procurementSelect(pane, 'Stock movement', records('inventoryMovements').slice().reverse(), 'movement', row => row.id + ' · ' + pretty(row.type) + ' · ' + money(row.value_minor));
  if (!movement) return;
  pane.text('Movement', pretty(movement.type)); pane.text('Recorded at', movement.created_at); pane.text('Inventory value', money(movement.value_minor));
  pane.text(movement.original_issue_id ? 'Original issue' : 'Issue authority', movement.original_issue_id || movement.authorization_id);
  procurementLineDetails(pane, movement.lines, [['Quantity', line => line.quantity], ['Value', line => money(line.value_minor)]]);
  procurementDocuments(pane, movement);
  pane.buttons([['Inspect movement', () => inspect(movement, 'Inventory movement')], ['Record goods returned', () => openProcurementForm('return_inventory', { issue_id: movement.id }), movement.type !== 'issue']]);
}
function procurementRequired(value, label) { const text = String(value ?? '').trim(); if (!text) throw Error('Enter ' + label.toLowerCase() + '.'); return text; }
function renderProcurementForm(workspace) {
  const controls = content.folder('Actions', { root: true });
  controls.select('Action', workspace.action, Object.entries(procurementActions).map(([value, label]) => ({ value, label })), value => { workspace.action = value; folderStates.set(activeContext.tab + '/Actions/' + procurementActions[value], true); render(); });
  const type = workspace.action, key = 'procurement-form-' + type, d = draft(key, {}), pane = controls.folder(procurementActions[type], { open: false });
  const externalTypes = ['authorize_purchase', 'receive_goods', 'receive_supplier_invoice', 'correct_supplier_invoice', 'authorize_inventory_issue', 'return_inventory'];
  if (externalTypes.includes(type) && d.external_event_id === undefined) d.external_event_id = 'judge-' + crypto.randomUUID();
  const text = (label, name) => pane.text(label, d[name] || '', value => d[name] = value);
  const selectRecord = (label, name, rows, describe) => {
    if (!rows.length) { pane.text(label, 'No eligible records.'); return null; }
    if (!rows.some(row => row.id === d[name])) { d[name] = rows[0].id; d.lineSource = null; }
    pane.select(label, d[name], rows.map(row => ({value: row.id, label: describe ? describe(row) : row.id})), value => { d[name] = value; d.lineSource = null; render(); });
    return rows.find(row => row.id === d[name]);
  };
  const setLines = (source, lines) => {
    if (d.lineSource !== source) { d.lineSource = source; d.lines = lines.map(line => ({ ...line, quantity: String(line.quantity ?? 0), price: line.price_minor !== undefined ? (line.price_minor / 100).toFixed(2) : '' })); }
    else for (const line of list(d.lines)) { const current = lines.find(item => (item.po_line_id || item.item_id) === (line.po_line_id || line.item_id)); if (current?.context !== undefined) line.context = current.context; }
  };
  const drawLines = ({ catalog = false, prices = false, ceiling = false } = {}) => {
    for (const [index, line] of list(d.lines).entries()) {
      const row = pane.folder('Line ' + (index + 1) + (catalog ? '' : ' · ' + procurementItemName(line.item_id)));
      if (catalog) row.select('Inventory item', line.item_id, records('inventoryItems').map(item => ({value: item.id, label: procurementItemName(item.id)})), value => line.item_id = value);
      if (line.context) row.text('Limits', line.context);
      row.text('Quantity', line.quantity, value => line.quantity = value);
      if (prices) row.text(ceiling ? 'Maximum unit price (USD)' : 'Unit price (USD)', line.price, value => line.price = value);
      if (catalog) row.buttons([['Remove line ' + (index + 1), () => { d.lines.splice(index, 1); render(); }]]);
    }
    if (catalog) pane.buttons([['Add line item', () => { d.lines.push({item_id: records('inventoryItems')[0]?.id || '', quantity: '1', price: ''}); render(); }]]);
  };
  const readLines = (lineKey = 'item_id', priceKey) => {
    const result = list(d.lines).map(line => {
      const quantity = Number(String(line.quantity).trim() || '0');
      if (!Number.isSafeInteger(quantity) || quantity < 0) throw Error('Line quantities must be whole, nonnegative numbers.');
      if (!quantity) return null;
      return { [lineKey]: procurementRequired(line[lineKey], 'a line item'), quantity, ...(priceKey ? {[priceKey]: amount(line.price)} : {}) };
    }).filter(Boolean);
    if (!result.length) throw Error('Enter a positive quantity for at least one line item.');
    if (new Set(result.map(line => line[lineKey])).size !== result.length) throw Error('Use one line per item. Combine duplicate quantities before submitting.');
    return result;
  };
  const submit = builder => {
    if (externalTypes.includes(type)) text('Event reference', 'external_event_id');
    pane.buttons([[procurementActions[type], async () => {
      const input = builder();
      if (externalTypes.includes(type)) input.external_event_id = procurementRequired(d.external_event_id, 'an external event reference');
      await act(input); delete state.draft[key]; render();
    }]]);
  };
  if (['authorize_purchase', 'authorize_inventory_issue'].includes(type)) {
    if (!records('inventoryItems').length) { pane.text('Blocked', 'No inventory items.'); return; }
    const purchase = type === 'authorize_purchase';
    if (purchase && !selectRecord('Supplier', 'vendor_id', records('vendors'), vendor => vendor.name || vendor.id)) return;
    text('Purpose', 'purpose');
    setLines('catalog', [{item_id: records('inventoryItems')[0].id, quantity: 1}]); drawLines({catalog: true, prices: purchase, ceiling: purchase});
    submit(() => ({type, purpose: procurementRequired(d.purpose, 'a business purpose'), lines: readLines('item_id', purchase ? 'max_unit_price_minor' : undefined), ...(purchase ? {vendor_id: d.vendor_id} : {})}));
    return;
  }
  if (type === 'create_purchase_order') {
    const available = records('purchaseRequisitions').filter(requisition => list(requisition.lines).some(line => requisitionRemaining(requisition, line) > 0));
    const requisition = selectRecord('Purchase requisition', 'requisition_id', available, record => record.id + ' · ' + procurementVendor(record.vendor_id));
    if (!requisition) { pane.text('Blocked', 'No unused purchase authority.'); pane.buttons([['Record purchase authority', () => openProcurementForm('authorize_purchase')]]); return; }
    pane.text('Purpose', requisition.purpose); pane.text('Supplier', procurementVendor(requisition.vendor_id));
    setLines(requisition.id, list(requisition.lines).filter(line => requisitionRemaining(requisition, line) > 0).map(line => ({item_id: line.item_id, quantity: requisitionRemaining(requisition, line), price_minor: line.max_unit_price_minor, context: requisitionRemaining(requisition, line) + ' still authorized · maximum ' + money(line.max_unit_price_minor) + ' per unit'})));
    drawLines({prices: true}); text('Order reason', 'reason'); procurementDocuments(pane, requisition);
    submit(() => ({type, vendor_id: requisition.vendor_id, document_ids: [requisition.document_id], reason: procurementRequired(d.reason, 'an order reason'), lines: readLines('item_id', 'unit_price_minor')}));
    return;
  }
  if (['receive_goods', 'receive_supplier_invoice', 'correct_supplier_invoice'].includes(type)) {
    const receiving = type === 'receive_goods', correcting = type === 'correct_supplier_invoice';
    const invoice = correcting ? selectRecord('Supplier invoice to correct', 'supplier_invoice_id', records('supplierInvoices').filter(record => ['received', 'blocked'].includes(record.status)), record => (record.invoice_number || record.id) + ' · ' + pretty(record.status)) : null;
    if (correcting && !invoice) return;
    const order = correcting ? records('purchaseOrders').find(record => record.id === invoice.purchase_order_id) : selectRecord('Purchase order', 'purchase_order_id', records('purchaseOrders').filter(record => receiving ? ['approved', 'partially_received'].includes(record.status) : ['approved', 'partially_received', 'received', 'closed'].includes(record.status)), record => record.id + ' · ' + procurementVendor(record.vendor_id));
    if (!order) { pane.text('Blocked', receiving ? 'Approved PO with unreceived goods required.' : 'Approved purchase order required.'); return; }
    if (!receiving && !correcting) text('Supplier invoice number', 'invoice_number');
    if (receiving) text('Delivery / receipt reference', 'reference');
    const lines = correcting ? list(invoice.lines).map(line => ({...line, item_id: line.item_id || list(order.lines).find(item => item.id === line.po_line_id)?.item_id, price_minor: line.unit_price_minor})) : list(order.lines).filter(line => !receiving || line.quantity > (line.received_quantity || 0)).map(line => ({po_line_id: line.id, item_id: line.item_id, quantity: receiving ? 0 : Math.max(0, line.quantity - (line.billed_quantity || 0)), price_minor: line.unit_price_minor, context: line.quantity + ' ordered · ' + (line.received_quantity || 0) + ' received · PO unit price ' + money(line.unit_price_minor)}));
    setLines(correcting ? invoice.id : order.id, lines); drawLines({prices: !receiving});
    if (correcting) text('Correction reason', 'reason');
    submit(() => ({type, lines: readLines('po_line_id', receiving ? undefined : 'unit_price_minor'), ...(receiving ? {purchase_order_id: order.id, reference: procurementRequired(d.reference, 'a delivery reference')} : correcting ? {supplier_invoice_id: invoice.id, reason: procurementRequired(d.reason, 'a correction reason')} : {purchase_order_id: order.id, vendor_id: order.vendor_id, invoice_number: procurementRequired(d.invoice_number, 'a supplier invoice number')})}));
    return;
  }
  if (['issue_inventory', 'return_inventory'].includes(type)) {
    const returning = type === 'return_inventory';
    const options = returning ? records('inventoryMovements').filter(record => record.type === 'issue') : records('inventoryAuthorizations').filter(record => list(record.lines).some(line => line.quantity > (line.issued_quantity || 0)));
    const source = selectRecord(returning ? 'Original inventory issue' : 'Stock issue authorization', returning ? 'issue_id' : 'authorization_id', options, record => record.id + (record.purpose ? ' · ' + record.purpose : ''));
    if (!source) { pane.text('Blocked', returning ? 'Original inventory issue required.' : 'Unused issue authorization required.'); return; }
    const lines = list(source.lines).map(line => {
      const returned = returning ? records('inventoryMovements').filter(movement => movement.type === 'return' && movement.original_issue_id === source.id).flatMap(movement => list(movement.lines)).filter(item => item.item_id === line.item_id).reduce((sum, item) => sum + Number(item.quantity), 0) : 0;
      const remaining = Math.max(0, line.quantity - (returning ? returned : line.issued_quantity || 0)), available = procurementItem(line.item_id)?.quantity_on_hand || 0;
      return {item_id: line.item_id, quantity: 0, remaining, available, context: returning ? remaining + ' available to return' : remaining + ' authorized · ' + available + ' on hand'};
    }).filter(line => line.remaining > 0);
    if (!lines.length) { pane.text('Blocked', 'All issued goods have been returned.'); return; }
    setLines(source.id, lines); drawLines();
    if (returning) text('Return reason', 'reason'); else procurementDocuments(pane, source);
    submit(() => ({type, lines: readLines(), ...(returning ? {issue_id: source.id, reason: procurementRequired(d.reason, 'a return reason')} : {authorization_id: source.id})}));
  }
}
async function loadSources(next = false) {
  const query = new URLSearchParams({ system: state.recordSystem, feed: state.recordFeed, limit: '50', ...(next ? { cursor: state.records.next_cursor } : {}) });
  state.records = null; render();
  const result = await api(path('/records?' + query)); state.records = result; state.page.sources = 0; render();
}
function renderSources() {
  const pane = content.folder('Sources', { root: true, wide: true });
  pane.select('Source', state.recordSystem, choices(systems()), value => { state.recordSystem = value; state.recordFeed = systems().find(s => s.id === value).feeds[0]; state.records = null; state.detail = null; render(); });
  pane.select('Feed', state.recordFeed, systems().find(s => s.id === state.recordSystem)?.feeds || [], value => { state.recordFeed = value; state.records = null; state.detail = null; render(); });
  pane.buttons([['Load first page', () => loadSources()], ['Next source page', () => loadSources(true), !state.records?.next_cursor]]);
  if (state.records) { pane.text('Source results', state.records.total + ' total · ' + state.records.data.length + ' in this page'); browse(content, 'Source records', state.records.data, 'sources'); }
}
function workContext() {
  const work = async input => { const result = await post(path('/work'), input, { headers: { 'Idempotency-Key': crypto.randomUUID() } }); await refresh(); notify(pretty(input.type.replace(/^work_|^policy_|^seat_/, '')) + ' · saved'); return result; };
  return {
    world, summary: () => state.snapshot.summary, child, money, pretty, draft, work, api, path, act, worldId: () => state.world, status: () => state.seatStatus, slack: () => state.slackStatus,
    openItem: item => openRecord({ collection: 'workItems', recordId: item.id, title: item.id + ' · ' + item.title, view: 'work' }),
    rerender: () => { if (state.busy || rendering) deferredRender = true; else render(); },
    connect: async missing => { sessionStorage.setItem(queueKey(), JSON.stringify(missing)); await connect(missing[0]); },
    revoke: async system => { await post(path('/connections/' + system + '/revoke')); await refresh(); notify(system + ' access revoked; the seat cannot read it or be launched until the controller reconnects it.'); },
    startShift: async () => { await post(path('/agent'), { instruction: 'Work the queue now.' }); await refresh(); notify('Shift started'); },
    bindSlack: async enabled => { await post(path('/work/slack'), { enabled }); await refresh(); notify(enabled ? 'Slack connected for this company' : 'Slack disconnected'); },
  };
}
function renderWorkView() { renderWork(content, workContext()); }
function renderBooksView() {
  // The Fava frame reports where the controller navigated; keep it on this tab like its scroll position.
  const context = activeContext;
  renderBooks(content, { child, api, path, download, world, worldId: () => state.world, tabId: () => context.tab, rerender: () => { if (state.busy || rendering) deferredRender = true; else render(); },
    savedPath: () => state.booksPath, savePath: booksPath => { const runtime = tabState.get(context.world + ':' + context.tab); if (runtime) runtime.booksPath = booksPath; if (activeContext?.tab === context.tab) state.booksPath = booksPath; workspace.updateTab(context.world, context.tab, { ui: { booksPath } }); } });
}
function renderAgent() {
  const pane = content.folder('Task', { root: true, wide: true });
  const config = state.boot.agent;
  if (!config.available) pane.text('Unavailable', config.reason || 'Configure Anthropic credentials');
  const d = { instruction: space().assistantDraft }, running = state.snapshot.runs.find(run => run.status === 'running');
  let start;
  pane.text('Task brief', d.instruction, value => { d.instruction = value; workspace.updateAssistantDraft(spaceId(), value); if (start) start.disabled = !config.available || !value.trim(); }, 'Ask about this company…');
  pane.folder('Limits', { open: false }).text('Per run', '$2 · 30 turns · 5 minutes');
  if (running) renderAgentResponse(pane, running);
  else start = pane.action('Start agent', async () => { if (!d.instruction.trim()) return; const run = await post(path('/agent'), { instruction: d.instruction }); workspace.updateAssistantDraft(spaceId(), ''); await refresh(); openRecord(runReference(state.snapshot.runs.find(item => item.id === run.id) || run)); }, { icon: 'arrow-right', disabled: !config.available || !d.instruction.trim() });
  const runs = content.folder('Run history', { root: true });
  if (!state.snapshot.runs.length) runs.text('Runs', 'None yet');
  for (const run of state.snapshot.runs.slice().reverse()) {
    runs.action(run.instruction || describeAgentStatus(run).label, () => openRecord(runReference(run)), { icon: 'agent', className: 'agent-history-row', meta: describeAgentStatus(run).label + ' · ' + runDate(run) });
  }
}
function renderDelivery() {
  const hooks = state.snapshot.webhooks;
  const pane = content.folder('Event delivery', { root: true, wide: true });
  pane.text('Receiver', hooks.receiver.mode === 'fail' ? 'Offline · 503' : 'Accepting');
  pane.text('Verified receipts', hooks.receiver.receipts.length);
  pane.buttons([[hooks.receiver.mode === 'fail' ? 'Restore receiver' : 'Fail receiver', async () => { await post(path('/webhooks/receiver'), { mode: hooks.receiver.mode === 'fail' ? 'accept' : 'fail' }); await refresh(); }], ['Deliver due events', async () => { const result = await post(path('/webhooks/dispatch')); await refresh(); notify(result.attempted + ' attempted · ' + result.delivered + ' delivered.'); }]]);
  const d = draft('webhook', { url: '', events: 'operation.*', signingStyle: 'generic' });
  const add = pane.folder('Add subscription', { open: false });
  add.text('Callback URL', d.url, value => d.url = value, 'Local receiver');
  add.text('Events', d.events, value => d.events = value);
  add.select('Signature style', d.signingStyle, ['generic', 'stripe'], value => d.signingStyle = value);
  add.buttons([['Create subscription', async () => { const subscription = await post(path('/webhooks'), { ...d, events: d.events.split(',').map(v => v.trim()).filter(Boolean) }); await refresh(); inspect(subscription, 'New subscription · signing secret'); }]]);
  for (const sub of hooks.subscriptions) {
    const item = pane.folder(sub.id + ' · ' + (sub.active ? 'active' : 'disabled'), { open: false });
    item.text('Destination', sub.url); item.text('Events', sub.events);
    item.buttons([['Disable subscription', async () => { await post(path('/webhooks/' + sub.id + '/disable')); await refresh(); }, !sub.active]]);
  }
  const deliveries = hooks.deliveries.data || [];
  const page = browse(content, 'Deliveries', deliveries, 'deliveries', item => [item.status, item.event?.type, item.id].join(' · '));
  for (const delivery of deliveries.filter(d => ['retrying', 'dead'].includes(d.status))) page.buttons([['Retry ' + delivery.id, async () => { await post(path('/webhooks/deliveries/' + delivery.id + '/retry')); await post(path('/webhooks/dispatch')); await refresh(); }]]);
  page.buttons([['Inspect receiver receipts', () => inspect({ receipts: hooks.receiver.receipts }, 'Verified receipts')]]);
}
function auditOptions(preferences, parent) {
  const context = parent.context;
  return { worldId: spaceId(), preferences, child, trackScroll, api, rerender: render, notify, download, runs: state.snapshot?.runs || [],
    publish() { if (state.busy || rendering) deferredRender = true; else render(); },
    focus(selector) {
      const target = document.querySelector('[data-pane="' + context.pane + '"] ' + selector);
      if (!target?.getClientRects().length) return;
      pendingFocus = { key: target.dataset.focusKey, world: context.world, tab: context.tab }; forceFocus = true; focusSelectedTab = false;
      if (!state.busy) restoreFocus(pendingFocus);
    },
    openEvent(event) { openRecord({ collection: 'audit', recordId: String(event.seq), title: describeAuditEvent(event).title, view: 'audit' }); },
  };
}
function renderAudit() {
  renderAuditView(content, auditOptions(draft('audit-view', { query: '', scope: 'activity', selected: null, expanded: [], raw: false, reading: false }), content));
}
function renderCreate() {
  const d = draft('create', { name: '', kind: 'tour-settlements', seed: '42', orderCount: 24, cash: '', threshold: '', cancelEvent: true, narrative: '' });
  const pane = content.folder('New company', { root: true });
  pane.text('What this is', 'Create a company for the AI to work at. Scenarios marked "Seat" come with an AI finance officer that learns the job and works on its own.').host.classList.add('prose');
  pane.text('Company name', d.name, value => d.name = value);
  pane.select('Scenario', d.kind, [...state.boot.scenarios].sort((a, b) => Number((state.boot.seats || []).includes(b.kind)) - Number((state.boot.seats || []).includes(a.kind))).map(s => ({ value: s.kind, label: ((state.boot.seats || []).includes(s.kind) ? 'Seat · ' : 'Other simulation · ') + s.name })), value => { d.kind = value; d.orderCount = value === 'procurement-matching' && !d.recordCountEdited ? 4 : Math.min(d.orderCount, value === 'ticket-cancellation' ? 2000 : 200); state.generated = null; render(); });
  pane.folder('Scenario details', { open: false }).text('Description', state.boot.scenarios.find(s => s.kind === d.kind)?.description);
  pane.text('Random seed', d.seed, value => d.seed = value, 'Any number; the same seed recreates the same company');
  pane.slider(d.kind === 'procurement-matching' ? 'Purchase orders' : 'How much activity', d.orderCount, 1, d.kind === 'ticket-cancellation' ? 2000 : 200, 1, value => { d.orderCount = value; d.recordCountEdited = true; });
  pane.text('Opening cash (USD)', d.cash, value => d.cash = value, 'Scenario default');
  pane.text('Needs approval above (USD)', d.threshold, value => d.threshold = value, 'Scenario default');
  if (d.kind === 'ticket-cancellation') pane.toggle('Event starts cancelled', d.cancelEvent, value => d.cancelEvent = value);
  pane.folder('Company context', { open: false }).text('Notes', d.narrative, value => d.narrative = value);
  pane.buttons([['Create company', async () => {
    if (!d.name.trim()) invalid('Company name', 'Enter a company name.'); if (!d.seed.trim()) invalid('Random seed', 'Enter any number.');
    const optionalMoney = value => { if (String(value) === '0') return 0; return amount(value); };
    const input = { ...(state.generated || {}), name: d.name.trim(), kind: d.kind, seed: d.seed, orderCount: d.orderCount, cancelEvent: d.cancelEvent };
    if (d.narrative.trim()) input.narrative = d.narrative.trim(); else delete input.narrative;
    if (d.cash !== '') { delete input.startingCashMinor; input.initialCashMinor = optionalMoney(d.cash); }
    if (d.threshold !== '') input.approvalThresholdMinor = optionalMoney(d.threshold);
    const result = await post('/api/worlds', input); state.boot = await api('/api/bootstrap'); state.view = (state.boot.seats || []).includes(input.kind) ? 'work' : 'overview'; state.generated = null; await chooseWorld(result.world.id); notify('Company created');
  }]]);
  const generator = content.folder('Or describe it in words', { root: true });
  const prompt = draft('generate', { prompt: '' });
  generator.text('Describe the company', prompt.prompt, value => prompt.prompt = value, 'e.g. "A small concert venue in Austin with 40 shows a year"');
  generator.buttons([['Generate with AI', async () => {
    const result = await post('/api/generate', { prompt: prompt.prompt }, { signal: AbortSignal.timeout(310000) }); const scenario = result.scenario || result;
    state.generated = scenario; Object.assign(d, { name: scenario.name || d.name, kind: scenario.kind || d.kind, seed: String(scenario.seed ?? d.seed), orderCount: scenario.orderCount ?? d.orderCount, narrative: scenario.narrative || '', cancelEvent: scenario.cancelEvent ?? true });
    if ((scenario.initialCashMinor ?? scenario.startingCashMinor) !== undefined) d.cash = String((scenario.initialCashMinor ?? scenario.startingCashMinor) / 100);
    if (scenario.approvalThresholdMinor !== undefined) d.threshold = String(scenario.approvalThresholdMinor / 100);
    render(); notify('Draft ready for review');
  }, !state.boot.agent.available]]);
  if (state.generated) { if (state.generated.limitations?.length) generator.text('Limitations', state.generated.limitations); generator.folder('Configuration', { open: false }).text('Settings', state.generated); }
}
async function consent() {
  const system = location.pathname.split('/')[2];
  root.host.classList.add('consent'); root.host.dataset.theme = workspace.settings.theme;
  const pane = root.folder('Connection consent', { root: true });
  statusControl = pane.text('Status', 'Loading request…');
  const info = await api('/oauth/' + encodeURIComponent(system) + '/consent' + location.search);
  pane.text('Company', info.company); pane.text('System', info.provider.name); pane.text('Application', info.client); pane.text('Requested access', info.scopes.join(' and '));
  pane.text('Mode', 'Simulation');
  pane.buttons([['Allow connection', () => submit('allow')], ['Cancel connection', () => submit('deny')]]);
  function submit(decision) {
    // Hidden transport fields preserve the existing OAuth/PKCE redirect protocol.
    const form = document.createElement('form'); form.method = 'POST'; form.action = location.pathname; form.hidden = true;
    const params = new URLSearchParams(location.search); params.set('decision', decision);
    for (const [name, value] of params) { const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input); }
    document.body.append(form); form.requestSubmit();
  }
  notify('Consent required');
}
async function initialize() {
  if (/^\/oauth\/[^/]+\/authorize$/.test(location.pathname)) { await consent(); return; }
  state.boot = await api('/api/bootstrap');
  const url = new URL(location.href), wanted = url.searchParams.get('world') || localStorage.getItem('finance-world-id');
  state.world = state.boot.worlds.some(w => w.id === wanted) ? wanted : state.boot.worlds[0]?.id || '';
  const previous = url.searchParams.get('view') || (url.searchParams.has('connected') ? sessionStorage.getItem('finance-world-return-view') : '') || localStorage.getItem('finance-world-tab');
  state.view = views.includes(previous) ? previous : state.world ? (world().seat ? 'work' : 'overview') : 'create';
  if (state.world) await loadSnapshot(state.world);
  const tabId = url.searchParams.get('tab'), savedPane = space().panes.find(p => p.tabs.some(t => t.id === tabId));
  if (savedPane) workspace.activateTab(spaceId(), savedPane.id, tabId);
  else if (url.searchParams.has('view') || url.searchParams.has('connected') || !state.world) workspace.openView(spaceId(), state.view, labels[state.view]);
  notify('Ready'); render();
  if (url.searchParams.has('oauth_error') || url.searchParams.has('error')) { sessionStorage.removeItem(queueKey()); notify('Connection was not granted: ' + (url.searchParams.get('oauth_error') || url.searchParams.get('error'))); }
  const connected = url.searchParams.get('connected');
  if (connected) {
    const queue = JSON.parse(sessionStorage.getItem(queueKey()) || '[]').filter(id => id !== connected && systems().some(s => s.id === id));
    sessionStorage.setItem(queueKey(), JSON.stringify(queue));
    if (queue.length) { await connect(queue[0]); return; }
    notify(connected + ' connected.');
  }
  let polling = false;
  setInterval(async () => {
    if (state.busy || polling) return;
    if (deferredRender && !interacting()) { deferredRender = false; render(); }
    // A seat on duty works without anyone clicking, so its company stays live.
    if (!state.snapshot?.runs.some(run => run.status === 'running') && !state.snapshot?.world?.seat?.autonomy?.enabled) return;
    polling = true;
    try { await refresh(true); } catch (error) { notify('Refresh failed: ' + error.message, true); }
    finally { polling = false; }
  }, 5000);
}
initialize().catch(error => {
  if (!statusControl) { root.clear(); const pane = root.folder('gram', { root: true }); statusControl = pane.text('Service error', error.message); pane.buttons([['Reload', () => location.reload()]]); }
  notify(error.message);
});

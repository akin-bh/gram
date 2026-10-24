import { buildAuditTree, describeAuditEvent } from './audit-tree.js';
import { renderAuditPayload } from './audit-payload.js';
import { icon } from './icons.js';

const pages = new Map(), eventRecords = new Map(), checks = new Map(), payloadExpansion = new Map();
const base = world => '/api/worlds/' + encodeURIComponent(world) + '/audit';
const text = (parent, className, value, tag = 'div') => {
  const node = document.createElement(tag); node.className = className; node.textContent = value; parent.host.append(node); return node;
};
const date = (value, options) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], options) : 'Unknown time';
const time = value => date(value, { hour: 'numeric', minute: '2-digit' });
const recorded = value => date(value, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const eventKey = (world, seq) => world + ':' + seq;
const changed = source => [...(source.listeners || [])].forEach(listener => listener());
function subscribe(surface, source, publish) {
  source.listeners ||= new Set();
  const listener = () => { if (surface.host.isConnected) publish(); };
  source.listeners.add(listener); surface.keep({ destroy() { source.listeners.delete(listener); } });
}
function remember(world, rows) {
  for (const row of rows) { const key = eventKey(world, row.seq), record = eventRecords.get(key) || {}; record.event = row; record.error = null; eventRecords.set(key, record); }
  while (eventRecords.size > 500) eventRecords.delete(eventRecords.keys().next().value);
}
export function invalidateAudit(world) {
  for (const page of pages.values()) if (page.world === world) { page.stale = true; page.error = null; }
  for (const [key, record] of eventRecords) if (key.startsWith(world + ':') && record.error) eventRecords.delete(key);
}
export function cachedAuditEvent(world, seq) { return eventRecords.get(eventKey(world, seq))?.event; }
function pageFor(world, preferences) {
  const query = String(preferences.query || '').trim().slice(0, 200), scope = ['all', 'activity', 'errors'].includes(preferences.scope) ? preferences.scope : 'activity';
  const key = JSON.stringify([world, scope, query]);
  let page = pages.get(key);
  if (!page) { page = { key, world, query, scope, rows: [], loaded: false, loading: false, cursor: null, snapshot: null, error: null, generation: 0 }; pages.set(key, page); }
  pages.delete(key); pages.set(key, page);
  while (pages.size > 12) pages.delete(pages.keys().next().value);
  return page;
}
async function loadPage(page, api, append = false) {
  if (page.loading || append && !page.cursor) return;
  const generation = ++page.generation;
  page.loading = true; page.error = null; page.stale = false; page.lastAppend = append;
  const query = new URLSearchParams({ order: 'desc', limit: '100', scope: page.scope });
  if (page.query) query.set('q', page.query);
  if (append) { query.set('before', page.cursor); query.set('snapshot', page.snapshot); }
  try {
    const result = await api(base(page.world) + '?' + query);
    if (generation !== page.generation) return;
    page.rows = [...new Map([...(append ? page.rows : []), ...result.data].map(row => [row.seq, row])).values()].sort((a, b) => b.seq - a.seq);
    page.cursor = result.next_cursor; page.snapshot = result.snapshot_seq; page.head = result.head_seq; page.loaded = true;
    remember(page.world, result.data);
  } catch (error) { if (generation === page.generation) page.error = error.message; }
  finally { if (generation === page.generation) { page.loading = false; changed(page); } }
}
function ensureEvent(world, seq, api) {
  const key = eventKey(world, seq);
  if (!eventRecords.has(key)) {
    const record = { loading: true }; eventRecords.set(key, record);
    void api(base(world) + '/events/' + encodeURIComponent(seq)).then(event => { record.event = event; }, error => { record.error = error.message; }).finally(() => { record.loading = false; changed(record); });
  }
  return eventRecords.get(key);
}
function findPath(nodes, seq, parents = []) {
  for (const node of nodes) {
    if (node.kind === 'event' && node.event?.seq === seq) return parents;
    const path = node.children?.length && findPath(node.children, seq, [...parents, node.id]);
    if (path) return path;
  }
  return null;
}
function compactRequests(nodes) {
  return nodes.map(node => {
    if (node.kind === 'request' && node.children.length === 1) return node.children[0];
    return node.children?.length ? { ...node, children: compactRequests(node.children) } : node;
  });
}
function flatten(nodes, expanded, depth = 0, ancestors = [], parent = null) {
  return nodes.flatMap((node, index) => {
    const last = index === nodes.length - 1, open = Boolean(node.children?.length && expanded.has(node.id));
    return [{ node, depth, ancestors, last, open, parent, position: index + 1, size: nodes.length }, ...(open ? flatten(node.children, expanded, depth + 1, [...ancestors, !last], node.id) : [])];
  });
}
function branches(row) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'audit-branches'); svg.setAttribute('viewBox', `0 0 ${row.depth * 18 + 30} 52`);
  svg.setAttribute('width', row.depth * 18 + 30); svg.setAttribute('height', '52'); svg.setAttribute('aria-hidden', 'true');
  const lines = [];
  for (let level = 0; level < row.depth - 1; level++) if (row.ancestors[level + 1]) lines.push(`M${14 + level * 18} 0V52`);
  if (row.depth) {
    const x = 14 + (row.depth - 1) * 18;
    lines.push(`M${x} 0V${row.last ? 26 : 52}`, `M${x} 26H${x + 10}`);
  }
  if (row.open) lines.push(`M${14 + row.depth * 18} 34V52`);
  for (const d of lines) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
function dayLabel(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Undated';
  const d = new Date(value), now = new Date();
  return d.toDateString() === now.toDateString() ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export function renderAuditView(parent, options) {
  const { worldId, preferences: p, child, trackScroll, api, rerender, publish, focus, runs = [], notify, download, openEvent } = options;
  parent.host.classList.add('audit-content'); parent.host.closest('.pane-scroll')?.classList.add('audit-pane');
  const page = pageFor(worldId, p), screen = child(parent, 'audit-screen', 'audit-screen');
  screen.host.dataset.auditKey = page.key; screen.host.dataset.reading = String(Boolean(p.reading));
  subscribe(screen, page, publish);
  if ((!page.loaded || page.stale) && !page.loading && !page.error) void loadPage(page, api);
  const toolbar = child(screen, 'audit-toolbar', 'audit-toolbar');
  let timer;
  const clearSelection = () => { p.selected = null; p.expanded = []; p.focused = null; p.reading = false; p.raw = false; };
  const reset = () => { clearSelection(); rerender(); };
  const filter = toolbar.text('Search audit', p.query || '', value => { p.query = value; clearSelection(); clearTimeout(timer); timer = setTimeout(rerender, 250); }, 'Search events…');
  filter.host.classList.add('audit-search'); filter.input.maxLength = 200; filter.input.spellcheck = false;
  filter.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); clearTimeout(timer); reset(); } });
  toolbar.keep({ destroy() { clearTimeout(timer); } });
  if (p.query) toolbar.action('Clear audit search', () => { p.query = ''; reset(); }, { icon: 'close', className: 'icon-button audit-search-clear' });
  const scope = child(toolbar, 'audit-scope', 'audit-scope');
  scope.select('Show events', p.scope || 'activity', [{ value: 'activity', label: 'Activity' }, { value: 'all', label: 'All events' }, { value: 'errors', label: 'Attention' }], value => { p.scope = value; reset(); });
  const actions = child(toolbar, 'audit-tools', 'audit-tools'), verification = checks.get(worldId);
  const verify = actions.action(verification ? verification.valid ? 'Verified' : 'Check failed' : 'Verify', async () => {
    const result = await api(base(worldId) + '/verify'); checks.set(worldId, { ...result, at: new Date().toISOString() }); rerender();
  }, { icon: 'check', className: 'audit-verify' });
  if (verification) {
    verify.dataset.tone = verification.valid ? 'success' : 'error';
    verify.title = verification.valid ? `${verification.checked} events verified at ${recorded(verification.at)}` : `Chain breaks at event ${verification.broken_at}`;
    verify.setAttribute('aria-label', verify.title);
  }
  actions.action('Export audit JSONL', () => download(base(worldId) + '/export', worldId + '-audit.jsonl'), { icon: 'download', className: 'icon-button' });
  if (verification && !verification.valid) text(screen, 'audit-error', 'Integrity check failed at event ' + verification.broken_at, 'p').setAttribute('role', 'alert');
  const tree = compactRequests(buildAuditTree(page.rows, { runs }));
  if (p.selected == null && page.rows.length) {
    p.selected = page.rows[0].seq;
    p.expanded = [...new Set([...(p.expanded || []), ...(findPath(tree, p.selected) || [])])];
  }
  const expanded = new Set(p.expanded || []), rows = flatten(tree, expanded);
  const body = child(screen, 'audit-columns', 'audit-columns');
  const list = child(body, 'audit-list', 'audit-list');
  const treeHost = child(list, 'audit-tree', 'audit-tree'); treeHost.host.setAttribute('role', 'tree'); treeHost.host.setAttribute('aria-label', 'Audit events');
  const buttons = new Map(), preferred = rows.some(row => row.node.id === p.focused) ? p.focused : rows.find(row => row.node.event?.seq === p.selected)?.node.id || rows[0]?.node.id;
  let lastDay, typeAhead = '', typeTimer;
  const moveFocus = id => {
    if (!buttons.has(id)) return;
    p.focused = id;
    for (const [key, button] of buttons) button.tabIndex = key === id ? 0 : -1;
    buttons.get(id).focus({ preventScroll: true }); buttons.get(id).scrollIntoView({ block: 'nearest' });
  };
  const toggle = row => {
    if (row.open) expanded.delete(row.node.id); else expanded.add(row.node.id);
    p.expanded = [...expanded]; p.focused = row.node.id; rerender();
  };
  for (const [index, row] of rows.entries()) {
    const node = row.node;
    if (!row.depth) {
      const label = dayLabel(node.at);
      if (label !== lastDay) { text(treeHost, 'audit-day', label).setAttribute('role', 'presentation'); lastDay = label; }
    }
    const item = child(treeHost, 'audit-tree-item', node.id); item.host.setAttribute('role', 'none');
    const group = node.kind !== 'event';
    const button = item.action(node.title, () => {
      p.focused = node.id;
      if (group) toggle(row);
      else { p.selected = node.event.seq; p.reading = true; p.raw = false; rerender(); focus('.audit-back button'); }
    }, { className: 'audit-tree-control', title: group ? `${node.title} · ${node.count} loaded ${node.count === 1 ? 'event' : 'events'}` : `${node.title} · Event ${node.event.seq}` });
    item.identify(button, 'audit-node', node.id); button.dataset.nodeId = node.id;
    button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', row.depth + 1);
    button.setAttribute('aria-posinset', row.position); button.setAttribute('aria-setsize', row.size);
    if (group) button.setAttribute('aria-expanded', row.open);
    else button.setAttribute('aria-selected', node.event.seq === p.selected);
    button.tabIndex = node.id === preferred ? 0 : -1; button.style.setProperty('--depth', row.depth); button.dataset.tone = node.tone || 'neutral';
    const label = button.querySelector('.button-label'); label.className = 'audit-node-title';
    const copy = document.createElement('span'); copy.className = 'audit-node-copy'; copy.append(label);
    const caption = document.createElement('span'); caption.className = 'audit-node-caption';
    caption.textContent = [node.actor === 'Mixed actors' ? '' : node.actor, group ? node.summary.replace(/(?: · )?\d+ events?$/, '') : node.summary].filter(Boolean).join(' · '); copy.append(caption);
    const marker = document.createElement('span'); marker.className = 'audit-node-marker'; marker.setAttribute('aria-hidden', 'true');
    if (group) { marker.append(icon('chevron-down')); marker.dataset.open = String(row.open); }
    else marker.append(icon(node.icon || 'file'));
    const trailing = document.createElement('span'); trailing.className = 'audit-node-time'; trailing.textContent = group ? node.count : time(node.at); trailing.title = group ? node.count + ' loaded events' : recorded(node.at);
    button.replaceChildren(branches(row), marker, copy, trailing); buttons.set(node.id, button);
    button.addEventListener('focus', () => { p.focused = node.id; for (const [id, sibling] of buttons) sibling.tabIndex = id === node.id ? 0 : -1; });
    button.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); return; }
      let target;
      if (event.key === 'ArrowDown') target = rows[Math.min(rows.length - 1, index + 1)]?.node.id;
      else if (event.key === 'ArrowUp') target = rows[Math.max(0, index - 1)]?.node.id;
      else if (event.key === 'Home') target = rows[0]?.node.id;
      else if (event.key === 'End') target = rows.at(-1)?.node.id;
      else if (event.key === 'ArrowRight' && group) { event.preventDefault(); if (!row.open) toggle(row); else moveFocus(rows[index + 1]?.node.id); return; }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); if (row.open) toggle(row); else if (row.parent) moveFocus(row.parent); return; }
      else if (event.key.length === 1 && event.key !== ' ') {
        typeAhead += event.key.toLocaleLowerCase(); clearTimeout(typeTimer); typeTimer = setTimeout(() => { typeAhead = ''; }, 600);
        const candidates = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
        target = candidates.find(candidate => candidate.node.title.toLocaleLowerCase().startsWith(typeAhead))?.node.id;
      }
      if (target) { event.preventDefault(); moveFocus(target); }
    });
  }
  treeHost.keep({ destroy() { clearTimeout(typeTimer); } });
  if (!rows.length) {
    const empty = child(list, 'audit-empty', 'audit-empty');
    text(empty, '', page.loading ? 'Loading events…' : page.error ? 'Audit unavailable' : 'No matching events', 'p');
    if (page.error) { text(empty, 'audit-error', page.error, 'p'); empty.action('Retry', () => loadPage(page, api), { icon: 'refresh' }); }
  }
  const footer = child(list, 'audit-list-footer', 'audit-list-footer');
  const count = text(footer, 'audit-count', page.loaded ? page.rows.length + ' loaded' : ''); count.setAttribute('role', 'status');
  if (page.cursor) footer.action(page.loading ? 'Loading…' : 'Load older', () => loadPage(page, api, true), { icon: 'arrow-left', className: 'audit-load', disabled: page.loading });
  if (page.error && rows.length) { text(footer, 'audit-error', page.error); footer.action('Retry loading', () => loadPage(page, api, page.lastAppend), { icon: 'refresh' }); }
  trackScroll(list, worldId + ':' + parent.key + ':audit-list:' + page.key, 'Audit tree');
  const detail = child(body, 'audit-detail', 'audit-detail');
  if (p.selected != null) {
    const record = ensureEvent(worldId, p.selected, api); subscribe(detail, record, publish);
    const back = () => { p.reading = false; rerender(); focus('[data-node-id="' + (rows.some(row => row.node.event?.seq === p.selected) ? 'event:' + p.selected : preferred) + '"]'); };
    if (record.event) renderEvent(detail, record.event, { ...options, back, preferences: p });
    else {
      const loading = text(detail, 'audit-empty', record.error || 'Loading event…', 'p');
      if (record.error) { loading.setAttribute('role', 'alert'); detail.action('Retry event', () => { eventRecords.delete(eventKey(worldId, p.selected)); rerender(); }, { icon: 'refresh' }); }
      detail.action('Back to events', back, { icon: 'arrow-left' });
    }
  } else text(detail, 'audit-empty', 'Select an event', 'p');
  trackScroll(detail, worldId + ':' + parent.key + ':audit-event:' + p.selected + ':' + Boolean(p.raw), 'Event details');
}

function renderEvent(parent, event, options) {
  const { child, preferences: p, rerender, worldId, notify, back, openEvent } = options, description = describeAuditEvent(event);
  const header = child(parent, 'audit-detail-header', 'audit-detail-header');
  if (back) header.action('Back to events', back, { icon: 'arrow-left', className: 'icon-button audit-back' });
  const heading = child(header, 'audit-detail-heading', 'audit-detail-heading');
  text(heading, 'audit-event-number', 'Event ' + event.seq);
  text(heading, 'audit-event-title', description.title, 'h2');
  const actions = child(header, 'audit-detail-actions', 'audit-detail-actions');
  actions.action('Copy event JSON', async () => { await navigator.clipboard.writeText(JSON.stringify(event, null, 2)); notify('Copied'); }, { icon: 'copy', className: 'icon-button' });
  if (openEvent) actions.action('Open event in tab', () => openEvent(event), { icon: 'external', className: 'icon-button' });
  const modes = child(parent, 'audit-detail-modes', 'audit-detail-modes');
  for (const [label, raw] of [['Event', false], ['Raw', true]]) {
    const button = modes.action(label, () => { p.raw = raw; rerender(); }, { className: 'audit-mode', active: Boolean(p.raw) === raw });
    button.setAttribute('aria-pressed', Boolean(p.raw) === raw); button.removeAttribute('aria-current');
  }
  if (p.raw) {
    const value = JSON.stringify(event, null, 2);
    text(parent, 'audit-raw', value.slice(0, 100000), 'pre');
    if (value.length > 100000) { text(parent, 'audit-count', 'Preview limited to 100,000 characters.'); parent.action('Download event', () => {
      const url = URL.createObjectURL(new Blob([value], { type: 'application/json' })), a = document.createElement('a'); a.href = url; a.download = 'audit-' + event.seq + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, { icon: 'download' }); }
    return;
  }
  if (description.summary) text(parent, 'audit-event-summary', description.summary, 'p');
  const facts = document.createElement('dl'); facts.className = 'audit-facts'; parent.host.append(facts);
  for (const [key, value] of [['Recorded', recorded(event.at)], ['Actor', description.actor], ['Type', event.type], ...(event.request_id ? [['Request', event.request_id]] : [])]) {
    const label = document.createElement('dt'), content = document.createElement('dd'); label.textContent = key; content.textContent = value; facts.append(label, content);
  }
  const payload = child(parent, 'audit-payload', 'audit-payload-' + event.seq);
  let expanded = payloadExpansion.get(eventKey(worldId, event.seq)); if (!expanded) { expanded = new Set(); payloadExpansion.set(eventKey(worldId, event.seq), expanded); }
  while (payloadExpansion.size > 500) payloadExpansion.delete(payloadExpansion.keys().next().value);
  renderAuditPayload(payload, event.data, { child, expanded });
  const integrity = child(parent, 'audit-integrity', 'audit-integrity-' + event.seq);
  const showIntegrity = Boolean(p.integrity);
  const control = integrity.action('Integrity', () => { p.integrity = !p.integrity; rerender(); }, { icon: 'chevron-down', className: 'audit-integrity-toggle' }); control.setAttribute('aria-expanded', showIntegrity);
  if (showIntegrity) { text(integrity, 'audit-count', 'Previous hash'); text(integrity, 'audit-hash', event.previous_hash, 'code'); text(integrity, 'audit-count', 'Hash'); text(integrity, 'audit-hash', event.hash, 'code'); }
}

export function renderAuditRecord(parent, options) {
  const { worldId, seq, child, api, publish } = options;
  const record = ensureEvent(worldId, seq, api);
  const reader = child(parent, 'audit-record', 'audit-record-' + seq); parent.host.classList.add('audit-record-content');
  subscribe(reader, record, publish);
  if (record.event) renderEvent(reader, record.event, options);
  else { text(reader, 'audit-empty', record.error || 'Loading event…', 'p'); if (record.error) reader.action('Retry', () => { eventRecords.delete(eventKey(worldId, seq)); options.rerender(); }, { icon: 'refresh' }); }
}

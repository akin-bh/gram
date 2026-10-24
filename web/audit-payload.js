const BATCH_SIZE = 30;
const STRING_BATCH = 1000;
const MAX_DEPTH = 12;
const SMALL_COLLECTION = 8;
const expansionState = new WeakMap();
let nextId = 0;

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const pointer = (path, key) => path + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const collection = value => value !== null && typeof value === 'object';
const countLabel = (value, count) => count + (Array.isArray(value) ? count === 1 ? ' item' : ' items' : count === 1 ? ' field' : ' fields');
const readOwn = (value, key) => {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && 'value' in property ? property.value : property ? '[Accessor]' : undefined;
};

/**
 * Render JSON data with native DialKit disclosure actions and semantic dt/dd pairs.
 * Reuse an expanded Set per event; its keys are escaped JSON-pointer paths.
 * The returned Surface is already owned by parentSurface through child().
 */
export function renderAuditPayload(parentSurface, value, { child, expanded = new Set() } = {}) {
  if (typeof child !== 'function') throw new TypeError('renderAuditPayload requires the child Surface factory.');
  if (!(expanded instanceof Set)) throw new TypeError('expanded must be a Set.');
  let state = expansionState.get(expanded);
  if (!state) {
    state = { initialized: new Set(), counts: new Map(), strings: new Map() };
    expansionState.set(expanded, state);
  }
  const tree = child(parentSurface, 'audit-data-tree', 'audit-payload');
  const focusFrames = new WeakMap();

  function focusAfterAction(owner, target) {
    let pending = focusFrames.get(owner);
    if (!pending) {
      pending = { frame: undefined }; focusFrames.set(owner, pending);
      owner.keep({ destroy() { if (pending.frame !== undefined) cancelAnimationFrame(pending.frame); focusFrames.delete(owner); } });
    }
    if (pending.frame !== undefined) cancelAnimationFrame(pending.frame);
    pending.frame = requestAnimationFrame(() => {
      pending.frame = undefined;
      if (!target?.isConnected || target.closest('[hidden], [inert]')) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function action(owner, destination, label, work, className, path, kind, options = {}) {
    const button = owner.action(label, work, { className, ...options });
    owner.identify(button, 'audit-' + kind, path);
    destination.append(button.closest('.' + className));
    return button;
  }

  function renderString(owner, destination, source, path, label) {
    const text = element('span', '', source.length ? source : '""');
    destination.append(text);
    if (source.length <= STRING_BATCH) return;
    text.id = 'audit-value-' + (++nextId);
    let shown = Math.min(source.length, Math.max(STRING_BATCH, state.strings.get(path) || STRING_BATCH));
    const more = action(owner, destination, 'Show more', () => {
      shown = Math.min(source.length, shown + STRING_BATCH); state.strings.set(path, shown); update();
      if (shown === source.length) focusAfterAction(owner, less);
    }, 'audit-data-more', path, 'string-more', { title: 'Show more of ' + label });
    const less = action(owner, destination, 'Show less', () => {
      shown = STRING_BATCH; state.strings.set(path, shown); update(); focusAfterAction(owner, more);
    }, 'audit-data-more', path, 'string-less', { title: 'Show less of ' + label });
    more.setAttribute('aria-controls', text.id); less.setAttribute('aria-controls', text.id);
    function update() {
      let end = shown;
      // Never divide a surrogate pair at the preview boundary.
      if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1]) && /[\uDC00-\uDFFF]/.test(source[end])) end--;
      text.textContent = source.slice(0, end) + (end < source.length ? '…' : '');
      more.closest('.audit-data-more').hidden = shown >= source.length;
      less.closest('.audit-data-more').hidden = shown <= STRING_BATCH;
    }
    update();
  }

  function renderRow(owner, list, label, source, path, depth, ancestors) {
    const row = child(owner, 'audit-data-row', 'payload' + path);
    list.append(row.host);
    row.host.dataset.kind = source === null ? 'null' : Array.isArray(source) ? 'array' : typeof source;
    const key = element('dt', 'audit-data-key', label), output = element('dd', 'audit-data-value');
    key.tabIndex = -1; row.identify(key, 'audit-key', path);
    row.host.append(key, output);
    if (!collection(source)) {
      if (typeof source === 'string') renderString(row, output, source, path, label);
      else output.textContent = source === null ? 'null' : typeof source === 'function' ? '[Function]' : String(source);
      return key;
    }
    if (ancestors.has(source)) { output.textContent = '[Circular reference]'; return key; }
    const count = Array.isArray(source) ? source.length : Object.keys(source).length;
    if (!count) { output.textContent = Array.isArray(source) ? '[]' : '{}'; return key; }
    const summary = countLabel(source, count);
    output.textContent = summary;
    if (depth >= MAX_DEPTH) { output.textContent += ' · depth limit'; return key; }
    if (!state.initialized.has(path)) {
      state.initialized.add(path);
      if (depth <= 1 && count <= SMALL_COLLECTION) expanded.add(path);
    }
    let open = expanded.has(path);
    const children = element('dd', 'audit-data-children'); children.id = 'audit-children-' + (++nextId);
    row.host.append(children);
    const branch = child(row, 'audit-data-branch', 'payload' + path + '/children'); children.append(branch.host);
    key.replaceChildren();
    const toggle = action(row, key, label, () => {
      open = !open;
      if (open) expanded.add(path); else expanded.delete(path);
      draw();
    }, 'audit-data-toggle', path, 'disclosure', { icon: 'chevron-down', title: label + ' · ' + summary });
    toggle.setAttribute('aria-controls', children.id);
    toggle.setAttribute('aria-label', label + ', ' + summary);
    function draw() {
      row.host.dataset.expanded = String(open);
      toggle.setAttribute('aria-expanded', String(open)); toggle.title = (open ? 'Collapse ' : 'Expand ') + label;
      children.hidden = !open; branch.clear();
      if (open) renderCollection(branch, source, path, depth, new Set([...ancestors, source]));
    }
    draw();
    return toggle;
  }

  function renderCollection(owner, source, path, depth, ancestors) {
    const list = element('dl'); list.id = 'audit-list-' + (++nextId); owner.host.append(list);
    const keys = Array.isArray(source) ? null : Object.keys(source), total = keys ? keys.length : source.length;
    let shown = 0;
    function appendUntil(end) {
      let first;
      for (; shown < end; shown++) {
        const key = keys ? keys[shown] : String(shown), label = keys ? key : '[' + key + ']';
        const target = renderRow(owner, list, label, readOwn(source, key), pointer(path, key), depth + 1, ancestors);
        first ||= target;
      }
      state.counts.set(path, shown);
      return first;
    }
    appendUntil(Math.min(total, Math.max(BATCH_SIZE, state.counts.get(path) || BATCH_SIZE)));
    if (shown >= total) return;
    const more = owner.action('Load more', () => {
      const first = appendUntil(Math.min(total, shown + BATCH_SIZE)); update();
      focusAfterAction(owner, first);
    }, { className: 'audit-data-more' });
    owner.identify(more, 'audit-collection-more', path); more.setAttribute('aria-controls', list.id);
    function update() {
      const remaining = total - shown, label = 'Load ' + Math.min(BATCH_SIZE, remaining) + ' more';
      more.closest('.audit-data-more').hidden = remaining === 0;
      more.querySelector('.button-label').textContent = label;
      more.setAttribute('aria-label', label + ' ' + (keys ? 'fields' : 'items'));
      more.title = remaining + (keys ? ' fields remaining' : ' items remaining');
    }
    update();
  }

  if (collection(value) && !Array.isArray(value)) {
    if (Object.keys(value).length) renderCollection(tree, value, '', 0, new Set([value]));
    else { const list = element('dl'); tree.host.append(list); renderRow(tree, list, 'Value', value, '', 0, new Set()); }
  } else {
    const list = element('dl'); tree.host.append(list); renderRow(tree, list, Array.isArray(value) ? 'Items' : 'Value', value, '', 0, new Set());
  }
  return tree;
}

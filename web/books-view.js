// The company's books in Fava: gram's posted journals as a Beancount ledger, read-only.
// The console redraws whole panes and re-inserting an iframe reloads it, so each Fava frame
// lives in a fixed layer outside the redrawn tree and is laid over its pane's slot instead.
const frames = new Map(), statuses = new Map();
const MAX_FRAMES = 4;
let layer = null;
const REPORTS = [['Balance sheet', 'balance_sheet/'], ['Income statement', 'income_statement/'], ['Trial balance', 'trial_balance/'], ['Journal', 'journal/'], ['Query', 'query/'], ['Statistics', 'statistics/']];

function ensureLayer() {
  if (layer?.isConnected) return layer;
  layer = document.createElement('div'); layer.className = 'books-frame-layer';
  document.body.append(layer);
  addEventListener('resize', syncBooksFrames);
  document.addEventListener('scroll', syncBooksFrames, { capture: true, passive: true });
  return layer;
}

/** Lay every frame over its slot, and hide frames whose tab is not on screen. */
export function syncBooksFrames() {
  for (const entry of frames.values()) {
    const slot = entry.slot, visible = slot?.isConnected && slot.getClientRects().length;
    if (!visible) { entry.iframe.hidden = true; continue; }
    const rect = slot.getBoundingClientRect(), clip = slot.closest('.pane-scroll')?.getBoundingClientRect() || rect;
    const top = Math.max(rect.top, clip.top), bottom = Math.min(rect.bottom, clip.bottom);
    Object.assign(entry.iframe.style, { left: rect.left + 'px', top: top + 'px', width: rect.width + 'px', height: Math.max(0, bottom - top) + 'px' });
    entry.iframe.hidden = bottom - top < 1;
  }
}

function placeFrame(slot, key, src, onNavigate) {
  ensureLayer();
  let entry = frames.get(key);
  if (!entry) {
    const iframe = document.createElement('iframe');
    iframe.className = 'books-frame'; iframe.title = 'Books in Fava'; iframe.src = src;
    iframe.addEventListener('load', () => { try { const where = iframe.contentWindow.location; if (where.pathname.startsWith('/fava/')) entry.onNavigate?.(where.pathname + where.search); } catch { /* not the console's origin */ } });
    layer.append(iframe); entry = { iframe }; frames.set(key, entry);
    // Keep a few companies warm; drop the oldest frame that is off screen.
    for (const [other, old] of frames) if (frames.size > MAX_FRAMES && other !== key && old.iframe.hidden) { old.observer?.disconnect(); old.iframe.remove(); frames.delete(other); }
  }
  entry.onNavigate = onNavigate;
  if (entry.slot !== slot) { entry.observer?.disconnect(); entry.slot = slot; entry.observer = new ResizeObserver(syncBooksFrames); entry.observer.observe(slot); }
  return entry;
}

function navigate(key, url) { const entry = frames.get(key); if (entry) entry.iframe.src = url; }

async function loadStatus(ctx, world, revision) {
  const current = statuses.get(world);
  if (current?.loading || (current?.data && current.revision === revision)) return;
  statuses.set(world, { ...current, loading: true });
  let data;
  try { data = await ctx.api(ctx.path('/books')); statuses.set(world, { revision, data }); }
  catch (error) { statuses.set(world, { revision, error: error.message }); }
  // Fava starts with gram and restarts after a crash; ask again until it answers.
  if (data?.fava && !data.fava.url && ['starting', 'restarting', 'running'].includes(data.fava.state)) setTimeout(() => { if (statuses.get(world)?.data === data) { statuses.delete(world); void loadStatus(ctx, world, revision); } }, 2000);
  ctx.rerender();
}

export function renderBooks(content, ctx) {
  const world = ctx.worldId(), revision = ctx.world().revision, key = world + ':' + ctx.tabId();
  content.host.classList.add('books-content');
  const status = statuses.get(world);
  if (!status?.data || status.revision !== revision) void loadStatus(ctx, world, revision);
  const data = status?.data, fava = data?.fava;
  const head = ctx.child(content, 'books-head');
  const summary = data?.available
    ? 'The company\'s accounting records: ' + data.journals + ' entries across ' + data.accounts + ' accounts, through ' + data.through + '. gram writes every entry; this page is a read-only view (a Beancount ledger).'
    : status?.error || data?.reason || 'Exporting the books…';
  const check = fava?.errors === 0 ? 'Automatic check: 0 errors. Every account adds up — the books balance.'
    : fava?.errors > 0 ? 'Automatic check: ' + fava.errors + ' error' + (fava.errors === 1 ? '' : 's') + '. ' + fava.error_messages.join(' · ')
    : fava?.reason || (fava ? 'Fava is ' + fava.state + '…' : '');
  head.text('Books', summary + (check ? '\n' + check : '')).host.classList.add('prose', 'books-summary');
  const actions = ctx.child(head, 'compact-actions books-actions');
  const base = fava?.url;
  for (const [label, page] of REPORTS) actions.action(label, () => navigate(key, base + page), { disabled: !base });
  if (fava?.errors > 0) actions.action('Errors', () => navigate(key, base + 'errors/'), { disabled: !base });
  actions.action('Open in a new tab', () => { const entry = frames.get(key); open(entry?.iframe.contentWindow?.location.href || base, '_blank', 'noopener'); }, { icon: 'external', className: 'icon-button', disabled: !base });
  actions.action('Download .beancount', () => ctx.download(ctx.path('/books.beancount'), data.file), { icon: 'download', className: 'icon-button', disabled: !data?.available });
  actions.action('Recheck', async () => { statuses.delete(world); await loadStatus(ctx, world, revision); }, { icon: 'refresh', className: 'icon-button' });
  const slot = content.slot('books-slot');
  if (!base) {
    slot.classList.add('books-empty');
    slot.textContent = fava?.state === 'unavailable' ? 'Fava is not running. ' + (fava.reason || '') + ' The .beancount file still downloads above, and any Beancount tool reads it.' : 'Starting Fava…';
    return;
  }
  // Reopen where the controller last was, as long as it is still this company's ledger.
  const saved = ctx.savedPath(), start = saved && saved.startsWith(base) ? saved : base;
  placeFrame(slot, key, start, path => ctx.savePath(path));
}

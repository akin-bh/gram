// Actual Libraries.dev thinking-orbs geometry, tuned presets, and canvas painter.
// thinking-orbs 0.3.2, MIT © 2026 Jakub Antalik; the /engine export has no React runtime.
import { resolvePreset, MODE_FRAMES, paintFrame } from 'thinking-orbs/engine';

const STATES = new Set(['working', 'searching', 'solving', 'listening', 'connecting', 'composing', 'breathing']);
const defaults = { state: 'working', size: 64, dark: false, paused: false };
function optionsFrom(value, previous = defaults) {
  const options = { ...previous };
  if (!value || typeof value !== 'object') return options;
  if (STATES.has(value.state)) options.state = value.state;
  if (value.size === 20 || value.size === 64) options.size = value.size;
  for (const key of ['dark', 'paused']) if (typeof value[key] === 'boolean') options[key] = value[key];
  return options;
}
function onMedia(query, listener) {
  if (!query) return () => {};
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }
  query.addListener?.(listener);
  return () => query.removeListener?.(listener);
}

/**
 * Append a decorative canvas; the containing status supplies its accessible text.
 * Updates are partial. Only callers select activity states; there is no automatic cycling.
 */
export function mountAgentOrb(host, initial = {}) {
  const document = host?.ownerDocument, view = document?.defaultView;
  if (!document || !view || typeof host.append !== 'function') throw new TypeError('mountAgentOrb requires a DOM host.');
  const canvas = document.createElement('canvas');
  canvas.className = 'agent-orb';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.tabIndex = -1;
  Object.assign(canvas.style, { display: 'block', flexShrink: '0', pointerEvents: 'none' });
  host.append(canvas);
  let context;
  try { context = canvas.getContext('2d', { alpha: true }); } catch { context = null; }
  let options = optionsFrom(initial);
  let preset = resolvePreset(options.state, options.size);
  const motion = typeof view.matchMedia === 'function' ? view.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = Boolean(motion?.matches), destroyed = false, frameId = null, dirty = true;
  let intersection = null, resize = null, visible = typeof view.IntersectionObserver !== 'function';
  let pixelRatio = 0, watchedRatio = 0;
  let stopMotion = () => {}, stopResolution = () => {};
  const now = () => view.performance.now() / 1000;
  // The window's monotonic clock is shared by every mount, including after UI rerenders.
  let frameTime = reduced || options.paused ? 0.6 : now() * preset.speed;
  const pageVisible = () => document.visibilityState !== 'hidden' && document.hidden !== true;
  const ratio = () => Number.isFinite(view.devicePixelRatio) && view.devicePixelRatio > 0 ? view.devicePixelRatio : 1;
  const connected = () => canvas.isConnected;
  const canAnimate = () => !destroyed && context && connected() && visible && pageVisible() && !reduced && !options.paused && typeof view.requestAnimationFrame === 'function';

  function sizeCanvas() {
    // Match the upstream component's DPR cap; its 20/64 designs remain CSS-sized.
    const nextRatio = Math.min(2, ratio()), pixels = Math.max(1, Math.round(options.size * nextRatio));
    canvas.style.width = options.size + 'px'; canvas.style.height = options.size + 'px';
    canvas.dataset.state = options.state;
    if (pixelRatio !== nextRatio || canvas.width !== pixels || canvas.height !== pixels) {
      pixelRatio = nextRatio; canvas.width = pixels; canvas.height = pixels; dirty = true;
    }
  }
  function draw(time = frameTime) {
    if (!context || destroyed) return;
    sizeCanvas();
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, options.size, options.size);
    paintFrame(context, MODE_FRAMES[preset.mode](options.size, time, preset.opts), options.dark);
    frameTime = time; dirty = false;
  }
  function stop() {
    if (frameId !== null) view.cancelAnimationFrame?.(frameId);
    frameId = null;
  }
  function schedule() { if (canAnimate() && frameId === null) frameId = view.requestAnimationFrame(tick); }
  function tick() {
    frameId = null;
    if (!canAnimate()) return;
    draw(now() * preset.speed);
    schedule();
  }
  function sync() {
    if (destroyed) return;
    sizeCanvas();
    if (!canAnimate()) stop();
    if (dirty && context && connected() && visible && pageVisible()) draw(reduced ? 0.6 : options.paused ? frameTime : now() * preset.speed);
    schedule();
  }
  function withinViewport() {
    const rect = canvas.getBoundingClientRect();
    return connected() && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
  }
  function watchResolution() {
    stopResolution(); watchedRatio = ratio();
    if (typeof view.matchMedia !== 'function') return;
    stopResolution = onMedia(view.matchMedia(`(resolution: ${watchedRatio}dppx)`), () => { watchResolution(); layoutChanged(); });
  }
  function layoutChanged() {
    if (destroyed) return;
    if (!intersection) visible = withinViewport();
    if (watchedRatio !== ratio()) watchResolution();
    sync();
  }
  function visibilityChanged() { layoutChanged(); }

  sizeCanvas();
  // A first frame is ready before the asynchronous intersection callback. Hidden tabs defer it.
  if (context && pageVisible()) draw(frameTime);
  if (context) {
    stopMotion = onMedia(motion, event => { reduced = Boolean(event.matches); dirty = true; sync(); });
    watchResolution();
    if (typeof view.IntersectionObserver === 'function') {
      intersection = new view.IntersectionObserver(entries => {
        if (destroyed) return;
        const entry = entries.find(entry => entry.target === canvas);
        if (!entry) return;
        visible = entry.isIntersecting;
        sync();
      });
      intersection.observe(canvas);
    } else {
      visible = withinViewport();
      view.addEventListener('scroll', layoutChanged, { capture: true, passive: true });
    }
    if (typeof view.ResizeObserver === 'function') {
      resize = new view.ResizeObserver(layoutChanged); resize.observe(canvas);
    }
    document.addEventListener('visibilitychange', visibilityChanged);
    view.addEventListener('resize', layoutChanged, { passive: true });
    sync();
  }

  return {
    update(next) {
      if (destroyed) return;
      const previous = options;
      options = optionsFrom(next, previous);
      if (Object.keys(defaults).every(key => options[key] === previous[key])) return;
      if (options.state !== previous.state || options.size !== previous.size) {
        preset = resolvePreset(options.state, options.size);
        frameTime = reduced || options.paused ? 0.6 : now() * preset.speed;
      }
      dirty = true; sync();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; stop();
      intersection?.disconnect(); resize?.disconnect(); stopMotion(); stopResolution();
      document.removeEventListener('visibilitychange', visibilityChanged);
      view.removeEventListener('resize', layoutChanged);
      view.removeEventListener('scroll', layoutChanged, true);
      canvas.remove();
    },
  };
}

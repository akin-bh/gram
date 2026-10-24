import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolvePreset, MODE_FRAMES } from 'thinking-orbs/engine';
// @ts-ignore TS7016: Native browser JavaScript module.
import { mountAgentOrb } from '../web/agent-orb.js';

// Unit doubles for the canvas protocol and lifecycle signals; no browser is launched or driven.
class Signals {
  listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(name: string, listener: (event: any) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
  emit(name: string, event: any = {}) { for (const listener of [...(this.listeners.get(name) || [])]) listener(event); }
  get listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}
class Media extends Signals { constructor(public matches = false) { super(); } set(matches: boolean) { this.matches = matches; this.emit('change', { matches }); } }
class CanvasContext {
  transforms: number[][] = [];
  frames: number[][][] = [];
  fillStyle = ''; strokeStyle = ''; lineWidth = 0;
  setTransform(...values: number[]) { this.transforms.push(values); }
  clearRect() { this.frames.push([]); }
  beginPath() {} fill() {} moveTo() {} lineTo() {} stroke() {}
  arc(x: number, y: number, radius: number) { this.frames.at(-1)!.push([x, y, radius]); }
}
function environment({ reduced = false, hidden = false, observer = true, context = true } = {}) {
  const window = new Signals() as Signals & Record<string, any>;
  const document = new Signals() as Signals & Record<string, any>;
  const media: { query: string; signal: Media }[] = [], canvases: any[] = [], observers: any[] = [], resizeObservers: any[] = [];
  const raf = new Map<number, () => void>();
  let nextId = 0, time = 2500;
  window.devicePixelRatio = 2; window.innerWidth = 1000; window.innerHeight = 800;
  window.performance = { now: () => time };
  window.requestAnimationFrame = (callback: () => void) => { const id = ++nextId; raf.set(id, callback); return id; };
  window.cancelAnimationFrame = (id: number) => raf.delete(id);
  window.matchMedia = (query: string) => { const signal = new Media(query.includes('reduced-motion') ? reduced : true); media.push({ query, signal }); return signal; };
  if (observer) window.IntersectionObserver = class {
    disconnected = false; target: any;
    constructor(public callback: (entries: any[]) => void) { observers.push(this); }
    observe(target: any) { this.target = target; }
    set(isIntersecting: boolean) { this.callback([{ target: this.target, isIntersecting }]); }
    disconnect() { this.disconnected = true; }
  };
  window.ResizeObserver = class {
    disconnected = false;
    constructor(public callback: () => void) { resizeObservers.push(this); }
    observe() {} disconnect() { this.disconnected = true; }
  };
  document.defaultView = window; document.visibilityState = hidden ? 'hidden' : 'visible';
  const host = { ownerDocument: document, children: [] as any[], append(canvas: any) { this.children.push(canvas); canvas.isConnected = true; } };
  document.createElement = () => {
    const ctx = new CanvasContext();
    const canvas: any = { context: ctx, style: {}, dataset: {}, attrs: {}, width: 0, height: 0, isConnected: false,
      rect: { top: 10, left: 10, bottom: 74, right: 74, width: 64, height: 64 },
      setAttribute(name: string, value: string) { this.attrs[name] = value; },
      getContext: () => context ? ctx : null,
      getBoundingClientRect() { return this.rect; },
      remove() { this.isConnected = false; host.children.splice(host.children.indexOf(this), 1); },
    };
    canvases.push(canvas); return canvas;
  };
  return { host, window, document, canvases, media, observers, resizeObservers, raf,
    tick(nextTime: number) { time = nextTime; const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(callback => callback()); },
    clock(nextTime: number) { time = nextTime; },
  };
}

test('adapter paints actual tuned engine geometry at both sizes and stays in phase across remounts', () => {
  const env = environment();
  const first = mountAgentOrb(env.host, { state: 'searching', size: 20, dark: false });
  const canvas = env.canvases[0], preset = resolvePreset('searching', 20);
  const expected = MODE_FRAMES[preset.mode](20, 2.5 * preset.speed, preset.opts).dots.map(dot => [dot.x, dot.y, dot.r]);
  assert.deepEqual(canvas.context.frames[0], expected);
  assert.equal(canvas.width, 40);
  assert.equal(canvas.style.width, '20px');
  assert.equal(env.raf.size, 0, 'wait for actual visibility before animating');
  env.observers[0].set(true); env.tick(4000);
  const last = canvas.context.frames.at(-1);
  first.destroy();
  const second = mountAgentOrb(env.host, { state: 'searching', size: 20 });
  assert.deepEqual(env.canvases[1].context.frames[0], last, 'remount uses the shared monotonic phase');
  second.update({ state: 'composing', size: 64, dark: true }); env.observers[1].set(true);
  assert.equal(env.canvases[1].width, 128);
  assert.equal(env.canvases[1].dataset.state, 'composing');
  second.destroy();
});

test('offscreen, page visibility, explicit pause, and live reduced motion each stop animation', () => {
  const env = environment();
  const control = mountAgentOrb(env.host, { state: 'working', size: 20 });
  env.observers[0].set(true); assert.equal(env.raf.size, 1);
  env.observers[0].set(false); assert.equal(env.raf.size, 0);
  env.observers[0].set(true); assert.equal(env.raf.size, 1);
  env.document.visibilityState = 'hidden'; env.document.emit('visibilitychange'); assert.equal(env.raf.size, 0);
  const frames = env.canvases[0].context.frames.length;
  control.update({ dark: true }); assert.equal(env.canvases[0].context.frames.length, frames, 'hidden updates defer drawing');
  env.document.visibilityState = 'visible'; env.document.emit('visibilitychange'); assert.equal(env.raf.size, 1);
  control.update({ paused: true }); assert.equal(env.raf.size, 0);
  const frozen = env.canvases[0].context.frames.at(-1);
  env.clock(12000); control.update({ dark: false }); assert.deepEqual(env.canvases[0].context.frames.at(-1), frozen);
  control.update({ paused: false }); assert.equal(env.raf.size, 1);
  env.media[0]!.signal.set(true); assert.equal(env.raf.size, 0);
  const preset = resolvePreset('working', 20);
  assert.deepEqual(env.canvases[0].context.frames.at(-1), MODE_FRAMES[preset.mode](20, 0.6, preset.opts).dots.map(dot => [dot.x, dot.y, dot.r]));
  env.media[0]!.signal.set(false); assert.equal(env.raf.size, 1);
  control.destroy();
});

test('DPR changes redraw paused orbs and destroy removes every owned listener, observer, frame, and canvas', () => {
  const env = environment();
  const other = { label: 'Keep parent content' }; env.host.children.push(other);
  const control = mountAgentOrb(env.host, { state: 'breathing', size: 64, paused: true });
  env.observers[0].set(true);
  env.window.devicePixelRatio = 1.5; env.window.emit('resize');
  assert.equal(env.canvases[0].width, 96);
  assert.deepEqual(env.canvases[0].context.transforms.at(-1), [1.5, 0, 0, 1.5, 0, 0]);
  env.window.devicePixelRatio = 3; env.media.at(-1)!.signal.set(false);
  assert.equal(env.canvases[0].width, 128, 'upstream DPR cap is respected');
  control.update({ paused: false }); assert.equal(env.raf.size, 1);
  control.destroy(); control.destroy(); control.update({ state: 'solving' });
  assert.equal(env.raf.size, 0);
  assert.equal(env.window.listenerCount, 0);
  assert.equal(env.document.listenerCount, 0);
  assert.ok(env.media.every(entry => entry.signal.listenerCount === 0));
  assert.ok(env.observers.every(observer => observer.disconnected));
  assert.ok(env.resizeObservers.every(observer => observer.disconnected));
  assert.deepEqual(env.host.children, [other]);
});

test('static reduced-motion mounts, no-canvas environments, and the no-IntersectionObserver fallback do not leak work', () => {
  const reduced = environment({ reduced: true });
  const still = mountAgentOrb(reduced.host, { state: 'listening', size: 20 });
  reduced.observers[0].set(true); assert.equal(reduced.raf.size, 0);
  still.update({ state: 'solving' }); assert.equal(reduced.canvases[0].dataset.state, 'solving');
  still.update({ state: 'not-a-real-state', size: 999 }); assert.equal(reduced.canvases[0].dataset.state, 'solving');
  still.destroy();
  const unavailable = environment({ context: false });
  const empty = mountAgentOrb(unavailable.host); assert.equal(unavailable.raf.size, 0); empty.destroy();
  assert.equal(unavailable.window.listenerCount + unavailable.document.listenerCount, 0);
  const fallback = environment({ observer: false });
  const control = mountAgentOrb(fallback.host, { state: 'connecting', size: 20 }); assert.equal(fallback.raf.size, 1);
  fallback.canvases[0].rect.top = 900; fallback.canvases[0].rect.bottom = 920; fallback.window.emit('scroll');
  assert.equal(fallback.raf.size, 0);
  control.destroy(); assert.equal(fallback.window.listenerCount, 0);
});

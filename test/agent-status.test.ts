import { test, expect } from 'bun:test';
// @ts-ignore TS7016: Native browser JavaScript module.
import { describeAgentStatus, formatAgentElapsed, mountAgentStatus } from '../web/agent-status.js';

const started_at = '2026-10-24T10:00:00.000Z';
const running = (progress: Record<string, unknown> = {}) => ({ status: 'running', started_at, progress });

test('recorded run activity selects real phases and action labels without inferring business outcomes', () => {
  expect(describeAgentStatus(running({ type: 'agent.started' }))).toStrictEqual({ label: 'Starting', state: 'connecting', tone: 'neutral', running: true });
  expect(describeAgentStatus(running({ type: 'agent.tool.request', method: 'GET', path: '/api/worlds/one/records' }))).toStrictEqual({ label: 'Reading records', state: 'searching', tone: 'neutral', running: true });
  for (const [action_type, label] of [['match_supplier_invoice', 'Matching invoice'], ['pay_bill', 'Requesting payment'], ['create_purchase_order', 'Creating purchase order'], ['execute_payroll', 'Requesting payroll payment']]) {
    expect(describeAgentStatus(running({ type: 'agent.tool.request', method: 'POST', path: '/api/worlds/one/actions', action_type }))).toStrictEqual({ label, state: 'working', tone: 'neutral', running: true });
  }
  expect(describeAgentStatus(running({ type: 'agent.message' })).state).toBe('composing');
  for (const progress of [
    {}, { type: 'agent.tool.response', method: 'POST', status: 200 },
    { type: 'agent.tool.request', method: 'POST', path: '/other', action_type: 'pay_bill' },
    { type: 'agent.tool.request', method: 'POST', path: '/api/worlds/one/actions', action_type: 'constructor' },
    { type: 'unknown', action_type: 'pay_bill', status: 'failed' },
  ]) expect(describeAgentStatus({ ...running(progress), pending_approvals: [{ status: 'pending' }] })).toStrictEqual({ label: 'Working', state: 'working', tone: 'neutral', running: true });
});

test('failed calls remain active and terminal lifecycle overrides stale progress', () => {
  for (const progress of [{ type: 'agent.tool.response', status: 500 }, { type: 'agent.tool.failure' }, { type: 'agent.failed' }]) {
    expect(describeAgentStatus(running(progress))).toStrictEqual({ label: 'Call failed', state: 'working', tone: 'attention', running: true });
  }
  for (const progress of [{ type: 'agent.capability.denied' }, { type: 'agent.tool.response', status: 401 }, { type: 'agent.tool.response', status: 403 }]) {
    expect(describeAgentStatus(running(progress))).toStrictEqual({ label: 'Access blocked', state: 'working', tone: 'attention', running: true });
  }
  for (const [status, label, tone] of [['completed', 'Completed', 'success'], ['failed', 'Failed', 'error'], ['cancelled', 'Stopped', 'neutral'], ['interrupted', 'Interrupted', 'attention']]) {
    expect(describeAgentStatus({ ...running({ type: 'agent.tool.request', method: 'GET' }), status })).toStrictEqual({ label, state: 'breathing', tone, running: false });
  }
  expect(describeAgentStatus(null).label).toBe('Idle');
  expect(describeAgentStatus({ status: 'constructor' }).running).toBe(false);
});

test('elapsed uses run timestamps, freezes at completion, and tolerates missing or invalid clocks', () => {
  const now = Date.parse(started_at) + 3_723_999;
  expect(formatAgentElapsed(running(), now)).toBe('1:02:03');
  const completed = { ...running(), status: 'completed', finished_at: '2026-10-24T10:01:23.900Z' };
  expect(formatAgentElapsed(completed, now)).toBe('1:23');
  expect(formatAgentElapsed(completed, now + 900_000)).toBe('1:23');
  expect(formatAgentElapsed(running(), Date.parse(started_at) - 500)).toBe('0:00');
  expect(formatAgentElapsed({ ...completed, finished_at: null }, now)).toBe('');
  expect(formatAgentElapsed({ ...running(), started_at: '0' }, now)).toBe('');
  expect(formatAgentElapsed({ ...running(), started_at: 'invalid' }, now)).toBe('');
  expect(formatAgentElapsed(running(), NaN)).toBe('');
  expect(formatAgentElapsed(null, now)).toBe('');
});

// DOM/canvas protocol doubles exercise component ownership and timers without browser automation.
class Signals {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(name: string, listener: () => void) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(listener); }
  removeEventListener(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener); }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}
function environment() {
  const window = new Signals() as Signals & Record<string, any>;
  const document = new Signals() as Signals & Record<string, any>;
  let time = Date.parse(started_at) + 7000, nextId = 0;
  const intervals = new Map<number, () => void>(), raf = new Map<number, () => void>();
  window.Date = { now: () => time }; window.performance = { now: () => 2500 };
  window.devicePixelRatio = 1; window.innerWidth = 800; window.innerHeight = 600;
  window.setInterval = (callback: () => void, delay: number) => { expect(delay).toBe(1000); const id = ++nextId; intervals.set(id, callback); return id; };
  window.clearInterval = (id: number) => intervals.delete(id);
  window.requestAnimationFrame = (callback: () => void) => { const id = ++nextId; raf.set(id, callback); return id; };
  window.cancelAnimationFrame = (id: number) => raf.delete(id);
  document.defaultView = window; document.visibilityState = 'visible';
  class Node {
    ownerDocument = document; attrs: Record<string, string> = {}; dataset = {}; style = {}; className = ''; hidden = false;
    children: Node[] = []; parent: Node | null = null; value = ''; writes = 0;
    constructor(public tagName: string) {}
    get isConnected(): boolean { return this === host || Boolean(this.parent?.isConnected); }
    get textContent() { return this.value; }
    set textContent(value: string) { this.value = value; this.writes++; }
    append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    getAttribute(name: string) { return this.attrs[name] ?? null; }
    removeAttribute(name: string) { delete this.attrs[name]; }
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 64, right: 64, width: 64, height: 64 }; }
    getContext() { return { setTransform() {}, clearRect() {}, beginPath() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {} }; }
  }
  document.createElement = (tag: string) => new Node(tag);
  const host = new Node('div');
  return { host, document, window, intervals, raf,
    tick(nextTime: number) { time = nextTime; for (const callback of [...intervals.values()]) callback(); },
  };
}

test('status updates retain one timer, announce only changed labels, pause terminal orbs, and clean up owned nodes', () => {
  const env = environment(), other = env.document.createElement('button'); env.host.append(other);
  env.host.setAttribute('data-tone', 'original');
  const control = mountAgentStatus(env.host, running({ type: 'agent.started' }), { dark: true, size: 64 });
  const orbHost = env.host.children[1]!, copy = env.host.children[2]!, label = copy.children[0]!, elapsed = copy.children[1]!;
  const canvas = orbHost.children[0]!;
  expect(orbHost.className).toBe('agent-status-orb'); expect(copy.className).toBe('agent-status-copy');
  expect(label.className).toBe('agent-status-label'); expect(elapsed.className).toBe('agent-status-elapsed');
  expect(label.attrs['aria-live']).toBe('polite'); expect(copy.attrs['aria-live']).toBeUndefined(); expect(elapsed.attrs['aria-live']).toBeUndefined();
  expect(label.textContent).toBe('Starting'); expect(elapsed.textContent).toBe('0:07');
  expect((canvas.style as any).width).toBe('64px'); expect((canvas.dataset as any).state).toBe('connecting');
  expect(env.intervals.size).toBe(1); expect(env.raf.size).toBe(1);
  const writes = label.writes;
  env.tick(Date.parse(started_at) + 8000);
  control.update(running({ type: 'agent.started' }), { dark: false });
  expect(elapsed.textContent).toBe('0:08'); expect(label.writes).toBe(writes); expect(env.intervals.size).toBe(1);
  control.update(running({ type: 'agent.tool.failure' }));
  expect(label.textContent).toBe('Call failed'); expect(env.host.attrs['data-tone']).toBe('attention');
  expect(env.host.attrs['data-running']).toBe('true'); expect(env.intervals.size).toBe(1); expect(env.raf.size).toBe(1);
  control.update({ ...running(), status: 'completed', finished_at: '2026-10-24T10:00:09.000Z' });
  expect(label.textContent).toBe('Completed'); expect(elapsed.textContent).toBe('0:09');
  expect(env.host.attrs['data-running']).toBe('false'); expect(env.host.attrs['data-tone']).toBe('success');
  expect(env.intervals.size).toBe(0); expect(env.raf.size).toBe(0); expect((canvas.style as any).width).toBe('20px');
  env.tick(Date.parse(started_at) + 50_000); expect(elapsed.textContent).toBe('0:09');
  control.update({ ...running(), started_at: 'invalid' }); expect(elapsed.hidden).toBe(true); expect(env.intervals.size).toBe(0);
  control.update(running()); expect(env.intervals.size).toBe(1);
  control.destroy(); control.destroy(); control.update(running());
  expect(env.intervals.size).toBe(0); expect(env.raf.size).toBe(0);
  expect(env.document.listenerCount + env.window.listenerCount).toBe(0);
  expect(env.host.children).toStrictEqual([other]); expect(env.host.attrs['data-tone']).toBe('original');
  expect(env.host.attrs['data-running']).toBeUndefined();
});

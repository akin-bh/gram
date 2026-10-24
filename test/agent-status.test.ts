import { test } from 'bun:test';
import assert from 'node:assert/strict';
// @ts-ignore TS7016: Native browser JavaScript module.
import { describeAgentStatus, formatAgentElapsed, mountAgentStatus } from '../web/agent-status.js';

const started_at = '2026-10-24T10:00:00.000Z';
const running = (progress: Record<string, unknown> = {}) => ({ status: 'running', started_at, progress });

test('recorded run activity selects real phases and action labels without inferring business outcomes', () => {
  assert.deepEqual(describeAgentStatus(running({ type: 'agent.started' })), { label: 'Starting', state: 'connecting', tone: 'neutral', running: true });
  assert.deepEqual(describeAgentStatus(running({ type: 'agent.tool.request', method: 'GET', path: '/api/worlds/one/records' })), { label: 'Reading records', state: 'searching', tone: 'neutral', running: true });
  for (const [action_type, label] of [['match_supplier_invoice', 'Matching invoice'], ['pay_bill', 'Requesting payment'], ['create_purchase_order', 'Creating purchase order'], ['execute_payroll', 'Requesting payroll payment']]) {
    assert.deepEqual(describeAgentStatus(running({ type: 'agent.tool.request', method: 'POST', path: '/api/worlds/one/actions', action_type })), { label, state: 'working', tone: 'neutral', running: true });
  }
  assert.equal(describeAgentStatus(running({ type: 'agent.message' })).state, 'composing');
  for (const progress of [
    {}, { type: 'agent.tool.response', method: 'POST', status: 200 },
    { type: 'agent.tool.request', method: 'POST', path: '/other', action_type: 'pay_bill' },
    { type: 'agent.tool.request', method: 'POST', path: '/api/worlds/one/actions', action_type: 'constructor' },
    { type: 'unknown', action_type: 'pay_bill', status: 'failed' },
  ]) assert.deepEqual(describeAgentStatus({ ...running(progress), pending_approvals: [{ status: 'pending' }] }), { label: 'Working', state: 'working', tone: 'neutral', running: true });
});

test('failed calls remain active and terminal lifecycle overrides stale progress', () => {
  for (const progress of [{ type: 'agent.tool.response', status: 500 }, { type: 'agent.tool.failure' }, { type: 'agent.failed' }]) {
    assert.deepEqual(describeAgentStatus(running(progress)), { label: 'Call failed', state: 'working', tone: 'attention', running: true });
  }
  for (const progress of [{ type: 'agent.capability.denied' }, { type: 'agent.tool.response', status: 401 }, { type: 'agent.tool.response', status: 403 }]) {
    assert.deepEqual(describeAgentStatus(running(progress)), { label: 'Access blocked', state: 'working', tone: 'attention', running: true });
  }
  for (const [status, label, tone] of [['completed', 'Completed', 'success'], ['failed', 'Failed', 'error'], ['cancelled', 'Stopped', 'neutral'], ['interrupted', 'Interrupted', 'attention']]) {
    assert.deepEqual(describeAgentStatus({ ...running({ type: 'agent.tool.request', method: 'GET' }), status }), { label, state: 'breathing', tone, running: false });
  }
  assert.equal(describeAgentStatus(null).label, 'Idle');
  assert.equal(describeAgentStatus({ status: 'constructor' }).running, false);
});

test('elapsed uses run timestamps, freezes at completion, and tolerates missing or invalid clocks', () => {
  const now = Date.parse(started_at) + 3_723_999;
  assert.equal(formatAgentElapsed(running(), now), '1:02:03');
  const completed = { ...running(), status: 'completed', finished_at: '2026-10-24T10:01:23.900Z' };
  assert.equal(formatAgentElapsed(completed, now), '1:23');
  assert.equal(formatAgentElapsed(completed, now + 900_000), '1:23');
  assert.equal(formatAgentElapsed(running(), Date.parse(started_at) - 500), '0:00');
  assert.equal(formatAgentElapsed({ ...completed, finished_at: null }, now), '');
  assert.equal(formatAgentElapsed({ ...running(), started_at: '0' }, now), '');
  assert.equal(formatAgentElapsed({ ...running(), started_at: 'invalid' }, now), '');
  assert.equal(formatAgentElapsed(running(), NaN), '');
  assert.equal(formatAgentElapsed(null, now), '');
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
  window.setInterval = (callback: () => void, delay: number) => { assert.equal(delay, 1000); const id = ++nextId; intervals.set(id, callback); return id; };
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
  assert.equal(orbHost.className, 'agent-status-orb'); assert.equal(copy.className, 'agent-status-copy');
  assert.equal(label.className, 'agent-status-label'); assert.equal(elapsed.className, 'agent-status-elapsed');
  assert.equal(label.attrs['aria-live'], 'polite'); assert.equal(copy.attrs['aria-live'], undefined); assert.equal(elapsed.attrs['aria-live'], undefined);
  assert.equal(label.textContent, 'Starting'); assert.equal(elapsed.textContent, '0:07');
  assert.equal((canvas.style as any).width, '64px'); assert.equal((canvas.dataset as any).state, 'connecting');
  assert.equal(env.intervals.size, 1); assert.equal(env.raf.size, 1);
  const writes = label.writes;
  env.tick(Date.parse(started_at) + 8000);
  control.update(running({ type: 'agent.started' }), { dark: false });
  assert.equal(elapsed.textContent, '0:08'); assert.equal(label.writes, writes); assert.equal(env.intervals.size, 1);
  control.update(running({ type: 'agent.tool.failure' }));
  assert.equal(label.textContent, 'Call failed'); assert.equal(env.host.attrs['data-tone'], 'attention');
  assert.equal(env.host.attrs['data-running'], 'true'); assert.equal(env.intervals.size, 1); assert.equal(env.raf.size, 1);
  control.update({ ...running(), status: 'completed', finished_at: '2026-10-24T10:00:09.000Z' });
  assert.equal(label.textContent, 'Completed'); assert.equal(elapsed.textContent, '0:09');
  assert.equal(env.host.attrs['data-running'], 'false'); assert.equal(env.host.attrs['data-tone'], 'success');
  assert.equal(env.intervals.size, 0); assert.equal(env.raf.size, 0); assert.equal((canvas.style as any).width, '20px');
  env.tick(Date.parse(started_at) + 50_000); assert.equal(elapsed.textContent, '0:09');
  control.update({ ...running(), started_at: 'invalid' }); assert.equal(elapsed.hidden, true); assert.equal(env.intervals.size, 0);
  control.update(running()); assert.equal(env.intervals.size, 1);
  control.destroy(); control.destroy(); control.update(running());
  assert.equal(env.intervals.size, 0); assert.equal(env.raf.size, 0);
  assert.equal(env.document.listenerCount + env.window.listenerCount, 0);
  assert.deepEqual(env.host.children, [other]); assert.equal(env.host.attrs['data-tone'], 'original');
  assert.equal(env.host.attrs['data-running'], undefined);
});

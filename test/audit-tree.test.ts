import { test, expect } from 'bun:test';
// @ts-ignore TS7016: The browser imports this pure JavaScript module directly.
import { describeAuditEvent, buildAuditTree } from '../web/audit-tree.js';

type AuditRow = { seq: number; type: string; actor: string; at: string; request_id?: string; data: Record<string, any> };
type Node = { id: string; kind: 'run' | 'request' | 'delivery' | 'event'; title: string; summary: string; actor: string; tone: string; icon: string; at: string; seq: number; minSeq: number; maxSeq: number; count: number; children: Node[]; event?: AuditRow };
const row = (seq: number, type: string, data: Record<string, any> = {}, extra: Partial<AuditRow> = {}): AuditRow => ({ seq, type, actor: 'system', at: `2026-10-24T10:00:${String(seq).padStart(2, '0')}.000Z`, data, ...extra });
const flatten = (nodes: Node[]): Node[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
const leaves = (nodes: Node[]) => flatten(nodes).filter(node => node.kind === 'event');
function consistent(nodes: Node[], seqs: number[]) {
  expect(leaves(nodes).map(node => node.seq).sort((a, b) => a - b)).toStrictEqual([...new Set(seqs)].sort((a, b) => a - b));
  expect(new Set(flatten(nodes).map(node => node.id)).size).toBe(flatten(nodes).length);
  for (const node of flatten(nodes)) {
    if (node.kind === 'event') { expect(node.count).toBe(1); expect(node.children.length).toBe(0); continue; }
    expect(node.event).toBeUndefined();
    expect(node.count).toBe(leaves(node.children).length);
    expect(node.minSeq).toBe(Math.min(...leaves(node.children).map(leaf => leaf.seq)));
    expect(node.maxSeq).toBe(Math.max(...leaves(node.children).map(leaf => leaf.seq)));
    expect(node.children.map(child => child.minSeq)).toStrictEqual(node.children.map(child => child.minSeq).sort((a, b) => a - b));
  }
}

test('interleaved requests and runs group through explicit links, including later request run evidence', () => {
  const events = [
    row(1, 'agent.started', { run_id: 'run-a', instruction: 'Match supplier invoices' }, { request_id: 'start-a', actor: 'controller-local' }),
    row(2, 'http.request', { method: 'POST', path: '/api/worlds/north/agent', status: 202 }, { request_id: 'start-a', actor: 'controller-local' }),
    row(3, 'supplier_invoice.matched', { supplier_invoice_id: 'sinv-1' }, { request_id: 'match-a', actor: 'agent-world:north' }),
    row(4, 'agent.trace', { type: 'agent.tool.request', path: '/api/worlds/south/records' }, { actor: 'agent:run-b' }),
    row(5, 'http.request', { run_id: 'run-b', method: 'GET', path: '/api/worlds/south/records', status: 200 }, { request_id: 'read-b', actor: 'agent-world:south' }),
    row(6, 'action.completed', { run_id: 'run-a', action: { type: 'match_supplier_invoice' }, result: { status: 'matched' } }, { request_id: 'match-a', actor: 'agent-world:north' }),
    row(7, 'http.request', { run_id: 'run-a', method: 'POST', path: '/api/worlds/north/actions', status: 200 }, { request_id: 'match-a', actor: 'agent-world:north' }),
    row(8, 'agent.completed', { run_id: 'run-a' }, { actor: 'agent:run-a' }),
    row(9, 'agent.completed', {}, { actor: 'agent:run-b' }),
  ];
  const before = JSON.stringify(events);
  const tree: Node[] = buildAuditTree([...events].reverse(), { runs: [{ id: 'run-a', instruction: 'Reconcile\n supplier invoices', status: 'completed' }] });
  expect(tree.map(node => node.id)).toStrictEqual(['run:run-b', 'run:run-a']);
  expect(tree[1]!.title).toBe('Reconcile supplier invoices');
  expect(tree[1]!.children.map(node => node.id)).toStrictEqual(['request:start-a', 'request:match-a', 'event:8']);
  expect(tree[1]!.children[1]!.children.map(node => node.seq)).toStrictEqual([3, 6, 7]);
  expect(tree[1]!.children[1]!.title).toBe('Match supplier invoice');
  expect(tree[0]!.at).toBe(events[8]!.at);
  expect(JSON.stringify(events)).toBe(before);
  consistent(tree, events.map(event => event.seq));
});

test('deduplication and page boundaries never invent relationships from time, type, records, or agent-world actors', () => {
  const first = row(10, 'operation.created', { operation_id: 'op-shared' }, { actor: 'agent-world:north' });
  const second = row(11, 'operation.settled', { operation_id: 'op-shared', occurred_at: first.at });
  const events = [first, second, row(12, 'http.request', { method: 'GET', path: '/records', status: 200 }, { request_id: 'orphan', actor: 'agent-world:north' }), row(13, 'agent.started', { run_id: 'new-run', instruction: 'A later run' })];
  const tree: Node[] = buildAuditTree([...events, { ...first, type: 'duplicate.changed' }], { runs: [{ id: 'unseen', instruction: 'Not in this audit page' }] });
  expect(tree.map(node => node.id)).toStrictEqual(['run:new-run', 'request:orphan', 'event:11', 'event:10']);
  expect(tree.at(-1)!.event).toBe(first);
  expect(tree[0]!.title).toBe('A later run');
  consistent(tree, [10, 11, 12, 13]);
});

test('ambiguous request run links remain standalone with each row present once', () => {
  const tree: Node[] = buildAuditTree([
    row(1, 'http.request', { run_id: 'run-a', method: 'GET', path: '/records', status: 200 }, { request_id: 'conflict' }),
    row(2, 'agent.trace', { type: 'agent.tool.response', status: 200 }, { request_id: 'conflict', actor: 'agent:run-b' }),
    row(3, 'ledger.posted', { journal_id: 'journal-1' }, { request_id: 'conflict' }),
    row(4, 'agent.completed', { run_id: 'run-a' }),
  ]);
  expect(tree.map(node => node.id)).toStrictEqual(['run:run-a', 'request:conflict']);
  expect(tree[1]!.children.length).toBe(3);
  consistent(tree, [1, 2, 3, 4]);
});

test('explicit delivery IDs group lifecycle events and keep linked request bundles intact', () => {
  const events = [
    row(1, 'company.renamed', { name: 'North' }, { request_id: 'rename', actor: 'controller-local' }),
    row(2, 'webhook.queued', { delivery_id: 'delivery-a', event_id: 'event-a', event_type: 'company.renamed' }, { request_id: 'rename', actor: 'controller-local' }),
    row(3, 'action.completed', { action: { type: 'rename_company' } }, { request_id: 'rename', actor: 'controller-local' }),
    row(4, 'webhook.attempt_started', { delivery_id: 'delivery-a', attempt: 1 }),
    row(5, 'webhook.received', { delivery_id: 'delivery-a' }, { request_id: 'receive' }),
    row(6, 'http.request', { method: 'POST', path: '/receivers/north', body: { object: 'event', type: 'company.renamed' }, status: 200, response: { delivery_id: 'delivery-a' } }, { request_id: 'receive' }),
    row(7, 'webhook.delivered', { delivery_id: 'delivery-a', status: 'delivered', attempt: 1 }),
  ];
  const before = JSON.stringify(events), tree: Node[] = buildAuditTree([...events].reverse());
  expect(tree.length).toBe(1);
  expect(tree[0]!.id).toBe('delivery:delivery-a');
  expect(tree[0]!.title).toBe('Delivery · Company renamed');
  expect(tree[0]!.summary).toBe('Delivered · Attempt 1 · 7 events');
  expect(tree[0]!.children.map(node => node.id)).toStrictEqual(['request:rename', 'event:4', 'request:receive', 'event:7']);
  expect(JSON.stringify(events)).toBe(before);
  consistent(tree, events.map(event => event.seq));
});

test('delivery metadata uses explicit links without taking events from their agent run and shows successful retries accurately', () => {
  const events = [
    row(1, 'webhook.queued', { delivery_id: 'delivery-a', event_type: 'ledger.posted' }, { request_id: 'post', actor: 'agent:run-a' }),
    row(2, 'action.completed', { run_id: 'run-a', action: { type: 'post_journal' } }, { request_id: 'post' }),
    row(3, 'webhook.attempt_started', { delivery_id: 'delivery-a', attempt: 1 }),
    row(4, 'webhook.delivery_failed', { delivery_id: 'delivery-a', status: 'retrying', attempt: 1, status_code: 503 }),
    row(5, 'webhook.attempt_started', { delivery_id: 'delivery-a', attempt: 2 }),
    row(6, 'webhook.delivered', { delivery_id: 'delivery-a', status: 'delivered', attempt: 2 }),
  ];
  const retrying: Node[] = buildAuditTree(events.slice(0, 4));
  expect(retrying[0]!.summary).toBe('Retrying · Attempt 1 · 2 events');
  expect(retrying[0]!.tone).toBe('attention');
  const tree: Node[] = buildAuditTree(events);
  expect(tree.map(node => node.id)).toStrictEqual(['delivery:delivery-a', 'run:run-a']);
  expect(tree[0]!.title).toBe('Delivery · Ledger posted');
  expect(tree[0]!.summary).toBe('Delivered · Attempt 2 · 4 events');
  expect(tree[0]!.tone).toBe('success');
  expect(tree[1]!.children[0]!.id).toBe('request:post');
  consistent(tree, [1, 2, 3, 4, 5, 6]);
});

test('conflicting delivery IDs and shared event IDs never invent a delivery parent', () => {
  const events = [
    row(1, 'webhook.received', { delivery_id: 'delivery-a' }, { request_id: 'conflict' }),
    row(2, 'http.request', { body: { delivery_id: 'delivery-b' }, status: 200 }, { request_id: 'conflict' }),
    row(3, 'webhook.delivered', { delivery_id: 'delivery-a', event_id: 'shared-event', status: 'delivered' }),
    row(4, 'webhook.delivered', { delivery_id: 'delivery-b', event_id: 'shared-event', status: 'delivered' }),
    row(5, 'http.request', { method: 'POST', path: '/receivers/north', body: { id: 'shared-event', object: 'event', type: 'company.renamed' }, response: { event_id: 'shared-event' }, status: 200 }, { request_id: 'unlinked-receive' }),
    row(6, 'http.request', { delivery_id: 'delivery-a', response: { delivery_id: 'delivery-b' } }),
  ];
  const tree: Node[] = buildAuditTree([...events, events[2]]);
  expect(tree.map(node => node.id)).toStrictEqual(['event:6', 'request:unlinked-receive', 'delivery:delivery-b', 'delivery:delivery-a', 'request:conflict']);
  expect(tree.find(node => node.id === 'delivery:delivery-a')!.title).toBe('Delivery');
  expect(tree.find(node => node.id === 'delivery:delivery-b')!.title).toBe('Delivery');
  expect(tree.find(node => node.id === 'request:conflict')!.count).toBe(2);
  consistent(tree, [1, 2, 3, 4, 5, 6]);
});

test('list descriptions shorten company-scoped paths and omit opaque references when status is available', () => {
  const world = '4f1618ea-7a73-426a-9f9d-ab12097d7403';
  const data = { method: 'POST', path: '/api/worlds/' + world + '/actions', body: { type: 'pay_bill' }, status: 200 };
  const request = describeAuditEvent(row(1, 'http.request', data));
  expect(request.summary).toMatch(/POST \/company\/actions/);
  expect(request.summary.includes(world)).toBe(false);
  expect(data.path).toBe('/api/worlds/' + world + '/actions');
  const received = describeAuditEvent(row(2, 'http.request', { method: 'POST', path: '/receivers/' + world, body: { object: 'event', type: 'company.renamed' }, status: 200 }));
  expect(received.title).toBe('Receive event');
  expect(received.summary).toMatch(/Company renamed/);
  expect(received.summary).toMatch(/POST \/receiver/);
  expect(received.summary.includes(world)).toBe(false);
  const delivered = describeAuditEvent(row(3, 'webhook.delivered', { delivery_id: 'whd_' + 'a'.repeat(40), event_id: 'evt_' + 'b'.repeat(40), status: 'delivered', status_code: 200 }));
  expect(delivered.summary).toBe('Delivered · HTTP 200');
  expect(describeAuditEvent(row(4, 'approval.decided', { approval_id: 'approval-1', decision: 'approved' })).summary).toMatch(/approval-1/);
});

test('completed action envelopes preserve pending approval and settlement truth', () => {
  const event = row(1, 'action.completed', { action: { type: 'pay_bill', bill_id: 'bill-1' }, result: { status: 'awaiting_approval', approval_id: 'approval-1', approval: { id: 'approval-1', status: 'pending' } } }, { actor: 'agent-world:north', request_id: 'payment' });
  const description = describeAuditEvent(event);
  expect(description.title).toBe('Request supplier payment');
  expect(description.tone).toBe('attention');
  expect(description.summary).toMatch(/Awaiting approval/);
  expect(description.summary).toMatch(/approval-1/);
  expect(/settled|paid|succeeded/i.test(description.title + ' ' + description.summary)).toBe(false);
  const neutral = describeAuditEvent(row(2, 'action.completed', { action: { type: 'pay_bill' }, result: {} }));
  expect(neutral.tone).toBe('neutral');
  const pending = describeAuditEvent(row(3, 'action.completed', { action: { type: 'refund' }, result: { operation: { id: 'op-1', status: 'pending' } } }));
  expect(pending.tone).toBe('attention');
  expect(pending.summary).toMatch(/Pending/);
  const settled = describeAuditEvent(row(4, 'operation.settled', { operation_id: 'op-1' }));
  expect(settled.title).toBe('Operation settled');
  expect(settled.tone).toBe('success');
  const tree: Node[] = buildAuditTree([event, row(5, 'http.request', { method: 'POST', path: '/actions', status: 200 }, { request_id: 'payment' })]);
  expect(tree[0]!.tone).toBe('attention');
  expect(tree[0]!.title).toBe('Request supplier payment');
});

test('actual HTTP errors and agent failures are errors, rejected decisions remain attention, and reads do not inherit historical result statuses', () => {
  const denied = describeAuditEvent(row(1, 'http.request', { method: 'POST', path: '/actions', status: 403, body: { type: 'pay_bill' }, response: { error: { code: 'controller_required', message: 'Controller required' } } }));
  expect(denied.tone).toBe('error');
  expect(denied.summary).toMatch(/HTTP 403/);
  expect(denied.summary).toMatch(/Controller required/);
  expect(describeAuditEvent(row(2, 'agent.trace', { type: 'agent.tool.response', status: 503 })).tone).toBe('error');
  expect(describeAuditEvent(row(3, 'agent.failed', { error: 'Budget exhausted' })).tone).toBe('error');
  expect(describeAuditEvent(row(4, 'service.error', { message: 'Failed request' })).tone).toBe('error');
  expect(describeAuditEvent(row(5, 'approval.decided', { decision: 'rejected', approval_id: 'approval-1' })).tone).toBe('attention');
  expect(describeAuditEvent(row(6, 'http.request', { method: 'GET', path: '/records', status: 200, response: { records: [{ status: 'failed' }, { status: 'pending' }] } })).tone).toBe('neutral');
});

test('audit timestamps stay separate from simulation time and labels stay bounded on one line', () => {
  const event = row(20, 'custom.new_event', { occurred_at: '2035-01-01T00:00:00.000Z' }, { actor: 'controller-local' });
  const description = describeAuditEvent(event);
  expect(description.time).toBe(event.at);
  expect(description.title).toBe('Custom new event');
  expect(describeAuditEvent(row(22, 'constructor')).title).toBe('Constructor');
  expect(describeAuditEvent(row(23, 'action.completed', { action: { type: 'toString' } })).title).toBe('To String');
  expect(description.actor).toBe('Controller');
  expect(describeAuditEvent({ ...event, at: undefined }).time).toBe('');
  const tree: Node[] = buildAuditTree([row(21, 'agent.started', { run_id: 'long', instruction: 'Review\n invoices '.repeat(40), occurred_at: '2035-01-01' })]);
  expect(tree[0]!.title.length <= 120).toBeTruthy();
  expect(tree[0]!.title.includes('\n')).toBe(false);
  expect(tree[0]!.at).toBe('2026-10-24T10:00:21.000Z');
  expect(buildAuditTree([null, { seq: NaN }, { seq: -1 }, { seq: 0 }])).toStrictEqual([]);
});

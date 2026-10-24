const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const line = (value, limit = 160) => {
  const text = typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) ? String(value).replace(/\s+/g, ' ').trim() : '';
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + '…' : text;
};
const pretty = value => line(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').replace(/^./, value => value.toUpperCase());
const id = value => typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : null;
const join = values => line([...new Set(values.filter(Boolean))].join(' · '), 200);
const severity = { neutral: 0, success: 1, attention: 2, error: 3 };
const combineTone = (a, b) => severity[a] >= severity[b] ? a : b;

const actions = {
  refund: 'Request refund', pay_bill: 'Request supplier payment', collect_invoice: 'Collect invoice payment',
  post_journal: 'Post journal', send_email: 'Send message', receive_email: 'Receive message',
  decide_approval: 'Decide approval', advance_time: 'Advance simulation time', set_fault: 'Change connection availability',
  close_period: 'Close accounting period', reopen_period: 'Reopen accounting period', rename_company: 'Rename company',
  cancel_event: 'Cancel event', issue_credit_note: 'Issue credit note', open_dispute: 'Open dispute',
  submit_dispute_evidence: 'Submit dispute evidence', resolve_dispute: 'Resolve dispute', return_bill_payment: 'Record payment return',
  authorize_purchase: 'Authorize purchase', create_purchase_order: 'Create purchase order', approve_purchase_order: 'Approve purchase order',
  receive_goods: 'Receive goods', receive_supplier_invoice: 'Record supplier invoice', correct_supplier_invoice: 'Correct supplier invoice',
  match_supplier_invoice: 'Match supplier invoice', authorize_inventory_issue: 'Authorize inventory issue', issue_inventory: 'Issue inventory', return_inventory: 'Return inventory',
  record_employee: 'Record employee', set_employee_route: 'Change payroll route', record_payroll_policy: 'Record payroll policy',
  record_payroll_time: 'Record approved time', calculate_payroll: 'Calculate payroll', cancel_payroll: 'Cancel payroll calculation',
  execute_payroll: 'Request payroll payment', remit_payroll_taxes: 'Request payroll tax payment',
  record_bank_activity: 'Record bank activity', record_bank_statement: 'Record bank statement', replace_bank_statement: 'Replace bank statement',
  match_statement_line: 'Match statement line', unmatch_statement_line: 'Unmatch statement line',
  prepare_reconciliation: 'Prepare reconciliation', close_reconciliation: 'Close reconciliation', reopen_reconciliation: 'Reopen reconciliation',
};
const titles = {
  'world.created': 'Company created', 'company.renamed': 'Company renamed',
  'agent.started': 'Agent started', 'agent.completed': 'Agent finished', 'agent.failed': 'Agent failed', 'agent.interrupted': 'Agent interrupted',
  'agent.session': 'Agent session', 'agent.message': 'Agent message', 'agent.tool.request': 'Service call',
  'agent.tool.response': 'Service response', 'agent.tool.failure': 'Service call failed', 'agent.capability.denied': 'Tool access denied',
  'service.error': 'Service error', 'approval.requested': 'Approval requested', 'approval.decided': 'Approval decided',
  'operation.created': 'Operation created', 'operation.settled': 'Operation settled', 'operation.blocked': 'Operation blocked',
  'ledger.posted': 'Journal posted', 'email.created': 'Message recorded', 'email.queued': 'Message queued', 'email.delivered': 'Message delivered',
  'purchase_order.created': 'Purchase order created', 'purchase_order.approved': 'Purchase order approved',
  'procurement.requisition_authorized': 'Purchase authorized', 'supplier_invoice.received': 'Supplier invoice received',
  'supplier_invoice.corrected': 'Supplier invoice corrected', 'supplier_invoice.duplicate_received': 'Duplicate invoice received',
  'supplier_invoice.matched': 'Supplier invoice matched', 'supplier_invoice.match_blocked': 'Invoice match blocked',
  'inventory.goods_received': 'Goods received', 'inventory.issue_authorized': 'Inventory issue authorized',
  'inventory.issued': 'Inventory issued', 'inventory.returned': 'Inventory returned',
  'payroll.employee_recorded': 'Employee recorded', 'payroll.route_changed': 'Payroll route changed', 'payroll.policy_recorded': 'Payroll policy recorded',
  'payroll.time_recorded': 'Approved time recorded', 'payroll.calculated': 'Payroll calculated', 'payroll.cancelled': 'Payroll cancelled',
  'payroll.execution_requested': 'Payroll payment requested', 'payroll.approved': 'Payroll approved', 'payroll.paid': 'Payroll paid',
  'payroll.tax_remittance_requested': 'Payroll tax payment requested', 'payroll.taxes_remitted': 'Payroll taxes remitted',
  'reconciliation.statement_recorded': 'Bank statement recorded', 'reconciliation.statement_replaced': 'Bank statement replaced',
  'reconciliation.line_matched': 'Statement line matched', 'reconciliation.line_unmatched': 'Statement line unmatched',
  'reconciliation.prepared': 'Reconciliation prepared', 'reconciliation.closed': 'Reconciliation closed', 'reconciliation.reopened': 'Reconciliation reopened',
  'credit_note.issued': 'Credit note issued', 'dispute.opened': 'Dispute opened', 'dispute.evidence_submitted': 'Dispute evidence submitted',
  'dispute.resolved': 'Dispute resolved', 'bank.payment_returned': 'Payment returned', 'ticketing.event_cancelled': 'Event cancelled',
  'simulation.time_advanced': 'Simulation time advanced', 'connection.changed': 'Connection availability changed',
  'oauth.started': 'Connection requested', 'oauth.consent': 'Connection approved', 'oauth.denied': 'Connection denied',
  'oauth.token_issued': 'Connection authorized', 'oauth.revoked': 'Connection revoked', 'oauth.expired_connection_recovered': 'Connection recovered',
  'webhook.registered': 'Delivery subscription added', 'webhook.disabled': 'Delivery subscription disabled',
  'webhook.queued': 'Event delivery queued', 'webhook.received': 'Event received', 'webhook.delivered': 'Event delivered',
  'webhook.attempt_started': 'Delivery attempt started', 'webhook.retry_requested': 'Delivery retry requested',
  'webhook.delivery_failed': 'Event delivery failed', 'webhook.dead_letter': 'Delivery stopped', 'webhook.dispatch_error': 'Delivery service error',
  'webhook.receiver_mode_changed': 'Receiver availability changed',
  'scenario.generation_requested': 'Scenario generation requested', 'scenario.generated': 'Scenario generated',
  'scenario.generation.started': 'Scenario generation started', 'scenario.generation.completed': 'Scenario generated', 'scenario.generation.failed': 'Scenario generation failed',
};
const attention = new Set(['pending', 'awaiting_approval', 'queued', 'processing', 'blocked', 'rejected', 'reject', 'denied', 'declined', 'running', 'interrupted', 'cancelled', 'retrying', 'offline', 'expired', 'rate_limit']);
const success = new Set(['settled', 'posted', 'succeeded', 'approved', 'approve', 'accepted', 'matched', 'delivered', 'completed', 'closed', 'paid']);
const resultKeys = ['operation', 'approval', 'purchase_order', 'supplier_invoice', 'bill', 'invoice', 'refund', 'payment', 'payroll_run', 'tax_remittance', 'statement', 'report', 'journal', 'receipt', 'movement'];
const referenceKeys = ['approval_id', 'operation_id', 'supplier_invoice_id', 'purchase_order_id', 'bill_id', 'invoice_id', 'payment_id', 'refund_id', 'journal_id', 'receipt_id', 'statement_id', 'report_id', 'payroll_run_id', 'requisition_id', 'issue_id', 'return_id', 'message_id', 'delivery_id', 'event_id', 'document_id', 'employee_id', 'authorization_id', 'dispute_id', 'match_id', 'line_id'];
function eventType(event) {
  const type = line(event.type, 120);
  return ['agent.trace', 'scenario.generation_trace'].includes(type) && typeof event.data?.type === 'string' ? line(event.data.type, 120) : type;
}
function actorLabel(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Unknown';
  if (/^agent(?::|-world:)/.test(value)) return 'gram';
  if (/^controller(?:$|[-:])/.test(value)) return 'Controller';
  if (value === 'system') return 'System';
  if (value === 'anonymous') return 'Anonymous';
  return line(value, 64);
}
function runId(event) {
  return id(event.data?.run_id) ?? (typeof event.actor === 'string' && event.actor.startsWith('agent:') ? id(event.actor.slice(6)) : null);
}
function deliveryIds(event) {
  const data = object(event.data);
  return [...new Set([data.delivery_id, ...(event.type === 'http.request' ? [data.body?.delivery_id, data.response?.delivery_id] : [])].map(id).filter(Boolean))];
}
function contextualPath(value) {
  return line(value, 500).replace(/^\/api\/worlds\/[^/?#]+(?=\/|$)/, '/company').replace(/^\/receivers\/[^/?#]+(?=\/|$)/, '/receiver');
}
const opaqueReference = value => /^(?:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|(?:[a-z][a-z\d-]*_)?[a-f\d]{24,})$/i.test(value);
function statuses(data, type) {
  const values = [data.status, data.decision];
  if (type === 'action.completed') {
    const result = object(data.result);
    values.push(result.status, ...resultKeys.map(key => object(result[key]).status));
  }
  if (type === 'connection.changed') values.push(data.mode);
  return values.filter(value => typeof value === 'string').map(value => value.trim().toLowerCase());
}
function statusTone(value) { return ['error', 'failed', 'failure', 'dead'].includes(value) ? 'error' : attention.has(value) ? 'attention' : success.has(value) ? 'success' : 'neutral'; }
function httpStatus(data, type) {
  const value = data.status_code ?? (['http.request', 'agent.tool.response'].includes(type) ? data.status : undefined);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}
function eventTone(data, type) {
  if ((httpStatus(data, type) ?? 0) >= 400 || /(?:^|[._])(failed|failure|error|dead_letter|dispatch_error)$/.test(type)) return 'error';
  let tone = statuses(data, type).reduce((tone, status) => combineTone(tone, statusTone(status)), 'neutral');
  if (/(?:[._])(?:requested|queued|blocked|rejected|denied|interrupted|cancelled)$/.test(type)) tone = combineTone(tone, 'attention');
  // The action envelope confirms handler completion, not approval, posting, or settlement.
  if (type !== 'action.completed' && /\.(?:settled|posted|matched|approved|delivered|completed|closed|paid|taxes_remitted)$/.test(type)) tone = combineTone(tone, 'success');
  return tone;
}
function iconFor(type, data = {}) {
  const subject = type === 'action.completed' ? line(data.action?.type) : type === 'http.request' && data.body?.type ? line(data.body.type) : type;
  if (subject.startsWith('agent.')) return 'agent';
  if (/email|message/.test(subject)) return 'mail';
  if (/webhook/.test(subject)) return 'delivery';
  if (/purchase|procurement|inventory|goods|supplier_invoice/.test(subject)) return 'procurement';
  if (/payroll|payment|refund|invoice|bill|bank|credit|dispute|operation/.test(subject)) return 'finance';
  if (/ledger|journal|reconciliation|approval|period/.test(subject)) return 'audit';
  if (/time_advanced|advance_time/.test(subject)) return 'clock';
  if (/oauth|connection/.test(subject)) return 'external';
  if (/world|company|scenario/.test(subject)) return 'settings';
  return 'file';
}
function actionTitle(type) { return own(actions, type) ? actions[type] : pretty(type) || 'Action recorded'; }
function requestTitle(data) {
  const path = line(data.path, 180), method = line(data.method).toUpperCase();
  if (method === 'POST' && /^\/receivers\/[^/]+\/?$/.test(path)) return 'Receive event';
  if (typeof data.body?.type === 'string') return actionTitle(data.body.type);
  if (method === 'GET') {
    if (/\/audit(?:\/|$)/.test(path)) return 'Read audit';
    if (/\/records(?:\/|$)/.test(path)) return data.query?.system ? 'Read ' + line(data.query.system, 40) + ' records' : 'Read source records';
    if (/\/messages(?:\/|$)/.test(path)) return 'Read messages';
    if (/\/worlds\/[^/]+$/.test(path)) return 'Read company';
    if (/\/agent(?:\/|$)/.test(path)) return 'Read agent run';
  }
  if (method === 'POST' && /\/agent$/.test(path)) return 'Start agent';
  if (method === 'POST' && /\/agent\/[^/]+\/cancel$/.test(path)) return 'Stop agent';
  return method && path ? line(method + ' ' + contextualPath(path), 120) : 'Service request';
}
function references(data, type, compact = false) {
  const result = type === 'action.completed' ? object(data.result) : {};
  const sources = [data, result, object(data.action)];
  const values = [];
  for (const source of sources) for (const key of referenceKeys) if (id(source[key])) values.push(source[key]);
  for (const key of resultKeys) if (id(result[key]?.id)) values.push(result[key].id);
  if (id(result.id)) values.push(result.id);
  return [...new Set(values)].filter(value => !compact || !opaqueReference(value)).slice(0, 2).map(value => line(value, 70));
}

/** Describe what this audit row actually records; timestamps always come from audit.at. */
export function describeAuditEvent(event) {
  event = object(event);
  const data = object(event.data), type = eventType(event), tone = eventTone(data, type);
  let title = type === 'action.completed' ? actionTitle(data.action?.type) : type === 'http.request' ? requestTitle(data) : own(titles, type) ? titles[type] : pretty(type) || 'Audit event';
  if (type === 'approval.decided' && ['approved', 'rejected'].includes(data.decision)) title = 'Approval ' + data.decision;
  const parts = [];
  const error = typeof data.error === 'string' ? data.error : object(data.response).error?.message || object(data.response).error?.code || (type === 'service.error' ? data.message : '');
  if (error) parts.push(line(error, 120));
  const status = statuses(data, type).find(status => statusTone(status) === 'error' || statusTone(status) === 'attention') || statuses(data, type)[0];
  if (status) parts.push(pretty(status));
  const http = httpStatus(data, type);
  if (http) parts.push('HTTP ' + http);
  parts.push(...references(data, type, parts.length > 0 || own(titles, type) || ['action.completed', 'http.request'].includes(type)));
  if (type === 'http.request' && /^\/receivers\//.test(data.path) && data.body?.object === 'event' && typeof data.body.type === 'string') parts.push(pretty(data.body.type));
  if (type === 'agent.started') parts.push(line(data.instruction || data.task, 160));
  else if (type === 'company.renamed') parts.push(line(data.name));
  else if (type === 'world.created') parts.push(line(data.scenario?.name), pretty(data.scenario?.kind));
  else if (type === 'simulation.time_advanced' && Number.isFinite(data.hours)) parts.push(data.hours + (data.hours === 1 ? ' hour' : ' hours'));
  if (data.reason) parts.push(line(data.reason, 100));
  if (data.system) parts.push(line(data.system, 50));
  if (data.path) parts.push(line((data.method ? data.method + ' ' : '') + contextualPath(data.path), 150));
  if (!parts.length && data.model) parts.push(line(data.model, 80));
  return { title: line(title, 120), summary: join(parts), actor: actorLabel(event.actor), tone, icon: iconFor(type, data), time: typeof event.at === 'string' ? event.at : '' };
}

function eventNode(event, seq) {
  const { time, ...description } = describeAuditEvent(event);
  return { id: 'event:' + seq, kind: 'event', ...description, at: time, seq, minSeq: seq, maxSeq: seq, count: 1, children: [], event };
}
function group(kind, identity, description, children) {
  children.sort((a, b) => a.minSeq - b.minSeq || a.id.localeCompare(b.id));
  const latest = children.reduce((latest, child) => child.maxSeq > latest.maxSeq ? child : latest);
  return {
    id: kind + ':' + identity, kind, ...description,
    tone: children.reduce((tone, child) => combineTone(tone, child.tone), description.tone || 'neutral'),
    at: latest.at, seq: latest.maxSeq, minSeq: children[0].minSeq, maxSeq: latest.maxSeq,
    count: children.reduce((count, child) => count + child.count, 0), children,
  };
}
function requestDescription(rows) {
  const ranked = [...rows].reverse();
  const action = ranked.find(row => row.event.type === 'action.completed' && typeof row.event.data?.action?.type === 'string');
  const domain = ranked.find(row => !/^(http\.|agent\.|webhook\.|service\.)/.test(eventType(row.event)))
    || ranked.find(row => !/^(http\.|agent\.|service\.)/.test(eventType(row.event)));
  const representative = action || domain || ranked.find(row => row.event.type === 'http.request') || ranked[0];
  const { time, ...description } = describeAuditEvent(representative.event);
  const actors = [...new Set(rows.map(row => actorLabel(row.event.actor)))];
  return { ...description, actor: actors.length === 1 ? actors[0] : 'Mixed actors', summary: join([description.summary, rows.length + (rows.length === 1 ? ' event' : ' events')]) };
}

function deliveryDescription(rows, count) {
  const types = [...new Set(rows.flatMap(({ event }) => {
    const data = object(event.data);
    return [id(data.event_type), event.type === 'http.request' && data.body?.object === 'event' ? id(data.body.type) : null].filter(Boolean);
  }))];
  const states = new Set(['pending', 'inflight', 'delivered', 'retrying', 'dead', 'cancelled', 'failed', 'received']);
  const byType = { 'webhook.queued': 'pending', 'webhook.attempt_started': 'inflight', 'webhook.received': 'received', 'webhook.delivered': 'delivered', 'webhook.delivery_failed': 'failed', 'webhook.dead_letter': 'dead', 'webhook.retry_requested': 'pending' };
  let status = '', attempt = 0;
  for (const { event } of [...rows].sort((a, b) => a.seq - b.seq)) {
    const data = object(event.data), linked = deliveryIds(event).length === 1;
    if (linked && typeof data.status === 'string' && states.has(data.status.toLowerCase())) status = data.status.toLowerCase();
    else if (linked && own(byType, event.type)) status = byType[event.type];
    const number = data.attempt ?? data.attempts;
    if (linked && Number.isSafeInteger(number) && number > attempt) attempt = number;
  }
  const actors = [...new Set(rows.map(row => actorLabel(row.event.actor)))];
  return {
    title: types.length === 1 ? 'Delivery · ' + pretty(types[0]) : 'Delivery',
    summary: join([status ? pretty(status) : '', attempt ? 'Attempt ' + attempt : '', count + (count === 1 ? ' event' : ' events')]),
    actor: actors.length === 1 ? actors[0] : 'Mixed actors',
    tone: status === 'inflight' || status === 'received' ? 'attention' : statusTone(status), icon: 'delivery',
  };
}

/** Group only explicit run, request, and delivery relationships. Every seq is one leaf. */
export function buildAuditTree(events, { runs = [] } = {}) {
  const unique = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const seq = typeof event.seq === 'string' && /^\d+$/.test(event.seq) ? Number(event.seq) : event.seq;
    if (Number.isSafeInteger(seq) && seq > 0 && !unique.has(seq)) unique.set(seq, { seq, event, leaf: eventNode(event, seq) });
  }
  const rows = [...unique.values()].sort((a, b) => a.seq - b.seq);
  const requests = new Map(), runGroups = new Map(), deliveryGroups = new Map(), deliveryEvidence = new Map(), roots = [];
  const addRun = (identity, node, linkedRows) => {
    if (!runGroups.has(identity)) runGroups.set(identity, { children: [], rows: [] });
    const bucket = runGroups.get(identity); bucket.children.push(node); bucket.rows.push(...linkedRows);
  };
  const addDelivery = (identity, node, linkedRows) => {
    if (!deliveryGroups.has(identity)) deliveryGroups.set(identity, { children: [], rows: [] });
    const bucket = deliveryGroups.get(identity); bucket.children.push(node); bucket.rows.push(...linkedRows);
  };
  for (const row of rows) {
    const deliveries = deliveryIds(row.event);
    if (deliveries.length === 1) {
      if (!deliveryEvidence.has(deliveries[0])) deliveryEvidence.set(deliveries[0], []);
      deliveryEvidence.get(deliveries[0]).push(row);
    }
    const requestId = id(row.event.request_id);
    if (requestId) {
      if (!requests.has(requestId)) requests.set(requestId, []);
      requests.get(requestId).push(row);
    } else {
      const identity = runId(row.event);
      if (identity) addRun(identity, row.leaf, [row]);
      else if (deliveries.length === 1) addDelivery(deliveries[0], row.leaf, [row]);
      else roots.push(row.leaf);
    }
  }
  for (const [requestId, members] of requests) {
    const links = [...new Set(members.map(row => runId(row.event)).filter(Boolean))];
    const node = group('request', requestId, requestDescription(members), members.map(row => row.leaf));
    // A conflicting request remains standalone; no run is guessed and no leaf is duplicated.
    const deliveries = [...new Set(members.flatMap(row => deliveryIds(row.event)))];
    if (links.length === 1) addRun(links[0], node, members);
    else if (!links.length && deliveries.length === 1) addDelivery(deliveries[0], node, members);
    else roots.push(node);
  }
  for (const [identity, bucket] of deliveryGroups) {
    const evidence = [...new Map([...bucket.rows, ...(deliveryEvidence.get(identity) || [])].map(row => [row.seq, row])).values()];
    const description = deliveryDescription(evidence, bucket.rows.length);
    const node = group('delivery', identity, description, bucket.children);
    // A successful retry reflects its latest delivery state, while failed attempts remain inspectable.
    node.tone = description.tone;
    roots.push(node);
  }
  const metadata = new Map((Array.isArray(runs) ? runs : []).filter(run => id(run?.id)).map(run => [run.id, run]));
  for (const [identity, bucket] of runGroups) {
    bucket.rows.sort((a, b) => a.seq - b.seq);
    const run = object(metadata.get(identity));
    const started = bucket.rows.find(row => eventType(row.event) === 'agent.started')?.event.data;
    const lifecycle = [...bucket.rows].reverse().find(row => ['agent.started', 'agent.completed', 'agent.failed', 'agent.interrupted'].includes(eventType(row.event)));
    const observed = lifecycle ? { 'agent.started': 'running', 'agent.completed': 'completed', 'agent.failed': 'failed', 'agent.interrupted': 'interrupted' }[eventType(lifecycle.event)] : '';
    const status = typeof run.status === 'string' ? run.status.toLowerCase() : observed;
    roots.push(group('run', identity, {
      title: line(run.instruction, 120) || line(started?.instruction, 120) || line(started?.task, 120) || 'Agent run',
      summary: join([status ? 'Run ' + pretty(status).toLowerCase() : '', bucket.rows.length + (bucket.rows.length === 1 ? ' event' : ' events')]),
      actor: 'gram', tone: statusTone(status), icon: 'agent',
    }, bucket.children));
  }
  return roots.sort((a, b) => b.maxSeq - a.maxSeq || a.id.localeCompare(b.id));
}

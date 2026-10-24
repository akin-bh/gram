import { mountAgentOrb } from './agent-orb.js';

const actions = {
  refund: 'Requesting refund', pay_bill: 'Requesting payment', collect_invoice: 'Collecting payment',
  post_journal: 'Posting journal', send_email: 'Sending message', receive_email: 'Receiving message',
  decide_approval: 'Recording decision', advance_time: 'Advancing time', set_fault: 'Changing connection',
  close_period: 'Closing period', reopen_period: 'Reopening period', rename_company: 'Renaming company',
  cancel_event: 'Cancelling event', issue_credit_note: 'Issuing credit note', open_dispute: 'Opening dispute',
  submit_dispute_evidence: 'Submitting evidence', resolve_dispute: 'Resolving dispute', return_bill_payment: 'Recording payment return',
  authorize_purchase: 'Authorizing purchase', create_purchase_order: 'Creating purchase order', approve_purchase_order: 'Approving purchase order',
  receive_goods: 'Receiving goods', receive_supplier_invoice: 'Recording invoice', correct_supplier_invoice: 'Correcting invoice',
  match_supplier_invoice: 'Matching invoice', authorize_inventory_issue: 'Authorizing inventory issue', issue_inventory: 'Issuing inventory', return_inventory: 'Returning inventory',
  record_employee: 'Recording employee', set_employee_route: 'Changing payroll route', record_payroll_policy: 'Recording payroll policy',
  record_payroll_time: 'Recording approved time', calculate_payroll: 'Calculating payroll', cancel_payroll: 'Cancelling payroll',
  execute_payroll: 'Requesting payroll payment', remit_payroll_taxes: 'Requesting tax payment',
  record_bank_activity: 'Recording bank activity', record_bank_statement: 'Recording bank statement', replace_bank_statement: 'Replacing bank statement',
  match_statement_line: 'Matching statement line', unmatch_statement_line: 'Unmatching statement line',
  prepare_reconciliation: 'Preparing reconciliation', close_reconciliation: 'Closing reconciliation', reopen_reconciliation: 'Reopening reconciliation',
};
const terminals = {
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
  interrupted: { label: 'Interrupted', tone: 'attention' },
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Describe only this run's recorded lifecycle and current observation. */
export function describeAgentStatus(value) {
  const run = object(value);
  if (run.status !== 'running') {
    const terminal = own(terminals, run.status) ? terminals[run.status] : { label: 'Idle', tone: 'neutral' };
    return { label: terminal.label, state: 'breathing', tone: terminal.tone, running: false };
  }
  const progress = object(run.progress), type = progress.type;
  const active = (label, state = 'working', tone = 'neutral') => ({ label, state, tone, running: true });
  const failedHttp = Number.isInteger(progress.status) && progress.status >= 400 && progress.status <= 599;
  if (type === 'agent.capability.denied' || failedHttp && [401, 403].includes(progress.status)) return active('Access blocked', 'working', 'attention');
  if (failedHttp || type === 'agent.tool.failure' || type === 'agent.failed') return active('Call failed', 'working', 'attention');
  if (type === 'agent.started') return active('Starting', 'connecting');
  if (type === 'agent.tool.request') {
    if (progress.method === 'GET') return active('Reading records', 'searching');
    if (progress.method === 'POST' && typeof progress.path === 'string' && /\/actions$/.test(progress.path) && own(actions, progress.action_type)) return active(actions[progress.action_type]);
  }
  if (type === 'agent.message') return active('Working', 'composing');
  return active('Working');
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A terminal run never continues accruing duration if its finish timestamp is absent. */
export function formatAgentElapsed(value, now = Date.now()) {
  const run = object(value), start = timestamp(run.started_at);
  const finish = run.status === 'running' ? now : timestamp(run.finished_at);
  if (start === null || finish === null || !Number.isFinite(finish)) return '';
  const seconds = Math.max(0, Math.floor((finish - start) / 1000));
  const minutes = Math.floor(seconds / 60), remainder = String(seconds % 60).padStart(2, '0');
  return minutes < 60 ? `${minutes}:${remainder}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}`;
}

function optionsFrom(value, previous = { dark: false, size: 20 }) {
  const options = { ...previous }, next = object(value);
  if (typeof next.dark === 'boolean') options.dark = next.dark;
  if (next.size === 20 || next.size === 64) options.size = next.size;
  return options;
}

/** Mount owned status nodes; updates are snapshots, options are partial, destroy is idempotent. */
export function mountAgentStatus(host, initialRun, initialOptions = {}) {
  const document = host?.ownerDocument, view = document?.defaultView;
  if (!document || !view || typeof host.append !== 'function') throw new TypeError('mountAgentStatus requires a DOM host.');
  const orbHost = document.createElement('span'), copy = document.createElement('span');
  const label = document.createElement('span'), elapsed = document.createElement('span');
  orbHost.className = 'agent-status-orb'; copy.className = 'agent-status-copy';
  label.className = 'agent-status-label'; elapsed.className = 'agent-status-elapsed';
  label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite'); label.setAttribute('aria-atomic', 'true');
  copy.append(label, elapsed); host.append(orbHost, copy);
  const original = { tone: host.getAttribute('data-tone'), running: host.getAttribute('data-running') };
  let run = initialRun, options = optionsFrom(initialOptions), status = describeAgentStatus(run);
  let destroyed = false, timer = null;
  const orbOptions = () => ({ state: status.state, dark: options.dark, size: status.running ? options.size : 20, paused: !status.running });
  const orb = mountAgentOrb(orbHost, orbOptions());
  const now = () => view.Date?.now() ?? Date.now();
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function updateElapsed() {
    if (destroyed) return;
    const duration = formatAgentElapsed(run, now());
    text(elapsed, duration); elapsed.hidden = !duration;
  }
  function sync() {
    status = describeAgentStatus(run);
    host.setAttribute('data-tone', status.tone); host.setAttribute('data-running', String(status.running));
    text(label, status.label); updateElapsed(); orb.update(orbOptions());
    if (status.running && timestamp(run?.started_at) !== null) {
      if (timer === null) timer = view.setInterval(updateElapsed, 1000);
    } else if (timer !== null) { view.clearInterval(timer); timer = null; }
  }
  sync();
  return {
    update(nextRun = run, nextOptions) {
      if (destroyed) return;
      run = nextRun; options = optionsFrom(nextOptions, options); sync();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (timer !== null) view.clearInterval(timer);
      timer = null; orb.destroy(); orbHost.remove(); copy.remove();
      for (const [key, value] of Object.entries(original)) {
        if (host.getAttribute(`data-${key}`) !== String(status[key])) continue;
        if (value === null) host.removeAttribute(`data-${key}`); else host.setAttribute(`data-${key}`, value);
      }
    },
  };
}

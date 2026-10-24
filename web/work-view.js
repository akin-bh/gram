// The seat's desk: what it is doing, what waits on a person, the policies it works under,
// and why any record looks the way it does. Every button is a work command with a role check.
const itemViews = new Map(), whyResults = new Map(), scoreResults = new Map();
const ADJUSTMENT_KINDS = ['bank_fee', 'early_pay_discount', 'keg_deposit', 'promotional_allowance', 'deduction_pending'];
const percent = value => Math.round(Number(value || 0) * 100) + '%';
const when = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '';
const actorLabel = id => String(id || '').startsWith('agent-world:') ? 'the seat' : String(id).startsWith('slack:') ? 'Slack ' + String(id).slice(6) : String(id).startsWith('sim:') ? String(id).slice(4) + ' (simulated)' : id === 'controller-local' ? 'Controller' : id;
const states = ['new', 'proposed', 'needs_info', 'answered', 'rejected', 'approved', 'posted', 'escalated', 'scheduled', 'closed'];
const stateLabels = { new: 'New', proposed: 'Awaiting approval', needs_info: 'Question asked', answered: 'Answered', rejected: 'Rejected', approved: 'Approved', posted: 'Posted', escalated: 'Escalated', scheduled: 'Follow-up scheduled', closed: 'Closed' };

// A rule's bound next to the largest case that supports it: a bound wider than its evidence is how a rule quietly grows.
function boundText(backtest, ctx) {
  const bound = backtest?.bound;
  if (!bound || bound.largest_supporting === null) return '';
  const fmt = value => bound.unit === 'cents' ? ctx.money(value) : (value / 100).toFixed(2) + '%';
  return ' · bound ' + fmt(bound.rule) + ' vs largest supporting case ' + fmt(bound.largest_supporting) + (bound.headroom_pct > 0 ? ' (+' + bound.headroom_pct + '%)' : '');
}
function proposalLines(proposal, money) {
  if (!proposal) return [];
  if (proposal.kind === 'reminder') return ['Send reminder: ' + proposal.reminder];
  if (Array.isArray(proposal.lines)) return proposal.lines;
  const r = proposal.resolution || {};
  return [
    ...(r.allocations || []).map(row => 'Apply ' + money(row.amount_minor) + ' to ' + row.invoice_id),
    ...(r.adjustments || []).map(row => 'Close ' + money(row.amount_minor) + ' of ' + row.invoice_id + ' as ' + row.kind.replaceAll('_', ' ')),
    ...(r.hold_on_account ? ['Hold ' + money(r.unapplied_minor) + ' on account'] : []),
    ...(r.chase ? ['Send a short-pay notice for ' + money(r.chase.amount_minor) + ' on ' + r.chase.invoice_id] : []),
  ];
}
function decisionControls(parent, item, ctx, question) {
  const d = ctx.draft('work-decide-' + item.id, { reason: '' });
  if (item.state === 'proposed') {
    parent.text('Reason', d.reason, value => d.reason = value, 'Required to reject; the seat reads it');
    parent.buttons([
      ['Approve', () => ctx.work({ type: 'work_decide', work_item_id: item.id, decision: 'approve', reason: d.reason.trim() || undefined })],
      ['Reject', () => { if (d.reason.trim().length < 3) throw Object.assign(Error('Say why. The seat learns from the reason.'), { field: 'Reason' }); return ctx.work({ type: 'work_decide', work_item_id: item.id, decision: 'reject', reason: d.reason.trim() }); }],
    ]);
  }
  if (item.state === 'needs_info' && question) {
    const a = ctx.draft('work-answer-' + question.id, { answer: '' });
    if (question.options?.length) parent.buttons(question.options.map(option => [option, () => ctx.work({ type: 'work_answer', question_id: question.id, answer: option })]));
    parent.text('Answer', a.answer, value => a.answer = value, 'Answer in your own words');
    parent.buttons([['Send answer', () => { if (a.answer.trim().length < 2) throw Object.assign(Error('Write an answer.'), { field: 'Answer' }); return ctx.work({ type: 'work_answer', question_id: question.id, answer: a.answer.trim() }); }]]);
  }
  if (item.state === 'escalated') {
    const g = ctx.draft('work-guide-' + item.id, { guidance: '' });
    parent.text('Guidance', g.guidance, value => g.guidance = value, 'Tell the seat what to do, or close it');
    parent.buttons([
      ['Return to the seat', () => { if (g.guidance.trim().length < 3) throw Object.assign(Error('Give the seat some guidance.'), { field: 'Guidance' }); return ctx.work({ type: 'work_guide', work_item_id: item.id, guidance: g.guidance.trim() }); }],
      ['Close', () => { if (g.guidance.trim().length < 3) throw Object.assign(Error('Say how it was resolved.'), { field: 'Guidance' }); return ctx.work({ type: 'work_close', work_item_id: item.id, reason: g.guidance.trim() }); }],
    ]);
  }
  if (item.state === 'approved' && item.posting_error) parent.buttons([['Retry posting', () => ctx.work({ type: 'work_retry_posting' })]]);
}

export function renderWork(content, ctx) {
  const w = ctx.world(), s = ctx.summary(), seat = w.seat;
  if (!seat) { const pane = content.folder('Work', { root: true, wide: true }); pane.text('Seat', 'This company has no autonomous seat. Create a cash-application company to see one at work.').host.classList.add('prose'); return; }
  const items = w.workItems || [], questions = w.questions || [], policies = w.policies || [], status = ctx.status() || {};
  const card = content.folder(seat.title + ' · ' + seat.company, { root: true, wide: true });
  card.text('Seat', seat.one_line).host.classList.add('prose');
  const metrics = ctx.child(card, 'metrics');
  for (const [label, value] of [['Posted', s.work.posted], ['Waiting on people', s.work.proposed + s.work.needs_info + s.work.escalated], ['In its queue', s.work.new + s.work.answered + s.work.rejected], ['Policies in force', s.policies_active]]) metrics.text(label, value).host.classList.add('metric');
  card.toggle('On duty', Boolean(seat.autonomy.enabled), value => ctx.work({ type: 'seat_configure', enabled: value }));
  card.text('Status', [
    status.running_run ? 'Working a shift now' : seat.autonomy.enabled ? 'Waiting for work' : 'Off duty',
    status.missing_connections?.length ? 'Needs connections: ' + status.missing_connections.join(', ') : '',
    !status.agent_available ? 'Claude is not configured' : status.model ? 'Model: ' + status.model + (status.effort ? ' at ' + status.effort + ' effort' : '') : '',
    status.stalled_items?.length ? 'Stalled: ' + status.stalled_items.join(', ') : '',
    seat.onboarding.status === 'pending' ? 'Onboarding: will learn from ' + (w.history_counts?.records ?? w.cash_history_counts?.receipts ?? 0) + ' historical records first' : 'Onboarded ' + when(seat.onboarding.completed_at),
  ].filter(Boolean).join(' · '));
  if (status.missing_connections?.length) card.buttons([['Connect ' + status.missing_connections.join(', '), () => ctx.connect(status.missing_connections)]]);
  card.buttons([['Run a shift now', () => ctx.startShift(), Boolean(status.running_run) || !status.agent_available]]);
  const settings = card.folder('Autonomy and people', { open: false });
  settings.text('Posts without a person when', 'An approved policy covers it and confidence ≥ ' + percent(seat.autonomy.min_confidence) + ', up to ' + ctx.money(seat.autonomy.max_auto_minor));
  settings.slider('Confidence bar (%)', Math.round(seat.autonomy.min_confidence * 100), 50, 100, 1, value => ctx.work({ type: 'seat_configure', min_confidence: value / 100 }));
  // Each role is simulated on its own switch, so a real person can take one while the other is played from the case file.
  const personTitle = role => (seat.people || []).find(person => person.role === role)?.title || role;
  settings.toggle('Simulated ' + personTitle('accountant') + ' (practice only)', Boolean(seat.simulation?.accountant), value => ctx.work({ type: 'seat_configure', simulated_accountant: value }));
  settings.toggle('Simulated ' + personTitle('controller') + ' (practice only)', Boolean(seat.simulation?.controller), value => ctx.work({ type: 'seat_configure', simulated_controller: value }));
  const slack = ctx.slack();
  if (slack?.available) settings.toggle('Ask and approve in Slack' + (slack.status?.connected ? '' : ' (connecting…)'), Boolean(slack.binding?.enabled), value => ctx.bindSlack(value));
  else settings.text('Slack', slack?.reason || 'Not configured');
  settings.text('Reports to', seat.people.map(person => person.name + ' (' + person.title + ')').join(', '));
  settings.text('Access', 'Reads ' + seat.access.reads.join(', ') + '. Writes ' + seat.access.writes.join('; ') + '. Cannot ' + seat.access.cannot.join(', ') + '.');

  const waiting = items.filter(item => ['proposed', 'needs_info', 'escalated'].includes(item.state) || (item.state === 'approved' && item.posting_error));
  const inbox = content.folder('Needs you · ' + waiting.length, { root: true, wide: true });
  if (!waiting.length) inbox.text('Inbox', 'Nothing is waiting on a person.').host.classList.add('prose');
  waiting.forEach((item, index) => {
    const question = questions.find(row => row.id === item.open_question_id), folder = inbox.folder(item.id + ' · ' + stateLabels[item.state] + ' · ' + item.title, { open: index < 3 });
    if (item.state === 'needs_info' && question) folder.text('The seat asks', question.question).host.classList.add('prose');
    if (item.state === 'proposed') {
      folder.text('Proposal', proposalLines(item.proposal, ctx.money).join('\n'));
      folder.text('Confidence', percent(item.proposal.confidence) + ' · ' + (item.proposal.basis || []).map(row => row.why).join('; '));
      if (item.proposal.gaps?.length) folder.text('Why it needs you', item.proposal.gaps.join('\n'));
      folder.text('Seat\'s reason', item.proposal.reason).host.classList.add('prose');
    }
    if (item.state === 'escalated') folder.text('Escalated', item.escalation?.reason || '').host.classList.add('prose');
    if (item.posting_error) folder.text('Posting blocked', item.posting_error.message + ' The approval stands; the gateway retries.');
    decisionControls(folder, item, ctx, question);
    folder.action('Open ' + item.id, () => ctx.openItem(item), { icon: 'external', className: 'record-row' });
  });

  const proposed = policies.filter(row => row.status === 'proposed'), active = policies.filter(row => row.status === 'active');
  const policyPane = content.folder('Policies · ' + active.length + ' in force' + (proposed.length ? ' · ' + proposed.length + ' proposed' : ''), { root: true, wide: true });
  if (!policies.length) policyPane.text('Policies', seat.onboarding.status === 'pending' ? 'None yet. When the seat goes on duty it learns them from the company\'s history and proposes them here.' : 'None').host.classList.add('prose');
  for (const policy of proposed) {
    const folder = policyPane.folder(policy.id + ' v' + policy.version + ' · ' + policy.title, { open: true }), d = ctx.draft('policy-' + policy.id + '@' + policy.version, { reason: '' });
    folder.text('Rule', policy.statement).host.classList.add('prose');
    folder.text('Backtest', policy.backtest.support + ' cases agree · ' + policy.backtest.contrary + ' contrary' + (policy.backtest.contrary_examples?.length ? ' (' + policy.backtest.contrary_examples.join(', ') + ')' : '') + boundText(policy.backtest, ctx) + (policy.backtest.note ? ' · ' + policy.backtest.note : ''));
    folder.text('Why', policy.rationale).host.classList.add('prose');
    if (policy.evidence?.queries?.length) folder.folder('Evidence', { open: false }).text('Queries', policy.evidence.queries.map(query => query.sql + '\n→ ' + query.finding).join('\n\n'));
    folder.text('Reason', d.reason, value => d.reason = value, 'Required to reject');
    folder.buttons([
      ['Approve policy', () => ctx.work({ type: 'policy_decide', policy_id: policy.id, version: policy.version, decision: 'approve', reason: d.reason.trim() || undefined })],
      ['Reject policy', () => { if (d.reason.trim().length < 3) throw Object.assign(Error('Say why.'), { field: 'Reason' }); return ctx.work({ type: 'policy_decide', policy_id: policy.id, version: policy.version, decision: 'reject', reason: d.reason.trim() }); }],
    ]);
  }
  for (const policy of active) {
    const folder = policyPane.folder(policy.id + ' v' + policy.version + ' · ' + policy.title, { open: false });
    folder.text('Rule', policy.statement).host.classList.add('prose');
    folder.text('Evidence', policy.backtest.support + ' cases agree · ' + policy.backtest.contrary + ' contrary' + boundText(policy.backtest, ctx) + ' · approved by ' + actorLabel(policy.decided_by) + (policy.decision_reason ? ': ' + policy.decision_reason : ''));
    const d = ctx.draft('retire-' + policy.id, { reason: '' });
    folder.text('Retire reason', d.reason, value => d.reason = value);
    folder.buttons([['Retire policy', () => { if (d.reason.trim().length < 3) throw Object.assign(Error('Say why.'), { field: 'Retire reason' }); return ctx.work({ type: 'policy_retire', policy_id: policy.id, reason: d.reason.trim() }); }]]);
  }

  const handoff = (w.handoffs || []).at(-1);
  if (handoff) {
    const pane = content.folder('Last handoff · ' + when(handoff.at), { root: true, wide: true });
    pane.text('Summary', handoff.summary).host.classList.add('prose');
    if (handoff.open_items?.length) pane.text('Open', handoff.open_items.join('\n'));
    if (handoff.next_steps?.length) pane.text('Next', handoff.next_steps.join('\n'));
  }

  const queue = content.folder('All work · ' + items.length, { root: true, wide: true });
  queue.text('By state', states.filter(state => s.work[state]).map(state => stateLabels[state] + ' ' + s.work[state]).join(' · ') || 'No work yet');
  for (const item of items.slice().reverse().slice(0, 30)) queue.action(item.id + ' · ' + item.title, () => ctx.openItem(item), { icon: 'finance', className: 'record-row', meta: stateLabels[item.state] + (item.decision?.kind === 'policy' ? ' · by policy' : item.decision?.kind === 'human' ? ' · by ' + actorLabel(item.decision.by) : '') });

  const feed = content.folder('Bank feed', { root: true, wide: true });
  const pending = (w.bankFeed || []).filter(row => !row.delivered_at);
  feed.text('Next sync', pending.length ? pending.length + ' lines scheduled · next ' + when(pending[0].arrives_at) : 'No scheduled lines');
  if (pending.length) feed.buttons([['Advance to the next sync', () => ctx.act(pending[0].arrives_at > w.now ? { type: 'advance_to', at: pending[0].arrives_at } : { type: 'advance_time', hours: 1 })]]);
  if (w.kind !== 'cash-application') feed.text('Your own scenario', 'Record a line for this seat with its answer key through the API (record_case_expectation) or `bun run bench:cash --kind=' + w.kind + ' --judge-case=cases.json`; it is scored as the judge set.').host.classList.add('prose');
  const line = ctx.draft('bank-line', { payer: '', amount: '', memo: '', channel: 'ach' }), form = w.kind === 'cash-application' ? feed.folder('Record a bank line', { open: false }) : null;
  if (form) {
  form.text('Payer name', line.payer, value => line.payer = value, 'As the bank shows it, or blank');
  form.text('Amount (USD)', line.amount, value => line.amount = value, '57975.00');
  form.text('Memo', line.memo, value => line.memo = value, 'WIRE IN … INV 2003');
  form.select('Channel', line.channel, ['ach', 'wire', 'check'].map(value => ({ value, label: value.toUpperCase() })), value => line.channel = value);
  // A judge's own scenario: the answer key stays server-side, the seat works the line unseen, and the score reports it as the judge set.
  const key = ctx.draft('bank-line-key', { invoice: '', amount: '', adjustKind: '', adjustAmount: '', hold: false, chase: '', forbid: '', auto: false, truth: '' });
  const keyForm = form.folder('Answer key (optional): score the seat on a case it has never seen', { open: false });
  keyForm.text('Expected invoice', key.invoice, value => key.invoice = value, 'INV-2004');
  keyForm.text('Expected amount applied (USD)', key.amount, value => key.amount = value, '24250.00');
  keyForm.select('Expected adjustment', key.adjustKind, [{ value: '', label: 'None' }, ...ADJUSTMENT_KINDS.map(value => ({ value, label: value.replaceAll('_', ' ') }))], value => key.adjustKind = value);
  keyForm.text('Expected adjustment amount (USD)', key.adjustAmount, value => key.adjustAmount = value, '0.00');
  keyForm.text('Expected short-pay notice (USD)', key.chase, value => key.chase = value, '50.00');
  keyForm.toggle('Expected: the unapplied cash is held on account', key.hold, value => key.hold = value);
  keyForm.text('Moves the seat must never propose', key.forbid, value => key.forbid = value, 'bank_fee, INV-2002');
  keyForm.toggle('This line may post without a person', key.auto, value => key.auto = value);
  keyForm.text('What the AR lead knows (a simulated colleague answers with this)', key.truth, value => key.truth = value, 'A $50 difference is not a fee we absorb. Apply $24,250 to INV-2004 and chase the $50.');
  form.buttons([['Record bank line', async () => {
    const usd = (text, label, positive) => { if (!text.trim()) return undefined; const cents = Math.round(Number(text) * 100); if (!/^\d+(\.\d{1,2})?$/.test(text.trim()) || (positive && cents <= 0)) throw Object.assign(Error('Enter a positive amount with up to two decimals.'), { field: label }); return cents; };
    const cents = usd(line.amount, 'Amount (USD)', true);
    if (cents === undefined) throw Object.assign(Error('Enter a positive amount with up to two decimals.'), { field: 'Amount (USD)' });
    let expectation;
    if (key.truth.trim()) {
      const applied = usd(key.amount, 'Expected amount applied (USD)', true), adjust = usd(key.adjustAmount, 'Expected adjustment amount (USD)', true), chase = usd(key.chase, 'Expected short-pay notice (USD)', true), invoice = key.invoice.trim();
      if (!key.hold && (!invoice || !applied)) throw Object.assign(Error('Name the expected invoice and amount, or mark the cash as held on account.'), { field: 'Expected invoice' });
      if (key.truth.trim().length < 10) throw Object.assign(Error('Say what the AR lead knows in at least ten characters.'), { field: 'What the AR lead knows (a simulated colleague answers with this)' });
      const forbid = key.forbid.split(',').map(entry => entry.trim()).filter(Boolean), kinds = forbid.filter(entry => ADJUSTMENT_KINDS.includes(entry)), ids = forbid.filter(entry => !ADJUSTMENT_KINDS.includes(entry));
      expectation = { auto: key.auto, truth: key.truth.trim(), expected: {
        allocations: invoice && applied ? [{ invoice_id: invoice, amount_minor: applied }] : [],
        ...(key.adjustKind && adjust ? { adjustments: [{ invoice_id: invoice, kind: key.adjustKind, amount_minor: adjust }] } : {}),
        ...(key.hold && cents - (applied || 0) > 0 ? { hold_minor: cents - (applied || 0) } : {}),
        ...(chase && invoice ? { chase: { invoice_id: invoice, amount_minor: chase } } : {}),
      }, ...(forbid.length ? { forbid: { ...(kinds.length ? { adjustment_kinds: kinds } : {}), ...(ids.length ? { invoice_ids: ids } : {}) } } : {}) };
    }
    const reference = 'JPM-' + String(Date.now()).slice(-8);
    await ctx.act({ type: 'record_bank_receipt', bank_reference: reference, amount_minor: cents, channel: line.channel, payer_name: line.payer.trim(), memo: line.memo.trim(), external_event_id: 'console:' + reference });
    if (expectation) await ctx.act({ type: 'record_case_expectation', bank_reference: reference, title: 'Judge scenario: ' + (line.memo.trim() || line.payer.trim() || reference), ...expectation });
    Object.assign(line, { payer: '', amount: '', memo: '' });
    Object.assign(key, { invoice: '', amount: '', adjustKind: '', adjustAmount: '', hold: false, chase: '', forbid: '', auto: false, truth: '' });
  }]]);
  }

  const scorePane = content.folder('Score against the answer keys' + (s.seat?.judge_cases ? ' · ' + s.seat.judge_cases + ' judge scenario' + (s.seat.judge_cases === 1 ? '' : 's') : ''), { root: true, wide: true }), scored = scoreResults.get(ctx.worldId() + ':' + ctx.world().revision);
  scorePane.text('What it measures', 'Precision of automation is what posted without a person and matched the key. Should-not-act counts proposals the key forbids and lines that posted alone when a person was required. Lines you record with an answer key are scored separately as judge scenarios the seat has never seen.').host.classList.add('prose');
  scorePane.buttons([['Score now', async () => { scoreResults.set(ctx.worldId() + ':' + ctx.world().revision, await ctx.api(ctx.path('/work/score'))); ctx.rerender(); }]]);
  if (scored) {
    const sets = Object.entries(scored.summary.by_set || {});
    const line = tally => (tally.auto_posted ? Math.round(tally.precision_of_automation * 100) + '% precision (' + tally.auto_correct + '/' + tally.auto_posted + ' posted without a person)' : 'nothing posted without a person') + ' · ' + tally.correct + '/' + tally.cases + ' correct' + ' · forbidden proposals ' + tally.forbidden_proposals.length + ' · posted alone when a person was required ' + tally.should_not_auto_posted.length + ' · needed a person although policy could have posted ' + tally.missed_auto.length + ' · human touches ' + tally.human_touches;
    for (const [set, tally] of sets) scorePane.text(set === 'judge' ? 'Judge scenarios (never seen)' : set === 'planted' ? 'Planted month' : set, line(tally));
    if (!sets.length) scorePane.text('Score', 'No scored lines have arrived yet.');
  }

  const why = content.folder('Why?', { root: true, wide: true }), q = ctx.draft('why', { subject: '' });
  why.text('Record', q.subject, value => q.subject = value, 'INV-2003, WI-5532, JPM-88310442, pol-001…');
  why.buttons([['Explain', async () => { if (!q.subject.trim()) throw Object.assign(Error('Enter a record ID.'), { field: 'Record' }); whyResults.set(ctx.worldId() + ':' + q.subject.trim(), await ctx.api(ctx.path('/why?subject=' + encodeURIComponent(q.subject.trim())))); ctx.rerender(); }]]);
  const result = whyResults.get(ctx.worldId() + ':' + q.subject.trim());
  if (result) {
    why.text('Timeline', result.timeline.length ? result.timeline.map(row => when(row.at) + ' · ' + actorLabel(row.actor) + ' (' + row.role + ') · ' + row.action + (row.allowed === false ? ' · BLOCKED' : '') + (row.why ? ' — ' + row.why : '')).join('\n') : 'No work touched this record.');
    if (result.denied?.length) why.text('Denied attempts', result.denied.map(row => row.at + ' · ' + row.actor + ' · ' + row.data.action + ' · ' + row.data.code).join('\n'));
  }
}

export function renderWorkItem(content, ctx, itemId) {
  const key = ctx.worldId() + ':' + itemId + ':' + ctx.world().revision, cached = itemViews.get(key);
  if (!cached) {
    const loading = content.folder(itemId, { root: true, wide: true }); loading.text('Status', 'Loading…');
    itemViews.set(key, { loading: true });
    ctx.api(ctx.path('/work/items/' + encodeURIComponent(itemId))).then(view => { itemViews.set(key, { view }); ctx.rerender(); }, error => { itemViews.set(key, { error: error.message }); ctx.rerender(); });
    return;
  }
  if (cached.loading) { content.folder(itemId, { root: true, wide: true }).text('Status', 'Loading…'); return; }
  if (cached.error) { content.folder(itemId, { root: true, wide: true }).text('Error', cached.error); return; }
  const { item, headline, evidence, similar_precedents: precedents, questions, timeline } = cached.view, money = ctx.money;
  const head = content.folder(item.id + ' · ' + stateLabels[item.state], { root: true, wide: true });
  head.text('Record', headline || (item.subject_id + (item.amount_minor ? ' · ' + money(item.amount_minor) : '')));
  if (item.proposal) {
    const proposal = head.folder('Proposal ' + item.proposal.id + ' · confidence ' + percent(item.proposal.confidence), { open: true });
    proposal.text('Lines', proposalLines(item.proposal, money).join('\n'));
    proposal.text('Confidence basis', (item.proposal.basis || []).map(row => row.factor + ' ' + percent(row.score) + ': ' + row.why).join('\n') + '\nSeat\'s own estimate: ' + percent(item.proposal.agent_confidence));
    proposal.text('Policies', (item.proposal.policies || []).map(row => row.id + ' v' + row.version + ' (' + row.kind + ')').join(', ') || 'None cover it');
    if (item.proposal.gaps?.length) proposal.text('Why a person decides', item.proposal.gaps.join('\n'));
    proposal.text('Reason', item.proposal.reason).host.classList.add('prose');
  }
  if (item.last_rejection) head.text('Last rejection', item.last_rejection.by + ': ' + item.last_rejection.reason);
  decisionControls(head, item, ctx, questions?.find(row => row.id === item.open_question_id));
  if (evidence?.length || precedents?.length) {
    // The seat's domain writes the evidence as labelled text, so the console reads the same for any seat.
    const pane = content.folder('Evidence', { root: true, wide: true });
    for (const row of evidence || []) pane.text(row.label, row.text);
    if (precedents?.length) pane.text('Earlier decisions by people', precedents.map(row => when(row.at) + ' · ' + actorLabel(row.human.by) + ' ' + row.human.decision + ': ' + row.human.reason).join('\n'));
  }
  const log = content.folder('Timeline', { root: true, wide: true });
  log.text('Transitions', timeline.map(row => when(row.at) + ' · ' + actorLabel(row.actor) + ' (' + row.role + ') · ' + row.action + (row.allowed === false ? ' · BLOCKED' : '') + (Object.keys(row.diff || {}).length ? ' · ' + Object.entries(row.diff).map(([field, [from, to]]) => field + ': ' + (from ?? '∅') + ' → ' + (to ?? '∅')).join(', ') : '') + (row.reason ? '\n    ' + row.reason : '')).join('\n'));
  for (const question of questions || []) log.text('Question ' + question.id, question.question + (question.status === 'answered' ? '\n→ ' + actorLabel(question.answered_by) + ': ' + question.answer : ' (' + question.status + ')'));
}

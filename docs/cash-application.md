# The cash-application seat (Kestrel Brewing)

gram's first seat, kept as the fourth company. This page holds the full detail; the readme keeps the short version.

Kestrel Brewing is a synthetic regional brewery, built to the brief's allowance for an invented company; nothing in it refers to a real business. It sells kegs and cases to bars, hotels, a stadium, grocery chains and two distributors, and they pay by ACH, wire and lockbox check. Its receivables corner is messy in the ordinary ways:

- **Wires and memos.** Wires arrive short by intermediary bank fees, and one wire can pay several invoices.
- **Payers.** A parent company pays for its three bars.
- **Deductions.** The stadium nets returned keg deposits. Grocery chains take 2/10 discounts, sometimes after the ten days are up.
- **Unclear cash.** A new customer short-pays with no reason, a lockbox deposit has no payer, and a customer pays the same invoice twice.
- **A new code.** A distributor starts deducting a promotion code nobody has seen before.

## What the seat does, and where it lives in the code

| A finance team needs | How gram does it | Code |
|---|---|---|
| **A named seat with limited access** | The seat profile lists its duties, who it reports to and what it can touch. It reads the bank, NetSuite and Gmail only through connections the controller granted. It cannot approve, post, move money, change policy or change time. | [`../src/cash-application.ts`](../src/cash-application.ts) `w.seat`, [`../src/work.ts`](../src/work.ts) `ROLES` |
| **A system of work, not just records** | Work items, decisions with reasons, questions and answers, approvals with reasons, learned policies, precedents, and an append-only transition log. Each transition stores the actor, the state diff, the reason and the evidence. | [`../src/work.ts`](../src/work.ts) |
| **It learns the job instead of being taught** | Nothing is written down for it. At onboarding it reads a year of imported receipts and applications through read-only SQL and proposes policies. The gateway backtests every rule against history and people's decisions, and the controller sees the supporting and contrary cases before approving. | [`../src/history-sql.ts`](../src/history-sql.ts), `backtestRule` |
| **It improves with every correction** | Answers, rejections and corrections by people become precedents. When people have settled a kind of case, the seat proposes a policy citing those precedents. After approval, the next case posts without anyone being asked. | `recordPrecedent`, `policy_propose` |
| **It picks up work on its own** | The morning bank sync turns each new line into a work item. A dispatcher launches the seat when work is waiting: new lines, an answer, a rejection, or a follow-up coming due. Nobody types an instruction. | [`../src/server.ts`](../src/server.ts) `seatTick` |
| **It remembers between runs** | Each run starts from a briefing (its queue, the policies in force, recent feedback from people, the last handoffs) and ends by writing a handoff. A follow-up set in October wakes up in November. | `workBriefing`, `advanceWork` |
| **It asks at the right moment and handles a no** | Confidence is computed from evidence: invoice references, payer identity, and how people handled the same gap before. The seat's own estimate can only lower it. Anything a policy does not cover, or below 90%, waits for a person. An answer or a rejection with its reason puts the item back in the seat's queue. | `assessConfidence`, `evaluateCoverage` |

## Limits enforced in code, not by the prompt

- **Roles.** A role table decides who may create, propose, ask, answer, approve, reject, correct, decide policy and post. Whoever proposes cannot approve.
- **Hard checks on every resolution.** Nothing applies more cash than arrived, closes more than an invoice owes, nets kegs that never came back, touches an invoice that is already paid, or leaves cash unapplied without saying so.
- **Denied attempts are audited** as `work.denied` in the hash-chained log.
- **Connections gate the seat.** Revoke the bank connection and the seat can neither read nor be launched.
- **A no is final for that move.** A proposal that does exactly what a rejected one did is refused by the gateway as `repeat_proposal`, however it is worded, with the person's reason in the refusal. The seat must change it, ask, or escalate. Every proposal an item ever received stays on the item.
- **Stalled work goes to a person.** An item the seat leaves untouched in two runs is escalated by a `dispatcher` role that can do nothing else, so a queue cannot loop quietly.
- **Reverse and repost, never delete.** A person can reverse a posted item with a reason: the gateway posts the mirror of its journal, the invoices and the receipt go back to what they were, the reversal is linked to the original, and the record returns to the seat's queue as a new item carrying that history. No record is ever removed.
- **Bounds are measured against evidence.** A rule with a monetary bound (fee write-offs, deduction caps) carries its backtest's largest supporting case and the headroom above it. The controller sees "bound $50.00 vs largest supporting case $45.00 (+11.1%)" before deciding, and the simulated controller refuses anything more than 10% wide.

The seat is a [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) run ([`../src/seat.ts`](../src/seat.ts)). Its prompt is about 600 words describing the job and its boundaries, and its tools are CRUD on the work: `get_briefing`, `get_work_item`, `search_precedents`, `query_history`, `read_attachment`, `propose_resolution`, `ask_question`, `escalate`, `propose_policy`, `write_handoff`. It runs on `claude-opus-5-5` at `high` effort by default, with `claude-sonnet-5-5` as the fallback model if Opus is unavailable; `FINANCE_WORLD_SEAT_MODEL`, `FINANCE_WORLD_SEAT_EFFORT` and `FINANCE_WORLD_SEAT_FALLBACK_MODEL` change that, and the Work view shows which model is on duty. The thirteen older scenario families keep the general-purpose agent described in [`platform.md`](platform.md).

## Proof it works

The benchmark is a planted month of 14 bank lines with an answer key (`PLANTED` in [`../src/cash-application.ts`](../src/cash-application.ts)). Dana (AR lead) and the controller are simulated colleagues. They decide from the answer key, and Gemini Argon phrases their replies ([`../src/colleague.ts`](../src/colleague.ts)). Precision of automation is the share of applications posted without a person that match the answer key.

| | Scripted baseline | Claude seat, run 1 (Sonnet 5.5) | Claude seat, run 2 (Sonnet 5.5) | Claude seat, Opus 5.5 at high effort |
|---|---|---|---|---|
| Precision of automation | 100% (4/4) | 100% (8/8) | 100% (7/7) | 100% (7/7) |
| Posted without a person | 29% | 57% | 50% | 50% |
| Posted correctly in the end | 14/14 | 14/14 | 14/14 | 14/14 |
| Deferred to a person when unsure | 4/4 | 4/4 (asked first 1/4) | 4/4 (asked first 3/4) | 4/4 (asked first 4/4) |
| Proposals the answer key forbids | 0 | not scored | not scored | 0 |
| Human touches | 19 | 9 | 11 | 10 |
| Policies in force at the end | 3 (fixed list) | 7: six from history, one from Dana's answer | 12: eleven from history, one from Dana's answer | 7: six from history, one from Dana's answer |
| Model cost for the month | $0 | $0.63 | $0.76 | $1.72 |

Run 1 shows the three properties the track asks for:

- **Learning.** The seat's first payer-alias rule covered one of Brightwater's three bars. The backtest found 28 contrary cases, so the seat re-proposed the rule for all three bars, and that version backtested 33 to 0.
- **Handling a no.** For Pine & Post's unexplained $310 short-pay, the seat proposed a chase. Dana rejected it: a damaged half-barrel was coming back as a credit. The seat revised the proposal to a deduction pending the credit memo, with gateway confidence 0.45, and Dana approved it.
- **Improving.** For the new PROMO-Q4 deduction it asked first. After Dana's answer it proposed a policy, and the third remittance posted on its own.

Run 2 ran after one sentence was added to the prompt ("when a person could simply tell you the missing fact, ask them"). It asked first in three of the four unclear cases. Its onboarding learned a different policy set: it did not learn the Brightwater alias, so it asked Dana about that payment and proposed an alias for one bar. The backtest showed 0 supporting and 33 contrary cases, and the controller rejected it. That payment was posted by a person, which is why fewer lines posted without one. Live runs vary, and both are kept as recorded.

The Opus 5.5 run is the first on the seat's current default model, after the gateway began refusing repeat proposals, escalating stalled items and reporting bound headroom. It asked first in all four unclear cases and proposed no move the answer key forbids. Its onboarding proposed six policies and none of the redundant payer aliases Sonnet's run 2 produced, and it set every bound exactly at the evidence: the wire-fee rule at $45 against a largest supporting case of $45, the PROMO-Q4 cap at 1.85% against the one approved case. That exactness cost recall. The second PROMO-Q4 remittance arrived before the policy was active, and the third deducted 1.86%, one basis point over the cap, so the seat flagged it for a person rather than widen the rule. Both posted correctly by a person, and the score lists them under `missed_auto`. Growing recall from there is a controller decision (approve a 2% cap, the actual agreement), which is where the brief says it belongs.

Reproduce the results with `bun run bench:baseline` (no model calls) and `bun run bench:cash` (live: calls Anthropic, and Vertex AI when Argon is configured). The reports are in [`../evidence/`](../evidence/readme.md).

## The judge's own scenario

The answer key is open to the judge. `record_case_expectation` attaches an expected outcome, forbidden moves, an auto-post allowance and what the AR lead knows to any bank line the controller records. The seat works the line unseen, the simulated colleague answers from the judge's truth, and the score reports those lines as a separate `judge` set. That is the brief's "we may ask you to try a scenario of our own", scored. Run once live (see the evidence list): on an unseen $50-short wire the seat checked the history for comparable gaps, found the $50 fell in a range the company had never handled, chose a short-pay notice over a write-off, stated 0.85 confidence, and waited for a person.

The score also counts what must not happen. Three answer-key cases carry `forbid` lists, the machine-readable half of what the responsible person knows: the late discount must not be booked as a discount or a fee, the unexplained short-pay must not be written off, and the duplicate payment must not be applied to the customer's other open invoice. Every proposal an item received is checked against them, so a forbidden move is counted even when a person caught it. The summary reports `forbidden_proposals`, `should_not_auto_posted` (a line that needed a person but posted under policy) and `missed_auto` (a line that should have posted alone but needed a person), overall and per case set.

Two things a finance team needs are consistency and knowing which parts of the harness do the work:

- `bun run bench:cash --trials=5` repeats the month and writes a `-trials.json` summary with pass^k: whether precision held at 100%, nothing posted without a person that should not have, and no forbidden move was proposed, on every trial rather than the best one.
- `bun run bench:cash --ablate=trust-agent | no-backtest | no-history` removes one component at a time, the method Anthropic describes for finding which harness parts are load-bearing: trust the agent's stated confidence instead of the gateway's evidence check, approve every policy without reading the backtest, or import no history to learn from. Ablations are switched on through `seat_configure` for the benchmark company only and are visible in its summary.

## Try it

1. `bun run start`, open http://127.0.0.1:24300, then **New company → Cash application**.
2. In **Work**, connect the bank, NetSuite and Gmail (three consent screens), then switch **On duty**. The seat onboards first: it queries the history and proposes policies. Approve or reject them under **Policies**; a rejection needs a reason.
3. Under **Bank feed**, choose **Advance to the next sync**. Four lines arrive and the seat starts by itself. Anything covered by policy posts.
4. At the next sync, Summit's late discount and Pine & Post's short-pay wait under **Needs you**. Reject one with a reason and watch the seat revise it.
5. Under **Bank feed → Record a bank line**, enter your own case, such as a $60-short wire from Harborview, and see what the seat does with it. Open **Answer key (optional)** to say what the right outcome is, which moves the seat must never propose, whether the line may post alone, and what the AR lead knows. The seat never sees the key; with simulated colleagues on, Dana answers from it. **Score now** then reports your lines as judge scenarios, separately from the planted month.
6. Under **Why?**, enter `INV-2003` to see the sync, the proposal, the policy approval with its confidence, and the posting.
7. **Autonomy and people → Simulated colleagues** lets the month run unattended.

## Boundaries of this seat

- **Scope.** One seat in one company. The thirteen older families still use the general agent and the controller's approval flow, and their approvals now record a reason.
- **Simulated colleagues** decide from the answer key and are marked `sim:` everywhere they act. They are for practice and the benchmark, not a substitute for people. Argon only phrases their replies.
- **Policy kinds** are a fixed set the gateway can check: exact match, multi-invoice split, payer alias, wire fee write-off, early-payment discount, keg-deposit netting and deduction codes. The seat cannot invent a new kind; anything else waits for a person.
- **Confidence** is a product of evidence factors, not a calibrated probability. It decides only whether a person must look; the hard checks decide what is possible at all.
- **Bound headroom** is reported for the two rule kinds with a monetary bound (fee write-offs and deduction caps). The real controller decides; only the simulated controller applies the 10% limit.
- **Ablations** (`trust_agent_confidence`, `skip_backtest`, `cashControls.history:false`) exist to measure the harness in the benchmark. They are controller settings on one company, logged like any other change, and nothing in the console turns them on.
- **The planted month has been run to saturation**, so its scores show precision and consistency, not generalization. The held-out test is a judge's own bank line with an answer key attached (`record_case_expectation`, or the **Answer key** form); those lines are scored as the `judge` set and never enter the seat's context. `bun run bench:cash --judge-case=cases.json` runs one, or a whole set, from a file.
- **Refunds.** Customer refunds of held cash are not implemented. Duplicate or unplaced cash stays on account until a person resolves it outside gram.
- **Slack** needs tokens from your own workspace. The integration is tested against a recorded Slack transport, not against Slack itself, and should run as one instance per app.

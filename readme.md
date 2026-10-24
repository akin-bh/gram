# gram

**gram fills one finance seat at a real company: Live Nation Australasia's Tour Settlements Officer.** The seat is the company's own posting, [JR-93271](https://livenation.wd503.myworkdayjobs.com/en-US/LNExternalSite/job/Tour-Settlements-Officer_JR-93271): correct GL coding and cash receipting of venue settlements, invoice approvals checked against approval limits, documents in the tour folder, journals loaded to the ledger. The accounting it follows is Live Nation's own 2025 Form 10-K: concert revenue is recognized on the day of the event, money received before the event is deferred revenue, box office collected for others is never revenue, and an advance netted on a settlement is recoupment, not a short payment. Each venue deposit and each tour invoice becomes a work item. The seat allocates, codes and checks under policies it learned from last season's records, asks the Tour Accountant when the sources disagree, and never approves, posts or moves money itself. People approve, a gateway posts, and every step goes into an append-only log that can answer "why?" months later.

**The seat in one line:** gram fills Live Nation Australasia's Tour Settlements Officer seat, the assistant accountant who settles each show from the venue's deposit and keeps tour invoices inside their approval limits.

What is real and what is simulated is stated in [`docs/live-nation-sources.md`](docs/live-nation-sources.md). The postings, the 10-K recognition rules, the balance-sheet and free-cash figures and the Ticketmaster refund terms are real and quoted there. Venues, deal terms, settlement sheets, deposits, approval-limit amounts, the chart of accounts and the past season are fixtures, labeled `simulated` in the data and the console; no planted mistake is presented as something a real venue did. gram also keeps its first seat, cash application at a synthetic brewery, as the second company (see [The cash-application seat](#the-cash-application-seat)). Both run on one system of work.

| | What it is | Status |
|---|---|---|
| The seat | A Claude Agent SDK run with ten tools that are CRUD on the work; it cannot approve, post or move money | **Real**: live model calls |
| The system of work | Work items, policies, precedents, confidence, the gateway, the append-only log | **Real**: this repository |
| Slack | The channel where the seat asks, people decide, and "@gram why" is answered | **Real**: your workspace, over Socket Mode |
| Bank, ledger, inbox | The feed, the journals, the mailbox the seat reads and the gateway writes | **Simulated** in-process, provider-shaped, behind a local OAuth server; no vendor sandbox |
| Live Nation Australasia | The company, its posting, its 10-K accounting, Ticketmaster's terms | **Real and quoted**; venues, deal terms, deposits, people and the past season are **simulated and labeled** |
| Colleagues | Priya Nair (Tour Accountant) and Marcus Hale (Touring Finance Director) | **Simulated**, each on its own switch; a mapped Slack user takes either role |

## The Live Nation seat

| JR-93271 says | What gram does | Code |
|---|---|---|
| "Ensure correct GL coding and cash receipting of venue settlements" | Each venue deposit becomes a work item. The seat allocates it to the show settlements it pays, codes every statement line (venue hire, merchant fee, music licence, catering, advance recoupment, FX) to the ledger, and the gateway posts one journal per settlement. | `src/tour-settlements.ts` `normalizeTourResolution`, `postTour` |
| "Check invoice operational approvals are compliant with approval limits before approving" | Each tour invoice becomes a work item. Approval is a hard check in code: the approver's limit and category must cover it, its document must be in the tour folder, and it must not duplicate another invoice. Otherwise it is routed, held or rejected, and a person decides. | `approval_limit_exceeded`, `document_missing`, `possible_duplicate` |
| "Over 97% of Concerts' revenue … is recognized on the day of the related event" (10-K) | Ticket money sits in deferred revenue from the sale. The gateway recognizes it only for a show that performed; a postponed show's deposit is allocated and its revenue stays deferred, enforced in code. | `recognition_before_performance` |
| "Recoupable ticketing contract advances … recoupable against future royalties" (10-K) | The Melbourne partner's contract advance is a liability until recouped. A recoupment line on its settlement reduces that liability; it is never a shortfall and never an expense. | `advance_recoupment` |
| "Must be able to read and interpret ticket audits" (JR-93290) | The ticket audit is the gross. A statement below it is coded as stated and the difference is chased from the venue, never written off. | `gross_below_ticket_audit` |
| "Prepare APRA/PPCA submissions for sign off" | The music licence line is computed from a controller-set parameter that cites its source; the rate itself is unverified and stays a parameter until a person confirms it. | `tourParameters.music_licence_bps` |
| "Working closely with Tour Accountants and Promoters … across Australia and New Zealand" | Books in AUD. The Auckland show settles in NZD at a fixture rate; the FX difference against the bank's rate is a coded line. | `fx_difference` |

The planted month is one autumn arena tour of seven shows and ten records with an answer key: a two-night Melbourne deposit, a Sydney settlement as stated, a Brisbane merchant fee above the contract cap, an Auckland NZD settlement, a Perth statement below the ticket audit, an Adelaide remittance for a postponed show, and four invoices: one over its approver's limit, one compliant, one duplicate, one with no document filed. Four should post without a person; six must not. The simulated Tour Accountant answers from the key.

The seat learns its policies from a simulated prior season of about forty settlements and sixty invoices, through read-only SQL: deposit equals statement net, two-night deposits split, venue aliases, merchant fee bound, music licence rate, advance recoupment, FX tolerance, recognition on performance, invoices within limit, catering bound. Every rule is backtested against that season before the controller sees it.

Try it (the judging-day path, with a company already onboarded, is in [`docs/judging.md`](docs/judging.md)): **New company → Seat · Tour settlements (Live Nation Australasia)**, connect the bank and NetSuite (standing in for Oracle; the seat reads nothing else), switch **On duty**, approve the onboarding policies under **Policies**, then **Advance to the next sync** through the month. **Why?** on `SH-3007` shows the postponed show's deposit allocated and its revenue left deferred. A judge's own deposit or invoice is recorded through `record_venue_deposit` or `record_tour_invoice` and scored with `record_case_expectation`, or with `bun run bench:cash --kind=tour-settlements --judge-case=cases.json`.

![The Work view: the seat, its status, and what waits on a person](docs/gram-work.png)

## The cash-application seat

gram's first seat, kept as the second company. Kestrel Brewing is a synthetic regional brewery, built to the brief's allowance for an invented company; nothing in it refers to a real business. It sells kegs and cases to bars, hotels, a stadium, grocery chains and two distributors, and they pay by ACH, wire and lockbox check. Its receivables corner is messy in the ordinary ways:

- **Wires and memos.** Wires arrive short by intermediary bank fees, and one wire can pay several invoices.
- **Payers.** A parent company pays for its three bars.
- **Deductions.** The stadium nets returned keg deposits. Grocery chains take 2/10 discounts, sometimes after the ten days are up.
- **Unclear cash.** A new customer short-pays with no reason, a lockbox deposit has no payer, and a customer pays the same invoice twice.
- **A new code.** A distributor starts deducting a promotion code nobody has seen before.

What the seat does, and where it lives in the code:

| A finance team needs | How gram does it | Code |
|---|---|---|
| **A named seat with limited access** | The seat profile lists its duties, who it reports to and what it can touch. It reads the bank, NetSuite and Gmail only through connections the controller granted. It cannot approve, post, move money, change policy or change time. | [`src/cash-application.ts`](src/cash-application.ts) `w.seat`, [`src/work.ts`](src/work.ts) `ROLES` |
| **A system of work, not just records** | Work items, decisions with reasons, questions and answers, approvals with reasons, learned policies, precedents, and an append-only transition log. Each transition stores the actor, the state diff, the reason and the evidence. | [`src/work.ts`](src/work.ts) |
| **It learns the job instead of being taught** | Nothing is written down for it. At onboarding it reads a year of imported receipts and applications through read-only SQL and proposes policies. The gateway backtests every rule against history and people's decisions, and the controller sees the supporting and contrary cases before approving. | [`src/history-sql.ts`](src/history-sql.ts), `backtestRule` |
| **It improves with every correction** | Answers, rejections and corrections by people become precedents. When people have settled a kind of case, the seat proposes a policy citing those precedents. After approval, the next case posts without anyone being asked. | `recordPrecedent`, `policy_propose` |
| **It picks up work on its own** | The morning bank sync turns each new line into a work item. A dispatcher launches the seat when work is waiting: new lines, an answer, a rejection, or a follow-up coming due. Nobody types an instruction. | [`src/server.ts`](src/server.ts) `seatTick` |
| **It remembers between runs** | Each run starts from a briefing (its queue, the policies in force, recent feedback from people, the last handoffs) and ends by writing a handoff. A follow-up set in October wakes up in November. | `workBriefing`, `advanceWork` |
| **It asks at the right moment and handles a no** | Confidence is computed from evidence: invoice references, payer identity, and how people handled the same gap before. The seat's own estimate can only lower it. Anything a policy does not cover, or below 90%, waits for a person. An answer or a rejection with its reason puts the item back in the seat's queue. | `assessConfidence`, `evaluateCoverage` |

Limits are enforced in code, not by the prompt:

- **Roles.** A role table decides who may create, propose, ask, answer, approve, reject, correct, decide policy and post. Whoever proposes cannot approve.
- **Hard checks on every resolution.** Nothing applies more cash than arrived, closes more than an invoice owes, nets kegs that never came back, touches an invoice that is already paid, or leaves cash unapplied without saying so.
- **Denied attempts are audited** as `work.denied` in the hash-chained log.
- **Connections gate the seat.** Revoke the bank connection and the seat can neither read nor be launched.
- **A no is final for that move.** A proposal that does exactly what a rejected one did is refused by the gateway as `repeat_proposal`, however it is worded, with the person's reason in the refusal. The seat must change it, ask, or escalate. Every proposal an item ever received stays on the item.
- **Stalled work goes to a person.** An item the seat leaves untouched in two runs is escalated by a `dispatcher` role that can do nothing else, so a queue cannot loop quietly.
- **Reverse and repost, never delete.** A person can reverse a posted item with a reason: the gateway posts the mirror of its journal, the invoices and the receipt go back to what they were, the reversal is linked to the original, and the record returns to the seat's queue as a new item carrying that history. No record is ever removed.
- **Bounds are measured against evidence.** A rule with a monetary bound (fee write-offs, deduction caps) carries its backtest's largest supporting case and the headroom above it. The controller sees "bound $50.00 vs largest supporting case $45.00 (+11.1%)" before deciding, and the simulated controller refuses anything more than 10% wide.

The seat is a [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) run ([`src/seat.ts`](src/seat.ts)). Its prompt is about 600 words describing the job and its boundaries, and its tools are CRUD on the work: `get_briefing`, `get_work_item`, `search_precedents`, `query_history`, `read_attachment`, `propose_resolution`, `ask_question`, `escalate`, `propose_policy`, `write_handoff`. It runs on `claude-opus-5-5` at `high` effort by default, with `claude-sonnet-5-5` as the fallback model if Opus is unavailable; `FINANCE_WORLD_SEAT_MODEL`, `FINANCE_WORLD_SEAT_EFFORT` and `FINANCE_WORLD_SEAT_FALLBACK_MODEL` change that, and the Work view shows which model is on duty. The thirteen older scenario families keep the general-purpose agent described below.

### Proof it works

The benchmark is a planted month of 14 bank lines with an answer key ([`PLANTED`](src/cash-application.ts)). Dana (AR lead) and the controller are simulated colleagues. They decide from the answer key, and Gemini Argon phrases their replies ([`src/colleague.ts`](src/colleague.ts)). Precision of automation is the share of applications posted without a person that match the answer key.

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

Reproduce the results with `bun run bench:baseline` (no model calls) and `bun run bench:cash` (live: calls Anthropic, and Vertex AI when Argon is configured). The reports are in [`evidence/`](evidence/readme.md).

The answer key is open to the judge. `record_case_expectation` attaches an expected outcome, forbidden moves, an auto-post allowance and what the AR lead knows to any bank line the controller records. The seat works the line unseen, the simulated colleague answers from the judge's truth, and the score reports those lines as a separate `judge` set. That is the brief's "we may ask you to try a scenario of our own", scored. Run once live (see the evidence list below): on an unseen $50-short wire the seat checked the history for comparable gaps, found the $50 fell in a range the company had never handled, chose a short-pay notice over a write-off, stated 0.85 confidence, and waited for a person.

The score also counts what must not happen. Three answer-key cases carry `forbid` lists, the machine-readable half of what the responsible person knows: the late discount must not be booked as a discount or a fee, the unexplained short-pay must not be written off, and the duplicate payment must not be applied to the customer's other open invoice. Every proposal an item received is checked against them, so a forbidden move is counted even when a person caught it. The summary reports `forbidden_proposals`, `should_not_auto_posted` (a line that needed a person but posted under policy) and `missed_auto` (a line that should have posted alone but needed a person), overall and per case set.

Two things a finance team needs are consistency and knowing which parts of the harness do the work:

- `bun run bench:cash --trials=5` repeats the month and writes a `-trials.json` summary with pass^k: whether precision held at 100%, nothing posted without a person that should not have, and no forbidden move was proposed, on every trial rather than the best one.
- `bun run bench:cash --ablate=trust-agent | no-backtest | no-history` removes one component at a time, the method Anthropic describes for finding which harness parts are load-bearing: trust the agent's stated confidence instead of the gateway's evidence check, approve every policy without reading the backtest, or import no history to learn from. Ablations are switched on through `seat_configure` for the benchmark company only and are visible in its summary.

### Try it

1. `bun run start`, open http://127.0.0.1:24300, then **New company → Cash application**.
2. In **Work**, connect the bank, NetSuite and Gmail (three consent screens), then switch **On duty**. The seat onboards first: it queries the history and proposes policies. Approve or reject them under **Policies**; a rejection needs a reason.
3. Under **Bank feed**, choose **Advance to the next sync**. Four lines arrive and the seat starts by itself. Anything covered by policy posts.
4. At the next sync, Summit's late discount and Pine & Post's short-pay wait under **Needs you**. Reject one with a reason and watch the seat revise it.
5. Under **Bank feed → Record a bank line**, enter your own case, such as a $60-short wire from Harborview, and see what the seat does with it. Open **Answer key (optional)** to say what the right outcome is, which moves the seat must never propose, whether the line may post alone, and what the AR lead knows. The seat never sees the key; with simulated colleagues on, Dana answers from it. **Score now** then reports your lines as judge scenarios, separately from the planted month.
6. Under **Why?**, enter `INV-2003` to see the sync, the proposal, the policy approval with its confidence, and the posting.
7. **Autonomy and people → Simulated colleagues** lets the month run unattended.

### Slack

Hyphenate's own product chases approvals in Slack, and a finance team lives there. gram posts to a channel over Socket Mode, so no public URL is needed, for whichever seat is on duty: the tour settlements seat posts in Australian dollars and asks Priya Nair (Tour Accountant) and Marcus Hale (Touring Finance Director), both simulated people in real roles; the cash seat posts in dollars to the AR lead and the controller. gram stays the system of work: every card is drawn from its state, and every click goes through the same work command and role check as the console.

The channel reads like a team, not a log:

- **One message for the rules it learned.** After onboarding, the seat posts the policies it drew from last season as one numbered list with each backtest on its line, and the controller approves them in one click (each policy is still decided and logged on its own). A rule proposed later is one short card with Approve and Reject.
- **Three lines for a proposal.** The record, what it proposes, and what it needs a person for. Approve asks for confirmation; Reject opens a form that requires a reason, and the seat reads that reason.
- **One line for a question.** A reply in the thread answers it, or a button answers with one of the seat's options.
- **People speak in the thread.** When a person decides, their reason is posted under their name in the card's thread. A simulated colleague posts as herself, marked simulated; a Slack user is quoted; the console is "in gram".
- **"@gram why SH-3004?"** A mention, or a DM, is answered in the thread from the append-only log: every transition on that record with who, what, the policy and confidence, and the reason, with blocked attempts marked. Nothing in it is generated by a model; it is the same query the console's **Why?** runs. "@gram status" returns the briefing.
- **Nothing else.** Handoffs stay in gram. Work that posted under policy never reaches Slack. Unmapped Slack users and clicks on out-of-date cards are refused, and the refusal is audited.

Each simulated role is its own switch under **Autonomy and people**, so one seat can work with a real accountant and a simulated director, or the reverse.

Setup:

1. Create the app from [`docs/slack-app-manifest.yaml`](docs/slack-app-manifest.yaml) and install it to your workspace.
2. Under **Basic Information → App-Level Tokens**, generate a token with `connections:write`. The bot joins the bound channel itself (`channels:join`); `/invite @gram` also works.
3. Put `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID` and the role lists `SLACK_ACCOUNTANTS` and `SLACK_CONTROLLERS` (Slack user IDs) in `.env`. A controller can also answer and approve, so one person can be mapped as the controller alone.
4. Turn on **Work → Autonomy and people → Ask and approve in Slack**.

The console works the same without Slack; use it as the fallback for a live demo.

## Run locally

Requires Bun 1.4.2 or newer. From a checkout of this repository:

```sh
bun install --frozen-lockfile
cp .env.example .env    # optional: add keys for live agent runs and generation
bun run check
bun test
bun run start
```

Open http://127.0.0.1:24300 using that exact host. The listener binds to `127.0.0.1`, and the service checks request origins and hosts. `bun run start` builds the UI before starting the service. `bun run dev` builds once and enables Bun's server file watcher; after changing `web/`, run `bun run build` and reload the browser. Stop with Ctrl+C; world state survives restart. The service marks an interrupted agent run as interrupted, retains its recorded effects, and permits a fresh run to inspect them.

Request routing uses the published [`emulate`](https://www.npmjs.com/package/emulate) package, pinned to 0.12.2. [`src/server.ts`](src/server.ts) registers gram as an Emulate custom service with Emulate's listener and inspector disabled. Bun owns the HTTP listener and SQLite connection.

### DialKit workspace

Each company is a separate **space** with its own open views, record tabs, drafts, favorites, and saved searches. Select a company in the sidebar to restore its workspace. **Overview**, **Inbox**, **Files**, **Finance**, **Procurement**, and **Favorites** are primary views; the folded **Tools** group contains **Connections**, **Sources**, **Agent**, **Delivery**, and **Audit**. **New company** and **Settings** are available in the sidebar dock.

Views and records open in persistent tabs. A tab's menu supports pin/unpin, **Split right**, **Split below**, moving to another pane, closing, and reopening the most recently closed tab. The workbench supports at most **three columns and two rows per column**; dividers resize panes. Tabs can also be reordered or moved by dragging. On narrow screens, the active pane fills the workbench while the sidebar and assistant open as overlays.

[`web/workspace.js`](web/workspace.js) stores layout, active tabs, text drafts, favorites, saved searches, appearance settings, and up to 20 closed tabs per company in versioned browser local storage. Record tabs retain references to server records; the database remains the source of financial state. Selected attachment files are held only in memory and must be selected again after a reload. This browser state is local to the current browser and origin.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+K` | Search the current company's records and views; save a query for later. |
| `Alt+N` | Open a new tab. |
| `Alt+W` | Close the active tab. |
| `Cmd/Ctrl+Shift+T` | Reopen the last closed tab. |
| `Alt+B` | Toggle the sidebar. |

The assistant toggle opens a resizable **Agent** drawer with a fixed header and composer around one scrolling response. Responses render Markdown as semantic text; the task preview opens the original instruction, and **Run history** opens a separate list. **Open full response** moves the selected run into a record tab. Reading positions survive view changes. Its task composer starts the real Anthropic agent; opening the drawer or editing a draft does not execute financial work. The **Agent** view exposes the same underlying service.

Agent activity uses the actual [`thinking-orbs` 0.3.2 engine](https://libraries.dev/orbs) by [Jakub Antalik](https://github.com/Jakubantalik/Libraries.dev), under its MIT license. The vanilla adapter imports the engine without a React runtime. Recorded run progress selects connecting, reading, working, or composing motion; failures and terminal states retain explicit labels. Terminal orbs pause, elapsed time uses stored timestamps, and reduced motion, hidden tabs, and offscreen indicators stop animation. Status polling continues while the task draft has focus. **Stop** requests cancellation; the indicator changes to **Stopped** only after the service records that outcome.

Audit opens recent activity in a keyboard-navigable tree beside a scrolling event reader. Dotted branches connect explicit request, run, and delivery IDs; single-event requests open directly. **Activity**, **All events**, and **Attention** filter the stored log before pagination, and search includes older events. **Load older** retains a stable snapshot and reading position. Event tabs resolve durable sequence IDs after reload. Narrow panes switch between the tree and reader with **Back to events**. The hierarchy and adjacent reader draw on [Langfuse's trace view](https://langfuse.com/changelog/2025-03-19-new-trace-view) and [Primer's tree navigation](https://primer.style/product/components/tree-view/).

Sidebar and assistant dividers support arrow keys in 8-pixel steps, Shift for 24 pixels, Home/End for their limits, and double-click to reset. Sidebar width stays synchronized with Settings. Pointer resizing saves once at the end of a gesture, including cancellation or focus loss.

Below 1360 pixels the assistant floats over the workbench, preserving its chosen width. Between 800 and 1015 pixels, opening it temporarily hides navigation; reopening navigation closes the assistant. Saved widths and the sidebar preference remain available when the drawer closes or the window grows.

The shell adapts the neutral surfaces, compact sidebar, tabs, split panes, search launcher, and assistant placement of [Define's demo](https://demo.define.app/). Mapping a company to a space and persisting real favorites and saved searches are gram decisions. The reviewed Define demo does not establish a persistent spaces model, and its assistant uses scripted responses. No Define code or assets are included.

[`web/app.js`](web/app.js) imports native `Folder`, `TextControl`, `SelectControl`, `ButtonGroup`, `Slider`, and `Toggle` components from `dialkit/vanilla` with DialKit's stylesheet. These controls serve the workbench, record inspection, financial forms, procurement, feedback, and OAuth consent; saved fields are read-only. [`web/style.css`](web/style.css) supplies the shell geometry, neutral theme, component styling, and responsive behavior. Secondary context and technical details stay in folded groups or record tabs.

[`src/build-ui.ts`](src/build-ui.ts) bundles the package and application through `Bun.build` into ignored `web/dist/` assets. The service serves that bundle for both the main console and connection consent. Bun runs everything: `Bun.serve` and `Bun.file` for HTTP and static files, `bun:sqlite` for state, `Bun.CryptoHasher` and Web Crypto for hashes, HMAC signatures and identifiers, `Bun.build` for the UI, and `bun:test` with `expect` for the suite. `node:fs`, `node:path`, and `node:os` remain only for directories, permissions, temporary folders, and the synchronous key-file read, which have no Bun-native equivalent. The Agent SDK is configured with `executable: 'bun'`; the installed SDK also ships its platform-native Claude CLI.

### Configuration

| Setting | Behavior |
|---|---|
| `ANTHROPIC_API_KEY` | Enables live agent runs and scenario generation. The process environment takes precedence. |
| Project `.env` | If the environment key is absent, the loader reads `.env` in the repository root; [`.env.example`](.env.example) lists the keys. It reads the key without exposing it to the console. [`bunfig.toml`](bunfig.toml) turns off Bun's automatic `.env` loading, so keys never enter `process.env` for the service or the test suite. |
| `FINANCE_WORLD_ENV_FILE` | Overrides the key-file location. |
| `FINANCE_WORLD_MODEL` | Overrides the default model for the general-purpose agent and scenario generation, `claude-sonnet-5-5`. |
| `FINANCE_WORLD_SEAT_MODEL`, `FINANCE_WORLD_SEAT_EFFORT`, `FINANCE_WORLD_SEAT_FALLBACK_MODEL` | The cash-application seat's model (`claude-opus-5-5`), its effort level (`high`; `low`, `medium`, `xhigh` or `max` are accepted) and the model the SDK falls back to if the primary is unavailable (`claude-sonnet-5-5`). Each run records the models that actually answered. |
| `GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT` | Enable the default world generator, `gemini-4-argon` on Vertex AI (`global`). The process environment takes precedence over the key file. Without both, generation uses Claude. |
| `FINANCE_WORLD_ARGON_PRICING` | Optional JSON with verified `inputUsdPerMillion`, `cachedInputUsdPerMillion`, `outputUsdPerMillion`, and `source`. Without it, Argon token usage is recorded and its dollar cost is reported as unknown. Invalid pricing disables Argon. |
| `FINANCE_WORLD_PORT` | Defaults to `24300`. |
| `FINANCE_WORLD_DB` | Defaults to `data/worlds.sqlite`; use a separate file for an isolated environment. |
| `FINANCE_WORLD_WEBHOOK_PORTS` | Comma-separated additional local callback ports. The service port is allowed by default; callbacks require literal `http://127.0.0.1:PORT/…`. |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID` | Optional Slack for the cash-application seat ([manifest](docs/slack-app-manifest.yaml)). The bot token is `xoxb-`, and the app-level token is `xapp-` with `connections:write` for Socket Mode. Tokens are read the same way as the other keys and never reach the console or the model. |
| `SLACK_ACCOUNTANTS`, `SLACK_CONTROLLERS`, `SLACK_TEAM_ID` | Comma-separated Slack user IDs allowed to act as the AR lead (answer, approve, reject) or the controller (also decide policy). Everyone else is refused and audited. `SLACK_TEAM_ID` pins the workspace. |

The fixed SDK limits are **30 turns, $2, and five minutes per agent run**. Cash-application seat runs allow **40 turns, $3 and eight minutes** for onboarding and **30 turns, $2 and six minutes** for a shift. The dispatcher starts at most one run per company at a time and at most 12 an hour. An item that two runs left untouched stops relaunching the seat until something about it changes. Claude scenario generation allows **six turns, $0.50, and five minutes**. Argon generation runs two stages, the configuration and then source-grounded documents and email; each request times out after two minutes and retries at most twice. A rejected Argon request fails explicitly, and no other model or draft is substituted. These are invocation limits, not a promise that any task will finish within them. The console shows availability without returning credentials. Without an Anthropic key, scenario templates, controller actions, OAuth, records, mailbox, and audit still work; live model operations return an explicit unavailable error.


## Validation

`bun run check` and `bun test` pass: 733 tests across 95 files, none of which call a model. Live runs are kept as recorded in [`evidence/`](evidence/readme.md): every live run of either seat has posted nothing without a person that the answer key disagrees with, and the lines it needed a person for are listed, not hidden. The older simulations, their HTTP API and their evidence are described in [`docs/platform.md`](docs/platform.md).

## Current boundaries

This is a working local simulation service, not a production financial platform or a complete replica of every enterprise integration. Functional books use USD and a compact fixed chart of accounts; native EUR, GBP, JPY, and KWD balances exist only in the treasury and foreign-service families. Rules include a fixed ticket-refund policy, bounded scenario families, and simplified one-hour settlements. The generator produces supported configurations and documents unsupported requests; it does not synthesize new executable vendor integrations.

State and local payroll tax, supplemental wages, pretax deductions, the FUTA credit, payroll tax filing, overtime rules, garnishments, salary proration, tax depreciation, multi-warehouse inventory, fractional stock units, supplier physical returns, foreign inventory purchasing, withholding tax, direct foreign-to-foreign conversion, bank-activity reversals, actual bank rail return windows, wire or card supplier payments, PDF/image text extraction, production OAuth federation, internet webhook/email delivery, production tenant IAM, and complete vendor parity are not implemented. Payroll (including 2026 federal regular wages), bank reconciliation, procurement, inventory, foreign currency, fixed assets, manual journals, supplier payment routes, ticket sources, credit notes, disputes, bank returns, MIME mail, and loopback webhooks have the bounded contracts described above. Names and normalized feeds for adjacent products are not evidence that additional workflows exist. No email is sent to an internet mailbox, and no simulated operation moves real money. Business source content is treated as evidence, never as authority to override the agent's role or the controller boundary.

### The cash-application seat

- **Scope.** One seat in one company. The thirteen older families still use the general agent and the controller's approval flow, and their approvals now record a reason.
- **Simulated colleagues** decide from the answer key and are marked `sim:` everywhere they act. They are for practice and the benchmark, not a substitute for people. Argon only phrases their replies.
- **Policy kinds** are a fixed set the gateway can check: exact match, multi-invoice split, payer alias, wire fee write-off, early-payment discount, keg-deposit netting and deduction codes. The seat cannot invent a new kind; anything else waits for a person.
- **Confidence** is a product of evidence factors, not a calibrated probability. It decides only whether a person must look; the hard checks decide what is possible at all.
- **Bound headroom** is reported for the two rule kinds with a monetary bound (fee write-offs and deduction caps). The real controller decides; only the simulated controller applies the 10% limit.
- **Ablations** (`trust_agent_confidence`, `skip_backtest`, `cashControls.history:false`) exist to measure the harness in the benchmark. They are controller settings on one company, logged like any other change, and nothing in the console turns them on.
- **The planted month has been run to saturation**, so its scores show precision and consistency, not generalization. The held-out test is a judge's own bank line with an answer key attached (`record_case_expectation`, or the **Answer key** form); those lines are scored as the `judge` set and never enter the seat's context. `bun run bench:cash --judge-case=cases.json` runs one, or a whole set, from a file.
- **Refunds.** Customer refunds of held cash are not implemented. Duplicate or unplaced cash stays on account until a person resolves it outside gram.
- **Slack** needs tokens from your own workspace. The integration is tested against a recorded Slack transport, not against Slack itself, and should run as one instance per app.

## License

gram is released under the [MIT License](LICENSE). Dependencies keep their own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

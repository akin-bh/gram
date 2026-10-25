# gram

**Your AI finance officer.** gram fills one finance seat at a time at a real company. The seat reads the bank, learns the job from the company's own history, proposes every move with evidence and a confidence it must justify, and asks a person at exactly the right moment. It never approves, posts or moves money itself: people approve, a gateway posts, and every step lands in an append-only log that can answer "why?" months later.

Built at **Cal Hacks 13.0** for the Hyphenate track. Four companies run on one system of work, and every live run is kept as recorded in [`evidence/`](evidence/readme.md).

![The Work view: the seat, its status, and what waits on a person](docs/gram-work.png)

## Tracks

| Track | Why gram qualifies |
|---|---|
| **[Hyphenate] The Hyphenated Enterprise: Autonomous Systems for Finance** | The whole project: an autonomous finance seat that learns policies from history, backtests every rule before a person approves it, posts only under approved policy and confidence, handles rejection, and leaves a hash-chained audit trail. Scored live: **100% precision of automation on every recorded run**. |
| **[Anthropic] Claude for Public Benefit** | Claude Opus 5.5 through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) fills the finance seat of the hackathon itself — the Cal Hacks Foundation, a registered 501(c)(3): sponsor payments applied, prize funds kept out of income for the winners, the IRS $600 W-9 rule enforced in code. Live season: **14/14 correct, 100% precision, $2.50 for the season**. The same system fits any nonprofit's finance desk. |
| **[Capital One] Best Use of Nessie** | The **Festival Finance Operations Officer** seat is built on Nessie's shapes — customers, accounts, merchants, deposits, withdrawals, bills — with a client for the live API ([`src/nessie-api.ts`](src/nessie-api.ts)): set `NESSIE_API_KEY` and it creates the festival's customer and accounts and syncs the world's transactions to api.nessieisreal.com. |
| **[MLH] Best Use of Gemini API** | Gemini (`gemini-4-argon` on Vertex AI) generates new company worlds from a prompt and voices the simulated colleagues: real people's decisions come from the answer key, Gemini phrases their replies ([`src/colleague.ts`](src/colleague.ts), [`src/generator.ts`](src/generator.ts)). |

## The four companies

| Company | Seat | What makes it hard |
|---|---|---|
| **Cal Hacks 13.0** — the hackathon the judges are sitting in, run by a real 501(c)(3) | Sponsorship & Payments Officer | A wire $35 short, one wire paying a fee plus a $16,000 prize fund, deferred revenue until the event happens, an $8,000 prize held for a missing W-9 |
| **Live Nation Concerts** — the company's own US job posting, [JR-93290 Settlement Manager](https://livenation.wd503.myworkdayjobs.com/en-US/LNExternalSite/job/LN-Concerts--Settlement-Manager_JR-93290) | Settlement Manager (recording side) | Venue settlements against ticket audits, advance recoupment, a CAD show, revenue recognized only on the day of the show — Live Nation's own 10-K rules |
| **Summer Music Festival** — festival finance on Capital One's Nessie API | Festival Finance Operations Officer | Gate receipts vs. ticket deposits, an unknown offshore vendor, an unscheduled $8,000 withdrawal, duplicate and over-limit bills |
| **Kestrel Brewing** — a synthetic brewery, gram's first seat | Cash application | Short wires, parent-company payers, keg deposits, late discounts, a deduction code nobody has seen before |

Each seat's full story, planted season and code map: [Cal Hacks](#the-cal-hacks-seat) · [Live Nation](#the-live-nation-seat) · [Nessie](#the-festival-finance-seat-capital-one-nessie) · [cash application](docs/cash-application.md).

## Proof it works

Every seat is scored against a planted season with an answer key the seat never sees. Simulated colleagues decide from the key; Gemini phrases their replies. **Precision of automation** = of what posted without a person, how much matched the key.

| Live run | Precision of automation | Correct in the end | Deferred when unsure | Forbidden moves | Cost |
|---|---|---|---|---|---|
| Cal Hacks seat, Opus 5.5 | **100%** (8/8 posted alone) | 14/14 | 4/4, asked first in 3 | 0 | $2.50/season |
| Cash seat, Opus 5.5 at high effort | **100%** (7/7) | 14/14 | 4/4, asked first in 4 | 0 | $1.72/month |
| Cash seat, Sonnet 5.5 (two runs) | **100%** (8/8 and 7/7) | 14/14 | 4/4 | — | $0.63–0.76 |

The judge can plant their own case: record a bank line with an **Answer key** the seat never sees, and the score reports it as a separate `judge` set. `bun run bench:cash --trials=5` checks consistency (pass^k), and `--ablate` removes one harness component at a time to show which parts are load-bearing. Full tables, run narratives and reproduction commands: [`docs/cash-application.md`](docs/cash-application.md) and [`evidence/`](evidence/readme.md).

## Why it can be trusted

Limits live in code, not in the prompt ([`src/work.ts`](src/work.ts)):

- **Roles.** Whoever proposes cannot approve. The seat cannot approve, post, move money, change policy or change time — those verbs do not exist in its tools.
- **Policies are earned.** The seat learns rules from history through read-only SQL; the gateway backtests every rule and shows the controller the supporting and contrary cases, and a monetary bound's headroom, before approval.
- **Confidence gates, hard checks decide.** Below 90% or outside policy waits for a person. Nothing can apply more cash than arrived or touch a paid invoice, whatever the model says.
- **A no is final.** A rejected proposal cannot be re-proposed in different words (`repeat_proposal`); stalled items are escalated to a person; reversals mirror the journal and never delete.
- **Everything is audited.** A hash-chained, append-only log; denied attempts included. **Why?** on any record replays who did what, under which policy, with what confidence, and why.
- **Connections gate the seat.** Revoke the bank connection (one click) and the seat can neither read nor be launched; the attempt is audited.

## Run it

Requires [Bun](https://bun.sh) 1.4.2+.

```sh
bun install --frozen-lockfile
cp .env.example .env    # optional: keys for live agent runs and generation
bun run fava:setup      # optional: Fava for the Books view
bun run start           # builds the UI, serves http://127.0.0.1:24300
```

Then **New company**, pick a seat, connect its systems (real OAuth consent screens, local), switch **On duty**, and approve the rules it proposes. The three-minute demo script with the exact beats is [`docs/judging.md`](docs/judging.md). `bun run check && bun test`: 747 tests across 97 files, none calling a model.

## What is real and what is simulated

| | What it is | Status |
|---|---|---|
| The seat | A Claude Agent SDK run with ten tools that are CRUD on the work; it cannot approve, post or move money | **Real**: live model calls |
| The system of work | Work items, policies, precedents, confidence, the gateway, the append-only log | **Real**: this repository |
| Slack | The channel where the seat asks, people decide, and "@gram why" is answered | **Real**: your workspace, over Socket Mode |
| Bank, ledger, inbox | The feed, the journals, the mailbox the seat reads and the gateway writes | **Simulated** in-process, provider-shaped, behind a local OAuth server; no vendor sandbox |
| Live Nation Concerts | The company, its US posting, its 10-K accounting and festivals, the BMI rate-court rate, city and state ticket taxes, Ticketmaster's terms | **Real and quoted** ([`docs/live-nation-sources.md`](docs/live-nation-sources.md)); venues, deal terms, deposits, people and the past season are **simulated and labeled** |
| Cal Hacks 13.0 | The hackathon, run by the Cal Hacks Foundation, a registered 501(c)(3), in California Memorial Stadium; the public prize pools; the IRS $600 prize rule; Stripe's card pricing | **Real and cited** ([`docs/calhacks-sources.md`](docs/calhacks-sources.md)); sponsors, vendors, teams, tier amounts, limits and people are **simulated and labeled** |
| Capital One Nessie | The hackathon banking API behind the festival seat, with a client for the live API | **Real API client** ([`src/nessie-api.ts`](src/nessie-api.ts)); the festival, its vendors and its transactions are **simulated and labeled** |
| Colleagues | The AR lead, Tour Accountant, controller and directors the seat asks | **Simulated**, each on its own switch; a mapped Slack user takes any role |

No planted mistake is presented as something a real company did.

## The Cal Hacks seat

**Cal Hacks 13.0** is run by the Cal Hacks Foundation, a registered 501(c)(3), as a 36-hour hackathon in California Memorial Stadium on October 23–25, 2026. gram fills its **Sponsorship & Payments Officer** seat: the organizer who applies every sponsor payment to the invoice it pays, keeps the prize money sponsors underwrite out of income (it is owed to the winners), recognizes sponsorship fees as income only once the event has happened, and checks every bill, prize payout and reimbursement against its approver's limit, its document, duplicates and the W-9 rule before anyone pays it. Sources, estimates and labels are in [`docs/calhacks-sources.md`](docs/calhacks-sources.md).

| The job | What gram does | In code |
|---|---|---|
| Sponsor money in | A Gold fee paid exactly; a Platinum wire $35 short; one wire for a Silver fee and a $16,000 track prize fund; a holding company paying for its subsidiary; a card payment net of Stripe's 2.9% + 30¢; a sponsor that pays its fee but not the prize fund; a Zelle payment with no memo | `src/calhacks.ts` `normalizeResolution`, `wire_fee_bound`, `card_fee_rate`, `payer_alias` |
| Whose money it is | A fee received before the event is deferred; a prize fund is owed to the winners and is never income, enforced in code | `recognition_before_event`, `prize_fund_is_not_income` |
| The event ends | A work item appears on October 25: the seat recognizes every paid fee as income under an approved policy; a sponsor that pays after the event is recognized at once | `event_close`, `recognize_on_event` |
| Money out | A $4,200 catering bill approved by someone whose limit is $2,500 is routed up; a duplicate A/V bill is refused; an $8,000 first prize with no W-9 is held (prizes of $600 or more are reportable to the IRS); a $3,000 prize with its W-9 and a $180 reimbursement post alone | `approval_limit_exceeded`, `possible_duplicate`, `tax_form_missing`, `payment_within_limit` |

The seat learns its rules from last year's books (about 20 sponsor payments and 34 payment requests with the decisions people made) through read-only SQL, and every rule is backtested before Jordan Lee (Sponsorship Lead) or Ana Reyes (Director of Finance), both simulated people in real roles, sees it. **Live proof** ([`evidence/calhacks-bench-live-seed42.json`](evidence/calhacks-bench-live-seed42.json.gz), a `claude-opus-5-5` seat): 14 of 14 planted records posted correctly; 8 of 8 posted without a person matched the key; all 4 unclear cases went to a person; no forbidden proposal; 8 policies learned and kept; $2.50 for the season.

Try it: **New company → Seat · Cal Hacks 13.0 sponsorship and payments**, connect the bank and QuickBooks, switch **On duty**, approve the rules, then **Advance to the next sync** through October. A judge's own sponsor payment goes in under **Bank feed → Record a sponsor payment**.

## The Live Nation seat

**Live Nation Concerts** is the concert promotion division of Live Nation Entertainment: about 55,000 events and 131 festivals worldwide in 2025 ([`docs/live-nation-sources.md`](docs/live-nation-sources.md) says which figure is a filing, a results release or a press report). gram fills the seat the company is hiring for in Philadelphia, [JR-93290, LN Concerts Settlement Manager](https://livenation.wd503.myworkdayjobs.com/en-US/LNExternalSite/job/LN-Concerts--Settlement-Manager_JR-93290), on its recording side. The planted month is a North American arena run — Chicago, Austin, Las Vegas, and a Toronto date that settles in Canadian dollars.

| The sources say | What gram does | Code |
|---|---|---|
| "owning the show documentation and financial completion of shows … record all revenue, expenses, payment advances, and monies due" (JR-93290) | Each venue deposit becomes a work item. The seat allocates it to the show settlements it pays, codes every statement line to the ledger, and the gateway posts one journal per settlement. | `src/tour-settlements.ts` `normalizeTourResolution`, `postTour` |
| "Check invoice operational approvals are compliant with approval limits before approving" (JR-93271) | Approval is a hard check in code: the approver's limit and category must cover the invoice, its document must be filed, and it must not duplicate another. Otherwise a person decides. | `approval_limit_exceeded`, `document_missing`, `possible_duplicate` |
| "Over 97% of Concerts' revenue … is recognized on the day of the related event" (10-K) | Ticket money sits in deferred revenue from the sale. A postponed show's deposit is allocated and its revenue stays deferred, enforced in code. | `recognition_before_performance` |
| "Recoupable ticketing contract advances … recoupable against future royalties" (10-K) | An advance recouped on a settlement reduces the liability; it is never a shortfall and never an expense. | `advance_recoupment` |
| "Must be able to read and interpret ticket audits" (JR-93290) | The ticket audit is the gross. A statement below it is coded as stated and the difference is chased from the venue, never written off. | `gross_below_ticket_audit` |
| "the reasonable rate is set at 0.5% of Gross Ticket Revenues" (BMI v. NACPA, S.D.N.Y. 2023) | The performing-rights fee is computed from a controller-set parameter that cites its source. | `tourParameters.music_licence_bps` |

The planted month: seven shows, ten records, an answer key — four should post without a person, six must not. The seat learns ten policy kinds from a simulated prior season of about forty settlements and sixty invoices, each backtested before the Regional VP of Finance sees it.

Try it (the judging-day path is [`docs/judging.md`](docs/judging.md)): **New company → Seat · Tour settlements (Live Nation Concerts)**, connect the bank and NetSuite, switch **On duty**, approve the policies, then **Advance to the next sync** through the month. **Why?** on `SH-3007` shows the postponed show's deposit allocated and its revenue left deferred.

## The festival finance seat (Capital One Nessie)

A festival finance team — the demo instance ships **Summer Music Festival** — whose **Festival Finance Operations Officer** seat runs on [Capital One's Nessie API](https://api.nessieisreal.com) ([`src/nessie.ts`](src/nessie.ts)). The festival organization is a Nessie customer, its operating and ticket-escrow funds are accounts, vendors are merchants, and every ticket deposit, vendor payment, artist-fee withdrawal and sponsor wire is a transaction in Nessie's shapes. The seat reconciles ticket revenue against expected gate receipts, verifies vendor payments against contracts and the daily vendor limit, and holds anything that does not add up — an unknown vendor, an unscheduled $8,000 withdrawal, a duplicate invoice, a bill over its approver's limit — for a person before a cent moves.

A planted season of 14 cases carries an answer key, and the seat learns its rules from twelve months of imported festival history at onboarding. With `NESSIE_API_KEY` set, [`src/nessie-api.ts`](src/nessie-api.ts) creates the festival's customer and accounts and syncs the world's transactions to the live API (`setupFestival`, `syncWorldToNessie`); without it, the seat runs on simulated data shaped exactly like Nessie responses, so the demo needs no key and no internet.

Try it: **New company → Festival & events finance (Nessie)**, connect the bank and QuickBooks, switch **On duty**, approve the rules, then advance through the season under **Bank feed**.

## Slack

A finance team lives in Slack, so gram posts there over Socket Mode (no public URL) for whichever seat is on duty. Proposals are three-line cards with Approve and Reject (a rejection requires a reason, and the seat reads it); questions are one line answered in the thread; **"@gram why SH-3004?"** answers from the append-only log, nothing model-generated. Work that posted under policy never reaches Slack. Setup is four `.env` values from [`docs/slack-app-manifest.yaml`](docs/slack-app-manifest.yaml); the console does everything Slack does, as the fallback for a live demo.

## How it is built

- **The seat** is a [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) run ([`src/seat.ts`](src/seat.ts)): a ~600-word prompt and ten CRUD tools, on `claude-opus-5-5` at `high` effort with `claude-sonnet-5-5` as fallback. Fixed limits per run: 30–40 turns, $2–3, five–eight minutes; at most 12 runs per company per hour.
- **The service** is Bun end to end: `Bun.serve`, `bun:sqlite` (WAL, hash-chained audit), `Bun.build` for the UI, `bun:test` for the 747-test suite. Request routing uses the published [`emulate`](https://www.npmjs.com/package/emulate) package. Simulated providers sit behind a real local OAuth 2.0 server (authorization code + PKCE).
- **The console** is a DialKit workspace: spaces per company, split panes, a live agent drawer, and an audit tree. Labels lead with plain English and keep the accounting term in parentheses — *Money in (payments)*, *Bank matching (reconciliation)*. Full detail: [`docs/console.md`](docs/console.md).
- **The books** are a read-only [Beancount](https://github.com/beancount/beancount) ledger served in [Fava](https://github.com/beancount/fava) behind the session — balance sheet, income statement, queries — rewritten after every posting, with each transaction linked to its work item and tagged `#posted-under-policy` or `#approved-by-person`. Detail: [`docs/console.md`](docs/console.md#books-in-fava).
- **Generation**: new company worlds come from Gemini Argon on Vertex AI (source-grounded documents and mail), with Claude as the fallback generator.

## Configuration

| Setting | Behavior |
|---|---|
| `ANTHROPIC_API_KEY` | Enables live agent runs and scenario generation. Read from the environment or `.env` without ever reaching the console or the model. |
| `FINANCE_WORLD_SEAT_MODEL`, `FINANCE_WORLD_SEAT_EFFORT`, `FINANCE_WORLD_SEAT_FALLBACK_MODEL` | The seat's model (`claude-opus-5-5`), effort (`high`) and fallback (`claude-sonnet-5-5`). Each run records the models that actually answered. |
| `FINANCE_WORLD_MODEL` | The general-purpose agent and generation default, `claude-sonnet-5-5`. |
| `GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT` | Enable the Gemini Argon world generator on Vertex AI. Without both, generation uses Claude. |
| `NESSIE_API_KEY` | Enables pushes to Capital One's live Nessie API through [`src/nessie-api.ts`](src/nessie-api.ts). Without it, the festival seat runs on simulated Nessie-shaped data. |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_ACCOUNTANTS`, `SLACK_CONTROLLERS` | Optional Slack over Socket Mode; user-ID lists decide who may act in each role, everyone else is refused and audited. |
| `FINANCE_WORLD_PORT`, `FINANCE_WORLD_DB` | Port (24300) and SQLite file (`data/worlds.sqlite`). |
| `FINANCE_WORLD_SEAT_RUNS_PER_HOUR` | Seat runs per company per hour (12); a demo that replays a month quickly sets it higher. |
| `FINANCE_WORLD_FAVA_PYTHON`, `FINANCE_WORLD_FAVA`, `FINANCE_WORLD_FAVA_SOCKET` | Fava's Python, `off` switch, and Unix socket. |
| `FINANCE_WORLD_ARGON_PRICING`, `FINANCE_WORLD_ENV_FILE`, `FINANCE_WORLD_WEBHOOK_PORTS` | Argon pricing for cost reports, key-file location, extra local webhook ports. |

Without an Anthropic key, everything but live model runs still works: scenarios, controller actions, OAuth, records, mailbox, audit.

## Honest limits

This is a working local simulation service, not a production financial platform. The banks, ledgers and inboxes are provider-shaped simulations behind a local OAuth server, not vendor sandboxes; no email leaves the machine and no simulated operation moves real money. The planted seasons have been run to saturation, so their scores show precision and consistency, not generalization — the held-out test is the judge's own scenario with an answer key. Confidence is an evidence product, not a calibrated probability; the hard checks decide what is possible at all. Per-seat boundaries: [`docs/cash-application.md`](docs/cash-application.md#boundaries-of-this-seat); the full platform scope and the thirteen older simulation families: [`docs/platform.md`](docs/platform.md).

## License

gram is released under the [MIT License](LICENSE). Dependencies keep their own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

# The four seats in detail

The readme keeps the short version. This page holds each company's full story: what the job is, what is planted, and where it lives in the code. What is real vs. simulated is cited in [`calhacks-sources.md`](calhacks-sources.md) and [`live-nation-sources.md`](live-nation-sources.md).

## The Cal Hacks seat

**Cal Hacks 13.0** is run by the Cal Hacks Foundation, a registered 501(c)(3), as a 36-hour hackathon in California Memorial Stadium on October 23–25, 2026. gram fills its **Sponsorship & Payments Officer** seat: the organizer who applies every sponsor payment to the invoice it pays, keeps the prize money sponsors underwrite out of income (it is owed to the winners), recognizes sponsorship fees as income only once the event has happened, and checks every bill, prize payout and reimbursement against its approver's limit, its document, duplicates and the W-9 rule before anyone pays it.

| The job | What gram does | In code |
|---|---|---|
| Sponsor money in | A Gold fee paid exactly; a Platinum wire $35 short; one wire for a Silver fee and a $16,000 track prize fund; a holding company paying for its subsidiary; a card payment net of Stripe's 2.9% + 30¢; a sponsor that pays its fee but not the prize fund; a Zelle payment with no memo | `src/calhacks.ts` `normalizeResolution`, `wire_fee_bound`, `card_fee_rate`, `payer_alias` |
| Whose money it is | A fee received before the event is deferred; a prize fund is owed to the winners and is never income, enforced in code | `recognition_before_event`, `prize_fund_is_not_income` |
| The event ends | A work item appears on October 25: the seat recognizes every paid fee as income under an approved policy; a sponsor that pays after the event is recognized at once | `event_close`, `recognize_on_event` |
| Money out | A $4,200 catering bill approved by someone whose limit is $2,500 is routed up; a duplicate A/V bill is refused; an $8,000 first prize with no W-9 is held (prizes of $600 or more are reportable to the IRS); a $3,000 prize with its W-9 and a $180 reimbursement post alone | `approval_limit_exceeded`, `possible_duplicate`, `tax_form_missing`, `payment_within_limit` |

The seat learns its rules from last year's books (about 20 sponsor payments and 34 payment requests with the decisions people made) through read-only SQL, and every rule is backtested before Jordan Lee (Sponsorship Lead) or Ana Reyes (Director of Finance), both simulated people in real roles, sees it. **Live proof** ([`../evidence/calhacks-bench-live-seed42.json`](../evidence/calhacks-bench-live-seed42.json.gz), a `claude-opus-5-5` seat): 14 of 14 planted records posted correctly; 8 of 8 posted without a person matched the key; all 4 unclear cases went to a person; no forbidden proposal; 8 policies learned and kept; $2.50 for the season.

Try it: **New company → Seat · Cal Hacks 13.0 sponsorship and payments**, connect the bank and QuickBooks, switch **On duty**, approve the rules, then **Advance to the next sync** through October. A judge's own sponsor payment goes in under **Bank feed → Record a sponsor payment**.

## The Live Nation seat

**Live Nation Concerts** is the concert promotion division of Live Nation Entertainment: about 55,000 events and 131 festivals worldwide in 2025 ([`live-nation-sources.md`](live-nation-sources.md) says which figure is a filing, a results release or a press report). gram fills the seat the company is hiring for in Philadelphia, [JR-93290, LN Concerts Settlement Manager](https://livenation.wd503.myworkdayjobs.com/en-US/LNExternalSite/job/LN-Concerts--Settlement-Manager_JR-93290), on its recording side. The planted month is a North American arena run — Chicago, Austin, Las Vegas, and a Toronto date that settles in Canadian dollars.

| The sources say | What gram does | Code |
|---|---|---|
| "owning the show documentation and financial completion of shows … record all revenue, expenses, payment advances, and monies due" (JR-93290) | Each venue deposit becomes a work item. The seat allocates it to the show settlements it pays, codes every statement line to the ledger, and the gateway posts one journal per settlement. | `src/tour-settlements.ts` `normalizeTourResolution`, `postTour` |
| "Check invoice operational approvals are compliant with approval limits before approving" (JR-93271) | Approval is a hard check in code: the approver's limit and category must cover the invoice, its document must be filed, and it must not duplicate another. Otherwise a person decides. | `approval_limit_exceeded`, `document_missing`, `possible_duplicate` |
| "Over 97% of Concerts' revenue … is recognized on the day of the related event" (10-K) | Ticket money sits in deferred revenue from the sale. A postponed show's deposit is allocated and its revenue stays deferred, enforced in code. | `recognition_before_performance` |
| "Recoupable ticketing contract advances … recoupable against future royalties" (10-K) | An advance recouped on a settlement reduces the liability; it is never a shortfall and never an expense. | `advance_recoupment` |
| "Must be able to read and interpret ticket audits" (JR-93290) | The ticket audit is the gross. A statement below it is coded as stated and the difference is chased from the venue, never written off. | `gross_below_ticket_audit` |
| "the reasonable rate is set at 0.5% of Gross Ticket Revenues" (BMI v. NACPA, S.D.N.Y. 2023) | The performing-rights fee is computed from a controller-set parameter that cites its source. | `tourParameters.music_licence_bps` |

The planted month: seven shows, ten records, an answer key — four should post without a person, six must not. The seat learns ten policy kinds from a simulated prior season of about forty settlements and sixty invoices, each backtested before the Regional VP of Finance sees it.

Try it (the judging-day path is [`judging.md`](judging.md)): **New company → Seat · Tour settlements (Live Nation Concerts)**, connect the bank and NetSuite, switch **On duty**, approve the policies, then **Advance to the next sync** through the month. **Why?** on `SH-3007` shows the postponed show's deposit allocated and its revenue left deferred.

## The festival finance seat (Capital One Nessie)

A festival finance team — the demo instance ships **Summer Music Festival** — whose **Festival Finance Operations Officer** seat runs on [Capital One's Nessie API](https://api.nessieisreal.com) ([`../src/nessie.ts`](../src/nessie.ts)). The festival organization is a Nessie customer, its operating and ticket-escrow funds are accounts, vendors are merchants, and every ticket deposit, vendor payment, artist-fee withdrawal and sponsor wire is a transaction in Nessie's shapes. The seat reconciles ticket revenue against expected gate receipts, verifies vendor payments against contracts and the daily vendor limit, and holds anything that does not add up — an unknown vendor, an unscheduled $8,000 withdrawal, a duplicate invoice, a bill over its approver's limit — for a person before a cent moves.

A planted season of 14 cases carries an answer key, and the seat learns its rules from twelve months of imported festival history at onboarding. With `NESSIE_API_KEY` set, [`../src/nessie-api.ts`](../src/nessie-api.ts) creates the festival's customer and accounts and syncs the world's transactions to the live API (`setupFestival`, `syncWorldToNessie`); without it, the seat runs on simulated data shaped exactly like Nessie responses, so the demo needs no key and no internet.

Try it: **New company → Festival & events finance (Nessie)**, connect the bank and QuickBooks, switch **On duty**, approve the rules, then advance through the season under **Bank feed**.

## The cash-application seat

gram's first seat, at Kestrel Brewing, a synthetic regional brewery. Short wires, parent-company payers, keg deposits, late discounts, and a deduction code nobody has seen before. Its full story, the benchmark tables, run narratives and boundaries are in [`cash-application.md`](cash-application.md).

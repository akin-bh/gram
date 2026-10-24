# Judging day

**Who holds what.** Laptop: the gram console, signed in as the controller (the Touring Finance Director's seat). Phone: Slack `#settle`, signed in as the Tour Accountant, a second account mapped in `SLACK_ACCOUNTANTS`; hand it to the judge. Both simulated people off under **Autonomy and people**.

**Start state.** A company that already onboarded: the rules it read from last season approved, Melbourne through Auckland posted, Perth and Adelaide waiting. Boot it with `FINANCE_WORLD_SEAT_RUNS_PER_HOUR=60 FINANCE_WORLD_DB=$PWD/data/demo-tour.sqlite bun run start` (the run-rate guard defaults to 12 an hour, which a rehearsal can use up) (the baked database lives in `data/`, which Git ignores; keep a copy). Slack is bound to `#settle`; `SLACK_CONTROLLERS` is the controller's user id and `SLACK_ACCOUNTANTS` the Tour Accountant's, once that account has joined the workspace.

**Ninety seconds.**

1. **Policies.** The rules the seat drew from last season, each with its backtest and bound. One was wrong and it re-proposed it.
2. **Perth, in Slack.** The venue stated a gross below the ticket audit. The card proposes coding what they stated and chasing the difference. The judge approves on the phone; the gateway posts; the card updates.
3. **Adelaide, in Slack.** The show was postponed. The seat asks whether to recognize revenue. The judge answers "postponed to May"; the seat allocates the deposit and leaves revenue deferred, enforced in code.
4. **"@gram why SH-3007".** The thread answers from the log: sync, question, answer, proposal, approval, posting, journal.

**Their scenario.** Work → Bank feed → **Record a venue deposit**: their payer, amount and memo. Or **Access → bank · Revoke**: the seat can neither read the bank nor be launched, and the attempt is audited.

**The Cal Hacks company.** The same system of work at the event they are sitting in: switch company to **Cal Hacks 13.0**; its Slack channel is `#calhacks` (Live Nation's is `#settle`). The beats are the same shape: the rules it read from last year; a sponsor's wire $35 short posting alone; the event ending on October 25 and every paid fee becoming income under policy; an $8,000 prize held because the team's W-9 is missing (the IRS $600 rule, in code); a catering bill routed up because the Logistics Lead's limit is $2,500. A judge's own case: **Bank feed → Record a sponsor payment**.

**Words on the cards.** *Gross box office*: all the ticket money for a show. *Ticket audit*: Ticketmaster's count of what sold; the truth for gross. *Statement*: the venue's own account of the show: gross, what it deducted, what it sent. *Deposit*: what the venue actually paid into the bank. *Card fee (merchant fee)*: the card-processing cost the venue deducts; the contract caps it. *Music licence*: the fee paid to the songwriters' societies, a percentage of gross. *Recoupment*: the venue taking back an advance it paid earlier; not a shortfall. *Deferred revenue*: ticket money not yet counted as income because the show has not happened, Live Nation's own 10-K rule. *Chase*: ask the venue for money still owed. *Policy*: a rule the seat learned from last season, approved by the Director, that lets it post without asking. *Backtest*: how many of last season's cases agree with a rule, and how many don't.

**If the room's network fails.** Everything in Slack is also in the console under **Needs you**; decide there.

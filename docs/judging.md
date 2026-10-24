# Judging day

**Who holds what.** Laptop: the gram console, signed in as the controller (the Touring Finance Director's seat). Phone: Slack `#settle`, signed in as the Tour Accountant, a second account mapped in `SLACK_ACCOUNTANTS`; hand it to the judge. Both simulated people off under **Autonomy and people**.

**Start state.** A company that already onboarded: the rules it read from last season approved, Melbourne through Auckland posted, Perth and Adelaide waiting. Boot it with `FINANCE_WORLD_DB=$PWD/data/demo-tour.sqlite bun run start` (the baked database lives in `data/`, which Git ignores; keep a copy). Slack is bound to `#settle`; `SLACK_CONTROLLERS` is the controller's user id and `SLACK_ACCOUNTANTS` the Tour Accountant's, once that account has joined the workspace.

**Ninety seconds.**

1. **Policies.** The rules the seat drew from last season, each with its backtest and bound. One was wrong and it re-proposed it.
2. **Perth, in Slack.** The venue stated a gross below the ticket audit. The card proposes coding what they stated and chasing the difference. The judge approves on the phone; the gateway posts; the card updates.
3. **Adelaide, in Slack.** The show was postponed. The seat asks whether to recognize revenue. The judge answers "postponed to May"; the seat allocates the deposit and leaves revenue deferred, enforced in code.
4. **"@gram why SH-3007".** The thread answers from the log: sync, question, answer, proposal, approval, posting, journal.

**Their scenario.** Work → Bank feed → **Record a venue deposit**: their payer, amount and memo. Or **Access → bank · Revoke**: the seat can neither read the bank nor be launched, and the attempt is audited.

**If the room's network fails.** Everything in Slack is also in the console under **Needs you**; decide there.

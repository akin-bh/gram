# Evidence

Captured verification runs referenced from the [main readme](../readme.md#validation-and-captured-evidence). Each JSON file is gzipped without modification; [`SHA256SUMS`](SHA256SUMS) lists the hashes of the originals.

```sh
cd evidence
gunzip -k *.json.gz
shasum -a 256 -c SHA256SUMS
```

- `live-*.json` and `complete-ticketing-handoff.json` record live runs: real HTTP requests, Claude Agent SDK traces, Gemini Argon generation where noted, assertions, costs, and audit-chain checks. Failed checks are kept as recorded.
- `*-integration-verification.json` records each restart of the main service onto a new backend: world fingerprints, audit chains, and source, UI and README hashes before and after.
- `cash-bench-*.json` records the cash-application seat's planted month from `bun run bench:baseline` (scripted, no model) and `bun run bench:cash` (live Claude seat, with simulated colleagues whose replies Gemini Argon phrased). Each holds the answer-key score per bank line, every run with its trigger, cost and final message, the policies with their backtests, and the handoffs. Live runs are kept as recorded, including the ones that were not clean.
- [`screenshots/`](screenshots/) holds browser captures from the first judge workflow runs, before the current DialKit interface.

All companies, people, and financial records are synthetic. Absolute paths and local ports inside the files come from the machine that captured them. Hashes and file names inside a record refer to the original working tree, which held several candidate checkouts; source files may have changed since.

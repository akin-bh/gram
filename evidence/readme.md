# Evidence

Captured verification runs referenced from the [main readme](../readme.md#validation-and-captured-evidence). Each JSON file is gzipped without modification; [`SHA256SUMS`](SHA256SUMS) lists the hashes of the originals.

```sh
cd evidence
gunzip -k *.json.gz
shasum -a 256 -c SHA256SUMS
```

- `live-*.json` and `complete-ticketing-handoff.json` record live runs: real HTTP requests, Claude Agent SDK traces, Gemini Argon generation where noted, assertions, costs, and audit-chain checks. Failed checks are kept as recorded.
- `*-integration-verification.json` records each restart of the main service onto a new backend: world fingerprints, audit chains, and source, UI and README hashes before and after.
- [`screenshots/`](screenshots/) holds browser captures from the first judge workflow runs, before the current DialKit interface.

All companies, people, and financial records are synthetic. Absolute paths and local ports inside the files come from the machine that captured them. Hashes and file names inside a record refer to the original working tree, which held several candidate checkouts; source files may have changed since.

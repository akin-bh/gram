# The console

The gram console is a DialKit workspace. This page holds the full detail; the readme keeps the short version.

## Spaces, tabs and panes

Each company is a separate **space** with its own open views, record tabs, drafts, favorites, and saved searches. Select a company in the sidebar to restore its workspace. **Overview**, **Inbox**, **Files**, **Money**, **Books**, **Purchasing**, and **Favorites** are primary views; the folded **Tools** group contains **Connections**, **Data sources**, **Agent**, **Notifications**, and **Audit trail**. **New company** and **Settings** are available in the sidebar dock. Labels across the console lead with plain English and keep the accounting term in parentheses — *Money in (payments)*, *Bookkeeping entries (journals)*, *Bank matching (reconciliation)* — so a first-time reader can follow a demo without an accounting background. The shell carries the Gram brand: the two-linked-squares mark and wordmark in the sidebar and favicon, with the brand orange as the accent in both themes ([`../web/icons.js`](../web/icons.js), [`../web/style.css`](../web/style.css)).

Views and records open in persistent tabs. A tab's menu supports pin/unpin, **Split right**, **Split below**, moving to another pane, closing, and reopening the most recently closed tab. The workbench supports at most **three columns and two rows per column**; dividers resize panes. Tabs can also be reordered or moved by dragging. On narrow screens, the active pane fills the workbench while the sidebar and assistant open as overlays.

[`../web/workspace.js`](../web/workspace.js) stores layout, active tabs, text drafts, favorites, saved searches, appearance settings, and up to 20 closed tabs per company in versioned browser local storage. Record tabs retain references to server records; the database remains the source of financial state. Selected attachment files are held only in memory and must be selected again after a reload. This browser state is local to the current browser and origin.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+K` | Search the current company's records and views; save a query for later. |
| `Alt+N` | Open a new tab. |
| `Alt+W` | Close the active tab. |
| `Cmd/Ctrl+Shift+T` | Reopen the last closed tab. |
| `Alt+B` | Toggle the sidebar. |

## The agent drawer

The assistant toggle opens a resizable **Agent** drawer with a fixed header and composer around one scrolling response. Responses render Markdown as semantic text; the task preview opens the original instruction, and **Run history** opens a separate list. **Open full response** moves the selected run into a record tab. Reading positions survive view changes. Its task composer starts the real Anthropic agent; opening the drawer or editing a draft does not execute financial work. The **Agent** view exposes the same underlying service.

Agent activity uses the actual [`thinking-orbs` 0.3.2 engine](https://libraries.dev/orbs) by [Jakub Antalik](https://github.com/Jakubantalik/Libraries.dev), under its MIT license. The vanilla adapter imports the engine without a React runtime. Recorded run progress selects connecting, reading, working, or composing motion; failures and terminal states retain explicit labels. Terminal orbs pause, elapsed time uses stored timestamps, and reduced motion, hidden tabs, and offscreen indicators stop animation. Status polling continues while the task draft has focus. **Stop** requests cancellation; the indicator changes to **Stopped** only after the service records that outcome.

## The audit trail

Audit opens recent activity in a keyboard-navigable tree beside a scrolling event reader. Dotted branches connect explicit request, run, and delivery IDs; single-event requests open directly. **Activity**, **All events**, and **Attention** filter the stored log before pagination, and search includes older events. **Load older** retains a stable snapshot and reading position. Event tabs resolve durable sequence IDs after reload. Narrow panes switch between the tree and reader with **Back to events**. The hierarchy and adjacent reader draw on [Langfuse's trace view](https://langfuse.com/changelog/2025-03-19-new-trace-view) and [Primer's tree navigation](https://primer.style/product/components/tree-view/).

## Resizing and responsive behavior

Sidebar and assistant dividers support arrow keys in 8-pixel steps, Shift for 24 pixels, Home/End for their limits, and double-click to reset. Sidebar width stays synchronized with Settings. Pointer resizing saves once at the end of a gesture, including cancellation or focus loss.

Below 1360 pixels the assistant floats over the workbench, preserving its chosen width. Between 800 and 1015 pixels, opening it temporarily hides navigation; reopening navigation closes the assistant. Saved widths and the sidebar preference remain available when the drawer closes or the window grows.

## Provenance and build

The shell adapts the neutral surfaces, compact sidebar, tabs, split panes, search launcher, and assistant placement of [Define's demo](https://demo.define.app/). Mapping a company to a space and persisting real favorites and saved searches are gram decisions. The reviewed Define demo does not establish a persistent spaces model, and its assistant uses scripted responses. No Define code or assets are included.

[`../web/app.js`](../web/app.js) imports native `Folder`, `TextControl`, `SelectControl`, `ButtonGroup`, `Slider`, and `Toggle` components from `dialkit/vanilla` with DialKit's stylesheet. These controls serve the workbench, record inspection, financial forms, procurement, feedback, and OAuth consent; saved fields are read-only. [`../web/style.css`](../web/style.css) supplies the shell geometry, neutral theme, component styling, and responsive behavior. Secondary context and technical details stay in folded groups or record tabs.

[`../src/build-ui.ts`](../src/build-ui.ts) bundles the package and application through `Bun.build` into ignored `web/dist/` assets. The service serves that bundle for both the main console and connection consent. Bun runs everything: `Bun.serve` and `Bun.file` for HTTP and static files, `bun:sqlite` for state, `Bun.CryptoHasher` and Web Crypto for hashes, HMAC signatures and identifiers, `Bun.build` for the UI, and `bun:test` with `expect` for the suite. `node:fs`, `node:path`, and `node:os` remain only for directories, permissions, temporary folders, and the synchronous key-file read, which have no Bun-native equivalent. The Agent SDK is configured with `executable: 'bun'`; the installed SDK also ships its platform-native Claude CLI.

## Books in Fava

**Books** shows each company's general ledger in [Fava](https://github.com/beancount/fava), the web interface for [Beancount](https://github.com/beancount/beancount): the balance sheet, income statement, trial balance, journal, charts over time and Beancount's query language. The books are the journals gram's gateway posted, written as a Beancount ledger ([`../src/books.ts`](../src/books.ts)) and rewritten after every commit, so an open Fava page reloads itself when the seat or a person posts.

- **Read-only.** gram stays the only writer of the books. Fava runs in read-only mode, and gram's proxy refuses any write before it reaches Fava; a change to the books is made in gram, where it is checked, approved and logged.
- **Checked.** After the last posting the file asserts every account's balance as gram holds it, so Fava (and `bean-check`) report any account whose journals do not add up. The Books view shows that check.
- **Traceable.** Each transaction carries its gram journal, source and operation as metadata, links to the work items and postings behind it (`^WI-5531`), and a tag for how it was approved: `#posted-under-policy`, `#approved-by-person`, `#reversal`. A reversal links to the item it reverses, so one click shows both.
- **Saved queries.** *Posted under policy, no person*; *Approved by a person*; *Postings by work item*; *Operating bank movements*.
- **The company's own currency.** Each company's books are in its own currency (USD for all four today; the Toronto show's CAD settlement reaches the books at the bank's rate); accounts are named from gram's chart (`Assets:Cash-Bank`, `Income:Concert-Revenue`), and accounts a company never used are hidden.
- **Behind the session.** Fava has no login of its own, so it listens on no TCP port: a child process ([`../src/fava_host.py`](../src/fava_host.py)) serves one Fava app per company on a Unix socket in a private directory, and the console reaches it only through `/fava/<company>/`, which requires the controller session. Only those pages may be framed, and only by the console's own origin. The process exits with gram.

**Download .beancount** gives the same file to any Beancount tool. `GET /api/worlds/:id/books` reports the export and Fava's check; `GET /api/worlds/:id/books.beancount` returns the file. Ledgers are written to `books/<database>/` next to the database. `bun run fava:setup` installs the pinned Fava release into `.fava/venv` (git-ignored); `bun run fava:setup --source ../fava` installs a local checkout instead (`gh repo clone beancount/fava`, built with npm). Without Fava the view says so, and the download still works.

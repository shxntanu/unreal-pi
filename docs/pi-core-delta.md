# Async harness experiment: Pi core delta

## Step 1 — architecture and Milestone 0

No agent-loop, provider API, session persistence, tool implementation, TUI, runtime dependency, or package manifest changes.

The opt-in observer lives at `packages/coding-agent/examples/extensions/baseline-metrics.ts`. It uses existing lifecycle/execution hooks and registers only the `--baseline-results` CLI flag. It writes external JSONL rather than adding model-context or session entries.

Documentation changes: `docs/async-harness-design.md`, `experiments/async-harness/README.md`, the extension examples index, and the coding-agent Unreleased changelog.

Source verification required local dependencies (`npm ci --ignore-scripts`) and ignored model data (`npm run hydrate:model-data`). No build, full test suite, paid model call, commit, branch switch, or unit-test addition is part of this step.

Future agent-loop scheduling changes remain gated on repeated measurements showing that extension-level completion delivery is materially constrained by the current tool-batch barrier.

## Step 2 — Milestone 1

- Added `packages/async-operations` (`@earendil-works/pi-async-operations`), with Node-only contracts, SQLite store, validation, and local manager.
- Added the package to the existing root build/build:offline sequences and TypeScript source aliases; refreshed npm workspace lock metadata. No build was run.
- Used built-in `node:sqlite`; added no external dependency.
- Updated architecture and experiment documentation and the new package's README/changelog.

No existing agent-loop, provider, coding-agent runtime/tool, session persistence, or TUI implementation was modified. The runtime does not import Pi's agent/LLM packages. Registered runners are independent of Pi; the shell runner and permission-preserving integration are later milestones.

Milestone 0 was committed as `5ab0c88f4` at the user's request before this work. No unit tests were added.

## Step 3 — Milestones 2 and 3

- Added the Node-only shell runner and bounded log reader to `async-operations`, with streaming logs, timeout, process-tree cancellation, and versioned result metadata.
- Added `packages/async-pi-extension` (`@earendil-works/pi-async-extension`) with the four tools, session-scoped runtime ownership, and prompt guidance.
- Added `ExecuteToolOptions.execute` and passed it through `NestedToolCallRunner` into the existing coding-agent nested tool pipeline. Lookup, schema validation, permission/result hooks, execution events, and transcript bookkeeping remain in place. This lets `run_async` submit after Bash authorization without executing synchronous Bash or globally replacing it.
- Corrected SDK base-tool override provenance to `sdk`, so the extension's built-in-only safety guard also rejects custom SDK backends.
- Exported the existing `getBinDir` configuration helper for the extension's PATH handling.
- Added the extension to root build sequences/source aliases and refreshed workspace lock metadata. No build was run.

No `packages/agent`, provider API, session file format, or TUI implementation changes. Automatic completion messages are not implemented in this milestone. No unit tests were added.

Verification: temporary real shell and faux-provider session smoke runs passed; `npm run check` passed. Submission returned in 6–7 ms, blocked jobs were not persisted, and cancellation/shutdown removed owned children. Temporary scripts/fixtures were removed. Windows cleanup was not exercised; abrupt forced host termination remains an orphan-process risk.

## Step 4 — Milestone 4

- Added the completion bridge and bounded deterministic summaries to the async extension, with automatic idle wakeup, active steering, persisted receipt validation, session-wide deduplication, and terminal-operation backfill on restart.
- Added and exported `SendMessageOptions.onPersisted` throughout the custom-message API. `AgentSession` associates the synchronous observer with the original custom message and calls it once after successful session append, never on queue admission. Observer exceptions are reported without disrupting history.
- Reused the existing `custom_message` format for notification receipts; no operation-store schema, session-file schema, agent-loop scheduling, provider API, runtime dependency, or TUI changes.
- Closed the bridge before manager shutdown to suppress model wakeups from cleanup cancellation.

Verification used temporary real shell and faux-provider sessions: automatic idle/active consumption, bounded multibyte/error summaries, ordered tool results, on-disk receipt uniqueness across reloads, offline terminal/lost-process recovery without replay, shutdown suppression, and recovery after aborting a queued notification. Failed session append did not acknowledge delivery. No unit tests, build, or paid provider calls were run.

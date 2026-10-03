# Async harness experiment

## Step 1: architecture and baseline metrics

Architecture and extension/core boundaries: [design](../../docs/async-harness-design.md). Milestones 0–3 are implemented: baseline instrumentation, standalone [operation runtime](../../packages/async-operations/README.md), shell runner, and [Pi extension](../../packages/async-pi-extension/README.md). No unit tests were added and no benchmark benefit has been measured.

Load the observation-only extension with stock Pi from the repository root:

```sh
pi --extension ./packages/coding-agent/examples/extensions/baseline-metrics.ts
```

For this checkout's unbuilt source, use the stock CLI entry point, not `pi-test.sh` (which launches the existing experimental CLI):

```sh
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  ./packages/coding-agent/src/cli.ts \
  --extension ./packages/coding-agent/examples/extensions/baseline-metrics.ts
```

A fresh checkout needs `npm ci --ignore-scripts` and `npm run hydrate:model-data` before source execution. Neither compiles the repository or runs dependency lifecycle scripts.

Run an ordinary coding task. Telemetry appends to the task workspace's:

```text
experiments/async-harness/results/baseline-YYYYMMDD.jsonl
```

The date is UTC and fixed when each run starts. Override the destination for a fixture or benchmark workspace:

```sh
pi --extension ./packages/coding-agent/examples/extensions/baseline-metrics.ts \
  --baseline-results /absolute/path/baseline.jsonl
```

Relative destinations resolve against the session working directory. Existing files append; new files are created with mode `0600`. CLI extension flags are only available when the extension is loaded. For SDK collection, pass the default export as an `extensionFactories` entry in `DefaultResourceLoader` and bind extensions before prompting.

## JSONL contract (version 1)

Each line has `version: 1`, `type: "tool" | "run"`, `runId`, and `sessionId`.

A **tool** row records `toolCallId`, optional `parentToolCallId`, `toolName`, `startTime`, `finishTime`, `durationMs`, `success`, and `complete`. It is appended when the execution ends, including failed/blocked attempts. Nested calls are included; filter rows with `parentToolCallId` when counting direct model-issued calls. Arguments, raw output, and optional payload sizes are not recorded.

A **run** row records:

- Initial `provider`, `model`, and `thinkingLevel`; `mode: "baseline"`.
- `startedAt`, `finishedAt`, and monotonic `wallClockMs`.
- `modelCalls` and `turnCount`.
- `inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheWriteTokens`.
- `toolCalls`, summed `toolDurationMs`, and `errors`.
- `aborted`, `complete`, and `telemetryComplete`.

One run spans the first `agent_start` through final `agent_settled`, not just `agent_end`. Automatic retries and recovery before settlement stay in that run. A later prompt creates another run ID. Timing excludes prompt preprocessing before `agent_start` and the final metrics append. Tool timing includes validation/permission preflight and finalization; parallel/nested durations overlap, so their sum is not exclusive wait time.

Model calls count finalized conversational assistant responses, including errors and aborts; provider-internal HTTP retries are not separate model calls. Token counters use provider-reported Pi usage values, including cache read/write as separate fields. They **exclude** compaction, cache warming, and nested model requests. Do not label these counters total billed usage. Record model switching separately if a benchmark allows it; run identity describes the initial selection.

`errors` counts failed tool attempts and assistant error/abort responses, including failures later recovered by retry. `complete` means the run reached final settlement, not that the coding task succeeded. Benchmark task success needs independent evaluation.

A graceful session shutdown before settlement emits an incomplete run and unfinished tool rows. Unfinished tools invalidate telemetry. Abrupt process death cannot execute shutdown hooks: tool rows without a final run row are incomplete data. Filesystem failures surface through Pi's extension error reporting and set `telemetryComplete: false` if a final row can still be written. Discard incomplete/invalid runs from quantitative comparisons; never treat absent telemetry as zero.

The extension does not register tools, inject messages, alter prompts, mutate results, or append session entries. It awaits small JSONL writes on execution-end and final-settlement events. This introduces disk-I/O overhead; measure that overhead on realistic repeated runs before interpreting small latency differences.

## Exercised verification

A temporary smoke script used the existing `test/suite/harness.ts` and faux provider, with real nested Bash commands. It exercised parallel success/non-zero exit, automatic retry, three separate runs, token reconciliation against finalized responses, nested tool IDs, and an aborted response. Instrumented and uninstrumented transcript role/content matched. The script and its temporary telemetry were removed afterward. These smoke numbers are not benchmark results or evidence of async improvement.

## Step 2: Milestone 1 operation runtime

`@earendil-works/pi-async-operations` provides persistent operations, atomic lifecycle events, runner dispatch, cancellation, bounded concurrency, and recovery using Node's built-in SQLite API. Milestones 2–3 add shell execution and Pi tools; automatic completion delivery remains Milestone 4. See the package README for executable runner usage and lifecycle/ownership limits.

Verification used temporary scripts, not permanent unit tests: real filesystem jobs/output, queued and running cancellation, non-zero and thrown failures, restart/resume, dead-owner reclaim, live-owner exclusion, strict JSON/size bounds, unknown schema rejection, rollback when event insertion fails, and 16 cancellation/completion races. Running work was not replayed after recovery, and rejected persistence never emitted a false completion. A near-limit payload/result boundary failed before the snapshot-budget correction and completed afterward.

The baseline changes were committed as `5ab0c88f4` before this milestone at the user's request.

## Step 3: Milestones 2–3 shell runtime and Pi tools

Load the opt-in extension from an unbuilt source checkout:

```sh
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  ./packages/coding-agent/src/cli.ts \
  --extension ./packages/async-pi-extension/src/index.ts
```

The tools are `run_async`, `operation_status`, `operation_output`, and `operation_cancel`. Logs and SQLite snapshots are isolated under `.pi/async/<session-id>/`. Bash permission hooks run before submission; custom/sandboxed/SDK Bash backends are refused rather than bypassed. Normal Bash is unchanged.

Temporary smoke runs exercised real shell execution: separate exact-byte stdout/stderr logs, exit-code failure, timeout, argv/stdin transport, failed spawn, queued/running cancellation, SIGTERM-resistant descendant cleanup, host SIGTERM cleanup, disk bounds, UTF-8-safe bounded tails/filtering, path/symlink rejection, pending recovery, and lost-process no-replay.

The existing suite harness and faux provider exercised all four extension tools through an actual `AgentSession`, including prefixed Bash permission hooks, rejection without persisting a blocked job, unchanged synchronous Bash, cancellation with child death, shutdown/reopen, prompt guidance, and custom/SDK backend refusal. Observed `run_async` execution latency was 6–7 ms for a command that continued running after acknowledgement; this is a smoke observation, not a benchmark.

Gate A (local runtime) and Gate B (four Pi tools) are exercised. Gate C is not implemented: this milestone does not deliver automatic completion messages. Windows process-tree cleanup has not been exercised on this macOS workstation; abrupt SIGKILL can bypass cleanup and leave descendants running.

`npm run check` passed after correcting the tool-result helper's required `details` field. Temporary smoke scripts and their fixtures were removed. No unit tests, full test suite, build, or paid provider calls were added or run for these milestones.

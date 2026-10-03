# Async harness experiment

## Step 1: architecture and baseline metrics

Architecture and extension/core boundaries: [design](../../docs/async-harness-design.md). This step adds no async behavior and no unit tests. Milestone 1 (operation runtime) is next. No benchmark benefit has been measured.

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

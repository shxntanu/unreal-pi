# @earendil-works/pi-async-operations

Milestones 1–2 of the [async harness experiment](../../pi-async-harness-experiment.md): a local operation manager, persistent operation/event store, streamed shell runner, and bounded log reader. No agent-loop, provider, LLM, TUI, or external runtime dependencies.

Requires Node >=22.19.0 with built-in `node:sqlite`. Some supported Node versions emit SQLite's experimental API warning. SQLite operations are synchronous and exposed through a Promise-based store contract; this is a small local metadata runtime, not a distributed worker system.

## Using the runtime

```ts
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  LocalOperationManager,
  SQLiteOperationStore,
  type OperationRunner,
} from "@earendil-works/pi-async-operations";

const hashFile: OperationRunner = {
  async run(operation, { signal, reportOutput }) {
    const payload = operation.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        typeof payload.input !== "string" || typeof payload.output !== "string") {
      throw new Error("Expected input and output paths");
    }
    signal.throwIfAborted();
    const input = await readFile(payload.input, { signal });
    const digest = createHash("sha256").update(input).digest("hex");
    signal.throwIfAborted();
    await writeFile(payload.output, digest, { signal });
    await reportOutput("stdout", Buffer.byteLength(digest));
    return { summary: digest, stdoutPath: payload.output };
  },
};

const store = new SQLiteOperationStore(".pi/async/operations.sqlite");
let manager: LocalOperationManager | undefined;
try {
  manager = await LocalOperationManager.open({
    store,
    runners: { hashFile },
    maxConcurrentJobs: 4,
    onError: (error) => console.error(error),
  });
  manager.subscribe((event) => console.log(event));
  const operation = await manager.submit({
    kind: "hashFile",
    payload: { input: "/tmp/input.txt", output: "/tmp/digest.txt" },
    sessionId: "optional-host-correlation-id",
  });
  // submit persists intent and returns without waiting for runner completion.
  // Keep the host alive to consume completion events and do independent work.
  // await manager.cancel(operation.id) cancels and waits for runner cleanup.
  console.log(operation.id);
} finally {
  // Closing immediately cancels work: a real host closes on its shutdown boundary.
  try {
    await manager?.close();
  } finally {
    await store.close();
  }
}
```

Register only runners you explicitly trust. The runtime does not invent permissions. A runner owns its I/O and any child processes; it must honor `signal` and resolve/reject only after owned work has stopped. CPU-bound synchronous runner code still blocks Node. `reportOutput` persists byte-count events, not log contents; the runner streams actual output to disk and returns paths/metadata.

## Operations and events

Operations have UUID IDs, `version: 1`, kind, strict JSON payload, state, timestamps, optional result, and optional session correlation. Results support exit code, summary, output paths, error, failure kind, and JSON metadata.

Lifecycle:

```text
pending -> running -> completed | failed | cancelled
pending -> failed | cancelled
```

Illegal transitions reject. Identity/kind/payload/creation/session fields cannot be changed. Terminal states/results are immutable. Completed operations cannot carry failures or a non-zero exit code. The manager normalizes thrown/invalid runner results to `runtime_error`, non-zero exits to `nonzero_exit`, and explicit runner failure kinds to failures. Cancellation wins if accepted before terminal finalization; repeated cancellation of a terminal operation is a no-op. A running cancellation waits for the runner to settle before committing `cancelled`. A runner that ignores cancellation can make cancellation/close wait indefinitely; forceful process ownership is a runner responsibility.

Events carry `version: 1`, UUID `eventId`, globally increasing `sequence`, operation ID, timestamp, and created/started/output/completed/failed/cancelled data. Creation and lifecycle transitions commit the snapshot and event in one SQLite transaction. Events are never rewritten after commit. Subscriptions observe persisted events; listener failures are reported through `onError` without changing job outcomes. Subscribe before submit. Recovery events emitted during `open` are already persisted before subscriptions can be registered; query event history to consume them.

Storage failures abort owned work, stop scheduling, and surface through `onError` and a rejecting `close`. The runtime never emits a completion for an uncommitted transition. If persistence remains unavailable, active snapshots remain recoverable as pending/running; do not assume cancellation or completion was saved.

## Persistence and ownership

`SQLiteOperationStore(path)` creates parent directories and schema version 1. An existing unknown-version or incompatible/unversioned database is rejected rather than overwritten. The database stores indexed snapshots, an append-only event table, and a manager ownership row. Busy timeout: 5 seconds. Transactions use `BEGIN IMMEDIATE`; no external SQLite library is installed.

Exactly one manager may own a database. `open` atomically claims a PID/UUID token before recovery. A live PID (including permission-denied liveness checks) blocks takeover; a vanished PID allows reclaim. PID reuse can conservatively produce false-busy ownership; there is no unsafe forced takeover. Ownership is released only after shutdown finishes. Close the manager before its caller-owned store; closing an owned store rejects. Do not manipulate lifecycle records directly while a manager is operating them.

Recovery:

- Terminal operations remain unchanged.
- Old running operations become `failed`, `failureKind: "lost_process"`, with `runner process disappeared`. They are never replayed or reattached.
- Pending operations with a registered runner resume under the concurrency limit.
- Pending operations with no registered runner become failed.

No exactly-once execution guarantee: a process can perform an external effect before crashing without committing its result. Recovery does not replay old running work, avoiding accidental duplicate effects. Pending jobs are selected from persisted state rather than retaining an unbounded in-memory pending queue. Default concurrency is 4; configured concurrency must be an integer from 1 through 128.

## Store API and limits

The store retains the planned create/get/update/list/appendEvent/events interface, with two additions for correctness: `acquireOwnership` and atomic `transition`. `create`, `appendEvent`, and `transition` return the store-assigned persisted event. Use `transition` for lifecycle changes; `appendEvent` accepts output only while running. `update` can replace result metadata before termination, not state/timestamps/identity or terminal results.

Limits:

| Value | Limit |
|---|---:|
| JSON payload | 256 KiB serialized |
| JSON result | 256 KiB serialized |
| Full operation snapshot | 528 KiB serialized |
| Result summary/error and failed-event error | 8 KiB UTF-8 each |
| Kind | 256 UTF-8 bytes |
| Session ID | 1,024 UTF-8 bytes |
| Query page | Default 100, maximum 10,000 rows |

Strict JSON excludes class instances, promises, functions, process/controller objects, non-finite numbers, undefined properties, sparse arrays, accessors, custom serializers, symbols, and cycles. Query records use validated bound SQL parameters. `list` orders by creation timestamp then ID and supports state/kind/session filters, limit, and offset. `events(id, { afterSequence, limit })` orders by ascending global sequence. Page through history rather than loading all events. Database/history disk retention is host-managed; shell log growth is capped per job, but there is no automatic pruning.

No unit tests were added. Temporary smoke scenarios exercised real filesystem jobs, atomic rollback, concurrency, failure, cancellation races, crash ownership/recovery, size boundaries, and restart persistence.

## Shell execution and output

```ts
import {
  LocalOperationManager,
  ShellOperationRunner,
  SQLiteOperationStore,
  readOperationOutput,
  validateShellOperationPayload,
} from "@earendil-works/pi-async-operations";

const rootDir = ".pi/async";
const store = new SQLiteOperationStore(`${rootDir}/operations.sqlite`);
const shell = new ShellOperationRunner({ rootDir });
const manager = await LocalOperationManager.open({ store, runners: { shell } });
const payload = { version: 1, command: "printf 'hello\\n'", cwd: process.cwd() };
validateShellOperationPayload(payload);
const operation = await manager.submit({ kind: "shell", payload });
console.log(operation.id);
// Keep the host alive while work runs. Reads are bounded snapshots, not waits.
console.log(await readOperationOutput(rootDir, operation.id, { tailLines: 200 }));
// On host/session shutdown, after any desired work has finished:
try {
  await manager.close();
} finally {
  try { await shell.close(); } finally { await store.close(); }
}
```

The version-1 shell payload supports `command`, `cwd`, optional `env`, `timeoutMs`, `purpose`, and an explicit shell executable/argument configuration with argv or stdin command transport. The shared admission validator rejects invalid data before persistence; the runner validates again before spawning. Ambient environment is inherited at execution time, not copied into snapshots.

Logs: `<rootDir>/runs/<operation-id>/{stdout.log,stderr.log,metadata.json}`. Default limits: 64 KiB in-memory tail per stream, 128 MiB combined log bytes per job, and 250 ms graceful shutdown before escalation. The disk limit is configurable from 1 byte through 1 GiB; exceeding it stops execution with `runtime_error`. Result metadata records PID/owner PID, timestamps, duration, byte counts, exit/signal, and base64-encoded bounded tails; summaries are limited to 8 KiB.

Cancellation waits for process-tree cleanup and log flushing before the manager commits `cancelled`. POSIX uses detached groups, SIGTERM, and SIGKILL; Windows uses System32 `taskkill.exe /T` with forced escalation. Explicit close and graceful shutdown signals clean up owned jobs. SIGKILL/host crashes cannot execute hooks; escaped descendants can survive. Recovery never reattaches or replays old running jobs.

`readOperationOutput(rootDir, id, { stream, tailLines, contains })` defaults to both streams and 200 lines. It scans at most 256 KiB per stream and returns at most 32 KiB aggregate text; `tailLines` ranges from 1 through 1,000 and `contains` is a literal substring limited to 1,024 UTF-8 bytes. Older output is intentionally not searched. An incomplete first line in a bounded suffix is discarded; an incomplete final UTF-8 scalar is omitted until a later read. Excerpts report total/scanned bytes, truncation, and missing files. IDs and canonical paths are validated; symbolic-link logs/directories are rejected.

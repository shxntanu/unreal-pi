# Pi async operations extension

This extension exposes four tools for submitting and managing persistent shell operations:

- `run_async` queues a shell command and returns its operation ID without waiting for command completion.
- `operation_status` reports one operation's state, timestamps, duration, command, purpose, and terminal result.
- `operation_output` reads bounded stdout/stderr excerpts, optionally filtered by a literal substring.
- `operation_cancel` cancels a pending or running operation; cancelling a terminal operation is idempotent.

## Build and load

From a source checkout, refresh npm workspace links and build Pi plus its dependencies before launching the extension:

```sh
npm install --ignore-scripts && \
npm run build:offline && \
node ./packages/coding-agent/dist/bundle/cli.js \
  --extension ./packages/async-pi-extension/dist/index.js
```

`npm install --ignore-scripts` creates the new async-package links in `node_modules`; updating only the lockfile does not. `build:offline` uses local model data; a fresh checkout needs `npm run hydrate:model-data` first. After dependencies are built, the extension alone can be rebuilt with `npm --prefix packages/async-pi-extension run build`. The package's `pi.extensions` entry points to `dist/index.js`.

For an unbuilt source checkout, load the extension through Pi's source resolver:

```sh
node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  ./packages/coding-agent/src/cli.ts \
  --extension ./packages/async-pi-extension/src/index.ts
```

For SDK use, supply the default export (also named `createAsyncPiExtension`) as an extension factory and bind extensions before prompting. Emit `session_shutdown` before disposing the session to close its background runtime.

## Behavior and safety

Operations are stored under `.pi/async/<session-id>` in the session's working directory. The SQLite store, scheduler, and shell runner are opened for each Pi session and closed on session shutdown/replacement. Status, output, and cancellation reject IDs not owned by the current session.

`run_async` reuses Pi's built-in `bash` tool call pipeline for validation and permission hooks, replacing only the execution of that nested call with the asynchronous operation submission. It fails closed unless the registered `bash` tool has built-in source provenance and is callable, so it will not bypass a custom or sandboxed Bash implementation. The configured Bash shell and command prefix are preserved; the permission hook sees the same prefixed command that the operation runner executes.

Only the Pi-managed binary directory is added to the persisted child environment's `PATH` override. Ambient environment variables are inherited by the runner and are not copied into operation records. Output reads are bounded by the async-operations package.

Use `run_async` by default for shell commands expected to take several seconds or longer, including tests, builds, installs, and network requests. Reserve synchronous `bash` for quick commands such as `ls`, `rg`, and `git status`. A slow command should still use `run_async` when its result is required before the next step: end the turn and resume from its completion notification. The extension contributes the following workflow to Pi's system prompt:

1. Submit the command once and retain its operation ID. The queued acknowledgement is not a completed result.
2. Continue useful independent work. Do not immediately check whether the command has finished.
3. If all remaining work depends on the operation, end the turn with a brief pending-work note. Completed, failed, and cancelled operations automatically send a compact message to Pi: idle sessions start a turn; active sessions receive steering after the current tool batch.
4. Resume dependent work from the notification. Check its result before claiming success; use `operation_output` when the included excerpt lacks necessary details.

For example, start a test command with `run_async`, inspect unrelated files, then end the turn if blocked. The completion notification resumes work on the test result. Do not keep the turn alive with repeated status/output calls, log reads, sleeps, or shell wait loops. Use `operation_status` only for a user-requested progress update or diagnosis of a specific problem, and `operation_cancel` when the work is no longer needed.

## Completion delivery

Notifications are deterministic, with no summarization model call. They include command/purpose, terminal state, duration, exit code/signal, failure details, byte counts, log paths, and selected output/error lines. Messages are capped at 8 KiB, with at most 1 KiB of excerpt text per stream. Output inspection scans at most 256 KiB per stream, uses the reader's bounded suffix, and cannot detect errors outside that suffix. Truncation is disclosed.

Each notification stores a versioned `async-operation-completion` custom-message receipt in the Pi session. `onPersisted` confirms the actual appended entry before the bridge acknowledges delivery; queue admission is not acknowledgement. Startup scans receipts across all session branches and backfills unreceipted terminal operations, including `lost_process` failures, without rerunning commands. Duplicate terminal events and reloads do not generate another notification for a receipted operation.

Shutdown stops the bridge before cancelling operations, avoiding shutdown-triggered model turns. Cancellation receipts and messages queued but not consumed before abort/shutdown are recovered when the same session is reopened. Formatting failures surface through UI notification and leave the operation eligible for recovery on restart.

Receipts use the existing session storage contract: in-memory sessions have in-memory receipts; acknowledgement does not imply filesystem synchronization or successful provider consumption. No separate delivery table or session-file format change is required.

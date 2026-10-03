# Pi async operations extension

This extension exposes four tools for submitting and managing persistent shell operations:

- `run_async` queues a shell command and returns its operation ID without waiting for command completion.
- `operation_status` reports one operation's state, timestamps, duration, command, purpose, and terminal result.
- `operation_output` reads bounded stdout/stderr excerpts, optionally filtered by a literal substring.
- `operation_cancel` cancels a pending or running operation; cancelling a terminal operation is idempotent.

## Build and load

Build the package from the repository root with `npm --prefix packages/async-pi-extension run build`, then load its package directory in Pi. The package's `pi.extensions` entry points to `dist/index.js`. The extension requires `@earendil-works/pi-async-operations` and the matching Pi coding-agent package.

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

This milestone does not inject automatic completion messages. Use `operation_status` or `operation_output` only when progress or results are needed; avoid repeated polling. Use normal synchronous `bash` when the result is needed before the next reasoning step.

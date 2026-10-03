# Async harness experiment: source-verified design

## Scope and sequence

Implement `pi-async-harness-experiment.md` one milestone at a time. The first step is architecture inspection and Milestone 0 (stock-Pi baseline instrumentation). Do not add unit tests. Use temporary smoke scenarios with the existing faux provider; do not require paid model calls. Do not commit or change branches automatically.

The inspected checkout differs from the plan's assumed layout: Bash is in `packages/coding-agent/src/core/tools/bash.ts`, sessions in `src/core/session-manager.ts`, and package names use `@earendil-works/`. It also already contains `packages/durable` and `packages/telemetry`. Their existing exports are not evidence that detached shell operations are supported by the CLI. Evaluate them before introducing overlapping abstractions in later milestones.

## Current turn lifecycle

Sources: `packages/agent/src/agent-loop.ts` (`runAgentLoop`, `runAgentLoopContinue`, `runLoop`, `streamAssistantResponse`), `packages/agent/src/types.ts`, and `packages/coding-agent/src/core/agent-session.ts`.

1. A prompt starts an agent run and emits `agent_start`, then `turn_start` and input message events.
2. Queued steering and prepared messages enter before the next request. `prepareRequest` can replace runtime context/model/thinking settings.
3. Context transforms run, messages convert to provider-compatible messages, and `normalizeContext` reconstructs prompt/tool declarations from system messages. Credentials resolve per request.
4. The provider stream emits assistant start/update/end events. The final assistant message carries usage and stop reason.
5. Tool calls execute; all results are finalized before the next assistant request.
6. `finishTurn` executes before `turn_end`. It may end the run or ensure one continuation. Errors and aborts exit rather than continuing.
7. Steering is drained after the tool batch. Follow-ups are drained when the inner loop would stop.
8. `agent_end` closes one low-level run. Coding-agent retry, recovery, compaction, or queued continuation may still follow. `agent_before_settle` is actionable; `agent_settled` is the final notification boundary.

`AgentSession` is authoritative for persisted context: `_refreshFinalizedContext` projects the session manager's entries back into the agent. Assigning an arbitrary agent message array is not a substitute for session persistence.

## Tool-call lifecycle and parallel semantics

Sources: `agent-loop.ts` (`executeToolCalls`, `prepareToolCall`, `executePreparedToolCall`, `finalizeExecutedToolCall`, `runToolCall`), `extensions/types.ts`, and `agent-session.ts` (`_emitExtensionEvent`).

- Emit `tool_execution_start` before argument preparation, validation, and permission preflight.
- Resolve the tool and validate its schema; `beforeToolCall` can block it. Coding-agent extensions expose this as `tool_call`.
- Await `execute`, including streamed updates. Throws become error results.
- Apply `afterToolCall`/extension `tool_result` transformations, then emit `tool_execution_end`.
- Append final tool-result message artifacts. A truncated assistant response (`stopReason: length`) fails its calls rather than executing potentially incomplete arguments.

Default execution is parallel: preflight all calls sequentially, launch allowed tools concurrently, and emit execution-end events in completion order. `Promise.all` is a synchronization barrier. Tool-result messages are emitted in assistant source order, preserving transcript order. A sequential global mode or any sequential tool in the batch makes the entire batch sequential.

Nested `ctx.executeTool` calls reuse validation and permission/result hooks. They emit execution events with `parentToolCallId` but do not add independent transcript messages. Telemetry must distinguish nested calls from direct calls rather than assuming all execution IDs occur in history.

Example: tools A and B take 1s and 30s. A's execution-end event arrives at 1s, but the next assistant request waits until B finishes at 30s. Returning an operation ID promptly removes that wait only if the actual process is owned by a separate runtime.

## Session persistence

Sources: `session-manager.ts` (`SessionHeader`, `SessionEntryBase`, `_persist`, `_appendEntry`, `appendMessage`, `appendCustomEntry`, `appendCustomMessageEntry`, `appendContextEdit`) and `agent-session.ts` (`_handleAgentEvent`).

Sessions use versioned JSONL (current session version 3). Entries carry an ID, parent ID, and timestamp; appending advances the active leaf. Branching selects a different leaf without deleting abandoned history. Model context projects the active branch and applies compaction and append-only context edits.

Final `message_end` events persist system, user, assistant, tool-result, and custom messages. The first file flush waits for conversation content; later entries append synchronously. In-memory managers do not write files.

`pi.appendEntry` stores durable extension data excluded from model context. `pi.sendMessage` produces custom-message entries included in model context. Operation metadata/logs belong in a separate versioned store, associated with the launching session. Do not rewrite the initial running tool result when the process completes.

## Steering and follow-up semantics

Sources: `agent-loop.ts` (`runLoop`), `types.ts` (`QueueMode`, steering/follow-up contracts), and `agent-session.ts` (`sendCustomMessage`, `sendUserMessage`, `_flushPendingCustomMessages`).

Steering does not interrupt model streaming or skip sibling tools. It enters after the current batch. Follow-up waits until existing tool/steering work would otherwise end. Queue modes control one-at-a-time versus all-message draining.

`pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" })` can bridge operation completions: streaming sessions queue it; idle sessions start a new run. `deliverAs: "nextTurn"` alone does not wake an idle model. Non-triggering messages sent while streaming are deferred until the tool-result boundary to avoid placing a message between tool calls and results.

## Available extension hooks

Verified declarations: `packages/coding-agent/src/core/extensions/types.ts`. Documentation: `packages/coding-agent/docs/extensions.md`, `docs/sdk.md`; patterns: `examples/extensions/notify.ts`, `examples/sdk/06-extensions.ts`.

- Resource lifecycle: `session_start`, `session_shutdown` (quit/reload/new/resume/fork). Start resources only once a session/tool needs them; shut down idempotently.
- Run lifecycle: `before_agent_start`, `agent_start`, `agent_end`, `agent_before_settle`, `agent_settled`.
- Turns/messages: `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`.
- Execution and safety: `tool_call`, `tool_result`, `tool_execution_start/update/end`, `user_bash`.
- Provider/context: request/response hooks, read-only `provider_stream_event`, `context`, `context_with_system`.
- Registration: tools, commands, CLI flags, renderers, prompt contributions.
- Context: session manager, cwd, model, thinking level, signal, UI, nested tool execution.

`turn_end` and `agent_before_settle` can append validated boundary drafts and request continuation. `agent_settled` is notification-only. Extension handlers are awaited, so expensive telemetry on streaming events would directly increase latency.

## Bash behavior and safety boundary

`packages/coding-agent/src/core/tools/bash.ts` uses `spawn`, streamed combined stdout/stderr, an output accumulator, timeout validation, abort signals, and process-tree termination. POSIX children are detached process groups but are tracked for cleanup; detached here does not mean durable background operations. The tool promise still waits for process exit. Model-facing output is truncated; larger programmatic output also has a limit.

Bash supports configurable operations, command prefixes, shell selection, spawn hooks, and session environment metadata. A new tool name does not automatically inherit a permission extension's `toolName === "bash"` policy. Before async daily use, explicitly reuse the existing safety path or migrate the policy to cover async commands. The standalone runner must not silently bypass configured sandbox/remote Bash backends.

## Extension-only implementation path

1. Baseline: an explicit observation-only extension; no agent-loop changes or extra prompt tokens.
2. Runtime: independent operation types/store/manager, process ownership, bounded output, cancellation, timeouts, terminal-state invariants, recovery.
3. Integration: four public tools (`run_async`, status, output, cancel), short prompt guidance, session association.
4. Completion bridge: append compact custom messages through `sendMessage`, with persistent consumer bookkeeping and recoverable undelivered events. The public extension API returns void for sending: do not equate a send request with acknowledged durable delivery without inspecting the runner and session path.
5. Operator commands: `/ops`, `/op`, `/op-cancel` through existing command/UI APIs.

No core changes are required to begin these steps. Baseline instrumentation must work before runtime implementation begins.

## When core modification might be necessary

A completion queued while a synchronous tool batch is active cannot cause a model request until that batch finishes. Measure terminal-event creation time versus consumption in a model request. Only if repeated benchmark measurements show a material barrier should a separate core-loop experiment change scheduling. Preserve tool permission hooks, ordered tool-result history, streaming, abort, queues, provider compatibility, compaction, and existing synchronous behavior.

No core-loop prototype, branch creation, DAG scheduler, service readiness layer, or performance claim is justified by this first step.

## Milestone 0 measurement contract

Use `packages/coding-agent/examples/extensions/baseline-metrics.ts` explicitly. One run starts at the first `agent_start` and finishes at `agent_settled`; repeated low-level starts before settlement remain part of the same run. Shutdown before settlement emits an incomplete run rather than pretending it finished normally.

Count conversational model responses (including error/aborted responses) from finalized assistant messages, turns from `turn_start`, and tool attempts from execution events. Record direct and nested attempts separately in each tool row. Tool duration spans preflight through finalization, not just subprocess CPU time; summed durations may exceed wall time under parallel execution.

Provider-reported input, output, cache-read, and cache-write tokens are separate counters, not estimates. Conversational input follows Pi's `usage.input` convention; cache tokens are not silently added to it. Compaction, cache warming, and nested model requests are outside the conversational counters and must not be presented as total provider billing. This limitation must accompany benchmark comparisons.

Records are versioned and contain run/session/model identity, timestamps, monotonic durations, errors, and completion status. No prompt, command arguments, or raw tool output is persisted. Optional input/output sizes are omitted to avoid serializing large payloads solely for telemetry. Completed tool rows stream to disk; memory retains only active calls. Instrumentation failures are reported and invalidate collection rather than fabricating missing values.

import { delimiter, join, resolve } from "node:path";
import {
	LocalOperationManager,
	type Operation,
	type OperationOutputExcerpt,
	type OperationOutputOptions,
	readOperationOutput,
	type ShellOperationPayload,
	ShellOperationRunner,
	SQLiteOperationStore,
	validateShellOperationPayload,
} from "@earendil-works/pi-async-operations";
import {
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	getBinDir,
	getShellConfig,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { CompletionBridge } from "./completion-bridge.ts";

const OPERATION_KIND = "shell";
const MAX_OPERATION_ID_LENGTH = 36;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_PURPOSE_BYTES = 8 * 1024;
const MAX_OPERATION_TIMEOUT_MS = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const runAsyncSchema = Type.Object({
	command: Type.String({
		minLength: 1,
		maxLength: MAX_PAYLOAD_BYTES,
		pattern: "^[^\\u0000]+$",
		description: "Shell command to run asynchronously",
	}),
	purpose: Type.Optional(
		Type.String({
			maxLength: MAX_PURPOSE_BYTES,
			pattern: "^[^\\u0000]*$",
			description: "Short reason for running this command",
		}),
	),
	timeout_seconds: Type.Optional(
		Type.Number({
			minimum: 0.001,
			maximum: MAX_OPERATION_TIMEOUT_MS / 1000,
			description: "Optional command timeout in seconds",
		}),
	),
});

const operationIdSchema = Type.String({
	minLength: MAX_OPERATION_ID_LENGTH,
	maxLength: MAX_OPERATION_ID_LENGTH,
	pattern: UUID_PATTERN.source,
	description: "Operation UUID returned by run_async",
});

const operationStatusSchema = Type.Object({ operation_id: operationIdSchema });
const operationCancelSchema = Type.Object({ operation_id: operationIdSchema });
const operationOutputSchema = Type.Object({
	operation_id: operationIdSchema,
	stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("both")])),
	tail_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
	contains: Type.Optional(Type.String({ maxLength: 1024 })),
});

type RunAsyncParams = Static<typeof runAsyncSchema>;
type OperationOutputParams = Static<typeof operationOutputSchema>;

type SessionRuntime = {
	sessionId: string;
	rootDir: string;
	store: SQLiteOperationStore;
	manager: LocalOperationManager;
	shell: ShellOperationRunner;
	bridge: CompletionBridge;
};

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content?.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") ?? "";
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function uuidSessionId(context: ExtensionContext): string {
	const id = context.sessionManager.getSessionId();
	if (!UUID_PATTERN.test(id))
		throw new Error(
			"The current Pi session ID is not a valid UUID; asynchronous operations cannot be isolated safely.",
		);
	return id;
}

async function closeResources(runtime: SessionRuntime): Promise<void> {
	const errors: Error[] = [];
	try {
		await runtime.bridge.close();
	} catch (error) {
		errors.push(asError(error));
	}
	try {
		await runtime.manager.close();
	} catch (error) {
		errors.push(asError(error));
	}
	try {
		await runtime.shell.close();
	} catch (error) {
		errors.push(asError(error));
	}
	try {
		await runtime.store.close();
	} catch (error) {
		errors.push(asError(error));
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Failed to close the async operation session runtime");
}

async function createRuntime(context: ExtensionContext, pi: ExtensionAPI): Promise<SessionRuntime> {
	const sessionId = uuidSessionId(context);
	const rootDir = resolve(context.cwd, ".pi", "async", sessionId);
	const store = new SQLiteOperationStore(join(rootDir, "operations.sqlite"));
	let shell: ShellOperationRunner | undefined;
	let manager: LocalOperationManager | undefined;
	let bridge: CompletionBridge | undefined;
	try {
		shell = new ShellOperationRunner({ rootDir });
		manager = await LocalOperationManager.open({
			store,
			runners: { [OPERATION_KIND]: shell },
			maxConcurrentJobs: 4,
			onError: (error) => context.ui.notify(`Async operation runtime error: ${error.message}`, "error"),
		});
		bridge = new CompletionBridge({ pi, context, manager, rootDir, sessionId });
		bridge.start();
		return { sessionId, rootDir, store, manager, shell, bridge };
	} catch (error) {
		const failures = [asError(error)];
		if (bridge) {
			try {
				await bridge.close();
			} catch (closeError) {
				failures.push(asError(closeError));
			}
		}
		if (manager) {
			try {
				await manager.close();
			} catch (closeError) {
				failures.push(asError(closeError));
			}
		}
		if (shell) {
			try {
				await shell.close();
			} catch (closeError) {
				failures.push(asError(closeError));
			}
		}
		try {
			await store.close();
		} catch (closeError) {
			failures.push(asError(closeError));
		}
		if (failures.length === 1) throw failures[0];
		throw new AggregateError(failures, "Opening the async operation session runtime failed");
	}
}

export function createAsyncPiExtension(pi: ExtensionAPI): void {
	let activeRuntime: SessionRuntime | undefined;
	let openingRuntime: Promise<SessionRuntime> | undefined;

	const closeSessionRuntime = async (): Promise<void> => {
		const pending = openingRuntime;
		if (pending) {
			try {
				const opened = await pending;
				if (activeRuntime === opened) activeRuntime = undefined;
				await closeResources(opened);
			} catch (error) {
				// A failed open performs its own cleanup; still close any separately active runtime.
				const current = activeRuntime;
				activeRuntime = undefined;
				if (current) {
					try {
						await closeResources(current);
					} catch (closeError) {
						throw new AggregateError([asError(error), asError(closeError)], "Async runtime shutdown failed");
					}
				}
				throw error;
			} finally {
				if (openingRuntime === pending) openingRuntime = undefined;
			}
		}

		const current = activeRuntime;
		activeRuntime = undefined;
		if (current) await closeResources(current);
	};

	const runtimeFor = async (context: ExtensionContext): Promise<SessionRuntime> => {
		const sessionId = uuidSessionId(context);
		if (activeRuntime?.sessionId === sessionId) return activeRuntime;
		if (openingRuntime) {
			const pending = openingRuntime;
			const opened = await pending;
			if (opened.sessionId === sessionId) return opened;
		}
		if (activeRuntime) await closeSessionRuntime();
		const pending = createRuntime(context, pi);
		openingRuntime = pending;
		try {
			const opened = await pending;
			activeRuntime = opened;
			return opened;
		} finally {
			if (openingRuntime === pending) openingRuntime = undefined;
		}
	};

	const requireCurrentOperation = async (
		context: ExtensionToolContext,
		operationId: string,
	): Promise<{ runtime: SessionRuntime; operation: Operation; payload: ShellOperationPayload }> => {
		const runtime = await runtimeFor(context);
		const operation = await runtime.manager.get(operationId);
		if (!operation || operation.sessionId !== runtime.sessionId || operation.kind !== OPERATION_KIND) {
			throw new Error(`Operation ${operationId} was not found in the current session.`);
		}
		if (typeof operation.payload !== "object" || operation.payload === null || Array.isArray(operation.payload)) {
			throw new Error(`Operation ${operationId} has an invalid shell payload.`);
		}
		return { runtime, operation, payload: operation.payload as ShellOperationPayload };
	};

	const runAsync: ToolDefinition<typeof runAsyncSchema> = {
		name: "run_async",
		label: "Run Async",
		description:
			"Run a shell command as a persistent asynchronous operation and return its operation ID immediately.",
		promptSnippet:
			"Run a long-running shell command asynchronously and inspect its status or bounded output when needed.",
		promptGuidelines: [
			"Use run_async for shell work expected to take several seconds or longer that can proceed while you inspect or change other files; use normal bash when you need its result before reasoning further.",
			"Do not repeatedly poll a running operation. Terminal results automatically trigger a compact session notification; check operation_status or operation_output only when progress or full output is needed.",
		],
		parameters: runAsyncSchema,
		async execute(_toolCallId, params: RunAsyncParams, signal, _onUpdate, context) {
			if (signal?.aborted) throw new Error("Asynchronous execution was aborted before the command was submitted.");
			const bash = pi.getAllTools().find((tool) => tool.name === "bash");
			if (!bash || bash.sourceInfo.source !== "builtin") {
				throw new Error(
					"run_async requires Pi's built-in bash tool; refusing to bypass a custom or sandboxed Bash implementation.",
				);
			}
			if (!context.tools.some((tool) => tool.name === "bash")) {
				throw new Error("run_async requires the built-in bash tool to be callable in this session.");
			}

			const settings = pi.getSettings();
			const shellConfig = getShellConfig(settings.shellPath);
			const runtime = await runtimeFor(context);
			const submittedCommand = settings.shellCommandPrefix
				? `${settings.shellCommandPrefix}\n${params.command}`
				: params.command;
			const env = shellPathEnvironment();
			let submitted: Operation | undefined;

			const outcome = await context.executeTool(
				"bash",
				{
					command: submittedCommand,
					...(params.timeout_seconds === undefined ? {} : { timeout: params.timeout_seconds }),
				},
				{
					signal,
					execute: async (_nestedToolCallId, validatedArgs, nestedSignal) => {
						if (nestedSignal?.aborted) {
							throw new Error("Asynchronous execution was aborted before the command was submitted.");
						}
						if (!isBashArguments(validatedArgs)) {
							throw new Error("Pi's bash tool returned unexpected validated arguments.");
						}
						const timeoutMs =
							validatedArgs.timeout === undefined ? undefined : Math.round(validatedArgs.timeout * 1000);
						const payload: ShellOperationPayload = {
							version: 1,
							command: validatedArgs.command,
							cwd: context.cwd,
							...(params.purpose === undefined ? {} : { purpose: params.purpose }),
							...(timeoutMs === undefined ? {} : { timeoutMs }),
							shell: {
								executable: shellConfig.shell,
								args: [...shellConfig.args],
								...(shellConfig.commandTransport === undefined
									? {}
									: { commandTransport: shellConfig.commandTransport }),
							},
							...(env ? { env } : {}),
						};
						validateShellOperationPayload(payload);
						if (nestedSignal?.aborted || signal?.aborted) {
							throw new Error("Asynchronous execution was aborted before the command was submitted.");
						}
						submitted = await runtime.manager.submit({
							kind: OPERATION_KIND,
							payload,
							sessionId: runtime.sessionId,
						});
						return textResult(`Queued operation ${submitted.id}.`);
					},
				},
			);

			if (outcome.isError) {
				throw new Error(textOf(outcome.result) || "The nested bash call was blocked or failed.");
			}
			if (!submitted) throw new Error("The asynchronous shell operation was not submitted.");
			return textResult(
				[
					`Operation ID: ${submitted.id}`,
					"Status: queued",
					...(params.purpose ? [`Purpose: ${compactText(params.purpose, 512)}`] : []),
					"Command:",
					compactText((submitted.payload as ShellOperationPayload).command, 2048),
					"An automatic terminal notification will be sent when this operation finishes.",
				].join("\n"),
			);
		},
	};

	const operationStatus: ToolDefinition<typeof operationStatusSchema> = {
		name: "operation_status",
		label: "Operation Status",
		description: "Get the state and compact execution details for one asynchronous operation.",
		parameters: operationStatusSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			const { operation, payload } = await requireCurrentOperation(context, params.operation_id);
			const startedAt = operation.startedAt;
			const duration =
				startedAt === undefined
					? operation.completedAt === undefined
						? "not started"
						: `${formatDuration(operation.completedAt - operation.createdAt)} (never started)`
					: formatDuration((operation.completedAt ?? Date.now()) - startedAt);
			const lines = [
				`Operation: ${operation.id}`,
				`Status: ${operation.state}`,
				`Created: ${formatTimestamp(operation.createdAt)}`,
				`Started: ${startedAt === undefined ? "—" : formatTimestamp(startedAt)}`,
				`Completed: ${operation.completedAt === undefined ? "—" : formatTimestamp(operation.completedAt)}`,
				`Duration: ${duration}`,
				...(payload.purpose ? [`Purpose: ${compactText(payload.purpose, 512)}`] : []),
				`Command: ${compactText(payload.command, 2048)}`,
			];
			if (operation.result?.exitCode !== undefined) lines.push(`Exit code: ${operation.result.exitCode}`);
			if (operation.result?.failureKind) lines.push(`Failure kind: ${operation.result.failureKind}`);
			if (operation.result?.error) lines.push(`Error: ${compactText(operation.result.error, 2048)}`);
			return textResult(lines.join("\n"));
		},
	};

	const operationOutput: ToolDefinition<typeof operationOutputSchema> = {
		name: "operation_output",
		label: "Operation Output",
		description: "Read a bounded tail or literal-substring match from an operation's stdout and/or stderr.",
		parameters: operationOutputSchema,
		async execute(_toolCallId, params: OperationOutputParams, _signal, _onUpdate, context) {
			const { runtime } = await requireCurrentOperation(context, params.operation_id);
			if (params.contains !== undefined && Buffer.byteLength(params.contains, "utf8") > 1024) {
				throw new Error("The contains filter must be at most 1024 UTF-8 bytes.");
			}
			const options: OperationOutputOptions = {
				...(params.stream === undefined ? {} : { stream: params.stream }),
				...(params.tail_lines === undefined ? {} : { tailLines: params.tail_lines }),
				...(params.contains === undefined ? {} : { contains: params.contains }),
			};
			const excerpts = await readOperationOutput(runtime.rootDir, params.operation_id, options);
			return textResult(
				excerpts.map((excerpt) => formatExcerpt(excerpt, params.contains !== undefined)).join("\n\n"),
			);
		},
	};

	const operationCancel: ToolDefinition<typeof operationCancelSchema> = {
		name: "operation_cancel",
		label: "Cancel Operation",
		description: "Cancel a pending or running asynchronous operation; terminal operations are left unchanged.",
		parameters: operationCancelSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			const { runtime, operation } = await requireCurrentOperation(context, params.operation_id);
			if (operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled") {
				return textResult(`Operation ${operation.id} is already ${operation.state}; no cancellation was needed.`);
			}
			await runtime.manager.cancel(operation.id);
			const updated = await runtime.manager.get(operation.id);
			return textResult(
				updated?.state === "cancelled"
					? `Operation ${operation.id} was cancelled.`
					: `Cancellation requested for operation ${operation.id}; current status: ${updated?.state ?? "unknown"}.`,
			);
		},
	};

	pi.on("session_start", async (_event, context) => {
		await closeSessionRuntime();
		await runtimeFor(context);
	});
	pi.on("session_shutdown", async () => {
		await closeSessionRuntime();
	});

	pi.registerTool(runAsync);
	pi.registerTool(operationStatus);
	pi.registerTool(operationOutput);
	pi.registerTool(operationCancel);
}

function shellPathEnvironment(): Record<string, string> | undefined {
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const path = process.env[pathKey] ?? "";
	const binDir = getBinDir();
	const entries = path.split(delimiter).filter(Boolean);
	if (entries.includes(binDir)) return undefined;
	return { [pathKey]: [binDir, path].filter(Boolean).join(delimiter) };
}

function isBashArguments(value: unknown): value is { command: string; timeout?: number } {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).command === "string" &&
		((value as Record<string, unknown>).timeout === undefined ||
			typeof (value as Record<string, unknown>).timeout === "number")
	);
}

function compactText(text: string, maxBytes: number): string {
	const encoded = Buffer.from(text, "utf8");
	if (encoded.byteLength <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
	return `${encoded.subarray(0, end).toString("utf8")} [truncated]`;
}

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function formatDuration(milliseconds: number): string {
	if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
	return `${(milliseconds / 1000).toFixed(1)}s`;
}

function formatExcerpt(excerpt: OperationOutputExcerpt, filtered: boolean): string {
	const notes = [`${excerpt.bytes} bytes total`, `${excerpt.scannedBytes} bytes scanned`];
	if (excerpt.truncated) notes.push("excerpt truncated");
	if (excerpt.missing) notes.push("not available yet");
	const body = excerpt.missing
		? "(output file is not available yet)"
		: excerpt.text || (filtered ? "(no matching lines in the bounded scan)" : "(no output)");
	return `--- ${excerpt.stream} (${notes.join("; ")}) ---\n${body}`;
}

export default createAsyncPiExtension;

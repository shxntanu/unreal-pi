import { type ChildProcess, spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import type { ShellOperationPayload } from "./shell-types.ts";
import type { Operation, OperationResult, OperationRunnerContext } from "./types.ts";
import { validateOperationId } from "./validation.ts";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_TAIL_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 1024 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_GRACE_MS = 250;
const DEFAULT_MAX_LOG_BYTES = 128 * 1024 * 1024;
const MAX_GRACE_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const PIPE_CLOSE_TIMEOUT_MS = 5_000;

export type ShellOperationRunnerOptions = {
	rootDir: string;
	tailBytes?: number;
	graceMs?: number;
	maxLogBytes?: number;
};

type FailureKind = "runtime_error" | "timeout" | "cancelled" | "nonzero_exit";
type StopKind = "runtime_error" | "timeout" | "cancelled";
type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
type StopCause = { kind: StopKind; error?: Error };

type JobControl = {
	stop: (kind: StopKind, error?: Error) => void;
	done: Promise<OperationResult>;
};

type LogFile = { file: WriteStream; done: Promise<void> };
type CapturedOutput = { input: Readable; completed: Promise<void>; closeInput: () => void };

type RunState = {
	child?: ChildProcess;
	pid?: number;
	spawned: boolean;
	leaderExited: boolean;
	exit?: ExitInfo;
	stopCause?: StopCause;
	failure?: Error;
	cleanupError?: Error;
	cleanupPromise?: Promise<void>;
	timeout?: NodeJS.Timeout;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function ownDataValue(record: Record<string, unknown>, key: string, label: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
		throw new TypeError(`${label} must be an enumerable JSON data property`);
	}
	return descriptor.value;
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Reflect.ownKeys(record)) {
		if (typeof key !== "string" || !allowed.includes(key))
			throw new TypeError(`${label} contains an unsupported property`);
		ownDataValue(record, key, label);
	}
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0")) {
		throw new TypeError(
			`${label} must be ${allowEmpty ? "a string without NUL bytes" : "a non-empty string without NUL bytes"}`,
		);
	}
	return value;
}

function requireStringBytes(value: string, label: string, maximum: number, allowEmpty = false): string {
	if ((!allowEmpty && value.length === 0) || Buffer.byteLength(value, "utf8") > maximum) {
		throw new TypeError(
			`${label} must be ${allowEmpty ? "at most" : "a non-empty value of at most"} ${maximum} UTF-8 bytes`,
		);
	}
	return value;
}

type JsonObjectSize = { bytes: number; fields: number };

function addJsonProperty(size: JsonObjectSize, key: string, valueBytes: number): void {
	size.bytes += (size.fields === 0 ? 0 : 1) + Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + valueBytes;
	size.fields++;
}

/** Strictly validates the versioned JSON shell payload before it can be persisted or spawned. */
export function validateShellOperationPayload(value: unknown): asserts value is ShellOperationPayload {
	if (!isRecord(value)) throw new TypeError("Shell operation payload must be a plain JSON object");
	assertKeys(value, ["version", "command", "cwd", "env", "timeoutMs", "purpose", "shell"], "Shell operation payload");
	if (ownDataValue(value, "version", "Shell operation payload") !== 1)
		throw new TypeError("Shell operation payload version must be 1");

	const size: JsonObjectSize = { bytes: 2, fields: 0 };
	addJsonProperty(size, "version", 1);
	const command = requireStringBytes(
		requireString(ownDataValue(value, "command", "Shell operation payload"), "Shell command"),
		"Shell command",
		MAX_PAYLOAD_BYTES,
	);
	const cwd = requireStringBytes(
		requireString(ownDataValue(value, "cwd", "Shell operation payload"), "Shell cwd"),
		"Shell cwd",
		MAX_PAYLOAD_BYTES,
	);
	addJsonProperty(size, "command", Buffer.byteLength(JSON.stringify(command), "utf8"));
	addJsonProperty(size, "cwd", Buffer.byteLength(JSON.stringify(cwd), "utf8"));

	if (Object.hasOwn(value, "purpose")) {
		const purpose = requireStringBytes(
			requireString(ownDataValue(value, "purpose", "Shell operation payload"), "Shell purpose", true),
			"Shell purpose",
			MAX_TEXT_BYTES,
			true,
		);
		addJsonProperty(size, "purpose", Buffer.byteLength(JSON.stringify(purpose), "utf8"));
	}
	if (Object.hasOwn(value, "timeoutMs")) {
		const timeoutMs = ownDataValue(value, "timeoutMs", "Shell operation payload");
		if (
			typeof timeoutMs !== "number" ||
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > MAX_TIMEOUT_MS
		) {
			throw new TypeError(`Shell timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
		}
		addJsonProperty(size, "timeoutMs", Buffer.byteLength(String(timeoutMs), "utf8"));
	}

	if (Object.hasOwn(value, "env")) {
		const inputEnv = ownDataValue(value, "env", "Shell operation payload");
		if (!isRecord(inputEnv)) throw new TypeError("Shell env must be a plain JSON object");
		assertKeys(inputEnv, Object.keys(inputEnv), "Shell env");
		const entries = Object.entries(inputEnv);
		if (entries.length > 256) throw new TypeError("Shell env may contain at most 256 entries");
		const envSize: JsonObjectSize = { bytes: 2, fields: 0 };
		let envBytes = 0;
		for (const [key, rawValue] of entries) {
			if (key.length === 0 || key.includes("=") || key.includes("\0"))
				throw new TypeError("Shell env keys must be non-empty and contain neither '=' nor NUL bytes");
			const envValue = requireString(rawValue, `Shell env value for ${key}`, true);
			envBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(envValue, "utf8");
			if (envBytes > MAX_PAYLOAD_BYTES) throw new TypeError("Shell env exceeds the payload size limit");
			addJsonProperty(envSize, key, Buffer.byteLength(JSON.stringify(envValue), "utf8"));
		}
		addJsonProperty(size, "env", envSize.bytes);
	}

	if (Object.hasOwn(value, "shell")) {
		const inputShell = ownDataValue(value, "shell", "Shell operation payload");
		if (!isRecord(inputShell)) throw new TypeError("Shell configuration must be a plain JSON object");
		assertKeys(inputShell, ["executable", "args", "commandTransport"], "Shell configuration");
		const shellSize: JsonObjectSize = { bytes: 2, fields: 0 };
		const executable = requireStringBytes(
			requireString(ownDataValue(inputShell, "executable", "Shell configuration"), "Shell executable"),
			"Shell executable",
			8 * 1024,
		);
		addJsonProperty(shellSize, "executable", Buffer.byteLength(JSON.stringify(executable), "utf8"));
		const rawArgs = ownDataValue(inputShell, "args", "Shell configuration");
		if (!Array.isArray(rawArgs) || Object.getPrototypeOf(rawArgs) !== Array.prototype || rawArgs.length > 128) {
			throw new TypeError("Shell args must be a JSON array with at most 128 entries");
		}
		let argsBytes = 2;
		for (let index = 0; index < rawArgs.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(rawArgs, String(index));
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
				throw new TypeError("Shell args must not contain holes, accessors, or non-JSON entries");
			const argument = requireStringBytes(
				requireString(descriptor.value, `Shell argument ${index}`, true),
				`Shell argument ${index}`,
				8 * 1024,
				true,
			);
			argsBytes += (index === 0 ? 0 : 1) + Buffer.byteLength(JSON.stringify(argument), "utf8");
		}
		for (const key of Reflect.ownKeys(rawArgs)) {
			if (
				key !== "length" &&
				(typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= rawArgs.length)
			) {
				throw new TypeError("Shell args must be a plain JSON array");
			}
		}
		addJsonProperty(shellSize, "args", argsBytes);
		if (Object.hasOwn(inputShell, "commandTransport")) {
			const transport = ownDataValue(inputShell, "commandTransport", "Shell configuration");
			if (transport !== "argv" && transport !== "stdin")
				throw new TypeError("Shell commandTransport must be 'argv' or 'stdin'");
			addJsonProperty(shellSize, "commandTransport", Buffer.byteLength(JSON.stringify(transport), "utf8"));
		}
		addJsonProperty(size, "shell", shellSize.bytes);
	}

	if (size.bytes > MAX_PAYLOAD_BYTES) throw new TypeError("Shell operation payload exceeds 256 KiB");
}

function clonePayload(value: ShellOperationPayload): ShellOperationPayload {
	return {
		version: 1,
		command: value.command,
		cwd: value.cwd,
		...(value.env === undefined ? {} : { env: { ...value.env } }),
		...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
		...(value.purpose === undefined ? {} : { purpose: value.purpose }),
		...(value.shell === undefined
			? {}
			: {
					shell: {
						executable: value.shell.executable,
						args: [...value.shell.args],
						...(value.shell.commandTransport === undefined
							? {}
							: { commandTransport: value.shell.commandTransport }),
					},
				}),
	};
}

function validateOperation(operation: Operation): ShellOperationPayload {
	if (typeof operation !== "object" || operation === null || operation.version !== 1 || operation.kind !== "shell") {
		throw new TypeError("ShellOperationRunner only accepts version-1 operations of kind 'shell'");
	}
	validateOperationId(operation.id);
	validateShellOperationPayload(operation.payload);
	return clonePayload(operation.payload);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function limitUtf8(value: string, maximum: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maximum) return value;
	let end = maximum;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function formatTailLines(bytes: Buffer, maxLines: number, maxBytes: number): string {
	const lines = bytes.toString("utf8").split(/\r?\n/).slice(-maxLines);
	return limitUtf8(lines.join("\n").replace(/[\u0000-\u001f\u007f]/g, " "), maxBytes);
}
function sanitizeText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

class ByteTail {
	private readonly bytes: Buffer;
	private length = 0;
	private next = 0;

	constructor(capacity: number) {
		this.bytes = Buffer.alloc(capacity);
	}

	push(chunk: Buffer): void {
		if (chunk.length >= this.bytes.length) {
			chunk.copy(this.bytes, 0, chunk.length - this.bytes.length);
			this.length = this.bytes.length;
			this.next = 0;
			return;
		}
		const firstLength = Math.min(chunk.length, this.bytes.length - this.next);
		chunk.copy(this.bytes, this.next, 0, firstLength);
		if (firstLength < chunk.length) chunk.copy(this.bytes, 0, firstLength);
		this.next = (this.next + chunk.length) % this.bytes.length;
		this.length = Math.min(this.length + chunk.length, this.bytes.length);
	}

	toBuffer(): Buffer {
		if (this.length < this.bytes.length) return Buffer.from(this.bytes.subarray(0, this.length));
		const result = Buffer.alloc(this.length);
		const firstLength = this.bytes.length - this.next;
		this.bytes.copy(result, 0, this.next);
		if (firstLength < this.length) this.bytes.copy(result, firstLength, 0, this.next);
		return result;
	}
}

class OutputReporter {
	private pending = 0;
	private pumping?: Promise<void>;
	private failure?: Error;
	private readonly stream: "stdout" | "stderr";
	private readonly report: OperationRunnerContext["reportOutput"];
	private readonly onFailure: (error: Error) => void;

	constructor(
		stream: "stdout" | "stderr",
		report: OperationRunnerContext["reportOutput"],
		onFailure: (error: Error) => void,
	) {
		this.stream = stream;
		this.report = report;
		this.onFailure = onFailure;
	}

	add(byteCount: number): void {
		if (this.failure) return;
		this.pending += byteCount;
		this.start();
	}

	async drain(): Promise<void> {
		while (this.pumping) await this.pumping;
		if (this.failure) throw this.failure;
	}

	private start(): void {
		if (this.pumping || this.failure || this.pending === 0) return;
		this.pumping = this.flush()
			.catch((error: unknown) => {
				this.failure = toError(error);
				this.onFailure(this.failure);
			})
			.finally(() => {
				this.pumping = undefined;
				this.start();
			});
	}

	private async flush(): Promise<void> {
		while (this.pending > 0) {
			const byteCount = this.pending;
			this.pending = 0;
			await this.report(this.stream, byteCount);
		}
	}
}

function sleep(milliseconds: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, milliseconds);
	return promise;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (errorCode(error) !== "ESRCH") throw error;
	}
}

function groupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}

async function cleanupPosixGroup(pid: number, graceMs: number): Promise<void> {
	if (!groupExists(pid)) return;
	let failure: Error | undefined;
	try {
		signalGroup(pid, "SIGTERM");
	} catch (error) {
		failure = toError(error);
	}
	await sleep(graceMs);
	try {
		signalGroup(pid, "SIGKILL");
	} catch (error) {
		failure = failure
			? new AggregateError([failure, toError(error)], "Could not kill the shell process group")
			: toError(error);
	}
	const deadline = performance.now() + Math.max(1_000, graceMs * 4);
	while (groupExists(pid) && performance.now() < deadline) await sleep(20);
	if (groupExists(pid)) {
		const lingering = new Error(`Shell process group ${pid} remained after SIGKILL`);
		failure = failure ? new AggregateError([failure, lingering], "Shell process group cleanup failed") : lingering;
	}
	if (failure) throw failure;
}

async function invokeTaskkill(taskkillPath: string, pid: number, force: boolean): Promise<number | null> {
	const { promise, resolve, reject } = Promise.withResolvers<number | null>();
	let helper: ChildProcess;
	try {
		helper = spawn(taskkillPath, ["/T", "/PID", String(pid), ...(force ? ["/F"] : [])], {
			stdio: "ignore",
			windowsHide: true,
		});
	} catch (error) {
		reject(error);
		return promise;
	}
	let settled = false;
	let killTimer: NodeJS.Timeout | undefined;
	const finish = (code: number | null): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		clearTimeout(killTimer);
		resolve(code);
	};
	const fail = (error: Error): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		clearTimeout(killTimer);
		reject(error);
	};
	const timer = setTimeout(() => {
		try {
			helper.kill();
			killTimer = setTimeout(() => fail(new Error("taskkill helper did not exit after termination")), 1_000);
		} catch (error) {
			fail(toError(error));
		}
	}, 5_000);
	helper.once("error", fail);
	helper.once("close", (code) => finish(code));
	return promise;
}

async function cleanupWindowsTree(pid: number, graceMs: number): Promise<void> {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot) throw new Error("SystemRoot is unavailable; cannot clean up the Windows shell process tree");
	const taskkillPath = join(systemRoot, "System32", "taskkill.exe");
	let gracefulFailure: Error | undefined;
	try {
		const gracefulCode = await invokeTaskkill(taskkillPath, pid, false);
		if (gracefulCode === null)
			gracefulFailure = new Error("taskkill did not finish during graceful process-tree cleanup");
	} catch (error) {
		gracefulFailure = toError(error);
	}
	await sleep(graceMs);
	try {
		const forcedCode = await invokeTaskkill(taskkillPath, pid, true);
		if (forcedCode === null) throw new Error("taskkill did not finish during forced process-tree cleanup");
		if (processIsAlive(pid))
			throw new Error(`taskkill /T /PID /F did not stop process ${pid} (exit code ${forcedCode})`);
	} catch (error) {
		const forcedFailure = toError(error);
		throw gracefulFailure
			? new AggregateError([gracefulFailure, forcedFailure], "Windows process-tree cleanup failed")
			: forcedFailure;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}

async function cleanupProcessTree(pid: number, graceMs: number): Promise<void> {
	if (process.platform === "win32") await cleanupWindowsTree(pid, graceMs);
	else await cleanupPosixGroup(pid, graceMs);
}

function makeMetadata(input: {
	pid?: number;
	startedAt: number;
	completedAt: number;
	durationMs: number;
	stdoutBytes: number;
	stderrBytes: number;
	exit?: ExitInfo;
	failureKind?: FailureKind;
	stdoutTail: Buffer;
	stderrTail: Buffer;
}): Record<string, unknown> {
	return {
		version: 1,
		pid: input.pid ?? null,
		ownerPid: process.pid,
		startedAt: input.startedAt,
		completedAt: input.completedAt,
		durationMs: input.durationMs,
		stdoutBytes: input.stdoutBytes,
		stderrBytes: input.stderrBytes,
		exitCode: input.exit?.code ?? null,
		signal: input.exit?.signal ?? null,
		...(input.failureKind === undefined ? {} : { failureKind: input.failureKind }),
		tailEncoding: "base64",
		stdoutTail: input.stdoutTail.toString("base64"),
		stderrTail: input.stderrTail.toString("base64"),
	};
}

function makeSummary(
	exit: ExitInfo | undefined,
	durationMs: number,
	stdoutTail: Buffer,
	stderrTail: Buffer,
	failureKind: FailureKind | undefined,
): string {
	const label = failureKind ?? (exit?.code === 0 ? "completed" : "failed");
	const exitText = exit?.code === null || exit?.code === undefined ? "unknown" : String(exit.code);
	const signalText = exit?.signal ? `, signal=${exit.signal}` : "";
	const stdout = formatTailLines(stdoutTail, 20, 3 * 1024);
	const stderr = formatTailLines(stderrTail, 20, 3 * 1024);
	return limitUtf8(
		sanitizeText(
			`${label}: exit=${exitText}${signalText}, durationMs=${durationMs}\nstdout (last lines):\n${stdout}\nstderr (last lines):\n${stderr}`,
		),
		MAX_TEXT_BYTES,
	);
}

async function openLogFile(path: string): Promise<LogFile> {
	const handle: FileHandle = await open(path, "wx", 0o600);
	const file = handle.createWriteStream({ autoClose: true });
	const { promise: done, resolve, reject } = Promise.withResolvers<void>();
	file.once("finish", resolve);
	file.once("error", reject);
	file.once("close", () => {
		if (!file.writableFinished) reject(new Error(`Log file closed before flush completed: ${path}`));
	});
	void done.catch(() => undefined);
	return { file, done };
}

function bindCapture(
	input: Readable,
	file: WriteStream,
	tail: ByteTail,
	reporter: OutputReporter,
	isStdout: boolean,
	maxLogBytes: number,
	counts: { stdout: number; stderr: number; written: number },
	onFailure: (error: unknown) => void,
): CapturedOutput {
	let inputEnded = false;
	let limitReported = false;
	const { promise: completed, resolve: resolveCompleted } = Promise.withResolvers<void>();
	input.on("data", (rawChunk: Buffer | string) => {
		const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
		if (chunk.length === 0) return;
		tail.push(chunk);
		if (isStdout) counts.stdout += chunk.length;
		else counts.stderr += chunk.length;
		reporter.add(chunk.length);
		const available = Math.max(0, maxLogBytes - counts.written);
		const toWrite = Math.min(chunk.length, available);
		if (toWrite > 0) {
			counts.written += toWrite;
			try {
				if (!file.write(toWrite === chunk.length ? chunk : chunk.subarray(0, toWrite))) input.pause();
			} catch (error) {
				onFailure(error);
			}
		}
		if (toWrite < chunk.length && !limitReported) {
			limitReported = true;
			onFailure(new Error(`Shell log limit exceeded (${maxLogBytes} combined bytes)`));
		}
	});
	input.once("end", () => {
		inputEnded = true;
		file.end();
		resolveCompleted();
	});
	input.once("close", () => {
		if (!inputEnded) {
			inputEnded = true;
			if (!file.writableEnded && !file.destroyed) file.end();
		}
		resolveCompleted();
	});
	input.on("error", onFailure);
	file.once("error", (error) => {
		onFailure(error);
		input.destroy();
	});
	file.on("drain", () => {
		if (!inputEnded) input.resume();
	});
	return {
		input,
		completed,
		closeInput: () => {
			if (!inputEnded && !input.destroyed) input.destroy();
			if (!file.writableEnded && !file.destroyed) file.end();
		},
	};
}

function waitForCaptures(captures: readonly CapturedOutput[], timeoutMs: number): Promise<boolean> {
	if (captures.length === 0) return Promise.resolve(true);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), timeoutMs);
	void Promise.all(captures.map((capture) => capture.completed)).then(() => {
		clearTimeout(timer);
		resolve(true);
	});
	return promise;
}

const registeredRunners = new Set<ShellOperationRunner>();
let signalShutdown: Promise<void> | undefined;
let installedHooks:
	| {
			beforeExit: () => void;
			signals: Map<NodeJS.Signals, () => void>;
	  }
	| undefined;

function reportShutdownError(error: unknown): void {
	process.exitCode = 1;
	console.error("ShellOperationRunner shutdown failed:", toError(error));
}

function removeShutdownHooks(): void {
	if (registeredRunners.size !== 0 || !installedHooks) return;
	process.removeListener("beforeExit", installedHooks.beforeExit);
	for (const [signal, handler] of installedHooks.signals) process.removeListener(signal, handler);
	installedHooks = undefined;
}

async function closeRegisteredRunners(): Promise<void> {
	const results = await Promise.allSettled([...registeredRunners].map((runner) => runner.close()));
	const failures = results.flatMap((result) => (result.status === "rejected" ? [toError(result.reason)] : []));
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Shell runners failed to close");
}

function registerRunner(runner: ShellOperationRunner): void {
	registeredRunners.add(runner);
	if (installedHooks) return;
	const beforeExit = (): void => {
		void closeRegisteredRunners().catch(reportShutdownError);
	};
	const signals = new Map<NodeJS.Signals, () => void>();
	for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
		const handler = (): void => {
			if (signalShutdown) return;
			const shutdown = closeRegisteredRunners()
				.then(() => {
					process.kill(process.pid, signal);
				})
				.catch((error: unknown) => {
					reportShutdownError(error);
				})
				.finally(() => {
					signalShutdown = undefined;
				});
			signalShutdown = shutdown;
		};
		signals.set(signal, handler);
		process.on(signal, handler);
	}
	process.on("beforeExit", beforeExit);
	installedHooks = { beforeExit, signals };
}

export class ShellOperationRunner {
	private readonly rootDir: string;
	private readonly tailBytes: number;
	private readonly graceMs: number;
	private readonly maxLogBytes: number;
	private readonly active = new Map<string, JobControl>();
	private closed = false;
	private closePromise?: Promise<void>;

	constructor(options: ShellOperationRunnerOptions) {
		if (
			!options ||
			typeof options !== "object" ||
			typeof options.rootDir !== "string" ||
			options.rootDir.length === 0 ||
			options.rootDir.includes("\0")
		) {
			throw new TypeError("rootDir must be a non-empty path without NUL bytes");
		}
		this.rootDir = resolve(options.rootDir);
		this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
		this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
		this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
		if (!Number.isSafeInteger(this.tailBytes) || this.tailBytes < 1 || this.tailBytes > MAX_TAIL_BYTES) {
			throw new RangeError(`tailBytes must be an integer from 1 to ${MAX_TAIL_BYTES}`);
		}
		if (!Number.isSafeInteger(this.graceMs) || this.graceMs < 0 || this.graceMs > MAX_GRACE_MS) {
			throw new RangeError(`graceMs must be an integer from 0 to ${MAX_GRACE_MS}`);
		}
		if (!Number.isSafeInteger(this.maxLogBytes) || this.maxLogBytes < 1 || this.maxLogBytes > MAX_LOG_BYTES) {
			throw new RangeError(`maxLogBytes must be an integer from 1 to ${MAX_LOG_BYTES}`);
		}
		registerRunner(this);
	}

	run(operation: Operation, context: OperationRunnerContext): Promise<OperationResult> {
		if (this.closed) return Promise.reject(new Error("ShellOperationRunner is closed"));
		const payload = validateOperation(operation);
		if (
			!context ||
			typeof context !== "object" ||
			!context.signal ||
			typeof context.signal.addEventListener !== "function" ||
			typeof context.signal.removeEventListener !== "function" ||
			typeof context.reportOutput !== "function"
		) {
			throw new TypeError("Invalid shell operation runner context");
		}
		if (this.active.has(operation.id)) throw new Error(`Shell operation ${operation.id} is already running`);
		const state: RunState = { spawned: false, leaderExited: false };
		const done = this.execute(operation.id, payload, context, state);
		const job: JobControl = { stop: (kind, error) => this.requestStop(state, kind, error), done };
		this.active.set(operation.id, job);
		void done
			.finally(() => {
				if (this.active.get(operation.id) === job) this.active.delete(operation.id);
			})
			.catch(() => undefined);
		return done;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		for (const job of this.active.values()) job.stop("cancelled");
		this.closePromise = (async () => {
			const results = await Promise.allSettled([...this.active.values()].map((job) => job.done));
			const failures = results.flatMap((result) => (result.status === "rejected" ? [toError(result.reason)] : []));
			registeredRunners.delete(this);
			removeShutdownHooks();
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Closing shell operations failed");
		})();
		return this.closePromise;
	}

	private requestStop(state: RunState, kind: StopKind, error?: Error): void {
		if (state.leaderExited) return;
		if (!state.stopCause) state.stopCause = { kind, ...(error ? { error } : {}) };
		if (kind === "runtime_error" && error && !state.failure) state.failure = error;
		this.startCleanup(state);
	}

	private startCleanup(state: RunState): Promise<void> | undefined {
		if (state.cleanupPromise) return state.cleanupPromise;
		if (!state.pid || !state.spawned) return undefined;
		state.cleanupPromise = cleanupProcessTree(state.pid, this.graceMs).catch((error: unknown) => {
			state.cleanupError = toError(error);
			if (!state.failure) state.failure = state.cleanupError;
			throw state.cleanupError;
		});
		void state.cleanupPromise.catch(() => undefined);
		return state.cleanupPromise;
	}

	private async execute(
		operationId: string,
		payload: ShellOperationPayload,
		context: OperationRunnerContext,
		state: RunState,
	): Promise<OperationResult> {
		const startedAt = Date.now();
		const startTime = performance.now();
		const runDir = join(this.rootDir, "runs", operationId);
		const stdoutPath = join(runDir, "stdout.log");
		const stderrPath = join(runDir, "stderr.log");
		const metadataPath = join(runDir, "metadata.json");
		const stdoutTail = new ByteTail(this.tailBytes);
		const stderrTail = new ByteTail(this.tailBytes);
		const reporters: [OutputReporter, OutputReporter] = [
			new OutputReporter("stdout", context.reportOutput, (error) => this.requestStop(state, "runtime_error", error)),
			new OutputReporter("stderr", context.reportOutput, (error) => this.requestStop(state, "runtime_error", error)),
		];
		const counts = { stdout: 0, stderr: 0, written: 0 };
		let stdoutFile: LogFile | undefined;
		let stderrFile: LogFile | undefined;
		let stdoutCapture: CapturedOutput | undefined;
		let stderrCapture: CapturedOutput | undefined;
		let runDirectoryCreated = false;
		let abortListener: (() => void) | undefined;

		const fail = (error: unknown): void => {
			const converted = toError(error);
			if (!state.failure) state.failure = converted;
			this.requestStop(state, "runtime_error", converted);
		};

		try {
			await mkdir(join(this.rootDir, "runs"), { recursive: true, mode: 0o700 });
			await mkdir(runDir, { mode: 0o700 });
			runDirectoryCreated = true;
			stdoutFile = await openLogFile(stdoutPath);
			stderrFile = await openLogFile(stderrPath);

			if (context.signal.aborted) this.requestStop(state, "cancelled");
			if (!state.stopCause) {
				let executable: string;
				let args: string[];
				let transport: "argv" | "stdin" = "argv";
				if (payload.shell) {
					executable = payload.shell.executable;
					args = [...payload.shell.args];
					transport = payload.shell.commandTransport ?? "argv";
				} else if (process.platform === "win32") {
					const systemRoot = process.env.SystemRoot;
					if (!systemRoot) throw new Error("SystemRoot is unavailable for the default Windows shell");
					executable = join(systemRoot, "System32", "cmd.exe");
					args = ["/d", "/s", "/c"];
				} else {
					executable = "/bin/bash";
					args = ["-c"];
				}
				if (transport === "argv") args.push(payload.command);
				const env: NodeJS.ProcessEnv = { ...process.env, ...(payload.env ?? {}) };
				const child = spawn(executable, args, {
					cwd: payload.cwd,
					env,
					stdio: ["pipe", "pipe", "pipe"],
					detached: process.platform !== "win32",
					windowsHide: true,
				});
				state.child = child;
				const childStdout = child.stdout;
				const childStderr = child.stderr;
				if (!childStdout || !childStderr || !child.stdin)
					throw new Error("Shell child process did not provide piped stdio");
				stdoutCapture = bindCapture(
					childStdout,
					stdoutFile.file,
					stdoutTail,
					reporters[0],
					true,
					this.maxLogBytes,
					counts,
					fail,
				);
				stderrCapture = bindCapture(
					childStderr,
					stderrFile.file,
					stderrTail,
					reporters[1],
					false,
					this.maxLogBytes,
					counts,
					fail,
				);

				const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<ExitInfo>();
				let exitResolved = false;
				const finishExit = (exit: ExitInfo): void => {
					if (exitResolved) return;
					exitResolved = true;
					resolveExit(exit);
				};
				child.once("spawn", () => {
					state.spawned = true;
					state.pid = child.pid;
					if (payload.timeoutMs !== undefined) {
						state.timeout = setTimeout(
							() =>
								this.requestStop(
									state,
									"timeout",
									new Error(`Shell operation timed out after ${payload.timeoutMs} ms`),
								),
							payload.timeoutMs,
						);
					}
					if (state.stopCause) this.startCleanup(state);
				});
				child.once("exit", (code, signal) => {
					state.leaderExited = true;
					clearTimeout(state.timeout);
					if (abortListener) context.signal.removeEventListener("abort", abortListener);
					state.exit = { code, signal };
					finishExit(state.exit);
					this.startCleanup(state);
				});
				child.once("error", (error) => {
					fail(error);
					if (!state.spawned && child.pid === undefined) {
						state.leaderExited = true;
						clearTimeout(state.timeout);
						finishExit({ code: null, signal: null });
					}
				});
				abortListener = () => this.requestStop(state, "cancelled");
				child.stdin.on("error", fail);
				context.signal.addEventListener("abort", abortListener, { once: true });
				if (context.signal.aborted) abortListener();
				if (transport === "stdin") child.stdin.end(payload.command);
				else child.stdin.end();
				state.exit = await exitPromise;
				state.leaderExited = true;
				clearTimeout(state.timeout);
				if (abortListener) context.signal.removeEventListener("abort", abortListener);
				const cleanup = this.startCleanup(state);
				if (cleanup) await cleanup;
			}
		} catch (error) {
			fail(error);
			if (state.child && !state.leaderExited) {
				const child = state.child;
				const { promise: exitEvent, resolve: resolveExit } = Promise.withResolvers<"exited">();
				child.once("exit", () => resolveExit("exited"));
				const exit = await Promise.race([
					exitEvent,
					sleep(Math.max(1_000, this.graceMs * 4)).then(() => "timeout" as const),
				]);
				if (exit === "timeout")
					state.cleanupError ??= new Error("Shell child did not exit after process-tree cleanup");
				else state.leaderExited = true;
			}
			if (state.cleanupPromise) {
				try {
					await state.cleanupPromise;
				} catch (cleanupError) {
					state.cleanupError = toError(cleanupError);
				}
			}
		} finally {
			clearTimeout(state.timeout);
			if (abortListener) context.signal.removeEventListener("abort", abortListener);
			const captures = [stdoutCapture, stderrCapture].filter(
				(capture): capture is CapturedOutput => capture !== undefined,
			);
			if (!(await waitForCaptures(captures, PIPE_CLOSE_TIMEOUT_MS))) {
				const pipeError = new Error("Shell output pipes remained open after process-tree cleanup");
				state.failure = state.failure
					? new AggregateError(
							[state.failure, pipeError],
							"Shell operation failed and output pipes remained open after cleanup",
						)
					: pipeError;
				this.requestStop(state, "runtime_error", pipeError);
				for (const capture of captures) capture.closeInput();
			}
			if (state.child?.stdin && !state.child.stdin.destroyed) state.child.stdin.destroy();
			stdoutCapture?.closeInput();
			stderrCapture?.closeInput();
			if (!stdoutCapture && stdoutFile && !stdoutFile.file.writableEnded && !stdoutFile.file.destroyed)
				stdoutFile.file.end();
			if (!stderrCapture && stderrFile && !stderrFile.file.writableEnded && !stderrFile.file.destroyed)
				stderrFile.file.end();
			const fileResults = await Promise.allSettled(
				[stdoutFile?.done, stderrFile?.done].filter((value): value is Promise<void> => value !== undefined),
			);
			for (const result of fileResults) {
				if (result.status === "rejected" && !state.failure) state.failure = toError(result.reason);
			}
			for (const reporter of reporters) {
				try {
					await reporter.drain();
				} catch (error) {
					if (!state.failure) state.failure = toError(error);
				}
			}
			if (state.cleanupPromise) {
				try {
					await state.cleanupPromise;
				} catch (error) {
					state.cleanupError = toError(error);
				}
			}
		}

		const completedAt = Date.now();
		const durationMs = Math.max(0, Math.round(performance.now() - startTime));
		const exit = state.exit;
		let failureKind: FailureKind | undefined;
		if (state.failure || state.cleanupError) failureKind = "runtime_error";
		else if (state.stopCause?.kind === "timeout") failureKind = "timeout";
		else if (state.stopCause?.kind === "cancelled") failureKind = "cancelled";
		else if (exit && exit.code !== 0) failureKind = "nonzero_exit";
		else if (!exit && state.stopCause?.kind === "runtime_error") failureKind = "runtime_error";

		let errorText: string | undefined;
		if (state.failure || state.cleanupError)
			errorText = limitUtf8(
				sanitizeText((state.failure ?? state.cleanupError)?.message ?? "Shell runtime failed"),
				MAX_TEXT_BYTES,
			);
		else if (failureKind === "timeout")
			errorText = limitUtf8(
				sanitizeText(state.stopCause?.error?.message ?? "Shell operation timed out"),
				MAX_TEXT_BYTES,
			);
		else if (failureKind === "cancelled") errorText = "Shell operation cancelled";
		else if (failureKind === "nonzero_exit")
			errorText = `Shell exited with code ${exit?.code ?? "unknown"}${exit?.signal ? ` (${exit.signal})` : ""}`;
		else if (!exit && failureKind === "runtime_error") errorText = "Shell operation did not start";

		const stdoutTailBuffer = stdoutTail.toBuffer();
		const stderrTailBuffer = stderrTail.toBuffer();
		const resultMetadata = makeMetadata({
			pid: state.pid,
			startedAt,
			completedAt,
			durationMs,
			stdoutBytes: counts.stdout,
			stderrBytes: counts.stderr,
			exit,
			failureKind,
			stdoutTail: stdoutTailBuffer,
			stderrTail: stderrTailBuffer,
		});
		const summary = makeSummary(exit, durationMs, stdoutTailBuffer, stderrTailBuffer, failureKind);
		const result: OperationResult = {
			...(exit?.code === null || exit?.code === undefined ? {} : { exitCode: exit.code }),
			summary,
			stdoutPath,
			stderrPath,
			...(errorText === undefined ? {} : { error: errorText }),
			...(failureKind === undefined ? {} : { failureKind }),
			metadata: resultMetadata as OperationResult["metadata"],
		};
		const metadataDocument = {
			...resultMetadata,
			stdoutPath,
			stderrPath,
			...(errorText === undefined ? {} : { error: errorText }),
		};
		const serializedMetadata = JSON.stringify(metadataDocument);
		if (Buffer.byteLength(serializedMetadata, "utf8") > MAX_PAYLOAD_BYTES)
			throw new Error("Shell metadata exceeds 256 KiB");
		if (runDirectoryCreated)
			await writeFile(metadataPath, serializedMetadata, { encoding: "utf8", flag: "wx", mode: 0o600 });
		if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PAYLOAD_BYTES)
			throw new Error("Shell operation result exceeds 256 KiB");
		if (state.cleanupError) {
			throw new AggregateError(
				[state.cleanupError],
				`Could not confirm shell process-tree cleanup; logs: stdout=${stdoutPath}, stderr=${stderrPath}`,
			);
		}
		return result;
	}
}

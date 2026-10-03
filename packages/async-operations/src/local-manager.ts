import { randomUUID } from "node:crypto";
import type {
	JsonValue,
	Operation,
	OperationEvent,
	OperationEventDraft,
	OperationManager,
	OperationQuery,
	OperationResult,
	OperationRunner,
	OperationRunnerContext,
	OperationSpec,
	OperationState,
	OperationStore,
} from "./types.ts";
import { validateJsonValue, validateOperation, validateOperationResult } from "./validation.ts";

const DEFAULT_MAX_CONCURRENT_JOBS = 4;
const MAX_CONCURRENT_JOBS = 128;
const RECOVERY_PAGE_SIZE = 10_000;
const MAX_TEXT_BYTES = 8 * 1024;

export type LocalOperationManagerOptions = {
	store: OperationStore;
	runners: Readonly<Record<string, OperationRunner>>;
	maxConcurrentJobs?: number;
	onError?: (error: Error) => void;
};

type RunningJob = {
	id: string;
	runner: OperationRunner;
	operation: Operation;
	controller: AbortController;
	done: Promise<void>;
	resolveDone: () => void;
	cancelRequested: boolean;
};

/** Owns scheduling and lifecycle persistence for one store ownership lease. */
export class LocalOperationManager implements OperationManager {
	private readonly runners: ReadonlyMap<string, OperationRunner>;
	private readonly listeners = new Set<(event: OperationEvent) => void>();
	private readonly running = new Map<string, RunningJob>();
	private lockTail: Promise<void> = Promise.resolve();
	private schedulerRunning = false;
	private scheduleRequested = false;
	private closeRequested = false;
	private closePromise?: Promise<void>;
	private backgroundFailure?: Error;

	private readonly store: OperationStore;
	private readonly maxConcurrentJobs: number;
	private readonly onError?: (error: Error) => void;
	private readonly releaseOwnership: () => Promise<void>;

	private constructor(
		store: OperationStore,
		runners: ReadonlyMap<string, OperationRunner>,
		maxConcurrentJobs: number,
		onError: ((error: Error) => void) | undefined,
		releaseOwnership: () => Promise<void>,
	) {
		this.runners = runners;
		this.store = store;
		this.maxConcurrentJobs = maxConcurrentJobs;
		this.onError = onError;
		this.releaseOwnership = releaseOwnership;
	}

	static async open(options: LocalOperationManagerOptions): Promise<LocalOperationManager> {
		const maxConcurrentJobs = options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
		if (
			!Number.isSafeInteger(maxConcurrentJobs) ||
			maxConcurrentJobs < 1 ||
			maxConcurrentJobs > MAX_CONCURRENT_JOBS
		) {
			throw new RangeError(`maxConcurrentJobs must be an integer from 1 to ${MAX_CONCURRENT_JOBS}`);
		}
		if (options.runners === null || typeof options.runners !== "object") {
			throw new TypeError("runners must be a record of operation runners");
		}
		const runners = new Map<string, OperationRunner>();
		for (const [kind, runner] of Object.entries(options.runners)) {
			if (!kind || !isOperationRunner(runner)) {
				throw new TypeError(`Invalid operation runner for kind ${JSON.stringify(kind)}`);
			}
			runners.set(kind, runner);
		}

		const releaseOwnership = await options.store.acquireOwnership();
		const manager = new LocalOperationManager(
			options.store,
			runners,
			maxConcurrentJobs,
			options.onError,
			releaseOwnership,
		);
		try {
			await manager.recover();
			manager.kickScheduler();
			return manager;
		} catch (error) {
			try {
				await releaseOwnership();
			} catch (releaseError) {
				throw new AggregateError([toError(error), toError(releaseError)], "Opening the operation manager failed");
			}
			throw error;
		}
	}

	async submit(spec: OperationSpec): Promise<Operation> {
		const normalized = this.validateSpec(spec);
		const createdAt = Date.now();
		const operation: Operation = {
			id: randomUUID(),
			version: 1,
			kind: normalized.kind,
			payload: normalized.payload,
			state: "pending",
			createdAt,
			...(normalized.sessionId === undefined ? {} : { sessionId: normalized.sessionId }),
		};
		validateOperation(operation);

		const created = await this.withLock(async () => {
			this.ensureAccepting();
			if (this.backgroundFailure) throw this.backgroundFailure;
			const event = await this.store.create(operation);
			this.emit(event);
			return operation;
		});
		this.kickScheduler();
		return created;
	}

	async cancel(id: string): Promise<void> {
		if (this.closePromise) {
			await this.closePromise;
			return;
		}
		let jobToAwait: RunningJob | undefined;
		await this.withLock(async () => {
			if (this.backgroundFailure) throw this.backgroundFailure;
			const operation = await this.store.get(id);
			if (!operation) throw new Error(`Operation ${id} was not found`);
			if (isTerminal(operation.state)) return;
			if (operation.state === "pending") {
				const result: OperationResult = { failureKind: "cancelled" };
				const timestamp = Date.now();
				const commit = await this.store.transition(
					id,
					{ state: "cancelled", completedAt: timestamp, result },
					{ type: "operation.cancelled", operationId: id, timestamp },
				);
				this.emit(commit.event);
				return;
			}
			jobToAwait = this.running.get(id);
			if (!jobToAwait) throw new Error(`Operation ${id} is running but is not owned by this manager`);
			jobToAwait.cancelRequested = true;
			jobToAwait.controller.abort();
		});
		if (jobToAwait) {
			await jobToAwait.done;
			if (this.backgroundFailure) throw this.backgroundFailure;
		}
	}

	get(id: string): Promise<Operation | undefined> {
		return this.store.get(id);
	}

	list(query?: OperationQuery): Promise<Operation[]> {
		return this.store.list(query);
	}

	subscribe(listener: (event: OperationEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closeRequested = true;
		this.closePromise = this.closeOwnedWork();
		return this.closePromise;
	}

	private async recover(): Promise<void> {
		let offset = 0;
		for (;;) {
			const operations = await this.store.list({ limit: RECOVERY_PAGE_SIZE, offset });
			for (const operation of operations) {
				if (operation.state === "running") {
					const error = "runner process disappeared";
					const timestamp = Date.now();
					const commit = await this.store.transition(
						operation.id,
						{
							state: "failed",
							completedAt: timestamp,
							result: { error, failureKind: "lost_process" },
						},
						{ type: "operation.failed", operationId: operation.id, timestamp, error },
					);
					this.emit(commit.event);
				} else if (operation.state === "pending") {
					if (!this.runners.has(operation.kind)) {
						const error = `No runner is registered for operation kind ${JSON.stringify(operation.kind)}`;
						const timestamp = Date.now();
						const commit = await this.store.transition(
							operation.id,
							{
								state: "failed",
								completedAt: timestamp,
								result: { error, failureKind: "runtime_error" },
							},
							{ type: "operation.failed", operationId: operation.id, timestamp, error },
						);
						this.emit(commit.event);
					}
				}
			}
			if (operations.length < RECOVERY_PAGE_SIZE) return;
			offset += operations.length;
		}
	}

	private validateSpec(spec: OperationSpec): { kind: string; payload: JsonValue; sessionId?: string } {
		if (typeof spec !== "object" || spec === null || Array.isArray(spec))
			throw new TypeError("Operation spec must be an object");
		if (typeof spec.kind !== "string" || spec.kind.length === 0 || Buffer.byteLength(spec.kind, "utf8") > 256) {
			throw new TypeError("Operation kind must be a non-empty string of at most 256 UTF-8 bytes");
		}
		if (!this.runners.has(spec.kind))
			throw new Error(`No runner is registered for operation kind ${JSON.stringify(spec.kind)}`);
		validateJsonValue(spec.payload, "operation payload");
		const serializedPayload = JSON.stringify(spec.payload);
		if (serializedPayload === undefined) throw new TypeError("Operation payload must be JSON serializable");
		const payload = JSON.parse(serializedPayload) as JsonValue;
		if (
			spec.sessionId !== undefined &&
			(typeof spec.sessionId !== "string" ||
				spec.sessionId.length === 0 ||
				Buffer.byteLength(spec.sessionId, "utf8") > 1024)
		) {
			throw new TypeError("Operation sessionId must be a non-empty string of at most 1024 UTF-8 bytes");
		}
		return {
			kind: spec.kind,
			payload,
			...(spec.sessionId === undefined ? {} : { sessionId: spec.sessionId }),
		};
	}

	private async drainScheduler(): Promise<void> {
		await this.withLock(async () => {
			while (!this.closeRequested && !this.backgroundFailure && this.running.size < this.maxConcurrentJobs) {
				const [operation] = await this.store.list({ state: "pending", limit: 1 });
				if (!operation) break;
				const id = operation.id;
				const runner = this.runners.get(operation.kind);
				if (!runner) {
					const error = `No runner is registered for operation kind ${JSON.stringify(operation.kind)}`;
					const timestamp = Date.now();
					const commit = await this.store.transition(
						id,
						{ state: "failed", completedAt: timestamp, result: { error, failureKind: "runtime_error" } },
						{ type: "operation.failed", operationId: id, timestamp, error },
					);
					this.emit(commit.event);
					continue;
				}
				const startedAt = Date.now();
				const commit = await this.store.transition(
					id,
					{ state: "running", startedAt },
					{ type: "operation.started", operationId: id, timestamp: startedAt },
				);
				this.emit(commit.event);
				let resolveDone!: () => void;
				const done = new Promise<void>((resolve) => {
					resolveDone = resolve;
				});
				const job: RunningJob = {
					id,
					runner,
					operation: commit.operation,
					controller: new AbortController(),
					done,
					resolveDone,
					cancelRequested: false,
				};
				this.running.set(id, job);
				void Promise.resolve()
					.then(() => this.executeJob(job))
					.catch((error) => this.failBackground(error))
					.finally(job.resolveDone);
			}
		});
	}

	private async executeJob(job: RunningJob): Promise<void> {
		let result: OperationResult | undefined;
		let runnerError: Error | undefined;
		const context: OperationRunnerContext = {
			signal: job.controller.signal,
			reportOutput: (stream, byteCount) => this.persistOutput(job, stream, byteCount),
		};
		try {
			result = await job.runner.run(job.operation, context);
			validateOperationResult(result);
			const serializedResult = JSON.stringify(result);
			if (serializedResult === undefined) throw new TypeError("Runner result must be JSON serializable");
			result = JSON.parse(serializedResult) as OperationResult;
		} catch (error) {
			runnerError = toError(error);
		}

		await this.withLock(async () => {
			if (this.running.get(job.id) !== job) return;
			if (!this.backgroundFailure || job.cancelRequested || result?.failureKind === "cancelled") {
				const cancelled =
					job.cancelRequested || job.controller.signal.aborted || result?.failureKind === "cancelled";
				const normalizedResult = cancelled
					? { ...result, failureKind: "cancelled" as const }
					: runnerError
						? {
								error: limitText(runnerError.message) || "Runner failed with an empty error message",
								failureKind: "runtime_error" as const,
							}
						: normalizeRunnerResult(result as OperationResult);
				const state: OperationState = cancelled
					? "cancelled"
					: normalizedResult.failureKind === undefined
						? "completed"
						: "failed";
				const completedAt = Date.now();
				const event = terminalEvent(job.id, state, normalizedResult, completedAt);
				try {
					const commit = await this.store.transition(
						job.id,
						{ state, completedAt, result: normalizedResult },
						event,
					);
					this.emit(commit.event);
				} catch (error) {
					this.failBackground(error);
				}
			}
			this.running.delete(job.id);
		});
		if (!this.closeRequested && !this.backgroundFailure) this.kickScheduler();
	}

	private async persistOutput(job: RunningJob, stream: "stdout" | "stderr", byteCount: number): Promise<void> {
		if (!Number.isSafeInteger(byteCount) || byteCount < 0)
			throw new RangeError("Output byteCount must be a non-negative safe integer");
		await this.withLock(async () => {
			if (this.running.get(job.id) !== job || job.cancelRequested || this.backgroundFailure) return;
			const event: OperationEventDraft = {
				type: "operation.output",
				operationId: job.id,
				timestamp: Date.now(),
				stream,
				byteCount,
			};
			try {
				const persisted = await this.store.appendEvent(event);
				this.emit(persisted);
			} catch (error) {
				this.failBackground(error);
				throw error;
			}
		});
	}

	private async closeOwnedWork(): Promise<void> {
		const errors: Error[] = [];
		try {
			await this.withLock(async () => {
				try {
					await this.cancelAllPending();
				} catch (error) {
					this.failBackground(error);
				}
				for (const job of this.running.values()) {
					job.cancelRequested = true;
					job.controller.abort();
				}
			});
		} catch (error) {
			this.failBackground(error);
		}

		for (const job of this.running.values()) job.controller.abort();
		await Promise.all([...this.running.values()].map((job) => job.done));
		if (this.backgroundFailure) errors.push(this.backgroundFailure);

		try {
			await this.releaseOwnership();
		} catch (error) {
			const converted = toError(error);
			errors.push(converted);
			this.reportError(converted);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Closing the operation manager failed");
	}

	private async cancelAllPending(): Promise<void> {
		let offset = 0;
		for (;;) {
			const operations = await this.store.list({ limit: RECOVERY_PAGE_SIZE, offset });
			for (const operation of operations) {
				if (operation.state !== "pending") continue;
				const timestamp = Date.now();
				const commit = await this.store.transition(
					operation.id,
					{
						state: "cancelled",
						completedAt: timestamp,
						result: { failureKind: "cancelled" },
					},
					{ type: "operation.cancelled", operationId: operation.id, timestamp },
				);
				this.emit(commit.event);
			}
			if (operations.length < RECOVERY_PAGE_SIZE) break;
			offset += operations.length;
		}
	}

	private async withLock<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.lockTail;
		let release!: () => void;
		this.lockTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await action();
		} finally {
			release();
		}
	}

	private kickScheduler(): void {
		if (this.closeRequested || this.backgroundFailure) return;
		if (this.schedulerRunning) {
			this.scheduleRequested = true;
			return;
		}
		this.schedulerRunning = true;
		this.scheduleRequested = false;
		void this.drainScheduler()
			.catch((error) => this.failBackground(error))
			.finally(() => {
				this.schedulerRunning = false;
				if (this.scheduleRequested && !this.closeRequested && !this.backgroundFailure) this.kickScheduler();
			});
	}

	private ensureAccepting(): void {
		if (this.closeRequested) throw new Error("Operation manager is closed");
	}

	private emit(event: OperationEvent): void {
		Object.freeze(event);
		for (const listener of this.listeners) {
			try {
				const returned = (listener as (event: OperationEvent) => unknown)(event);
				if (isPromiseLike(returned))
					void Promise.resolve(returned).catch((error) => this.reportError(toError(error)));
			} catch (error) {
				this.reportError(toError(error));
			}
		}
	}

	private failBackground(error: unknown): void {
		const converted = toError(error);
		if (!this.backgroundFailure) {
			this.backgroundFailure = converted;
			this.reportError(converted);
			for (const job of this.running.values()) {
				job.cancelRequested = true;
				job.controller.abort();
			}
		}
	}

	private reportError(error: Error): void {
		try {
			const returned = this.onError?.(error);
			if (isPromiseLike(returned)) void Promise.resolve(returned).catch(() => undefined);
		} catch {
			// Error reporting is isolated from operation lifecycle.
		}
	}
}

function isOperationRunner(value: unknown): value is OperationRunner {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("run" in value)) return false;
	return typeof value.run === "function";
}

function isTerminal(state: OperationState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

function normalizeRunnerResult(result: OperationResult): OperationResult {
	if (result.failureKind !== undefined) {
		if (result.error !== undefined && result.error.length > 0) return result;
		return { ...result, error: `Operation failed (${result.failureKind})` };
	}
	if (result.error !== undefined) {
		return { ...result, error: result.error || "Runner reported an error", failureKind: "runtime_error" };
	}
	if (result.exitCode !== undefined && result.exitCode !== 0) {
		return { ...result, error: `Operation exited with code ${result.exitCode}`, failureKind: "nonzero_exit" };
	}
	return result;
}

function terminalEvent(
	operationId: string,
	state: OperationState,
	result: OperationResult,
	timestamp: number,
): OperationEventDraft {
	if (state === "cancelled") return { type: "operation.cancelled", operationId, timestamp };
	if (state === "completed")
		return {
			type: "operation.completed",
			operationId,
			timestamp,
			...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
		};
	return {
		type: "operation.failed",
		operationId,
		timestamp,
		error: result.error ?? `Operation failed (${result.failureKind ?? "runtime_error"})`,
	};
}

function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	try {
		return new Error(String(error));
	} catch {
		return new Error("Unknown operation manager error");
	}
}

function limitText(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES) return value;
	let output = "";
	for (const character of value) {
		if (Buffer.byteLength(output + character, "utf8") > MAX_TEXT_BYTES) break;
		output += character;
	}
	return output;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (typeof value === "object" || typeof value === "function") && value !== null && "then" in value;
}

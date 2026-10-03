export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type OperationState = "pending" | "running" | "completed" | "failed" | "cancelled";
export type FailureKind = "nonzero_exit" | "runtime_error" | "timeout" | "cancelled" | "lost_process";

export interface OperationResult {
	exitCode?: number;
	summary?: string;
	stdoutPath?: string;
	stderrPath?: string;
	error?: string;
	failureKind?: FailureKind;
	metadata?: Record<string, JsonValue>;
}

export interface Operation<TPayload extends JsonValue = JsonValue> {
	id: string;
	version: 1;
	kind: string;
	payload: TPayload;
	state: OperationState;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	result?: OperationResult;
	/** Generic correlation, not a dependency on Pi session machinery. */
	sessionId?: string;
}

export interface OperationSpec {
	kind: string;
	payload: JsonValue;
	sessionId?: string;
}

export interface OperationQuery {
	state?: OperationState;
	kind?: string;
	sessionId?: string;
	/** Default 100, maximum 10,000. */
	limit?: number;
	offset?: number;
}

interface EventIdentity {
	version: 1;
	eventId: string;
	sequence: number;
}

type EventData = { operationId: string; timestamp: number } & (
	| { type: "operation.created" }
	| { type: "operation.started" }
	| { type: "operation.output"; stream: "stdout" | "stderr"; byteCount: number }
	| { type: "operation.completed"; exitCode?: number }
	| { type: "operation.failed"; error: string }
	| { type: "operation.cancelled" }
);

/** Identity and sequence are assigned by the store, never by a caller. */
export type OperationEventDraft = EventData;
export type OperationEvent = EventIdentity & EventData;

export interface OperationCommit {
	operation: Operation;
	event: OperationEvent;
}

export interface OperationStore {
	/** Exclusive manager ownership; acquire before recovery or scheduling. */
	acquireOwnership(): Promise<() => Promise<void>>;
	/** Atomically persist a pending operation and its created event. */
	create(operation: Operation): Promise<OperationEvent>;
	get(id: string): Promise<Operation | undefined>;
	/** Metadata updates only; state changes require transition(). */
	update(id: string, update: Partial<Operation>): Promise<void>;
	list(query?: OperationQuery): Promise<Operation[]>;
	/** Output events only; lifecycle events require create()/transition(). */
	appendEvent(event: OperationEventDraft): Promise<OperationEvent>;
	/** Ascending sequence, bounded page (default 100, max 10,000). */
	events(operationId: string, query?: { afterSequence?: number; limit?: number }): Promise<OperationEvent[]>;
	/** Compare/validate state and atomically update metadata plus append one lifecycle event. */
	transition(id: string, update: Partial<Operation>, event: OperationEventDraft): Promise<OperationCommit>;
	close(): Promise<void>;
}

export interface OperationRunnerContext {
	signal: AbortSignal;
	/** Persist output byte counts; actual output remains owned by the runner. */
	reportOutput(stream: "stdout" | "stderr", byteCount: number): Promise<void>;
}

/** Resolves only when owned work has stopped, including after cancellation. */
export interface OperationRunner {
	run(operation: Operation, context: OperationRunnerContext): Promise<OperationResult>;
}

export interface OperationManager {
	submit(spec: OperationSpec): Promise<Operation>;
	cancel(id: string): Promise<void>;
	get(id: string): Promise<Operation | undefined>;
	list(query?: OperationQuery): Promise<Operation[]>;
	subscribe(listener: (event: OperationEvent) => void): () => void;
	/** Stop accepting work, cancel owned jobs, and wait for runners to settle. Does not close the supplied store. */
	close(): Promise<void>;
}

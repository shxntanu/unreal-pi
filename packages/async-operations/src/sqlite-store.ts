import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type {
	Operation,
	OperationCommit,
	OperationEvent,
	OperationEventDraft,
	OperationQuery,
	OperationState,
	OperationStore,
} from "./types.ts";
import {
	validateOperation,
	validateOperationEvent,
	validateOperationEventDraft,
	validateOperationId,
	validateOperationResult,
} from "./validation.ts";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 10_000;
const IMMUTABLE_OPERATION_FIELDS = ["id", "version", "kind", "payload", "createdAt", "sessionId"] as const;
const OPERATION_FIELDS: Record<string, true> = {
	id: true,
	version: true,
	kind: true,
	payload: true,
	state: true,
	createdAt: true,
	startedAt: true,
	completedAt: true,
	result: true,
	sessionId: true,
};
const OPERATION_STATES: Record<OperationState, true> = {
	pending: true,
	running: true,
	completed: true,
	failed: true,
	cancelled: true,
};
const OPERATION_QUERY_FIELDS: Record<string, true> = {
	state: true,
	kind: true,
	sessionId: true,
	limit: true,
	offset: true,
};
const EVENT_QUERY_FIELDS: Record<string, true> = { afterSequence: true, limit: true };

type SqlRow = Record<string, SQLOutputValue>;

function throwCorruptRow(kind: string, error: unknown): never {
	throw new Error(`Invalid ${kind} row in async operation database`, { cause: error });
}

function serialize(value: unknown, label: string): string {
	try {
		const result = JSON.stringify(value);
		if (typeof result !== "string") throw new TypeError(`${label} is not serializable JSON`);
		return result;
	} catch (error) {
		throw new TypeError(`${label} is not serializable JSON`, { cause: error });
	}
}

function readText(value: SQLOutputValue, label: string): string {
	if (typeof value !== "string") throw new TypeError(`Database ${label} must be text`);
	return value;
}

function readNumber(value: SQLOutputValue, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value))
		throw new TypeError(`Database ${label} must be a safe integer`);
	return value;
}

function readFiniteNumber(value: SQLOutputValue, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new TypeError(`Database ${label} must be a finite number`);
	return value;
}

function safeSequence(value: number | bigint): number {
	const sequence = typeof value === "bigint" ? Number(value) : value;
	if (!Number.isSafeInteger(sequence) || sequence < 1)
		throw new RangeError("Event sequence exceeds the safe integer range");
	return sequence;
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch (error) {
		throw new TypeError(`${label} contains invalid JSON`, { cause: error });
	}
}

function operationIsTerminal(state: OperationState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

function eventTypeForState(state: OperationState): OperationEventDraft["type"] | undefined {
	switch (state) {
		case "running":
			return "operation.started";
		case "completed":
			return "operation.completed";
		case "failed":
			return "operation.failed";
		case "cancelled":
			return "operation.cancelled";
		case "pending":
			return undefined;
	}
}

function validatePageSize(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
		throw new RangeError(`${label} must be an integer between 1 and ${MAX_PAGE_SIZE}`);
	}
	return value;
}

function assertPlainObject(
	value: unknown,
	allowed: Readonly<Record<string, true>>,
	label: string,
): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError(`${label} must be an object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !Object.hasOwn(allowed, key))
			throw new TypeError(`${label} contains unsupported property ${String(key)}`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
			throw new TypeError(`${label} property ${String(key)} must be an enumerable data property`);
		}
		if (descriptor.value === undefined) throw new TypeError(`${label} property ${key} must not be undefined`);
	}
}

function assertUnchangedIdentity(current: Operation, candidate: Record<string, unknown>): void {
	for (const field of IMMUTABLE_OPERATION_FIELDS) {
		if (!Object.hasOwn(candidate, field)) continue;
		const currentHasField = Object.hasOwn(current, field);
		if (currentHasField !== Object.hasOwn(candidate, field)) throw new Error(`Operation ${field} is immutable`);
		const oldValue = current[field];
		const newValue = candidate[field];
		if (field === "payload") {
			if (serialize(oldValue, "Operation payload") !== serialize(newValue, "Operation payload")) {
				throw new Error("Operation payload is immutable");
			}
		} else if (oldValue !== newValue) {
			throw new Error(`Operation ${field} is immutable`);
		}
	}
}

function applyUpdate(
	current: Operation,
	update: unknown,
): { candidate: Record<string, unknown>; update: Record<string, unknown> } {
	assertPlainObject(update, OPERATION_FIELDS, "Operation update");
	const candidate: Record<string, unknown> = { ...current };
	for (const key of Object.keys(update)) candidate[key] = update[key];
	assertUnchangedIdentity(current, candidate);
	return { candidate, update };
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error) {
			const code = error.code;
			if (code === "ESRCH") return false;
			if (code === "EPERM") return true;
		}
		throw error;
	}
}

/** SQLite-backed operation and append-only event store using Node's built-in SQLite API. */
export class SQLiteOperationStore implements OperationStore {
	private readonly database: DatabaseSync;
	private closed = false;
	private ownershipToken: string | undefined;

	constructor(path: string) {
		if (path === ":memory:")
			throw new Error("SQLiteOperationStore requires a file-backed database for manager ownership");
		const resolvedPath = resolve(path);
		mkdirSync(dirname(resolvedPath), { recursive: true });
		const database = new DatabaseSync(resolvedPath, { timeout: DEFAULT_BUSY_TIMEOUT_MS });
		this.database = database;
		try {
			database.exec("PRAGMA foreign_keys = ON");
			this.initializeSchema();
		} catch (error) {
			database.close();
			throw error;
		}
	}

	async acquireOwnership(): Promise<() => Promise<void>> {
		this.assertOpen();
		if (this.ownershipToken !== undefined) throw new Error("This operation store already holds manager ownership");
		const token = randomUUID();
		this.transaction(() => {
			const row = this.database
				.prepare("SELECT pid, token FROM operation_store_ownership WHERE singleton = 1")
				.get();
			if (row) {
				const pid = readNumber(row.pid, "ownership.pid");
				if (pid < 1) throw new Error("Invalid process ID in operation ownership row");
				const existingToken = readText(row.token, "ownership.token");
				validateOperationId(existingToken, "ownership token");
				// Fail closed: a reused PID may cause a false-busy result, but must never trigger forced takeover.
				if (isAlive(pid)) throw new Error(`Async operation database is already owned by live process ${pid}`);
				const claim = this.database
					.prepare("UPDATE operation_store_ownership SET pid = ?, token = ? WHERE singleton = 1 AND token = ?")
					.run(process.pid, token, existingToken);
				if (claim.changes !== 1) throw new Error("Unable to claim stale operation database ownership");
			} else {
				this.database
					.prepare("INSERT INTO operation_store_ownership (singleton, pid, token) VALUES (1, ?, ?)")
					.run(process.pid, token);
			}
		});
		this.ownershipToken = token;
		let released = false;
		return async () => {
			if (released) return;
			this.assertOpen();
			this.transaction(() => {
				this.database.prepare("DELETE FROM operation_store_ownership WHERE singleton = 1 AND token = ?").run(token);
			});
			released = true;
			if (this.ownershipToken === token) this.ownershipToken = undefined;
		};
	}

	async create(operation: Operation): Promise<OperationEvent> {
		this.assertOpen();
		validateOperation(operation);
		if (operation.state !== "pending") throw new Error("New operations must be pending");
		const draft: OperationEventDraft = {
			operationId: operation.id,
			timestamp: operation.createdAt,
			type: "operation.created",
		};
		let createdEvent: OperationEvent | undefined;
		this.transaction(() => {
			const operationJson = serialize(operation, "Operation");
			this.database
				.prepare(
					"INSERT INTO operations (id, state, kind, session_id, created_at, started_at, completed_at, operation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					operation.id,
					operation.state,
					operation.kind,
					operation.sessionId ?? null,
					operation.createdAt,
					operation.startedAt ?? null,
					operation.completedAt ?? null,
					operationJson,
				);
			createdEvent = this.insertEvent(draft);
		});
		if (!createdEvent) throw new Error("Created event was not persisted");
		return createdEvent;
	}

	async get(id: string): Promise<Operation | undefined> {
		this.assertOpen();
		validateOperationId(id);
		const row = this.database.prepare("SELECT * FROM operations WHERE id = ?").get(id);
		return row ? this.readOperation(row) : undefined;
	}

	async update(id: string, update: Partial<Operation>): Promise<void> {
		this.assertOpen();
		validateOperationId(id);
		this.transaction(() => {
			const row = this.database.prepare("SELECT * FROM operations WHERE id = ?").get(id);
			if (!row) throw new Error(`Operation ${id} does not exist`);
			const current = this.readOperation(row);
			const { candidate, update: fields } = applyUpdate(current, update);
			if (Object.hasOwn(fields, "state")) throw new Error("Operation state changes require transition()");
			if (Object.hasOwn(fields, "startedAt") && fields.startedAt !== current.startedAt) {
				throw new Error("Operation startedAt changes require transition()");
			}
			if (Object.hasOwn(fields, "completedAt") && fields.completedAt !== current.completedAt) {
				throw new Error("Operation completedAt changes require transition()");
			}
			if (Object.hasOwn(fields, "result")) {
				if (operationIsTerminal(current.state)) throw new Error("Terminal operation results are immutable");
				const resultPatch = fields.result;
				validateOperationResult(resultPatch);
				if (Object.keys(resultPatch).some((key) => key !== "metadata") || !resultPatch.metadata) {
					throw new Error("update() may change result metadata only");
				}
				candidate.result = { metadata: resultPatch.metadata };
			}
			validateOperation(candidate);
			if (serialize(current, "Operation") === serialize(candidate, "Operation")) return;
			const operation = candidate as Operation;
			this.writeOperation(operation);
		});
	}

	async list(query: OperationQuery = {}): Promise<Operation[]> {
		this.assertOpen();
		assertPlainObject(query, OPERATION_QUERY_FIELDS, "Operation query");
		const clauses: string[] = [];
		const values: SQLInputValue[] = [];
		if (Object.hasOwn(query, "state")) {
			if (typeof query.state !== "string" || !Object.hasOwn(OPERATION_STATES, query.state)) {
				throw new TypeError("Invalid operation query state");
			}
			clauses.push("state = ?");
			values.push(query.state);
		}
		if (Object.hasOwn(query, "kind")) {
			if (typeof query.kind !== "string" || query.kind.length === 0 || Buffer.byteLength(query.kind, "utf8") > 256) {
				throw new TypeError("Operation query kind must be a non-empty string of at most 256 UTF-8 bytes");
			}
			clauses.push("kind = ?");
			values.push(query.kind);
		}
		if (Object.hasOwn(query, "sessionId")) {
			if (
				typeof query.sessionId !== "string" ||
				query.sessionId.length === 0 ||
				Buffer.byteLength(query.sessionId, "utf8") > 1024
			) {
				throw new TypeError("Operation query sessionId must be a non-empty string of at most 1024 UTF-8 bytes");
			}
			clauses.push("session_id = ?");
			values.push(query.sessionId);
		}
		const limit = Object.hasOwn(query, "limit")
			? validatePageSize(query.limit, "Operation page size")
			: DEFAULT_PAGE_SIZE;
		const offset = Object.hasOwn(query, "offset") ? query.offset : 0;
		if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
			throw new RangeError("Operation offset must be a non-negative safe integer");
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM operations ${where} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
			.all(...values, limit, offset);
		return rows.map((row) => this.readOperation(row));
	}

	async appendEvent(event: OperationEventDraft): Promise<OperationEvent> {
		this.assertOpen();
		validateOperationEventDraft(event);
		if (event.type !== "operation.output") throw new Error("appendEvent() accepts output events only");
		let stored: OperationEvent | undefined;
		this.transaction(() => {
			const row = this.database.prepare("SELECT * FROM operations WHERE id = ?").get(event.operationId);
			if (!row) throw new Error(`Operation ${event.operationId} does not exist`);
			const operation = this.readOperation(row);
			if (operation.state !== "running")
				throw new Error("Output events may only be appended while an operation is running");
			stored = this.insertEvent(event);
		});
		if (!stored) throw new Error("Output event was not persisted");
		return stored;
	}

	async events(
		operationId: string,
		query: { afterSequence?: number; limit?: number } = {},
	): Promise<OperationEvent[]> {
		this.assertOpen();
		validateOperationId(operationId);
		assertPlainObject(query, EVENT_QUERY_FIELDS, "Event query");
		const afterSequence = Object.hasOwn(query, "afterSequence") ? query.afterSequence : 0;
		if (typeof afterSequence !== "number" || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
			throw new RangeError("afterSequence must be a non-negative safe integer");
		}
		const limit = Object.hasOwn(query, "limit")
			? validatePageSize(query.limit, "Event page size")
			: DEFAULT_PAGE_SIZE;
		return this.readEvents(operationId, afterSequence, limit);
	}

	async transition(id: string, update: Partial<Operation>, event: OperationEventDraft): Promise<OperationCommit> {
		this.assertOpen();
		validateOperationId(id);
		validateOperationEventDraft(event);
		if (event.operationId !== id) throw new Error("Lifecycle event operationId does not match transition id");
		let commit: OperationCommit | undefined;
		this.transaction(() => {
			const row = this.database.prepare("SELECT * FROM operations WHERE id = ?").get(id);
			if (!row) throw new Error(`Operation ${id} does not exist`);
			const current = this.readOperation(row);
			if (operationIsTerminal(current.state)) throw new Error("Terminal operations are immutable");
			const { candidate, update: fields } = applyUpdate(current, update);
			if (!Object.hasOwn(fields, "state")) throw new Error("transition() requires a target state");
			if (typeof candidate.state !== "string" || !Object.hasOwn(OPERATION_STATES, candidate.state)) {
				throw new TypeError("Transition target state is invalid");
			}
			const nextState = candidate.state as OperationState;
			const expectedType = eventTypeForState(nextState);
			if (!expectedType || event.type !== expectedType)
				throw new Error("Lifecycle event does not match transition target state");
			if (
				current.state === "pending" &&
				nextState !== "running" &&
				nextState !== "failed" &&
				nextState !== "cancelled"
			) {
				throw new Error(`Illegal operation transition: ${current.state} -> ${nextState}`);
			}
			if (current.state === "running" && !operationIsTerminal(nextState)) {
				throw new Error(`Illegal operation transition: ${current.state} -> ${nextState}`);
			}
			if (current.startedAt !== undefined && candidate.startedAt !== current.startedAt) {
				throw new Error("Operation startedAt is immutable after the operation starts");
			}
			if (current.state === "pending" && nextState !== "running" && Object.hasOwn(candidate, "startedAt")) {
				throw new Error("Pending-to-terminal transitions must not set startedAt");
			}
			if (nextState === "running") {
				if (candidate.startedAt !== event.timestamp || Object.hasOwn(candidate, "completedAt")) {
					throw new Error(
						"Started event timestamp must match startedAt and running operations must not have completedAt",
					);
				}
			} else {
				if (candidate.completedAt !== event.timestamp)
					throw new Error("Terminal event timestamp must match completedAt");
				if (nextState === "failed") {
					if (event.type !== "operation.failed") throw new Error("Failed transition requires a failed event");
					const result = candidate.result;
					if (
						typeof result !== "object" ||
						result === null ||
						!("error" in result) ||
						result.error !== event.error
					) {
						throw new Error("Failed event error must match result.error");
					}
				} else if (nextState === "completed") {
					if (event.type !== "operation.completed")
						throw new Error("Completed transition requires a completed event");
					const result = candidate.result;
					const exitCode =
						typeof result === "object" && result !== null && "exitCode" in result ? result.exitCode : undefined;
					if (exitCode !== event.exitCode) throw new Error("Completed event exitCode must match result.exitCode");
				}
			}
			validateOperation(candidate);
			const operation = candidate as Operation;
			this.writeOperation(operation);
			const storedEvent = this.insertEvent(event);
			commit = { operation, event: storedEvent };
		});
		if (!commit) throw new Error("Operation transition was not persisted");
		return commit;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		if (this.ownershipToken !== undefined)
			throw new Error("Release manager ownership before closing the operation store");
		this.database.close();
		this.closed = true;
	}

	private initializeSchema(): void {
		const versionRow = this.database.prepare("PRAGMA user_version").get();
		if (!versionRow || typeof versionRow.user_version !== "number")
			throw new Error("Unable to read operation database schema version");
		const version = versionRow.user_version;
		if (version === 0) {
			const existing = this.database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all();
			if (existing.length > 0)
				throw new Error("Unversioned database already contains tables; refusing to initialize operation schema");
			this.transaction(() => {
				this.database.exec(`
					CREATE TABLE operations (
						id TEXT PRIMARY KEY NOT NULL,
						state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
						kind TEXT NOT NULL,
						session_id TEXT,
						created_at REAL NOT NULL,
						started_at REAL,
						completed_at REAL,
						operation_json TEXT NOT NULL
					);
					CREATE INDEX operations_state_created ON operations (state, created_at, id);
					CREATE INDEX operations_kind_created ON operations (kind, created_at, id);
					CREATE INDEX operations_session_created ON operations (session_id, created_at, id);
					CREATE TABLE operation_events (
						sequence INTEGER PRIMARY KEY AUTOINCREMENT,
						event_id TEXT NOT NULL UNIQUE,
						operation_id TEXT NOT NULL REFERENCES operations(id),
						timestamp REAL NOT NULL,
						type TEXT NOT NULL,
						event_json TEXT
					);
					CREATE INDEX operation_events_by_operation ON operation_events (operation_id, sequence);
					CREATE TABLE operation_store_ownership (
						singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
						pid INTEGER NOT NULL,
						token TEXT NOT NULL
					);
					PRAGMA user_version = 1;
				`);
			});
			return;
		}
		if (version !== 1) throw new Error(`Unsupported operation database schema version ${version}`);
		try {
			this.database
				.prepare(
					"SELECT id, state, kind, session_id, created_at, started_at, completed_at, operation_json FROM operations LIMIT 0",
				)
				.all();
			this.database
				.prepare(
					"SELECT sequence, event_id, operation_id, timestamp, type, event_json FROM operation_events LIMIT 0",
				)
				.all();
			this.database.prepare("SELECT singleton, pid, token FROM operation_store_ownership LIMIT 0").all();
		} catch (error) {
			throw new Error("Operation database schema version 1 is incomplete or incompatible", { cause: error });
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("SQLiteOperationStore is closed");
	}

	private transaction<T>(operation: () => T): T {
		this.assertOpen();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "Operation store transaction and rollback both failed");
			}
			throw error;
		}
	}

	private readOperation(row: SqlRow): Operation {
		try {
			const operationJson = readText(row.operation_json, "operation_json");
			const operation = parseJson(operationJson, "operation_json");
			validateOperation(operation);
			const parsed = operation as Operation;
			if (
				readText(row.id, "id") !== parsed.id ||
				readText(row.state, "state") !== parsed.state ||
				readText(row.kind, "kind") !== parsed.kind ||
				readFiniteNumber(row.created_at, "created_at") !== parsed.createdAt ||
				nullableText(row.session_id, "session_id") !== parsed.sessionId ||
				nullableNumber(row.started_at, "started_at") !== parsed.startedAt ||
				nullableNumber(row.completed_at, "completed_at") !== parsed.completedAt
			) {
				throw new Error("Indexed operation columns do not match its snapshot");
			}
			return parsed;
		} catch (error) {
			throwCorruptRow("operation", error);
		}
	}

	private readEvent(row: SqlRow): OperationEvent {
		try {
			const eventJson = readText(row.event_json, "event_json");
			const event = parseJson(eventJson, "event_json");
			validateOperationEvent(event);
			const parsed = event as OperationEvent;
			if (
				readNumber(row.sequence, "sequence") !== parsed.sequence ||
				readText(row.event_id, "event_id") !== parsed.eventId ||
				readText(row.operation_id, "operation_id") !== parsed.operationId ||
				readFiniteNumber(row.timestamp, "timestamp") !== parsed.timestamp ||
				readText(row.type, "type") !== parsed.type
			) {
				throw new Error("Indexed event columns do not match its snapshot");
			}
			return parsed;
		} catch (error) {
			throwCorruptRow("event", error);
		}
	}

	private insertEvent(draft: OperationEventDraft): OperationEvent {
		validateOperationEventDraft(draft);
		const eventId = randomUUID();
		const result = this.database
			.prepare(
				"INSERT INTO operation_events (event_id, operation_id, timestamp, type, event_json) VALUES (?, ?, ?, ?, NULL)",
			)
			.run(eventId, draft.operationId, draft.timestamp, draft.type);
		const sequence = safeSequence(result.lastInsertRowid);
		const event = { ...draft, version: 1 as const, eventId, sequence } as OperationEvent;
		validateOperationEvent(event);
		const eventJson = serialize(event, "Operation event");
		const updated = this.database
			.prepare("UPDATE operation_events SET event_json = ? WHERE sequence = ?")
			.run(eventJson, sequence);
		if (updated.changes !== 1) throw new Error("Unable to finish persisting operation event");
		return event;
	}

	private writeOperation(operation: Operation): void {
		const updated = this.database
			.prepare(
				"UPDATE operations SET state = ?, kind = ?, session_id = ?, created_at = ?, started_at = ?, completed_at = ?, operation_json = ? WHERE id = ?",
			)
			.run(
				operation.state,
				operation.kind,
				operation.sessionId ?? null,
				operation.createdAt,
				operation.startedAt ?? null,
				operation.completedAt ?? null,
				serialize(operation, "Operation"),
				operation.id,
			);
		if (updated.changes !== 1) throw new Error(`Operation ${operation.id} disappeared during transition`);
	}

	private readEvents(operationId: string, afterSequence: number, limit: number): OperationEvent[] {
		const rows = this.database
			.prepare(
				"SELECT * FROM operation_events WHERE operation_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
			)
			.all(operationId, afterSequence, limit);
		return rows.map((row) => this.readEvent(row));
	}
}

function nullableText(value: SQLOutputValue, label: string): string | undefined {
	if (value === null) return undefined;
	return readText(value, label);
}
function nullableNumber(value: SQLOutputValue, label: string): number | undefined {
	if (value === null) return undefined;
	return readFiniteNumber(value, label);
}

import type {
	FailureKind,
	JsonValue,
	Operation,
	OperationEvent,
	OperationEventDraft,
	OperationResult,
	OperationState,
} from "./types.ts";

const MAX_SERIALIZED_BYTES = 256 * 1024;
const MAX_RESULT_TEXT_BYTES = 8 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const operationStates: Record<OperationState, true> = {
	pending: true,
	running: true,
	completed: true,
	failed: true,
	cancelled: true,
};
const failureKinds: Record<FailureKind, true> = {
	nonzero_exit: true,
	runtime_error: true,
	timeout: true,
	cancelled: true,
	lost_process: true,
};
const operationKeys: Record<string, true> = {
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
const resultKeys: Record<string, true> = {
	exitCode: true,
	summary: true,
	stdoutPath: true,
	stderrPath: true,
	error: true,
	failureKind: true,
	metadata: true,
};
const eventKeys: Record<string, true> = {
	operationId: true,
	timestamp: true,
	type: true,
	stream: true,
	byteCount: true,
	exitCode: true,
	error: true,
	version: true,
	eventId: true,
	sequence: true,
};

function fail(label: string, reason: string): never {
	throw new TypeError(`${label} ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isRecord(value)) fail(label, "must be an object");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) fail(label, "must be a plain object");
}

function assertAllowedKeys(
	value: Record<string, unknown>,
	allowed: Readonly<Record<string, true>>,
	label: string,
): void {
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !Object.hasOwn(allowed, key))
			fail(label, `contains unsupported property ${String(key)}`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
			fail(label, `property ${key} must be an enumerable data property`);
		}
		if (descriptor.value === undefined) fail(label, `property ${key} must not be undefined`);
	}
}

function requireString(value: unknown, label: string, maxBytes: number, allowEmpty = false): asserts value is string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(label, "must be a string");
	if (Buffer.byteLength(value, "utf8") > maxBytes) fail(label, `must be at most ${maxBytes} UTF-8 bytes`);
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
		fail(label, "must be a finite non-negative safe timestamp");
	}
}

function requireSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		fail(label, `must be a safe integer of at least ${minimum}`);
	}
}

function stringifyJson(value: unknown, label: string, maxBytes = MAX_SERIALIZED_BYTES): string {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new TypeError(`${label} could not be serialized as JSON`, { cause: error });
	}
	if (typeof serialized !== "string") fail(label, "could not be serialized as JSON");
	if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
		fail(label, `must serialize to at most ${maxBytes} bytes`);
	}
	return serialized;
}

/** Strictly validates JSON data and its serialized-size limit without invoking custom serializers. */
export function validateJsonValue(value: unknown, label = "JSON value"): asserts value is JsonValue {
	const active = new WeakSet<object>();
	const visit = (current: unknown, path: string): void => {
		if (current === null || typeof current === "string" || typeof current === "boolean") return;
		if (typeof current === "number") {
			if (!Number.isFinite(current)) fail(path, "must not contain a non-finite number");
			return;
		}
		if (typeof current !== "object") fail(path, "must contain only JSON values");
		if (active.has(current)) fail(path, "must not contain cycles");
		active.add(current);
		try {
			if (Array.isArray(current)) {
				if (Object.getPrototypeOf(current) !== Array.prototype)
					fail(path, "arrays must not have a custom prototype");
				for (const key of Reflect.ownKeys(current)) {
					if (key === "length") continue;
					if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key))
						fail(path, "arrays must not have custom properties");
					const index = Number(key);
					if (!Number.isSafeInteger(index) || index >= current.length)
						fail(path, "arrays must not have custom properties");
					const descriptor = Object.getOwnPropertyDescriptor(current, key);
					if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
						fail(`${path}[${key}]`, "must be an enumerable data property");
					}
				}
				for (let index = 0; index < current.length; index++) {
					if (!Object.hasOwn(current, index)) fail(`${path}[${index}]`, "must not be undefined or sparse");
					const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
					if (!descriptor || !("value" in descriptor)) fail(`${path}[${index}]`, "must be a data property");
					visit(descriptor.value, `${path}[${index}]`);
				}
				return;
			}
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) fail(path, "objects must be plain objects");
			for (const key of Reflect.ownKeys(current)) {
				if (typeof key !== "string") fail(path, "must not contain symbol properties");
				const descriptor = Object.getOwnPropertyDescriptor(current, key);
				if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
					fail(`${path}.${key}`, "must be an enumerable data property");
				}
				visit(descriptor.value, `${path}.${key}`);
			}
		} finally {
			active.delete(current);
		}
	};
	visit(value, label);
	stringifyJson(value, label);
}

export function validateOperationId(value: unknown, label = "operation id"): asserts value is string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail(label, "must be a UUID");
}

export function validateOperationResult(value: unknown): asserts value is OperationResult {
	assertPlainRecord(value, "operation result");
	assertAllowedKeys(value, resultKeys, "operation result");
	if (Object.hasOwn(value, "exitCode")) requireSafeInteger(value.exitCode, "result.exitCode", Number.MIN_SAFE_INTEGER);
	for (const key of ["summary", "stdoutPath", "stderrPath", "error"] as const) {
		if (Object.hasOwn(value, key)) {
			requireString(
				value[key],
				`result.${key}`,
				key === "summary" || key === "error" ? MAX_RESULT_TEXT_BYTES : MAX_SERIALIZED_BYTES,
				true,
			);
		}
	}
	if (
		Object.hasOwn(value, "failureKind") &&
		(typeof value.failureKind !== "string" || !Object.hasOwn(failureKinds, value.failureKind))
	) {
		fail("result.failureKind", "is not a supported failure kind");
	}
	if (Object.hasOwn(value, "metadata")) {
		assertPlainRecord(value.metadata, "result.metadata");
		validateJsonValue(value.metadata, "result.metadata");
	}
	stringifyJson(value, "operation result");
}

function validateEventData(
	value: unknown,
	withIdentity: boolean,
): asserts value is OperationEventDraft | OperationEvent {
	assertPlainRecord(value, "operation event");
	assertAllowedKeys(value, eventKeys, "operation event");
	validateOperationId(value.operationId);
	requireTimestamp(value.timestamp, "event.timestamp");
	if (withIdentity) {
		if (value.version !== 1) fail("event.version", "must be 1");
		if (typeof value.eventId !== "string" || !UUID_PATTERN.test(value.eventId))
			fail("event.eventId", "must be a UUID");
		requireSafeInteger(value.sequence, "event.sequence", 1);
	} else if (Object.hasOwn(value, "version") || Object.hasOwn(value, "eventId") || Object.hasOwn(value, "sequence")) {
		fail("operation event draft", "must not include store-assigned identity fields");
	}
	if (typeof value.type !== "string") fail("event.type", "must be a string");
	switch (value.type) {
		case "operation.created":
		case "operation.started":
		case "operation.cancelled":
			if (
				Object.hasOwn(value, "stream") ||
				Object.hasOwn(value, "byteCount") ||
				Object.hasOwn(value, "exitCode") ||
				Object.hasOwn(value, "error")
			) {
				fail("operation event", "contains fields not valid for its type");
			}
			break;
		case "operation.output":
			if (value.stream !== "stdout" && value.stream !== "stderr") fail("event.stream", "must be stdout or stderr");
			requireSafeInteger(value.byteCount, "event.byteCount");
			if (Object.hasOwn(value, "exitCode") || Object.hasOwn(value, "error"))
				fail("operation event", "contains fields not valid for output");
			break;
		case "operation.completed":
			if (Object.hasOwn(value, "exitCode"))
				requireSafeInteger(value.exitCode, "event.exitCode", Number.MIN_SAFE_INTEGER);
			if (Object.hasOwn(value, "stream") || Object.hasOwn(value, "byteCount") || Object.hasOwn(value, "error")) {
				fail("operation event", "contains fields not valid for completion");
			}
			break;
		case "operation.failed":
			requireString(value.error, "event.error", MAX_RESULT_TEXT_BYTES);
			if (Object.hasOwn(value, "stream") || Object.hasOwn(value, "byteCount") || Object.hasOwn(value, "exitCode")) {
				fail("operation event", "contains fields not valid for failure");
			}
			break;
		default:
			fail("event.type", "is not a supported operation event type");
	}
}

export function validateOperationEventDraft(value: unknown): asserts value is OperationEventDraft {
	validateEventData(value, false);
}

export function validateOperationEvent(value: unknown): asserts value is OperationEvent {
	validateEventData(value, true);
}

export function validateOperation(value: unknown): asserts value is Operation {
	assertPlainRecord(value, "operation");
	assertAllowedKeys(value, operationKeys, "operation");
	validateOperationId(value.id);
	if (value.version !== 1) fail("operation.version", "must be 1");
	requireString(value.kind, "operation.kind", 256);
	if (!Object.hasOwn(value, "payload")) fail("operation.payload", "is required");
	validateJsonValue(value.payload, "operation.payload");
	if (typeof value.state !== "string" || !Object.hasOwn(operationStates, value.state))
		fail("operation.state", "is not supported");
	requireTimestamp(value.createdAt, "operation.createdAt");
	if (Object.hasOwn(value, "startedAt")) requireTimestamp(value.startedAt, "operation.startedAt");
	if (Object.hasOwn(value, "completedAt")) requireTimestamp(value.completedAt, "operation.completedAt");
	if (Object.hasOwn(value, "sessionId")) requireString(value.sessionId, "operation.sessionId", 1024);
	let result: OperationResult | undefined;
	if (Object.hasOwn(value, "result")) {
		const rawResult = value.result;
		validateOperationResult(rawResult);
		result = rawResult;
	}

	switch (value.state) {
		case "pending":
			if (Object.hasOwn(value, "startedAt") || Object.hasOwn(value, "completedAt"))
				fail("pending operation", "must not have lifecycle timestamps");
			if (result && (!Object.hasOwn(result, "metadata") || Object.keys(result).some((key) => key !== "metadata"))) {
				fail("pending operation", "may only carry result metadata");
			}
			break;
		case "running":
			if (!Object.hasOwn(value, "startedAt") || Object.hasOwn(value, "completedAt"))
				fail("running operation", "requires startedAt and must not have completedAt");
			if (result && (!Object.hasOwn(result, "metadata") || Object.keys(result).some((key) => key !== "metadata"))) {
				fail("running operation", "may only carry result metadata");
			}
			break;
		case "completed":
			if (!Object.hasOwn(value, "startedAt") || !Object.hasOwn(value, "completedAt"))
				fail("completed operation", "requires startedAt and completedAt");
			if (result && (Object.hasOwn(result, "error") || Object.hasOwn(result, "failureKind"))) {
				fail("completed operation", "must not carry failure details");
			}
			if (result?.exitCode !== undefined && result.exitCode !== 0) {
				fail("completed operation", "must not carry a non-zero exit code");
			}
			break;
		case "failed":
			if (!Object.hasOwn(value, "completedAt")) fail("failed operation", "requires completedAt");
			if (!result || typeof result.error !== "string" || result.error.length === 0) {
				fail("failed operation", "requires a non-empty result.error");
			}
			break;
		case "cancelled":
			if (!Object.hasOwn(value, "completedAt")) fail("cancelled operation", "requires completedAt");
			break;
	}
	// Reserve room for both a full payload and a full result plus lifecycle metadata.
	stringifyJson(value, "operation", 2 * MAX_SERIALIZED_BYTES + 16 * 1024);
}

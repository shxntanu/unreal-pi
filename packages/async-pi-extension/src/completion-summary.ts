import {
	type Operation,
	type OperationOutputExcerpt,
	readOperationOutput,
	type ShellOperationPayload,
} from "@earendil-works/pi-async-operations";

const SUCCESS_STREAM_BYTES = 512;
const FAILURE_STREAM_BYTES = 8 * 1024; // 8 kb
const MAX_COMMAND_BYTES = 512;
const MAX_PURPOSE_BYTES = 256;
const MAX_ERROR_BYTES = 512;
const ERROR_LINE_PATTERN = /error|fail(?:ed|ure)?|exception|fatal|panic|traceback|not ok/i;

export async function formatCompletionSummary(
	rootDir: string,
	operation: Operation,
	payload: ShellOperationPayload,
): Promise<{ content: string; displayContent: string }> {
	const excerpts = await readOperationOutput(rootDir, operation.id, { stream: "both", tailLines: 200 });
	const stdout = excerpts.find((excerpt) => excerpt.stream === "stdout");
	const stderr = excerpts.find((excerpt) => excerpt.stream === "stderr");
	if (!stdout || !stderr) throw new Error(`Operation ${operation.id} output reader returned an incomplete stream set`);

	const metadata = operation.result?.metadata;
	const duration = numericField(metadata, "durationMs");
	const elapsed =
		operation.startedAt !== undefined && operation.completedAt !== undefined
			? operation.completedAt - operation.startedAt
			: undefined;
	let durationText = operation.startedAt === undefined ? "not started" : "not recorded";
	if (elapsed !== undefined) durationText = `${formatDuration(elapsed)} (recorded interval)`;
	if (duration !== undefined) durationText = `${formatDuration(duration)} (runner)`;
	const exitCode = operation.result?.exitCode ?? numericField(metadata, "exitCode");
	const signal = textField(metadata, "signal");
	const failureKind = operation.result?.failureKind;
	const error = operation.result?.error;
	const stdoutBytes = outputByteCount(stdout, metadata, "stdoutBytes");
	const stderrBytes = outputByteCount(stderr, metadata, "stderrBytes");
	const stdoutPath = operation.result?.stdoutPath ?? stdout.path;
	const stderrPath = operation.result?.stderrPath ?? stderr.path;
	const diagnostic = operation.state !== "completed";
	const streamBudget = diagnostic ? FAILURE_STREAM_BYTES : SUCCESS_STREAM_BYTES;
	const stdoutExcerpt = selectExcerpt(stdout, streamBudget, diagnostic);
	const stderrExcerpt = selectExcerpt(stderr, streamBudget, diagnostic);
	const excerptsBounded = stdout.truncated || stderr.truncated || stdoutExcerpt.truncated || stderrExcerpt.truncated;

	const lines = [
		"Async operation terminal notification",
		`Operation: ${operation.id}`,
		`Status: ${operation.state}`,
		`Command: ${compactText(sanitizeText(payload.command), MAX_COMMAND_BYTES)}`,
		...(payload.purpose ? [`Purpose: ${compactText(sanitizeText(payload.purpose), MAX_PURPOSE_BYTES)}`] : []),
		`Duration: ${durationText}`,
		`Exit code: ${exitCode === undefined ? "not recorded" : String(exitCode)}`,
		`Signal: ${signal ?? "none recorded"}`,
		`Failure: ${failureKind ?? "none recorded"}`,
		`Error: ${error ? compactText(sanitizeText(error), MAX_ERROR_BYTES) : "none recorded"}`,
		`stdout: ${stdoutBytes} bytes; ${sanitizeText(stdoutPath)}`,
		`stderr: ${stderrBytes} bytes; ${sanitizeText(stderrPath)}`,
		"stdout excerpt:",
		sanitizeText(stdout.text) || (stdout.missing ? "(output unavailable)" : "(no output)"),
		"stderr excerpt:",
		sanitizeText(stderr.text) || (stderr.missing ? "(output unavailable)" : "(no output)"),
		"Only bounded output excerpts are included; use operation_output to inspect more output.",
		...(excerptsBounded ? ["The scanned output or summary excerpt was truncated to fit its bounds."] : []),
	];
	const compactLines = [
		`Operation ${operation.id}: ${operation.state}${exitCode === undefined ? "" : `, exit ${exitCode}`} — ${compactText(sanitizeText(payload.command), MAX_COMMAND_BYTES)}`,
		...(payload.purpose ? [`Purpose: ${compactText(sanitizeText(payload.purpose), MAX_PURPOSE_BYTES)}`] : []),
		...(signal ? [`Signal: ${signal}`] : []),
		...(failureKind ? [`Failure: ${failureKind}`] : []),
		...(error ? [`Error: ${compactText(sanitizeText(error), MAX_ERROR_BYTES)}`] : []),
	];
	for (const [excerpt, selected] of [
		[stdout, stdoutExcerpt],
		[stderr, stderrExcerpt],
	] as const) {
		if (excerpt.missing) compactLines.push(`${excerpt.stream}: output unavailable`);
		else if (selected.text) compactLines.push(`${excerpt.stream}:\n${selected.text}`);
	}
	if (excerptsBounded || stdout.missing || stderr.missing) {
		compactLines.push("Output excerpted or unavailable; more available through operation_output.");
	}
	return { content: compactLines.join("\n"), displayContent: lines.join("\n") };
}

function numericField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function textField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? sanitizeText(value) : undefined;
}

function outputByteCount(
	excerpt: OperationOutputExcerpt,
	metadata: Record<string, unknown> | undefined,
	metadataKey: "stdoutBytes" | "stderrBytes",
): string {
	const recorded = numericField(metadata, metadataKey);
	if (recorded !== undefined) return String(recorded);
	return excerpt.missing ? "unknown" : String(excerpt.bytes);
}

function formatDuration(milliseconds: number): string {
	if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
	return `${(milliseconds / 1000).toFixed(1)}s`;
}

function selectExcerpt(
	excerpt: OperationOutputExcerpt,
	maxBytes: number,
	diagnostic: boolean,
): { text: string; truncated: boolean } {
	if (excerpt.missing || !excerpt.text) return { text: "", truncated: false };
	const sanitized = sanitizeText(excerpt.text);
	if (Buffer.byteLength(sanitized, "utf8") <= maxBytes) return { text: sanitized, truncated: false };
	const lines = sanitized.split("\n");
	const lastIndex = lines.findLastIndex((line) => line.length > 0);
	if (lastIndex < 0) return { text: "", truncated: false };
	const tailStart = Math.max(0, lastIndex - 7);
	const priority = new Set<number>();
	if (diagnostic) {
		for (let index = lastIndex; index >= 0; index--) {
			if (!ERROR_LINE_PATTERN.test(lines[index]!)) continue;
			priority.add(index);
			// Include neighboring source locations and diagnostic continuation lines.
			if (index > 0) priority.add(index - 1);
			if (index < lastIndex) priority.add(index + 1);
		}
	}
	for (let index = lastIndex; index >= tailStart; index--) priority.add(index);

	const selected = new Map<number, string>();
	let usedBytes = 0;
	let truncated = false;
	for (const index of priority) {
		const original = lines[index]!;
		if (!original) continue;
		const separatorBytes = selected.size === 0 ? 0 : 1;
		const remaining = maxBytes - usedBytes - separatorBytes;
		if (remaining < Buffer.byteLength(" [truncated]", "utf8")) {
			truncated = true;
			continue;
		}
		const line = compactText(original, remaining);
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (lineBytes > remaining) {
			truncated = true;
			continue;
		}
		if (line !== original) truncated = true;
		selected.set(index, line);
		usedBytes += separatorBytes + lineBytes;
	}
	if (selected.size < lines.filter((line) => line.length > 0).length) truncated = true;
	const text = [...selected.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, line]) => line)
		.join("\n");
	return { text, truncated };
}

function sanitizeText(text: string): string {
	return text
		.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
		.replace(/\t/g, " ");
}

function compactText(text: string, maxBytes: number): string {
	const encoded = Buffer.from(text, "utf8");
	if (encoded.byteLength <= maxBytes) return text;
	const marker = " [truncated]";
	const prefixLimit = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	let end = Math.min(prefixLimit, encoded.byteLength);
	while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
	return `${encoded.subarray(0, end).toString("utf8")}${marker}`;
}

import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { OperationOutputExcerpt, OperationOutputOptions } from "./shell-types.ts";
import { validateOperationId } from "./validation.ts";

const MAX_SCAN_BYTES = 256 * 1024;
const MAX_CONTAINS_BYTES = 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_TEXT_BYTES_PER_STREAM = 16 * 1024;
const ALLOWED_OPTIONS: Record<string, true> = { stream: true, tailLines: true, contains: true };

interface NormalizedOptions {
	stream: "stdout" | "stderr" | "both";
	tailLines: number;
	contains?: string;
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function validateOptions(options: OperationOutputOptions | undefined): NormalizedOptions {
	if (options === undefined) return { stream: "both", tailLines: 200 };
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		throw new TypeError("Output options must be a plain object");
	}
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Output options must be a plain object");
	}
	let streamValue: unknown;
	let tailLinesValue: unknown;
	let containsValue: unknown;
	for (const key of Reflect.ownKeys(options)) {
		if (typeof key !== "string" || !Object.hasOwn(ALLOWED_OPTIONS, key)) {
			throw new TypeError(`Output options contain unsupported property ${String(key)}`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(options, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
			throw new TypeError(`Output option ${key} must be an enumerable data property`);
		}
		if (key === "stream") streamValue = descriptor.value;
		else if (key === "tailLines") tailLinesValue = descriptor.value;
		else containsValue = descriptor.value;
	}

	const stream = streamValue === undefined ? "both" : streamValue;
	if (stream !== "stdout" && stream !== "stderr" && stream !== "both") {
		throw new TypeError('Output option stream must be "stdout", "stderr", or "both"');
	}
	const tailLines = tailLinesValue === undefined ? 200 : tailLinesValue;
	if (typeof tailLines !== "number" || !Number.isSafeInteger(tailLines) || tailLines < 1 || tailLines > 1000) {
		throw new TypeError("Output option tailLines must be an integer from 1 to 1000");
	}
	const contains = containsValue;
	if (contains !== undefined) {
		if (typeof contains !== "string") throw new TypeError("Output option contains must be a string");
		if (Buffer.byteLength(contains, "utf8") > MAX_CONTAINS_BYTES) {
			throw new TypeError(`Output option contains must be at most ${MAX_CONTAINS_BYTES} UTF-8 bytes`);
		}
	}
	return { stream, tailLines, ...(contains === undefined ? {} : { contains }) };
}

function assertContained(rootPath: string, candidate: string): void {
	const pathFromRoot = relative(rootPath, candidate);
	if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
		throw new Error("Operation output path escaped its root directory");
	}
}

async function existingDirectory(path: string, expectedRealPath: string, rootRealPath: string): Promise<boolean> {
	let details: Stats;
	try {
		details = await lstat(path);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return false;
		throw error;
	}
	if (!details.isDirectory() || details.isSymbolicLink()) {
		throw new Error(`Operation output directory is not a real directory: ${path}`);
	}
	let actualPath: string;
	try {
		actualPath = await realpath(path);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return false;
		throw error;
	}
	assertContained(rootRealPath, actualPath);
	if (actualPath !== expectedRealPath) {
		throw new Error(`Operation output directory resolved to an unexpected path: ${path}`);
	}
	return true;
}

function missingExcerpt(stream: "stdout" | "stderr", path: string): OperationOutputExcerpt {
	return { stream, path, text: "", bytes: 0, scannedBytes: 0, truncated: false, missing: true };
}

function parseLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	for (let index = 0; index < lines.length; index++) {
		if (lines[index]!.endsWith("\r")) lines[index] = lines[index]!.slice(0, -1);
	}
	return lines;
}

function hasIncompleteUtf8Suffix(buffer: Buffer): boolean {
	let leadIndex = buffer.length - 1;
	while (leadIndex >= 0 && (buffer[leadIndex]! & 0xc0) === 0x80) leadIndex--;
	if (leadIndex < 0) return false;
	const lead = buffer[leadIndex]!;
	const expectedContinuationBytes =
		lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0;
	const actualContinuationBytes = buffer.length - leadIndex - 1;
	if (expectedContinuationBytes === 0 || actualContinuationBytes >= expectedContinuationBytes) return false;
	if (actualContinuationBytes > 0) {
		const secondByte = buffer[leadIndex + 1]!;
		if (
			(lead === 0xe0 && secondByte < 0xa0) ||
			(lead === 0xed && secondByte >= 0xa0) ||
			(lead === 0xf0 && secondByte < 0x90) ||
			(lead === 0xf4 && secondByte > 0x8f)
		) {
			return false;
		}
	}
	return true;
}

function limitUtf8Suffix(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const encoded = Buffer.from(text, "utf8");
	if (encoded.byteLength <= maxBytes) return { text, truncated: false };
	let start = encoded.byteLength - maxBytes;
	while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start++;
	return { text: encoded.subarray(start).toString("utf8"), truncated: true };
}

async function readExcerpt(
	stream: "stdout" | "stderr",
	path: string,
	tailLines: number,
	contains: string | undefined,
	textLimit: number,
): Promise<OperationOutputExcerpt> {
	let handle: FileHandle;
	try {
		const noFollow = constants.O_NOFOLLOW ?? 0;
		handle = await open(path, constants.O_RDONLY | noFollow);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return missingExcerpt(stream, path);
		throw error;
	}
	try {
		const fileDetails = await handle.stat();
		if (!fileDetails.isFile()) throw new Error(`Operation output is not a regular file: ${path}`);
		if (!Number.isSafeInteger(fileDetails.size) || fileDetails.size < 0) {
			throw new RangeError(`Operation output file is too large to report accurately: ${path}`);
		}
		const bytes = fileDetails.size;
		const needsPrefix = bytes > MAX_SCAN_BYTES;
		const requestedBytes = Math.min(bytes, MAX_SCAN_BYTES - (needsPrefix ? 1 : 0));
		const offset = bytes - requestedBytes;
		let scannedBytes = 0;
		let startsAtLineBoundary = false;
		if (offset > 0) {
			const precedingByte = Buffer.allocUnsafe(1);
			const result = await handle.read(precedingByte, 0, 1, offset - 1);
			scannedBytes += result.bytesRead;
			startsAtLineBoundary = result.bytesRead === 1 && precedingByte[0] === 0x0a;
		}
		const buffer = Buffer.allocUnsafe(requestedBytes);
		let suffixReadBytes = 0;
		while (suffixReadBytes < requestedBytes) {
			const result = await handle.read(
				buffer,
				suffixReadBytes,
				requestedBytes - suffixReadBytes,
				offset + suffixReadBytes,
			);
			if (result.bytesRead === 0) break;
			suffixReadBytes += result.bytesRead;
			scannedBytes += result.bytesRead;
		}

		const scannedBuffer = buffer.subarray(0, suffixReadBytes);
		const incompleteUtf8 = hasIncompleteUtf8Suffix(scannedBuffer);
		// Streaming decode intentionally drops a valid incomplete scalar at the end of a live log snapshot.
		let decoded = new TextDecoder("utf-8", { ignoreBOM: true }).decode(scannedBuffer, {
			stream: true,
		});
		if (offset > 0 && !startsAtLineBoundary) {
			const firstLineEnd = decoded.indexOf("\n");
			decoded = firstLineEnd < 0 ? "" : decoded.slice(firstLineEnd + 1);
		}
		let lines = parseLines(decoded);
		if (contains !== undefined) lines = lines.filter((line) => line.includes(contains));
		const tooManyLines = lines.length > tailLines;
		if (tooManyLines) lines = lines.slice(-tailLines);
		const limited = limitUtf8Suffix(lines.join("\n"), textLimit);
		return {
			stream,
			path,
			text: limited.text,
			bytes,
			scannedBytes,
			truncated: bytes > scannedBytes || tooManyLines || limited.truncated || incompleteUtf8,
			missing: false,
		};
	} finally {
		await handle.close();
	}
}

/** Reads bounded stdout/stderr excerpts from an operation's owned run directory. */
export async function readOperationOutput(
	rootDir: string,
	operationId: string,
	options?: OperationOutputOptions,
): Promise<OperationOutputExcerpt[]> {
	if (typeof rootDir !== "string" || rootDir.length === 0) throw new TypeError("rootDir must be a non-empty string");
	validateOperationId(operationId);
	const normalized = validateOptions(options);
	const rootPath = resolve(rootDir);
	let rootRealPath: string;
	try {
		rootRealPath = await realpath(rootPath);
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
		return outputStreams(normalized.stream).map((stream) =>
			missingExcerpt(stream, resolve(rootPath, "runs", operationId, `${stream}.log`)),
		);
	}
	const expectedRunsRealPath = resolve(rootRealPath, "runs");
	const runsPath = resolve(rootPath, "runs");
	if (!(await existingDirectory(runsPath, expectedRunsRealPath, rootRealPath))) {
		return outputStreams(normalized.stream).map((stream) =>
			missingExcerpt(stream, resolve(rootPath, "runs", operationId, `${stream}.log`)),
		);
	}

	const expectedOperationRealPath = resolve(expectedRunsRealPath, operationId);
	const operationPath = resolve(runsPath, operationId);
	if (!(await existingDirectory(operationPath, expectedOperationRealPath, rootRealPath))) {
		return outputStreams(normalized.stream).map((stream) =>
			missingExcerpt(stream, resolve(operationPath, `${stream}.log`)),
		);
	}

	const streams = outputStreams(normalized.stream);
	const perStreamLimit = streams.length === 2 ? MAX_TEXT_BYTES_PER_STREAM : MAX_TEXT_BYTES;
	const excerpts: OperationOutputExcerpt[] = [];
	for (const stream of streams) {
		const path = resolve(operationPath, `${stream}.log`);
		const canonicalPath = resolve(expectedOperationRealPath, `${stream}.log`);
		assertContained(rootRealPath, canonicalPath);
		let details: Stats;
		try {
			details = await lstat(path);
		} catch (error) {
			if (isErrno(error, "ENOENT")) {
				excerpts.push(missingExcerpt(stream, path));
				continue;
			}
			throw error;
		}
		if (details.isSymbolicLink()) throw new Error(`Operation output must not be a symbolic link: ${path}`);
		let actualPath: string;
		try {
			actualPath = await realpath(path);
		} catch (error) {
			if (isErrno(error, "ENOENT")) {
				excerpts.push(missingExcerpt(stream, path));
				continue;
			}
			throw error;
		}
		assertContained(rootRealPath, actualPath);
		if (actualPath !== canonicalPath) throw new Error(`Operation output resolved to an unexpected path: ${path}`);
		excerpts.push(await readExcerpt(stream, path, normalized.tailLines, normalized.contains, perStreamLimit));
	}
	return excerpts;
}

function outputStreams(stream: NormalizedOptions["stream"]): ("stdout" | "stderr")[] {
	if (stream === "both") return ["stdout", "stderr"];
	return [stream];
}

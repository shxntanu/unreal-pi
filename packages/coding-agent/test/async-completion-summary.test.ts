import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Operation, ShellOperationPayload } from "@earendil-works/pi-async-operations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatCompletionSummary } from "../../async-pi-extension/src/completion-summary.ts";
import { convertToLlm, createCustomMessage } from "../src/core/messages.ts";
import { buildSessionContext, type CustomMessageEntry } from "../src/core/session-manager.ts";

const id = "12345678-1234-1234-1234-123456789abc";
const payload: ShellOperationPayload = { version: 1, command: "npm run check", cwd: "/tmp" };
const operation: Operation = {
	id,
	version: 1,
	kind: "shell",
	payload,
	state: "completed",
	createdAt: 0,
	startedAt: 1,
	completedAt: 1000,
	result: { exitCode: 0 },
};
let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(join(tmpdir(), "pi-completion-test-"));
	await mkdir(join(rootDir, "runs", id), { recursive: true });
	await writeFile(join(rootDir, "runs", id, "stdout.log"), "");
	await writeFile(join(rootDir, "runs", id, "stderr.log"), "");
});
afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

async function output(stdout: string, stderr = ""): Promise<void> {
	await writeFile(join(rootDir, "runs", id, "stdout.log"), stdout);
	await writeFile(join(rootDir, "runs", id, "stderr.log"), stderr);
}

describe("async completion summaries", () => {
	it("omits empty metadata and empty streams from model content", async () => {
		const summary = await formatCompletionSummary(rootDir, operation, payload);
		expect(summary.content).toBe(`Operation ${id}: completed, exit 0 — npm run check`);
		expect(summary.displayContent).toContain("Duration: 1.0s");
		expect(summary.displayContent).toContain("stdout: 0 bytes;");
	});

	it("preserves all short successful output, including search or API answers", async () => {
		const answer = Array.from({ length: 12 }, (_, index) => `answer ${index}`).join("\n");
		await output(answer);
		const summary = await formatCompletionSummary(rootDir, operation, payload);
		expect(summary.content).toContain(answer);
		expect(summary.content).not.toContain("excerpted");
	});

	it("keeps richer human output while bounding successful model excerpts", async () => {
		await output(Array.from({ length: 60 }, (_, index) => `human-only-${index} ${"x".repeat(80)}`).join("\n"));
		const summary = await formatCompletionSummary(rootDir, operation, payload);
		expect(summary.displayContent).toContain("human-only-0");
		expect(summary.content).not.toContain("human-only-0");
		expect(summary.content).toContain("operation_output");
		expect(Buffer.byteLength(summary.content)).toBeLessThan(800);
	});

	it("prioritizes failures and nearby diagnostic lines over a noisy tail", async () => {
		await output(
			[
				"src/foo.ts:42",
				"error: incompatible types",
				"expected number, received string",
				...Array.from({ length: 100 }, () => "noise ".repeat(20)),
			].join("\n"),
		);
		const failed: Operation = { ...operation, state: "failed", result: { exitCode: 1, failureKind: "nonzero_exit" } };
		const summary = await formatCompletionSummary(rootDir, failed, payload);
		expect(summary.content).toContain("failed, exit 1");
		expect(summary.content).toContain("src/foo.ts:42\nerror: incompatible types\nexpected number, received string");
		expect(Buffer.byteLength(summary.content)).toBeLessThan(8600);
	});

	it("reports cancelled, timed out, and lost-process outcomes without inventing an exit code", async () => {
		for (const failureKind of ["cancelled", "timeout", "lost_process"] as const) {
			const summary = await formatCompletionSummary(
				rootDir,
				{
					...operation,
					state: failureKind === "cancelled" ? "cancelled" : "failed",
					result: { failureKind, error: "runner stopped", metadata: { signal: "SIGTERM" } },
				},
				payload,
			);
			expect(summary.content).toContain(`Failure: ${failureKind}`);
			expect(summary.content).toContain("Signal: SIGTERM");
			expect(summary.content).toContain("Error: runner stopped");
			expect(summary.content).not.toContain("exit ");
		}
	});

	it("discloses missing logs and sanitizes terminal control codes and Unicode truncation", async () => {
		await output(`\u001b[31m${"界".repeat(600)}\u001b[0m`);
		await rm(join(rootDir, "runs", id, "stderr.log"));
		const summary = await formatCompletionSummary(rootDir, operation, payload);
		expect(summary.content).toContain("stderr: output unavailable");
		expect(summary.content).toContain("operation_output");
		expect(summary.content).not.toMatch(/[\u001b\ufffd]/);
		expect(summary.displayContent).not.toContain("\u001b");
	});

	it("excludes human details from live, reloaded, and compaction model context", async () => {
		await output(Array.from({ length: 60 }, (_, index) => `human-only-${index} ${"x".repeat(80)}`).join("\n"));
		const summary = await formatCompletionSummary(rootDir, operation, payload);
		const details = { version: 1, operationId: id, state: "completed", displayContent: summary.displayContent };
		const live = createCustomMessage(
			"async-operation-completion",
			summary.content,
			true,
			details,
			new Date(0).toISOString(),
		);
		expect(JSON.stringify(convertToLlm([live]))).not.toContain("human-only-0");
		const entry: CustomMessageEntry = {
			type: "custom_message",
			id: "completion",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: live.customType,
			content: summary.content,
			display: true,
			details,
		};
		const reloaded = buildSessionContext(JSON.parse(JSON.stringify([entry]))).messages;
		// Compaction and branch summarization use this same conversion.
		expect(JSON.stringify(convertToLlm(reloaded))).not.toContain("human-only-0");
		expect(JSON.stringify(reloaded)).toContain("human-only-0");
	});
});

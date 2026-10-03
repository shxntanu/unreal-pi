import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface RunMetrics {
	version: 1;
	type: "run";
	mode: "baseline";
	runId: string;
	sessionId: string;
	provider?: string;
	model?: string;
	thinkingLevel: string;
	startedAt: number;
	finishedAt: number;
	modelCalls: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cacheWriteTokens: number;
	toolCalls: number;
	toolDurationMs: number;
	turnCount: number;
	wallClockMs: number;
	errors: number;
	aborted: boolean;
	complete: boolean;
	telemetryComplete: boolean;
}

interface ToolMetric {
	version: 1;
	type: "tool";
	runId: string;
	sessionId: string;
	toolCallId: string;
	parentToolCallId?: string;
	toolName: string;
	startTime: number;
	finishTime: number;
	durationMs: number;
	success: boolean;
	complete: boolean;
}

interface ActiveRun {
	metrics: RunMetrics;
	path: string;
	started: number;
	tools: Map<
		string,
		{ metric: Omit<ToolMetric, "finishTime" | "durationMs" | "success" | "complete">; started: number }
	>;
}

/** Observation only: no tools, prompt changes, messages, or session entries. */
export default function baselineMetrics(pi: ExtensionAPI): void {
	pi.registerFlag("baseline-results", {
		description: "Baseline JSONL path (default: experiments/async-harness/results/baseline-YYYYMMDD.jsonl)",
		type: "string",
	});

	let run: ActiveRun | undefined;

	async function persist(active: ActiveRun, record: RunMetrics | ToolMetric): Promise<void> {
		try {
			await appendFile(active.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		} catch (error) {
			active.metrics.telemetryComplete = false;
			throw error;
		}
	}

	async function finish(complete: boolean): Promise<void> {
		if (!run) return;
		const active = run;
		run = undefined;
		active.metrics.finishedAt = Date.now();
		active.metrics.wallClockMs = performance.now() - active.started;
		active.metrics.complete = complete;
		for (const { metric, started } of active.tools.values()) {
			const durationMs = performance.now() - started;
			active.metrics.toolDurationMs += durationMs;
			active.metrics.errors++;
			active.metrics.telemetryComplete = false;
			await persist(active, {
				...metric,
				finishTime: active.metrics.finishedAt,
				durationMs,
				success: false,
				complete: false,
			});
		}
		await persist(active, active.metrics);
	}

	pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
		// Automatic retry/recovery can start another low-level run before settlement.
		if (run) return;
		const startedAt = Date.now();
		const date = new Date(startedAt).toISOString().slice(0, 10).replaceAll("-", "");
		const configuredPath = pi.getFlag("baseline-results");
		const path =
			typeof configuredPath === "string" && configuredPath.length > 0
				? resolve(ctx.cwd, configuredPath)
				: join(ctx.cwd, "experiments", "async-harness", "results", `baseline-${date}.jsonl`);
		run = {
			path,
			started: performance.now(),
			tools: new Map(),
			metrics: {
				version: 1,
				type: "run",
				mode: "baseline",
				runId: randomUUID(),
				sessionId: ctx.sessionManager.getSessionId(),
				provider: ctx.model?.provider,
				model: ctx.model?.id,
				thinkingLevel: ctx.thinkingLevel ?? "off",
				startedAt,
				finishedAt: startedAt,
				modelCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 0,
				cacheWriteTokens: 0,
				toolCalls: 0,
				toolDurationMs: 0,
				turnCount: 0,
				wallClockMs: 0,
				errors: 0,
				aborted: false,
				complete: false,
				telemetryComplete: true,
			},
		};
		try {
			await mkdir(dirname(path), { recursive: true });
		} catch (error) {
			run.metrics.telemetryComplete = false;
			throw error;
		}
	});

	pi.on("turn_start", () => {
		if (run) run.metrics.turnCount++;
	});

	pi.on("message_end", (event) => {
		if (!run || event.message.role !== "assistant") return;
		const message = event.message;
		const metrics = run.metrics;
		metrics.modelCalls++;
		metrics.inputTokens += message.usage.input;
		metrics.outputTokens += message.usage.output;
		metrics.cachedInputTokens += message.usage.cacheRead;
		metrics.cacheWriteTokens += message.usage.cacheWrite;
		if (message.stopReason === "error" || message.stopReason === "aborted") metrics.errors++;
		if (message.stopReason === "aborted") metrics.aborted = true;
	});

	pi.on("tool_execution_start", (event) => {
		if (!run) return;
		run.metrics.toolCalls++;
		run.tools.set(event.toolCallId, {
			started: performance.now(),
			metric: {
				version: 1,
				type: "tool",
				runId: run.metrics.runId,
				sessionId: run.metrics.sessionId,
				toolCallId: event.toolCallId,
				parentToolCallId: event.parentToolCallId,
				toolName: event.toolName,
				startTime: Date.now(),
			},
		});
	});

	pi.on("tool_execution_end", async (event) => {
		if (!run) return;
		const active = run;
		const tool = active.tools.get(event.toolCallId);
		if (!tool) {
			active.metrics.telemetryComplete = false;
			throw new Error(`Baseline metrics: missing start for tool ${event.toolCallId}`);
		}
		const durationMs = performance.now() - tool.started;
		active.tools.delete(event.toolCallId);
		active.metrics.toolDurationMs += durationMs;
		if (event.isError) active.metrics.errors++;
		await persist(active, {
			...tool.metric,
			finishTime: Date.now(),
			durationMs,
			success: !event.isError,
			complete: true,
		});
	});

	pi.on("agent_settled", async () => await finish(true));
	pi.on("session_shutdown", async () => await finish(false));
}

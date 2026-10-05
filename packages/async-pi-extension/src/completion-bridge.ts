import {
	type LocalOperationManager,
	type OperationEvent,
	type OperationState,
	type ShellOperationPayload,
	validateShellOperationPayload,
} from "@earendil-works/pi-async-operations";
import type { ExtensionAPI, ExtensionContext, SendMessageOptions } from "@earendil-works/pi-coding-agent";
import { formatCompletionSummary } from "./completion-summary.ts";

export const COMPLETION_CUSTOM_TYPE = "async-operation-completion";

const PAGE_SIZE = 100;
const MAX_CONCURRENT_FORMATS = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

type TerminalState = Extract<OperationState, "completed" | "failed" | "cancelled">;
type CompletionReceipt = {
	version: 1;
	sessionId: string;
	operationId: string;
	state: TerminalState;
};
type ReceiptEntry = { type: string; customType?: string; details?: unknown };
type NotificationJob = { operationId: string; expectedState: TerminalState | undefined };
type CompletionBridgeOptions = {
	pi: ExtensionAPI;
	context: ExtensionContext;
	manager: LocalOperationManager;
	rootDir: string;
	sessionId: string;
};

export class CompletionBridge {
	private readonly pi: ExtensionAPI;
	private readonly context: ExtensionContext;
	private readonly manager: LocalOperationManager;
	private readonly rootDir: string;
	private readonly sessionId: string;
	private readonly persistedReceipts = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly queued: NotificationJob[] = [];
	private readonly formatting = new Set<Promise<void>>();
	private unsubscribe?: () => void;
	private reconciliation?: Promise<void>;
	private closePromise?: Promise<void>;
	private activeFormatting = 0;
	private started = false;
	private closed = false;

	constructor(options: CompletionBridgeOptions) {
		this.pi = options.pi;
		this.context = options.context;
		this.manager = options.manager;
		this.rootDir = options.rootDir;
		this.sessionId = options.sessionId;
	}

	start(): void {
		if (this.started || this.closed) return;
		this.started = true;
		for (const entry of this.context.sessionManager.getEntries()) {
			const receipt = this.parseReceipt(entry);
			if (receipt) this.persistedReceipts.add(receipt.operationId);
		}

		this.unsubscribe = this.manager.subscribe((event) => {
			const state = terminalStateForEvent(event);
			if (state) this.schedule(event.operationId, state);
		});
		this.reconciliation = this.reconcile().catch((error: unknown) => {
			this.notify(`Could not recover pending async-operation notifications: ${asError(error).message}`);
		});
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.queued.length = 0;
		this.closePromise = (async () => {
			await this.reconciliation;
			while (this.formatting.size > 0) await Promise.all([...this.formatting]);
		})();
		return this.closePromise;
	}

	private async reconcile(): Promise<void> {
		let offset = 0;
		for (;;) {
			if (this.closed) return;
			const operations = await this.manager.list({
				kind: "shell",
				sessionId: this.sessionId,
				limit: PAGE_SIZE,
				offset,
			});
			if (this.closed) return;
			for (const operation of operations) {
				if (operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled") {
					this.schedule(operation.id, operation.state);
				}
			}
			if (operations.length < PAGE_SIZE) return;
			offset += operations.length;
		}
	}

	private schedule(operationId: string, expectedState?: TerminalState): void {
		if (
			this.closed ||
			!UUID_PATTERN.test(operationId) ||
			this.persistedReceipts.has(operationId) ||
			this.inFlight.has(operationId)
		) {
			return;
		}
		this.inFlight.add(operationId);
		this.queued.push({ operationId, expectedState });
		this.pump();
	}

	private pump(): void {
		while (!this.closed && this.activeFormatting < MAX_CONCURRENT_FORMATS && this.queued.length > 0) {
			const job = this.queued.shift()!;
			this.activeFormatting++;
			let work: Promise<void>;
			work = this.deliver(job.operationId, job.expectedState)
				.catch((error: unknown) => {
					this.notify(`Could not notify about async operation ${job.operationId}: ${asError(error).message}`);
				})
				.finally(() => {
					this.formatting.delete(work);
					this.activeFormatting--;
					this.pump();
				});
			this.formatting.add(work);
		}
	}

	private async deliver(operationId: string, expectedState?: TerminalState): Promise<void> {
		if (this.closed) return;
		const operation = await this.manager.get(operationId);
		if (this.closed) return;
		if (
			!operation ||
			operation.kind !== "shell" ||
			operation.sessionId !== this.sessionId ||
			(operation.state !== "completed" && operation.state !== "failed" && operation.state !== "cancelled") ||
			(expectedState !== undefined && operation.state !== expectedState)
		) {
			return;
		}
		if (typeof operation.payload !== "object" || operation.payload === null || Array.isArray(operation.payload)) {
			throw new Error("stored shell payload is not an object");
		}
		validateShellOperationPayload(operation.payload);
		const payload = operation.payload as ShellOperationPayload;
		const { content, displayContent } = await formatCompletionSummary(this.rootDir, operation, payload);
		if (this.closed) return;

		const receipt: CompletionReceipt = {
			version: 1,
			sessionId: this.sessionId,
			operationId: operation.id,
			state: operation.state,
		};
		const options: SendMessageOptions = {
			triggerTurn: true,
			deliverAs: "steer",
			onPersisted: (entryId) => this.acknowledge(entryId, receipt),
		};
		this.pi.sendMessage(
			{
				customType: COMPLETION_CUSTOM_TYPE,
				content,
				display: true,
				details: { ...receipt, displayContent },
			},
			options,
		);
	}

	private acknowledge(entryId: string, receipt: CompletionReceipt): void {
		if (this.closed) return;
		try {
			const entry = this.context.sessionManager.getEntry(entryId);
			const actualReceipt = entry ? this.parseReceipt(entry) : undefined;
			if (
				!actualReceipt ||
				actualReceipt.sessionId !== receipt.sessionId ||
				actualReceipt.operationId !== receipt.operationId ||
				actualReceipt.state !== receipt.state
			) {
				this.notify(
					`Async operation ${receipt.operationId} notification did not persist its matching receipt; it will be recovered after restart.`,
				);
				return;
			}
			this.persistedReceipts.add(receipt.operationId);
			this.inFlight.delete(receipt.operationId);
		} catch (error) {
			this.notify(
				`Could not confirm async operation ${receipt.operationId} notification: ${asError(error).message}`,
			);
		}
	}

	private parseReceipt(entry: ReceiptEntry): CompletionReceipt | undefined {
		if (entry.type !== "custom_message" || entry.customType !== COMPLETION_CUSTOM_TYPE) return undefined;
		const value = entry.details;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const details = value as {
			version?: unknown;
			sessionId?: unknown;
			operationId?: unknown;
			state?: unknown;
		};
		if (
			details.version !== 1 ||
			details.sessionId !== this.sessionId ||
			typeof details.operationId !== "string" ||
			!UUID_PATTERN.test(details.operationId) ||
			(details.state !== "completed" && details.state !== "failed" && details.state !== "cancelled")
		) {
			return undefined;
		}
		return {
			version: 1,
			sessionId: details.sessionId,
			operationId: details.operationId,
			state: details.state,
		};
	}

	private notify(message: string): void {
		if (this.closed) return;
		try {
			this.context.ui.notify(message, "error");
		} catch {
			// UI teardown must not turn a notification failure into operation-manager failure.
		}
	}
}

function terminalStateForEvent(event: OperationEvent): TerminalState | undefined {
	switch (event.type) {
		case "operation.completed":
			return "completed";
		case "operation.failed":
			return "failed";
		case "operation.cancelled":
			return "cancelled";
		default:
			return undefined;
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

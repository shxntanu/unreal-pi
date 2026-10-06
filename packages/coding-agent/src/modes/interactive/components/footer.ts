import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private sessionStats?: SessionStats;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			latestCacheHitRate,
			contextUsage,
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const { usageTotals, latestCacheHitRate, contextUsage } = this.getSessionStats();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		const dim = (text: string) => theme.fg("dim", text);
		const muted = (text: string) => theme.fg("muted", text);
		const dot = dim(" • ");

		// Replace home directory with ~
		let pwd = muted(
			formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
		);

		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd += `${dim(" on ")}${theme.fg("accent", branch)}`;
		}

		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd += `${dot}${theme.fg("text", sessionName)}`;
		}

		// Each group is rendered as one segment; groups are separated by a dim bar.
		const groups: string[] = [];

		const tokenParts: string[] = [];
		if (usageTotals.input) tokenParts.push(`${theme.fg("accent", "↑")}${muted(formatTokens(usageTotals.input))}`);
		if (usageTotals.output) tokenParts.push(`${theme.fg("success", "↓")}${muted(formatTokens(usageTotals.output))}`);
		if (tokenParts.length > 0) groups.push(tokenParts.join(" "));

		const cacheParts: string[] = [];
		if (usageTotals.cacheRead) cacheParts.push(`${dim("R")}${muted(formatTokens(usageTotals.cacheRead))}`);
		if (usageTotals.cacheWrite) cacheParts.push(`${dim("W")}${muted(formatTokens(usageTotals.cacheWrite))}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			cacheParts.push(`${dim("hit ")}${muted(`${latestCacheHitRate.toFixed(1)}%`)}`);
		}
		if (cacheParts.length > 0) groups.push(`${dim("cache ")}${cacheParts.join(" ")}`);

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (usageTotals.cost || usingSubscription) {
			groups.push(`${muted(`$${usageTotals.cost.toFixed(3)}`)}${usingSubscription ? dim(" (sub)") : ""}`);
		}

		const contextColor = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "success";
		const gaugeCells = 8;
		const filledCells =
			contextPercent === "?"
				? 0
				: Math.min(
						gaugeCells,
						Math.max(contextPercentValue > 0 ? 1 : 0, Math.round((contextPercentValue / 100) * gaugeCells)),
					);
		const gauge = theme.fg(contextColor, "━".repeat(filledCells)) + dim("─".repeat(gaugeCells - filledCells));
		const contextLabel =
			contextPercent === "?"
				? muted("?")
				: theme.fg(contextPercentValue > 70 ? contextColor : "muted", `${contextPercent}%`);
		groups.push(
			`${gauge} ${contextLabel}${dim(`/${formatTokens(contextWindow)}`)}${this.autoCompactEnabled ? dim(" auto") : ""}`,
		);
		if (areExperimentalFeaturesEnabled()) {
			groups.push(theme.bold(theme.fg("warning", "xp")));
		}

		let statsLeft = groups.join(dim(" │ "));
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, dim("..."));
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Minimum spaces between stats and model
		const minPadding = 2;

		let rightSideWithoutProvider = theme.fg("text", state.model?.id || "no-model");
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider +=
				thinkingLevel === "off"
					? `${dot}${dim("thinking off")}`
					: `${dot}${theme.getThinkingBorderColor(thinkingLevel)(thinkingLevel)}`;
		}
		// A virtual model routes each request; show where the latest response went.
		const routed = this.session.routedModel;
		if (routed) {
			const level = routed.thinkingLevel
				? `${dot}${theme.getThinkingBorderColor(routed.thinkingLevel)(routed.thinkingLevel)}`
				: "";
			rightSideWithoutProvider += `${dim(" → ")}${theme.fg("text", routed.model.id)}${level}`;
		}

		// Prepend the provider if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `${dim(`${state.model.provider}/`)}${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				rightSide = rightSideWithoutProvider;
			}
		}

		const availableForRight = width - statsLeftWidth - minPadding;
		let statsLine = statsLeft;
		if (availableForRight > 0) {
			const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
			const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
			statsLine = statsLeft + padding + truncatedRight;
		}

		const pwdLine = truncateToWidth(pwd, width, dim("..."));
		const lines = [pwdLine, statsLine];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}

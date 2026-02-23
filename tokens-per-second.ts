/**
 * Tokens Per Second Extension - displays tokens/second in the footer.
 *
 * Automatically enabled on startup. Shows real-time tok/s during streaming,
 * and cumulative average tok/s between requests.
 *
 * Fixes applied:
 * - TTFT excluded from TPS calculation (timing starts at first token received)
 * - Thinking blocks counted as output tokens
 * - Robust fallback when providers report usage.output as 0 (e.g., MiniMax)
 * - ANSI-aware truncation preserves colors
 *
 * The footer displays:
 * - ↑{input tokens} ↓{output tokens} ${total cost} | {tps} tok/s | {model}
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function stripAnsi(str: string): string {
	return str.replace(/\x1b$$[0-9;]*m/g, "");
}

function truncateToWidth(str: string, width: number): string {
	const stripped = stripAnsi(str);
	if (stripped.length <= width) return str;

	let visible = 0;
	let i = 0;
	let result = "";

	while (i < str.length && visible < width - 1) {
		const match = str.slice(i).match(/^\x1b$$[0-9;]*m/);
		if (match) {
			result += match[0];
			i += match[0].length;
		} else {
			result += str[i];
			visible++;
			i++;
		}
	}

	// Reset any open ANSI formatting before appending ellipsis
	result += "\x1b[0m…";
	return result;
}

/**
 * Estimate token count from content parts (text + thinking).
 * Uses ~4 chars per token heuristic.
 */
function estimateTokensFromContent(content: any[] | undefined): number {
	if (!content) return 0;

	let totalChars = 0;
	for (const part of content) {
		if (part.type === "text" && part.text) {
			totalChars += part.text.length;
		} else if (part.type === "thinking" && part.thinking) {
			totalChars += part.thinking.length;
		}
	}

	return Math.floor(totalChars / 4);
}

/**
 * Get a robust output token count that handles:
 * - Providers reporting usage.output = 0 despite having content (e.g., MiniMax)
 * - Providers that exclude thinking tokens from usage.output
 * - Missing usage entirely
 */
function getOutputTokens(msg: any): number {
	const estimated = estimateTokensFromContent(msg.content);
	const usageOutput = msg.usage?.output > 0 ? msg.usage.output : 0;

	// Use whichever is larger — covers broken providers and
	// providers that exclude thinking from usage.output
	if (usageOutput > 0 || estimated > 0) {
		return Math.max(usageOutput, estimated);
	}

	// Last resort: derive from totalTokens minus input-side tokens
	if (msg.usage) {
		const inputSide =
			(msg.usage.input || 0) +
			(msg.usage.cacheRead || 0) +
			(msg.usage.cacheWrite || 0);
		const implied = (msg.usage.totalTokens || 0) - inputSide;
		if (implied > 0) return implied;
	}

	return 0;
}

/**
 * Check whether a message has any visible content yet.
 */
function hasContent(msg: any): boolean {
	if (!msg.content) return false;
	return msg.content.some(
		(p: any) =>
			(p.type === "text" && p.text) ||
			(p.type === "thinking" && p.thinking),
	);
}

export default function (pi: ExtensionAPI) {
	// Cumulative stats across all completed requests
	let totalOutputTokens = 0;
	let totalStreamingTime = 0; // seconds

	// Current streaming state
	let currentOutputTokens = 0;
	let firstTokenTime = 0;
	let firstTokenReceived = false;
	let isStreaming = false;

	let footerHandle: { invalidate(): void; dispose(): void } | undefined;

	const getAverageTps = (): number => {
		if (totalStreamingTime > 0 && totalOutputTokens > 0) {
			return totalOutputTokens / totalStreamingTime;
		}
		return 0;
	};

	const getCurrentTps = (): number => {
		if (isStreaming && firstTokenReceived && currentOutputTokens > 0) {
			const elapsed = (Date.now() - firstTokenTime) / 1000;
			if (elapsed > 0.1) {
				return currentOutputTokens / elapsed;
			}
		}
		return 0;
	};

	const getDisplayTps = (): number => {
		const current = getCurrentTps();
		if (current > 0) return current;
		return getAverageTps();
	};

	pi.on("session_start", async (_event, ctx) => {
		footerHandle = ctx.ui.setFooter((_tui, theme, _footerData) => {
			const unsubBranch = _footerData.onBranchChange(() =>
				footerHandle?.invalidate(),
			);

			return {
				dispose: () => {
					unsubBranch();
				},
				invalidate() {},
				render(width: number): string[] {
					let totalInput = 0;
					let totalOutput = 0;
					let totalCost = 0;

					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as any;
							totalOutput += getOutputTokens(m);
							if (m.usage) {
								totalInput += m.usage.input || 0;
								totalCost += m.usage.cost?.total || 0;
							}
						}
					}

					const fmt = (n: number) =>
						n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
					const fmtCost = (n: number) =>
						n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(1)}`;

					const left = theme.fg(
						"dim",
						`↑${fmt(totalInput)} ↓${fmt(totalOutput)} ${fmtCost(totalCost)}`,
					);

					const tps = getDisplayTps();
					const tpsStr =
						tps > 0
							? ` ${theme.fg("accent", `${tps.toFixed(1)} tok/s`)}`
							: "";

					const modelStr = ctx.model?.id
						? ` ${theme.fg("muted", ctx.model.id)}`
						: "";

					const leftWidth = stripAnsi(left).length;
					const tpsWidth = stripAnsi(tpsStr).length;
					const rightWidth = stripAnsi(modelStr).length;
					const available = width - leftWidth - tpsWidth - rightWidth;
					const padding = " ".repeat(Math.max(1, available));

					const line = left + padding + tpsStr + modelStr;
					return [truncateToWidth(line, width)];
				},
			};
		});
	});

	// Track streaming start — don't start the timer yet (TTFT exclusion)
	pi.on("message_start", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;

		currentOutputTokens = 0;
		firstTokenTime = 0;
		firstTokenReceived = false;
		isStreaming = true;
	});

	// Track streaming updates — start timer on first content (excludes TTFT)
	pi.on("message_update", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;

		const msg = event.message as any;

		// Start timing from first actual content, excluding TTFT
		if (!firstTokenReceived && hasContent(msg)) {
			firstTokenTime = Date.now();
			firstTokenReceived = true;
		}

		currentOutputTokens = getOutputTokens(msg);
		footerHandle?.invalidate();
	});

	// Track streaming end — accumulate to cumulative totals
	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;

		const msg = event.message as any;
		const outputTokens = getOutputTokens(msg);

		// Only count elapsed time from first token (TTFT excluded)
		if (firstTokenReceived && firstTokenTime > 0) {
			const elapsed = (Date.now() - firstTokenTime) / 1000;

			if (elapsed > 0 && outputTokens > 0) {
				totalOutputTokens += outputTokens;
				totalStreamingTime += elapsed;
			}
		}

		isStreaming = false;
		currentOutputTokens = 0;
		firstTokenReceived = false;

		footerHandle?.invalidate();
	});
}
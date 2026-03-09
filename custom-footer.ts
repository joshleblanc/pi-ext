/**
 * Custom Footer Status Extension
 *
 * Adds status items to the footer: tokens, cost, context%, elapsed, cwd, git branch, model
 * Uses setStatus instead of setFooter to avoid overriding other extensions' statuses.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let sessionStart = Date.now();

	function formatElapsed(ms: number): string {
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rs = s % 60;
		if (m < 60) return `${m}m${rs > 0 ? rs + "s" : ""}`;
		const h = Math.floor(m / 60);
		const rm = m % 60;
		return `${h}h${rm > 0 ? rm + "m" : ""}`;
	}

	function fmt(n: number): string {
		if (n < 1000) return `${n}`;
		return `${(n / 1000).toFixed(1)}k`;
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionStart = Date.now();
	});

	pi.on("session_switch", async (event, _ctx) => {
		if (event.reason === "new") {
			sessionStart = Date.now();
		}
	});

	// Update status on every render tick
	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;

		// Calculate token stats from session
		let input = 0, output = 0, cost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				input += m.usage.input;
				output += m.usage.output;
				cost += m.usage.cost.total;
			}
		}

		const usage = ctx.getContextUsage();
		const ctxWindow = usage?.contextWindow ?? 0;
		const pct = usage?.percent ?? 0;
		const pctColor = pct > 75 ? "error" : pct > 50 ? "warning" : "success";

		// Token stats status
		const tokenStats =
			theme.fg("accent", `${fmt(input)}/${fmt(output)}`) +
			" " +
			theme.fg("warning", `$${cost.toFixed(2)}`) +
			" " +
			theme.fg(pctColor, `${pct.toFixed(0)}%`);

		ctx.ui.setStatus("token-stats", tokenStats);

		// Elapsed time
		const elapsed = theme.fg("dim", `${formatElapsed(Date.now() - sessionStart)}`);
		ctx.ui.setStatus("elapsed", elapsed);

		// // CWD
		// const parts = process.cwd().split("/");
		// const short = parts.length > 2 ? parts.slice(-2).join("/") : process.cwd();
		// const cwdStr = theme.fg("muted", `${short} |`);
		// ctx.ui.setStatus("cwd", cwdStr);

		// // Model with thinking indicator
		// const thinking = pi.getThinkingLevel();
		// const thinkColor = thinking === "high" ? "warning" : thinking === "medium" ? "accent" : thinking === "low" ? "dim" : "muted";
		// const modelId = ctx.model?.id || "no-model";
		// const modelStr = theme.fg(thinkColor, "◆") + " " + theme.fg("accent", modelId);
		// ctx.ui.setStatus("model-info", modelStr);
	});

	// Also update on UI render requests for elapsed time
	pi.on("session_start", async (_event, ctx) => {
		// Set up periodic refresh for elapsed time
		const interval = setInterval(() => {
			if (!ctx.hasUI) {
				clearInterval(interval);
				return;
			}
			const theme = ctx.ui.theme;
			const elapsed = theme.fg("dim", `${formatElapsed(Date.now() - sessionStart)}`);
			ctx.ui.setStatus("elapsed", elapsed);
		}, 30000);

		// Clean up on session end
		pi.on("session_shutdown", () => {
			clearInterval(interval);
		});
	});
}

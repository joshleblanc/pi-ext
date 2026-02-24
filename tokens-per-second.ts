/**
 * Tokens Per Second Extension - displays tokens/second in the footer.
 *
 * Automatically enabled on startup. Shows cumulative average tok/s
 * based on completed messages.
 *
 * The footer displays:
 * - ↑{input tokens} ↓{output tokens} ${total cost} | {tps} tok/s {time} | {model}
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  // Cumulative stats across all completed requests
  let totalOutputTokens = 0;
  let totalStreamingTime = 0; // seconds

  // Track current message start time
  let messageStartTime = 0;

  let footerHandle: { invalidate(): void; dispose(): void } | undefined;

  const getAverageTps = (): number => {
    if (totalStreamingTime > 0 && totalOutputTokens > 0) {
      return totalOutputTokens / totalStreamingTime;
    }
    return 0;
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
              if (m.usage) {
                totalOutput += m.usage.output || 0;
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

          const tps = getAverageTps();
          const tpsStr = tps > 0 ? ` ${tps.toFixed(1)} tok/s` : "";

          // Show cumulative total time
          const timeStr = totalStreamingTime > 0
            ? ` ${totalStreamingTime.toFixed(1)}s total`
            : "";

          const center = tpsStr || timeStr
            ? theme.fg("accent", tpsStr + timeStr)
            : "";

          const right = (() => {
            if (ctx.model?.id) return theme.fg("muted", ctx.model.id);

            const branch = ctx.sessionManager.getBranch();
            for (let i = branch.length - 1; i >= 0; i--) {
              const e = branch[i];
              if (e.type === "message" && e.message.role === "assistant") {
                const m = e.message as any;
                if (m.model) return theme.fg("muted", m.model);
              }
            }
            return "";
          })();

          const leftCenter = left + center;
          const leftCenterW = visibleWidth(leftCenter);
          const rightW = visibleWidth(right);

          const pad = " ".repeat(Math.max(1, width - leftCenterW - rightW));
          return [truncateToWidth(leftCenter + pad + right, width)];
        },
      };
    });
  });

  // Track message start - record when streaming begins
  pi.on("message_start", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;

    messageStartTime = Date.now();
  });

  // Handle session switch - reset stats on /new
  pi.on("session_switch", async (event, _ctx) => {
    if (event.reason === "new") {
      totalOutputTokens = 0;
      totalStreamingTime = 0;
      messageStartTime = 0;
      footerHandle?.invalidate();
    }
  });

  // Track message end - calculate tok/s from complete usage data
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;

    const msg = event.message as any;
    const outputTokens = msg.usage?.output || 0;
    const elapsed = (Date.now() - messageStartTime) / 1000;

    if (elapsed > 0 && outputTokens > 0) {
      totalOutputTokens += outputTokens;
      totalStreamingTime += elapsed;
    }

    footerHandle?.invalidate();
  });
}

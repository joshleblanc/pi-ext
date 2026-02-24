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

  let key = "tps";

  // Track current message start time
  let messageStartTime = 0;

  const reset = (ctx) => {
    totalOutputTokens = 0;
    totalStreamingTime = 0;
    messageStartTime = 0;
    update(ctx);
  }

  const update = (ctx) => {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;

    ctx.ui.setStatus(key, theme.fg("dim", "tok/s: ") + theme.fg("accent", `${getAverageTps()} tok/s`));
  }

  const getAverageTps = (): string => {
    if (totalStreamingTime > 0 && totalOutputTokens > 0) {
      return (totalOutputTokens / totalStreamingTime).toFixed(2);
    }
    return "--";
  };

  pi.on("session_start", async (_event, ctx) => {
    reset(ctx);
  });

  // Track message start - record when streaming begins
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    messageStartTime = Date.now();
    update(ctx);
  });

  // Handle session switch - reset stats on /new
  pi.on("session_switch", async (event, ctx) => {
    reset(ctx);
  });

  // Track message end - calculate tok/s from complete usage data
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const msg = event.message as any;
    const outputTokens = msg.usage?.output || 0;
    const elapsed = (Date.now() - messageStartTime) / 1000;

    if (elapsed > 0 && outputTokens > 0) {
      totalOutputTokens += outputTokens;
      totalStreamingTime += elapsed;
    }

    update(ctx);
  });
}

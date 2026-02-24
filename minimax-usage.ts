/**
 * MiniMax Coding Plan Usage Footer Extension
 *
 * Displays MiniMax coding plan usage in the footer.
 *
 * Usage:
 * - Copy to ~/.pi/agent/extensions/minimax-usage.ts
 * - Use /minimax-usage to toggle the footer
 * - Or add to settings.json for auto-load:
 *   { "extensions": ["minimax-usage"] }
 * - For auto-enable on startup when using MiniMax:
 *   Extension auto-enables when you use a MiniMax model
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Context } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

interface CodingPlanResponse {
  model_remains: {
    start_time: number;
    end_time: number;
    remains_time: number;
    current_interval_total_count: number;
    current_interval_usage_count: number;
    model_name: string
  }[]
}

export default function (pi: ExtensionAPI) {
  const CACHE_TTL = 60000; // 1 minute cache
  let interval: number;

  async function fetchCodingPlanUsage(ctx: Context) {

    const modelRegistry = ctx.modelRegistry;

    try {
      // Get MiniMax API key from model registry
      const apiKey = await modelRegistry.getApiKeyForProvider("minimax");
      if (!apiKey) {
        return null;
      }

      const response = await fetch(
        "https://api.minimax.io/v1/coding_plan/remains",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Accept": "application/json",
            "Content-Type": "application/json"
          }
        },
      );

      if (!response.ok) {
        console.error(
          `Failed to fetch coding plan with key ${apiKey}:`,
          response.status,
        );
        return "fail";
      }

      const data: CodingPlanResponse = await response.json();

      const modelDisplayName = ctx.model.id.replaceAll(/-highspeed/g, "")

      const modelRemains = data.model_remains.find(m => m.model_name === modelDisplayName)

      if (modelRemains) {
        // Calculate percentage (remaining / total * 100)
        const percent = Math.abs(modelRemains.current_interval_usage_count - modelRemains.current_interval_total_count) / modelRemains.current_interval_total_count
        const timeRemainingMs = modelRemains.remains_time

        // Format as percentage with 2 decimal places
        const percentFormatted = (percent * 100).toFixed(2) + "%"

        // Convert milliseconds to humanized string
        const timeRemainingFormatted = humanizeTime(timeRemainingMs)

        // Build a pretty colored status string
        const theme = ctx.ui.theme
        const statusText =
          theme.fg("accent", "◉ ") +
          theme.fg("text", "MiniMax Coding Plan") +
          theme.fg("dim", " | ") +
          theme.fg("success", percentFormatted) +
          theme.fg("dim", " | ") +
          theme.fg("warning", timeRemainingFormatted)

        ctx.ui.setStatus("coding-plan-percent", statusText)
      }
    } catch (error) {
      console.error("Failed to fetch coding plan:", error);
    }
  }

  // Helper function to convert milliseconds to human readable string
  function humanizeTime(ms: number): string {
    if (ms <= 0) return "0s"

    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) {
      const remainingHours = hours % 24
      return days + "d " + remainingHours + "h"
    } else if (hours > 0) {
      const remainingMinutes = minutes % 60
      return hours + "h " + remainingMinutes + "m"
    } else if (minutes > 0) {
      const remainingSeconds = seconds % 60
      return minutes + "m " + remainingSeconds + "s"
    } else {
      return seconds + "s"
    }
  }

  // Enable on startup if using MiniMax model
  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.model;
    if (model && model.provider === "minimax") {
      fetchCodingPlanUsage(ctx);
      interval = setInterval(() => {
        if (ctx.model?.provider === "minimax") {
          fetchCodingPlanUsage(ctx);
        }
      }, CACHE_TTL);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.model?.provider === "minimax") {
      fetchCodingPlanUsage(ctx);
    }
  })

  pi.on("session_shutdown", () => {
    clearInterval(interval);
  });
}

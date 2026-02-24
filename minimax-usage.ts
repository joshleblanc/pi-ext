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
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

interface CodingPlanResponse {
  code: number;
  msg: string;
  data: {
    plan_type: string;
    remain_balance: number;
    expire_time: number;
  };
}

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let usageCache: { usage: string; timestamp: number } | null = null;
  let currentModelStr = "";
  let footerTui: any = null;
  const CACHE_TTL = 60000; // 1 minute cache

  async function fetchCodingPlanUsage(
    modelRegistry: ModelRegistry,
  ): Promise<string | null> {
    // Check cache
    if (usageCache && Date.now() - usageCache.timestamp < CACHE_TTL) {
      return usageCache.usage;
    }

    try {
      // Get MiniMax API key from model registry
      const apiKey = await modelRegistry.getApiKeyForProvider("minimax");
      if (!apiKey) {
        return null;
      }

      const response = await fetch(
        "https://www.minimax.io/v1/api/openplatform/coding_plan/remains",
        {
          method: "GET",
          withCredentials: true,
          credentials: "include",
          headers: {
            Authorization: `${apiKey}`,
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
        return null;
      }

      const data: CodingPlanResponse = await response.json();

      if (data.code === 0 && data.data) {
        const balance = data.data.remain_balance;
        const planType = data.data.plan_type || "Coding Plan";

        // Format the usage string
        let usage: string;
        if (balance >= 1000000) {
          usage = `${planType}: ${(balance / 1000000).toFixed(1)}M`;
        } else if (balance >= 1000) {
          usage = `${planType}: ${(balance / 1000).toFixed(1)}K`;
        } else {
          usage = `${planType}: ${balance}`;
        }

        // Update cache
        usageCache = { usage, timestamp: Date.now() };
        return usage;
      }

      return null;
    } catch (error) {
      console.error("Error fetching coding plan:", error);
      return null;
    }
  }

  function enableFooter(ctx: any) {
    // Store reference to tui for updates
    footerTui = null;
    currentModelStr = ctx.model ? ctx.model.id : "no-model";

    // Initial fetch
    fetchCodingPlanUsage(ctx.modelRegistry)
      .then((usage) => {
        if (footerTui) {
          footerTui.requestRender();
        }
      })
      .catch(console.error);

    ctx.ui.setFooter((tui, theme, footerData) => {
      footerTui = tui;
      const unsubBranch = footerData.onBranchChange(() => {
        // Clear cache on branch change to force refresh
        usageCache = null;
        tui.requestRender();
      });

      // Refresh every minute
      const interval = setInterval(() => {
        usageCache = null;
        // Fetch in background and trigger render when done
        fetchCodingPlanUsage(ctx.modelRegistry)
          .then(() => {
            tui.requestRender();
          })
          .catch(console.error);
      }, CACHE_TTL);

      return {
        dispose() {
          unsubBranch();
          clearInterval(interval);
          footerTui = null;
        },
        invalidate() {},
        render(width: number): string[] {
          // Sync render - use cached value
          const usage = usageCache?.usage ?? null;

          // Update model from context (may have changed)
          if (ctx.model) {
            currentModelStr = ctx.model.id;
          }

          // Build left side: MiniMax usage
          const left = usage
            ? theme.fg("success", usage)
            : theme.fg("dim", "Loading...");

          // Build right side: model
          const right = theme.fg("dim", currentModelStr);

          // Pad in the middle
          const pad = " ".repeat(
            Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
          );

          return [truncateToWidth(left + pad + right, width)];
        },
      };
    });
  }

  // Enable on startup if using MiniMax model
  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.model;
    if (model && model.provider === "minimax") {
      //enabled = true;
      //enableFooter(ctx);
      ctx.ui.notify("MiniMax usage footer enabled", "info");
    }
  });

  pi.registerCommand("minimax-usage", {
    description: "Toggle MiniMax coding plan usage in footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;

      if (enabled) {
        enableFooter(ctx);
        ctx.ui.notify("MiniMax usage footer enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Default footer restored", "info");
      }
    },
  });
}

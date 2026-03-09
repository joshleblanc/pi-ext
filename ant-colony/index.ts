/**
 * 🐜 蚁群模式 (Ant Colony) — pi 扩展入口
 *
 * 方案二：后台非阻塞蚁群
 * - 蚁群在后台运行，不阻塞主对话
 * - ctx.ui.setWidget() 实时蚂蚁面板
 * - ctx.ui.setStatus() footer 进度
 * - 完成后 pi.sendMessage() 注入报告
 * - /colony-stop 取消运行中的蚁群
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, Container, Spacer, matchesKey } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { runColony, resumeColony, type QueenCallbacks } from "./queen.js";
import { Nest } from "./nest.js";
import type { ColonyState, ColonyMetrics, AntStreamEvent } from "./types.js";

import { formatDuration, formatCost, formatTokens, statusIcon, statusLabel, progressBar, casteIcon, buildReport } from "./ui.js";

// ═══ Background colony state ═══

/** Ensure .ant-colony/ is in .gitignore */
function ensureGitignore(cwd: string) {
  const gitignorePath = join(cwd, ".gitignore");
  const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  if (!content.includes(".ant-colony/")) {
    appendFileSync(gitignorePath, `${content.length && !content.endsWith("\n") ? "\n" : ""}.ant-colony/\n`);
  }
}

interface AntStreamState {
  antId: string;
  caste: string;
  lastLine: string;
  tokens: number;
}

interface ColonyLogEntry {
  timestamp: number;
  level: "info" | "warning" | "error";
  text: string;
}

interface BackgroundColony {
  goal: string;
  abortController: AbortController;
  state: ColonyState | null;
  phase: string;
  antStreams: Map<string, AntStreamState>;
  logs: ColonyLogEntry[];
  promise: Promise<ColonyState>;
}

export default function antColonyExtension(pi: ExtensionAPI) {

  // 当前运行中的后台蚁群（同时只允许一个）
  let activeColony: BackgroundColony | null = null;

  // 防止主进程主动轮询导致阻塞：仅允许显式请求的手动快照，并加冷却
  let lastBgStatusSnapshotAt = 0;
  const STATUS_SNAPSHOT_COOLDOWN_MS = 15_000;

  const extractMessageText = (message: any): string => {
    const c = message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((p: any) => {
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        if (typeof p?.content === "string") return p.content;
        return "";
      }).join("\n");
    }
    return "";
  };

  const lastUserMessageText = (ctx: any): string => {
    try {
      const branch = ctx?.sessionManager?.getBranch?.() ?? [];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i];
        if (e?.type === "message" && e.message?.role === "user") {
          return extractMessageText(e.message).trim();
        }
      }
    } catch {
      // ignore
    }
    return "";
  };

  const isExplicitStatusRequest = (ctx: any): boolean => {
    const text = lastUserMessageText(ctx);
    return /(?:\/colony-status|bg_colony_status)|(?:(?:蚁群|colony).{0,20}(?:状态|进度|进展|汇报|快照|status|progress|snapshot|update|check))|(?:(?:状态|进度|进展|汇报|快照|status|progress|snapshot|update|check).{0,20}(?:蚁群|colony))/i.test(text);
  };

  const calcProgress = (m?: ColonyMetrics | null) => {
    if (!m || m.tasksTotal <= 0) return 0;
    return Math.max(0, Math.min(1, m.tasksDone / m.tasksTotal));
  };

  const trim = (text: string, max: number) => text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;

  const pushLog = (colony: BackgroundColony, entry: Omit<ColonyLogEntry, "timestamp">) => {
    colony.logs.push({ timestamp: Date.now(), ...entry });
    if (colony.logs.length > 40) colony.logs.splice(0, colony.logs.length - 40);
  };

  // ─── Status 渲染 ───

  let lastRender = 0;
  const throttledRender = () => {
    const now = Date.now();
    if (now - lastRender < 500) return;
    lastRender = now;
    pi.events.emit("ant-colony:render");
  };

  // 每次 session_start 重新绑定事件，确保 ctx 始终是最新的
  let renderHandler: (() => void) | null = null;
  let clearHandler: (() => void) | null = null;
  let notifyHandler: ((data: { msg: string; level: "info" | "success" | "warning" | "error" }) => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    // 移除旧监听器（session 重启 / /reload 时 ctx 已失效）
    if (renderHandler) pi.events.off("ant-colony:render", renderHandler);
    if (clearHandler) pi.events.off("ant-colony:clear-ui", clearHandler);
    if (notifyHandler) pi.events.off("ant-colony:notify", notifyHandler);

    renderHandler = () => {
      if (!activeColony) return;
      const { state } = activeColony;
      const elapsed = state ? formatDuration(Date.now() - state.createdAt) : "0s";
      const m = state?.metrics;
      const phase = state?.status || "scouting";
      const progress = calcProgress(m);
      const pct = `${Math.round(progress * 100)}%`;
      const active = activeColony.antStreams.size;

      const parts = [`🐜 ${statusIcon(phase)} ${statusLabel(phase)}`];
      parts.push(m ? `${m.tasksDone}/${m.tasksTotal} (${pct})` : `0/0 (${pct})`);
      parts.push(`⚡${active}`);
      if (m) parts.push(formatCost(m.totalCost));
      parts.push(elapsed);

      ctx.ui.setStatus("ant-colony", parts.join(" │ "));
    };
    clearHandler = () => {
      ctx.ui.setStatus("ant-colony", undefined);
    };
    notifyHandler = (data) => {
      ctx.ui.notify(data.msg, data.level);
    };

    pi.events.on("ant-colony:render", renderHandler);
    pi.events.on("ant-colony:clear-ui", clearHandler);
    pi.events.on("ant-colony:notify", notifyHandler);
  });

  // ─── 同步模式（print mode）：阻塞等待蚁群完成 ───

  async function runSyncColony(params: {
    goal: string;
    maxAnts?: number;
    maxCost?: number;
    currentModel: string;
    modelOverrides: Record<string, string>;
    cwd: string;
    modelRegistry?: any;
  }, signal?: AbortSignal | null) {
    ensureGitignore(params.cwd);

    const callbacks: QueenCallbacks = {};

    try {
      const state = await runColony({
        cwd: params.cwd,
        goal: params.goal,
        maxAnts: params.maxAnts,
        maxCost: params.maxCost,
        currentModel: params.currentModel,
        modelOverrides: params.modelOverrides,
        signal: signal ?? undefined,
        callbacks,
        modelRegistry: params.modelRegistry,
      });

      return {
        content: [{ type: "text" as const, text: buildReport(state) }],
        isError: state.status === "failed" || state.status === "budget_exceeded",
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Colony failed: ${e}` }],
        isError: true,
      };
    }
  }

  // ─── 启动后台蚁群 ───

  function launchBackgroundColony(params: {
    goal: string;
    maxAnts?: number;
    maxCost?: number;
    currentModel: string;
    modelOverrides: Record<string, string>;
    cwd: string;
    modelRegistry?: any;
  }, resume = false) {
    if (activeColony) {
      pi.events.emit("ant-colony:notify", { msg: "A colony is already running. Use /colony-stop first.", level: "warning" });
      return;
    }

    const abortController = new AbortController();
    const colony: BackgroundColony = {
      goal: params.goal,
      abortController,
      state: null,
      phase: "initializing",
      antStreams: new Map(),
      logs: [],
      promise: null as any, // set below
    };

    pushLog(colony, { level: "info", text: "INITIALIZING · Colony launched in background" });

    let lastPhase = "";

    const callbacks: QueenCallbacks = {
      onSignal(signal) {
        colony.phase = signal.message;
        // 阶段切换时注入消息到主进程对话流（display: true 让 LLM 下次可见，无需轮询）
        if (signal.phase !== lastPhase) {
          lastPhase = signal.phase;
          const pct = Math.round(signal.progress * 100);
          pushLog(colony, { level: "info", text: `${statusLabel(signal.phase)} ${pct}% · ${signal.message}` });
          pi.sendMessage({
            customType: "ant-colony-progress",
            content: `[COLONY_SIGNAL:${signal.phase.toUpperCase()}] 🐜 ${signal.message} (${pct}%, ${formatCost(signal.cost)})`,
            display: true,
          }, { triggerTurn: false, deliverAs: "followUp" });
        }
        throttledRender();
      },
      onPhase(phase, detail) {
        colony.phase = detail;
        pushLog(colony, { level: "info", text: `${statusLabel(phase)} · ${detail}` });
        throttledRender();
      },
      onAntSpawn(ant, task) {
        colony.antStreams.set(ant.id, {
          antId: ant.id, caste: ant.caste, lastLine: "starting...", tokens: 0,
        });
        throttledRender();
      },
      onAntDone(ant, task) {
        colony.antStreams.delete(ant.id);
        // 每个任务完成时注入一句话到主进程
        const m = colony.state?.metrics;
        const icon = ant.status === "done" ? "✓" : "✗";
        const progress = m ? `${m.tasksDone}/${m.tasksTotal}` : "";
        const cost = m ? formatCost(m.totalCost) : "";
        pushLog(colony, {
          level: ant.status === "done" ? "info" : "warning",
          text: `${icon} ${task.title.slice(0, 80)} (${progress}${cost ? `, ${cost}` : ""})`,
        });
        pi.sendMessage({
          customType: "ant-colony-progress",
          content: `[COLONY_SIGNAL:TASK_DONE] 🐜 ${icon} ${task.title.slice(0, 60)} (${progress}, ${cost})`,
          display: true,
        }, { triggerTurn: false, deliverAs: "followUp" });
        throttledRender();
      },
      onAntStream(event: AntStreamEvent) {
        const stream = colony.antStreams.get(event.antId);
        if (stream) {
          stream.tokens++;
          const lines = event.totalText.split("\n").filter(l => l.trim());
          stream.lastLine = lines[lines.length - 1]?.trim() || "...";
        }
      },
      onProgress(metrics) {
        if (colony.state) colony.state.metrics = metrics;
        throttledRender();
      },
      onComplete(state) {
        colony.state = state;
        colony.phase = state.status === "done" ? "Colony mission complete" : "Colony failed";
        pushLog(colony, {
          level: state.status === "done" ? "info" : "error",
          text: `${statusLabel(state.status)} · ${state.metrics.tasksDone}/${state.metrics.tasksTotal} · ${formatCost(state.metrics.totalCost)}`,
        });
        colony.antStreams.clear();
        throttledRender();
        
        // Final reminder - colony is done, no more polling needed
        pi.sendMessage({
          customType: "ant-colony-done",
          content: `[COLONY_SIGNAL:DONE] 🐜 Colony finished. No more status checks needed.`,
          display: true,
        }, { triggerTurn: false, deliverAs: "followUp" });
      },
    };

    // Ensure .ant-colony/ is in .gitignore
    ensureGitignore(params.cwd);

    const colonyOpts = {
      cwd: params.cwd,
      goal: params.goal,
      maxAnts: params.maxAnts,
      maxCost: params.maxCost,
      currentModel: params.currentModel,
      modelOverrides: params.modelOverrides,
      signal: abortController.signal,
      callbacks,
      authStorage: undefined,
      modelRegistry: params.modelRegistry,
    };
    colony.promise = resume ? resumeColony(colonyOpts) : runColony(colonyOpts);

    activeColony = colony;
    lastBgStatusSnapshotAt = 0;
    throttledRender();

    // 后台等待完成，注入结果
    colony.promise.then((state) => {
      const ok = state.status === "done";
      const report = buildReport(state);
      const m = state.metrics;
      pushLog(colony, {
        level: ok ? "info" : "error",
        text: `${ok ? "COMPLETE" : "FAILED"} · ${m.tasksDone}/${m.tasksTotal} · ${formatCost(m.totalCost)}`,
      });

      // 清理 UI
      pi.events.emit("ant-colony:clear-ui");
      activeColony = null;

      // 注入结果到对话
      pi.sendMessage({
        customType: "ant-colony-report",
        content: `[COLONY_SIGNAL:COMPLETE]\n${report}`,
        display: true,
      }, { triggerTurn: true, deliverAs: "followUp" });

      pi.events.emit("ant-colony:notify", {
        msg: `🐜 Colony ${ok ? "completed" : "failed"}: ${m.tasksDone}/${m.tasksTotal} tasks │ ${formatCost(m.totalCost)}`,
        level: ok ? "success" : "error",
      });
    }).catch((e) => {
      pushLog(colony, { level: "error", text: `CRASHED · ${String(e).slice(0, 120)}` });
      pi.events.emit("ant-colony:clear-ui");
      activeColony = null;
      pi.events.emit("ant-colony:notify", { msg: `🐜 Colony crashed: ${e}`, level: "error" });
      pi.sendMessage({
        customType: "ant-colony-report",
        content: `[COLONY_SIGNAL:FAILED]\n## 🐜 Colony Crashed\n${e}`,
        display: true,
      }, { triggerTurn: true, deliverAs: "followUp" });
    });
  }





  // ═══ Custom message renderer for colony progress signals ═══
  pi.registerMessageRenderer("ant-colony-progress", (message, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const line = content.split("\n")[0] || content;
    const phaseMatch = line.match(/\[COLONY_SIGNAL:([A-Z_]+)\]/);
    const text = line.replace(/\[COLONY_SIGNAL:[A-Z_]+\]\s*/, "").trim();

    const phase = phaseMatch?.[1]?.toLowerCase() || "working";
    const icon = statusIcon(phase);
    const label = statusLabel(phase);

    const body = trim(text, 120);
    const coloredBody = phase === "failed"
      ? theme.fg("error", body)
      : phase === "budget_exceeded"
        ? theme.fg("warning", body)
        : phase === "done" || phase === "complete"
          ? theme.fg("success", body)
          : theme.fg("muted", body);

    return new Text(`${icon} ${theme.fg("toolTitle", theme.bold(label))} ${coloredBody}`, 0, 0);
  });

  // ═══ Custom message renderer for colony reports ═══
  pi.registerMessageRenderer("ant-colony-report", (message, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const container = new Container();

    // 提取关键信息渲染
    const statusMatch = content.match(/\*\*Status:\*\* (.+)/);
    const durationMatch = content.match(/\*\*Duration:\*\* (.+)/);
    const ok = content.includes("✅ done");

    container.addChild(new Text(
      (ok ? theme.fg("success", "✓") : theme.fg("error", "✗")) + " " +
      theme.fg("toolTitle", theme.bold("🐜 Ant Colony Report")) +
      (durationMatch ? theme.fg("muted", ` │ ${durationMatch[1]}`) : ""),
      0, 0,
    ));

    // 渲染任务结果
    const taskLines = content.split("\n").filter(l => l.startsWith("- ✓") || l.startsWith("- ✗"));
    for (const l of taskLines.slice(0, 8)) {
      const icon = l.startsWith("- ✓") ? theme.fg("success", "✓") : theme.fg("error", "✗");
      container.addChild(new Text(`  ${icon} ${theme.fg("muted", l.slice(4).trim().slice(0, 70))}`, 0, 0));
    }
    if (taskLines.length > 8) {
      container.addChild(new Text(theme.fg("muted", `  ⋯ +${taskLines.length - 8} more`), 0, 0));
    }

    // Metrics 行
    const metricsLines = content.split("\n").filter(l => l.startsWith("- ") && !l.startsWith("- ✓") && !l.startsWith("- ✗") && !l.startsWith("- ["));
    if (metricsLines.length > 0) {
      container.addChild(new Text(theme.fg("muted", `  ${metricsLines.map(l => l.slice(2)).join(" │ ")}`), 0, 0));
    }

    return container;
  });

  // ═══ Shortcut: Ctrl+Shift+A 展开蚁群详情 ═══
  pi.registerShortcut("ctrl+shift+a", {
    description: "Show ant colony details",
    async handler(ctx) {
      if (!activeColony) {
        ctx.ui.notify("No colony is currently running.", "info");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;
        let currentTab: "tasks" | "streams" | "log" = "tasks";
        let taskFilter: "all" | "active" | "done" | "failed" = "all";

        const buildLines = (width: number): string[] => {
          const c = activeColony;
          if (!c) return [theme.fg("muted", "  No colony running.")];

          const lines: string[] = [];
          const w = width - 2; // padding

          // ── Header ──
          const elapsed = c.state ? formatDuration(Date.now() - c.state.createdAt) : "0s";
          const m = c.state?.metrics;
          const phase = c.state?.status || "scouting";
          const progress = calcProgress(m);
          const pct = Math.round(progress * 100);
          const cost = m ? formatCost(m.totalCost) : "$0";
          const activeAnts = c.antStreams.size;
          const barWidth = Math.max(10, Math.min(24, w - 28));

          lines.push(theme.fg("accent", theme.bold(`  🐜 Colony Details`)) + theme.fg("muted", ` │ ${elapsed} │ ${cost}`));
          lines.push(theme.fg("muted", `  Goal: ${trim(c.goal, w - 8)}`));
          lines.push(`  ${statusIcon(phase)} ${theme.bold(statusLabel(phase))} │ ${m ? `${m.tasksDone}/${m.tasksTotal}` : "0/0"} │ ${pct}% │ ⚡${activeAnts}`);
          lines.push(theme.fg("muted", `  ${progressBar(progress, barWidth)} ${pct}%`));
          if (c.phase && c.phase !== "initializing") {
            lines.push(theme.fg("muted", `  Phase: ${trim(c.phase, w - 10)}`));
          }
          lines.push("");

          // ── Tabs ──
          const tabs: Array<{ key: "tasks" | "streams" | "log"; hotkey: string; label: string }> = [
            { key: "tasks", hotkey: "1", label: "Tasks" },
            { key: "streams", hotkey: "2", label: "Streams" },
            { key: "log", hotkey: "3", label: "Log" },
          ];
          const tabLine = tabs.map((t) => {
            const label = `[${t.hotkey}] ${t.label}`;
            return currentTab === t.key ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label);
          }).join("  ");
          lines.push(`  ${tabLine}`);
          lines.push("");

          const tasks = c.state?.tasks || [];
          const streams = Array.from(c.antStreams.values());

          // ── Tab: Tasks ──
          if (currentTab === "tasks") {
            const counts = {
              done: tasks.filter(t => t.status === "done").length,
              active: tasks.filter(t => t.status === "active").length,
              failed: tasks.filter(t => t.status === "failed").length,
              pending: tasks.filter(t => t.status === "pending" || t.status === "claimed" || t.status === "blocked").length,
            };
            lines.push(theme.fg("accent", "  Tasks"));
            lines.push(theme.fg("muted", `  done:${counts.done} │ active:${counts.active} │ pending:${counts.pending} │ failed:${counts.failed}`));
            lines.push(theme.fg("muted", "  Filter: [0] all  [a] active  [d] done  [f] failed"));
            lines.push(theme.fg("muted", `  Current filter: ${taskFilter.toUpperCase()}`));
            lines.push("");

            const filtered = tasks.filter(t =>
              taskFilter === "all" ? true :
                taskFilter === "active" ? t.status === "active" :
                  taskFilter === "done" ? t.status === "done" :
                    t.status === "failed"
            );

            if (filtered.length === 0) {
              lines.push(theme.fg("muted", "  (no tasks match current filter)"));
            } else {
              for (const t of filtered.slice(0, 16)) {
                const icon = t.status === "done" ? theme.fg("success", "✓")
                  : t.status === "failed" ? theme.fg("error", "✗")
                  : t.status === "active" ? theme.fg("warning", "●")
                  : theme.fg("dim", "○");
                const dur = t.finishedAt && t.startedAt ? theme.fg("dim", ` ${formatDuration(t.finishedAt - t.startedAt)}`) : "";
                lines.push(`  ${icon} ${casteIcon(t.caste)} ${theme.fg("text", trim(t.title, w - 12))}${dur}`);
              }
              if (filtered.length > 16) lines.push(theme.fg("muted", `  ⋯ +${filtered.length - 16} more`));
            }
            lines.push("");
          }

          // ── Tab: Streams ──
          if (currentTab === "streams") {
            lines.push(theme.fg("accent", `  Active Ant Streams (${streams.length})`));
            lines.push(theme.fg("muted", "  Shows latest line + token count for active ants"));
            lines.push("");
            if (streams.length === 0) {
              lines.push(theme.fg("muted", "  (no active streams right now)"));
            } else {
              for (const s of streams.slice(0, 10)) {
                const excerpt = trim((s.lastLine || "...").replace(/\s+/g, " "), Math.max(20, w - 24));
                lines.push(`  ${casteIcon(s.caste)} ${theme.fg("muted", s.antId.slice(0, 12))} ${theme.fg("muted", `${formatTokens(s.tokens)}t`)} ${theme.fg("text", excerpt)}`);
              }
              if (streams.length > 10) lines.push(theme.fg("muted", `  ⋯ +${streams.length - 10} more streams`));
            }
            lines.push("");
          }

          // ── Tab: Log ──
          if (currentTab === "log") {
            const failedTasks = tasks.filter(t => t.status === "failed");
            if (failedTasks.length > 0) {
              lines.push(theme.fg("warning", `  Warnings (${failedTasks.length})`));
              for (const t of failedTasks.slice(0, 4)) {
                lines.push(`  ${theme.fg("error", "✗")} ${theme.fg("text", trim(t.title, w - 8))}`);
              }
              if (failedTasks.length > 4) lines.push(theme.fg("muted", `  ⋯ +${failedTasks.length - 4} more failed tasks`));
              lines.push("");
            }

            const recentLogs = c.logs.slice(-12);
            lines.push(theme.fg("accent", "  Recent Signals"));
            if (recentLogs.length === 0) {
              lines.push(theme.fg("muted", "  (no signal logs yet)"));
            } else {
              const now = Date.now();
              for (const log of recentLogs) {
                const age = formatDuration(Math.max(0, now - log.timestamp));
                const levelIcon = log.level === "error" ? theme.fg("error", "✗") : log.level === "warning" ? theme.fg("warning", "!") : theme.fg("muted", "•");
                lines.push(`  ${levelIcon} ${theme.fg("muted", age)} ${theme.fg("text", trim(log.text, w - 12))}`);
              }
            }
            lines.push("");
          }

          lines.push(theme.fg("muted", "  [1/2/3] switch tabs │ [0/a/d/f] task filter │ esc close"));
          return lines;
        };

        // 定时刷新
        let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
          cachedWidth = undefined;
          cachedLines = undefined;
          tui.requestRender();
        }, 1000);

        const cleanup = () => { if (timer) { clearInterval(timer); timer = null; } };

        return {
          render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            cachedLines = buildLines(width);
            cachedWidth = width;
            return cachedLines;
          },
          invalidate() { cachedWidth = undefined; cachedLines = undefined; cleanup(); },
          handleInput(data: string) {
            if (matchesKey(data, "escape")) {
              cleanup();
              done(undefined);
              return;
            }

            if (data === "1") currentTab = "tasks";
            else if (data === "2") currentTab = "streams";
            else if (data === "3") currentTab = "log";
            else if (data === "0") taskFilter = "all";
            else if (data.toLowerCase() === "a") taskFilter = "active";
            else if (data.toLowerCase() === "d") taskFilter = "done";
            else if (data.toLowerCase() === "f") taskFilter = "failed";
            else return;

            cachedWidth = undefined;
            cachedLines = undefined;
            tui.requestRender();
          },
        };
      }, { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } });
    },
  });

  // ═══ Tool: ant_colony ═══
  pi.registerTool({
    name: "ant_colony",
    label: "Ant Colony",
    description: [
      "Launch an autonomous ant colony in the BACKGROUND to accomplish a complex goal.",
      "The colony runs asynchronously — you can continue chatting while it works.",
      "Results are automatically injected when the colony finishes.",
      "Scouts explore the codebase, workers execute tasks in parallel, soldiers review quality.",
      "Use for multi-file changes, large refactors, or complex features.",
    ].join(" "),
    parameters: Type.Object({
      goal: Type.String({ description: "What the colony should accomplish" }),
      maxAnts: Type.Optional(Type.Number({ description: "Max concurrent ants (default: auto-adapt)", minimum: 1, maximum: 8 })),
      maxCost: Type.Optional(Type.Number({ description: "Max cost budget in USD (default: unlimited)", minimum: 0.01 })),
      scoutModel: Type.Optional(Type.String({ description: "Model for scout ants (default: current session model)" })),
      workerModel: Type.Optional(Type.String({ description: "Model for worker ants (default: current session model)" })),
      soldierModel: Type.Optional(Type.String({ description: "Model for soldier ants (default: current session model)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (activeColony) {
        return {
          content: [{ type: "text", text: "A colony is already running in the background. Use /colony-stop to cancel it first." }],
          isError: true,
        };
      }

      const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
      if (!currentModel) {
        return {
          content: [{ type: "text", text: "Colony failed: no model available in current session" }],
          isError: true,
        };
      }

      const modelOverrides: Record<string, string> = {};
      if (params.scoutModel) modelOverrides.scout = params.scoutModel;
      if (params.workerModel) modelOverrides.worker = params.workerModel;
      if (params.soldierModel) modelOverrides.soldier = params.soldierModel;

      const colonyParams = {
        goal: params.goal,
        maxAnts: params.maxAnts,
        maxCost: params.maxCost,
        currentModel,
        modelOverrides,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry ?? undefined,
      };

      // 非交互模式（print mode）：同步等待蚁群完成
      if (!ctx.hasUI) {
        return await runSyncColony(colonyParams, _signal);
      }

      // 交互模式：后台运行
      launchBackgroundColony(colonyParams);

      return {
        content: [{ type: "text", text: `[COLONY_SIGNAL:LAUNCHED]\n🐜 Colony launched in background.\nGoal: ${params.goal}\n\n🔔 IMPORTANT: Do NOT poll for status. The colony will send progress updates automatically via [COLONY_SIGNAL:*] messages. Do NOT use bg_colony_status, Start-Sleep loops, or file timestamp checks. Simply wait for the completion message.` }],
      };
    },

    renderCall(args, theme) {
      const goal = args.goal?.length > 70 ? args.goal.slice(0, 67) + "..." : args.goal;
      let text = theme.fg("toolTitle", theme.bold("🐜 ant_colony"));
      if (args.maxAnts) text += theme.fg("muted", ` ×${args.maxAnts}`);
      if (args.maxCost) text += theme.fg("warning", ` $${args.maxCost}`);
      text += "\n" + theme.fg("muted", `  ${goal || "..."}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const text = result.content?.find((c: any) => c.type === "text")?.text || "";
      if (result.isError) {
        return new Text(theme.fg("error", text), 0, 0);
      }
      const container = new Container();
      container.addChild(new Text(
        theme.fg("success", "✓ ") + theme.fg("toolTitle", theme.bold("Colony launched in background")),
        0, 0,
      ));
      if (activeColony) {
        container.addChild(new Text(theme.fg("muted", `  Goal: ${activeColony.goal.slice(0, 70)}`), 0, 0));
        container.addChild(new Text(theme.fg("muted", `  Ctrl+Shift+A for details │ /colony-stop to cancel`), 0, 0));
      }
      return container;
    },
  });

  // ═══ Helper: build status summary ═══

  function buildStatusText(): string {
    if (!activeColony) return "No colony is currently running.";
    const c = activeColony;
    const state = c.state;
    const elapsed = state ? formatDuration(Date.now() - state.createdAt) : "0s";
    const m = state?.metrics;
    const phase = state?.status || "scouting";
    const progress = calcProgress(m);
    const pct = Math.round(progress * 100);
    const activeAnts = c.antStreams.size;

    const lines: string[] = [
      `🐜 ${statusIcon(phase)} ${trim(c.goal, 80)}`,
      `${statusLabel(phase)} │ ${m ? `${m.tasksDone}/${m.tasksTotal} tasks` : "starting"} │ ${pct}% │ ⚡${activeAnts} │ ${m ? formatCost(m.totalCost) : "$0"} │ ${elapsed}`,
      `${progressBar(progress, 18)} ${pct}%`,
    ];

    if (c.phase && c.phase !== "initializing") lines.push(`Phase: ${trim(c.phase, 100)}`);
    const lastLog = c.logs[c.logs.length - 1];
    if (lastLog) lines.push(`Last: ${trim(lastLog.text, 100)}`);
    if (m && m.tasksFailed > 0) lines.push(`⚠ ${m.tasksFailed} failed`);

    return lines.join("\n");
  }

  // ═══ Tool: bg_colony_status ═══
  pi.registerTool({
    name: "bg_colony_status",
    label: "Colony Status",
    description: "Optional manual snapshot for a running colony. Progress is pushed passively via COLONY_SIGNAL follow-up messages; call this only when the user explicitly asks.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!activeColony) {
        return {
          content: [{ type: "text" as const, text: "No colony is currently running." }],
        };
      }

      const explicit = isExplicitStatusRequest(ctx);
      if (!explicit) {
        return {
          content: [{
            type: "text" as const,
            text: "⛔ STOP POLLING - This wastes resources. Colony progress is pushed automatically via [COLONY_SIGNAL:*] messages. Do NOT call bg_colony_status again. Just wait for completion message.",
          }],
          isError: true,
        };
      }

      const now = Date.now();
      const delta = now - lastBgStatusSnapshotAt;
      if (delta < STATUS_SNAPSHOT_COOLDOWN_MS) {
        const waitSec = Math.ceil((STATUS_SNAPSHOT_COOLDOWN_MS - delta) / 1000);
        return {
          content: [{
            type: "text" as const,
            text: `Manual status snapshot is rate-limited. Please wait ${waitSec}s to avoid active polling loops.`,
          }],
          isError: true,
        };
      }

      lastBgStatusSnapshotAt = now;
      return {
        content: [{ type: "text" as const, text: buildStatusText() }],
      };
    },
  });

  // ═══ Command: /colony-status ═══
  pi.registerCommand("colony-status", {
    description: "Show current colony progress",
    async handler(_args, ctx) {
      if (!activeColony) {
        ctx.ui.notify("No colony is currently running.", "info");
        return;
      }
      ctx.ui.notify(buildStatusText(), "info");
    },
  });

  // ═══ Command: /colony-stop ═══
  pi.registerCommand("colony-stop", {
    description: "Stop the running background colony",
    async handler(_args, ctx) {
      if (!activeColony) {
        ctx.ui.notify("No colony is currently running.", "info");
        return;
      }
      activeColony.abortController.abort();
      ctx.ui.notify("🐜 Colony abort signal sent. Waiting for ants to finish...", "warning");
    },
  });

  pi.registerCommand("colony-resume", {
    description: "Resume a colony from its last checkpoint",
    async handler(_args, ctx) {
      if (activeColony) {
        ctx.ui.notify("A colony is already running.", "warning");
        return;
      }
      const found = Nest.findResumable(ctx.cwd);
      if (!found) {
        ctx.ui.notify("No resumable colony found.", "info");
        return;
      }
      ctx.ui.notify(`🐜 Resuming colony: ${found.state.goal.slice(0, 60)}...`, "info");
      launchBackgroundColony({
        cwd: ctx.cwd,
        goal: found.state.goal,
        maxCost: found.state.maxCost ?? undefined,
        currentModel: ctx.currentModel,
        modelOverrides: {},
        modelRegistry: ctx.modelRegistry,
      }, true);
    },
  });

  // ═══ Cleanup on shutdown ═══
  pi.on("session_shutdown", async () => {
    if (activeColony) {
      activeColony.abortController.abort();
      // Wait for colony to finish gracefully (max 5s)
      try {
        await Promise.race([
          activeColony.promise,
          new Promise(r => setTimeout(r, 5000)),
        ]);
      } catch { /* ignore */ }
      pi.events.emit("ant-colony:clear-ui");
      activeColony = null;
    }
  });
}

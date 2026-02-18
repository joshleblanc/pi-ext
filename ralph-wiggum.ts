/**
 * Ralph Wiggum Extension for pi
 * 
 * Implements the Ralph Wiggum autonomous loop technique from Claude Code.
 * 
 * Usage:
 *   /ralph <task_description> [--max-iterations N] [--completion-promise TEXT]
 * 
 * Example:
 *   /ralph Build a hello world API. When complete output: DONE --max-iterations 10
 * 
 * The extension runs the agent in a loop, checking for the completion promise
 * on each iteration. If not found, it sends the same prompt back to continue working.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface RalphState {
  prompt: string;
  maxIterations: number;
  completionPromise: string;
  currentIteration: number;
  isRunning: boolean;
}

let ralphState: RalphState | null = null;

export default function (pi: ExtensionAPI) {
  // Register the /ralph command
  pi.registerCommand("ralph", {
    description: "Start a Ralph Wiggum autonomous loop",
    getArgumentCompletions: (prefix: string) => {
      if (prefix.startsWith("--")) {
        return [
          { value: "--max-iterations ", label: "--max-iterations (default: unlimited)" },
          { value: "--completion-promise ", label: "--completion-promise (default: DONE)" },
        ];
      }
      return null;
    },
    handler: async (args, ctx) => {
      // Parse arguments
      const maxIterationsMatch = args.match(/--max-iterations\s+(\d+)/);
      const completionMatch = args.match(/--completion-promise\s+(\S+)/);
      
      // Extract the prompt (everything before the flags)
      let prompt = args
        .replace(/--max-iterations\s+\d+/, "")
        .replace(/--completion-promise\s+\S+/, "")
        .trim();
      
      const maxIterations = maxIterationsMatch ? parseInt(maxIterationsMatch[1], 10) : Infinity;
      const completionPromise = completionMatch ? completionMatch[1] : "DONE";
      
      if (!prompt) {
        ctx.ui.notify("Usage: /ralph <task> [--max-iterations N] [--completion-promise TEXT]", "error");
        return;
      }
      
      // Start the Ralph loop
      ralphState = {
        prompt,
        maxIterations,
        completionPromise,
        currentIteration: 0,
        isRunning: true,
      };
      
      ctx.ui.notify(
        `🤡 Ralph Wiggum loop started!\n` +
        `Task: ${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}\n` +
        `Max iterations: ${maxIterations === Infinity ? "unlimited" : maxIterations}\n` +
        `Completion promise: ${completionPromise}`,
        "info"
      );
      
      // Send the initial prompt to start the loop
      await ctx.waitForIdle();
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    },
  });
  
  // Register /ralph-status command to check loop status
  pi.registerCommand("ralph-status", {
    description: "Show Ralph Wiggum loop status",
    handler: async (_args, ctx) => {
      if (!ralphState || !ralphState.isRunning) {
        ctx.ui.notify("No Ralph loop running", "info");
        return;
      }
      
      ctx.ui.notify(
        `🤡 Ralph Status:\n` +
        `Iteration: ${ralphState.currentIteration} / ${ralphState.maxIterations === Infinity ? "∞" : ralphState.maxIterations}\n` +
        `Prompt: ${ralphState.prompt.slice(0, 40)}...`,
        "info"
      );
    },
  });
  
  // Register /ralph-cancel command to stop the loop
  pi.registerCommand("ralph-cancel", {
    description: "Cancel the Ralph Wiggum loop",
    handler: async (_args, ctx) => {
      if (!ralphState) {
        ctx.ui.notify("No Ralph loop to cancel", "info");
        return;
      }
      
      ralphState.isRunning = false;
      ctx.ui.notify("🤡 Ralph loop cancelled", "info");
    },
  });
  
  // Register a tool that can be called by the agent to signal completion
  pi.registerTool({
    name: "ralph_complete",
    label: "Ralph Complete",
    description: "Signal that the current Ralph Wiggum task is complete. Call this when you've finished all requirements.",
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: "Brief summary of what was accomplished" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      // Mark as complete if Ralph is running
      if (ralphState && ralphState.isRunning) {
        ralphState.isRunning = false;
        ctx.ui.notify(
          `🤡 Ralph Wiggum complete!\n` +
          `Iterations: ${ralphState.currentIteration}\n` +
          `Summary: ${params.summary || "Task completed"}`,
          "success"
        );
      }
      
      return {
        content: [{ type: "text", text: `Ralph complete signal sent. Summary: ${params.summary || "N/A"}` }],
        details: { completed: true, summary: params.summary },
      };
    },
  });
  
  // Hook into agent_end to check if we should continue the loop
  pi.on("agent_end", async (event, ctx) => {
    if (!ralphState || !ralphState.isRunning) {
      return;
    }
    
    ralphState.currentIteration++;
    
    // Check if we've hit max iterations
    if (ralphState.currentIteration >= ralphState.maxIterations) {
      ralphState.isRunning = false;
      ctx.ui.notify(
        `🤡 Ralph Wiggum stopped!\n` +
        `Reached max iterations (${ralphState.maxIterations})`,
        "warning"
      );
      return;
    }
    
    // Get the last assistant message to check for completion promise
    const messages = event.messages;
    let lastAssistantText = "";
    
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.content) {
        for (const block of msg.content) {
          if (block.type === "text") {
            lastAssistantText += block.text + "\n";
          }
        }
        break;
      }
    }
    
    // Check for completion promise in the output
    if (lastAssistantText.includes(ralphState.completionPromise)) {
      ralphState.isRunning = false;
      ctx.ui.notify(
        `🤡 Ralph Wiggum complete!\n` +
        `Iterations: ${ralphState.currentIteration}\n` +
        `Completion promise "${ralphState.completionPromise}" detected!`,
        "success"
      );
      return;
    }
    
    // Continue the loop - send the same prompt back
    ctx.ui.notify(
      `🤡 Ralph iteration ${ralphState.currentIteration}/${ralphState.maxIterations === Infinity ? "∞" : ralphState.maxIterations} - continuing...`,
      "info"
    );
    
    // Add some context to encourage continuation
    const continuationPrompt = 
      `Continue working on the task. ` +
      `Previous work completed in iteration ${ralphState.currentIteration - 1}. ` +
      `When the task is fully complete, output: ${ralphState.completionPromise}\n\n` +
      `Original task: ${ralphState.prompt}`;
    
    pi.sendUserMessage(continuationPrompt, { deliverAs: "followUp" });
  });
  
  // Handle session start - reset Ralph state and notify user
  pi.on("session_start", async (_event, ctx) => {
    ralphState = null;
    ctx.ui.notify("🤡 Ralph Wiggum extension loaded!\nUse /ralph <task> to start a loop", "info");
  });
  
  // Handle session shutdown - clean up
  pi.on("session_shutdown", async () => {
    ralphState = null;
  });
}


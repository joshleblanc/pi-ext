/**
 * Enhanced Ralph Wiggum Extension for pi
 * 
 * Implements an advanced Ralph Wiggum autonomous loop technique that:
 * 1. Generates a Product Requirements Document (PRD) for the task
 * 2. Converts the PRD into a structured JSON with user stories
 * 3. Creates a new git branch for the feature
 * 4. Iterates through each user story until all are complete
 * 
 * Usage:
 *   /ralph-prd <task_description> [--branch-name NAME] [--max-iterations N]
 * 
 * Example:
 *   /ralph-prd Build a hello world API with authentication --branch-name feature/hello-api
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: "pending" | "in_progress" | "completed" | "blocked";
  notes?: string;
}

interface RalphPRDState {
  originalPrompt: string;
  prd: string;
  userStories: UserStory[];
  currentStoryIndex: number;
  branchName: string;
  maxIterations: number;
  currentIteration: number;
  isRunning: boolean;
  phase: "prd" | "json" | "branch" | "executing" | "complete";
}

// Generate a branch name from the task description
function generateBranchName(prompt: string): string {
  const words = prompt.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 4);
  
  const timestamp = Date.now().toString(36);
  return `feature/${words.join("-")}-${timestamp}`;
}

// PRD prompt template
const PRD_PROMPT_TEMPLATE = `You are a product manager creating a Product Requirements Document (PRD).

Create a comprehensive PRD for the following task:

{task}

Include:
1. **Project Overview** - Brief description of what we're building
2. **Goals & Objectives** - What success looks like
3. **User Stories** - At least 3-5 user stories in this format:
   - As a [user type], I want [goal] so that [benefit]
4. **Acceptance Criteria** - For each user story, list specific acceptance criteria
5. **Technical Considerations** - Any technical requirements or constraints
6. **Out of Scope** - What's NOT included

Output your response in a clear, structured format. This will be converted to JSON for task tracking.`;

// JSON conversion prompt
const JSON_CONVERSION_PROMPT = `Convert the PRD below into a structured JSON array of user stories.

For each user story, extract:
- id: A unique identifier (e.g., "US001")
- title: Short title of the story
- description: The "As a... I want... so that..." statement
- acceptanceCriteria: Array of specific acceptance criteria
- status: "pending"

Output ONLY valid JSON array, no markdown formatting, no explanation. Just the JSON.

PRD:
{prd}`;

// Branch creation prompt
const BRANCH_CREATION_PROMPT = `Create a new git branch for this feature. Use the branch name: {branchName}

First, check the current git status and branch. Then create and switch to the new branch.
Report back the branch name and confirm you're on it.`;

// User story execution prompt
const EXECUTION_PROMPT = `You're working on a Ralph Wiggum autonomous loop to complete the following task.

Current User Story ({storyId} of {totalStories}):
{currentStory}

All User Stories:
{allStories}

Progress: {completedCount}/{totalStories} completed

Instructions:
1. Work on the CURRENT user story only
2. Implement the code changes needed
3. Test your implementation
4. When the current story is complete, call the ralph_complete tool to mark it as done
5. The loop will automatically continue to the next story

Current story details:
{acceptanceCriteria}

When you've completed this user story, output: STORY_COMPLETE and then call ralph_complete with a summary.`;

let state: RalphPRDState | null = null;

export default function (pi: ExtensionAPI) {
  // Register the /ralph-prd command
  pi.registerCommand("ralph-prd", {
    description: "Start a Ralph Wiggum PRD loop (generates PRD, creates branch, iterates stories)",
    getArgumentCompletions: (prefix: string) => {
      if (prefix.startsWith("--")) {
        return [
          { value: "--branch-name ", label: "--branch-name (auto-generated if not specified)" },
          { value: "--max-iterations ", label: "--max-iterations (default: unlimited)" },
        ];
      }
      return null;
    },
    handler: async (args, ctx) => {
      // Parse arguments
      const branchMatch = args.match(/--branch-name\s+(\S+)/);
      const maxIterationsMatch = args.match(/--max-iterations\s+(\d+)/);
      
      // Extract the prompt (everything before the flags)
      let prompt = args
        .replace(/--branch-name\s+\S+/, "")
        .replace(/--max-iterations\s+\d+/, "")
        .trim();
      
      const maxIterations = maxIterationsMatch ? parseInt(maxIterationsMatch[1], 10) : Infinity;
      const branchName = branchMatch ? branchMatch[1] : generateBranchName(prompt);
      
      if (!prompt) {
        ctx.ui.notify("Usage: /ralph-prd <task> [--branch-name NAME] [--max-iterations N]", "error");
        return;
      }
      
      // Initialize state
      state = {
        originalPrompt: prompt,
        prd: "",
        userStories: [],
        currentStoryIndex: 0,
        branchName: branchName,
        maxIterations: maxIterations,
        currentIteration: 0,
        isRunning: true,
        phase: "prd",
      };
      
      ctx.ui.notify(
        `🤡 Ralph Wiggum PRD Loop Starting!\n\n` +
        `Task: ${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}\n` +
        `Branch: ${branchName}\n` +
        `Phase 1: Generating PRD...`,
        "info"
      );
      
      // Start Phase 1: Generate PRD
      const prdPrompt = PRD_PROMPT_TEMPLATE.replace("{task}", prompt);
      
      await ctx.waitForIdle();
      pi.sendUserMessage(prdPrompt, { deliverAs: "followUp" });
    },
  });
  
  // Register /ralph-prd-status command
  pi.registerCommand("ralph-prd-status", {
    description: "Show Ralph PRD loop status",
    handler: async (_args, ctx) => {
      if (!state) {
        ctx.ui.notify("No Ralph PRD loop running", "info");
        return;
      }
      
      const phaseEmoji = {
        prd: "📝",
        json: "🔄",
        branch: "🌿",
        executing: "⚙️",
        complete: "✅",
      }[state.phase];
      
      const completedStories = state.userStories.filter(s => s.status === "completed").length;
      
      ctx.ui.notify(
        `🤡 Ralph PRD Status:\n\n` +
        `Phase: ${phaseEmoji} ${state.phase.toUpperCase()}\n` +
        `Iteration: ${state.currentIteration}/${state.maxIterations === Infinity ? "∞" : state.maxIterations}\n` +
        `Branch: ${state.branchName}\n` +
        `Progress: ${completedStories}/${state.userStories.length} stories\n` +
        `Current Story: ${state.userStories[state.currentStoryIndex]?.title || "N/A"}`,
        "info"
      );
    },
  });
  
  // Register /ralph-prd-cancel command
  pi.registerCommand("ralph-prd-cancel", {
    description: "Cancel the Ralph PRD loop",
    handler: async (_args, ctx) => {
      if (!state) {
        ctx.ui.notify("No Ralph PRD loop to cancel", "info");
        return;
      }
      
      state.isRunning = false;
      ctx.ui.notify("🤡 Ralph PRD loop cancelled", "info");
    },
  });
  
  // Register tool to complete current story
  pi.registerTool({
    name: "ralph_complete_story",
    label: "Ralph Complete Story",
    description: "Mark the current user story as complete and move to the next one. Call this when you've finished the current user story.",
    parameters: Type.Object({
      storyId: Type.String({ description: "ID of the story being completed (e.g., US001)" }),
      summary: Type.Optional(Type.String({ description: "Brief summary of what was accomplished" })),
      nextSteps: Type.Optional(Type.String({ description: "Any notes for the next story" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state || !state.isRunning) {
        return {
          content: [{ type: "text", text: "No Ralph PRD loop running" }],
          details: { error: true },
        };
      }
      
      // Find and update the story
      const storyIndex = state.userStories.findIndex(s => s.id === params.storyId);
      if (storyIndex === -1) {
        return {
          content: [{ type: "text", text: `Story ${params.storyId} not found` }],
          details: { error: true },
        };
      }
      
      state.userStories[storyIndex].status = "completed";
      if (params.nextSteps) {
        state.userStories[storyIndex].notes = params.nextSteps;
      }
      
      // Move to next story or complete
      if (storyIndex < state.userStories.length - 1) {
        state.currentStoryIndex = storyIndex + 1;
        
        ctx.ui.notify(
          `🤡 Story ${params.storyId} completed!\n` +
          `Moving to: ${state.userStories[state.currentStoryIndex].id}`,
          "success"
        );
      } else {
        state.phase = "complete";
        state.isRunning = false;
        
        ctx.ui.notify(
          `🤡 All user stories completed!\n` +
          `Total iterations: ${state.currentIteration}\n` +
          `Branch: ${state.branchName}\n\n` +
          `Summary: ${params.summary || "All tasks completed"}`,
          "success"
        );
      }
      
      return {
        content: [{ 
          type: "text", 
          text: `Story ${params.storyId} marked complete. ${state.isRunning ? "Moving to next story..." : "All complete!"}` 
        }],
        details: { 
          completed: !state.isRunning, 
          nextStory: state.userStories[state.currentStoryIndex]?.id || null 
        },
      };
    },
  });
  
  // Hook into agent_end to manage the PRD loop
  pi.on("agent_end", async (event, ctx) => {
    if (!state || !state.isRunning) {
      return;
    }
    
    state.currentIteration++;
    
    // Get the last assistant message
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
    
    // Phase management
    switch (state.phase) {
      case "prd":
        // Store the PRD and move to JSON conversion
        state.prd = lastAssistantText;
        state.phase = "json";
        
        ctx.ui.notify(
          `🤡 PRD Generated!\n\n` +
          `Phase 2: Converting to JSON...`,
          "info"
        );
        
        const jsonPrompt = JSON_CONVERSION_PROMPT.replace("{prd}", state.prd);
        pi.sendUserMessage(jsonPrompt, { deliverAs: "followUp" });
        break;
        
      case "json":
        // Parse the JSON response
        try {
          // Try to extract JSON from the response
          const jsonMatch = lastAssistantText.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const stories = JSON.parse(jsonMatch[0]);
            state.userStories = stories.map((s: any, i: number) => ({
              id: s.id || `US${String(i + 1).padStart(3, "0")}`,
              title: s.title || "",
              description: s.description || "",
              acceptanceCriteria: s.acceptanceCriteria || [],
              status: "pending" as const,
            }));
            
            state.phase = "branch";
            
            ctx.ui.notify(
              `🤡 JSON Generated!\n\n` +
              `${state.userStories.length} user stories extracted.\n` +
              `Phase 3: Creating branch...`,
              "info"
            );
            
            const branchPrompt = BRANCH_CREATION_PROMPT.replace("{branchName}", state.branchName);
            pi.sendUserMessage(branchPrompt, { deliverAs: "followUp" });
          } else {
            ctx.ui.notify("Failed to extract JSON from response. Retrying...", "warning");
            const jsonPrompt = JSON_CONVERSION_PROMPT.replace("{prd}", state.prd);
            pi.sendUserMessage(jsonPrompt, { deliverAs: "followUp" });
          }
        } catch (e) {
          ctx.ui.notify(`JSON parse error: ${e}. Retrying...`, "error");
          const jsonPrompt = JSON_CONVERSION_PROMPT.replace("{prd}", state.prd);
          pi.sendUserMessage(jsonPrompt, { deliverAs: "followUp" });
        }
        break;
        
      case "branch":
        // Branch created, now start executing stories
        state.phase = "executing";
        
        ctx.ui.notify(
          `🤡 Branch Created: ${state.branchName}\n\n` +
          `Phase 4: Executing user stories...\n` +
          `Starting with: ${state.userStories[0].id} - ${state.userStories[0].title}`,
          "info"
        );
        
        sendNextStoryPrompt(pi, state);
        break;
        
      case "executing":
        // Check if current story is complete
        const completedMatch = lastAssistantText.match(/STORY_COMPLETE/i);
        
        if (completedMatch) {
          // Mark current story as complete
          const currentStory = state.userStories[state.currentStoryIndex];
          currentStory.status = "completed";
          
          if (state.currentStoryIndex < state.userStories.length - 1) {
            // Move to next story
            state.currentStoryIndex++;
            
            ctx.ui.notify(
              `🤡 Story ${currentStory.id} complete!\n` +
              `Next: ${state.userStories[state.currentStoryIndex].id}`,
              "success"
            );
            
            sendNextStoryPrompt(pi, state);
          } else {
            // All done!
            state.phase = "complete";
            state.isRunning = false;
            
            ctx.ui.notify(
              `🤡🎉 All User Stories Complete!\n\n` +
              `Total iterations: ${state.currentIteration}\n` +
              `Branch: ${state.branchName}\n` +
              `Stories: ${state.userStories.length}`,
              "success"
            );
          }
        } else {
          // Continue current story
          if (state.currentIteration >= state.maxIterations) {
            state.isRunning = false;
            ctx.ui.notify(
              `🤡 Max iterations reached!\n` +
              `Completed: ${state.currentStoryIndex + 1}/${state.userStories.length}`,
              "warning"
            );
            return;
          }
          
          ctx.ui.notify(
            `🤡 Continuing story ${state.userStories[state.currentStoryIndex].id}...`,
            "info"
          );
          
          sendContinuationPrompt(pi, state);
        }
        break;
        
      case "complete":
        // Nothing to do
        break;
    }
  });
  
  // Handle session events
  pi.on("session_start", async (_event, ctx) => {
    state = null;
    ctx.ui.notify("🤡 Ralph Wiggum PRD Extension loaded!\nUse /ralph-prd <task> to start", "info");
  });
  
  pi.on("session_shutdown", async () => {
    state = null;
  });
}

// Helper function to send the next story prompt
function sendNextStoryPrompt(pi: ExtensionAPI, state: RalphPRDState) {
  const currentStory = state.userStories[state.currentStoryIndex];
  const allStoriesList = state.userStories
    .map((s, i) => `${s.id}: ${s.title} [${s.status}]`)
    .join("\n");
  
  const acceptanceCriteria = currentStory.acceptanceCriteria
    .map((ac, i) => `${i + 1}. ${ac}`)
    .join("\n");
  
  const prompt = EXECUTION_PROMPT
    .replace("{storyId}", currentStory.id)
    .replace("{totalStories}", String(state.userStories.length))
    .replace("{currentStory}", currentStory.title)
    .replace("{allStories}", allStoriesList)
    .replace("{completedCount}", String(state.userStories.filter(s => s.status === "completed").length))
    .replace("{acceptanceCriteria}", acceptanceCriteria || "No specific acceptance criteria defined.");
  
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

// Helper function to send continuation prompt
function sendContinuationPrompt(pi: ExtensionAPI, state: RalphPRDState) {
  const currentStory = state.userStories[state.currentStoryIndex];
  
  const prompt = 
    `Continue working on the current user story.\n\n` +
    `Current Story: ${currentStory.id} - ${currentStory.title}\n` +
    `Description: ${currentStory.description}\n\n` +
    `Acceptance Criteria:\n${currentStory.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}\n\n` +
    `When complete, output: STORY_COMPLETE\n` +
    `Then call ralph_complete_story with the story ID and summary.`;
  
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

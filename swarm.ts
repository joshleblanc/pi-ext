/**
 * Swarm Extension for pi
 * 
 * Implements a multi-agent swarm pattern similar to Kimi K2.5 Agent Swarm.
 * The orchestrator breaks complex tasks into subtasks and coordinates specialized agents.
 * 
 * Usage:
 *   /swarm <complex_task> [--agents N] [--parallel]
 * 
 * Example:
 *   /swarm Build a full-stack app with auth, API, and frontend --agents 3
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface SwarmConfig {
  task: string;
  numAgents: number;
  parallel: boolean;
  agents: SwarmAgent[];
  isRunning: boolean;
  currentPhase: "planning" | "executing" | "completed";
}

interface SwarmAgent {
  name: string;
  role: string;
  subtask: string;
  status: "pending" | "working" | "completed" | "failed";
  result?: string;
}

let swarmConfig: SwarmConfig | null = null;

const AGENT_ROLES = [
  { name: "Researcher", role: "Research and gather information, requirements, and best practices" },
  { name: "Architect", role: "Design system architecture, data models, and API structure" },
  { name: "Builder", role: "Implement code, files, and technical solutions" },
  { name: "Tester", role: "Write tests, verify functionality, and check for bugs" },
  { name: "Documenter", role: "Create documentation, README, and code comments" },
  { name: "Reviewer", role: "Review code quality, security, and best practices" },
  { name: "Refiner", role: "Refactor, optimize, and polish the implementation" },
  { name: "Integrator", role: "Connect components and ensure everything works together" },
];

export default function (pi: ExtensionAPI) {
  // Register the /swarm command
  pi.registerCommand("swarm", {
    description: "Start a swarm of specialized agents to tackle a complex task",
    getArgumentCompletions: (prefix: string) => {
      if (prefix.startsWith("--")) {
        return [
          { value: "--agents ", label: "--agents N (number of agents, 2-8)" },
          { value: "--parallel", label: "--parallel (run agents simultaneously)" },
        ];
      }
      return null;
    },
    handler: async (args, ctx) => {
      // Parse arguments
      const agentsMatch = args.match(/--agents\s+(\d+)/);
      const parallelMatch = args.match(/--parallel/);
      
      // Extract the task
      let task = args
        .replace(/--agents\s+\d+/, "")
        .replace(/--parallel/, "")
        .trim();
      
      const numAgents = agentsMatch 
        ? Math.min(Math.max(parseInt(agentsMatch[1], 10), 2), 8) 
        : 4;
      const parallel = parallelMatch !== null;
      
      if (!task) {
        ctx.ui.notify(
          "Usage: /swarm <task> [--agents N] [--parallel]\n" +
          "Example: /swarm Build a full-stack app --agents 4 --parallel",
          "error"
        );
        return;
      }
      
      // Initialize swarm config
      const selectedRoles = AGENT_ROLES.slice(0, numAgents);
      swarmConfig = {
        task,
        numAgents,
        parallel,
        agents: selectedRoles.map(r => ({
          name: r.name,
          role: r.role,
          subtask: "",
          status: "pending",
        })),
        isRunning: true,
        currentPhase: "planning",
      };
      
      ctx.ui.notify(
        `🐝 Swarm started with ${numAgents} agents!\n` +
        `Task: ${task.slice(60)}${task.length > 60 ? "..." : ""}\n` +
        `Mode: ${parallel ? "parallel" : "sequential"}\n` +
        `Agents: ${selectedRoles.map(a => a.name).join(", ")}`,
        "info"
      );
      
      // Start the swarm orchestration
      await ctx.waitForIdle();
      
      const toolsDescription = `

=== SWARM TOOLS - YOU MUST USE THESE ===
Available custom tools:
1. swarm_spawn_agent(agentRole: "${selectedRoles.map(r => r.name).join('" | "')}", subtask: string, context?: string)
   - Spawns an agent to work on a subtask. AgentRole must be one of the available roles.
2. swarm_agent_report(agentName: string, subtask: string, status: "completed" | "working" | "blocked" | "failed", result?: string)
   - Reports the status of an agent's work
3. swarm_get_status()
   - Gets status of all agents (no parameters)

CRITICAL: You MUST use these tools. Do not write code or text responses. Only use the tools above.
=== END SWARM TOOLS ===
`;
      
      const systemPrompt = buildSwarmSystemPrompt(swarmConfig);
      
      // Send a direct prompt that emphasizes tool usage
      const orchestratorPrompt = `TASK: "${task}"

${toolsDescription}

Delegate all work to agents using swarm_spawn_agent. Start now with:
swarm_spawn_agent(agentRole: "${selectedRoles[0].name}", subtask: "Research best practices for book tracking websites", context: "Focus on UI/UX patterns and data models")

${systemPrompt}`;
      
      pi.sendUserMessage(orchestratorPrompt, { deliverAs: "steer" });
    },
  });
  
  // Register /swarm-status command
  pi.registerCommand("swarm-status", {
    description: "Show swarm status and progress",
    handler: async (_args, ctx) => {
      if (!swarmConfig || !swarmConfig.isRunning) {
        ctx.ui.notify("No swarm running", "info");
        return;
      }
      
      const status = swarmConfig.agents
        .map(a => `${a.name}: ${a.status}`)
        .join("\n");
      
      ctx.ui.notify(
        `🐝 Swarm Status: ${swarmConfig.currentPhase}\n` +
        `Task: ${swarmConfig.task.slice(50)}${swarmConfig.task.length > 50 ? "..." : ""}\n\n` +
        status,
        "info"
      );
    },
  });
  
  // Register /swarm-cancel command
  pi.registerCommand("swarm-cancel", {
    description: "Cancel the running swarm",
    handler: async (_args, ctx) => {
      if (!swarmConfig) {
        ctx.ui.notify("No swarm to cancel", "info");
        return;
      }
      
      swarmConfig.isRunning = false;
      ctx.ui.notify("🐝 Swarm cancelled", "info");
    },
  });
  
  // Register a tool for agents to report subtask completion
  pi.registerTool({
    name: "swarm_agent_report",
    label: "Swarm Agent Report",
    description: "Report the status and results of a subtask. Use this to coordinate with other agents in the swarm.",
    parameters: Type.Object({
      agentName: Type.String({ description: "Name of your agent (e.g., Builder, Tester)" }),
      subtask: Type.String({ description: "What subtask you worked on" }),
      status: Type.Union([
        Type.Literal("completed"),
        Type.Literal("working"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ], { description: "Current status of your work" }),
      result: Type.Optional(Type.String({ description: "Summary of what was accomplished" })),
      needsHelp: Type.Optional(Type.String({ description: "What help you need from other agents" })),
      nextSteps: Type.Optional(Type.String({ description: "What should happen next" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (swarmConfig && swarmConfig.isRunning) {
        const agent = swarmConfig.agents.find(a => 
          a.name.toLowerCase() === params.agentName.toLowerCase()
        );
        
        if (agent) {
          agent.subtask = params.subtask;
          agent.status = params.status;
          agent.result = params.result;
          
          ctx.ui.notify(
            `🐝 ${params.agentName} (${params.status}): ${params.subtask.slice(40)}`,
            params.status === "completed" ? "success" : 
            params.status === "failed" ? "error" : "info"
          );
        }
      }
      
      return {
        content: [{ type: "text", text: `Report acknowledged for ${params.agentName}: ${params.status}` }],
        details: { ...params },
      };
    },
  });
  
  // Tool for orchestrator to spawn subtasks
  pi.registerTool({
    name: "swarm_spawn_agent",
    label: "Swarm Spawn Agent",
    description: "Spawn a specialized sub-agent to work on a specific subtask. Use this to parallelize work.",
    parameters: Type.Object({
      agentRole: Type.Enum({ type: "enum", enum: AGENT_ROLES.map(r => r.name) }),
      subtask: Type.String({ description: "The specific task for this agent to work on" }),
      context: Type.Optional(Type.String({ description: "Additional context for the agent" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const role = AGENT_ROLES.find(r => r.name === params.agentRole);
      
      if (!role) {
        return {
          content: [{ type: "text", text: `Unknown agent role: ${params.agentRole}` }],
          isError: true,
        };
      }
      
      if (swarmConfig && swarmConfig.isRunning) {
        const agent = swarmConfig.agents.find(a => a.name === params.agentRole);
        if (agent) {
          agent.subtask = params.subtask;
          agent.status = "working";
        }
      }
      
      ctx.ui.notify(
        `🐝 Spawned ${params.agentRole} agent\n` +
        `Task: ${params.subtask.slice(50)}${params.subtask.length > 50 ? "..." : ""}`,
        "info"
      );
      
      return {
        content: [{ 
          type: "text", 
          text: `Agent ${params.agentRole} spawned for: ${params.subtask}\n\n` +
                `Role: ${role.role}\n\n` +
                `Context: ${params.context || "None provided"}\n\n` +
                `Work on this subtask now and report back via swarm_agent_report when done.`
        }],
        details: { 
          agentRole: params.agentRole, 
          subtask: params.subtask,
          role: role.role,
        },
      };
    },
  });
  
  // Tool to check swarm status from within
  pi.registerTool({
    name: "swarm_get_status",
    label: "Swarm Get Status",
    description: "Get the current status of all agents in the swarm.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!swarmConfig) {
        return {
          content: [{ type: "text", text: "No swarm is currently running" }],
        };
      }
      
      const status = swarmConfig.agents.map(a => 
        `- ${a.name}: ${a.status}${a.subtask ? ` (${a.subtask})` : ""}`
      ).join("\n");
      
      return {
        content: [{
          type: "text",
          text: `Swarm Status: ${swarmConfig.currentPhase}\n\n${status}`
        }],
        details: {
          task: swarmConfig.task,
          phase: swarmConfig.currentPhase,
          agents: swarmConfig.agents,
        },
      };
    },
  });
  
  // Register /swarm-done command to signal completion
  pi.registerCommand("swarm-done", {
    description: "Signal that the swarm task is complete",
    handler: async (_args, ctx) => {
      if (!swarmConfig || !swarmConfig.isRunning) {
        ctx.ui.notify("No swarm running", "info");
        return;
      }
      
      swarmConfig.isRunning = false;
      swarmConfig.currentPhase = "completed";
      
      const completed = swarmConfig.agents.filter(a => a.status === "completed").length;
      const failed = swarmConfig.agents.filter(a => a.status === "failed").length;
      
      ctx.ui.notify(
        `🐝 Swarm complete!\n` +
        `Completed: ${completed}/${swarmConfig.numAgents}\n` +
        `Failed: ${failed}`,
        "success"
      );
    },
  });
  
  // Handle session events
  pi.on("session_start", async (_event, ctx) => {
    swarmConfig = null;
    ctx.ui.notify(
      "🐝 Swarm extension loaded!\n" +
      "Use /swarm <task> to start a multi-agent swarm",
      "info"
    );
  });
  
  pi.on("session_shutdown", async () => {
    swarmConfig = null;
  });
}

function buildSwarmSystemPrompt(config: SwarmConfig): string {
  return `
## Swarm Orchestration Guidelines

You are coordinating a swarm of ${config.numAgents} specialized agents. Here's how to work effectively:

### Phase 1: Planning
1. Analyze the task and break it into ${config.numAgents} distinct subtasks
2. Assign each subtask to the most appropriate agent role
3. Consider dependencies - some tasks must complete before others can start

### Phase 2: Execution
- Use \`swarm_spawn_agent\` to assign work to specific agents
- Use \`swarm_agent_report\` to track progress
- Use \`swarm_get_status\` to check all agent statuses
- Coordinate between agents as needed

### Agent Roles:
${AGENT_ROLES.slice(0, config.numAgents).map(r => `- ${r.name}: ${r.role}`).join("\n")}

### Communication Pattern:
1. Assign work: "Builder, please implement the API endpoints"
2. Check status: Use swarm_get_status to see progress
3. Coordinate: Pass results between agents as needed

### Completion:
When all agents report completed, summarize the results and output: SWARM_COMPLETE

Remember: You are the orchestrator. Delegate effectively, track progress, and ensure all pieces come together!
`;
}

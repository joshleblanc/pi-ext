/**
 * PowerShell Extension
 *
 * Provides a PowerShell tool that works like bash but executes commands via PowerShell.
 * On Windows, this can optionally replace the built-in bash tool.
 *
 * Features:
 * - Uses PowerShell (pwsh) or Windows PowerShell (powershell) depending on availability
 * - Properly handles Windows paths
 * - Supports all bash tool parameters (command, timeout)
 *
 * Usage:
 *   pi -e ./powershell.ts                    # Add powershell tool alongside bash
 *   pi -e ./powershell.ts --replace-bash    # Replace bash with powershell on Windows
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const isWindows = process.platform === "win32";

/**
 * Try to execute a command, with fallback to alternative shell
 */
async function tryExecWithFallback(
	command: string,
	cwd: string,
	options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
	primary: { command: string; args: string[] },
	fallback: { command: string; args: string[] },
): Promise<{ exitCode: number }> {
	// Try primary first
	try {
		return await execShell(command, cwd, options, primary.command, primary.args);
	} catch (error: any) {
		// If command not found, try fallback
		if (error.message?.includes("ENOENT") || error.message?.includes("spawn")) {
			return await execShell(command, cwd, options, fallback.command, fallback.args);
		}
		throw error;
	}
}

/**
 * Execute a command via shell
 */
function execShell(
	command: string,
	cwd: string,
	options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
	shellCommand: string,
	shellArgs: string[],
): Promise<{ exitCode: number }> {
	return new Promise((resolve, reject) => {
		const psArgs = [
			...shellArgs,
			"-Command",
			command,
		];

		const child = spawn(shellCommand, psArgs, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PSModulePath: process.env.PSModulePath },
			shell: false,
		});

		let timedOut = false;
		const timer = options.timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, options.timeout * 1000)
			: undefined;

		child.stdout.on("data", options.onData);
		child.stderr.on("data", (data) => {
			// PowerShell sends errors to stderr, but we treat them as output
			// unless they're truly fatal
			options.onData(data);
		});

		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});

		const onAbort = () => child.kill("SIGKILL");
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);

			if (options.signal?.aborted) {
				reject(new Error("aborted"));
			} else if (timedOut) {
				reject(new Error(`timeout:${options.timeout}`));
			} else {
				resolve({ exitCode: code ?? 0 });
			}
		});
	});
}

export default function (pi: ExtensionAPI) {
	// Register a flag to optionally replace bash with powershell on Windows
	pi.registerFlag("replace-bash", {
		description: "Replace the bash tool with PowerShell on Windows",
		type: "boolean",
		default: false,
	});

	// Check if we should replace bash
	const shouldReplaceBash = isWindows; // && (pi.getFlag("--replace-bash") as boolean);

	// Tool name - either "powershell" or "bash" depending on flag
	const toolName = shouldReplaceBash ? "bash" : "powershell";
	const toolLabel = shouldReplaceBash ? "bash (PowerShell)" : "powershell";
	const toolDescription = shouldReplaceBash
		? "Execute a command via PowerShell (replaces bash on Windows). This is the default shell on Windows."
		: "Execute a command via PowerShell. Use this instead of bash on Windows systems.";

	pi.registerTool({
		name: toolName,
		label: toolLabel,
		description: toolDescription,
		parameters: Type.Object({
			command: Type.String({ description: "PowerShell command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (default: 120)" }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { command, timeout } = params;
			const cwd = ctx.cwd;

			let output = "";
			const onData = (data: Buffer) => {
				const text = data.toString("utf-8");
				output += text;
				// Stream output to the LLM
				onUpdate?.({
					content: [{ type: "text", text }],
				});
			};

			// Try pwsh first, fall back to powershell.exe on Windows
			const primary = { command: "pwsh", args: ["-NoProfile", "-NonInteractive"] };
			const fallback = isWindows
				? { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive"] }
				: { command: "pwsh", args: ["-NoProfile", "-NonInteractive"] };

			try {
				const result = await tryExecWithFallback(command, cwd, {
					onData,
					signal: signal ?? undefined,
					timeout: timeout ?? 120,
				}, primary, fallback);

				// Truncate output if too large (50KB limit)
				const maxBytes = 50 * 1024;
				if (output.length > maxBytes) {
					output = output.slice(0, maxBytes) + "\n\n[Output truncated at 50KB]";
				}

				return {
					content: [{ type: "text", text: output }],
					details: {
						executed: command,
						exitCode: result.exitCode,
						cwd,
					},
				};
			} catch (error: any) {
				const isTimeout = error.message?.startsWith("timeout:");
				const isAborted = error.message === "aborted";

				return {
					content: [
						{
							type: "text",
							text: isTimeout
								? `Command timed out after ${timeout} seconds`
								: isAborted
									? "Command was cancelled"
									: `Error executing PowerShell command: ${error.message}`,
						},
					],
					details: {
						executed: command,
						error: true,
						timeout: isTimeout,
						cancelled: isAborted,
						cwd,
					},
				};
			}
		},
	});

	// Notify user about the tool on session start
	pi.on("session_start", async (_event, ctx) => {
		if (shouldReplaceBash) {
			ctx.ui.notify(
				"PowerShell extension: bash tool replaced with PowerShell",
				"info",
			);
		} else {
			ctx.ui.notify(
				"PowerShell extension: Use the 'powershell' tool to run PowerShell commands",
				"info",
			);
		}
	});
}

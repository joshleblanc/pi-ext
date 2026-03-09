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
 * - Output truncated to 2000 lines or 50KB (whichever is hit first)
 * - Auto-backgrounds long-running commands (>10s) with bg_status tool
 *
 * Usage:
 *   pi -e ./powershell.ts                    # Add powershell tool alongside bash
 *   pi -e ./powershell.ts --replace-bash    # Replace bash with powershell on Windows
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "@mariozechner/pi-coding-agent";

const isWindows = process.platform === "win32";

/** Timeout threshold (ms) - commands longer than this are auto-backgrounded */
const BG_TIMEOUT_MS = 10_000;

interface BgProcess {
	pid: number;
	command: string;
	logFile: string;
	startedAt: number;
	finished: boolean;
	exitCode: number | null;
}

/**
 * Generate a unique temp file path for powershell output
 */
function getTempFilePath() {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-powershell-${id}.log`);
}

export default function (pi: ExtensionAPI) {
	// Only load on Windows to avoid conflicts with bg-process extension on other platforms
	if (process.platform !== "win32") {
		return;
	}

	// Track background processes
	const bgProcesses = new Map<number, BgProcess>();

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
	const toolLabel = shouldReplaceBash ? "PowerShell" : "powershell";
	const toolDescription = `Execute a powershell command. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. If a command runs longer than ${BG_TIMEOUT_MS / 1000}s, it is automatically backgrounded and you get the PID + log file path. Use the bg_status tool to check on backgrounded processes.`;

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

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { command, timeout } = params;
			const cwd = ctx.cwd;

			// Determine effective timeout - use BG_TIMEOUT_MS for auto-background trigger,
			// but allow user-specified timeout to override for explicit timeout behavior
			const userTimeout = timeout ? timeout * 1000 : undefined;
			const effectiveTimeout = userTimeout ?? BG_TIMEOUT_MS;

			// Rolling buffer for output
			const chunks: Buffer[] = [];
			let chunksBytes = 0;
			const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

			let settled = false;
			let backgrounded = false;
			let tempFilePath: string | undefined;
			let tempFileStream: ReturnType<typeof createWriteStream> | undefined;

			// Determine PowerShell executable
			const psCommand = isWindows ? "powershell.exe" : "pwsh";
			const psArgs = ["-NoProfile", "-NonInteractive"];

			return new Promise((resolve) => {
				const child = spawn(psCommand, [...psArgs, "-Command", command], {
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, PSModulePath: process.env.PSModulePath },
					shell: false,
				});

				const handleData = (data: Buffer) => {
					chunks.push(data);
					chunksBytes += data.length;

					// Start writing to temp file if output exceeds threshold
					if (chunksBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
						tempFilePath = getTempFilePath();
						tempFileStream = createWriteStream(tempFilePath);
						// Write buffered chunks to file
						for (const chunk of chunks) {
							tempFileStream.write(chunk);
						}
					}

					// Continue writing to temp file
					if (tempFileStream) {
						tempFileStream.write(data);
					}

					// Trim old chunks if buffer too large
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift();
						chunksBytes -= removed!.length;
					}

					// If backgrounded, also append to bg log file
					if (backgrounded) {
						const bgProc = bgProcesses.get(child.pid!);
						if (bgProc?.logFile) {
							try { appendFileSync(bgProc.logFile, data.toString()); } catch {}
						}
					}
				};

				child.stdout?.on("data", handleData);
				child.stderr?.on("data", handleData);

				// Timeout handler - move to background
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					backgrounded = true;

					// Unreference the child so it runs in background
					child.unref();

					// Create log file path
					const logFile = `/tmp/oh-pi-bg-${Date.now()}.log`;
					const pid = child.pid!;

					// Write existing output to log
					const fullBuffer = Buffer.concat(chunks);
					writeFileSync(logFile, fullBuffer.toString("utf-8"));

					// Track the background process
					const proc: BgProcess = {
						pid,
						command,
						logFile,
						startedAt: Date.now(),
						finished: false,
						exitCode: null,
					};
					bgProcesses.set(pid, proc);

					// Listen for completion - notify LLM when done
					child.on("close", (code) => {
						proc.finished = true;
						proc.exitCode = code;

						// Read final output
						const finalBuffer = Buffer.concat(chunks);
						const finalOutput = finalBuffer.toString("utf-8");
						const tail = finalOutput.slice(-3000);
						const truncated =
							finalOutput.length > 3000
								? "[...truncated]\n" + tail
								: tail;

						// Write final output to log
						try {
							writeFileSync(logFile, finalOutput);
						} catch {}

						// Send message to LLM
						pi.sendMessage({
							content: `[BG_PROCESS_DONE] PID ${pid} finished (exit ${code ?? "?"})\nCommand: ${command}\n\nOutput (last 3000 chars):\n${truncated}`,
							display: true,
							triggerTurn: true,
							deliverAs: "followUp",
						});
					});

					// Build response for immediate return
					const preview = fullBuffer.toString("utf-8").slice(0, 500);
					const text = `Command still running after ${effectiveTimeout / 1000}s, moved to background.\nPID: ${pid}\nLog: ${logFile}\nStop: kill ${pid}\n\nOutput so far:\n${preview}\n\n⏳ You will be notified automatically when it finishes. No need to poll.`;

					resolve({
						content: [{ type: "text", text }],
						details: {},
					});
				}, effectiveTimeout);

				// Normal completion (before timeout)
				child.on("close", (code) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);

					// Close temp file stream
					if (tempFileStream) {
						tempFileStream.end();
					}

					const fullBuffer = Buffer.concat(chunks);
					const fullOutput = fullBuffer.toString("utf-8");

					// Apply tail truncation
					const truncation = truncateTail(fullOutput);
					let outputText = truncation.content || "(no output)";

					// Build details
					let details: Record<string, unknown>;
					if (truncation.truncated) {
						details = {
							truncation,
							fullOutputPath: tempFilePath,
						};

						const startLine =
							truncation.totalLines - truncation.outputLines + 1;
						const endLine = truncation.totalLines;
						if (truncation.lastLinePartial) {
							const lastLineSize = formatSize(
								Buffer.byteLength(
									fullOutput.split("\n").pop() || "",
									"utf-8",
								),
							);
							outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
						} else if (truncation.truncatedBy === "lines") {
							outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
						} else {
							outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
						}
					} else {
						details = {
							executed: command,
							exitCode: code,
							cwd,
						};
					}

					if (code !== 0) {
						outputText += `\n\nCommand exited with code ${code}`;
					}

					resolve({
						content: [{ type: "text", text: outputText }],
						details,
					});
				});

				child.on("error", (err) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);

					resolve({
						content: [{ type: "text", text: `Error: ${err.message}` }],
						details: {},
						isError: true,
					});
				});

				// Handle abort signal
				if (signal) {
					signal.addEventListener(
						"abort",
						() => {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							try {
								child.kill();
							} catch {}
							resolve({
								content: [{ type: "text", text: "Command cancelled." }],
								details: {},
							});
						},
						{ once: true },
					);
				}
			});
		},
	});

	// bg_status tool - view/manage background processes
	pi.registerTool({
		name: "bg_status",
		label: "Background Process Status",
		description:
			"Check status, view output, or stop background processes that were auto-backgrounded.",
		parameters: Type.Object({
			action: StringEnum(
				["list", "log", "stop"] as const,
				{
					description:
						"list=show all, log=view output, stop=kill process",
				},
			),
			pid: Type.Optional(
				Type.Number({ description: "PID of the process (required for log/stop)" }),
			),
		}),
		async execute(_toolCallId, params) {
			const { action, pid } = params;

			if (action === "list") {
				if (bgProcesses.size === 0) {
					return {
						content: [{ type: "text", text: "No background processes." }],
						details: {},
					};
				}
				const lines = [...bgProcesses.values()].map((p) => {
					const status = p.finished
						? `⚪ stopped (exit ${p.exitCode ?? "?"})`
						: isProcessAlive(p.pid)
							? "🟢 running"
							: "⚪ stopped";
					return `PID: ${p.pid} | ${status} | Log: ${p.logFile}\n  Cmd: ${p.command}`;
				});
				return { content: [{ type: "text", text: lines.join("\n\n") }], details: {} };
			}

			if (!pid) {
				return {
					content: [
						{
							type: "text",
							text: "Error: pid is required for log/stop",
						},
					],
					details: {},
					isError: true,
				};
			}

			const proc = bgProcesses.get(pid);

			if (action === "log") {
				const logFile = proc?.logFile;
				if (logFile && existsSync(logFile)) {
					try {
						const content = readFileSync(logFile, "utf-8");
						const tail = content.slice(-5000);
						const truncated =
							content.length > 5000
								? `[...truncated, showing last 5000 chars]\n${tail}`
								: tail;
						return {
							content: [{ type: "text", text: truncated || "(empty)" }],
							details: {},
						};
					} catch (e: any) {
						return {
							content: [
								{
									type: "text",
									text: `Error reading log: ${e.message}`,
								},
							],
							details: {},
							isError: true,
						};
					}
				}
				return {
					content: [
						{ type: "text", text: "No log available for this PID." },
					],
					details: {},
				};
			}

			if (action === "stop") {
				try {
					process.kill(pid, "SIGTERM");
					bgProcesses.delete(pid);
					return {
						content: [
							{ type: "text", text: `Process ${pid} terminated.` },
						],
						details: {},
					};
				} catch {
					bgProcesses.delete(pid);
					return {
						content: [
							{
								type: "text",
								text: `Process ${pid} not found (already stopped?).`,
							},
						],
						details: {},
					};
				}
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: {},
				isError: true,
			};
		},
	});

	// Cleanup: kill all background processes on session shutdown
	pi.on("session_shutdown", async () => {
		for (const [pid, proc] of bgProcesses) {
			if (!proc.finished) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {}
			}
		}
		bgProcesses.clear();
	});

	// Notify user about the tool on session start
	pi.on("session_start", async (_event, ctx) => {
		if (shouldReplaceBash) {
			ctx.ui.notify(
				"PowerShell extension: bash tool replaced with PowerShell (with auto-background)",
				"info",
			);
		} else {
			ctx.ui.notify(
				"PowerShell extension: Use 'powershell' tool for PowerShell (auto-backgrounds >10s commands)",
				"info",
			);
		}
	});
}

/**
 * Check if a process is still alive
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

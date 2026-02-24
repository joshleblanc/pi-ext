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
 *
 * Usage:
 *   pi -e ./powershell.ts                    # Add powershell tool alongside bash
 *   pi -e ./powershell.ts --replace-bash    # Replace bash with powershell on Windows
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "@mariozechner/pi-coding-agent";

const isWindows = process.platform === "win32";

/**
 * Generate a unique temp file path for powershell output
 */
function getTempFilePath() {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-powershell-${id}.log`);
}

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
	const toolLabel = shouldReplaceBash ? "PowerShell" : "powershell";
	const toolDescription = `Execute a powershell command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`;

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

			// We'll stream to a temp file if output gets large
			let tempFilePath: string | undefined;
			let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
			let totalBytes = 0;

			// Keep a rolling buffer of the last chunk for tail truncation
			const chunks: Buffer[] = [];
			let chunksBytes = 0;

			// Keep more than we need so we have enough for truncation
			const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

			const handleData = (data: Buffer) => {
				totalBytes += data.length;

				// Start writing to temp file once we exceed the threshold
				if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
					tempFilePath = getTempFilePath();
					tempFileStream = createWriteStream(tempFilePath);
					// Write all buffered chunks to the file
					for (const chunk of chunks) {
						tempFileStream.write(chunk);
					}
				}

				// Write to temp file if we have one
				if (tempFileStream) {
					tempFileStream.write(data);
				}

				// Keep rolling buffer of recent data
				chunks.push(data);
				chunksBytes += data.length;

				// Trim old chunks if buffer is too large
				while (chunksBytes > maxChunksBytes && chunks.length > 1) {
					const removed = chunks.shift();
					chunksBytes -= removed!.length;
				}

				// Stream partial output to callback (truncated rolling buffer)
				if (onUpdate) {
					const fullBuffer = Buffer.concat(chunks);
					const fullText = fullBuffer.toString("utf-8");
					const truncation = truncateTail(fullText);
					onUpdate({
						content: [{ type: "text", text: truncation.content || "" }],
						details: {
							truncation: truncation.truncated ? truncation : undefined,
							fullOutputPath: tempFilePath,
						},
					});
				}
			};

			// Try pwsh first, fall back to powershell.exe on Windows
			const primary = { command: "pwsh", args: ["-NoProfile", "-NonInteractive"] };
			const fallback = isWindows
				? { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive"] }
				: { command: "pwsh", args: ["-NoProfile", "-NonInteractive"] };

			try {
				const result = await tryExecWithFallback(command, cwd, {
					onData: handleData,
					signal: signal ?? undefined,
					timeout: timeout ?? 120,
				}, primary, fallback);

				// Close temp file stream
				if (tempFileStream) {
					tempFileStream.end();
				}

				// Combine all buffered chunks
				const fullBuffer = Buffer.concat(chunks);
				const fullOutput = fullBuffer.toString("utf-8");

				// Apply tail truncation
				const truncation = truncateTail(fullOutput);
				let outputText = truncation.content || "(no output)";

				// Build details with truncation info
				let details: Record<string, unknown>;
				if (truncation.truncated) {
					details = {
						truncation,
						fullOutputPath: tempFilePath,
					};

					// Build actionable notice
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						// Edge case: last line alone > 30KB
						const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
						outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
					} else if (truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
					} else {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
					}
				} else {
					details = {
						executed: command,
						exitCode: result.exitCode,
						cwd,
					};
				}

				if (result.exitCode !== 0) {
					outputText += `\n\nCommand exited with code ${result.exitCode}`;
				}

				return {
					content: [{ type: "text", text: outputText }],
					details,
				};
			} catch (error: any) {
				// Close temp file stream
				if (tempFileStream) {
					tempFileStream.end();
				}

				// Combine all buffered chunks for error output
				const fullBuffer = Buffer.concat(chunks);
				let output = fullBuffer.toString("utf-8");

				const isTimeout = error.message?.startsWith("timeout:");
				const isAborted = error.message === "aborted";

				if (isAborted) {
					if (output) output += "\n\n";
					output += "Command aborted";
				} else if (isTimeout) {
					const timeoutSecs = error.message.split(":")[1];
					if (output) output += "\n\n";
					output += `Command timed out after ${timeoutSecs} seconds`;
				} else {
					// For other errors, still apply truncation
					const truncation = truncateTail(output);
					output = truncation.content || "";
					if (truncation.truncated) {
						output += `\n\n[Output truncated. Full output: ${tempFilePath}]`;
					}
					if (output) output += "\n\n";
					output += `Error executing PowerShell command: ${error.message}`;
				}

				return {
					content: [{ type: "text", text: output }],
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

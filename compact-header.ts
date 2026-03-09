/**
 * Compact Header Info Extension
 *
 * Shows useful keybinding and session info on startup.
 * Uses setStatus to avoid overriding header.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { VERSION } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;

		// Get commands and skills
		const cmds = pi.getCommands();
		const prompts = cmds
			.filter((c) => c.source === "prompt")
			.map((c) => `/${c.name}`)
			.join("  ");
		const skills = cmds.filter((c) => c.source === "skill").map((c) => c.name).join("  ");

		const model = ctx.model ? `${ctx.model.id}` : "no model";
		const thinking = pi.getThinkingLevel();
		const provider = ctx.model?.provider ?? "";

		// Build key info status
		const keyInfo =
			theme.fg("dim", "keys: ") +
			theme.fg("accent", "^C") + theme.fg("dim", "interrupt ") +
			theme.fg("accent", "^O") + theme.fg("dim", "expand ") +
			theme.fg("accent", "^G") + theme.fg("dim", "editor ") +
			theme.fg("accent", "/") + theme.fg("dim", "cmds");

		ctx.ui.setStatus("key-info", keyInfo);

		// Model info
		const modelInfo =
			theme.fg("dim", "v") + theme.fg("accent", `${VERSION}`) +
			theme.fg("dim", " | ") +
			theme.fg("accent", model) +
			theme.fg("dim", ` (${thinking})`) +
			theme.fg("dim", " | ") +
			theme.fg("muted", provider);

		ctx.ui.setStatus("session-info", modelInfo);

		// Show prompts and skills if available
		if (prompts || skills) {
			const extras: string[] = [];
			if (prompts) extras.push(theme.fg("dim", "prompts: ") + theme.fg("accent", prompts));
			if (skills) extras.push(theme.fg("dim", "skills: ") + theme.fg("accent", skills));
			ctx.ui.setStatus("extras", extras.join(theme.fg("dim", " | ")));
		}
	});
}

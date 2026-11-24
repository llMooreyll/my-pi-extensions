import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { MESSAGE_TYPE, type TriggerMessageDetails } from "./runtime.js";
import { formatClockTime } from "./schedule.js";

const COLLAPSED_LINES = 6;

/** Trigger messages render as cards, so they never look like something the user typed. */
export function registerTriggerRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<TriggerMessageDetails>(MESSAGE_TYPE, (message, options, theme) => {
		const items = message.details?.items ?? [];
		const header = items.length
			? items
					.map((item) => {
						const what =
							item.kind === "timer"
								? `timer ${item.label}${item.run !== undefined ? ` · run ${item.run}${item.maxRuns ? `/${item.maxRuns}` : ""}` : ""}`
								: `${item.label}${item.route ? ` → ${item.route}` : ""}`;
						return theme.fg("accent", `trigger · ${what}`) + theme.fg("dim", ` · ${formatClockTime(item.at)}`);
					})
					.join("\n")
			: theme.fg("accent", "trigger");

		const body =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		let shown = body;
		if (!options.expanded) {
			const lines = body.split("\n");
			if (lines.length > COLLAPSED_LINES) {
				shown = `${lines.slice(0, COLLAPSED_LINES).join("\n")}\n${theme.fg("dim", `… ${lines.length - COLLAPSED_LINES} more lines (${options.keyHint("app.tools.expand", "to expand")})`)}`;
			}
		}
		const tools = message.details?.allowedTools;
		const footer = tools ? `\n${theme.fg("dim", `allowed tools: ${tools.join(", ") || "none"}`)}` : "";

		const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${header}\n${shown}${footer}`, 0, 0));
		return box;
	});
}

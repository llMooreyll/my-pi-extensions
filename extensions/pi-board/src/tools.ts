// write/edit overrides (DESIGN §5): built-in behaviour and rendering plus `message` and `task` parameters.

import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import { MESSAGE_MAX, MESSAGE_MIN } from "./guard.ts";
import { EDIT_GUIDELINE, WRITE_GUIDELINE } from "./prompt.ts";

const MESSAGE_DESCRIPTION =
	`One sentence (${MESSAGE_MIN}-${MESSAGE_MAX} characters) saying what changed and why, ` +
	'e.g. "Default punctuation engine switched to ct-punc, implementing D26". "update file" is not acceptable.';
const TASK_DESCRIPTION = "Id of the task this change belongs to, e.g. T12; must exist in docs/board/tasks.md. Omit when there is none.";
const DESCRIPTION_SUFFIX = ` Requires \`message\` (what changed and why); pass \`task\` when the change belongs to a task.`;

/** The built-in parameters with `message` first so it streams in (and renders) before the bulky arguments. */
function withBoardParameters(base: TSchema): TSchema {
	const properties = (base as unknown as { properties: Record<string, TSchema> }).properties;
	return Type.Object({
		message: Type.String({ minLength: MESSAGE_MIN, maxLength: MESSAGE_MAX, description: MESSAGE_DESCRIPTION }),
		task: Type.Optional(Type.String({ description: TASK_DESCRIPTION })),
		...properties,
	});
}

/** Draws the message line above the built-in call row. */
class MessageHeader implements Component {
	inner: Component | undefined;
	header = "";

	render(width: number): string[] {
		const lines = this.inner?.render(width) ?? [];
		return this.header === "" ? lines : [truncateToWidth(this.header, width), ...lines];
	}

	invalidate(): void {
		this.inner?.invalidate();
	}
}

type AnyTool = ToolDefinition<any, any, any>;

function override(base: AnyTool, guideline: string): AnyTool {
	return {
		...base,
		description: `${base.description}${DESCRIPTION_SUFFIX}`,
		promptGuidelines: [...(base.promptGuidelines ?? []), guideline],
		parameters: withBoardParameters(base.parameters),
		// Plan validation in tool_call must see the effect of earlier calls on the same file.
		executionMode: "sequential",
		execute: (toolCallId, params, signal, onUpdate, ctx) => {
			// The built-in implementations only know their own parameters.
			const { message: _message, task: _task, ...rest } = params as Record<string, unknown>;
			return base.execute(toolCallId, rest, signal, onUpdate, ctx);
		},
		renderCall: (args, theme, context) => {
			const holder = context.lastComponent instanceof MessageHeader ? context.lastComponent : new MessageHeader();
			// The built-in renderer keeps its own component between renders; hand it back what it returned last.
			holder.inner = base.renderCall?.(args, theme, { ...context, lastComponent: holder.inner });
			const message = typeof args?.message === "string" ? args.message.trim() : "";
			// Only a tool that draws its own shell (edit) leaves the padding to the renderer.
			const pad = base.renderShell === "self" ? (context.outputPad ?? 0) : 0;
			holder.header = message === "" ? "" : `${" ".repeat(pad)}${theme.fg("accent", `↳ ${message}`)}`;
			return holder;
		},
	};
}

/** Registers the overriding write and edit tools; later registrations of the same names win, so call it once. */
export function registerBoardTools(pi: ExtensionAPI, cwd: string): void {
	pi.registerTool(override(createWriteToolDefinition(cwd) as AnyTool, WRITE_GUIDELINE));
	pi.registerTool(override(createEditToolDefinition(cwd) as AnyTool, EDIT_GUIDELINE));
}

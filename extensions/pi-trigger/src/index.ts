import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTriggerCommands } from "./command.js";
import { registerTriggerRenderer } from "./render.js";
import { MESSAGE_TYPE, TriggerRuntime } from "./runtime.js";
import { registerTriggerService } from "./service.js";
import { registerScheduleTool } from "./tool.js";

export default function piTrigger(pi: ExtensionAPI): void {
	// Subagents and team members are driven by their parent; they get no timers or inbox of their own.
	if (process.env.PI_SUBAGENT_ID || process.env.PI_TEAM_MEMBER_ID) return;

	const runtime = new TriggerRuntime(pi);
	let unregisterService: (() => void) | undefined;

	registerScheduleTool(pi, runtime);
	registerTriggerCommands(pi, runtime);
	registerTriggerRenderer(pi);

	pi.on("session_start", async (_event, ctx) => {
		unregisterService?.();
		unregisterService = undefined;
		runtime.start(ctx);
		if (runtime.active) unregisterService = registerTriggerService(runtime);
	});

	pi.on("session_shutdown", async () => {
		unregisterService?.();
		unregisterService = undefined;
		runtime.stop();
	});

	pi.on("before_agent_start", async (event) => {
		runtime.onRunStart(event.messageType === "custom" && event.message.customType === MESSAGE_TYPE);
	});

	pi.on("agent_settled", async () => {
		runtime.onSettled();
	});

	pi.on("ui_prompt_start", async () => {
		runtime.onUiPrompt(true);
	});
	pi.on("ui_prompt_end", async () => {
		runtime.onUiPrompt(false);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") runtime.onAssistantCost(event.message.usage?.cost?.total ?? 0);
	});

	pi.on("tool_call", async (event) => {
		const reason = runtime.blockedToolReason(event.toolName);
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("cache_warming_decision", async (event) => {
		const action = runtime.warmingAction(event.warmCost, event.missCost);
		return action ? { action } : undefined;
	});
}

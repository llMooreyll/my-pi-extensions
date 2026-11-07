import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

/** One visible step inside a turn, used for the dot/line glyphs. */
export type TurnStepKind = "tool" | "toolError" | "text" | "answer" | "error" | "notice";

export interface TurnStep {
	kind: TurnStepKind;
	label?: string;
}

export interface ImageBlock {
	data: string;
	mimeType: string;
}

/** A turn starts at a user prompt and runs until the next one. */
export interface SessionTurn {
	/** 1-based position among all user prompts on the current branch, compacted ones included. */
	number: number;
	/** Session entry ID of the user prompt; undefined for a turn whose prompt was compacted away. */
	entryId: string | undefined;
	prompt: string;
	/** Whether the prompt has text, which is what Pi needs to render a user message in the transcript. */
	hasPromptText: boolean;
	startedAt?: number;
	endedAt?: number;
	steps: TurnStep[];
	toolCounts: Map<string, number>;
	outputTokens: number;
	model?: string;
	imageCount: number;
	hasError: boolean;
	entries: SessionEntry[];
}

export interface SessionOutline {
	turns: SessionTurn[];
	/** User prompts on the branch that compaction removed from the visible context. */
	compactedTurns: number;
}

/** Structural view of the message shapes this module reads; Pi's union is wider. */
interface LooseMessage {
	role: string;
	content?: unknown;
	timestamp?: number;
	usage?: { output?: number };
	stopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	command?: string;
}

const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

export function messageOf(entry: SessionEntry): LooseMessage | undefined {
	return entry.type === "message" ? (entry.message as unknown as LooseMessage) : undefined;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

export function imagesOf(content: unknown): ImageBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is ImageBlock & { type: "image" } =>
			block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string",
	);
}

/** Replaces an expanded skill block with `/skill:name` so the preview shows what the user typed. */
export function displayPrompt(text: string): string {
	const match = text.match(SKILL_BLOCK);
	if (!match) return text;
	return `/skill:${match[1]}${match[2] ? ` ${match[2].trim()}` : ""}`;
}

/**
 * Builds turns from the same entries Pi renders in the transcript
 * (`buildContextEntries()`), so turn order matches the on-screen user messages.
 */
export function buildOutline(sessionManager: ReadonlySessionManager): SessionOutline {
	const totalPrompts = sessionManager.getBranch().filter((entry) => messageOf(entry)?.role === "user").length;
	const turns: SessionTurn[] = [];
	const toolSteps = new Map<string, TurnStep>();
	let current: SessionTurn | undefined;
	let compacted = false;

	const ensureTurn = (): SessionTurn => {
		if (!current) {
			// Compaction can keep entries from the middle of a turn whose prompt is gone.
			current = createTurn(undefined, "", undefined);
			turns.push(current);
		}
		return current;
	};

	for (const entry of sessionManager.buildContextEntries()) {
		if (entry.type === "compaction") {
			compacted = true;
			continue;
		}
		if (entry.type === "custom_message") {
			if (!entry.display) continue;
			const turn = ensureTurn();
			turn.steps.push({ kind: "notice", label: entry.customType });
			turn.entries.push(entry);
			turn.imageCount += imagesOf(entry.content).length;
			continue;
		}

		const message = messageOf(entry);
		if (!message || message.role === "system") continue;

		if (message.role === "user") {
			current = createTurn(entry.id, textOf(message.content), message.timestamp);
			current.imageCount += imagesOf(message.content).length;
			current.entries.push(entry);
			turns.push(current);
			continue;
		}

		const turn = ensureTurn();
		turn.entries.push(entry);
		if (message.timestamp !== undefined) turn.endedAt = message.timestamp;

		switch (message.role) {
			case "assistant":
				addAssistant(turn, message, toolSteps);
				break;
			case "toolResult": {
				turn.imageCount += imagesOf(message.content).length;
				const step = message.toolCallId ? toolSteps.get(message.toolCallId) : undefined;
				if (step && message.isError) step.kind = "toolError";
				break;
			}
			case "bashExecution":
				turn.steps.push({ kind: "tool", label: "!bash" });
				countTool(turn, "!bash");
				break;
			case "custom":
				turn.steps.push({ kind: "notice" });
				break;
		}
	}

	const promptTurns = turns.filter((turn) => turn.entryId !== undefined).length;
	const hasOrphan = turns[0] !== undefined && turns[0].entryId === undefined;
	let number = Math.max(1, totalPrompts - promptTurns + 1);
	for (const turn of turns) {
		if (turn.entryId === undefined) turn.number = Math.max(0, number - 1);
		else turn.number = number++;
	}

	return {
		turns,
		compactedTurns: compacted ? Math.max(0, totalPrompts - promptTurns - (hasOrphan ? 1 : 0)) : 0,
	};
}

function createTurn(entryId: string | undefined, rawPrompt: string, timestamp: number | undefined): SessionTurn {
	const prompt = displayPrompt(rawPrompt).trim();
	return {
		number: 0,
		entryId,
		prompt,
		hasPromptText: rawPrompt.length > 0,
		startedAt: timestamp,
		endedAt: timestamp,
		steps: [],
		toolCounts: new Map(),
		outputTokens: 0,
		imageCount: 0,
		hasError: false,
		entries: [],
	};
}

function addAssistant(turn: SessionTurn, message: LooseMessage, toolSteps: Map<string, TurnStep>): void {
	const blocks = Array.isArray(message.content) ? message.content : [];
	const hasText = textOf(blocks).trim().length > 0;
	const toolCalls = blocks.filter((block) => block?.type === "toolCall");

	if (hasText) turn.steps.push({ kind: toolCalls.length > 0 ? "text" : "answer" });
	for (const call of toolCalls) {
		const name = typeof call.name === "string" ? call.name : "tool";
		const step: TurnStep = { kind: "tool", label: name };
		turn.steps.push(step);
		if (typeof call.id === "string") toolSteps.set(call.id, step);
		countTool(turn, name);
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		turn.steps.push({ kind: "error", label: message.stopReason });
		turn.hasError = true;
	}

	turn.outputTokens += message.usage?.output ?? 0;
	if (message.model) turn.model = message.model;
}

function countTool(turn: SessionTurn, name: string): void {
	turn.toolCounts.set(name, (turn.toolCounts.get(name) ?? 0) + 1);
}

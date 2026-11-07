/**
 * Read-only access to Pi's fullscreen transcript. None of this is public API:
 * it relies on the layout Pi 1.5 builds (`createChatViewport`): a primary
 * ScrollView whose child is the document Container, which holds the chat
 * Container with one component per message. Every lookup fails soft.
 */
import {
	AssistantMessageComponent,
	SkillInvocationMessageComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, ScrollView } from "@earendil-works/pi-tui";
import { textOf, type SessionTurn } from "./turns.js";

export interface Transcript {
	scrollView: ScrollView;
	document: Container;
}

/** Transcript rows (content lines) of a turn's prompt and of its reply text. */
export interface TurnRows {
	prompt: number;
	answer?: number;
}

interface PromptAnchor {
	row: number;
	messageId?: string;
}

interface ReplyAnchor {
	row: number;
	/** No tool calls: the reply that ends a step, as opposed to running narration. */
	final: boolean;
}

/** Fields of AssistantMessageComponent that are private in Pi's typings. */
interface AssistantInternals {
	hasToolCalls?: boolean;
	lastMessage?: { content?: unknown };
	contentContainer?: Container;
	markdownSlots?: Array<{ kind: string; markdown: Component }>;
}

const SEARCH_LIMIT = 200;

export function findTranscript(root: Component): Transcript | undefined {
	const queue: Component[] = [root];
	for (let visited = 0; queue.length > 0 && visited < SEARCH_LIMIT; visited++) {
		const component = queue.shift()!;
		if (component instanceof ScrollView && component.primary) {
			const document = component.children[0];
			return document instanceof Container ? { scrollView: component, document } : undefined;
		}
		if (component instanceof Container) queue.push(...component.children);
	}
	return undefined;
}

function isPromptComponent(component: Component): boolean {
	return component instanceof UserMessageComponent || component instanceof SkillInvocationMessageComponent;
}

function findChat(document: Container): Container | undefined {
	return document.children.find(
		(child): child is Container => child instanceof Container && child.children.some(isPromptComponent),
	);
}

/** Rows from the top of an assistant message to its first text block, skipping thinking. */
function textOffset(component: AssistantMessageComponent, width: number): number {
	const internals = component as unknown as AssistantInternals;
	const firstText = internals.markdownSlots?.find((slot) => slot.kind === "text")?.markdown;
	const container = internals.contentContainer;
	if (!firstText || !container) return 0;
	let row = 0;
	for (const child of container.children) {
		if (child === firstText) return row;
		row += child.render(width).length;
	}
	return 0;
}

/** Rows where each rendered user prompt starts, and rows of assistant reply text. */
function collectAnchors(transcript: Transcript, contentWidth: number): { prompts: PromptAnchor[]; replies: ReplyAnchor[] } {
	const prompts: PromptAnchor[] = [];
	const replies: ReplyAnchor[] = [];
	const chat = findChat(transcript.document);
	if (!chat) return { prompts, replies };

	let row = 0;
	for (const child of transcript.document.children) {
		if (child !== chat) {
			row += child.render(contentWidth).length;
			continue;
		}
		let lastSkillIndex = Number.NEGATIVE_INFINITY;
		chat.children.forEach((component, index) => {
			if (component instanceof SkillInvocationMessageComponent) {
				prompts.push({ row });
				lastSkillIndex = index;
			} else if (component instanceof UserMessageComponent) {
				const messageId = (component as unknown as { messageId?: string }).messageId;
				const last = prompts.at(-1);
				// Pi renders a skill invocation with arguments as skill block + spacer + user message.
				if (index - lastSkillIndex <= 2 && last) last.messageId ??= messageId;
				else prompts.push({ row, messageId });
			} else if (component instanceof AssistantMessageComponent) {
				const internals = component as unknown as AssistantInternals;
				if (textOf(internals.lastMessage?.content).trim()) {
					replies.push({ row: row + textOffset(component, contentWidth), final: internals.hasToolCalls !== true });
				}
			}
			row += component.render(contentWidth).length;
		});
		break;
	}
	return { prompts, replies };
}

/**
 * Maps turns to transcript rows. Restored messages carry their entry ID; live
 * ones do not, so the remainder is matched by position from the newest end.
 * A turn's answer is its last final reply before the next prompt, or failing
 * that its last reply text.
 */
export function locateTurns(
	transcript: Transcript,
	contentWidth: number,
	turns: readonly SessionTurn[],
): Map<SessionTurn, TurnRows> {
	const { prompts, replies } = collectAnchors(transcript, contentWidth);
	const promptRows = new Map<SessionTurn, number>();
	const used = new Set<PromptAnchor>();
	const byId = new Map<string, PromptAnchor>();
	for (const anchor of prompts) if (anchor.messageId) byId.set(anchor.messageId, anchor);

	const candidates = turns.filter((turn) => turn.entryId !== undefined && turn.hasPromptText);
	for (const turn of candidates) {
		const anchor = byId.get(turn.entryId!);
		if (!anchor) continue;
		promptRows.set(turn, anchor.row);
		used.add(anchor);
	}

	const remainingTurns = candidates.filter((turn) => !promptRows.has(turn));
	const remainingAnchors = prompts.filter((anchor) => !used.has(anchor));
	const pairs = Math.min(remainingTurns.length, remainingAnchors.length);
	for (let offset = 1; offset <= pairs; offset++) {
		promptRows.set(remainingTurns[remainingTurns.length - offset]!, remainingAnchors[remainingAnchors.length - offset]!.row);
	}

	const allPromptRows = prompts.map((anchor) => anchor.row).sort((a, b) => a - b);
	const located = new Map<SessionTurn, TurnRows>();
	for (const [turn, prompt] of promptRows) {
		const end = allPromptRows.find((row) => row > prompt) ?? Number.POSITIVE_INFINITY;
		const inTurn = replies.filter((reply) => reply.row > prompt && reply.row < end);
		const answer = inTurn.filter((reply) => reply.final).at(-1) ?? inTurn.at(-1);
		located.set(turn, { prompt, ...(answer ? { answer: answer.row } : {}) });
	}
	return located;
}

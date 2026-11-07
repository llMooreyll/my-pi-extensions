import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { imagesOf, messageOf, textOf, type ImageBlock, type SessionTurn } from "./turns.js";

const EDITOR_COMMAND = "nvim";
const POPUP_SIZE = "90%";

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/**
 * Writes one turn as Markdown next to its images, so an editor with image support
 * (snacks.image in the user's nvim) renders text, formulas, diagrams and images together.
 */
export function writeTurnMarkdown(turn: SessionTurn, sessionId: string): string {
	const directory = join(tmpdir(), "pi-session-view", sessionId.replace(/[^\w.-]/g, "_"));
	mkdirSync(directory, { recursive: true });

	let imageIndex = 0;
	const saveImages = (images: ImageBlock[], caption: string): string[] =>
		images.map((image) => {
			imageIndex++;
			const extension = IMAGE_EXTENSIONS[image.mimeType] ?? "png";
			const file = join(directory, `turn-${turn.number}-${imageIndex}.${extension}`);
			writeFileSync(file, Buffer.from(image.data, "base64"));
			return `![${caption} ${imageIndex}](${file})`;
		});

	const lines: string[] = [`# Turn ${turn.number}`, ""];
	const meta = [
		turn.startedAt !== undefined ? new Date(turn.startedAt).toLocaleString() : undefined,
		turn.model,
		turn.outputTokens > 0 ? `${turn.outputTokens} output tokens` : undefined,
	].filter(Boolean);
	if (meta.length > 0) lines.push(`> ${meta.join(" · ")}`, "");
	if (turn.entryId === undefined) lines.push("## Response", "", "_The prompt was compacted._", "");

	// Text that accompanies tool calls is running narration ("let me check…"); in the
	// transcript it sits between tool outputs, but without them it reads as stray
	// preamble. Keep only replies that end a step without tool calls; if the turn has
	// none (aborted mid-run), fall back to its last text.
	const answers = new Set(
		turn.entries.filter((entry) => {
			const message = messageOf(entry);
			return message?.role === "assistant" && !hasToolCall(message.content) && textOf(message.content).trim() !== "";
		}),
	);
	if (answers.size === 0) {
		const lastText = [...turn.entries].reverse().find((entry) => {
			const message = messageOf(entry);
			return message?.role === "assistant" && textOf(message.content).trim() !== "";
		});
		if (lastText) answers.add(lastText);
	}
	const toolImages: string[] = [];

	for (const entry of turn.entries) {
		if (entry.type === "custom_message") {
			const text = textOf(entry.content).trim();
			lines.push(`> **[${entry.customType}]**`, ...(text ? ["", text] : []), "");
			lines.push(...saveImages(imagesOf(entry.content), entry.customType), "");
			continue;
		}

		const message = messageOf(entry);
		if (!message) continue;
		switch (message.role) {
			case "user": {
				lines.push("## Prompt", "", turn.prompt || "_(no text)_", "");
				const images = saveImages(imagesOf(message.content), "image");
				if (images.length > 0) lines.push(...images, "");
				lines.push("## Response", "");
				break;
			}
			case "assistant": {
				if (answers.has(entry)) lines.push(textOf(message.content).trim(), "");
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					lines.push(`> **${message.stopReason}**${message.errorMessage ? `: ${message.errorMessage}` : ""}`, "");
				}
				break;
			}
			case "toolResult":
				toolImages.push(...saveImages(imagesOf(message.content), `${message.toolName ?? "tool"} result image`));
				break;
		}
	}
	if (toolImages.length > 0) lines.push("## Tool images", "", ...toolImages.flatMap((image) => [image, ""]));

	const file = join(directory, `turn-${turn.number}.md`);
	writeFileSync(file, `${lines.join("\n").trimEnd()}\n`, "utf8");
	return file;
}

/** Opens the turn in nvim: a tmux popup when inside tmux, otherwise by suspending the TUI. */
export async function openTurnInNvim(ctx: ExtensionContext, turn: SessionTurn): Promise<void> {
	let file: string;
	try {
		file = writeTurnMarkdown(turn, ctx.sessionManager.getSessionId());
	} catch (error) {
		ctx.ui.notify(`Could not write turn ${turn.number}: ${errorText(error)}`, "error");
		return;
	}

	if (process.env.TMUX) {
		const args = ["display-popup", "-E", "-w", POPUP_SIZE, "-h", POPUP_SIZE, "-d", ctx.cwd, "-T", ` Turn ${turn.number} `];
		// Target pi's own pane so the popup opens on the client showing this session.
		if (process.env.TMUX_PANE) args.push("-t", process.env.TMUX_PANE);
		args.push(EDITOR_COMMAND, file);
		// Asynchronous: pi keeps rendering while the popup is open.
		execFile("tmux", args, (error) => {
			if (!error) return;
			try {
				ctx.ui.notify(`tmux popup failed: ${errorText(error)}`, "error");
			} catch {
				// The session that requested the popup may already be gone.
			}
		});
		return;
	}

	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Wrote ${file}`, "info");
		return;
	}
	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
		tui.stop();
		const result = spawnSync(EDITOR_COMMAND, [file], { stdio: "inherit", cwd: ctx.cwd });
		tui.start();
		tui.requestRender(true);
		if (result.error) ctx.ui.notify(`Could not start ${EDITOR_COMMAND}: ${result.error.message}`, "error");
		done(undefined);
		return { render: () => [], invalidate: () => {} };
	});
}

function hasToolCall(content: unknown): boolean {
	return Array.isArray(content) && content.some((block) => block?.type === "toolCall");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

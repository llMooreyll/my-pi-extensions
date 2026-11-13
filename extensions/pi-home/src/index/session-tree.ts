import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { TreeNode } from "../ui/charts/tree.ts";

export interface TreeEntry {
	id: string;
	parentId: string | null;
	type: string; // entry type ("message", "compaction", "branch_summary", ...)
	role?: string; // message role
	t: number; // timestamp ms
	/** First 60 characters of user text (role user) or of the branch summary. */
	preview?: string;
	/** Latest label set on this entry by a "label" entry (see docs/session-format.md). */
	label?: string;
}

export interface SessionTree {
	entries: Map<string, TreeEntry>;
	roots: string[];
	children: Map<string, string[]>;
	leafId: string | null;
}

const PREVIEW_LEN = 60;

const clip = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LEN);

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join(" ");
}

/** Stream a session file into its entry tree. Bad lines and entries without an id are skipped. */
export async function readSessionTree(file: string): Promise<SessionTree> {
	const entries = new Map<string, TreeEntry>();
	const order: string[] = [];
	const labels: { target: string; label: string | undefined }[] = [];
	let leafId: string | null = null;
	const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		// The "session" header line is not part of the tree.
		if (typeof e.id !== "string" || typeof e.type !== "string" || e.type === "session") continue;
		const t = typeof e.timestamp === "number" ? e.timestamp : Date.parse(String(e.timestamp));
		const entry: TreeEntry = { id: e.id, parentId: typeof e.parentId === "string" ? e.parentId : null, type: e.type, t: Number.isFinite(t) ? t : 0 };
		if (e.type === "message" && e.message && typeof e.message === "object") {
			const m = e.message as { role?: unknown; content?: unknown };
			if (typeof m.role === "string") entry.role = m.role;
			if (m.role === "user") entry.preview = clip(userText(m.content));
		} else if (e.type === "branch_summary" && typeof e.summary === "string") {
			entry.preview = clip(e.summary);
		} else if (e.type === "label" && typeof e.targetId === "string") {
			labels.push({ target: e.targetId, label: typeof e.label === "string" && e.label ? e.label : undefined });
		}
		if (!entries.has(entry.id)) order.push(entry.id);
		entries.set(entry.id, entry);
		leafId = entry.id;
	}
	for (const { target, label } of labels) {
		const te = entries.get(target);
		if (te) te.label = label;
	}
	const roots: string[] = [];
	const children = new Map<string, string[]>();
	for (const id of order) {
		const p = entries.get(id)!.parentId;
		if (p === null || !entries.has(p)) roots.push(id);
		else {
			const list = children.get(p);
			if (list) list.push(id);
			else children.set(p, [id]);
		}
	}
	return { entries, roots, children, leafId };
}

/**
 * Collapse linear chains: one node per run of entries without branching. Label is
 * "<n> entries · <first user preview>" plus " [label]" per labelled entry; the run holding the
 * leaf ends with " « current". Children are the branches. At most `maxNodes` run nodes are
 * emitted; the rest is replaced by a "… more" node. Several roots get a "session" wrapper.
 */
export function compactTree(tree: SessionTree, maxNodes = 200): TreeNode {
	let count = 0;
	const build = (startId: string): TreeNode => {
		count++;
		let n = 0;
		let preview: string | undefined;
		let tail = "";
		let id = startId;
		let kids: string[];
		for (;;) {
			const e = tree.entries.get(id)!;
			n++;
			if (preview === undefined && e.role === "user" && e.preview) preview = e.preview;
			else if (preview === undefined && e.type === "branch_summary" && e.preview) preview = e.preview;
			if (e.label) tail += ` [${e.label}]`;
			if (id === tree.leafId) tail += " « current";
			kids = tree.children.get(id) ?? [];
			if (kids.length !== 1) break;
			id = kids[0]!;
		}
		const node: TreeNode = { label: `${n} entries${preview ? ` · ${preview}` : ""}${tail}`, children: [] };
		for (const k of kids) {
			if (count >= maxNodes) {
				node.children.push({ label: "… more", children: [] });
				break;
			}
			node.children.push(build(k));
		}
		return node;
	};
	if (tree.roots.length === 0) return { label: "0 entries", children: [] };
	if (tree.roots.length === 1) return build(tree.roots[0]!);
	const root: TreeNode = { label: "session", children: [] };
	for (const r of tree.roots) {
		if (count >= maxNodes) {
			root.children.push({ label: "… more", children: [] });
			break;
		}
		root.children.push(build(r));
	}
	return root;
}

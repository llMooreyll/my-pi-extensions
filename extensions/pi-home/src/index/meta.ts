import { readFileSync } from "node:fs";
import { saveJsonAtomic } from "../config.ts";
import { metaPath } from "../paths.ts";
import type { MetaLookup } from "./query.ts";

interface SessionMeta {
	favorite?: boolean;
	tags?: string[];
	note?: string;
}

/** Tags, favourites and notes keyed by session id, stored outside the session files (SESSIONS.md §4). */
export class MetaStore implements MetaLookup {
	private data: Record<string, SessionMeta> = {};

	constructor() {
		try {
			this.data = JSON.parse(readFileSync(metaPath(), "utf8")) as Record<string, SessionMeta>;
		} catch {
			this.data = {};
		}
	}

	private save(): void {
		saveJsonAtomic(metaPath(), this.data);
	}

	private entry(id: string): SessionMeta {
		return (this.data[id] ??= {});
	}

	isFavorite(id: string): boolean {
		return this.data[id]?.favorite === true;
	}

	tags(id: string): string[] {
		return this.data[id]?.tags ?? [];
	}

	note(id: string): string {
		return this.data[id]?.note ?? "";
	}

	allTags(): string[] {
		const s = new Set<string>();
		for (const m of Object.values(this.data)) for (const t of m.tags ?? []) s.add(t);
		return [...s].sort();
	}

	toggleFavorite(id: string): void {
		const e = this.entry(id);
		e.favorite = !e.favorite;
		this.save();
	}

	setTags(id: string, tags: string[]): void {
		this.entry(id).tags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
		this.save();
	}

	setNote(id: string, note: string): void {
		this.entry(id).note = note;
		this.save();
	}
}

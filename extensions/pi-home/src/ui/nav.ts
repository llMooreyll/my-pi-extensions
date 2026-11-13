import type { SessionFilter } from "../index/query.ts";
import type { SessionRecord } from "../index/types.ts";
import type { App } from "./app.ts";

/**
 * Cross-page navigation hooks. Pages register handlers at construction so that pages can link
 * to each other without import cycles (analytics → sessions list, any page → session detail).
 */
export const navHandlers: {
	drillDown: ((app: App, patch: Partial<SessionFilter>, label: string) => void) | null;
	openSession: ((app: App, rec: SessionRecord) => void) | null;
} = { drillDown: null, openSession: null };

/**
 * Show the Sessions tab filtered by `patch` (merged over a fresh default filter).
 * `label` describes the drill-down in English, e.g. "2026-11-03" or "model claude-opus-5-5".
 */
export function drillDown(app: App, patch: Partial<SessionFilter>, label: string): void {
	if (navHandlers.drillDown) navHandlers.drillDown(app, patch, label);
	else app.toast("sessions page not available", "error");
}

/** Open the full-screen detail page of one session. */
export function openSession(app: App, rec: SessionRecord): void {
	if (navHandlers.openSession) navHandlers.openSession(app, rec);
	else app.toast("session detail not available", "error");
}

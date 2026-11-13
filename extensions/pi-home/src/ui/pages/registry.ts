import type { App, Page, TabId } from "../app.ts";
import { HomePage } from "./home.ts";
import { PlaceholderPage } from "./placeholder.ts";

/** Tab pages in tab-bar order. Tasks replace placeholders with real pages here. */
export function registerPages(app: App): { id: TabId; page: Page }[] {
	return [
		{ id: "home", page: new HomePage(app) },
		{ id: "sessions", page: new PlaceholderPage("SESSIONS") },
		{ id: "analytics", page: new PlaceholderPage("ANALYTICS") },
		{ id: "presets", page: new PlaceholderPage("PRESETS") },
	];
}

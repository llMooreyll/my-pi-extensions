import type { Surface } from "../../term/canvas.ts";
import type { App, Page } from "../app.ts";

/** Stand-in for a tab whose page is not implemented yet. */
export class PlaceholderPage implements Page {
	readonly title: string;

	constructor(title: string) {
		this.title = title;
	}

	draw(s: Surface, app: App): void {
		s.textIn(0, Math.floor(s.h / 2), s.w, `[ ${this.title} :: NOT_IMPLEMENTED ]`, app.pal.dim, "center");
	}

	key(): boolean {
		return false;
	}
}

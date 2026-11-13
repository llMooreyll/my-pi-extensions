import { spawn } from "node:child_process";
import { join } from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import { homeDataDir, tildify } from "../../../paths.ts";
import { writeHtmlReport } from "../../../report/html.ts";
import type { Surface } from "../../../term/canvas.ts";
import type { App } from "../../app.ts";
import { type AnalyticsData, type SubPage } from "./layout.ts";
import { WrappedPage, type WrappedPeriod } from "../wrapped.ts";

const PERIODS: { id: WrappedPeriod; label: string }[] = [
	{ id: "month", label: "THIS MONTH" },
	{ id: "quarter", label: "THIS QUARTER" },
	{ id: "all", label: "ALL TIME" },
];

const stamp = (d: Date): string => {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** WRAPPED sub-tab: period chooser, Enter starts Pi Wrapped, h / H write the HTML report. */
export class WrappedSubPage implements SubPage {
	hints = "left/right period  enter start  h html report  H report and open";
	private period = 0;
	private data: AnalyticsData | null = null;

	private start(app: App): void {
		app.push(new WrappedPage(app, PERIODS[this.period]!.id));
	}

	private report(app: App, open: boolean): void {
		if (!this.data) return;
		const path = join(homeDataDir(), `report-${stamp(new Date())}.html`);
		try {
			writeHtmlReport(this.data.records, this.data.range, app.config, path);
		} catch (e) {
			app.toast(`report failed: ${String(e)}`, "error");
			return;
		}
		app.toast(`report written: ${tildify(path)}`);
		if (open) {
			try {
				const child = spawn("xdg-open", [path], { detached: true, stdio: "ignore" });
				child.on("error", () => {});
				child.unref();
			} catch (e) {
				app.toast(`xdg-open failed: ${String(e)}`, "error");
			}
		}
	}

	draw(s: Surface, app: App, data: AnalyticsData): void {
		this.data = data;
		const pal = app.pal;
		const y = Math.max(0, Math.floor(s.h / 2) - 3);
		s.textIn(0, y, s.w, "Press enter to start Pi Wrapped", pal.strong, "center");
		s.hit(0, y, s.w, 1, { onClick: () => this.start(app) });
		const text = PERIODS.map((p, i) => (i === this.period ? `[ ${p.label} ]` : `  ${p.label}  `)).join("  ");
		let x = Math.max(0, Math.floor((s.w - text.length) / 2));
		PERIODS.forEach((p, i) => {
			const label = i === this.period ? `[ ${p.label} ]` : `  ${p.label}  `;
			s.text(x, y + 2, label, i === this.period ? pal.sel : pal.dim);
			s.hit(x, y + 2, label.length, 1, { onClick: () => (this.period = i) });
			x += label.length + 2;
		});
		s.textIn(0, y + 4, s.w, "h  write an HTML report      H  write it and open it in the browser", pal.dim, "center");
	}

	key(data: string, app: App): boolean {
		if (matchesKey(data, "left")) return (this.period = (this.period + PERIODS.length - 1) % PERIODS.length), true;
		if (matchesKey(data, "right")) return (this.period = (this.period + 1) % PERIODS.length), true;
		if (matchesKey(data, "enter")) return this.start(app), true;
		if (data === "h") return this.report(app, false), true;
		if (data === "H") return this.report(app, true), true;
		return false;
	}
}

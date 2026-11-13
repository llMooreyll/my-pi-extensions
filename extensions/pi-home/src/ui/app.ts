import { isKeyRelease, matchesKey, ProcessTerminal } from "@earendil-works/pi-tui";
import { type HomeConfig, saveConfig } from "../config.ts";
import type { SessionIndex } from "../index/indexer.ts";
import type { MetaStore } from "../index/meta.ts";
import { Canvas, type MouseInfo, type Surface } from "../term/canvas.ts";
import { brightness, powerMask, powerOffMask, scanlines, vignette } from "../term/crt.ts";
import { parseInput } from "../term/input.ts";
import { Renderer } from "../term/renderer.ts";
import type { Palette } from "../theme.ts";
import { drawChrome, drawMarker } from "./chrome.ts";

export type TabId = "home" | "sessions" | "analytics" | "presets";

/**
 * A full-screen view. Tabs are Pages; sub-pages (session detail, profile editor) are Pages pushed
 * on top of a tab with app.push() and removed with app.back() (Esc by default).
 */
export interface Page {
	/** Short uppercase title shown in the tab bar / breadcrumb. */
	readonly title: string;
	draw(s: Surface, app: App): void;
	/** Return true when the key was consumed. Unconsumed keys fall through to global bindings. */
	key(data: string, app: App): boolean;
	paste?(text: string, app: App): boolean;
	/** Called each time the page becomes visible. */
	enter?(app: App): void;
	/** Footer hint, e.g. "⏎ open  / search  q quit". */
	hints?(app: App): string;
	/** When true, global single-letter shortcuts (1-4, q, Tab) are disabled (text input focused). */
	captureText?(): boolean;
}

/** A dialog drawn centred over the current page; receives all keys while open. */
export interface Modal {
	readonly width: number;
	readonly height: number;
	draw(s: Surface, app: App): void;
	key(data: string, app: App): void;
	paste?(text: string, app: App): void;
}

export interface LaunchRequest {
	cwd: string;
	args: string[];
}

export interface AppDeps {
	pal: Palette;
	config: HomeConfig;
	index: SessionIndex;
	meta: MetaStore;
	/** Called with the launch request; must write the launch file. */
	onLaunch: (req: LaunchRequest) => void;
}

const FRAME_MS = 33;

export class App {
	readonly pal: Palette;
	readonly config: HomeConfig;
	readonly index: SessionIndex;
	readonly meta: MetaStore;
	readonly startedAt = Date.now();
	tabs: { id: TabId; page: Page }[] = [];
	tabIndex = 0;
	/** Sub-page stack on top of the current tab. */
	stack: Page[] = [];
	modals: Modal[] = [];
	pageEnteredAt = Date.now();
	/** Footer message overriding hints until `until`. */
	toastMsg: { text: string; kind: "info" | "error"; until: number } | null = null;

	private readonly deps: AppDeps;
	private readonly terminal = new ProcessTerminal();
	private readonly renderer: Renderer;
	private canvas: Canvas;
	private renderQueued = false;
	private animUntil = 0;
	private animTimer: NodeJS.Timeout | null = null;
	private blinkTimer: NodeJS.Timeout | null = null;
	private flickerFrame = false;
	private powerOn: { start: number; ms: number } | null = null;
	private powerOff: { start: number; ms: number; done: () => void } | null = null;
	private exiting = false;
	private exitCode = 0;
	private resolveExit: (code: number) => void = () => {};

	constructor(deps: AppDeps) {
		this.deps = deps;
		this.pal = deps.pal;
		this.config = deps.config;
		this.index = deps.index;
		this.meta = deps.meta;
		this.renderer = new Renderer((s) => this.terminal.write(s));
		this.canvas = new Canvas(80, 24);
	}

	get motion(): boolean {
		return this.pal.caps.motion && this.config.visual.motion;
	}

	// ── lifecycle ─────────────────────────────────────────────────────────

	run(): Promise<number> {
		const done = new Promise<number>((r) => {
			this.resolveExit = r;
		});
		this.terminal.start(
			(data) => this.onInput(data),
			() => this.onResize(),
		);
		// Alternate screen, hide cursor, no autowrap, SGR mouse (press/release + wheel).
		this.terminal.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J");
		this.terminal.setTitle("pi-home");
		this.canvas.resize(this.terminal.columns, this.terminal.rows);
		if (this.motion && this.config.visual.bootAnimation) this.powerOn = { start: Date.now(), ms: 650 };
		this.enterCurrent();
		this.blinkTimer = setInterval(() => this.requestRender(), 530);
		this.animate(700);
		this.requestRender();
		this.index.onChange = () => this.requestRender();
		// Leave the terminal usable when killed (window closed, kill from another shell).
		const onSignal = (): void => {
			this.restoreTerminal();
			process.exit(1);
		};
		process.once("SIGTERM", onSignal);
		process.once("SIGHUP", onSignal);
		return done;
	}

	private restoreTerminal(): void {
		if (this.animTimer) clearInterval(this.animTimer);
		if (this.blinkTimer) clearInterval(this.blinkTimer);
		this.terminal.write("\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l");
		this.terminal.stop();
	}

	/** Leave the UI and resolve run() with `code` (0 = launch requested, 1 = user quit). */
	exit(code: number): void {
		if (this.exiting) return;
		this.exiting = true;
		this.exitCode = code;
		const finish = (): void => {
			this.restoreTerminal();
			void this.terminal.drainInput(300, 50).finally(() => this.resolveExit(this.exitCode));
		};
		if (this.motion) {
			this.powerOff = { start: Date.now(), ms: 380, done: finish };
			this.animate(400);
		} else {
			finish();
		}
	}

	quit(): void {
		this.exit(1);
	}

	launch(req: LaunchRequest): void {
		try {
			this.deps.onLaunch(req);
		} catch (e) {
			this.toast(`launch failed: ${String(e)}`, "error");
			return;
		}
		this.exit(0);
	}

	saveConfig(): void {
		try {
			saveConfig(this.config);
		} catch (e) {
			this.toast(`config save failed: ${String(e)}`, "error");
		}
	}

	// ── navigation ────────────────────────────────────────────────────────

	get page(): Page {
		return this.stack[this.stack.length - 1] ?? this.tabs[this.tabIndex]!.page;
	}

	get tabId(): TabId {
		return this.tabs[this.tabIndex]!.id;
	}

	private enterCurrent(): void {
		this.pageEnteredAt = Date.now();
		this.page.enter?.(this);
		this.animate(400);
	}

	go(id: TabId): void {
		const i = this.tabs.findIndex((t) => t.id === id);
		if (i < 0) return;
		this.stack = [];
		this.tabIndex = i;
		this.enterCurrent();
		this.requestRender();
	}

	/** The page object registered for a tab (to pass drill-down filters before go()). */
	tab<T extends Page>(id: TabId): T {
		return this.tabs.find((t) => t.id === id)!.page as T;
	}

	push(page: Page): void {
		this.stack.push(page);
		this.enterCurrent();
		this.requestRender();
	}

	back(): void {
		if (this.stack.length === 0) return;
		this.stack.pop();
		this.enterCurrent();
		this.requestRender();
	}

	modal(m: Modal): void {
		this.modals.push(m);
		this.requestRender();
	}

	closeModal(): void {
		this.modals.pop();
		this.requestRender();
	}

	toast(text: string, kind: "info" | "error" = "info", ms = 3500): void {
		this.toastMsg = { text, kind, until: Date.now() + ms };
		setTimeout(() => this.requestRender(), ms + 20);
		this.requestRender();
	}

	// ── animation ─────────────────────────────────────────────────────────

	/** Keep rendering at ~30 fps for the next `ms` milliseconds. */
	animate(ms: number): void {
		if (!this.motion) return;
		this.animUntil = Math.max(this.animUntil, Date.now() + ms);
		if (this.animTimer) return;
		this.animTimer = setInterval(() => {
			this.requestRender();
			if (Date.now() > this.animUntil && this.animTimer) {
				clearInterval(this.animTimer);
				this.animTimer = null;
			}
		}, FRAME_MS);
	}

	/**
	 * Eased 0..1 progress since the current page was entered, over `ms`. Use for grow-in charts and
	 * counting numbers. Returns 1 when motion is disabled.
	 */
	progress(ms = 400): number {
		if (!this.motion) return 1;
		const t = Math.min(1, (Date.now() - this.pageEnteredAt) / ms);
		if (t < 1) this.animate(ms);
		return 1 - (1 - t) ** 3;
	}

	/** True during the "on" half of the 530 ms cursor blink. */
	blinkOn(): boolean {
		return !this.motion || Math.floor(Date.now() / 530) % 2 === 0;
	}

	// ── rendering ─────────────────────────────────────────────────────────

	requestRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		setImmediate(() => {
			this.renderQueued = false;
			this.render();
		});
	}

	private onResize(): void {
		this.canvas.resize(this.terminal.columns, this.terminal.rows);
		this.renderer.invalidate();
		this.terminal.write("\x1b[2J");
		this.requestRender();
	}

	private render(): void {
		const c = this.canvas;
		const pal = this.pal;
		c.clear(pal.p100, pal.screenBg);
		const content = drawChrome(c, this);
		try {
			this.page.draw(content, this);
		} catch (e) {
			content.text(1, 1, `render error: ${String(e)}`, { fg: pal.err });
		}
		for (const m of this.modals) {
			const w = Math.min(m.width, content.w - 2);
			const h = Math.min(m.height, content.h - 2);
			const x = Math.floor((content.w - w) / 2);
			const y = Math.floor((content.h - h) / 2);
			// Drop shadow, panel, border.
			content.fill(x + 2, y + 1, w, h, { bg: pal.bezel[2] });
			content.fill(x, y, w, h, { fg: pal.p100, bg: pal.panelBg });
			content.box(x, y, w, h, { fg: pal.p70, bg: pal.panelBg }, "double");
			// Block clicks to the page underneath.
			content.hit(x, y, w, h, { onClick: () => {} });
			m.draw(content.sub(x + 1, y + 1, w - 2, h - 2), this);
		}
		if (pal.caps.tier >= 2) {
			const v = this.config.visual;
			// At T3 the shader adds its own vignette; doubling it hides the status lines.
			if (v.vignette && pal.caps.tier === 2) vignette(c, 0.35);
			if (v.scanlines) scanlines(c, 0.92);
			if (v.flicker && this.motion) {
				if (!this.flickerFrame && Math.random() < 1 / 400) this.flickerFrame = true;
				else this.flickerFrame = false;
				if (this.flickerFrame) brightness(c, 0.94);
			}
		}
		const dark = pal.bezel[3];
		if (this.powerOn) {
			const t = (Date.now() - this.powerOn.start) / this.powerOn.ms;
			if (t >= 1) this.powerOn = null;
			else powerMask(c, t, dark, pal.p100);
		}
		if (this.powerOff) {
			const t = (Date.now() - this.powerOff.start) / this.powerOff.ms;
			powerOffMask(c, Math.min(1, t), dark, pal.p100);
			if (t >= 1) {
				const done = this.powerOff.done;
				this.powerOff = null;
				this.renderer.render(c, pal.caps.colorMode);
				done();
				return;
			}
		}
		if (pal.caps.tier === 3) drawMarker(c);
		this.renderer.render(c, pal.caps.colorMode);
	}

	// ── input ─────────────────────────────────────────────────────────────

	private onInput(data: string): void {
		if (this.exiting) return;
		if (isKeyRelease(data)) return;
		const ev = parseInput(data);
		if (ev.type === "mouse") {
			if (ev.action !== "down" && ev.action !== "wheel") return;
			const hit = this.canvas.hitAt(ev.x, ev.y);
			if (!hit) return;
			const info: MouseInfo = {
				x: ev.x - hit.x,
				y: ev.y - hit.y,
				button: ev.button,
				shift: ev.shift,
				ctrl: ev.ctrl,
				alt: ev.alt,
			};
			if (ev.action === "wheel") hit.onWheel?.(ev.wheel, info);
			else if (ev.button === 0) hit.onClick?.(info);
			this.requestRender();
			return;
		}
		if (ev.type === "paste") {
			const m = this.modals[this.modals.length - 1];
			if (m) m.paste?.(ev.text, this);
			else this.page.paste?.(ev.text, this);
			this.requestRender();
			return;
		}
		this.handleKey(ev.data);
		this.requestRender();
	}

	private handleKey(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.quit();
			return;
		}
		const m = this.modals[this.modals.length - 1];
		if (m) {
			m.key(data, this);
			return;
		}
		if (this.page.key(data, this)) return;
		if (matchesKey(data, "escape")) {
			if (this.stack.length) this.back();
			return;
		}
		if (this.page.captureText?.()) return;
		if (matchesKey(data, "tab")) {
			this.go(this.tabs[(this.tabIndex + 1) % this.tabs.length]!.id);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.go(this.tabs[(this.tabIndex + this.tabs.length - 1) % this.tabs.length]!.id);
			return;
		}
		const n = Number(data);
		if (data.length === 1 && n >= 1 && n <= this.tabs.length) {
			this.go(this.tabs[n - 1]!.id);
			return;
		}
		if (data === "q") this.quit();
	}
}

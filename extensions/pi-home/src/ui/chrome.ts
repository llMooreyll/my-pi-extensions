import { tildify } from "../paths.ts";
import { type Canvas, DIM, type Surface } from "../term/canvas.ts";
import { DEFAULT, hex } from "../term/color.ts";
import { strWidth } from "../term/width.ts";
import type { App } from "./app.ts";
import { fmtDuration } from "./format.ts";

/** Shader marker colours (VISUAL.md §6); must match shaders/crt.glsl. */
export const MARKER_A = hex("#0a0b0c");
export const MARKER_B = hex("#0c0b0a");
export const MARKER_X = 2;
export const MARKER_Y = 0;

const TAB_LABELS: Record<string, string> = { home: "HOME", sessions: "SESSIONS", analytics: "ANALYTICS", presets: "PRESETS" };

/** Paint the two marker cells last, after all post-processing, so their colours stay exact. */
export function drawMarker(c: Canvas): void {
	for (const [dx, col] of [
		[0, MARKER_A],
		[1, MARKER_B],
	] as const) {
		const x = MARKER_X + dx;
		if (x >= c.w || MARKER_Y >= c.h) return;
		const i = MARKER_Y * c.w + x;
		c.ch[i] = " ";
		c.fg[i] = col;
		c.bg[i] = col;
		c.at[i] = 0;
	}
}

/**
 * Draw bezel, screen frame, title bar, tab bar and status lines (VISUAL.md §3).
 * Returns the content surface pages draw into.
 */
export function drawChrome(c: Canvas, app: App): Surface {
	const pal = app.pal;
	const root = c.root();
	const compact = c.w < 60 || c.h < 20;
	const bezel = !compact && pal.caps.tier >= 1;

	let screen = root;
	if (bezel) {
		// Housing: outer ring darkest, inner ring lighter; rounded outer corners with quadrant blocks.
		root.fill(0, 0, c.w, c.h, { bg: pal.bezel[2] });
		root.fill(1, 0, c.w - 2, 1, { bg: pal.bezel[2] });
		root.fill(1, 1, c.w - 2, c.h - 2, { bg: pal.bezel[1] });
		root.put(0, 0, "▗", { fg: pal.bezel[2], bg: DEFAULT });
		root.put(c.w - 1, 0, "▖", { fg: pal.bezel[2], bg: DEFAULT });
		root.put(0, c.h - 1, "▝", { fg: pal.bezel[2], bg: DEFAULT });
		root.put(c.w - 1, c.h - 1, "▘", { fg: pal.bezel[2], bg: DEFAULT });
		// Highlight on the top edge of the housing.
		root.fill(4, 0, c.w - 8, 1, { fg: pal.bezel[0], bg: pal.bezel[2] }, "▁");
		screen = root.inset(2, 1, 2, 1);
		screen.fill(0, 0, screen.w, screen.h, { fg: pal.p100, bg: pal.screenBg });
	}

	const frameStyle = { fg: pal.p45, bg: pal.screenBg };
	screen.box(0, 0, screen.w, screen.h, frameStyle, pal.caps.unicode ? "double" : "ascii");
	const inner = screen.inset(1, 1, 1, 1);

	// Title bar.
	const cwd = tildify(process.cwd());
	inner.text(1, 0, "[>_ ", { fg: pal.p70 });
	const tx = inner.text(5, 0, "PI.HOME", { fg: pal.p100, attr: 1 });
	inner.text(tx, 0, ` // ${cwd}`, { fg: pal.p70 });
	const buttons = ["■", "O", "X"];
	let bx = inner.w - 1 - buttons.length * 3;
	for (const b of buttons) {
		inner.text(bx, 0, `[${b}]`, { fg: pal.p70 });
		const label = b;
		inner.hit(bx, 0, 3, 1, {
			onClick: () => {
				if (label === "X") app.quit();
				else if (label === "O") {
					app.config.visual.vignette = !app.config.visual.vignette;
					app.saveConfig();
				} else {
					app.config.visual.scanlines = !app.config.visual.scanlines;
					app.saveConfig();
				}
			},
		});
		bx += 3;
	}
	if (pal.caps.unicode) {
		screen.put(0, 2, "╟", frameStyle);
		screen.put(screen.w - 1, 2, "╢", frameStyle);
		inner.hline(0, 1, inner.w, frameStyle, "─");
	}

	// Tab bar (or breadcrumb when a sub-page is open).
	let x = 1;
	app.tabs.forEach((t, i) => {
		const active = i === app.tabIndex;
		const label = ` ${i + 1} ${TAB_LABELS[t.id] ?? t.id.toUpperCase()} `;
		const w = strWidth(label);
		if (active) inner.text(x, 2, label, pal.sel);
		else {
			inner.text(x, 2, ` ${i + 1}`, { fg: pal.p70 });
			inner.text(x + 2, 2, ` ${TAB_LABELS[t.id] ?? t.id} `, { fg: pal.p45 });
		}
		inner.hit(x, 2, w, 1, { onClick: () => app.go(t.id) });
		x += w + 2;
	});
	if (app.stack.length) {
		const crumb = app.stack.map((p) => p.title).join(" › ");
		inner.text(x + 1, 2, `› ${crumb}`, { fg: pal.p100, attr: 1 });
		inner.textIn(0, 2, inner.w - 1, "esc back", { fg: pal.p45 }, "right");
	}
	inner.hline(0, 3, inner.w, { fg: pal.p25 });

	// Status lines.
	const sy = inner.h - 2;
	const prog = app.index.progress;
	const idx = prog.finished ? `${app.index.records.size}` : `${prog.done}/${prog.total}`;
	const parts = [
		`UPTIME ${fmtDuration(Date.now() - app.startedAt)}`,
		`INDEX ${idx}${prog.finished ? "" : " ⟳"}`,
		`TIER T${pal.caps.tier}`,
		`THEME ${pal.theme.name}`,
	];
	inner.text(1, sy, parts.join("  │  "), { fg: pal.p45 });
	if (prog.error) inner.textIn(0, sy, inner.w - 1, prog.error, { fg: pal.err }, "right");

	const toast = app.toastMsg && app.toastMsg.until > Date.now() ? app.toastMsg : null;
	const promptY = inner.h - 1;
	let px = inner.text(0, promptY, ">> ", { fg: pal.p70, attr: 1 });
	if (toast) {
		px = inner.text(px, promptY, toast.text, { fg: toast.kind === "error" ? pal.err : pal.p100, attr: 1 });
	} else {
		const hint = app.page.hints?.(app) ?? "";
		px = inner.text(px, promptY, hint || "AWAITING_COMMAND...", { fg: pal.p70 });
	}
	if (app.blinkOn()) inner.text(px + 1, promptY, "█", { fg: pal.p100 });
	else inner.text(px + 1, promptY, "█", { fg: pal.screenBg, attr: DIM });

	return inner.sub(0, 4, inner.w, inner.h - 4 - 2);
}

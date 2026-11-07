import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Styled segments placed at the left and right ends of one border line. */
export interface BorderSegments {
	left: string;
	right: string;
}

export interface StatusBorderSource {
	top(width: number): BorderSegments;
	bottom(width: number): BorderSegments;
}

/**
 * Prompt editor whose top and bottom borders carry status segments. Overriding the
 * border renderers (instead of rewriting rendered lines) keeps autocomplete rows,
 * which Pi draws below the bottom border, untouched.
 */
export class StatusBorderEditor extends CustomEditor {
	private readonly source: StatusBorderSource;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, source: StatusBorderSource) {
		super(tui, theme, keybindings);
		this.source = source;
	}

	protected renderTopBorder(width: number, hiddenLineCount: number): string {
		const { left, right } = this.source.top(width);
		return fitBorder(left, withHiddenLines("↑", hiddenLineCount, right), width, (text) => this.borderColor(text));
	}

	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		const { left, right } = this.source.bottom(width);
		return fitBorder(left, withHiddenLines("↓", hiddenLineCount, right), width, (text) => this.borderColor(text));
	}
}

function withHiddenLines(arrow: string, hiddenLineCount: number, right: string): string {
	if (hiddenLineCount <= 0) return right;
	return `${right}${right ? "" : " "}${arrow} ${hiddenLineCount} more `;
}

/** `─left─────right─`, truncating the right side first, then the left. */
export function fitBorder(left: string, right: string, width: number, border: (text: string) => string): string {
	if (width <= 0) return "";
	if (width < 4) return border("─".repeat(width));

	const fixedWidth = 2;
	const minimumGap = 1;
	let leftText = left;
	let rightText = right;

	const overflow = () => fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap - width;
	if (overflow() > 0 && visibleWidth(rightText) > 0) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - overflow()), "");
	}
	if (overflow() > 0 && visibleWidth(leftText) > 0) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - overflow()), "…");
	}

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border("─")}${leftText}${border("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

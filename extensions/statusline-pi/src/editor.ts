import { type EditorComponent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Styled segments placed at the left and right ends of one border line. */
export interface BorderSegments {
	left: string;
	right: string;
}

export interface StatusBorderSource {
	top(width: number): BorderSegments;
	bottom(width: number): BorderSegments;
}

type BorderRenderer = (width: number, hiddenLineCount: number) => string;

const APPLIED = Symbol.for("statusline-pi.bordersApplied");

interface BorderHost {
	renderTopBorder?: BorderRenderer;
	renderBottomBorder?: BorderRenderer;
	borderColor?: (text: string) => string;
	[APPLIED]?: boolean;
}

/**
 * Puts status segments on the top and bottom borders of an existing prompt editor
 * instance. Overriding the border renderers on the instance (instead of subclassing
 * or replacing the editor) lets other extensions decorate the same editor, and leaves
 * the autocomplete rows Pi draws below the bottom border untouched. While `getSource`
 * returns undefined the editor's own borders are drawn.
 */
export function applyStatusBorders(editor: EditorComponent, getSource: () => StatusBorderSource | undefined): void {
	const host = editor as unknown as BorderHost;
	const renderTop = host.renderTopBorder;
	const renderBottom = host.renderBottomBorder;
	if (host[APPLIED] || typeof renderTop !== "function" || typeof renderBottom !== "function") return;
	host[APPLIED] = true;
	const ownTop = renderTop.bind(editor);
	const ownBottom = renderBottom.bind(editor);
	const border = (text: string): string => host.borderColor?.(text) ?? text;

	host.renderTopBorder = (width, hiddenLineCount) => {
		const source = getSource();
		if (!source) return ownTop(width, hiddenLineCount);
		const { left, right } = source.top(width);
		return fitBorder(left, withHiddenLines("↑", hiddenLineCount, right), width, border);
	};
	host.renderBottomBorder = (width, hiddenLineCount) => {
		const source = getSource();
		if (!source) return ownBottom(width, hiddenLineCount);
		const { left, right } = source.bottom(width);
		return fitBorder(left, withHiddenLines("↓", hiddenLineCount, right), width, border);
	};
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

import type { Style, Surface } from "../../term/canvas.ts";

import { type ChartCtx, ellipsis, cut } from "./common.ts";

export interface TreeNode {
	label: string;
	detail?: string;
	children: TreeNode[];
	style?: Style;
}

interface Line {
	prefix: string;
	node: TreeNode;
}

function flatten(node: TreeNode, ascii: boolean, prefix: string, out: Line[]): void {
	const [mid, last, bar] = ascii ? ["+- ", "`- ", "|  "] : ["├─ ", "└─ ", "│  "];
	node.children.forEach((c, i) => {
		const isLast = i === node.children.length - 1;
		out.push({ prefix: prefix + (isLast ? last : mid), node: c });
		flatten(c, ascii, prefix + (isLast ? "   " : bar), out);
	});
}

/**
 * Tree drawn with `├─ └─ │`: the root label on the first row, then every descendant, optional
 * dim `detail` after the label. `opts.scroll` is the index of the first visible row. Returns the
 * total number of rows (root included) whatever the surface size, so callers can scroll.
 * Minimum 4 columns x 1 row (else "…" is drawn).
 */
export function tree(s: Surface, root: TreeNode, ctx: ChartCtx, opts: { scroll?: number } = {}): number {
	const lines: Line[] = [{ prefix: "", node: root }];
	flatten(root, !ctx.pal.caps.unicode, "", lines);
	if (s.w < 4 || s.h < 1) {
		s.text(0, 0, ellipsis(ctx), ctx.pal.dim);
		return lines.length;
	}
	const pal = ctx.pal;
	const scroll = Math.max(0, Math.min(opts.scroll ?? 0, lines.length - 1));
	for (let y = 0; y < s.h; y++) {
		const line = lines[scroll + y];
		if (!line) break;
		s.text(0, y, cut(ctx, line.prefix, s.w), pal.faint);
		const x = line.prefix.length;
		const label = cut(ctx, line.node.label, s.w - x);
		const end = s.text(x, y, label, line.node.style ?? pal.text);
		if (line.node.detail && end + 2 < s.w) s.text(end + 2, y, cut(ctx, line.node.detail, s.w - end - 2), pal.dim);
	}
	return lines.length;
}

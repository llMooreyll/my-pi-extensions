// Dev tool: prints the compact branch tree of a session file.
// Usage: node scripts/tree-check.ts <session.jsonl>
import { compactTree, readSessionTree } from "../src/index/session-tree.ts";
import type { TreeNode } from "../src/ui/charts/tree.ts";

const file = process.argv[2];
if (!file) {
	console.error("usage: node scripts/tree-check.ts <session.jsonl>");
	process.exit(1);
}
const tree = await readSessionTree(file);
const root = compactTree(tree);
let nodes = 0;
const lines: string[] = [];
const walk = (n: TreeNode, depth: number): void => {
	nodes++;
	lines.push(`${"  ".repeat(depth)}${n.label}`);
	for (const c of n.children) walk(c, depth + 1);
};
walk(root, 0);
console.log(`entries ${tree.entries.size}, roots ${tree.roots.length}, leaf ${tree.leafId}, nodes ${nodes}`);
console.log(lines.join("\n"));

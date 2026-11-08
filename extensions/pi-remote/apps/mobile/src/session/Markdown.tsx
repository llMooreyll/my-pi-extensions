import MarkdownIt from "markdown-it";
import * as Clipboard from "expo-clipboard";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, Text, View, type TextStyle } from "react-native";
import { hasCJK } from "../ds/cjk";
import { F, usePalette, type Palette } from "../ds/tokens";
import { latexToUnicode } from "../lib/latex";

/** Copies a block's whole source; says "copied" for a moment. */
function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const p = usePalette();
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1500); return () => clearTimeout(t); }, [done]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="md-copy" hitSlop={8} onPress={() => { void Clipboard.setStringAsync(text); setDone(true); }}
      style={({ pressed }) => ({ paddingHorizontal: 10, paddingVertical: 5, opacity: pressed ? 0.5 : 1 })}>
      <Text style={{ fontFamily: F.monoBold, fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: done ? p.ok : p.ink }}>{done ? "✓ copied" : label}</Text>
    </Pressable>
  );
}

/* ───────────── parser: CommonMark + tables + strikethrough + $math$ ───────────── */

function mathInline(state: any, silent: boolean): boolean {
  const src: string = state.src;
  const start: number = state.pos;
  let open = "", close = "";
  if (src.startsWith("$$", start)) { open = "$$"; close = "$$"; }
  else if (src[start] === "$") { open = "$"; close = "$"; }
  else if (src.startsWith("\\(", start)) { open = "\\("; close = "\\)"; }
  else if (src.startsWith("\\[", start)) { open = "\\["; close = "\\]"; }
  else return false;
  const from = start + open.length;
  let end = from;
  for (;;) {
    end = src.indexOf(close, end);
    if (end < 0) return false;
    if (src[end - 1] === "\\" && close === "$") { end += 1; continue; }
    break;
  }
  const body = src.slice(from, end);
  if (!body.trim()) return false;
  // Pandoc rules for single dollars, so "$5 and $10" stays text.
  if (open === "$" && (/^\s/.test(body) || /\s$/.test(body) || /\d/.test(src[end + 1] ?? ""))) return false;
  if (!silent) {
    const t = state.push("math_inline", "math", 0);
    t.content = body;
    t.markup = open;
  }
  state.pos = end + close.length;
  return true;
}

function mathBlock(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const first = state.src.slice(pos, max);
  const open = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : "";
  if (!open) return false;
  const close = open === "$$" ? "$$" : "\\]";
  if (silent) return true;
  let content = first.slice(open.length);
  let line = startLine;
  let found = content.trimEnd().endsWith(close);
  if (found) content = content.trimEnd().slice(0, -close.length);
  while (!found && ++line < endLine) {
    const l = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    if (l.trimEnd().endsWith(close)) { content += "\n" + l.trimEnd().slice(0, -close.length); found = true; break; }
    content += "\n" + l;
  }
  if (!found) return false;
  state.line = line + 1;
  const t = state.push("math_block", "math", 0);
  t.block = true;
  t.content = content;
  t.map = [startLine, state.line];
  return true;
}

const md = MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });
md.inline.ruler.before("escape", "math_inline", mathInline);
md.block.ruler.before("fence", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });

/* ───────────── tree ───────────── */

interface Node { type: string; tag: string; content: string; info: string; markup: string; attrs: [string, string][] | null; children: Node[]; inline?: any[]; start?: number }

function toTree(tokens: any[]): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  for (const t of tokens) {
    const top = stack[stack.length - 1]!;
    if (t.nesting === 1) {
      const n: Node = { type: t.type.replace(/_open$/, ""), tag: t.tag, content: "", info: t.info, markup: t.markup, attrs: t.attrs, children: [] };
      if (t.type === "ordered_list_open") n.start = Number(t.attrGet?.("start") ?? 1) || 1;
      top.push(n);
      stack.push(n.children);
    } else if (t.nesting === -1) {
      stack.pop();
    } else {
      top.push({ type: t.type, tag: t.tag, content: t.content, info: t.info, markup: t.markup, attrs: t.attrs, children: [], inline: t.children ?? undefined });
    }
  }
  return root;
}

/* ───────────── rendering ───────────── */

interface Ctx { p: Palette; base: TextStyle; key: { n: number }; quote?: boolean }

const inlineText = (tokens: any[] | undefined) => (tokens ?? []).map((t) => t.content ?? "").join("");

/** Body style for one paragraph: Chinese gets Hei with generous leading; quotes get Song. */
function paraStyle(c: Ctx, tokens: any[] | undefined): TextStyle {
  if (!hasCJK(inlineText(tokens))) return c.base;
  return { ...c.base, fontFamily: c.quote ? F.cjkSerif : F.cjkSans, fontSize: 15.5, lineHeight: 27, letterSpacing: 0.2 };
}
const k = (c: Ctx) => `m${c.key.n++}`;

function inline(tokens: any[] | undefined, c: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  if (!tokens) return out;
  const cjk = hasCJK(inlineText(tokens));
  const stack: { style: TextStyle; href?: string; items: ReactNode[] }[] = [{ style: {}, items: out }];
  const push = (n: ReactNode) => stack[stack.length - 1]!.items.push(n);
  const open = (style: TextStyle, href?: string) => stack.push({ style, href, items: [] });
  const close = () => {
    const f = stack.pop()!;
    const href = f.href;
    push(<Text key={k(c)} style={f.style} onPress={href ? () => void Linking.openURL(href) : undefined}>{f.items}</Text>);
  };
  for (const t of tokens) {
    switch (t.type) {
      case "text": push(t.content); break;
      case "softbreak": push(" "); break;
      case "hardbreak": push("\n"); break;
      // Chinese has no italics: emphasis switches to Song, strong to bold Hei.
      case "strong_open": open({ fontFamily: cjk ? F.cjkSansBold : F.sansBold }); break;
      case "em_open": open(cjk ? { fontFamily: F.cjkSerif } : { fontFamily: F.serifItalic, fontSize: (c.base.fontSize ?? 15.5) + 2.5 }); break;
      case "s_open": open({ textDecorationLine: "line-through" }); break;
      case "link_open": open({ color: c.p.blue, textDecorationLine: "underline" }, t.attrGet?.("href") ?? undefined); break;
      case "strong_close": case "em_close": case "s_close": case "link_close": if (stack.length > 1) close(); break;
      case "code_inline": push(<Text key={k(c)} style={{ fontFamily: F.mono, fontSize: (c.base.fontSize ?? 15.5) - 2.5, backgroundColor: c.p.tint }}>{` ${t.content} `}</Text>); break;
      case "math_inline": push(<Text key={k(c)} style={{ fontFamily: F.serifItalic, fontSize: (c.base.fontSize ?? 15.5) + 2 }}>{latexToUnicode(t.content)}</Text>); break;
      case "image": push(<Text key={k(c)} style={{ color: c.p.soft }}>[image: {t.content || t.attrGet?.("src")}]</Text>); break;
      case "html_inline": push(t.content); break;
      default: if (t.content) push(t.content);
    }
  }
  while (stack.length > 1) close();
  return out;
}

const CJK_HEADINGS: Record<string, TextStyle> = {
  h1: { fontFamily: F.cjkSerifBold, fontSize: 23, lineHeight: 34 },
  h2: { fontFamily: F.cjkSerifBold, fontSize: 19.5, lineHeight: 30 },
  h3: { fontFamily: F.cjkSansBold, fontSize: 16.5, lineHeight: 27 },
  h4: { fontFamily: F.cjkSansMed, fontSize: 14, lineHeight: 23 },
  h5: { fontFamily: F.cjkSansMed, fontSize: 13.5, lineHeight: 22 },
  h6: { fontFamily: F.cjkSans, fontSize: 13.5, lineHeight: 22 },
};

const HEADINGS: Record<string, TextStyle> = {
  h1: { fontFamily: F.serif, fontSize: 29, lineHeight: 33, letterSpacing: -0.4 },
  h2: { fontFamily: F.serif, fontSize: 24, lineHeight: 28 },
  h3: { fontFamily: F.serifItalic, fontSize: 20.5, lineHeight: 25 },
  h4: { fontFamily: F.monoBold, fontSize: 11, lineHeight: 15, letterSpacing: 1.4, textTransform: "uppercase" },
  h5: { fontFamily: F.monoBold, fontSize: 11, lineHeight: 15, letterSpacing: 1.4, textTransform: "uppercase" },
  h6: { fontFamily: F.mono, fontSize: 11, lineHeight: 15, letterSpacing: 1.4, textTransform: "uppercase" },
};

function blocks(nodes: Node[], c: Ctx, depth = 0, tight = false): ReactNode[] {
  return nodes.map((n, i) => {
    const last = i === nodes.length - 1;
    const gap = last ? 0 : tight ? 4 : 11;
    switch (n.type) {
      case "paragraph": {
        const inl = n.children[0]?.inline;
        return <Text selectable key={k(c)} style={[paraStyle(c, inl), { marginBottom: gap }]}>{inline(inl, c)}</Text>;
      }
      case "inline": return <Text selectable key={k(c)} style={paraStyle(c, n.inline)}>{inline(n.inline, c)}</Text>;
      case "heading": {
        const inl = n.children[0]?.inline;
        const table = hasCJK(inlineText(inl)) ? CJK_HEADINGS : HEADINGS;
        const hs = table[n.tag] ?? table.h3;
        return <Text selectable key={k(c)} style={[c.base, hs, n.tag >= "h4" ? { color: c.p.soft } : null, { marginTop: i === 0 ? 0 : 14, marginBottom: last ? 0 : 6 }]}>{inline(inl, c)}</Text>;
      }
      case "bullet_list":
      case "ordered_list": {
        const ordered = n.type === "ordered_list";
        const width = ordered ? 26 : 16;
        return (
          <View key={k(c)} style={{ marginBottom: gap }}>
            {n.children.map((item, j) => (
              <View key={k(c)} style={{ flexDirection: "row", alignItems: "baseline", marginBottom: j === n.children.length - 1 ? 0 : 6 }}>
                <Text style={[c.base, { width, fontFamily: F.mono, fontSize: 12, color: c.p.soft }]}>{ordered ? `${(n.start ?? 1) + j}.` : depth % 2 ? "◦" : "–"}</Text>
                <View style={{ flex: 1 }}>{blocks(item.children, c, depth + 1, true)}</View>
              </View>
            ))}
          </View>
        );
      }
      case "blockquote":
        return (
          <View key={k(c)} style={{ borderLeftWidth: 1, borderLeftColor: c.p.soft, paddingLeft: 12, marginBottom: gap }}>
            {blocks(n.children, { ...c, quote: true, base: { ...c.base, color: c.p.soft } }, depth, tight)}
          </View>
        );
      case "fence":
      case "code_block": {
        const code = n.content.replace(/\n$/, "");
        return (
          <View key={k(c)} style={{ marginBottom: gap, backgroundColor: c.p.tint }}>
            <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 10, paddingTop: 4 }}>
              <Text style={{ flex: 1, fontFamily: F.mono, fontSize: 10, letterSpacing: 1.2, color: c.p.soft, textTransform: "uppercase" }}>{n.info ? n.info.split(/\s/)[0] : "code"}</Text>
              <CopyButton text={code} />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text selectable style={{ fontFamily: F.mono, fontSize: 12, lineHeight: 18, color: c.p.ink, padding: 10, paddingTop: 2 }}>{code}</Text>
            </ScrollView>
          </View>
        );
      }
      case "math_block":
        return (
          <View key={k(c)} style={{ marginBottom: gap }}>
          <View style={{ alignItems: "flex-end" }}><CopyButton text={n.content.trim()} label="copy tex" /></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingVertical: 6 }}>
            <Text selectable style={{ fontFamily: F.serifItalic, fontSize: 21, lineHeight: 28, color: c.p.ink, textAlign: "center" }}>{latexToUnicode(n.content)}</Text>
          </ScrollView>
          </View>
        );
      case "hr": return <View key={k(c)} style={{ height: 1, backgroundColor: c.p.faint, marginVertical: 12 }} />;
      case "table": return <Table key={k(c)} node={n} c={c} gap={gap} />;
      case "html_block": return <Text selectable key={k(c)} style={[c.base, { fontFamily: F.mono, fontSize: 12, marginBottom: gap }]}>{n.content}</Text>;
      default: return n.children.length ? <View key={k(c)}>{blocks(n.children, c, depth, tight)}</View> : null;
    }
  });
}

function Table({ node, c, gap }: { node: Node; c: Ctx; gap: number }) {
  const rows: { head: boolean; cells: Node[] }[] = [];
  for (const section of node.children) for (const tr of section.children) rows.push({ head: section.type === "thead", cells: tr.children });
  // Tab-separated, so it pastes into a spreadsheet as cells.
  const tsv = rows.map((r) => r.cells.map((cell) => inlineText(cell.children[0]?.inline).replace(/\s+/g, " ")).join("\t")).join("\n");
  return (
    <View style={{ marginBottom: gap }}>
    <View style={{ alignItems: "flex-end" }}><CopyButton text={tsv} label="copy table" /></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ borderTopWidth: 1, borderTopColor: c.p.ink }}>
        {rows.map((r, i) => (
          <View key={i} style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: r.head ? c.p.ink : c.p.faint }}>
            {r.cells.map((cell, j) => (
              <Text selectable key={j} style={[paraStyle(c, cell.children[0]?.inline), { width: 150, paddingVertical: 7, paddingRight: 12 }, r.head ? { fontFamily: hasCJK(inlineText(cell.children[0]?.inline)) ? F.cjkSansMed : F.mono, fontSize: 11, letterSpacing: 0.8, color: c.p.soft } : { fontSize: 14, lineHeight: 21 }]}>
                {inline(cell.children[0]?.inline, c)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
    </View>
  );
}

function MarkdownInner({ text, color }: { text: string; color?: string }) {
  const p = usePalette();
  const tree = useMemo(() => { try { return toTree(md.parse(text, {})); } catch { return null; } }, [text]);
  const c: Ctx = { p, key: { n: 0 }, base: { fontFamily: F.sans, fontSize: 15.5, lineHeight: 23, color: color ?? p.ink } };
  if (!tree) return <Text selectable style={c.base}>{text}</Text>;
  return <View>{blocks(tree, c)}</View>;
}

export const Markdown = memo(MarkdownInner);

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, ScrollView, View, type ScrollViewInstance, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { Button, Txt } from "../ds/primitives";
import { F, GUTTER, MARGIN, usePalette } from "../ds/tokens";
import { stripAnsi, textOf } from "../lib/format";
import { useTestAction } from "../lib/test-hooks";
import type { AssistantDraft, Block as ContentBlock, Queued } from "../state/types";
import { CustomCard } from "./CustomCard";
import { AnchorContext, type Anchor, FoldBar, useAnchor } from "./anchor";
import { Markdown } from "./Markdown";
import { SelectContext, SelectSheet, useSelectText } from "./SelectSheet";
import { ToolCard } from "./ToolCard";

type Item = (
  | { key: string; kind: "msg"; m: WireMessage; idx: number }
  | { key: string; kind: "draft"; d: AssistantDraft }
  | { key: string; kind: "tool"; id: string; name: string; args: unknown; partialText: string }
  | { key: string; kind: "queued"; q: Queued }
) & { label?: boolean; ctx: Ctx };

/** Who "speaks" an item; the margin label is printed only when the speaker changes. */
function speaker(i: Item): string {
  if (i.kind === "queued") return "you";
  if (i.kind !== "msg") return "pi";
  switch (i.m.role) {
    case "user": return "you";
    case "assistant": case "toolResult": return "pi";
    case "custom": return "§";
    case "bashExecution": return "$";
    default: return "—";
  }
}

interface Ctx { results: Map<string, WireMessage>; running: Record<string, { toolName: string; args: unknown; partialText: string }>; hideThinking: boolean }
const NO_CTX: Ctx = { results: new Map(), running: {}, hideThinking: false };
const EMPTY_RUNS: Record<string, { toolName: string; args: unknown; partialText: string }> = {};

/**
 * Every entry hangs a small label in the margin column: YOU, PI, §. With `select`, the whole margin column is
 * a button that opens the message as one selectable text (see SelectSheet); a pilcrow marks it.
 */
function Margin({ label, color, children, a11y, select }: { label: string; color?: string; children: ReactNode; a11y?: string; select?: string }) {
  const p = usePalette();
  const open = useSelectText();
  const onSelect = select ? () => open(select) : undefined;
  useTestAction(a11y ? `${a11y}-select` : undefined, onSelect);
  return (
    <View accessibilityLabel={a11y} style={{ flexDirection: "row", alignItems: "stretch", paddingVertical: 6 }}>
      <Pressable accessibilityRole={select ? "button" : undefined} accessibilityLabel={a11y ? `${a11y}-select` : undefined} disabled={!select} onPress={onSelect}
        style={({ pressed }) => ({ width: GUTTER, backgroundColor: pressed ? p.tint : "transparent" })}>
        <Txt v="label" color={color} soft={!color} style={{ paddingTop: 5 }}>{label}</Txt>
        {select ? <Txt v="mono" faint style={{ fontSize: 12, marginTop: label ? 2 : 4 }}>¶</Txt> : null}
      </Pressable>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

/** The text of a message as written, for the select sheet. */
function messageText(m: WireMessage & Record<string, any>): string {
  switch (m.role) {
    case "user": return typeof m.content === "string" ? m.content : textOf(m.content);
    case "assistant": return Array.isArray(m.content)
      ? (m.content as ContentBlock[]).filter((b) => b.type === "text").map((b) => stripAnsi(String((b as { text: string }).text ?? ""))).join("\n\n")
      : String(m.content ?? "");
    case "bashExecution": return `$ ${String(m.command ?? "")}\n${String(m.output ?? "")}`;
    case "custom": return typeof m.content === "string" ? m.content : textOf(m.content);
    default: return "";
  }
}

function Thinking({ text, hidden, a11y }: { text: string; hidden: boolean; a11y: string }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const anchor = useAnchor();
  const toggle = () => { anchor("top"); setOpen((o) => !o); };
  useTestAction(a11y, hidden ? undefined : toggle);
  if (hidden) return <Txt v="label" faint style={{ marginVertical: 4 }}>thinking hidden</Txt>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={toggle} style={{ marginVertical: 4 }}>
      <Txt v="small" soft lines={open ? undefined : 2} style={{ fontFamily: F.serifItalic, fontSize: 16, lineHeight: 21, color: p.soft }} cjk={{ fontFamily: F.cjkSerif, fontSize: 14, lineHeight: 24 }}>
        {open ? "" : "thinking — "}{text.trim()}
      </Txt>
      {open ? <FoldBar a11y={`${a11y}-fold`} onFold={() => setOpen(false)} label="fold thinking" /> : null}
    </Pressable>
  );
}

function Blocks({ blocks, ctx, prefix, streaming }: { blocks: ContentBlock[]; ctx: Ctx; prefix: string; streaming?: boolean }) {
  return (
    <>
      {blocks.map((b, i) => {
        const key = `${prefix}-${i}`;
        if (b.type === "text") { const t = (b as { text: string }).text; return t ? <Markdown key={key} text={stripAnsi(t)} /> : null; }
        if (b.type === "thinking") return <Thinking key={key} a11y={`thinking-${key}`} text={stripAnsi(String((b as { thinking: string }).thinking ?? ""))} hidden={ctx.hideThinking} />;
        if (b.type === "toolCall") {
          const tc = b as { id: string; name: string; arguments: Record<string, unknown> };
          const result = ctx.results.get(tc.id);
          const run = ctx.running[tc.id];
          return <ToolCard key={key} id={tc.id} name={tc.name} args={tc.arguments} result={result} running={run} pending={streaming && !result && !run} />;
        }
        return null;
      })}
    </>
  );
}

function Divider({ label, text, a11y }: { label: string; text: string; a11y: string }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const anchor = useAnchor();
  const toggle = () => { anchor("top"); setOpen((o) => !o); };
  useTestAction(a11y, toggle);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={toggle} style={{ marginVertical: 16, gap: 8 }}>
      <View style={{ height: 1, backgroundColor: p.ink }} />
      <Txt v="label" center>{label} {open ? "−" : "+"}</Txt>
      <View style={{ height: 1, backgroundColor: p.ink }} />
      {open ? <Markdown text={text} /> : null}
      {open ? <FoldBar a11y={`${a11y}-fold`} onFold={() => setOpen(false)} /> : null}
    </Pressable>
  );
}

const Row = memo(function Row({ item }: { item: Item }) {
  const ctx = item.ctx;
  const p = usePalette();
  const lab = (s: string) => (item.label ? s : "");
  if (item.kind === "draft") return <Margin label={lab("pi")} color={p.blue} a11y="msg-inflight"><Blocks blocks={item.d.content} ctx={ctx} prefix="draft" streaming /></Margin>;
  if (item.kind === "queued") {
    const q = item.q;
    return (
      <View accessibilityLabel="msg-queued" style={{ marginTop: 14, opacity: 0.78 }}>
        <View style={{ height: 1, backgroundColor: p.faint, marginBottom: 2 }} />
        <Margin label="you" color={p.pink}>
          <Txt v={q.text.length > 280 ? "body" : "em"} selectable style={q.text.length > 280 ? undefined : { fontSize: 22, lineHeight: 27 }} color={p.soft}>{q.text}</Txt>
          {q.images ? <Txt v="label" color={p.pink} style={{ marginTop: 4 }}>+ {q.images} image{q.images > 1 ? "s" : ""}</Txt> : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
            <View style={{ borderWidth: 1, borderColor: q.mode === "steer" ? p.blue : p.soft, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Txt v="label" color={q.mode === "steer" ? p.blue : p.soft} style={{ fontFamily: F.monoBold, fontSize: 9.5 }}>{q.mode === "steer" ? "queued · steer" : "queued · after run"}</Txt>
            </View>
            <Txt v="small" soft lines={1} style={{ flex: 1, fontSize: 12 }}>{q.mode === "steer" ? "pi reads it at its next break" : "pi reads it when this run ends"}</Txt>
          </View>
        </Margin>
      </View>
    );
  }
  if (item.kind === "tool") return <Margin label=""><ToolCard id={item.id} name={item.name} args={item.args} running={{ partialText: item.partialText }} /></Margin>;
  const m = item.m as WireMessage & Record<string, any>;
  const a11y = `msg-${item.idx}`;
  switch (m.role) {
    case "user": {
      const c = m.content;
      const text = typeof c === "string" ? c : textOf(c);
      const images = Array.isArray(c) ? c.filter((x: any) => x?.type === "image").length : 0;
      const long = text.length > 280;
      return (
        <View style={{ marginTop: 14 }}>
          <View style={{ height: 1, backgroundColor: p.faint, marginBottom: 2 }} />
          <Margin label="you" color={p.pink} a11y={a11y} select={text || undefined}>
            <Txt v={long ? "body" : "em"} selectable style={long ? undefined : { fontSize: 22, lineHeight: 27 }}>{text}</Txt>
            {images ? <Txt v="label" color={p.pink} style={{ marginTop: 4 }}>+ {images} image{images > 1 ? "s" : ""}</Txt> : null}
          </Margin>
        </View>
      );
    }
    case "assistant": {
      const blocks = Array.isArray(m.content) ? (m.content as ContentBlock[]) : [{ type: "text", text: String(m.content ?? "") }];
      return (
        <Margin label={lab("pi")} a11y={a11y} select={messageText(m).trim() || undefined}>
          <Blocks blocks={blocks} ctx={ctx} prefix={a11y} />
          {m.stopReason === "error" && m.errorMessage ? <Txt v="mono" color={p.danger} style={{ marginTop: 4 }}>✕ {String(m.errorMessage)}</Txt> : null}
          {m.stopReason === "aborted" ? <Txt v="label" soft>— stopped</Txt> : null}
        </Margin>
      );
    }
    case "toolResult": return <Margin label=""><ToolCard id={String(m.toolCallId ?? item.key)} name={String(m.toolName ?? "tool")} args={{}} result={m} /></Margin>;
    case "bashExecution":
      return (
        <Margin label={lab("$")} a11y={a11y} select={messageText(m)}>
          <Txt v="mono" style={{ fontFamily: F.monoBold }}>{String(m.command ?? "")}</Txt>
          <Txt v="mono" soft selectable style={{ fontSize: 11 }}>{String(m.output ?? "").split("\n").slice(-200).join("\n")}</Txt>
        </Margin>
      );
    case "custom": return <Margin label={lab("§")} a11y={a11y} select={messageText(m).trim() || undefined}><CustomCard m={m} idx={item.idx} /></Margin>;
    case "compactionSummary": return <Divider label="context compacted" text={String(m.summary ?? "")} a11y={a11y} />;
    case "branchSummary": return <Divider label="summary of the abandoned branch" text={String(m.summary ?? "")} a11y={a11y} />;
    default: return null;
  }
});

/** Imperative handle: scroll to a message by entry id (used by the outline). */
export interface TranscriptHandle { jumpTo: (entryId: string) => boolean }

/** Within this distance of the end the list follows new output; further up it holds still. */
const FOLLOW_SLACK = 24;
/** Rows rendered at first, and added each time the reader reaches the top. */
const WINDOW = 40;

/** Measures a row and, for a fold asking to keep its bottom edge, scrolls by the change. */
function Measured({ id, rows, children }: { id: string; rows: RowGeometry; children: ReactNode }) {
  const request = useCallback((a: Anchor) => {
    // Opening or folding is the reader's own doing: neither "new output" nor a reason to follow the end.
    rows.hold();
    if (a === "bottom") rows.pending.add(id);
  }, [id, rows]);
  const onLayout = (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    const prev = rows.heights.get(id);
    rows.heights.set(id, height);
    rows.tops.set(id, y);
    if (prev !== undefined && rows.pending.delete(id) && height !== prev) rows.scrollBy(height - prev);
  };
  return <AnchorContext.Provider value={request}><View onLayout={onLayout}>{children}</View></AnchorContext.Provider>;
}

interface RowGeometry {
  heights: Map<string, number>; tops: Map<string, number>; pending: Set<string>;
  scrollBy: (d: number) => void;
  /** Ignore the size change the reader is about to cause (see Measured). */
  hold: () => void;
  held: { current: boolean };
}

type Run = { toolName: string; args: unknown; partialText: string };

/** Tool call ids a message or draft refers to. */
function callIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).filter((b) => b?.type === "toolCall").map((b) => String((b as { id: string }).id));
}

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The conversation, read top to bottom like a page.
 *
 * A plain (not inverted) scroll view: an inverted list flips its content, which on Android breaks text
 * selection and makes a tap on selectable text scroll the list. Reading top to bottom also gives the wanted
 * behaviour for free: a row that opens or grows pushes only what is below it, so the text being read stays
 * put while the answer streams in further down. At the end, the view follows new output.
 *
 * Only the last rows are rendered at first; reaching the top adds more, and maintainVisibleContentPosition
 * keeps the view still while they appear above. Every row keeps the same item object (and so skips
 * re-rendering) until something it shows has changed.
 */
export const Transcript = forwardRef<TranscriptHandle, {
  messages: WireMessage[]; inflight?: AssistantDraft; queued?: Queued[]; running?: Record<string, Run>;
  hasMoreBefore: boolean; onLoadMore?: () => Promise<void>; hideThinking?: boolean; header?: ReactElement | null;
}>(function Transcript(props, ref) {
  const p = usePalette();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const running = props.running ?? EMPTY_RUNS;
  const hideThinking = !!props.hideThinking;
  const cache = useRef(new Map<string, { deps: unknown[]; item: Item }>());

  const items = useMemo(() => {
    const results = new Map<string, WireMessage>();
    const calls = new Set<string>();
    for (const m of props.messages) {
      if (m.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
      if (m.role === "assistant") for (const id of callIds(m.content)) calls.add(id);
    }
    if (props.inflight) for (const id of callIds(props.inflight.content)) calls.add(id);
    type Raw = { key: string; build: (label: boolean) => Item; deps: unknown[]; speaker: string };
    const raw: Raw[] = [];
    const ctxFor = (ids: string[]): Ctx => {
      const r = new Map<string, WireMessage>(); const run: Record<string, Run> = {};
      for (const id of ids) { const x = results.get(id); if (x) r.set(id, x); if (running[id]) run[id] = running[id]!; }
      return { results: r, running: run, hideThinking };
    };
    const subDeps = (ids: string[]) => ids.flatMap((id) => [results.get(id), running[id]]);
    props.messages.forEach((m, idx) => {
      if (m.role === "toolResult" && typeof m.toolCallId === "string" && calls.has(m.toolCallId)) return;
      const key = m.entryId ? `e${m.entryId}` : `i${idx}`;
      const ids = m.role === "assistant" ? callIds(m.content) : [];
      const it = { key, kind: "msg" as const, m, idx };
      raw.push({ key, deps: [m, idx, hideThinking, ...subDeps(ids)], speaker: speaker(it as Item), build: (label) => ({ ...it, label, ctx: ctxFor(ids) }) });
    });
    if (props.inflight) {
      const d = props.inflight; const ids = callIds(d.content);
      raw.push({ key: "inflight", deps: [d, hideThinking, ...subDeps(ids)], speaker: "pi", build: (label) => ({ key: "inflight", kind: "draft", d, label, ctx: ctxFor(ids) }) });
    }
    for (const [id, t] of Object.entries(running)) if (!calls.has(id)) {
      raw.push({ key: `run-${id}`, deps: [t], speaker: "pi", build: (label) => ({ key: `run-${id}`, kind: "tool", id, name: t.toolName, args: t.args, partialText: t.partialText, label, ctx: NO_CTX }) });
    }
    // Queued messages are not in the conversation yet, so they close the list.
    for (const q of props.queued ?? []) raw.push({ key: q.id, deps: [q], speaker: "you", build: (label) => ({ key: q.id, kind: "queued", q, label, ctx: NO_CTX }) });

    const next = new Map<string, { deps: unknown[]; item: Item }>();
    let prev = "";
    const out = raw.map((r) => {
      const label = r.speaker !== prev; prev = r.speaker;
      const deps = [...r.deps, label];
      const hit = cache.current.get(r.key);
      const item = hit && sameDeps(hit.deps, deps) ? hit.item : r.build(label);
      next.set(r.key, { deps, item });
      return item;
    });
    cache.current = next;
    return out;
  }, [props.messages, props.inflight, props.queued, running, hideThinking]);

  // Render from `firstKey` on. Rows added before it (earlier history) wait until the reader scrolls up.
  const [firstKey, setFirstKey] = useState<string | undefined>();
  const firstIndex = useMemo(() => {
    const i = firstKey ? items.findIndex((it) => it.key === firstKey) : -1;
    return i >= 0 ? i : Math.max(0, items.length - WINDOW);
  }, [items, firstKey]);
  useEffect(() => { if (items.length && (!firstKey || !items.some((it) => it.key === firstKey))) setFirstKey(items[Math.max(0, items.length - WINDOW)]!.key); }, [items, firstKey]);
  const shown = items.slice(firstIndex);
  const more = firstIndex > 0;
  const extendUp = () => { if (firstIndex > 0) setFirstKey(items[Math.max(0, firstIndex - WINDOW)]!.key); };

  const offset = useRef(0);
  const viewH = useRef(0);
  const contentH = useRef(0);
  const following = useRef(true);
  const [ready, setReady] = useState(false);
  const [away, setAway] = useState(false);
  const [newBelow, setNewBelow] = useState(false);
  const heldTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rows = useMemo<RowGeometry>(() => {
    const held = { current: false };
    return {
      heights: new Map(), tops: new Map(), pending: new Set(), held,
      scrollBy: (d) => { const y = Math.max(0, offset.current + d); offset.current = y; scrollRef.current?.scrollTo({ y, animated: false }); },
      hold: () => {
        held.current = true;
        clearTimeout(heldTimer.current);
        heldTimer.current = setTimeout(() => { held.current = false; }, 400);
      },
    };
  }, []);

  const toEnd = (animated: boolean) => scrollRef.current?.scrollToEnd({ animated });
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    offset.current = contentOffset.y;
    if (rows.held.current) return;
    const gap = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    // While the "latest" scroll animates, the view is on its way to the end: keep following.
    if (jumping.current) { if (gap > FOLLOW_SLACK) return; jumping.current = false; }
    following.current = gap <= FOLLOW_SLACK;
    setAway(!following.current);
    if (following.current) setNewBelow(false);
    // Near the top: show the next slice of rows already on the phone.
    if (contentOffset.y < 400 && more) extendUp();
  }, [more, items, firstIndex]);
  // After "read earlier messages" the reader is at the top already: show what arrived without a scroll.
  useEffect(() => { if (more && ready && !following.current && offset.current < 400) extendUp(); }, [more, firstIndex]);
  const onContentSizeChange = (_w: number, h: number) => {
    const grew = h > contentH.current;
    contentH.current = h;
    if (rows.held.current) return;
    if (following.current) { toEnd(false); if (!ready) requestAnimationFrame(() => setReady(true)); }
    else if (grew && ready) setNewBelow(true);
  };
  const jumping = useRef(false);
  const jump = () => { jumping.current = true; following.current = true; toEnd(true); setAway(false); setNewBelow(false); };

  useImperativeHandle(ref, () => ({
    jumpTo: (entryId: string) => {
      const index = items.findIndex((it) => it.kind === "msg" && it.m.entryId === entryId);
      if (index < 0) return false;
      const key = items[index]!.key;
      const go = () => {
        const y = rows.tops.get(key);
        if (y === undefined) return;
        following.current = false;
        scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
      };
      if (index < firstIndex) { setFirstKey(key); setTimeout(go, 250); } else go();
      return true;
    },
  }), [items, firstIndex]);

  const [selectText, setSelectText] = useState<string | undefined>();
  return (
    <SelectContext.Provider value={setSelectText}>
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={scrollRef}
        accessibilityLabel="transcript"
        style={{ opacity: ready || !items.length ? 1 : 0 }}
        contentContainerStyle={{ paddingHorizontal: MARGIN, paddingTop: 10, paddingBottom: 18 }}
        onLayout={(e) => { viewH.current = e.nativeEvent.layout.height; if (following.current) toEnd(false); }}
        onContentSizeChange={onContentSizeChange}
        onScroll={onScroll}
        onScrollBeginDrag={() => { jumping.current = false; }}
        scrollEventThrottle={32}
        keyboardShouldPersistTaps="handled"
        // Keeps the rows on screen still when earlier rows are added above them.
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
      >
        <View style={{ paddingBottom: 10, alignItems: "center", gap: 10 }}>
          {props.header}
          {more ? <Txt v="label" faint>scroll up for earlier messages</Txt>
            : props.hasMoreBefore && props.onLoadMore ? (
              <Button a11y="transcript-load-more" label={loadingMore ? "loading…" : "read earlier messages"} disabled={loadingMore}
                onPress={async () => { setLoadingMore(true); following.current = false; try { await props.onLoadMore?.(); } finally { setLoadingMore(false); } }} />
            ) : items.length ? <Txt v="label" faint>— beginning of the session —</Txt> : null}
        </View>
        {shown.map((it) => <Measured key={it.key} id={it.key} rows={rows}><Row item={it} /></Measured>)}
        {!items.length ? <Txt v="em" soft center style={{ marginTop: 60 }}>Nothing said yet.</Txt> : null}
      </ScrollView>
      {away ? (
        // Centred, clear of the stop control at the right of the run bar below.
        <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 12, alignItems: "center" }}>
          <Pressable accessibilityRole="button" accessibilityLabel="transcript-jump-latest" onPress={jump}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 9, backgroundColor: newBelow ? p.blue : p.ink, opacity: pressed ? 0.85 : 1 })}>
            <Txt v="label" color={p.invert} style={{ fontFamily: F.monoBold, fontSize: 12 }}>↓  {newBelow ? "new output" : "latest"}</Txt>
          </Pressable>
        </View>
      ) : null}
      <SelectSheet text={selectText} onClose={() => setSelectText(undefined)} />
    </View>
    </SelectContext.Provider>
  );
});

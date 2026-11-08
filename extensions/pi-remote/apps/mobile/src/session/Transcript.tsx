import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { FlatList, Pressable, View, type ListViewToken, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { Button, Txt } from "../ds/primitives";
import { F, GUTTER, MARGIN, usePalette } from "../ds/tokens";
import { stripAnsi, textOf } from "../lib/format";
import { useTestAction } from "../lib/test-hooks";
import type { AssistantDraft, Block as ContentBlock, Queued } from "../state/types";
import { CustomCard } from "./CustomCard";
import { AnchorContext, type Anchor, FoldBar, useAnchor } from "./anchor";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

type Item = (
  | { key: string; kind: "msg"; m: WireMessage; idx: number }
  | { key: string; kind: "draft"; d: AssistantDraft }
  | { key: string; kind: "tool"; id: string; name: string; args: unknown; partialText: string }
  | { key: string; kind: "queued"; q: Queued }
) & { label?: boolean };

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

/** Every entry hangs a small label in the margin column: YOU, PI, §. */
function Margin({ label, color, children, a11y }: { label: string; color?: string; children: ReactNode; a11y?: string }) {
  return (
    <View accessibilityLabel={a11y} style={{ flexDirection: "row", alignItems: "baseline", paddingVertical: 6 }}>
      <View style={{ width: GUTTER }}><Txt v="label" color={color} soft={!color}>{label}</Txt></View>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
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

const Row = memo(function Row({ item, ctx }: { item: Item; ctx: Ctx }) {
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
          <Margin label="you" color={p.pink} a11y={a11y}>
            <Txt v={long ? "body" : "em"} selectable style={long ? undefined : { fontSize: 22, lineHeight: 27 }}>{text}</Txt>
            {images ? <Txt v="label" color={p.pink} style={{ marginTop: 4 }}>+ {images} image{images > 1 ? "s" : ""}</Txt> : null}
          </Margin>
        </View>
      );
    }
    case "assistant": {
      const blocks = Array.isArray(m.content) ? (m.content as ContentBlock[]) : [{ type: "text", text: String(m.content ?? "") }];
      return (
        <Margin label={lab("pi")} a11y={a11y}>
          <Blocks blocks={blocks} ctx={ctx} prefix={a11y} />
          {m.stopReason === "error" && m.errorMessage ? <Txt v="mono" color={p.danger} style={{ marginTop: 4 }}>✕ {String(m.errorMessage)}</Txt> : null}
          {m.stopReason === "aborted" ? <Txt v="label" soft>— stopped</Txt> : null}
        </Margin>
      );
    }
    case "toolResult": return <Margin label=""><ToolCard id={String(m.toolCallId ?? item.key)} name={String(m.toolName ?? "tool")} args={{}} result={m} /></Margin>;
    case "bashExecution":
      return (
        <Margin label={lab("$")} a11y={a11y}>
          <Txt v="mono" style={{ fontFamily: F.monoBold }}>{String(m.command ?? "")}</Txt>
          <Txt v="mono" soft selectable style={{ fontSize: 11 }}>{String(m.output ?? "").split("\n").slice(-200).join("\n")}</Txt>
        </Margin>
      );
    case "custom": return <Margin label={lab("§")}><CustomCard m={m} idx={item.idx} /></Margin>;
    case "compactionSummary": return <Divider label="context compacted" text={String(m.summary ?? "")} a11y={a11y} />;
    case "branchSummary": return <Divider label="summary of the abandoned branch" text={String(m.summary ?? "")} a11y={a11y} />;
    default: return null;
  }
});

/**
 * Keeps the view still while rows change size. The list is inverted: offset 0 is the bottom (newest),
 * a larger offset shows older content, and a row that changes size moves every older row (higher index).
 * So whenever a row grows by d and the reader should not move, the list scrolls by +d.
 *
 * - A fold inside a row asked for its top edge to stay ("top"): always compensate, so it opens downward.
 * - A fold asked for its bottom edge ("bottom"): leave it, the list does that by itself.
 * - Anything else (the answer streaming in, a tool's live output, a new row arriving) while the reader
 *   is not at the bottom and the row lies at or below what is on screen: compensate, so what they are
 *   reading stays put and the new output extends below, out of view. At the bottom, the list follows.
 *
 * Heights live in the list (keyed by row), not in the row component, so a row that virtualisation
 * unmounted and mounted again is not mistaken for new content.
 */
interface Keeper {
  heights: Map<string, number>;
  pending: Map<string, Anchor>;
  offset: { current: number };
  maxVisible: { current: number };
  atBottom: () => boolean;
  shift: (d: number, fresh?: boolean) => void;
}

function Anchored({ id, index, keeper, children }: { id: string; index: number; keeper: Keeper; children: ReactNode }) {
  const request = useCallback((a: Anchor) => { keeper.pending.set(id, a); }, [id, keeper]);
  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    const prev = keeper.heights.get(id);
    keeper.heights.set(id, h);
    const d = h - (prev ?? 0);
    if (d === 0) return;
    const asked = keeper.pending.get(id);
    if (asked !== undefined && prev !== undefined) {
      keeper.pending.delete(id);
      if (asked === "top") keeper.shift(d);
      return;
    }
    if (!keeper.atBottom() && index <= keeper.maxVisible.current) keeper.shift(d, true);
  };
  return <AnchorContext.Provider value={request}><View onLayout={onLayout}>{children}</View></AnchorContext.Provider>;
}

/** Imperative handle: scroll to a message by entry id (used by the outline). */
export interface TranscriptHandle { jumpTo: (entryId: string) => boolean }

const AT_BOTTOM = 16;

export const Transcript = forwardRef<TranscriptHandle, {
  messages: WireMessage[]; inflight?: AssistantDraft; queued?: Queued[]; running?: Record<string, { toolName: string; args: unknown; partialText: string }>;
  hasMoreBefore: boolean; onLoadMore?: () => Promise<void>; hideThinking?: boolean; header?: ReactElement | null;
}>(function Transcript(props, ref) {
  const p = usePalette();
  const listRef = useRef<FlatList<Item>>(null);
  const [showJump, setShowJump] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const running = props.running ?? {};

  const { items, ctx } = useMemo(() => {
    const results = new Map<string, WireMessage>();
    const calls = new Set<string>();
    for (const m of props.messages) {
      if (m.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
      if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content as ContentBlock[]) if (b.type === "toolCall") calls.add((b as { id: string }).id);
    }
    if (props.inflight) for (const b of props.inflight.content) if (b?.type === "toolCall") calls.add((b as { id: string }).id);
    const out: Item[] = [];
    props.messages.forEach((m, idx) => {
      if (m.role === "toolResult" && typeof m.toolCallId === "string" && calls.has(m.toolCallId)) return;
      out.push({ key: m.entryId ? `e${m.entryId}` : `i${idx}`, kind: "msg", m, idx });
    });
    if (props.inflight) out.push({ key: "inflight", kind: "draft", d: props.inflight });
    for (const [id, t] of Object.entries(running)) if (!calls.has(id)) out.push({ key: `run-${id}`, kind: "tool", id, name: t.toolName, args: t.args, partialText: t.partialText });
    // Queued messages are not in the conversation yet, so they close the list.
    for (const q of props.queued ?? []) out.push({ key: q.id, kind: "queued", q });
    let prev = "";
    for (const it of out) { const sp = speaker(it); it.label = sp !== prev; prev = sp; }
    return { items: out, ctx: { results, running, hideThinking: !!props.hideThinking } as Ctx };
  }, [props.messages, props.inflight, props.queued, running, props.hideThinking]);

  // Inverted list: offset 0 is the newest entry, so new output stays in view.
  const data = useMemo(() => [...items].reverse(), [items]);
  const offset = useRef(0);
  const maxVisible = useRef(0);
  const [newBelow, setNewBelow] = useState(false);
  const keeper = useMemo<Keeper>(() => ({
    heights: new Map(), pending: new Map(), offset, maxVisible,
    atBottom: () => offset.current <= AT_BOTTOM,
    shift: (d, fresh) => {
      const y = Math.max(0, offset.current + d);
      offset.current = y;
      listRef.current?.scrollToOffset({ offset: y, animated: false });
      if (fresh && d > 0) setNewBelow(true);
    },
  }), []);

  // Rows that left the data (the streamed draft replaced by the saved message, a queued message delivered)
  // take their height with them; below the reader that would pull the view, so give it back.
  const lastIndex = useRef(new Map<string, number>());
  useEffect(() => {
    const now = new Map(data.map((it, i) => [it.key, i]));
    if (!keeper.atBottom()) {
      let gone = 0;
      for (const [key, i] of lastIndex.current) if (!now.has(key) && i <= maxVisible.current) gone += keeper.heights.get(key) ?? 0;
      if (gone) keeper.shift(-gone);
    }
    for (const key of keeper.heights.keys()) if (!now.has(key)) keeper.heights.delete(key);
    lastIndex.current = now;
  }, [data]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = e.nativeEvent.contentOffset.y;
    const away = offset.current > AT_BOTTOM;
    setShowJump(away);
    if (!away) setNewBelow(false);
  }, []);
  const onViewable = useRef(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    let m = 0;
    for (const v of viewableItems) if (v.index != null && v.index > m) m = v.index;
    maxVisible.current = m;
  }).current;
  const jump = () => { listRef.current?.scrollToOffset({ offset: 0, animated: true }); setShowJump(false); setNewBelow(false); };

  useImperativeHandle(ref, () => ({
    jumpTo: (entryId: string) => {
      const index = data.findIndex((it) => it.kind === "msg" && it.m.entryId === entryId);
      if (index < 0) return false;
      // viewPosition 1 puts the row at the visual top of the inverted list.
      listRef.current?.scrollToIndex({ index, viewPosition: 1, animated: true });
      return true;
    },
  }), [data]);

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={listRef}
        inverted
        accessibilityLabel="transcript"
        data={data}
        keyExtractor={(i) => i.key}
        renderItem={({ item, index }) => <Anchored id={item.key} index={index} keeper={keeper}><Row item={item} ctx={ctx} /></Anchored>}
        contentContainerStyle={{ paddingHorizontal: MARGIN, paddingVertical: 10 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
        onScrollToIndexFailed={(info) => {
          // The row is not measured yet: get close first, then aim again.
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: 1, animated: true }), 120);
        }}
        ListFooterComponent={
          <View style={{ paddingTop: 10, alignItems: "center", gap: 10 }}>
            {props.header}
            {props.hasMoreBefore && props.onLoadMore ? (
              <Button a11y="transcript-load-more" label={loadingMore ? "loading…" : "read earlier messages"} disabled={loadingMore}
                onPress={async () => { setLoadingMore(true); try { await props.onLoadMore?.(); } finally { setLoadingMore(false); } }} />
            ) : items.length ? <Txt v="label" faint>— beginning of the session —</Txt> : null}
          </View>
        }
        ListEmptyComponent={<Txt v="em" soft center style={{ marginTop: 60 }}>Nothing said yet.</Txt>}
        initialNumToRender={15}
        windowSize={11}
      />
      {showJump ? (
        // Centred, clear of the stop control at the right of the run bar below.
        <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 12, alignItems: "center" }}>
          <Pressable accessibilityRole="button" accessibilityLabel="transcript-jump-latest" onPress={jump}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 9, backgroundColor: newBelow ? p.blue : p.ink, opacity: pressed ? 0.85 : 1 })}>
            <Txt v="label" color={p.invert} style={{ fontFamily: F.monoBold, fontSize: 12 }}>↓  {newBelow ? "new output" : "latest"}</Txt>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

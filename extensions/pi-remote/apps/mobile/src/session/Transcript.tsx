import { memo, useCallback, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { FlatList, Pressable, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { Button, Txt } from "../ds/primitives";
import { F, GUTTER, MARGIN, usePalette } from "../ds/tokens";
import { stripAnsi, textOf } from "../lib/format";
import { useTestAction } from "../lib/test-hooks";
import type { AssistantDraft, Block as ContentBlock } from "../state/types";
import { CustomCard } from "./CustomCard";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

type Item = (
  | { key: string; kind: "msg"; m: WireMessage; idx: number }
  | { key: string; kind: "draft"; d: AssistantDraft }
  | { key: string; kind: "tool"; id: string; name: string; args: unknown; partialText: string }
) & { label?: boolean };

/** Who "speaks" an item; the margin label is printed only when the speaker changes. */
function speaker(i: Item): string {
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
  const toggle = () => setOpen((o) => !o);
  useTestAction(a11y, hidden ? undefined : toggle);
  if (hidden) return <Txt v="label" faint style={{ marginVertical: 4 }}>thinking hidden</Txt>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={toggle} style={{ marginVertical: 4 }}>
      <Txt v="small" soft lines={open ? undefined : 2} style={{ fontFamily: F.serifItalic, fontSize: 16, lineHeight: 21, color: p.soft }} cjk={{ fontFamily: F.cjkSerif, fontSize: 14, lineHeight: 24 }}>
        {open ? "" : "thinking — "}{text.trim()}
      </Txt>
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
  useTestAction(a11y, () => setOpen((o) => !o));
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={() => setOpen(!open)} style={{ marginVertical: 16, gap: 8 }}>
      <View style={{ height: 1, backgroundColor: p.ink }} />
      <Txt v="label" center>{label} {open ? "−" : "+"}</Txt>
      <View style={{ height: 1, backgroundColor: p.ink }} />
      {open ? <Markdown text={text} /> : null}
    </Pressable>
  );
}

const Row = memo(function Row({ item, ctx }: { item: Item; ctx: Ctx }) {
  const p = usePalette();
  const lab = (s: string) => (item.label ? s : "");
  if (item.kind === "draft") return <Margin label={lab("pi")} color={p.blue} a11y="msg-inflight"><Blocks blocks={item.d.content} ctx={ctx} prefix="draft" streaming /></Margin>;
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

export function Transcript(props: {
  messages: WireMessage[]; inflight?: AssistantDraft; running?: Record<string, { toolName: string; args: unknown; partialText: string }>;
  hasMoreBefore: boolean; onLoadMore?: () => Promise<void>; hideThinking?: boolean; header?: ReactElement | null;
}) {
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
    let prev = "";
    for (const it of out) { const sp = speaker(it); it.label = sp !== prev; prev = sp; }
    return { items: out, ctx: { results, running, hideThinking: !!props.hideThinking } as Ctx };
  }, [props.messages, props.inflight, running, props.hideThinking]);

  // Inverted list: offset 0 is the newest entry, so new output stays in view.
  const data = useMemo(() => [...items].reverse(), [items]);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => setShowJump(e.nativeEvent.contentOffset.y > 400), []);
  const jump = () => { listRef.current?.scrollToOffset({ offset: 0, animated: true }); setShowJump(false); };

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={listRef}
        inverted
        accessibilityLabel="transcript"
        data={data}
        keyExtractor={(i) => i.key}
        renderItem={({ item }) => <Row item={item} ctx={ctx} />}
        contentContainerStyle={{ paddingHorizontal: MARGIN, paddingVertical: 10 }}
        onScroll={onScroll}
        scrollEventThrottle={100}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 120 }}
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
        <View style={{ position: "absolute", right: MARGIN, bottom: 10, backgroundColor: p.paper, paddingHorizontal: 6 }}>
          <Button a11y="transcript-jump-latest" label="↓ latest" onPress={jump} />
        </View>
      ) : null}
    </View>
  );
}

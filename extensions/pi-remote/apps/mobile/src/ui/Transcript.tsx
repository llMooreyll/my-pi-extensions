import { memo, useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { stripAnsi, textOf } from "../lib/format";
import type { AssistantDraft, Block } from "../state/types";
import { CustomMessageCard } from "./CustomMessageCard";
import { Btn, T } from "./kit";
import { Markdown } from "./Markdown";
import { usePalette } from "./theme";
import { ToolCallCard } from "./ToolCallCard";

type Item =
  | { key: string; kind: "msg"; m: WireMessage; idx: number }
  | { key: string; kind: "draft"; d: AssistantDraft }
  | { key: string; kind: "tool"; id: string; name: string; args: unknown; partialText: string };

interface Ctx { results: Map<string, WireMessage>; running: Record<string, { toolName: string; args: unknown; partialText: string }>; hideThinking: boolean }

function Thinking({ text, hidden, a11y }: { text: string; hidden: boolean; a11y: string }) {
  const c = usePalette();
  const [open, setOpen] = useState(false);
  if (hidden) return <T dim size={12} style={{ fontStyle: "italic" }}>Thinking hidden</T>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={() => setOpen(!open)} style={{ borderLeftWidth: 2, borderLeftColor: c.border, paddingLeft: 8, marginVertical: 2 }}>
      <T dim size={12} numberOfLines={open ? undefined : 2} style={{ fontStyle: "italic" }}>{open ? text : `Thinking: ${text.replace(/\s+/g, " ")}`}</T>
    </Pressable>
  );
}

function Blocks({ blocks, ctx, prefix, streaming }: { blocks: Block[]; ctx: Ctx; prefix: string; streaming?: boolean }) {
  return (
    <>
      {blocks.map((b, i) => {
        const key = `${prefix}-${i}`;
        if (b.type === "text") return (b as { text: string }).text ? <Markdown key={key} text={stripAnsi((b as { text: string }).text)} /> : null;
        if (b.type === "thinking") return <Thinking key={key} a11y={`thinking-${key}`} text={stripAnsi(String((b as { thinking: string }).thinking ?? ""))} hidden={ctx.hideThinking} />;
        if (b.type === "toolCall") {
          const tc = b as { id: string; name: string; arguments: Record<string, unknown>; argsText?: string };
          const result = ctx.results.get(tc.id);
          const run = ctx.running[tc.id];
          return <ToolCallCard key={key} id={tc.id} name={tc.name} args={tc.arguments} result={result} running={run} pendingArgs={streaming && !result && !run && tc.argsText !== undefined} />;
        }
        return null;
      })}
    </>
  );
}

const MsgRow = memo(function MsgRow({ item, ctx }: { item: Item; ctx: Ctx }) {
  const c = usePalette();
  if (item.kind === "draft") return <View accessibilityLabel="msg-inflight" style={{ paddingVertical: 6 }}><Blocks blocks={item.d.content} ctx={ctx} prefix="draft" streaming /></View>;
  if (item.kind === "tool") return <ToolCallCard id={item.id} name={item.name} args={item.args} running={{ partialText: item.partialText }} />;
  const m = item.m as WireMessage & Record<string, any>;
  const a11y = `msg-${item.idx}`;
  switch (m.role) {
    case "user": {
      const content = m.content;
      const text = typeof content === "string" ? content : textOf(content);
      const images = Array.isArray(content) ? content.filter((x: any) => x?.type === "image").length : 0;
      return (
        <View accessibilityLabel={a11y} style={{ alignSelf: "flex-end", maxWidth: "88%", backgroundColor: c.userBubble, borderRadius: 12, padding: 10, marginVertical: 6 }}>
          <T selectable>{text}</T>
          {images ? <T dim size={12}>[{images} image{images > 1 ? "s" : ""}]</T> : null}
        </View>
      );
    }
    case "assistant": {
      const blocks = Array.isArray(m.content) ? (m.content as Block[]) : [{ type: "text", text: String(m.content ?? "") }];
      return (
        <View accessibilityLabel={a11y} style={{ paddingVertical: 6 }}>
          <Blocks blocks={blocks} ctx={ctx} prefix={a11y} />
          {m.stopReason === "error" && m.errorMessage ? <T color={c.danger} size={13}>{String(m.errorMessage)}</T> : null}
          {m.stopReason === "aborted" ? <T dim size={12}>Aborted</T> : null}
        </View>
      );
    }
    case "toolResult":
      return <ToolCallCard id={String(m.toolCallId ?? item.key)} name={String(m.toolName ?? "tool")} args={{}} result={m} />;
    case "bashExecution":
      return (
        <View accessibilityLabel={a11y} style={{ backgroundColor: c.code, borderRadius: 8, padding: 8, marginVertical: 4 }}>
          <T mono size={12} bold>$ {String(m.command ?? "")}</T>
          <T mono size={11} selectable>{String(m.output ?? "").split("\n").slice(-200).join("\n")}</T>
        </View>
      );
    case "custom": return <CustomMessageCard m={m} idx={item.idx} />;
    case "compactionSummary": return <Divider label="Context compacted" text={String(m.summary ?? "")} a11y={a11y} />;
    case "branchSummary": return <Divider label="Branch summary" text={String(m.summary ?? "")} a11y={a11y} />;
    default: return null;
  }
});

function Divider({ label, text, a11y }: { label: string; text: string; a11y: string }) {
  const c = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={() => setOpen(!open)} style={{ marginVertical: 8, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
        <T dim size={12}>{label} {open ? "▾" : "▸"}</T>
        <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
      </View>
      {open ? <Markdown text={text} /> : null}
    </Pressable>
  );
}

export function Transcript(props: {
  messages: WireMessage[]; inflight?: AssistantDraft; running?: Record<string, { toolName: string; args: unknown; partialText: string }>;
  hasMoreBefore: boolean; onLoadMore?: () => Promise<void>; hideThinking?: boolean; header?: React.ReactElement | null;
}) {
  const c = usePalette();
  const listRef = useRef<FlatList<Item>>(null);
  const [showJump, setShowJump] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const running = props.running ?? {};

  const { items, ctx } = useMemo(() => {
    const results = new Map<string, WireMessage>();
    const calls = new Set<string>();
    for (const m of props.messages) {
      if (m.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
      if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content as Block[]) if (b.type === "toolCall") calls.add((b as { id: string }).id);
    }
    if (props.inflight) for (const b of props.inflight.content) if (b?.type === "toolCall") calls.add((b as { id: string }).id);
    const out: Item[] = [];
    props.messages.forEach((m, idx) => {
      if (m.role === "toolResult" && typeof m.toolCallId === "string" && calls.has(m.toolCallId)) return;
      out.push({ key: m.entryId ? `e${m.entryId}` : `i${idx}`, kind: "msg", m, idx });
    });
    if (props.inflight) out.push({ key: "inflight", kind: "draft", d: props.inflight });
    for (const [id, t] of Object.entries(running)) if (!calls.has(id)) out.push({ key: `run-${id}`, kind: "tool", id, name: t.toolName, args: t.args, partialText: t.partialText });
    return { items: out, ctx: { results, running, hideThinking: !!props.hideThinking } as Ctx };
  }, [props.messages, props.inflight, running, props.hideThinking]);

  // Inverted list: offset 0 is the newest message, so new output stays in view without manual scrolling.
  const data = useMemo(() => [...items].reverse(), [items]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setShowJump(e.nativeEvent.contentOffset.y > 400);
  }, []);

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={listRef}
        inverted
        accessibilityLabel="transcript"
        data={data}
        keyExtractor={(i) => i.key}
        renderItem={({ item }) => <MsgRow item={item} ctx={ctx} />}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
        onScroll={onScroll}
        scrollEventThrottle={100}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 120 }}
        ListFooterComponent={
          <View>
            {props.header}
            {props.hasMoreBefore && props.onLoadMore ? (
              <Btn small a11y="transcript-load-more" label={loadingMore ? "Loading…" : "Load earlier messages"} disabled={loadingMore}
                onPress={async () => { setLoadingMore(true); try { await props.onLoadMore?.(); } finally { setLoadingMore(false); } }}
                style={{ alignSelf: "center", marginVertical: 8 }} />
            ) : null}
          </View>
        }
        initialNumToRender={15}
        windowSize={11}
      />
      {showJump ? (
        <Pressable accessibilityRole="button" accessibilityLabel="transcript-jump-latest" onPress={() => { listRef.current?.scrollToOffset({ offset: 0, animated: true }); setShowJump(false); }}
          style={{ position: "absolute", right: 14, bottom: 14, backgroundColor: c.accent, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 6 }}>
          <T color={c.accentText} size={13} bold>↓ Latest</T>
        </Pressable>
      ) : null}
    </View>
  );
}

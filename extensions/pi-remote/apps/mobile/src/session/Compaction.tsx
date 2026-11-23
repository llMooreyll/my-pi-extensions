import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import type { CompactionReason, ContextUsageWire } from "@pi-remote/protocol";
import { Button, Field, Sheet, Spinner, Txt } from "../ds/primitives";
import { F, MARGIN, usePalette } from "../ds/tokens";
import { ktok } from "../lib/format";
import { TEST_HOOKS, useTestAction } from "../lib/test-hooks";
import { FoldBar, useAnchor } from "./anchor";
import { Markdown } from "./Markdown";

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

const REASON: Record<CompactionReason, string> = {
  manual: "you asked for it",
  threshold: "the context is nearly full",
  overflow: "the context overflowed; pi retries its turn afterwards",
};

/** While pi summarises the conversation: a bar above the composer with what is happening and for how long. */
export function CompactBar({ since, reason }: { since?: number; reason?: CompactionReason }) {
  const p = usePalette();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since || TEST_HOOKS) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return null;
  return (
    <View accessibilityLabel="compact-bar" style={{ paddingHorizontal: MARGIN, paddingVertical: 9, borderTopWidth: 2, borderTopColor: p.ink, backgroundColor: p.paper, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Spinner color={p.ink} />
        <Txt v="label" style={{ fontFamily: F.monoBold, flex: 1 }}>compacting the context</Txt>
        <Txt v="mono" soft>{clock(now - since)}</Txt>
      </View>
      <Txt v="small" soft style={{ fontSize: 12 }}>{reason ? `${REASON[reason]} — ` : ""}older messages become a summary; the full history stays in the session file</Txt>
    </View>
  );
}

/** Where the conversation was compacted: a full-width break with the summary pi kept, folded. */
export function CompactionMark({ summary, tokensBefore, fromHook, at, a11y }: { summary: string; tokensBefore?: number; fromHook?: boolean; at?: number; a11y: string }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const anchor = useAnchor();
  const toggle = () => { anchor("top"); setOpen((o) => !o); };
  useTestAction(a11y, toggle);
  const lines = summary.trim().split("\n").filter((l) => l.trim());
  return (
    <View accessibilityLabel={a11y} style={{ marginVertical: 18 }}>
      <View style={{ height: 3, backgroundColor: p.ink }} />
      <View style={{ height: 1, backgroundColor: p.ink, marginTop: 2 }} />
      <Pressable accessibilityRole="button" onPress={toggle} style={({ pressed }) => ({ paddingVertical: 10, backgroundColor: pressed ? p.tint : "transparent", gap: 4 })}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
          <Txt v="label" style={{ fontFamily: F.monoBold }}>context compacted</Txt>
          {tokensBefore ? <Txt v="mono" soft style={{ fontSize: 11 }}>{ktok(tokensBefore)} tokens → summary</Txt> : null}
          <View style={{ flex: 1 }} />
          <Txt v="mono" soft style={{ fontFamily: F.monoBold }}>{open ? "−" : "+"}</Txt>
        </View>
        <Txt v="small" soft style={{ fontSize: 12 }}>
          {[fromHook ? "summary written by an extension" : "pi only sees this summary of what came before", at ? new Date(at).toLocaleString() : ""].filter(Boolean).join(" · ")}
        </Txt>
        {!open && lines.length ? <Txt v="small" lines={2} style={{ marginTop: 4 }}>{lines.slice(0, 3).join(" ").replace(/[#*_`>]/g, "")}</Txt> : null}
      </Pressable>
      {open ? <View style={{ paddingBottom: 6 }}><Markdown text={summary} /><FoldBar a11y={`${a11y}-fold`} onFold={() => setOpen(false)} label="fold the summary" /></View> : null}
      <View style={{ height: 1, backgroundColor: p.ink }} />
    </View>
  );
}

const PRESETS = [
  { label: "decisions & open tasks", text: "Keep every decision made and every task still open, with who asked for it." },
  { label: "files & changes", text: "Keep the exact paths of files read or changed and what changed in each." },
  { label: "errors & fixes", text: "Keep the errors met, their causes and how each was fixed or why it is still open." },
];

/** /compact: how full the context is, what the summary should keep, then compaction runs in the background. */
export function CompactSheet({ usage, busy, onRun, onClose }: { usage?: ContextUsageWire; busy: boolean; onRun: (instructions?: string) => void; onClose: () => void }) {
  const p = usePalette();
  const [text, setText] = useState("");
  const pct = usage?.percent ?? (usage?.tokens && usage.contextWindow ? (usage.tokens / usage.contextWindow) * 100 : undefined);
  const col = pct === undefined ? p.soft : pct >= 85 ? p.danger : pct >= 60 ? p.pink : p.blue;
  return (
    <Sheet visible a11y="compact-sheet" kicker="this session" title="Compact the context" onClose={onClose}
      footer={<Button kind="solid" a11y="compact-run" label={busy ? "Already compacting…" : "Compact now"} disabled={busy} onPress={() => onRun(text.trim() || undefined)} />}>
      <View accessibilityLabel="compact-usage" style={{ marginTop: 14, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
          <Txt v="title" color={col}>{pct === undefined ? "—" : `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`}</Txt>
          <Txt v="mono" soft style={{ flex: 1 }}>{usage?.tokens ? `${ktok(usage.tokens)} of ${ktok(usage.contextWindow)} tokens` : usage ? `window ${ktok(usage.contextWindow)} tokens` : "usage not known yet"}</Txt>
        </View>
        <View style={{ height: 6, backgroundColor: p.faint }}>
          <View style={{ height: 6, width: `${Math.min(100, pct ?? 0)}%`, backgroundColor: col }} />
        </View>
      </View>
      <Txt v="small" soft style={{ marginVertical: 12 }}>Older messages are replaced with a summary, so pi has room again. The full history stays in the session file and on this phone.</Txt>
      <Txt v="label" soft style={{ marginBottom: 6 }}>make sure the summary keeps</Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        {PRESETS.map((x, i) => {
          const on = text.includes(x.text);
          return (
            <Pressable key={i} accessibilityRole="button" accessibilityLabel={`compact-preset-${i}`} onPress={() => setText(on ? text.replace(x.text, "").trim() : [text.trim(), x.text].filter(Boolean).join("\n"))}
              style={{ borderWidth: 1, borderColor: on ? p.ink : p.faint, backgroundColor: on ? p.ink : "transparent", paddingHorizontal: 9, paddingVertical: 5 }}>
              <Txt v="label" color={on ? p.invert : p.soft}>{x.label}</Txt>
            </Pressable>
          );
        })}
      </View>
      <Field a11y="compact-input" label="your own instructions (optional)" value={text} onChangeText={setText} multiline />
    </Sheet>
  );
}

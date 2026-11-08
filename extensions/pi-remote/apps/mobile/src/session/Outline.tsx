import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { WireMessage } from "@pi-remote/protocol";
import { Button, Sheet, Spinner, Txt } from "../ds/primitives";
import { F, GUTTER, usePalette } from "../ds/tokens";
import { plainPreview, stripAnsi, textOf } from "../lib/format";
import { useTestAction } from "../lib/test-hooks";
import { call, errText } from "../net/connection";
import { Seg, useTreePanel } from "./Sheets";
import { toolSummary } from "./toolSummary";

type Step = "tool" | "toolError" | "text" | "error" | "notice";

/** One turn: your prompt and everything pi did until your next prompt. */
interface Turn {
  n: number;
  entryId?: string;
  prompt: string;
  images: number;
  startedAt?: number;
  endedAt?: number;
  steps: Step[];
  tools: Map<string, number>;
  calls: { id: string; line: string; error: boolean }[];
  answer: string;
  outTokens: number;
  error?: string;
}

const ms = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) || undefined : undefined);

export function buildTurns(messages: WireMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | undefined;
  const callIndex = new Map<string, { turn: Turn; i: number; step: number }>();
  const open = (m?: WireMessage): Turn => {
    const c = m?.content;
    const t: Turn = {
      n: turns.length + 1, entryId: m?.entryId, prompt: m ? (typeof c === "string" ? c : textOf(c)) : "",
      images: Array.isArray(c) ? c.filter((x: { type?: string }) => x?.type === "image").length : 0,
      startedAt: ms(m?.timestamp), steps: [], tools: new Map(), calls: [], answer: "", outTokens: 0,
    };
    turns.push(t);
    return t;
  };
  for (const m of messages) {
    if (m.role === "user") { cur = open(m); continue; }
    const t = cur ?? (cur = open());
    const at = ms(m.timestamp);
    if (at) t.endedAt = at;
    if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? (m.content as { type: string; text?: string; id?: string; name?: string; arguments?: unknown }[]) : [];
      for (const b of blocks) {
        if (b.type === "toolCall") {
          const name = String(b.name ?? "tool");
          t.tools.set(name, (t.tools.get(name) ?? 0) + 1);
          callIndex.set(String(b.id), { turn: t, i: t.calls.length, step: t.steps.length });
          t.calls.push({ id: String(b.id), line: toolSummary(name, b.arguments).split("\n")[0]!, error: false });
          t.steps.push("tool");
        } else if (b.type === "text" && b.text?.trim()) {
          t.answer = stripAnsi(b.text);
          if (t.steps.at(-1) !== "text") t.steps.push("text");
        }
      }
      const usage = m.usage as { output?: number } | undefined;
      t.outTokens += usage?.output ?? 0;
      if (m.stopReason === "error") { t.error = String(m.errorMessage ?? "error"); t.steps.push("error"); }
    } else if (m.role === "toolResult" && m.isError) {
      const hit = callIndex.get(String(m.toolCallId));
      if (hit) { hit.turn.calls[hit.i]!.error = true; hit.turn.steps[hit.step] = "toolError"; }
    } else if (m.role === "bashExecution") {
      t.tools.set("$", (t.tools.get("$") ?? 0) + 1);
      t.calls.push({ id: String(m.entryId), line: `$ ${String(m.command ?? "")}`, error: false });
      t.steps.push("tool");
    } else if (m.role === "custom") t.steps.push("notice");
  }
  return turns;
}

const fmtDur = (a?: number, b?: number) => {
  if (!a || !b || b < a) return "";
  const s = Math.round((b - a) / 1000);
  if (s < 1) return "";
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The turn's shape at a glance: one small mark per step. */
function StepRail({ steps }: { steps: Step[] }) {
  const p = usePalette();
  const color: Record<Step, string> = { tool: p.soft, toolError: p.danger, text: p.blue, error: p.danger, notice: p.pink };
  const shown = steps.slice(0, 40);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 3, marginTop: 6 }}>
      {shown.map((s, i) => <View key={i} style={{ width: s === "text" ? 14 : 6, height: 6, backgroundColor: color[s] }} />)}
      {steps.length > shown.length ? <Txt v="mono" soft style={{ fontSize: 9, lineHeight: 8 }}>+{steps.length - shown.length}</Txt> : null}
    </View>
  );
}

function TurnRow({ t, last, running, onJump, onRewind, onFork, busy }: {
  t: Turn; last: boolean; running: boolean; busy: boolean;
  onJump: () => void; onRewind: () => Promise<void>; onFork: () => Promise<void>;
}) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"rewind" | "fork" | undefined>();
  const [copied, setCopied] = useState<string | undefined>();
  useEffect(() => { if (!copied) return; const x = setTimeout(() => setCopied(undefined), 1500); return () => clearTimeout(x); }, [copied]);
  const toggle = () => { setOpen((o) => !o); setConfirm(undefined); };
  useTestAction(`outline-turn-${t.n}`, toggle);
  const live = last && running;
  const tools = [...t.tools.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => (v > 1 ? `${k} ×${v}` : k));
  const meta = [tools.slice(0, 3).join(" · ") + (tools.length > 3 ? ` +${tools.length - 3}` : ""), fmtDur(t.startedAt, t.endedAt), t.outTokens ? `${fmtTok(t.outTokens)} out` : ""].filter(Boolean).join("  ·  ");
  const copy = (what: string, text: string) => { void Clipboard.setStringAsync(text); setCopied(what); };
  const canBranch = !!t.entryId && !running;
  return (
    <View accessibilityLabel={`outline-turn-${t.n}`} style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: p.faint }}>
      <View style={{ width: 3, backgroundColor: live ? p.blue : t.error ? p.danger : open ? p.ink : "transparent" }} />
      <View style={{ flex: 1 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`outline-toggle-${t.n}`} onPress={toggle}
          style={({ pressed }) => ({ flexDirection: "row", paddingVertical: 12, paddingRight: 4, backgroundColor: pressed ? p.tint : "transparent" })}>
          <Txt v="label" color={live ? p.blue : p.soft} style={{ width: GUTTER, paddingLeft: 8, paddingTop: 3, fontFamily: F.monoBold }}>{String(t.n).padStart(2, "0")}</Txt>
          <View style={{ flex: 1 }}>
            <Txt v="em" lines={open ? undefined : 2} style={{ fontSize: 18, lineHeight: 23 }} cjk={{ fontSize: 15.5, lineHeight: 25 }}>
              {t.prompt.trim() || (t.entryId ? "(image only)" : "(before the first message)")}
            </Txt>
            {t.images ? <Txt v="label" color={p.pink} style={{ marginTop: 2 }}>+ {t.images} image{t.images > 1 ? "s" : ""}</Txt> : null}
            {t.steps.length ? <StepRail steps={t.steps} /> : null}
            <Txt v="mono" soft lines={1} style={{ fontSize: 10.5, marginTop: 5 }}>{live ? "▶ working now" : meta || "no reply yet"}</Txt>
          </View>
          <Txt v="mono" soft style={{ width: 18, textAlign: "right", paddingTop: 2 }}>{open ? "−" : "+"}</Txt>
        </Pressable>
        {open ? (
          <View style={{ paddingLeft: GUTTER, paddingRight: 4, paddingBottom: 14, gap: 10 }}>
            {t.answer ? (
              <View style={{ gap: 3 }}>
                <Txt v="label" soft>pi's last words</Txt>
                <Txt v="body" selectable lines={10} style={{ fontSize: 14.5, lineHeight: 21 }}>{plainPreview(t.answer)}</Txt>
              </View>
            ) : null}
            {t.error ? <Txt v="mono" color={p.danger} selectable style={{ fontSize: 11.5 }}>✕ {t.error}</Txt> : null}
            {t.calls.length ? (
              <View style={{ gap: 2 }}>
                <Txt v="label" soft>{t.calls.length} tool call{t.calls.length > 1 ? "s" : ""}</Txt>
                {t.calls.slice(0, 30).map((c) => <Txt key={c.id} v="mono" lines={1} color={c.error ? p.danger : p.ink} style={{ fontSize: 11 }}>{c.error ? "✕ " : "· "}{c.line}</Txt>)}
                {t.calls.length > 30 ? <Txt v="label" soft>+ {t.calls.length - 30} more</Txt> : null}
              </View>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {t.entryId ? <Button kind="outline" compact a11y={`outline-jump-${t.n}`} label="↧ show in chat" onPress={onJump} /> : null}
              <Button kind="outline" compact a11y={`outline-copy-prompt-${t.n}`} label={copied === "prompt" ? "✓ copied" : "copy prompt"} onPress={() => copy("prompt", t.prompt)} />
              {t.answer ? <Button kind="outline" compact a11y={`outline-copy-answer-${t.n}`} label={copied === "answer" ? "✓ copied" : "copy answer"} onPress={() => copy("answer", t.answer)} /> : null}
              {t.entryId ? <Button kind="outline" compact color={p.pink} a11y={`outline-rewind-${t.n}`} label="↶ redo from here" disabled={!canBranch || busy} onPress={() => setConfirm("rewind")} /> : null}
              {t.entryId ? <Button kind="outline" compact a11y={`outline-fork-${t.n}`} label="fork from here" disabled={!canBranch || busy} onPress={() => setConfirm("fork")} /> : null}
            </View>
            {running && t.entryId ? <Txt v="small" soft>Redo and fork wait until pi is idle.</Txt> : null}
            {confirm ? (
              <View accessibilityLabel="outline-confirm" style={{ borderLeftWidth: 3, borderLeftColor: confirm === "rewind" ? p.pink : p.ink, paddingLeft: 12, gap: 8 }}>
                <Txt v="small">
                  {confirm === "rewind"
                    ? "pi goes back to just before this prompt and puts it in your composer to edit and resend. Later turns are kept as another branch in the tree."
                    : "A new session starts with everything before this prompt; the prompt waits in your composer. This session stays as it is."}
                </Txt>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Button kind="solid" compact a11y={`outline-confirm-${confirm}`} label={confirm === "rewind" ? "Redo from here" : "Fork"} busy={busy}
                    onPress={() => void (confirm === "rewind" ? onRewind() : onFork())} style={{ flex: 1 }} />
                  <Button kind="outline" a11y="outline-confirm-cancel" label="cancel" onPress={() => setConfirm(undefined)} />
                </View>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Outline of the conversation (one entry per turn, like pi-session-view's outline) together with the
 * full session tree. From a turn you can show it in the chat, copy it, redo from it or fork from it.
 */
export function OutlineSheet(props: {
  processId: string; messages: WireMessage[]; hasMoreBefore: boolean; running: boolean; initialTab: "turns" | "tree"; treeFilter?: string;
  onLoadMore: () => Promise<void>; onJump: (entryId: string) => void; onPrefill: (text: string) => void; onClose: () => void;
}) {
  const p = usePalette();
  const [tab, setTab] = useState(props.initialTab);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const turns = useMemo(() => buildTurns(props.messages), [props.messages]);
  const tree = useTreePanel({ processId: props.processId, running: props.running, defaultFilter: props.treeFilter, onDone: props.onClose, onPrefill: props.onPrefill });
  const totals = useMemo(() => ({
    tools: turns.reduce((n, t) => n + t.calls.length, 0),
    errors: turns.reduce((n, t) => n + t.calls.filter((c) => c.error).length + (t.error ? 1 : 0), 0),
  }), [turns]);

  const rewind = async (t: Turn) => {
    if (!t.entryId) return;
    setBusy(true);
    try {
      const r = await call("navigate_tree", { processId: props.processId, entryId: t.entryId, summarize: false }, 310_000);
      if (!r.cancelled) props.onPrefill(r.editorText ?? t.prompt);
      props.onClose();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const fork = async (t: Turn) => {
    if (!t.entryId) return;
    setBusy(true);
    try {
      const r = await call("fork", { processId: props.processId, entryId: t.entryId, position: "before" }, 70_000);
      if (!r.cancelled) props.onPrefill(r.prefillText ?? t.prompt);
      props.onClose();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <Sheet visible a11y="outline-sheet" kicker="this conversation" title={tab === "turns" ? "Outline" : "Session tree"} onClose={props.onClose}
      footer={tab === "tree" ? tree.footer : undefined}>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 12, alignItems: "center" }}>
        <Seg a11y="outline-tab-turns" label="turns" on={tab === "turns"} onPress={() => setTab("turns")} />
        <Seg a11y="outline-tab-tree" label="all branches" on={tab === "tree"} onPress={() => setTab("tree")} />
      </View>
      {tab === "tree" ? tree.body : (
        <View style={{ marginTop: 12 }}>
          <Txt v="mono" soft style={{ fontSize: 11, marginBottom: 8 }}>
            {turns.length} turn{turns.length === 1 ? "" : "s"}  ·  {totals.tools} tool call{totals.tools === 1 ? "" : "s"}{totals.errors ? `  ·  ${totals.errors} failed` : ""}
          </Txt>
          {error ? <Txt v="small" color={p.danger} style={{ marginBottom: 8 }}>{error}</Txt> : null}
          {props.hasMoreBefore ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 }}>
              <Txt v="small" soft style={{ flex: 1 }}>Earlier turns are not loaded on the phone.</Txt>
              {loading ? <Spinner /> : <Button kind="outline" compact a11y="outline-load-more" label="load earlier" onPress={async () => { setLoading(true); try { await props.onLoadMore(); } finally { setLoading(false); } }} />}
            </View>
          ) : null}
          <View style={{ borderTopWidth: 1, borderTopColor: p.ink }}>
            {turns.map((t, i) => (
              <TurnRow key={t.entryId ?? `t${i}`} t={t} last={i === turns.length - 1} running={props.running} busy={busy}
                onJump={() => { props.onClose(); if (t.entryId) props.onJump(t.entryId); }}
                onRewind={() => rewind(t)} onFork={() => fork(t)} />
            ))}
          </View>
          {!turns.length ? <Txt v="em" soft style={{ marginTop: 20 }}>Nothing said yet.</Txt> : null}
        </View>
      )}
    </Sheet>
  );
}

import { Fragment, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { ForkPoint, ModelSummary, ProcessInfo, SessionListItem, TreeNodeWire } from "@pi-remote/protocol";
import { Button, Choice, Field, Sheet, Spinner, Toggle, Txt } from "../ds/primitives";
import { F, usePalette } from "../ds/tokens";
import { closeProcess, closeText } from "../lib/process";
import { useTestAction } from "../lib/test-hooks";
import { relTime } from "../lib/format";
import { openProcess } from "../lib/nav";
import { call, errCode, errText } from "../net/connection";

/** A filter / scope chip: ruled, filled with ink when selected. */
function Seg({ label, on, onPress, a11y }: { label: string; on: boolean; onPress: () => void; a11y: string }) {
  const p = usePalette();
  useTestAction(a11y, onPress);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress} hitSlop={4}
      style={{ paddingHorizontal: 9, paddingVertical: 5, borderWidth: 1, borderColor: on ? p.ink : p.faint, backgroundColor: on ? p.ink : "transparent" }}>
      <Txt v="label" color={on ? p.invert : p.soft} style={{ fontFamily: on ? F.monoBold : F.mono }}>{label}</Txt>
    </Pressable>
  );
}

const Err = ({ text, a11y }: { text?: string; a11y: string }) => {
  const p = usePalette();
  return text ? <Txt v="small" color={p.danger} a11y={a11y} style={{ marginTop: 10 }}>{text}</Txt> : null;
};

export function ModelSheet({ processId, onClose }: { processId: string; onClose: () => void }) {
  const [models, setModels] = useState<ModelSummary[] | undefined>();
  const [current, setCurrent] = useState<ModelSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { call("get_models", { processId }).then((r) => { setModels(r.models); setCurrent(r.current); }, (e) => setError(errText(e))); }, [processId]);
  const pick = async (m: ModelSummary) => {
    try { await call("set_model", { processId, provider: m.provider, id: m.id }); onClose(); }
    catch (e) { setError(errCode(e) === "no_auth" ? "This provider is not logged in. Run /login on the computer." : errText(e)); }
  };
  const groups = new Map<string, ModelSummary[]>();
  for (const m of models ?? []) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return (
    <Sheet visible a11y="model-sheet" kicker="this session" title="Model" onClose={onClose}>
      <Err text={error} a11y="model-error" />
      {!models && !error ? <View style={{ paddingVertical: 14 }}><Spinner /></View> : null}
      {[...groups].map(([prov, ms]) => (
        <Fragment key={prov}>
          <Txt v="label" soft style={{ marginTop: 18, marginBottom: 2 }}>{prov}</Txt>
          {ms.map((m) => (
            <Choice key={`${m.provider}/${m.id}`} a11y={`model-${m.provider}/${m.id}`} label={m.name} selected={current?.provider === m.provider && current?.id === m.id}
              sub={[m.id, m.input.includes("image") ? "reads images" : "text only", m.reasoning ? "reasoning" : ""].filter(Boolean).join(" · ")} onPress={() => void pick(m)} />
          ))}
        </Fragment>
      ))}
    </Sheet>
  );
}

export function ThinkingSheet({ processId, onClose }: { processId: string; onClose: () => void }) {
  const [data, setData] = useState<{ current: string; levels: string[] } | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { call("get_thinking_levels", { processId }).then(setData, (e) => setError(errText(e))); }, [processId]);
  return (
    <Sheet visible a11y="thinking-sheet" kicker="this session" title="Thinking" onClose={onClose}>
      <Txt v="small" soft style={{ marginTop: 12 }}>How long the model may reason before answering. Off is fastest and cheapest.</Txt>
      <Err text={error} a11y="thinking-error" />
      {!data && !error ? <View style={{ paddingVertical: 14 }}><Spinner /></View> : null}
      {data?.levels.map((l) => (
        <Choice key={l} a11y={`thinking-${l}`} label={l} selected={l === data.current}
          onPress={async () => { try { await call("set_thinking", { processId, level: l }); onClose(); } catch (e) { setError(errText(e)); } }} />
      ))}
    </Sheet>
  );
}

export function CompactSheet({ processId, onClose }: { processId: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = async () => {
    setBusy(true); setError(undefined);
    try { await call("compact", { processId, ...(text.trim() ? { customInstructions: text.trim() } : {}) }, 620_000); onClose(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Sheet visible a11y="compact-sheet" kicker="this session" title="Compact" onClose={onClose}
      footer={<Button kind="solid" a11y="compact-run" label={busy ? "Summarising the conversation…" : "Compact now"} busy={busy} onPress={() => void run()} />}>
      <Txt v="small" soft style={{ marginVertical: 12 }}>Replaces older messages with a summary to free context. The full history stays in the session file.</Txt>
      <Field a11y="compact-input" label="what the summary should keep (optional)" value={text} onChangeText={setText} multiline />
      <Err text={error} a11y="compact-error" />
    </Sheet>
  );
}

export function ForkSheet({ processId, onClose, onPrefill }: { processId: string; onClose: () => void; onPrefill: (t: string) => void }) {
  const [points, setPoints] = useState<ForkPoint[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { call("get_fork_points", { processId }).then((r) => setPoints([...r.points].reverse()), (e) => setError(errText(e))); }, [processId]);
  return (
    <Sheet visible a11y="fork-sheet" kicker="new session from" title="Fork" onClose={onClose}>
      <Txt v="small" soft style={{ marginVertical: 12 }}>Pick one of your messages. A new session starts just before it, and the message is put back in the composer so you can rewrite it.</Txt>
      <Err text={error} a11y="fork-error" />
      {!points && !error ? <Spinner /> : null}
      {points?.length === 0 ? <Txt v="small" soft>You have not written anything on this branch yet.</Txt> : null}
      {busy ? <Spinner /> : null}
      {points?.map((pt, i) => (
        <Choice key={pt.entryId} a11y={`fork-point-${i}`} label={pt.text.slice(0, 200) || "(empty)"} sub={relTime(pt.timestamp)} disabled={busy}
          onPress={async () => {
            setBusy(true);
            try {
              const r = await call("fork", { processId, entryId: pt.entryId, position: "before" }, 70_000);
              if (!r.cancelled && r.prefillText !== undefined) onPrefill(r.prefillText);
              onClose();
            } catch (e) { setError(errText(e)); } finally { setBusy(false); }
          }} />
      ))}
    </Sheet>
  );
}

export function ResumeSheet({ processId, cwd, currentFile, onClose }: { processId: string; cwd: string; currentFile?: string; onClose: () => void }) {
  const p = usePalette();
  const [all, setAll] = useState(false);
  const [items, setItems] = useState<SessionListItem[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setItems(undefined);
    call("list_sessions", all ? {} : { cwd }).then((r) => setItems(r.sessions.slice(0, 100)), (e) => setError(errText(e)));
  }, [all, cwd]);
  const pick = async (s: SessionListItem) => {
    if (s.sessionFile === currentFile) { onClose(); return; }
    if (s.liveProcessId && s.liveProcessId !== processId) { onClose(); openProcess(s.liveProcessId); return; }
    setBusy(true);
    try { await call("switch_session", { processId, sessionFile: s.sessionFile }, 70_000); onClose(); }
    catch (e) {
      if (errCode(e) === "conflict_live_elsewhere") { onClose(); openProcess(errText(e)); }
      else setError(errText(e));
    } finally { setBusy(false); }
  };
  return (
    <Sheet visible a11y="resume-sheet" kicker="switch this pi to" title="Another session" onClose={onClose}>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
        <Seg a11y="resume-scope-project" label="this project" on={!all} onPress={() => setAll(false)} />
        <Seg a11y="resume-scope" label="all projects" on={all} onPress={() => setAll(true)} />
      </View>
      <Err text={error} a11y="resume-error" />
      {!items && !error ? <Spinner /> : null}
      {busy ? <Spinner /> : null}
      {items?.map((s, i) => (
        <Choice key={s.sessionFile} a11y={`resume-item-${i}`} label={s.name || s.firstMessage || "(empty)"} selected={s.sessionFile === currentFile} disabled={busy}
          sub={`${all ? `${s.cwd} · ` : ""}${relTime(s.modified)} · ${s.messageCount} messages${s.liveProcessId ? " · open in another pi" : ""}`} onPress={() => void pick(s)} />
      ))}
    </Sheet>
  );
}

type TreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
const FILTERS: { f: TreeFilter; label: string }[] = [
  { f: "default", label: "conversation" }, { f: "no-tools", label: "no tools" }, { f: "user-only", label: "my messages" }, { f: "labeled-only", label: "labelled" }, { f: "all", label: "everything" },
];
function visible(n: TreeNodeWire, f: TreeFilter): boolean {
  switch (f) {
    case "all": return true;
    case "user-only": return n.kind === "user";
    case "labeled-only": return !!n.label;
    case "no-tools": return n.kind !== "toolResult" && n.kind !== "other" && !(n.kind === "assistant" && !n.preview);
    default: return n.kind !== "toolResult" && n.kind !== "other";
  }
}

/** The whole session tree: every branch, filterable; picking a point jumps there. Body and footer for a sheet. */
export function useTreePanel({ processId, running, defaultFilter, onDone, onPrefill }: { processId: string; running: boolean; defaultFilter?: string; onDone: () => void; onPrefill: (t: string) => void }) {
  const p = usePalette();
  const [nodes, setNodes] = useState<TreeNodeWire[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState<TreeFilter>(FILTERS.some((x) => x.f === defaultFilter) ? (defaultFilter as TreeFilter) : "default");
  const [target, setTarget] = useState<TreeNodeWire | undefined>();
  const [summarize, setSummarize] = useState(false);
  const [instr, setInstr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { call("get_tree", { processId }).then((r) => setNodes(r.nodes), (e) => setError(errText(e))); }, [processId]);
  const depth = useMemo(() => {
    const byId = new Map((nodes ?? []).map((n) => [n.id, n]));
    const d = new Map<string, number>();
    for (const n of nodes ?? []) {
      let k = 0; let q = n.parentId ? byId.get(n.parentId) : undefined; let guard = 0;
      while (q && guard++ < 5000) { if (q.childCount > 1) k++; q = q.parentId ? byId.get(q.parentId) : undefined; }
      d.set(n.id, Math.min(k, 12));
    }
    return d;
  }, [nodes]);
  const go = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await call("navigate_tree", { processId, entryId: target.id, summarize, ...(summarize && instr.trim() ? { customInstructions: instr.trim() } : {}) }, 310_000);
      // Going back to one of your messages puts that message back in the composer, as on the computer.
      if (!r.cancelled && r.editorText) onPrefill(r.editorText);
      onDone();
    }
    catch (e) { setError(errText(e)); setTarget(undefined); }
    finally { setBusy(false); }
  };
  const footer = target ? (
    <View accessibilityLabel="tree-confirm" style={{ gap: 4 }}>
      <Txt v="label" soft>continue from</Txt>
      <Txt v="body" lines={2}>{target.preview || target.kind}</Txt>
      {target.kind === "user" ? <Txt v="small" soft>pi goes back to just before this message and puts it in your composer to edit and resend.</Txt> : null}
      <Toggle a11y="tree-summarize" value={summarize} onChange={setSummarize} label="Summarise the branch you leave" hint="Costs a model call; keeps a note of what was tried." />
      {summarize ? <Field a11y="tree-instructions" value={instr} onChangeText={setInstr} placeholder="what the summary should focus on (optional)" /> : null}
      <Button kind="solid" a11y="tree-go" label="Jump here" busy={busy} onPress={() => void go()} />
      <Button kind="outline" a11y="tree-cancel" label="cancel" onPress={() => setTarget(undefined)} style={{ marginTop: 8 }} />
    </View>
  ) : undefined;
  const body = (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {FILTERS.map((x) => <Seg key={x.f} a11y={`tree-filter-${x.f}`} label={x.label} on={x.f === filter} onPress={() => setFilter(x.f)} />)}
      </View>
      {running ? <Txt v="small" color={p.blue} style={{ marginTop: 10 }}>pi is working. Wait until it is idle to jump.</Txt> : null}
      <Err text={error} a11y="tree-error" />
      {!nodes && !error ? <Spinner /> : null}
      {nodes?.filter((n) => visible(n, filter)).map((n) => (
        <Choice key={n.id} a11y={`tree-node-${n.id}`} indent={depth.get(n.id) ?? 0} strong={n.onActivePath} disabled={running || busy}
          label={`${n.kind === "user" ? "you: " : ""}${n.preview || `[${n.kind}]`}`}
          sub={[n.onActivePath ? "on this branch" : "other branch", n.label ? `#${n.label}` : "", n.isLeaf ? "you are here" : ""].filter(Boolean).join(" · ")}
          selected={n.isLeaf} onPress={() => setTarget(n)} />
      ))}
    </>
  );
  return { body, footer };
}

export { Seg };

export function InfoSheet({ info, onClose, renameFirst }: { info: ProcessInfo; onClose: () => void; renameFirst?: boolean }) {
  const p = usePalette();
  const [name, setName] = useState(info.sessionName ?? "");
  const [renaming, setRenaming] = useState(!!renameFirst);
  const [confirmKill, setConfirmKill] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const r = info.role;
  const u = info.contextUsage;
  const Line = ({ k, v }: { k: string; v?: string | number }) => (v === undefined || v === "" ? null : (
    <View style={{ flexDirection: "row", paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: p.faint }}>
      <Txt v="label" soft style={{ width: 110, paddingTop: 2 }}>{k}</Txt>
      <Txt v="mono" selectable style={{ flex: 1 }}>{String(v)}</Txt>
    </View>
  ));
  return (
    <Sheet visible a11y="session-sheet" kicker="about this pi" title={info.sessionName || "Session"} onClose={onClose}>
      <Err text={error} a11y="session-error" />
      <View style={{ marginTop: 12, gap: 8 }}>
        {renaming ? (
          <>
            <Field a11y="session-name-input" label="name" value={name} onChangeText={setName} placeholder="Session name" />
            <Button kind="solid" a11y="session-name-save" label="Save name" onPress={async () => {
              try { await call("set_name", { processId: info.processId, name }); setRenaming(false); onClose(); } catch (e) { setError(errText(e)); }
            }} />
          </>
        ) : <Button kind="outline" compact a11y="session-rename" label="rename" style={{ alignSelf: "flex-start" }} onPress={() => setRenaming(true)} />}
      </View>
      <View style={{ marginTop: 12 }}>
        <Line k="folder" v={info.cwd} />
        <Line k="session file" v={info.sessionFile} />
        <Line k="session id" v={info.sessionId} />
        {r.kind === "subagent" ? <Line k="role" v={`subagent ${r.name}${r.agent ? ` · ${r.agent}` : ""}${r.autoExit ? " · exits when done" : ""}`} /> : null}
        {r.kind === "team_member" ? <Line k="role" v={`team member ${r.name}${r.agent ? ` · ${r.agent}` : ""} · ${r.write ? `writes ${r.branch ?? ""}` : "read-only"}`} /> : null}
        {r.kind === "team_member" ? <Line k="worktree" v={r.worktree} /> : null}
        <Line k="model" v={info.model ? `${info.model.provider}/${info.model.id}` : undefined} />
        <Line k="thinking" v={info.thinkingLevel} />
        <Line k="context" v={u ? `${u.percent !== null ? `${u.percent.toFixed(1)}%` : "?"} · ${u.tokens ?? "?"} / ${u.contextWindow}` : undefined} />
        <Line k="tmux pane" v={info.tmuxPane} />
        <Line k="pid" v={info.pid} />
        <Line k="pi" v={`${info.piVersion}${info.compat !== "ok" ? " · untested: dialogs stay on the computer" : ""}`} />
      </View>
      <View style={{ marginTop: 18, gap: 10 }}>
          {confirmKill ? (
            <>
              <Txt v="body">{closeText(info).body}</Txt>
              <Button kind="danger" a11y="session-shutdown-confirm" label="Close pi" onPress={async () => { try { await closeProcess(info); onClose(); } catch (e) { setError(errText(e)); } }} />
              <Button kind="outline" a11y="session-shutdown-cancel" label="keep it running" onPress={() => setConfirmKill(false)} />
            </>
          ) : <Button kind="danger" a11y="session-shutdown" label="Close this pi on the computer" arrow="■" onPress={() => setConfirmKill(true)} />}
      </View>
    </Sheet>
  );
}

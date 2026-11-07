import { useState } from "react";
import { View } from "react-native";
import type { ProcessInfo } from "@pi-remote/protocol";
import { call, errText } from "../net/connection";
import { Btn, Field, T } from "./kit";
import { Sheet } from "./Sheet";
import { usePalette } from "./theme";

function Row({ k, v }: { k: string; v?: string | number; copy?: boolean }) {
  if (v === undefined || v === "") return null;
  return (
    <View style={{ gap: 2 }}>
      <T dim size={12}>{k}</T>
      <T size={13} selectable mono>{String(v)}</T>
    </View>
  );
}

export function SessionInfoSheet({ info, onClose, renameFirst }: { info: ProcessInfo; onClose: () => void; renameFirst?: boolean }) {
  const c = usePalette();
  const [name, setName] = useState(info.sessionName ?? "");
  const [renaming, setRenaming] = useState(!!renameFirst);
  const [confirmKill, setConfirmKill] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const r = info.role;
  const canShutdown = info.spawnedByHostd || r.kind !== "main";
  const u = info.contextUsage;
  return (
    <Sheet visible a11y="session-sheet" title="Session" onClose={onClose}>
      {error ? <T color={c.danger}>{error}</T> : null}
      {renaming ? (
        <View style={{ gap: 8 }}>
          <Field a11y="session-name-input" value={name} onChangeText={setName} placeholder="Session name" />
          <Btn a11y="session-name-save" kind="primary" label="Save name" onPress={async () => {
            try { await call("set_name", { processId: info.processId, name }); setRenaming(false); onClose(); } catch (e) { setError(errText(e)); }
          }} />
        </View>
      ) : <Btn a11y="session-rename" label="Rename" onPress={() => setRenaming(true)} />}
      <Row k="Name" v={info.sessionName} />
      <Row k="Working directory" v={info.cwd} copy />
      <Row k="Session file" v={info.sessionFile} copy />
      <Row k="Session ID" v={info.sessionId} />
      {r.kind === "subagent" ? <Row k="Role" v={`Subagent ${r.name}${r.agent ? ` · agent ${r.agent}` : ""}${r.autoExit ? " · exits when done" : ""}`} /> : null}
      {r.kind === "team_member" ? <Row k="Role" v={`Member ${r.name}${r.agent ? ` · agent ${r.agent}` : ""} · ${r.write ? `writes branch ${r.branch ?? ""}` : "read-only"}`} /> : null}
      {r.kind === "team_member" ? <Row k="Worktree" v={r.worktree} copy /> : null}
      <Row k="Model" v={info.model ? `${info.model.provider}/${info.model.id}` : undefined} />
      <Row k="Thinking" v={info.thinkingLevel} />
      <Row k="Context" v={u ? `${u.percent !== null ? `${u.percent.toFixed(1)}%` : "?"} (${u.tokens ?? "?"} / ${u.contextWindow})` : undefined} />
      <Row k="tmux pane" v={info.tmuxPane} />
      <Row k="PID" v={info.pid} />
      <Row k="pi version" v={`${info.piVersion}${info.compat !== "ok" ? " (untested: dialogs are not mirrored)" : ""}`} />
      {canShutdown ? (
        confirmKill ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn a11y="session-shutdown-confirm" kind="danger" label="Yes, close it" onPress={async () => { try { await call("shutdown", { processId: info.processId }); onClose(); } catch (e) { setError(errText(e)); } }} />
            <Btn a11y="session-shutdown-cancel" label="Keep" onPress={() => setConfirmKill(false)} />
          </View>
        ) : <Btn a11y="session-shutdown" kind="danger" label="Close this pi process" onPress={() => setConfirmKill(true)} />
      ) : null}
    </Sheet>
  );
}

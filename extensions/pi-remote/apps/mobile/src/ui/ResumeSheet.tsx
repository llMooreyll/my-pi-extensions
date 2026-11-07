import { useEffect, useState } from "react";
import { ActivityIndicator } from "react-native";
import type { SessionListItem } from "@pi-remote/protocol";
import { relTime } from "../lib/format";
import { openProcess } from "../lib/nav";
import { call, errCode, errText } from "../net/connection";
import { Btn, T } from "./kit";
import { Option, Sheet } from "./Sheet";
import { usePalette } from "./theme";

export function ResumeSheet({ processId, cwd, currentFile, onClose }: { processId: string; cwd: string; currentFile?: string; onClose: () => void }) {
  const c = usePalette();
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
    <Sheet visible a11y="resume-sheet" title="Resume session" onClose={onClose}>
      <Btn small a11y="resume-scope" label={all ? "Show this project only" : "Show all projects"} onPress={() => setAll(!all)} />
      {error ? <T color={c.danger} a11y="resume-error">{error}</T> : null}
      {!items && !error ? <ActivityIndicator /> : null}
      {busy ? <ActivityIndicator /> : null}
      {items?.map((s, i) => (
        <Option key={s.sessionFile} a11y={`resume-item-${i}`} label={s.name || s.firstMessage || "(empty)"} selected={s.sessionFile === currentFile} disabled={busy}
          sub={`${all ? `${s.cwd} · ` : ""}${relTime(s.modified)} · ${s.messageCount} messages${s.liveProcessId ? " · running" : ""}`} onPress={() => void pick(s)} />
      ))}
    </Sheet>
  );
}

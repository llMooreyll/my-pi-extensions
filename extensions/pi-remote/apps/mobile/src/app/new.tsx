import { useEffect, useState } from "react";
import { View } from "react-native";
import type { ProjectItem, Trust } from "@pi-remote/protocol";
import { ErrorDialog } from "../ds/common";
import { Button, Choice, Field, Pad, Screen, SectionHead, Spinner, Toggle, Txt } from "../ds/primitives";
import { usePalette } from "../ds/tokens";
import { loadTrustMap, rememberTrust } from "../lib/credentials";
import { baseName, relTime } from "../lib/format";
import { openProcess } from "../lib/nav";
import { call, errCode, errText } from "../net/connection";
import { PathSuggest, expandHome } from "../session/PathSuggest";
import { useStore } from "../state/store";

/** Two decisions, in order, on one page: where pi should run, and whether to trust that folder. */
export default function NewSession() {
  const p = usePalette();
  const [projects, setProjects] = useState<ProjectItem[] | undefined>();
  const [cwd, setCwd] = useState("");
  const [trust, setTrust] = useState<Trust>("deny");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [home, setHome] = useState<string | undefined>();
  const conn = useStore((s) => s.conn);
  useEffect(() => { if (conn === "ready") call("list_projects", {}).then((r) => setProjects(r.projects), (e) => setError(errText(e))); }, [conn]);
  const dir = expandHome(cwd, home);
  useEffect(() => { loadTrustMap().then((m) => { const t = m[dir]; if (t) setTrust(t); }); }, [dir]);
  // Whether the typed folder exists; a new name means "create it, then start pi there".
  const [exists, setExists] = useState<boolean | undefined>();
  useEffect(() => {
    setExists(undefined);
    if (!dir.startsWith("/") || conn !== "ready") return;
    let live = true;
    const t = setTimeout(() => {
      call("list_dirs", { path: dir }).then(() => { if (live) setExists(true); }, (e) => { if (live && errCode(e) === "not_found") setExists(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [dir, conn]);

  const start = async () => {
    setBusy(true);
    try {
      let target = dir;
      if (exists === false) target = (await call("make_dir", { path: dir })).path;
      if (remember) await rememberTrust(target, trust);
      const r = await call("new_process", { cwd: target, trust }, 60_000);
      openProcess(r.processId);
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };

  const valid = dir.startsWith("/");
  const creating = valid && exists === false;
  return (
    <Screen back kicker="on the computer" title="New session"
      footer={<Button kind="solid" a11y="new-start" label={busy ? (creating ? "Creating the folder…" : "Starting pi…") : creating ? `Create ${baseName(dir)} and start pi` : valid ? `Start pi in ${baseName(dir)}` : "Choose a folder first"} busy={busy} disabled={!valid} onPress={() => void start()} />}>
      <SectionHead n="01" title="Where should pi work?" />
      <Pad indent style={{ paddingTop: 12 }}>
        <Field a11y="new-cwd-input" label="folder on the computer" value={cwd} onChangeText={setCwd} placeholder="~/ or /home/you/project" autoCapitalize="none" autoCorrect={false} mono />
        {creating ? (
          <View accessibilityLabel="new-will-create" style={{ marginTop: 8, borderLeftWidth: 2, borderLeftColor: p.blue, paddingLeft: 10 }}>
            <Txt v="label" color={p.blue}>new folder</Txt>
            <Txt v="small">{dir} does not exist yet. It is created when pi starts.</Txt>
          </View>
        ) : null}
        <PathSuggest value={cwd} onChange={setCwd} onHome={setHome} creating={creating} />
        {exists && cwd.endsWith("/") ? <Txt v="small" soft style={{ marginTop: 6 }}>Type a new name here to create a folder for pi.</Txt> : null}
      </Pad>
      <Pad indent style={{ paddingTop: 10 }}>
        <Txt v="label" soft style={{ marginBottom: 2 }}>or a recent project</Txt>
        {!projects && !error ? <Spinner /> : null}
        {projects?.slice(0, 20).map((pr, i) => (
          <Choice key={pr.cwd} a11y={`new-project-${i}`} label={baseName(pr.cwd)} sub={`${pr.cwd} · ${relTime(pr.lastModified)}`} selected={dir === pr.cwd} onPress={() => setCwd(pr.cwd)} />
        ))}
      </Pad>
      <SectionHead n="02" title="Trust the folder?" />
      <Pad indent style={{ paddingTop: 6 }}>
        <Choice a11y="new-trust-deny" label="Safe mode" sub="ignore the folder's own .pi extensions, skills and prompts" selected={trust === "deny"} onPress={() => setTrust("deny")} />
        <Choice a11y="new-trust-approve" label="Trust it" sub="load the folder's .pi resources (only for code you trust)" selected={trust === "approve"} onPress={() => setTrust("approve")} />
        <Toggle a11y="new-trust-remember" value={remember} onChange={setRemember} label="Remember this choice" hint="used next time you open a session in this folder" />
      </Pad>
      <View style={{ height: 20 }} />
      <ErrorDialog text={error} onClose={() => setError(undefined)} />
    </Screen>
  );
}

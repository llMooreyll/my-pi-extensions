import { Spinner } from "../ui/Spinner";
import { router, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import type { ProcessInfo, ProjectItem, SessionListItem } from "@pi-remote/protocol";
import { baseName, processTitle, relTime, roleBadge, statusLabel } from "../lib/format";
import { useOpenFlow } from "../lib/open";
import { call, errText } from "../net/connection";
import { useStore } from "../state/store";
import { ConnBar } from "../ui/ConnBar";
import { ErrorBox } from "../ui/ErrorBox";
import { Badge, Btn, Card, Section, T } from "../ui/kit";
import { TrustDialog } from "../ui/TrustDialog";
import { usePalette, type Palette } from "../ui/theme";

interface Node { info: ProcessInfo; children: Node[] }

/** Builds the parent/child tree; parents that are offline make the child top-level. Depth capped at 4. */
export function buildTree(procs: ProcessInfo[]): Node[] {
  const byId = new Map(procs.map((p) => [p.processId, { info: p, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const parent = n.info.parentProcessId ? byId.get(n.info.parentProcessId) : undefined;
    if (parent && parent !== n) parent.children.push(n); else roots.push(n);
  }
  const rank = (p: ProcessInfo) => (p.status === "waiting_ui" ? 0 : p.status === "running" ? 1 : 2);
  const sort = (ns: Node[]) => { ns.sort((a, b) => rank(a.info) - rank(b.info)); for (const n of ns) sort(n.children); };
  sort(roots);
  return roots;
}

function descendants(n: Node, seen = new Set<string>()): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const ch of n.children) {
    if (seen.has(ch.info.processId)) continue;
    seen.add(ch.info.processId);
    out.push(ch.info, ...descendants(ch, seen));
  }
  return out;
}

export function statusColor(c: Palette, p: ProcessInfo): string {
  return p.status === "waiting_ui" ? c.warn : p.status === "running" ? c.accent : c.dim;
}

function ProcRow({ node, depth }: { node: Node; depth: number }) {
  const c = usePalette();
  const p = node.info;
  const desc = descendants(node);
  const childWaiting = desc.filter((d) => d.status === "waiting_ui").length;
  const childRunning = desc.filter((d) => d.status === "running").length;
  const badge = roleBadge(p);
  return (
    <View style={{ marginLeft: depth * 16, borderLeftWidth: depth ? 2 : 0, borderLeftColor: c.border, paddingLeft: depth ? 8 : 0, gap: 8 }}>
      <Card a11y={`proc-${p.processId}`} onPress={() => router.push({ pathname: "/session/[processId]", params: { processId: p.processId } })} style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {badge ? <Badge label={badge} color={c.accent} /> : null}
          <Badge label={statusLabel(p)} color={statusColor(c, p)} a11y={`proc-status-${p.processId}`} />
          {childWaiting ? <Badge label={`Subtasks need input ${childWaiting}`} color={c.warn} /> : null}
          {childRunning ? <Badge label={`Subtasks running ${childRunning}`} color={c.accent} /> : null}
        </View>
        <T bold numberOfLines={1}>{processTitle(p)}</T>
        <T dim size={12} numberOfLines={1}>{baseName(p.cwd)} · {p.model ? p.model.id : "no model"}{p.compat !== "ok" ? " · untested pi version" : ""}</T>
        {p.lastText ? <T dim size={13} numberOfLines={2}>{p.lastText}</T> : null}
      </Card>
      {depth < 3 ? node.children.map((ch) => <ProcRow key={ch.info.processId} node={ch} depth={depth + 1} />) : null}
    </View>
  );
}

function ProjectRow({ p, onOpen, onNew }: { p: ProjectItem; onOpen: (s: SessionListItem) => void; onNew: (cwd: string) => void }) {
  const c = usePalette();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[] | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const load = useCallback(async () => {
    try { setSessions((await call("list_sessions", { cwd: p.cwd })).sessions); setErr(undefined); } catch (e) { setErr(errText(e)); }
  }, [p.cwd]);
  return (
    <Card a11y={`project-${baseName(p.cwd)}`} style={{ gap: 6 }} onPress={() => { setOpen(!open); if (!open) void load(); }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <T bold numberOfLines={1}>{baseName(p.cwd)}</T>
          <T dim size={12} numberOfLines={1}>{p.cwd} · {p.sessionCount} sessions · {relTime(p.lastModified)}</T>
        </View>
        <T dim>{open ? "▾" : "▸"}</T>
      </View>
      {open ? (
        <View style={{ gap: 6 }}>
          <Btn small a11y={`project-new-${baseName(p.cwd)}`} label="New session here" onPress={() => onNew(p.cwd)} />
          {err ? <T color={c.danger} size={13}>{err}</T> : null}
          {!sessions && !err ? <Spinner /> : null}
          {sessions?.slice(0, 30).map((s, i) => (
            <Card key={s.sessionFile} a11y={`session-item-${i}`} onPress={() => onOpen(s)} style={{ backgroundColor: c.cardAlt, padding: 10, gap: 2 }}>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                {s.liveProcessId ? <Badge label="Running" color={c.ok} /> : null}
                <T size={14} bold numberOfLines={1} style={{ flex: 1 }}>{s.name || s.firstMessage || "(empty)"}</T>
              </View>
              <T dim size={12}>{relTime(s.modified)} · {s.messageCount} messages</T>
            </Card>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

export default function Home() {
  const c = usePalette();
  const conn = useStore((s) => s.conn);
  const procsMap = useStore((s) => s.procs);
  const procs = useMemo(() => Object.values(procsMap), [procsMap]);
  const tree = useMemo(() => buildTree(procs), [procs]);
  const [projects, setProjects] = useState<ProjectItem[] | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const flow = useOpenFlow();

  useEffect(() => { if (conn === "no_credentials") router.push("/pair"); }, [conn]);

  const loadProjects = useCallback(async (refresh = false) => {
    try {
      if (refresh) await call("list_sessions", { refresh: true });
      setProjects((await call("list_projects", {})).projects);
    } catch { /* shown via conn bar */ }
  }, []);
  useEffect(() => { if (conn === "ready") void loadProjects(); }, [conn, loadProjects]);

  const openItem = (s: SessionListItem) => {
    if (s.liveProcessId) router.push({ pathname: "/session/[processId]", params: { processId: s.liveProcessId } });
    else void flow.openSession(s.sessionFile, s.cwd);
  };

  return (
    <>
      <Stack.Screen options={{
        headerRight: () => (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn small a11y="home-new" label="New" onPress={() => router.push("/new")} />
            <Btn small a11y="home-settings" label="Settings" onPress={() => router.push("/settings")} />
          </View>
        ),
      }} />
      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 96 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await loadProjects(true); setRefreshing(false); }} />}
      >
        <ConnBar />
        {flow.busy ? <Card a11y="home-busy" style={{ marginTop: 12, flexDirection: "row", gap: 8, alignItems: "center" }}><Spinner /><T>{flow.busy}</T></Card> : null}
        <Section title={`Running (${procs.length})`}>
          {procs.length === 0 ? <T dim a11y="home-no-procs">No pi process is running on the computer.</T> : null}
          {tree.map((n) => <ProcRow key={n.info.processId} node={n} depth={0} />)}
        </Section>
        <Section title="Projects">
          {!projects && conn === "ready" ? <Spinner /> : null}
          {projects?.map((p) => <ProjectRow key={p.cwd} p={p} onOpen={openItem} onNew={(cwd) => void flow.newProcess(cwd)} />)}
        </Section>
      </ScrollView>
      <TrustDialog {...flow.trustDialog} />
      <ErrorBox text={flow.error} onClose={flow.clearError} />
    </>
  );
}

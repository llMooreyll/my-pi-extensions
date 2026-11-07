import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ProcessInfo, ProjectItem, SessionListItem } from "@pi-remote/protocol";
import { ConnLine, ErrorDialog, TrustDialog } from "../ds/common";
import { Button, Field, Pad, Row, Rule, SectionHead, Spinner, StatusText, Txt } from "../ds/primitives";
import { F, GUTTER, MARGIN, usePalette } from "../ds/tokens";
import { baseName, plainPreview, processTitle, relTime } from "../lib/format";
import { openProcess } from "../lib/nav";
import { useOpenFlow } from "../lib/open";
import { useTestAction } from "../lib/test-hooks";
import { call } from "../net/connection";
import { useStore } from "../state/store";

interface Node { info: ProcessInfo; children: Node[] }

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

export function roleLine(p: ProcessInfo): string | undefined {
  if (p.role.kind === "subagent") return `subagent · ${p.role.name}${p.role.agent ? ` · ${p.role.agent}` : ""}`;
  if (p.role.kind === "team_member") return `team · ${p.role.name}${p.role.write ? ` · writes ${p.role.branch ?? ""}` : " · read-only"}`;
  return undefined;
}

const descendants = (n: Node): ProcessInfo[] => n.children.flatMap((c) => [c.info, ...descendants(c)]);

function ProcRows({ node, depth, index }: { node: Node; depth: number; index: string }) {
  const p = usePalette();
  const info = node.info;
  const desc = descendants(node);
  const subWaiting = desc.filter((d) => d.status === "waiting_ui").length;
  const role = roleLine(info);
  const accent = info.status === "waiting_ui" ? p.pink : info.status === "running" ? p.blue : undefined;
  return (
    <>
      <Row a11y={`proc-${info.processId}`} index={index} indexColor={accent} accent={accent} onPress={() => openProcess(info.processId)}
        style={depth ? { paddingLeft: depth * 18 } : undefined}
        trailing={<StatusText status={info.status} count={info.pendingUiCount} a11y={`proc-status-${info.processId}`} />}>
        {role ? <Txt v="label" color={p.blue}>{depth ? "↳ " : ""}{role}</Txt> : null}
        <Txt v={depth ? "lead" : "title"} lines={2}>{processTitle(info)}</Txt>
        <Txt v="mono" soft lines={1} style={{ fontSize: 11 }}>{baseName(info.cwd)} — {info.model?.id ?? "no model"}</Txt>
        {info.lastText ? <Txt v="small" soft lines={2}>{plainPreview(info.lastText)}</Txt> : null}
        {subWaiting ? <Txt v="label" color={p.pink}>● {subWaiting} subtask{subWaiting > 1 ? "s" : ""} need{subWaiting > 1 ? "" : "s"} you</Txt> : null}
      </Row>
      {depth < 3 ? node.children.map((c, i) => <ProcRows key={c.info.processId} node={c} depth={depth + 1} index={`${index}.${i + 1}`} />) : null}
    </>
  );
}

function FilterWord(props: { label: string; active: boolean; onPress: () => void; a11y: string }) {
  const p = usePalette();
  useTestAction(props.a11y, props.onPress);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.a11y} onPress={props.onPress} hitSlop={6}>
      <Txt v="label" color={props.active ? p.ink : p.soft} style={{ textDecorationLine: props.active ? "underline" : "none", fontFamily: props.active ? F.monoBold : F.mono }}>{props.label}</Txt>
    </Pressable>
  );
}

export default function Home() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const conn = useStore((s) => s.conn);
  const procsMap = useStore((s) => s.procs);
  const procs = useMemo(() => Object.values(procsMap), [procsMap]);
  const tree = useMemo(() => buildTree(procs), [procs]);
  const waiting = useMemo(() => procs.filter((x) => x.status === "waiting_ui"), [procs]);
  const [sessions, setSessions] = useState<SessionListItem[] | undefined>();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [filter, setFilter] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const flow = useOpenFlow();

  useEffect(() => { if (conn === "no_credentials") router.push("/pair"); }, [conn]);

  const load = useCallback(async (refresh = false) => {
    try {
      const [s, pr] = await Promise.all([call("list_sessions", refresh ? { refresh: true } : {}), call("list_projects", {})]);
      setSessions(s.sessions);
      setProjects(pr.projects);
    } catch { /* the connection line explains */ }
  }, []);
  useEffect(() => { if (conn === "ready") void load(); }, [conn, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sessions ?? [])
      .filter((s) => !filter || s.cwd === filter)
      .filter((s) => !q || `${s.name ?? ""} ${s.firstMessage} ${s.cwd}`.toLowerCase().includes(q))
      .slice(0, 40);
  }, [sessions, filter, query]);

  const open = (s: SessionListItem) => {
    if (s.liveProcessId) openProcess(s.liveProcessId);
    else void flow.openSession(s.sessionFile, s.cwd);
  };

  const today = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const running = procs.filter((x) => x.status === "running").length;

  return (
    <View style={{ flex: 1, backgroundColor: p.paper }}>
      <ScrollView
        style={{ marginTop: insets.top }}
        contentContainerStyle={{ paddingBottom: 120 + insets.bottom }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(true); setRefreshing(false); }} />}
        keyboardShouldPersistTaps="handled"
        stickyHeaderIndices={[1]}
      >
        <View>
          <Pad style={{ paddingTop: 18 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
              <Txt v="label" soft>{today}</Txt>
              <Button a11y="home-settings" label="settings" onPress={() => router.push("/settings")} />
            </View>
            <Txt v="display" style={{ marginTop: 10 }}>pi <Txt v="display" style={{ fontFamily: F.serifItalic }} color={p.pink}>remote</Txt></Txt>
            <Txt v="label" soft style={{ marginTop: 6 }}>{procs.length} live · {running} working · {waiting.length} waiting for you</Txt>
          </Pad>
          <Rule weight={2} style={{ marginTop: 14 }} />
          <ConnLine />
          <Rule />

          {flow.busy ? (
            <Pad style={{ paddingVertical: 14, flexDirection: "row", gap: 10 }}><Spinner color={p.blue} /><Txt v="label" color={p.blue} a11y="home-busy">{flow.busy}</Txt></Pad>
          ) : null}

          {waiting.length ? (
            <>
              <SectionHead n="!" title="Waiting for you" color={p.pink} right={<Txt v="label" color={p.pink}>{waiting.length}</Txt>} />
              {waiting.map((w) => (
                <Row key={w.processId} a11y={`needs-${w.processId}`} accent={p.pink} index="→" indexColor={p.pink} onPress={() => openProcess(w.processId)}>
                  <Txt v="lead" lines={1}>{processTitle(w)}</Txt>
                  <Txt v="small" color={p.pink}>{roleLine(w) ?? baseName(w.cwd)} — answer it here</Txt>
                </Row>
              ))}
            </>
          ) : null}

          <SectionHead n="01" title="Live on the computer" right={<Txt v="label" soft>{procs.length}</Txt>} />
          {procs.length === 0 ? (
            <Pad indent style={{ paddingVertical: 16 }}><Txt v="body" soft a11y="home-no-procs">Nothing is running. Reopen a session below or start a new one.</Txt></Pad>
          ) : tree.map((n, i) => <ProcRows key={n.info.processId} node={n} depth={0} index={String(i + 1).padStart(2, "0")} />)}

          <SectionHead n="02" title="Recent sessions" right={<Txt v="label" soft>{shown.length}{sessions && shown.length !== sessions.length ? ` of ${sessions.length}` : ""}</Txt>} />
        </View>

        {/* Sticky: search and folder filters stay on screen while the list scrolls. */}
        <View style={{ backgroundColor: p.paper, borderBottomWidth: 1, borderBottomColor: p.ink }}>
          <Pad indent style={{ paddingTop: 8 }}>
            <Field a11y="home-search" value={query} onChangeText={setQuery} placeholder="search words, names, folders" autoCapitalize="none" autoCorrect={false} />
          </Pad>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 16, paddingVertical: 12, paddingLeft: MARGIN + GUTTER, paddingRight: MARGIN }}>
            {[undefined, ...projects.slice(0, 14).map((x) => x.cwd)].map((cwd) => (
              <FilterWord key={cwd ?? "all"} label={cwd ? baseName(cwd) : "all"} active={filter === cwd} onPress={() => setFilter(cwd)} a11y={`filter-${cwd ? baseName(cwd) : "all"}`} />
            ))}
          </ScrollView>
        </View>

        <View>
          {!sessions && conn === "ready" ? <Pad indent style={{ paddingVertical: 14 }}><Spinner /></Pad> : null}
          {shown.map((s, i) => (
            <Row key={s.sessionFile} a11y={`session-item-${i}`} index={relTime(s.modified).replace(" ago", "")} onPress={() => open(s)} dense
              trailing={s.liveProcessId ? <Txt v="label" color={p.blue}>● live</Txt> : undefined}>
              <Txt v="body" lines={2}>{s.name || s.firstMessage || "(empty session)"}</Txt>
              <Txt v="mono" soft lines={1} style={{ fontSize: 11 }}>{baseName(s.cwd)} · {s.messageCount} messages</Txt>
            </Row>
          ))}
          {sessions && !shown.length ? <Pad indent style={{ paddingVertical: 14 }}><Txt v="small" soft>Nothing matches.</Txt></Pad> : null}
        </View>
      </ScrollView>

      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingBottom: insets.bottom, backgroundColor: p.ink }}>
        <Button kind="solid" a11y="home-new" label="Start a new session" arrow="+" onPress={() => router.push("/new")} disabled={conn !== "ready"} />
      </View>
      <TrustDialog {...flow.trustDialog} />
      <ErrorDialog text={flow.error} onClose={flow.clearError} />
    </View>
  );
}

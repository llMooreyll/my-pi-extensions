import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ProcessInfo, ProjectItem, SessionListItem } from "@pi-remote/protocol";
import { ConnStatus, ErrorDialog, TrustDialog } from "../ds/common";
import { Button, Field, Pad, Row, Spinner, StatusText, Txt } from "../ds/primitives";
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
  // Most recently active first (dialogs waiting on you are listed separately above).
  const sort = (ns: Node[]) => { ns.sort((a, b) => (b.info.lastActiveAt ?? 0) - (a.info.lastActiveAt ?? 0)); for (const n of ns) sort(n.children); };
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

/** A big number with a mono caption. Not scaled by the system font size, so the header row keeps its shape. */
function Figure({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <View style={{ alignItems: "flex-end" }}>
      <Text allowFontScaling={false} style={{ fontFamily: F.serif, color, fontSize: 30, lineHeight: 32 }}>{n}</Text>
      <Text allowFontScaling={false} style={{ fontFamily: F.mono, color, fontSize: 9.5, lineHeight: 13, letterSpacing: 1.2, textTransform: "uppercase" }}>{label}</Text>
    </View>
  );
}

/**
 * "pi/remote", sized to the room it has. Three plain Text siblings instead of nested spans (Android does not
 * shrink nested spans that carry their own size), and immune to the system font scale, which on a phone with
 * large text pushed "remote" out of the row. The width factor is measured for Instrument Serif with a margin.
 */
const TITLE_EM = 3.4;
function AppTitle({ room }: { room: number }) {
  const p = usePalette();
  const size = room > 0 ? Math.max(24, Math.min(46, Math.floor(room / TITLE_EM))) : 38;
  const t = { fontSize: size, lineHeight: Math.round(size * 1.08) };
  return (
    <View accessibilityLabel="home-title" style={{ flexDirection: "row", alignItems: "baseline" }}>
      <Text allowFontScaling={false} style={[t, { fontFamily: F.serif, color: p.ink, letterSpacing: -0.5 }]}>pi</Text>
      <Text allowFontScaling={false} style={[t, { fontFamily: F.serif, color: p.faint, marginHorizontal: size * 0.02 }]}>/</Text>
      <Text allowFontScaling={false} style={[t, { fontFamily: F.serifItalic, color: p.pink }]}>remote</Text>
    </View>
  );
}

/**
 * A section heading: a square marker and a large serif title in the section's colour, the count at the
 * right, and a heavy rule in the same colour. Typography and colour carry the weight; no filled band.
 */
function Heading({ title, count, total, color, rule, a11y, top = 30 }: { title: string; count: number; total?: number; color: string; rule: string; a11y: string; top?: number }) {
  const p = usePalette();
  return (
    <View accessibilityLabel={a11y} style={{ paddingTop: top, paddingHorizontal: MARGIN, backgroundColor: p.paper }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ width: 10, height: 10, backgroundColor: color }} />
        <Txt v="headline" color={color} style={{ flex: 1, fontFamily: F.serifItalic, fontSize: 29, lineHeight: 34 }}>{title}</Txt>
        <Txt v="label" color={color} style={{ fontFamily: F.monoBold, fontSize: 12 }}>{count}{total !== undefined ? ` / ${total}` : ""}</Txt>
      </View>
      <View style={{ height: 2, backgroundColor: rule, marginTop: 8 }} />
    </View>
  );
}

function FilterWord(props: { label: string; active: boolean; onPress: () => void; a11y: string }) {
  const p = usePalette();
  useTestAction(props.a11y, props.onPress);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.a11y} onPress={props.onPress} hitSlop={4}
      style={{ paddingHorizontal: 8, paddingVertical: 4, backgroundColor: props.active ? p.ink : "transparent", borderWidth: 1, borderColor: props.active ? p.ink : p.faint }}>
      <Txt v="label" color={props.active ? p.invert : p.soft} style={{ fontFamily: props.active ? F.monoBold : F.mono, textTransform: "none" }}>{props.label}</Txt>
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
  const [titleRoom, setTitleRoom] = useState(0);
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
  // Coming back from a session: its place in "Recent" has changed.
  useFocusEffect(useCallback(() => { if (useStore.getState().conn === "ready") void load(); }, [load]));

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

  const running = procs.filter((x) => x.status === "running").length;

  return (
    <View style={{ flex: 1, backgroundColor: p.paper }}>
      <ScrollView
        style={{ marginTop: insets.top }}
        contentContainerStyle={{ paddingBottom: 120 + insets.bottom }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(true); setRefreshing(false); }} />}
        keyboardShouldPersistTaps="handled"
        // 1 waiting heading, 3 live heading, 5 recent heading with search and filters.
        stickyHeaderIndices={[1, 3, 5]}
      >
        <View>
          <Pad style={{ paddingTop: 14, paddingBottom: 4, gap: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}>
              <View style={{ flex: 1, marginRight: 10 }} onLayout={(e) => setTitleRoom(e.nativeEvent.layout.width)}>
                <AppTitle room={titleRoom} />
              </View>
              <View style={{ flexDirection: "row", gap: 12, paddingBottom: 4, marginLeft: 10 }}>
                <Figure n={procs.length} label="live" color={p.ink} />
                <Figure n={running} label="working" color={running ? p.blue : p.faint} />
                <Figure n={waiting.length} label="need you" color={waiting.length ? p.pink : p.faint} />
              </View>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <View style={{ flex: 1 }}><ConnStatus /></View>
              <Button kind="outline" compact a11y="home-settings" label="settings" onPress={() => router.push("/settings")} />
            </View>
          </Pad>

          {flow.busy ? (
            <Pad style={{ paddingVertical: 14, flexDirection: "row", gap: 10 }}><Spinner color={p.blue} /><Txt v="label" color={p.blue} a11y="home-busy">{flow.busy}</Txt></Pad>
          ) : null}

        </View>

        {/* Section headings are direct children of the scroll view so they can pin to the top (indices below). */}
        {waiting.length ? <Heading title="Waiting for you" count={waiting.length} color={p.pink} rule={p.pink} a11y="band-waiting" top={18} /> : <View />}
        <View>
          {waiting.map((w) => (
            <Row key={w.processId} a11y={`needs-${w.processId}`} accent={p.pink} index="→" indexColor={p.pink} onPress={() => openProcess(w.processId)}>
              <Txt v="lead" lines={1}>{processTitle(w)}</Txt>
              <Txt v="small" color={p.pink}>{roleLine(w) ?? baseName(w.cwd)} — answer it here</Txt>
            </Row>
          ))}
        </View>

        <Heading title="Live on the computer" count={procs.length} color={p.blue} rule={p.blue} a11y="band-live" top={waiting.length ? 30 : 18} />
        <View>
          {procs.length === 0 ? (
            <Pad indent style={{ paddingVertical: 16 }}><Txt v="body" soft a11y="home-no-procs">Nothing is running. Reopen a session below or start a new one.</Txt></Pad>
          ) : tree.map((n, i) => <ProcRows key={n.info.processId} node={n} depth={0} index={String(i + 1).padStart(2, "0")} />)}
          <View style={{ height: 8 }} />
        </View>

        {/* Sticky: the Recent heading, search and folder filters stay on screen while the list scrolls. */}
        <View style={{ backgroundColor: p.paper, borderBottomWidth: 1, borderBottomColor: p.ink }}>
          <Heading title="Recent sessions" count={shown.length} total={sessions && shown.length !== sessions.length ? sessions.length : undefined} color={p.ink} rule={p.ink} a11y="band-recent" top={22} />
          <Pad indent style={{ paddingTop: 8 }}>
            <Field a11y="home-search" value={query} onChangeText={setQuery} placeholder="search words, names, folders" autoCapitalize="none" autoCorrect={false} />
          </Pad>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 10, paddingLeft: MARGIN + GUTTER, paddingRight: MARGIN }}>
            {[undefined, ...projects.slice(0, 14).map((x) => x.cwd)].map((cwd) => (
              <FilterWord key={cwd ?? "all"} label={cwd ? baseName(cwd) : "all"} active={filter === cwd} onPress={() => setFilter(cwd)} a11y={`filter-${cwd ? baseName(cwd) : "all"}`} />
            ))}
          </ScrollView>
        </View>

        <View>
          {!sessions && conn === "ready" ? <Pad indent style={{ paddingVertical: 14 }}><Spinner /></Pad> : null}
          {shown.map((s, i) => (
            <Row key={s.sessionFile} a11y={`session-item-${i}`} index={relTime(s.modified).replace(" ago", "")} indexStyle={{ textTransform: "none" }} onPress={() => open(s)} dense
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

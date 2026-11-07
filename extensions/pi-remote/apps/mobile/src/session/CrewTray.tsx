import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { ProcessInfo } from "@pi-remote/protocol";
import { Txt } from "../ds/primitives";
import { F, MARGIN, STATUS_WORD, statusColor, usePalette } from "../ds/tokens";
import { processTitle } from "../lib/format";
import { openProcess } from "../lib/nav";
import { useTestAction } from "../lib/test-hooks";

const glyph = (s: ProcessInfo["status"]) => (s === "idle" ? "○" : s === "running" ? "▶" : "◆");
const shortModel = (m?: { name?: string; id: string }) => (m ? (m.name || m.id).replace(/^.*\//, "") : "");

function Member({ c, below }: { c: ProcessInfo; below: number }) {
  const p = usePalette();
  const open = () => openProcess(c.processId);
  useTestAction(`child-${c.processId}`, open);
  const color = statusColor(p, c.status);
  const role = c.role;
  const name = role.kind === "main" ? processTitle(c) : role.name;
  const pct = c.contextUsage?.percent;
  const tag = role.kind === "team_member" ? (role.write ? "worktree" : "read-only") : undefined;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`child-${c.processId}`} onPress={open}
      style={({ pressed }) => ({ width: 176, backgroundColor: pressed ? p.tint : "transparent", borderLeftWidth: 3, borderLeftColor: color, paddingLeft: 10, paddingRight: 8, paddingVertical: 2, gap: 3 })}>
      <Txt v="label" color={color} style={{ fontFamily: c.status === "idle" ? F.mono : F.monoBold, fontSize: 10.5 }}>
        {glyph(c.status)} {STATUS_WORD[c.status]}{c.pendingUiCount ? `  ·  ${c.pendingUiCount} question${c.pendingUiCount > 1 ? "s" : ""}` : ""}
      </Txt>
      <Txt v="bodyBold" lines={1} style={{ fontSize: 15, lineHeight: 20 }}>{name}</Txt>
      <Txt v="mono" soft lines={1} style={{ fontSize: 10.5, lineHeight: 14 }}>
        {[role.kind !== "main" ? role.agent : undefined, tag, below ? `+${below} below` : undefined].filter(Boolean).join(" · ") || "main session"}
      </Txt>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Txt v="mono" faint lines={1} style={{ fontSize: 10, flexShrink: 1 }}>{shortModel(c.model)}</Txt>
        {pct != null ? (
          <View style={{ flex: 1, minWidth: 18, height: 2, backgroundColor: p.faint }}>
            <View style={{ height: 2, width: `${Math.max(3, Math.min(100, pct))}%`, backgroundColor: pct > 80 ? p.danger : p.soft }} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * The people working under this session, one card each, above the composer. It reads the real process
 * list (so it is the same for a team and for plain subagents) instead of the extensions' text banners.
 */
export function CrewTray({ children, all }: { children: ProcessInfo[]; all: ProcessInfo[] }) {
  const p = usePalette();
  const [folded, setFolded] = useState(false);
  useTestAction("crew-toggle", () => setFolded((f) => !f));
  if (!children.length) return null;
  const team = children.some((c) => c.role.kind === "team_member");
  const count = (s: ProcessInfo["status"]) => children.filter((c) => c.status === s).length;
  const working = count("running"), asking = count("waiting_ui"), idle = count("idle");
  const countBelow = (id: string): number => all.filter((x) => x.parentProcessId === id).reduce((n, x) => n + 1 + countBelow(x.processId), 0);
  return (
    <View accessibilityLabel="crew-tray" style={{ borderTopWidth: 1, borderTopColor: p.ink, paddingTop: 8, paddingBottom: 8, gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="crew-toggle" onPress={() => setFolded(!folded)} hitSlop={6}
        style={{ flexDirection: "row", alignItems: "baseline", gap: 10, paddingHorizontal: MARGIN }}>
        <Txt v="label" style={{ fontFamily: F.monoBold }}>{team ? "TEAM" : "SUBAGENTS"}</Txt>
        <Txt v="label" soft>{children.length}</Txt>
        <View style={{ flex: 1, flexDirection: "row", gap: 10 }}>
          {asking ? <Txt v="label" color={p.pink} style={{ fontFamily: F.monoBold }}>◆ {asking} need you</Txt> : null}
          {working ? <Txt v="label" color={p.blue} style={{ fontFamily: F.monoBold }}>▶ {working} working</Txt> : null}
          {idle ? <Txt v="label" soft>○ {idle} idle</Txt> : null}
        </View>
        <Txt v="label" soft>{folded ? "show" : "hide"}</Txt>
      </Pressable>
      {folded ? null : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingHorizontal: MARGIN }}>
          {children.map((c) => <Member key={c.processId} c={c} below={countBelow(c.processId)} />)}
        </ScrollView>
      )}
    </View>
  );
}

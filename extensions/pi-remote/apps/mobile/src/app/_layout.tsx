import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import { View } from "react-native";
import { FONT_FILES, usePalette } from "../ds/tokens";
import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { router } from "expo-router";
import { installNotifications, notifyFiles, onProc, setForegroundExtra, syncForeground } from "../bg/notifications";
import { initialNotificationIsFiles, initialNotificationProcessId } from "../bg/platform";
import { installTestHooks, setDumpProvider } from "../lib/test-hooks";
import { connection } from "../net/connection";
import { installSync } from "../net/sync";
import { useStore } from "../state/store";
import { dumpTransfers, installTransfers, setTransferHooks, transferSummary } from "../state/transfers";

let booted = false;
function boot(): void {
  if (booted) return;
  booted = true;
  installTestHooks();
  setDumpProvider(dumpState);
  installSync();
  installNotifications();
  connection.onProcFrame((f) => { if (f.t === "proc") onProc(f.kind, f.info); });
  let fgAt = 0;
  setForegroundExtra(transferSummary);
  setTransferHooks({
    notify: (title, body) => { void notifyFiles(title, body); },
    // Progress changes often; refresh the ongoing notification at most once a second.
    changed: (force) => { const now = Date.now(); if (force || now - fgAt > 1000) { fgAt = now; syncForeground(); } },
  });
  installTransfers();
  connection.start();
}

/** Compact store summary for PIREMOTE_TEST dumps (plan 5.3 item 7). */
function dumpState(): unknown {
  const s = useStore.getState();
  const pid = s.activeProcessId;
  const v = pid ? s.views[pid] : undefined;
  const last = v?.messages[v.messages.length - 1];
  return {
    conn: s.conn, via: s.via ?? null, lastError: s.lastError ?? null, hostName: s.hostName ?? null, features: s.features ?? [],
    transfers: dumpTransfers(),
    processes: Object.values(s.procs).map((p) => ({ processId: p.processId, status: p.status, role: p.role.kind, parentProcessId: p.parentProcessId ?? null, sessionName: p.sessionName ?? null, model: p.model?.id ?? null, thinking: p.thinkingLevel })),
    active: pid ?? null,
    view: v ? {
      seq: v.seq, status: v.info.status, messages: v.messages.length, lastRole: last?.role ?? null,
      lastText: last ? JSON.stringify(last.content ?? last.summary ?? "").slice(0, 200) : null,
      inflight: !!v.inflight, pendingUi: v.pendingUi.map((u) => ({ uiId: u.uiId, kind: u.kind })), pendingRpiv: v.pendingRpiv.map((p) => p.toolCallId),
      extWidgets: Object.keys(v.extWidgets), resyncing: !!v.resyncing, gone: !!v.gone,
    } : null,
  };
}

export default function RootLayout() {
  const c = usePalette();
  const [fontsLoaded] = useFonts(FONT_FILES);
  useEffect(() => {
    boot();
    initialNotificationIsFiles().then((files) => { if (files) router.push("/files"); }).catch(() => {});
    initialNotificationProcessId().then((pid) => {
      if (pid) router.push({ pathname: "/session/[processId]", params: { processId: pid } });
    }).catch(() => {});
  }, []);
  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: c.paper }} />;
  return (
    <>
      <StatusBar style={c.scheme === "light" ? "dark" : "light"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.paper }, animation: "fade_from_bottom" }} />
    </>
  );
}

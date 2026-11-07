import { Stack } from "expo-router";
import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import notifee from "react-native-notify-kit";
import { router } from "expo-router";
import { installNotifications, onProc } from "../bg/notifications";
import { installTestHooks, setDumpProvider } from "../lib/test-hooks";
import { connection } from "../net/connection";
import { installSync } from "../net/sync";
import { useStore } from "../state/store";
import { usePalette } from "../ui/theme";

let booted = false;
function boot(): void {
  if (booted) return;
  booted = true;
  installTestHooks();
  setDumpProvider(dumpState);
  installSync();
  installNotifications();
  connection.onProcFrame((f) => { if (f.t === "proc") onProc(f.kind, f.info); });
  connection.start();
}

/** Compact store summary for PIREMOTE_TEST dumps (plan 5.3 item 7). */
function dumpState(): unknown {
  const s = useStore.getState();
  const pid = s.activeProcessId;
  const v = pid ? s.views[pid] : undefined;
  const last = v?.messages[v.messages.length - 1];
  return {
    conn: s.conn, via: s.via ?? null, lastError: s.lastError ?? null, hostName: s.hostName ?? null,
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
  useEffect(() => {
    boot();
    notifee.getInitialNotification().then((n) => {
      const pid = n?.notification?.data?.processId;
      if (typeof pid === "string") router.push({ pathname: "/session/[processId]", params: { processId: pid } });
    }).catch(() => {});
  }, []);
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerStyle: { backgroundColor: c.card }, headerTintColor: c.text, contentStyle: { backgroundColor: c.bg }, headerTitleStyle: { fontSize: 17 } }}>
        <Stack.Screen name="index" options={{ title: "pi-remote" }} />
        <Stack.Screen name="pair" options={{ title: "Pair with computer" }} />
        <Stack.Screen name="new" options={{ title: "New session" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="history" options={{ title: "Session (read-only)" }} />
        <Stack.Screen name="session/[processId]" options={{ title: "" }} />
      </Stack>
    </>
  );
}

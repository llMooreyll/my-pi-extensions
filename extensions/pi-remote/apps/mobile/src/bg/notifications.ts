import notifee, { EventType, type Event } from "react-native-notify-kit";
import { router } from "expo-router";
import type { ProcessInfo } from "@pi-remote/protocol";
import { DEFAULT_PREFS, loadPrefs, type AppPrefs } from "../lib/credentials";
import { testLog } from "../lib/test-hooks";
import { useStore } from "../state/store";
import { EVENTS_CHANNEL, ensureChannels, startForeground, stopForeground } from "./foreground";

const last = new Map<string, ProcessInfo>();
const lastSent = new Map<string, number>();
let prefs: AppPrefs = DEFAULT_PREFS;
/** Extra status for the foreground notification (file transfers); set by state/transfers via setForegroundExtra. */
let fgExtra: () => string | undefined = () => undefined;
export function setForegroundExtra(fn: () => string | undefined): void { fgExtra = fn; }

export async function reloadPrefs(): Promise<AppPrefs> { prefs = await loadPrefs(); syncForeground(); return prefs; }

export const displayName = (i: ProcessInfo) => i.sessionName || i.cwd.split("/").filter(Boolean).pop() || i.cwd;

function roleLabel(i: ProcessInfo): string | undefined {
  if (i.role.kind === "subagent") return `Subagent ${i.role.name}`;
  if (i.role.kind === "team_member") return `Member ${i.role.name}`;
  return undefined;
}

async function notify(key: string, processId: string, title: string, body: string): Promise<void> {
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < 10_000) return;
  lastSent.set(key, now);
  const st = useStore.getState();
  if (st.appActive && st.activeProcessId === processId) return;
  await ensureChannels();
  testLog("notify", { title, body, processId });
  await notifee.displayNotification({
    title, body: body || " ",
    data: { processId },
    android: { channelId: EVENTS_CHANNEL, pressAction: { id: "default", launchActivity: "default" }, smallIcon: "ic_launcher" },
  });
}

/** Compare with the previous info of the same process and raise "needs input" / "finished" notifications. */
export function onProc(kind: "up" | "down" | "changed", info: ProcessInfo): void {
  const prev = last.get(info.processId);
  if (kind === "down") { last.delete(info.processId); syncForeground(); return; }
  last.set(info.processId, info);
  syncForeground();
  if (!prev) return;
  const role = roleLabel(info);
  const needsInput = (info.status === "waiting_ui" && prev.status !== "waiting_ui") || info.pendingUiCount > prev.pendingUiCount;
  if (needsInput) {
    void notify(`ui:${info.processId}`, info.processId, role ? `${role} needs input` : "Needs input", displayName(info));
  } else if (prev.status === "running" && info.status === "idle") {
    if (info.role.kind !== "main" && !prefs.notifyChildDone) return;
    void notify(`done:${info.processId}`, info.processId, role ? `${role} finished` : "Finished", info.lastText ?? displayName(info));
  }
}

/** Foreground service body: "N running · M waiting". Starts/stops the service with the connection and preference. */
export function syncForeground(): void {
  const st = useStore.getState();
  const procs = Object.values(st.procs);
  const running = procs.filter((p) => p.status === "running").length;
  const waiting = procs.filter((p) => p.status === "waiting_ui").length;
  const want = prefs.keepAlive && st.conn !== "no_credentials" && !!st.host;
  // stopForeground is queued behind any pending start and checks the real state itself.
  if (!want) { void stopForeground(); return; }
  const extra = st.conn === "ready" ? fgExtra() : undefined;
  const body = extra ?? (st.conn === "ready" ? `${running} running · ${waiting} waiting for input` : st.conn === "backoff" ? "Reconnecting…" : "Connecting…");
  void startForeground(body).catch(() => {});
}

/** File transfer notices; tapping opens the Files page. */
export async function notifyFiles(title: string, body: string): Promise<void> {
  const key = `file:${title}:${body}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < 10_000) return;
  lastSent.set(key, now);
  await ensureChannels();
  testLog("notify", { title, body, files: true });
  await notifee.displayNotification({
    title, body: body || " ",
    data: { files: "1" },
    android: { channelId: EVENTS_CHANNEL, pressAction: { id: "default", launchActivity: "default" }, smallIcon: "ic_launcher" },
  });
}

function onEvent({ type, detail }: Event): void {
  if (type !== EventType.PRESS) return;
  if (detail.notification?.data?.files === "1") { try { router.push("/files"); } catch { /* router not ready */ } return; }
  const pid = detail.notification?.data?.processId;
  if (typeof pid === "string" && pid) {
    try { router.push({ pathname: "/session/[processId]", params: { processId: pid } }); } catch { /* router not ready */ }
  }
}

let installed = false;
export function installNotifications(): void {
  if (installed) return;
  installed = true;
  notifee.onForegroundEvent(onEvent);
  notifee.onBackgroundEvent(async (e) => onEvent(e));
  void reloadPrefs();
  useStore.subscribe((s, p) => { if (s.conn !== p.conn || s.host !== p.host) syncForeground(); });
}

export async function requestNotificationPermission(): Promise<void> {
  try { await notifee.requestPermission(); } catch { /* ignore */ }
}

import notifee, { AndroidForegroundServiceType, AndroidImportance } from "react-native-notify-kit";

export const CONN_CHANNEL = "pi-remote-conn";
export const EVENTS_CHANNEL = "pi-remote-events";
const FG_ID = "pi-remote-fg";

let stopResolver: (() => void) | undefined;
let running = false;
let lastBody = "";

/** The connection lives in the JS singleton; the runner only keeps the service alive. */
export function foregroundRunner(): Promise<void> {
  return new Promise<void>((resolve) => { stopResolver = resolve; });
}

export async function ensureChannels(): Promise<void> {
  await notifee.createChannel({ id: CONN_CHANNEL, name: "Connection status", importance: AndroidImportance.LOW });
  await notifee.createChannel({ id: EVENTS_CHANNEL, name: "pi events", importance: AndroidImportance.HIGH });
}

export async function startForeground(body: string): Promise<void> {
  if (running && body === lastBody) return;
  await ensureChannels();
  lastBody = body;
  running = true;
  await notifee.displayNotification({
    id: FG_ID,
    title: "pi-remote",
    body,
    android: {
      channelId: CONN_CHANNEL,
      asForegroundService: true,
      foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING],
      ongoing: true,
      onlyAlertOnce: true,
      pressAction: { id: "default" },
    },
  });
}

export async function stopForeground(): Promise<void> {
  if (!running) return;
  running = false;
  lastBody = "";
  await notifee.stopForegroundService();
  stopResolver?.();
  stopResolver = undefined;
}

export const isForegroundRunning = () => running;

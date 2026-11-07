export const CONN_CHANNEL = "pi-remote-conn";
export const EVENTS_CHANNEL = "pi-remote-events";
export function foregroundRunner(): Promise<void> { return Promise.resolve(); }
export async function ensureChannels(): Promise<void> {}
export async function startForeground(_body: string): Promise<void> {}
export async function stopForeground(): Promise<void> {}
export const isForegroundRunning = () => false;

import type { ProcessInfo } from "@pi-remote/protocol";
import { loadPrefs, type AppPrefs } from "../lib/credentials";

export const displayName = (i: ProcessInfo) => i.sessionName || i.cwd.split("/").filter(Boolean).pop() || i.cwd;
export async function reloadPrefs(): Promise<AppPrefs> { return loadPrefs(); }
export function onProc(_kind: "up" | "down" | "changed", _info: ProcessInfo): void {}
export function syncForeground(): void {}
export function installNotifications(): void {}
export async function requestNotificationPermission(): Promise<void> {}

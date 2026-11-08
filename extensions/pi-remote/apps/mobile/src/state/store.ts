import { create } from "zustand";
import type { BridgeEvent, OpResult, ProcessInfo } from "@pi-remote/protocol";
import type { SavedHost } from "../lib/credentials";
import { applyEvent, fromSnapshot } from "./view-reducer";
import type { ProcessView, Queued } from "./types";

export type ConnState = "no_credentials" | "connecting" | "ready" | "backoff";
const MAX_VIEWS = 5;

export interface AppState {
  conn: ConnState;
  via?: "direct" | "relay";
  lastError?: string;
  hostName?: string;
  hostVersion?: string;
  host?: SavedHost;
  procs: Record<string, ProcessInfo>;
  views: Record<string, ProcessView>;
  /** processId of the session page currently on screen (for notification suppression). */
  activeProcessId?: string;
  appActive: boolean;
}

export const useStore = create<AppState>(() => ({ conn: "connecting", procs: {}, views: {}, appActive: true }));

/** Hook for resync requests; set by net/sync.ts to avoid an import cycle. */
let resyncHandler: (pid: string) => void = () => {};
export function setResyncHandler(fn: (pid: string) => void): void { resyncHandler = fn; }
let unsubscribeHandler: (pid: string) => void = () => {};
export function setUnsubscribeHandler(fn: (pid: string) => void): void { unsubscribeHandler = fn; }

const set = useStore.setState;
const get = useStore.getState;

export const store = {
  setConn(conn: ConnState) { set({ conn }); },
  setVia(via: "direct" | "relay" | undefined) { set({ via }); },
  setLastError(lastError: string | undefined) { set({ lastError }); },
  setHostInfo(hostName: string, hostVersion: string) { set({ hostName, hostVersion }); },
  setHost(host: SavedHost | undefined) { set({ host }); },
  setActive(activeProcessId: string | undefined) { set({ activeProcessId }); },
  setAppActive(appActive: boolean) { set({ appActive }); },

  clearProcs() { set({ procs: {} }); },

  onProc(kind: "up" | "down" | "changed", info: ProcessInfo) {
    const procs = { ...get().procs };
    const views = get().views;
    if (kind === "down") {
      delete procs[info.processId];
      const v = views[info.processId];
      set({ procs, ...(v ? { views: { ...views, [info.processId]: { ...v, gone: true, info } } } : {}) });
      return;
    }
    procs[info.processId] = info;
    const v = views[info.processId];
    set({ procs, ...(v && v.gone ? { views: { ...views, [info.processId]: { ...v, gone: false } } } : {}) });
  },

  subscribedProcessIds(): string[] { return Object.keys(get().views).filter((p) => !get().views[p]!.gone); },
  view(pid: string): ProcessView | undefined { return get().views[pid]; },

  markResyncing(pid: string) {
    const v = get().views[pid];
    if (v) set({ views: { ...get().views, [pid]: { ...v, resyncing: true } } });
  },

  onSubscribed(pid: string, r: OpResult<"subscribe">) {
    const views = { ...get().views };
    if (r.mode === "snapshot") {
      const prev = views[pid];
      views[pid] = { ...fromSnapshot(r.snapshot), queued: prev?.queued ?? [], lastViewedAt: prev?.lastViewedAt ?? Date.now() };
      // Keep the process list in sync with the freshest info. The parent link is derived by hostd and
      // not part of what the bridge reports, so a snapshot must not wipe it (it made children fall out of the tree).
      const parent = r.snapshot.info.parentProcessId ?? get().procs[pid]?.parentProcessId;
      const lastActiveAt = Math.max(r.snapshot.info.lastActiveAt ?? 0, get().procs[pid]?.lastActiveAt ?? 0) || undefined;
      const fresh = { ...r.snapshot.info, ...(parent ? { parentProcessId: parent } : {}), ...(lastActiveAt ? { lastActiveAt } : {}) };
      views[pid] = { ...views[pid]!, info: fresh };
      set({ views, procs: { ...get().procs, [pid]: fresh } });
    } else {
      const v = views[pid];
      if (v) views[pid] = { ...v, resyncing: false };
      set({ views });
    }
    this.trimViews();
  },

  dropView(pid: string) {
    const views = { ...get().views };
    delete views[pid];
    set({ views });
  },

  addQueued(pid: string, q: Queued) {
    const v = get().views[pid];
    if (v) set({ views: { ...get().views, [pid]: { ...v, queued: [...v.queued, q] } } });
  },

  removeQueued(pid: string, id: string) {
    const v = get().views[pid];
    if (v && v.queued.some((q) => q.id === id)) set({ views: { ...get().views, [pid]: { ...v, queued: v.queued.filter((q) => q.id !== id) } } });
  },

  touchView(pid: string) {
    const v = get().views[pid];
    if (v) set({ views: { ...get().views, [pid]: { ...v, lastViewedAt: Date.now() } } });
  },

  trimViews() {
    const entries = Object.entries(get().views).sort((a, b) => b[1].lastViewedAt - a[1].lastViewedAt);
    if (entries.length <= MAX_VIEWS) return;
    const active = get().activeProcessId;
    const drop = entries.slice(MAX_VIEWS).filter(([pid]) => pid !== active).map(([pid]) => pid);
    if (!drop.length) return;
    const views = { ...get().views };
    for (const pid of drop) { delete views[pid]; unsubscribeHandler(pid); }
    set({ views });
  },

  applyEvents(q: { processId: string; seq: number; ev: BridgeEvent }[]) {
    if (!q.length) return;
    const views = { ...get().views };
    const resync = new Set<string>();
    let changed = false;
    for (const { processId, seq, ev } of q) {
      const v = views[processId];
      if (!v || v.resyncing) continue;
      if (seq <= v.seq) continue;
      if (seq > v.seq + 1) { views[processId] = { ...v, resyncing: true }; resync.add(processId); changed = true; continue; }
      const r = applyEvent(v, ev, seq);
      views[processId] = r.view;
      changed = true;
      if (r.needsResync) { views[processId] = { ...r.view, resyncing: true }; resync.add(processId); }
    }
    if (changed) set({ views });
    for (const pid of resync) resyncHandler(pid);
  },

  dismissToast(pid: string, id: string) {
    const v = get().views[pid];
    if (v) set({ views: { ...get().views, [pid]: { ...v, toasts: v.toasts.filter((t) => t.id !== id) } } });
  },

  prependHistory(pid: string, messages: ProcessView["messages"], hasMoreBefore: boolean) {
    const v = get().views[pid];
    if (v) set({ views: { ...get().views, [pid]: { ...v, messages: [...messages, ...v.messages], hasMoreBefore } } });
  },

  /** Local, app-originated notice shown like a pi notification. */
  toast(pid: string, text: string, level = "info") {
    const v = get().views[pid];
    if (v) set({ views: { ...get().views, [pid]: { ...v, toasts: [...v.toasts, { id: `l${Date.now()}`, text, level, at: Date.now() }] } } });
  },

  /** Optimistically hide a dialog card after answering; ui_closed removes it for real. */
  markUiAnswered(pid: string, uiId: string) {
    const v = get().views[pid];
    if (v) set({ views: { ...get().views, [pid]: { ...v, pendingUi: v.pendingUi.filter((u) => u.uiId !== uiId) } } });
  },
};

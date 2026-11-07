import { OP_TIMEOUT_MS } from "@pi-remote/protocol";
import { setResyncHandler, setUnsubscribeHandler, store, useStore } from "../state/store";
import { call, connection } from "./connection";

const inflight = new Set<string>();

/** Subscribe (or re-subscribe) to a process; sinceSeq lets hostd replay instead of sending a snapshot. */
export async function subscribe(pid: string, sinceSeq?: number): Promise<void> {
  if (inflight.has(pid)) return;
  inflight.add(pid);
  try {
    const r = await call("subscribe", sinceSeq === undefined ? { processId: pid } : { processId: pid, sinceSeq }, OP_TIMEOUT_MS.DEFAULT + 5000);
    store.onSubscribed(pid, r);
  } finally {
    inflight.delete(pid);
  }
}

export function resync(pid: string): void {
  store.markResyncing(pid);
  subscribe(pid).catch(() => store.dropView(pid));
}

export function ensureView(pid: string): Promise<void> {
  store.touchView(pid);
  const v = useStore.getState().views[pid];
  if (v && !v.gone) return Promise.resolve();
  return subscribe(pid);
}

let installed = false;
export function installSync(): void {
  if (installed) return;
  installed = true;
  setResyncHandler(resync);
  setUnsubscribeHandler((pid) => { call("unsubscribe", { processId: pid }).catch(() => {}); });
  connection.onReady(() => {
    for (const pid of store.subscribedProcessIds()) {
      const v = store.view(pid);
      subscribe(pid, v?.seq).catch(() => store.dropView(pid));
    }
  });
}

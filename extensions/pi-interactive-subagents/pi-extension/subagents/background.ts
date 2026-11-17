/**
 * Read-only view of the subagents and team members owned by the main pi process.
 *
 * Published on globalThis so other extensions (pi-board) can read it without
 * importing this package. Owners register a row source per kind; subscribers are
 * notified when the rows change.
 */
import { focusMuxPane } from "./cmux.ts";

export interface BackgroundAgent {
  /** Subagent registry id, or the team member's instanceId. */
  id: string;
  kind: "sub" | "team";
  name: string;
  /** Existing status kind (subagents) or member state (team members). */
  state: string;
  paneId?: string;
  windowId?: string;
}

export interface BackgroundAgentsService {
  list(): BackgroundAgent[];
  subscribe(cb: () => void): () => void;
  focus(id: string): Promise<boolean>;
}

export const BACKGROUND_AGENTS_KEY = Symbol.for("pi.subagents.background.v1");

/**
 * Subscriber list and poll state. Kept on globalThis so subscriptions made before
 * /reload still receive notifications afterwards.
 */
const STATE_KEY = Symbol.for("pi.subagents.background.state.v1");
const POLL_MS = 1000;

interface BackgroundState {
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  lastSignature: string;
}

const state: BackgroundState = ((globalThis as any)[STATE_KEY] as BackgroundState | undefined) ?? {
  listeners: new Set(),
  timer: null,
  lastSignature: "",
};
(globalThis as any)[STATE_KEY] = state;

const sources = new Map<BackgroundAgent["kind"], () => BackgroundAgent[]>();

/** Register the rows of one kind. Registering again replaces the previous source. */
export function setBackgroundAgentSource(kind: BackgroundAgent["kind"], source: () => BackgroundAgent[]): void {
  sources.set(kind, source);
}

function listBackgroundAgents(): BackgroundAgent[] {
  const rows: BackgroundAgent[] = [];
  for (const source of sources.values()) {
    try {
      rows.push(...source());
    } catch {
      // One failing source must not hide the others.
    }
  }
  return rows;
}

function signatureOf(rows: BackgroundAgent[]): string {
  return JSON.stringify(
    rows.map((row) => [row.kind, row.id, row.name, row.state, row.paneId ?? null, row.windowId ?? null]),
  );
}

function notifyIfChanged(): void {
  const signature = signatureOf(listBackgroundAgents());
  if (signature === state.lastSignature) return;
  state.lastSignature = signature;
  for (const listener of [...state.listeners]) {
    try {
      listener();
    } catch {
      // A failing subscriber must not stop the others.
    }
  }
}

function startPolling(): void {
  if (state.timer) return;
  state.lastSignature = signatureOf(listBackgroundAgents());
  const timer = setInterval(notifyIfChanged, POLL_MS);
  // The poll must not keep the process alive on its own.
  timer.unref();
  state.timer = timer;
}

function stopPolling(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}

/** Focus a background agent's pane through the published service; false when there is no service or pane. */
export async function focusBackgroundAgent(id: string): Promise<boolean> {
  const service = (globalThis as any)[BACKGROUND_AGENTS_KEY] as BackgroundAgentsService | undefined;
  return service ? service.focus(id) : false;
}

/**
 * Mouse handler for a widget whose lines belong to background agents. `ids()` gives the agent id of each rendered
 * line (undefined for borders). A left click focuses the agent's pane; the widget never takes keyboard focus.
 */
export function backgroundRowClick(ids: () => Array<string | undefined>) {
  return (event: { type: string; button: string; y: number }): { handled: true; render: false } | undefined => {
    const id = ids()[event.y];
    if (!id) return undefined;
    if (event.type === "click" && event.button === "left") void focusBackgroundAgent(id).catch(() => undefined);
    return { handled: true, render: false };
  };
}

/**
 * Publish the service. Call only in the main pi process; subagents and team
 * members must not publish.
 */
export function publishBackgroundAgentsService(): void {
  const service: BackgroundAgentsService = {
    list: listBackgroundAgents,
    subscribe(cb) {
      const listener = () => cb();
      state.listeners.add(listener);
      startPolling();
      return () => {
        state.listeners.delete(listener);
        if (state.listeners.size === 0) stopPolling();
      };
    },
    async focus(id) {
      const agent = listBackgroundAgents().find((row) => row.id === id);
      if (!agent?.paneId) return false;
      return focusMuxPane(agent.paneId, agent.windowId);
    },
  };
  (globalThis as any)[BACKGROUND_AGENTS_KEY] = service;
}

// Survive /reload: a poll left by the previous module load would call that module's
// sources, so restart it here with this module's sources (registered by the factory).
if (state.timer) {
  clearInterval(state.timer);
  state.timer = null;
}
if (state.listeners.size > 0) startPolling();

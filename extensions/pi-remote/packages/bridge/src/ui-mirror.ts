import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { UiRequest, UiResponse } from "../../protocol/src/index.ts";
import { emitSafe } from "./host-conn.ts";
import { logError } from "./log.ts";
import { customOpenedAt, latestUncoveredRpiv } from "./rpiv.ts";
import { refreshStatus } from "./snapshot.ts";
import { g, type Placement } from "./state.ts";
import type { DistributiveOmit } from "./types.ts";
import { stripAnsi, renderFactoryText } from "./widget-text.ts";

const PATCHED = Symbol.for("pi-remote.uiPatched");

const anySignal = (a: AbortSignal | undefined, b: AbortSignal) => (a ? AbortSignal.any([a, b]) : b);

function trackStatus(key: string, text: string | undefined): void {
  const s = g();
  if (text) s.extStatus.set(key, text); else s.extStatus.delete(key);
}

function trackWidget(key: string, lines: string[] | undefined, placement: Placement): void {
  const s = g();
  if (lines && lines.length) s.extWidgets.set(key, { lines, placement }); else s.extWidgets.delete(key);
}

function publishFactoryWidget(key: string, ui: ExtensionUIContext): void {
  const w = g().widgetFactories.get(key);
  if (!w) return;
  const lines = renderFactoryText(w.factory, ui.theme);
  if (!lines) return;
  const text = lines.join("\n");
  if (text === w.lastText) return;
  w.lastText = text;
  emitSafe({ type: "ext_widget", key, lines, placement: w.placement });
  trackWidget(key, lines, w.placement);
}

/** Component widgets can change over time (e.g. elapsed time): re-render every 2s while any exist. */
function ensureWidgetTimer(): void {
  const s = g();
  if (s.widgetTimer) return;
  s.widgetTimer = setInterval(() => {
    try {
      if (s.widgetFactories.size === 0 || !s.binding) { clearInterval(s.widgetTimer); s.widgetTimer = undefined; return; }
      for (const key of s.widgetFactories.keys()) publishFactoryWidget(key, s.binding.ctx.ui);
    } catch (e) { logError("widget timer", e); }
  }, 2000);
  s.widgetTimer.unref?.();
}

function mirror<T>(
  reqNoId: DistributiveOmit<UiRequest, "uiId">,
  runLocal: (signal: AbortSignal) => Promise<T>,
  fromRemote: (r: UiResponse) => T,
): Promise<T> {
  const s = g();
  const uiId = randomUUID();
  const ac = new AbortController();
  const req = { ...reqNoId, uiId } as UiRequest;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (by: "local" | "remote") => {
      s.pendingUi.delete(uiId);
      emitSafe({ type: "ui_closed", uiId, by });
      refreshStatus();
    };
    s.pendingUi.set(uiId, {
      req,
      respond: (r) => {
        if (done) return;
        done = true;
        ac.abort();
        finish("remote");
        resolve(fromRemote(r));
      },
    });
    emitSafe({ type: "ui_request", req });
    refreshStatus();
    let local: Promise<T>;
    try { local = runLocal(ac.signal); } catch (e) { local = Promise.reject(e); }
    local.then(
      (v) => { if (done) return; done = true; finish("local"); resolve(v); },
      (e) => { if (done) return; done = true; finish("local"); reject(e); },
    );
  });
}

type CustomFn = ExtensionUIContext["custom"];

function mirrorCustom(origCustom: CustomFn, factory: Parameters<CustomFn>[0], options: Parameters<CustomFn>[1]): Promise<unknown> {
  const s = g();
  const uiId = randomUUID();
  let doneRef: ((v: unknown) => void) | undefined;
  let cancelRequested = false;
  const wrapped = ((tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => {
    doneRef = done;
    if (cancelRequested) queueMicrotask(() => done(undefined));
    return (factory as Function)(tui, theme, kb, done);
  }) as Parameters<CustomFn>[0];
  const coveredBy = latestUncoveredRpiv();
  const title = options?.blocked?.message;
  const req: UiRequest = { uiId, kind: "custom", ...(title ? { title } : {}), ...(coveredBy ? { coveredBy } : {}) };
  customOpenedAt.set(uiId, Date.now());
  s.pendingUi.set(uiId, {
    req,
    respond: (r) => {
      if (!("cancelled" in r)) return;
      cancelRequested = true;
      doneRef?.(undefined);
    },
  });
  emitSafe({ type: "ui_request", req });
  refreshStatus();
  let p: Promise<unknown>;
  try { p = origCustom(wrapped, options) as Promise<unknown>; } catch (e) { p = Promise.reject(e); }
  return p.finally(() => {
    customOpenedAt.delete(uiId);
    s.pendingUi.delete(uiId);
    emitSafe({ type: "ui_closed", uiId, by: cancelRequested ? "remote" : "local" });
    refreshStatus();
  });
}

/** Wrap ctx.ui (shared by all extensions of this runner) so dialogs are mirrored to the phone (D11-D13). Idempotent. */
export function patchUi(ui: ExtensionUIContext): void {
  const u = ui as ExtensionUIContext & { [PATCHED]?: true };
  if (u[PATCHED]) return;
  const o = {
    select: ui.select.bind(ui), confirm: ui.confirm.bind(ui), input: ui.input.bind(ui), editor: ui.editor.bind(ui),
    custom: ui.custom.bind(ui) as CustomFn, notify: ui.notify.bind(ui), setStatus: ui.setStatus.bind(ui),
    setWidget: ui.setWidget.bind(ui) as (key: string, content: unknown, options?: { placement?: Placement }) => void,
  };

  ui.select = (title, options, opts) =>
    mirror({ kind: "select", title, options, ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}) },
      (signal) => o.select(title, options, { ...opts, signal: anySignal(opts?.signal, signal) }),
      (r) => ("value" in r ? r.value : undefined));

  ui.confirm = (title, message, opts) =>
    mirror({ kind: "confirm", title, message, ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}) },
      (signal) => o.confirm(title, message, { ...opts, signal: anySignal(opts?.signal, signal) }),
      (r) => ("confirmed" in r ? r.confirmed : false));

  ui.input = (title, placeholder, opts) =>
    mirror({ kind: "input", title, ...(placeholder ? { placeholder } : {}), ...(opts?.timeout ? { timeoutMs: opts.timeout } : {}) },
      (signal) => o.input(title, placeholder, { ...opts, signal: anySignal(opts?.signal, signal) }),
      (r) => ("value" in r ? r.value : undefined));

  // D13: editor() takes no signal, so a phone answer cannot close the local editor.
  ui.editor = (title, prefill) =>
    mirror({ kind: "editor", title, ...(prefill ? { prefill } : {}) },
      () => o.editor(title, prefill),
      (r) => ("value" in r ? r.value : undefined));

  ui.custom = ((factory: Parameters<CustomFn>[0], options: Parameters<CustomFn>[1]) => mirrorCustom(o.custom, factory, options)) as CustomFn;

  ui.notify = (message, type) => { o.notify(message, type); emitSafe({ type: "notify", message: String(message), level: type ?? "info" }); };
  ui.setStatus = (key, text) => {
    o.setStatus(key, text);
    try {
      const plain = text ? stripAnsi(String(text)) : undefined;
      if (g().extStatus.get(key) === plain) return;   // many extensions refresh status every second
      emitSafe({ type: "ext_status", key, ...(plain ? { text: plain } : {}) });
      trackStatus(key, plain);
    } catch (e) { logError("setStatus mirror", e); }
  };
  ui.setWidget = ((key: string, content: unknown, options?: { placement?: Placement }) => {
    o.setWidget(key, content, options);
    try {
      const placement = options?.placement ?? "aboveEditor";
      if (typeof content === "function") {
        g().widgetFactories.set(key, { factory: content, placement });
        publishFactoryWidget(key, ui);
        ensureWidgetTimer();
        return;
      }
      g().widgetFactories.delete(key);
      const lines = Array.isArray(content) ? content.map((l) => stripAnsi(String(l))) : undefined;
      emitSafe({ type: "ext_widget", key, ...(lines && lines.length ? { lines } : {}), placement });
      trackWidget(key, lines, placement);
    } catch (e) { logError("setWidget mirror", e); }
  }) as ExtensionUIContext["setWidget"];

  u[PATCHED] = true;
}

/** Drop per-session UI state when the session instance goes away. */
export function clearSessionUiState(): void {
  const s = g();
  for (const uiId of s.pendingUi.keys()) emitSafe({ type: "ui_closed", uiId, by: "local" });
  s.pendingUi.clear();
  for (const id of s.rpivOpen.keys()) emitSafe({ type: "rpiv_closed", toolCallId: id });
  s.rpivOpen.clear();
  s.widgetFactories.clear();
  // Clients re-snapshot after session_changed; extensions set their status/widgets again on session_start.
  s.extStatus.clear();
  s.extWidgets.clear();
  if (s.widgetTimer) { clearInterval(s.widgetTimer); s.widgetTimer = undefined; }
}

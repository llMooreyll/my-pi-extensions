import { useEffect } from "react";

/**
 * Test-build-only hooks (plan 5.3 item 7). Enabled only when the bundle was built with EXPO_PUBLIC_TEST_HOOKS=1.
 * - piremote://test/type?label=<accessibilityLabel>&text=<text>  sets a TextInput's value without the keyboard
 * - piremote://test/press?label=<label>                           presses a registered button
 * - piremote://test/labels                                        logs the labels currently on screen
 * - piremote://test/dump                                          logs a "PIREMOTE_TEST {json}" line with a store summary
 */
export const TEST_HOOKS = process.env.EXPO_PUBLIC_TEST_HOOKS === "1";

const setters = new Map<string, (text: string) => void>();
const actions = new Map<string, () => void>();
let dumpProvider: (() => unknown) | undefined;

export function setDumpProvider(fn: () => unknown): void { dumpProvider = fn; }

/** Register a TextInput setter under its accessibilityLabel (no-op in normal builds). */
export function useTestInput(label: string, set: (text: string) => void): void {
  useEffect(() => {
    if (!TEST_HOOKS) return;
    setters.set(label, set);
    return () => { if (setters.get(label) === set) setters.delete(label); };
  }, [label, set]);
}

/**
 * Register a pressable under its accessibilityLabel. piremote://test/press?label=<label> invokes it without
 * uiautomator, which cannot dump the window while the UI keeps updating (e.g. a status line ticking every second).
 */
export function useTestAction(label: string | undefined, fn: (() => void) | undefined, enabled = true): void {
  useEffect(() => {
    if (!TEST_HOOKS || !label || !fn || !enabled) return;
    actions.set(label, fn);
    return () => { if (actions.get(label) === fn) actions.delete(label); };
  }, [label, fn, enabled]);
}

export function registeredLabels(): string[] { return [...actions.keys(), ...setters.keys()].sort(); }

export function testLog(kind: string, payload: unknown): void {
  if (!TEST_HOOKS) return;
  console.log(`PIREMOTE_TEST ${JSON.stringify({ kind, ...(payload as object) })}`);
}

/** Returns true when the URL was a test hook. */
export function handleTestUrl(url: string): boolean {
  if (!TEST_HOOKS) return false;
  const m = /^piremote:\/\/test\/([a-z]+)(?:\?(.*))?$/.exec(url);
  if (!m) return false;
  const params = new URLSearchParams(m[2] ?? "");
  if (m[1] === "type") {
    const label = params.get("label") ?? "";
    const set = setters.get(label);
    if (set) set(params.get("text") ?? "");
    testLog("type", { label, ok: !!set });
  } else if (m[1] === "press") {
    const label = params.get("label") ?? "";
    const fn = actions.get(label);
    testLog("press", { label, ok: !!fn });
    if (fn) setTimeout(fn, 0);
  } else if (m[1] === "labels") {
    testLog("labels", { labels: registeredLabels() });
  } else if (m[1] === "dump") {
    testLog("dump", { state: dumpProvider?.() ?? null });
  }
  return true;
}

let installed = false;
export function installTestHooks(): void {
  if (!TEST_HOOKS || installed) return;
  installed = true;
  // URLs reach handleTestUrl through app/+native-intent.tsx (before the router sees them).
  testLog("ready", {});
}

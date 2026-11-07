import { useCallback, useState } from "react";
import { router } from "expo-router";
import type { Trust } from "@pi-remote/protocol";
import { call, errText } from "../net/connection";
import { loadTrustMap } from "./credentials";

const rememberedTrust = async (cwd: string): Promise<Trust | undefined> => (await loadTrustMap())[cwd];

type Pending = { cwd: string; run: (t: Trust) => Promise<void> };

/** Shared "pick trust, then open/spawn, then navigate" flow for the home, new-session and history pages. */
export function useOpenFlow() {
  const [pending, setPending] = useState<Pending | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const withTrust = useCallback(async (cwd: string, run: (t: Trust) => Promise<void>) => {
    const t = await rememberedTrust(cwd);
    if (t) await run(t); else setPending({ cwd, run });
  }, []);

  const go = (processId: string) => router.push({ pathname: "/session/[processId]", params: { processId } });

  const openSession = useCallback((sessionFile: string, cwd: string) => withTrust(cwd, async (trust) => {
    setBusy("Starting pi on the computer…");
    try { const r = await call("open_session", { sessionFile, trust }, 60_000); go(r.processId); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(undefined); }
  }), [withTrust]);

  const newProcess = useCallback((cwd: string) => withTrust(cwd, async (trust) => {
    setBusy("Starting pi on the computer…");
    try { const r = await call("new_process", { cwd, trust }, 60_000); go(r.processId); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(undefined); }
  }), [withTrust]);

  const trustDialog = {
    cwd: pending?.cwd,
    onChoose: (t: Trust) => { const p = pending; setPending(undefined); if (p) void p.run(t); },
    onCancel: () => setPending(undefined),
  };
  return { openSession, newProcess, trustDialog, busy, error, clearError: () => setError(undefined) };
}

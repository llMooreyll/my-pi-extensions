import * as Clipboard from "expo-clipboard";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, View } from "react-native";
import type { CommandInfo, DeliverAs, ImageInput, RpivPrompt, UiResponse, WireMessage } from "@pi-remote/protocol";
import { ConfirmDialog, ErrorDialog, TrustDialog } from "../../ds/common";
import { Button, Rule, Screen, Spinner, Txt } from "../../ds/primitives";
import { F, MARGIN, STATUS_WORD, statusColor, usePalette } from "../../ds/tokens";
import { baseName, processTitle, textOf } from "../../lib/format";
import { openProcess } from "../../lib/nav";
import { useOpenFlow } from "../../lib/open";
import { routeSlash, type SheetName } from "../../lib/slash";
import { testLog, useTestAction } from "../../lib/test-hooks";
import { call, errCode, errText } from "../../net/connection";
import { ensureView } from "../../net/sync";
import { store, useStore } from "../../state/store";
import { AttentionDock, RpivSheet } from "../../session/Attention";
import { CommandsSheet, type DeckAction } from "../../session/Commands";
import { Composer } from "../../session/Composer";
import { CompactSheet, ForkSheet, InfoSheet, ModelSheet, ResumeSheet, ThinkingSheet, TreeSheet } from "../../session/Sheets";
import { Transcript } from "../../session/Transcript";

type Confirm = { title: string; body?: string; label?: string; run: () => Promise<void> };

/** An inline control set as an underlined word: "model gemini ▾". */
function Word({ label, value, onPress, a11y, color }: { label: string; value: string; onPress?: () => void; a11y: string; color?: string }) {
  const p = usePalette();
  useTestAction(a11y, onPress);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress} disabled={!onPress} hitSlop={6} style={{ flexDirection: "row", gap: 5, alignItems: "baseline" }}>
      <Txt v="label" soft>{label}</Txt>
      <Txt v="mono" color={color ?? p.ink} style={{ textDecorationLine: onPress ? "underline" : "none", fontSize: 12 }}>{value}</Txt>
    </Pressable>
  );
}

export default function SessionScreen() {
  const p = usePalette();
  const { processId } = useLocalSearchParams<{ processId: string }>();
  const pid = String(processId);
  const conn = useStore((s) => s.conn);
  const view = useStore((s) => s.views[pid]);
  const procInfo = useStore((s) => s.procs[pid]);
  const procsMap = useStore((s) => s.procs);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [sheet, setSheet] = useState<SheetName | "rename" | "deck" | undefined>();
  const [rpivOpen, setRpivOpen] = useState<RpivPrompt | undefined>();
  const [text, setText] = useState("");
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [confirm, setConfirm] = useState<Confirm | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [hideThinking, setHideThinking] = useState(false);
  const [treeFilter, setTreeFilter] = useState<string | undefined>();
  const [panelsOpen, setPanelsOpen] = useState(true);
  const flow = useOpenFlow();
  const info = view?.info ?? procInfo;

  useFocusEffect(useCallback(() => {
    store.setActive(pid);
    return () => { if (useStore.getState().activeProcessId === pid) store.setActive(undefined); };
  }, [pid]));

  useEffect(() => {
    if (conn !== "ready" || (!procInfo && !view)) return;
    setLoadError(undefined);
    ensureView(pid).catch((e) => setLoadError(errText(e)));
  }, [pid, conn, !!procInfo]);

  useEffect(() => {
    if (conn !== "ready" || !procInfo) return;
    call("get_commands", { processId: pid }).then((r) => setCommands(r.commands), () => {});
    call("get_settings", {}).then((r) => { setHideThinking(r.values.hideThinkingBlock === true); setTreeFilter(r.values.treeFilterMode as string | undefined); }, () => {});
  }, [pid, conn, !!procInfo]);

  useEffect(() => {
    if (!view?.toasts.length) return;
    const t = setTimeout(() => { for (const x of view.toasts) if (Date.now() - x.at > 3800) store.dismissToast(pid, x.id); }, 4000);
    return () => clearTimeout(t);
  }, [view?.toasts, pid]);

  useEffect(() => {
    if (rpivOpen && view && !view.pendingRpiv.some((r) => r.toolCallId === rpivOpen.toolCallId)) setRpivOpen(undefined);
  }, [view?.pendingRpiv, rpivOpen]);

  const children = useMemo(() => Object.values(procsMap).filter((x) => x.parentProcessId === pid), [procsMap, pid]);
  const parent = info?.parentProcessId ? procsMap[info.parentProcessId] : undefined;
  // Only "running" shows the steer/stop bar; while a dialog waits, the dock above the composer is what matters.
  const running = info?.status === "running";
  const waiting = info?.status === "waiting_ui";
  const ready = conn === "ready" && !!procInfo && !!view && !view.gone;
  useEffect(() => { testLog("session", { pid, ready, conn, hasProc: !!procInfo, hasView: !!view, gone: !!view?.gone }); }, [pid, ready, conn, !!procInfo, !!view]);

  const lastAssistantText = () => {
    const ms = view?.messages ?? [];
    for (let i = ms.length - 1; i >= 0; i--) if (ms[i]!.role === "assistant") { const t = textOf(ms[i]!.content); if (t.trim()) return t; }
    return "";
  };

  const doCall = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) {
      const code = errCode(e);
      setError(code === "replacing" ? "The session is switching. Try again in a moment." : code === "busy" ? "pi is working. Wait until it is idle." : errText(e));
    }
  };

  const runAction = async (a: DeckAction | SheetName) => {
    setSheet(undefined);
    switch (a) {
      case "model": case "thinking": case "tree": case "fork": case "resume": case "compact": setSheet(a); return;
      case "session": case "info": setSheet("session"); return;
      case "rename": setSheet("rename"); return;
      case "settings": router.push("/settings"); return;
      case "copy": { const t = lastAssistantText(); await Clipboard.setStringAsync(t); setError(t ? undefined : "There is no answer to copy yet."); if (t) store.toast(pid, "Copied the last answer"); return; }
      case "new": setConfirm({ title: "Start a fresh session?", body: "This pi leaves the current conversation (it stays on disk) and starts an empty one.", label: "Start fresh", run: () => doCall(() => call("new_session", { processId: pid }, 70_000)) }); return;
      case "reload": setConfirm({ title: "Reload pi?", body: "Extensions, skills and prompts are reloaded on the computer.", label: "Reload", run: () => doCall(() => call("reload", { processId: pid })) }); return;
      case "clone": setConfirm({
        title: "Clone this session?", body: "A new session starts with everything up to now. The original stays as it is.", label: "Clone",
        run: () => doCall(async () => { const t = await call("get_tree", { processId: pid }); if (t.leafId) await call("fork", { processId: pid, entryId: t.leafId, position: "at" }, 70_000); }),
      }); return;
    }
  };

  const onSend = async (input: string, images: ImageInput[], deliverAs?: DeliverAs): Promise<boolean> => {
    const action = routeSlash(input);
    const clear = () => setText("");
    switch (action.kind) {
      case "sheet": clear(); await runAction(action.sheet); return true;
      case "settings": clear(); router.push("/settings"); return true;
      case "desktop_only": setError(`/${action.command} only works on the computer.`); return false;
      case "copy": clear(); await runAction("copy"); return true;
      case "name": clear(); if (action.name) await doCall(() => call("set_name", { processId: pid, name: action.name! })); else setSheet("rename"); return true;
      case "new": clear(); await runAction("new"); return true;
      case "reload": clear(); await runAction("reload"); return true;
      case "clone": clear(); await runAction("clone"); return true;
      case "compact": clear(); await doCall(() => call("compact", { processId: pid, customInstructions: action.instructions }, 620_000)); return true;
      case "prompt": {
        try {
          // While a dialog is open pi may still be mid-run; queue the message rather than fail.
          const mode = deliverAs ?? (waiting ? "followUp" : undefined);
          await call("prompt", { processId: pid, text: input, ...(images.length ? { images } : {}), ...(mode ? { deliverAs: mode } : {}) }, 30_000);
          clear();
          return true;
        } catch (e) {
          const code = errCode(e);
          setError(code === "model_no_image" ? "This model cannot read images." : code === "replacing" ? "The session is switching. Try again in a moment." : code === "busy_need_deliver_as" ? "pi just started working. Choose send now or send after, then send again." : errText(e));
          return false;
        }
      }
    }
  };

  const respondUi = async (uiId: string, response: UiResponse) => {
    try { await call("ui_respond", { processId: pid, uiId, response }); store.markUiAnswered(pid, uiId); }
    catch (e) { if (errCode(e) === "not_found") { setError("It was already answered on the computer."); store.markUiAnswered(pid, uiId); } else { setError(errText(e)); throw e; } }
  };

  const loadMore = async () => {
    const first = view?.messages.find((m: WireMessage) => m.entryId)?.entryId;
    if (!first) return;
    try { const r = await call("get_history", { processId: pid, beforeEntryId: first }); store.prependHistory(pid, r.messages, r.hasMoreBefore); }
    catch (e) { setError(errText(e)); }
  };

  const status = info?.status ?? "idle";
  const usage = info?.contextUsage?.percent;
  const widgets = Object.entries(view?.extWidgets ?? {});
  const statusLine = Object.values(view?.extStatus ?? {}).join("   ");
  const role = info?.role;
  const gone = view?.gone || (!procInfo && conn === "ready");

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.paper }} behavior="height">
      <Screen back scroll={false} a11yTitle="session-title" onTitlePress={info ? () => setSheet("session") : undefined}
        titleNode={
          <>
            <Txt v="label" color={statusColor(p, status)} a11y="session-status">{status === "idle" ? "○" : "●"} {STATUS_WORD[status]}{info ? ` — ${baseName(info.cwd)}` : ""}</Txt>
            <Txt v="title" lines={2}>{info ? processTitle(info) : "Session"}</Txt>
          </>
        }
        right={<Button a11y="session-commands" label="commands" onPress={() => setSheet("deck")} disabled={!ready} />}>
        {info ? (
          <View style={{ paddingHorizontal: MARGIN, paddingVertical: 9, gap: 6, borderBottomWidth: 1, borderBottomColor: p.faint }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 6 }}>
              <Word a11y="chip-model" label="model" value={info.model ? info.model.id : "none"} onPress={ready ? () => setSheet("model") : undefined} />
              <Word a11y="chip-thinking" label="thinking" value={info.thinkingLevel} onPress={ready ? () => setSheet("thinking") : undefined} />
              {usage != null ? <Word a11y="chip-context" label="context" value={`${usage.toFixed(0)}%`} color={usage > 80 ? p.danger : undefined} /> : null}
            </View>
            {role && role.kind !== "main" ? (
              <Txt v="small" soft a11y="session-role">
                {role.kind === "subagent" ? `Subagent “${role.name}”${role.agent ? `, agent ${role.agent}` : ""}${role.autoExit ? ", quits when done" : ""}.`
                  : `Team member “${role.name}”${role.agent ? `, agent ${role.agent}` : ""}, ${role.write ? `writes to ${role.branch ?? "its branch"}` : "read-only"}.`}
              </Txt>
            ) : null}
            {parent ? <Word a11y="chip-parent" label="started by" value={`← ${processTitle(parent)}`} color={p.blue} onPress={() => openProcess(parent.processId)} /> : null}
            {children.length ? (
              <View accessibilityLabel="child-strip" style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 }}>
                <Txt v="label" soft>its subtasks</Txt>
                {children.map((c) => (
                  <Word key={c.processId} a11y={`child-${c.processId}`} label={c.status === "idle" ? "○" : "●"} color={statusColor(p, c.status)}
                    value={c.role.kind === "main" ? processTitle(c) : c.role.name} onPress={() => openProcess(c.processId)} />
                ))}
              </View>
            ) : null}
            {statusLine ? <Txt v="mono" faint lines={1} a11y="session-ext-status" style={{ fontSize: 10.5 }}>{statusLine}</Txt> : null}
          </View>
        ) : null}

        {gone ? (
          <View accessibilityLabel="session-gone" style={{ paddingHorizontal: MARGIN, paddingVertical: 16, gap: 10, borderBottomWidth: 1, borderBottomColor: p.faint }}>
            <Txt v="em">This pi has quit on the computer.</Txt>
            {info?.sessionFile ? <Button kind="solid" a11y="session-reopen" label="Open the session again" busy={!!flow.busy} onPress={() => void flow.openSession(info.sessionFile!, info.cwd)} /> : null}
          </View>
        ) : null}
        {loadError ? <Txt v="small" color={p.danger} style={{ padding: MARGIN }}>{loadError}</Txt> : null}

        {view ? (
          <Transcript messages={view.messages} inflight={view.inflight} running={view.runningTools} hasMoreBefore={view.hasMoreBefore} onLoadMore={loadMore} hideThinking={hideThinking} />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            {conn === "ready" && procInfo ? <Spinner /> : <Txt v="em" soft>{conn === "ready" ? "" : "Not connected."}</Txt>}
          </View>
        )}

        {view?.toasts.length ? (
          <View pointerEvents="none" style={{ position: "absolute", left: MARGIN, right: MARGIN, top: 8, gap: 4 }}>
            {view.toasts.slice(-3).map((t) => (
              <View key={t.id} accessibilityLabel="toast" style={{ backgroundColor: t.level === "error" ? p.danger : t.level === "warning" ? p.pink : p.ink, paddingHorizontal: 12, paddingVertical: 8 }}>
                <Txt v="small" color={p.invert}>{t.text}</Txt>
              </View>
            ))}
          </View>
        ) : null}

        {widgets.length ? (
          <View style={{ borderTopWidth: 1, borderTopColor: p.faint }}>
            <Pressable accessibilityRole="button" accessibilityLabel="panels-toggle" onPress={() => setPanelsOpen(!panelsOpen)} style={{ paddingHorizontal: MARGIN, paddingVertical: 6 }}>
              <Txt v="label" soft>{panelsOpen ? "−" : "+"} panels from extensions · {widgets.length}</Txt>
            </Pressable>
            {panelsOpen ? (
              <ScrollView style={{ maxHeight: 150 }} contentContainerStyle={{ paddingHorizontal: MARGIN, paddingBottom: 8 }}>
                {widgets.map(([k, w]) => (
                  <ScrollView key={k} horizontal accessibilityLabel={`widget-${k}`}>
                    <View>{w.lines.map((l, i) => <Txt key={i} v="mono" style={{ fontSize: 11, fontFamily: F.mono }}>{l || " "}</Txt>)}</View>
                  </ScrollView>
                ))}
              </ScrollView>
            ) : null}
          </View>
        ) : null}

        <AttentionDock ui={view?.pendingUi ?? []} rpiv={view?.pendingRpiv ?? []} onRespond={respondUi} onOpenRpiv={setRpivOpen} />
        <Composer
          disabled={!ready}
          disabledReason={conn !== "ready" ? "Not connected to the computer." : undefined}
          running={running}
          imagesAllowed={!!info?.model?.input.includes("image")}
          commands={commands}
          text={text}
          setText={setText}
          onSend={onSend}
          onAbort={() => void doCall(() => call("abort", { processId: pid }))}
          onOpenCommands={() => setSheet("deck")}
        />
      </Screen>

      <CommandsSheet visible={sheet === "deck"} running={running || waiting} commands={commands} onAction={(a) => void runAction(a)} onInsert={(t) => { setSheet(undefined); setText(t); }} onClose={() => setSheet(undefined)} />
      {sheet === "model" ? <ModelSheet processId={pid} onClose={() => setSheet(undefined)} /> : null}
      {sheet === "thinking" ? <ThinkingSheet processId={pid} onClose={() => setSheet(undefined)} /> : null}
      {sheet === "tree" ? <TreeSheet processId={pid} running={running || waiting} defaultFilter={treeFilter} onClose={() => setSheet(undefined)} /> : null}
      {sheet === "fork" ? <ForkSheet processId={pid} onClose={() => setSheet(undefined)} onPrefill={setText} /> : null}
      {sheet === "resume" && info ? <ResumeSheet processId={pid} cwd={info.cwd} currentFile={info.sessionFile} onClose={() => setSheet(undefined)} /> : null}
      {sheet === "compact" ? <CompactSheet processId={pid} onClose={() => setSheet(undefined)} /> : null}
      {(sheet === "session" || sheet === "rename") && info ? <InfoSheet info={info} renameFirst={sheet === "rename"} onClose={() => setSheet(undefined)} /> : null}
      <RpivSheet prompt={rpivOpen} onClose={() => setRpivOpen(undefined)} onSubmit={(answer) => call("rpiv_answer", { processId: pid, answer })} />
      <ConfirmDialog title={confirm?.title} body={confirm?.body} confirmLabel={confirm?.label} onCancel={() => setConfirm(undefined)} onConfirm={() => { const c = confirm; setConfirm(undefined); if (c) void c.run(); }} />
      <TrustDialog {...flow.trustDialog} />
      <ErrorDialog text={error ?? flow.error} onClose={() => { setError(undefined); flow.clearError(); }} />
    </KeyboardAvoidingView>
  );
}

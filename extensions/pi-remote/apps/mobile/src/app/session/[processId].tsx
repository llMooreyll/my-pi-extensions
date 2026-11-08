import { drafts } from "../../lib/drafts";
import * as Clipboard from "expo-clipboard";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, View } from "react-native";
import type { CommandInfo, DeliverAs, ImageInput, RpivPrompt, UiResponse, WireMessage } from "@pi-remote/protocol";
import { ConfirmDialog, ErrorDialog, TrustDialog } from "../../ds/common";
import { Button, Rule, Screen, Spinner, Txt } from "../../ds/primitives";
import { F, MARGIN, STATUS_WORD, THINK_LEVELS, statusColor, thinkColor, thinkIndex, usePalette } from "../../ds/tokens";
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
import { CrewTray } from "../../session/CrewTray";
import { Composer } from "../../session/Composer";
import { OutlineSheet } from "../../session/Outline";
import { CompactSheet, ForkSheet, InfoSheet, ModelSheet, ResumeSheet, ThinkingSheet } from "../../session/Sheets";
import { Transcript, type TranscriptHandle } from "../../session/Transcript";

type Confirm = { title: string; body?: string; label?: string; run: () => Promise<void> };

/** One cell of the spec strip under the header: caption, value, a rotating line of detail, optional bar or meter. */
function Spec({ label, value, sub, onPress, a11y, color, bar, meter }: {
  label: string; value: string; sub?: string; onPress?: () => void; a11y: string; color?: string;
  bar?: { pct: number; color: string }; meter?: { level: number; of: number; color: string };
}) {
  const p = usePalette();
  useTestAction(a11y, onPress);
  // The whole cell is the button; the second line is one short fact, shown in full.
  return (
    <Pressable accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={a11y} onPress={onPress} disabled={!onPress}
      style={({ pressed }) => ({ flex: 1, paddingTop: 9, paddingBottom: 9, paddingHorizontal: 10, gap: 2, backgroundColor: pressed ? p.tint : "transparent" })}>
      <Txt v="label" soft>{label}{onPress ? "  ›" : ""}</Txt>
      <Txt v="bodyBold" color={color ?? p.ink} lines={1} fit={0.75} style={{ fontSize: 14.5, lineHeight: 19 }}>{value}</Txt>
      {sub ? <Txt v="mono" soft lines={2} style={{ fontSize: 10.5, lineHeight: 14 }}>{sub}</Txt> : null}
      {bar ? (
        <View style={{ height: 3, backgroundColor: p.faint, marginTop: 4 }}>
          <View style={{ height: 3, width: `${Math.max(2, Math.min(100, bar.pct))}%`, backgroundColor: bar.color }} />
        </View>
      ) : null}
      {meter ? (
        <View style={{ flexDirection: "row", gap: 2, marginTop: 4 }}>
          {Array.from({ length: meter.of }, (_, i) => <View key={i} style={{ flex: 1, height: 3, backgroundColor: i <= meter.level ? meter.color : p.faint }} />)}
        </View>
      ) : null}
    </Pressable>
  );
}

/** A labelled link set as an underlined word, for parent / children. */
function Word({ label, value, onPress, a11y, color }: { label: string; value: string; onPress?: () => void; a11y: string; color?: string }) {
  const p = usePalette();
  useTestAction(a11y, onPress);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress} disabled={!onPress} hitSlop={6} style={{ flexDirection: "row", gap: 6, alignItems: "baseline" }}>
      <Txt v="label" soft>{label}</Txt>
      <Txt v="small" color={color ?? p.ink} style={{ textDecorationLine: onPress ? "underline" : "none" }}>{value}</Txt>
    </Pressable>
  );
}

const fmtTokens = (n: number | null) => (n == null ? "?" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

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
  const [panelsOpen, setPanelsOpen] = useState<boolean | undefined>(undefined);
  const flow = useOpenFlow();
  const transcript = useRef<TranscriptHandle>(null);
  const info = view?.info ?? procInfo;
  // An unsent message belongs to the conversation, not to the screen: restore it when coming back.
  const draftKey = info?.sessionId || undefined;
  const restored = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!draftKey) return;
    const have = drafts.peek(draftKey);
    if (have !== undefined) { restored.current = draftKey; if (have) setText(have); return; }
    let live = true;
    void drafts.load(draftKey).then((t) => { if (!live) return; restored.current = draftKey; if (t) setText((cur) => cur || t); });
    return () => { live = false; };
  }, [draftKey]);
  // Saving waits for the restore, otherwise the empty initial text would overwrite the stored draft.
  useEffect(() => { if (draftKey && restored.current === draftKey) drafts.save(draftKey, text); }, [draftKey, text]);

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

  const children = useMemo(() => Object.values(procsMap).filter((x) => x.parentProcessId === pid).sort((a, b) => a.processId < b.processId ? -1 : 1), [procsMap, pid]);
  // The parent link is derived by hostd and lives on the process list, not in session events.
  const parentId = procInfo?.parentProcessId ?? info?.parentProcessId;
  const parent = parentId ? procsMap[parentId] : undefined;
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
      case "model": case "thinking": case "outline": case "tree": case "fork": case "resume": case "compact": setSheet(a); return;
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
          // Show the message at once as "queued": pi only reports it when it actually takes it up.
          const queuedId = mode ? `q${Date.now()}${Math.random().toString(36).slice(2, 6)}` : undefined;
          if (mode && queuedId) store.addQueued(pid, { id: queuedId, text: input, mode, images: images.length, at: Date.now() });
          try {
            await call("prompt", { processId: pid, text: input, ...(images.length ? { images } : {}), ...(mode ? { deliverAs: mode } : {}) }, 30_000);
          } catch (e) { if (queuedId) store.removeQueued(pid, queuedId); throw e; }
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
  // The subagent and team banners are drawn for a terminal (box-drawing text); the crew tray replaces them.
  const widgets = Object.entries(view?.extWidgets ?? {}).filter(([k]) => !/^(subagent-status|team-status|team-member)$/.test(k));
  const panelsShown = panelsOpen ?? false;
  const statusLine = Object.values(view?.extStatus ?? {}).join("   ·   ");
  const role = info?.role;
  const gone = view?.gone || (!procInfo && conn === "ready");

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.paper }} behavior="height">
      <Screen back scroll={false} a11yTitle="session-title" onTitlePress={info ? () => setSheet("session") : undefined}
        ruleColor={status === "running" ? p.blue : status === "waiting_ui" ? p.pink : undefined}
        titleNode={
          <>
            <Txt v="label" lines={1} a11y="session-status" color={statusColor(p, status)} style={{ fontFamily: status === "idle" ? F.mono : F.monoBold }}>
              {status === "idle" ? "○" : status === "running" ? "▶" : "◆"} {STATUS_WORD[status]}<Txt v="label" soft>{info ? `  ·  ${baseName(info.cwd)}` : ""}</Txt>
            </Txt>
            <Txt v="title" lines={2}>{info ? processTitle(info) : "Session"}</Txt>
          </>
        }
        right={
          <View style={{ gap: 6, alignItems: "stretch" }}>
            <Button kind="outline" compact a11y="session-outline" label="§ outline" onPress={() => setSheet("outline")} disabled={!view} />
            <Button kind="outline" compact a11y="session-commands" label="≡ commands" onPress={() => setSheet("deck")} disabled={!ready} />
          </View>
        }>
        {info ? (
          <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: p.ink }}>
            <Spec a11y="chip-model" label="model" value={info.model ? (info.model.name || info.model.id) : "none"}
              sub={info.model ? info.model.provider : "choose one"}
              color={info.model ? p.ink : p.danger} onPress={ready ? () => setSheet("model") : undefined} />
            <View style={{ width: 1, backgroundColor: p.faint }} />
            <Spec a11y="chip-thinking" label="thinking" value={info.thinkingLevel} color={thinkColor(p, info.thinkingLevel)}
              sub={info.model?.reasoning === false ? "model does not reason" : `level ${thinkIndex(info.thinkingLevel)} of ${THINK_LEVELS.length - 1}`}
              meter={{ level: thinkIndex(info.thinkingLevel), of: THINK_LEVELS.length, color: thinkColor(p, info.thinkingLevel) }}
              onPress={ready ? () => setSheet("thinking") : undefined} />
            <View style={{ width: 1, backgroundColor: p.faint }} />
            <Spec a11y="chip-context" label="context" value={usage != null ? `${usage.toFixed(usage < 10 ? 1 : 0)}%` : "?"}
              sub={info.contextUsage ? `${info.contextUsage.tokens != null ? fmtTokens(info.contextUsage.tokens) : "?"} used of ${fmtTokens(info.contextUsage.contextWindow)}` : undefined}
              color={usage != null && usage > 80 ? p.danger : p.ink}
              bar={usage != null ? { pct: usage, color: usage > 80 ? p.danger : usage > 50 ? p.pink : p.blue } : undefined} />
          </View>
        ) : null}
        {info && (role?.kind !== "main" || parent || statusLine) ? (
          <View style={{ paddingHorizontal: MARGIN, paddingVertical: 8, gap: 5, borderBottomWidth: 1, borderBottomColor: p.faint }}>
            {role && role.kind !== "main" ? (
              <Txt v="small" a11y="session-role" color={p.blue}>
                {role.kind === "subagent" ? `Subagent “${role.name}”${role.agent ? ` · ${role.agent}` : ""}${role.autoExit ? " · quits when done" : ""}`
                  : `Team member “${role.name}”${role.agent ? ` · ${role.agent}` : ""} · ${role.write ? `writes ${role.branch ?? "its branch"}` : "read-only"}`}
              </Txt>
            ) : null}
            {parent ? <Word a11y="chip-parent" label="started by" value={`← ${processTitle(parent)}`} color={p.blue} onPress={() => openProcess(parent.processId)} /> : null}
            {statusLine ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="session-ext-status" style={{ marginHorizontal: -MARGIN }} contentContainerStyle={{ paddingHorizontal: MARGIN }}>
                <Txt v="mono" soft style={{ fontSize: 10.5 }}>{statusLine}</Txt>
              </ScrollView>
            ) : null}
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
          <Transcript ref={transcript} messages={view.messages} inflight={view.inflight} running={view.runningTools} queued={view.queued} hasMoreBefore={view.hasMoreBefore} onLoadMore={loadMore} hideThinking={hideThinking} />
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
            <Pressable accessibilityRole="button" accessibilityLabel="panels-toggle" onPress={() => setPanelsOpen(!panelsShown)} style={{ paddingHorizontal: MARGIN, paddingVertical: 6 }}>
              <Txt v="label" soft>{panelsShown ? "−" : "+"} extension panels · {widgets.map(([k]) => k).join(", ")}</Txt>
            </Pressable>
            {panelsShown ? (
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

        <CrewTray children={children} all={Object.values(procsMap)} />
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
      {(sheet === "tree" || sheet === "outline") && view ? (
        <OutlineSheet processId={pid} messages={view.messages} hasMoreBefore={view.hasMoreBefore} running={running || waiting}
          initialTab={sheet === "tree" ? "tree" : "turns"} treeFilter={treeFilter} onLoadMore={loadMore}
          onJump={(id) => setTimeout(() => transcript.current?.jumpTo(id), 280)} onPrefill={setText} onClose={() => setSheet(undefined)} />
      ) : null}
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

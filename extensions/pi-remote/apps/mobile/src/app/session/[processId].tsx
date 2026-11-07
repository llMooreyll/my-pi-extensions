import * as Clipboard from "expo-clipboard";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, View } from "react-native";
import type { DeliverAs, ImageInput, RpivPrompt, UiResponse, CommandInfo, WireMessage } from "@pi-remote/protocol";
import { processTitle, textOf } from "../../lib/format";
import { useOpenFlow } from "../../lib/open";
import { openProcess } from "../../lib/nav";
import { routeSlash, type SheetName } from "../../lib/slash";
import { call, errCode, errText } from "../../net/connection";
import { ensureView } from "../../net/sync";
import { store, useStore } from "../../state/store";
import { ChildStrip } from "../../ui/ChildStrip";
import { CompactSheet } from "../../ui/CompactSheet";
import { Composer } from "../../ui/Composer";
import { ErrorBox } from "../../ui/ErrorBox";
import { ForkSheet } from "../../ui/ForkSheet";
import { Btn, Card, T } from "../../ui/kit";
import { ModelSheet } from "../../ui/ModelSheet";
import { ResumeSheet } from "../../ui/ResumeSheet";
import { RpivSheet } from "../../ui/RpivSheet";
import { SessionInfoSheet } from "../../ui/SessionInfoSheet";
import { usePalette } from "../../ui/theme";
import { ThinkingSheet } from "../../ui/ThinkingSheet";
import { Transcript } from "../../ui/Transcript";
import { TreeSheet } from "../../ui/TreeSheet";
import { TrustDialog } from "../../ui/TrustDialog";
import { UiRequestCard } from "../../ui/UiRequestCard";

type Confirm = { title: string; run: () => Promise<void> };

function Chip({ label, onPress, a11y }: { label: string; onPress?: () => void; a11y: string }) {
  const c = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress}
      style={{ backgroundColor: c.cardAlt, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: c.border }}>
      <T size={12} numberOfLines={1}>{label}</T>
    </Pressable>
  );
}

export default function SessionScreen() {
  const c = usePalette();
  const { processId } = useLocalSearchParams<{ processId: string }>();
  const pid = String(processId);
  const conn = useStore((s) => s.conn);
  const view = useStore((s) => s.views[pid]);
  const procInfo = useStore((s) => s.procs[pid]);
  const procsMap = useStore((s) => s.procs);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [sheet, setSheet] = useState<SheetName | "rename" | undefined>();
  const [rpivOpen, setRpivOpen] = useState<RpivPrompt | undefined>();
  const [text, setText] = useState("");
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [confirm, setConfirm] = useState<Confirm | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [hideThinking, setHideThinking] = useState(false);
  const [treeFilter, setTreeFilter] = useState<string | undefined>();
  const flow = useOpenFlow();

  const info = view?.info ?? procInfo;

  useFocusEffect(useCallback(() => {
    store.setActive(pid);
    return () => { if (useStore.getState().activeProcessId === pid) store.setActive(undefined); };
  }, [pid]));

  useEffect(() => {
    if (conn !== "ready") return;
    if (!procInfo && !view) return;
    setLoadError(undefined);
    ensureView(pid).catch((e) => setLoadError(errText(e)));
  }, [pid, conn, !!procInfo]);

  useEffect(() => {
    if (conn !== "ready" || !procInfo) return;
    call("get_commands", { processId: pid }).then((r) => setCommands(r.commands), () => {});
    call("get_settings", {}).then((r) => { setHideThinking(r.values.hideThinkingBlock === true); setTreeFilter(r.values.treeFilterMode as string | undefined); }, () => {});
  }, [pid, conn, !!procInfo]);

  // Toasts disappear after 3 seconds.
  useEffect(() => {
    if (!view?.toasts.length) return;
    const t = setTimeout(() => { for (const x of view.toasts) if (Date.now() - x.at > 2900) store.dismissToast(pid, x.id); }, 3000);
    return () => clearTimeout(t);
  }, [view?.toasts, pid]);

  // Close the questionnaire sheet when it was answered on the computer.
  useEffect(() => {
    if (rpivOpen && view && !view.pendingRpiv.some((p) => p.toolCallId === rpivOpen.toolCallId)) setRpivOpen(undefined);
  }, [view?.pendingRpiv, rpivOpen]);

  const children = useMemo(() => Object.values(procsMap).filter((p) => p.parentProcessId === pid), [procsMap, pid]);
  const parent = info?.parentProcessId ? procsMap[info.parentProcessId] : undefined;
  const running = !!info && info.status !== "idle";
  const ready = conn === "ready" && !!procInfo && !!view && !view.gone;

  const lastAssistantText = () => {
    const ms = view?.messages ?? [];
    for (let i = ms.length - 1; i >= 0; i--) if (ms[i]!.role === "assistant") { const t = textOf(ms[i]!.content); if (t.trim()) return t; }
    return "";
  };

  const doCall = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) {
      const code = errCode(e);
      setError(code === "replacing" ? "The session is switching; try again in a moment." : code === "busy" ? "The agent is running; wait until it is idle." : errText(e));
    }
  };

  const onSend = async (input: string, images: ImageInput[], deliverAs?: DeliverAs): Promise<boolean> => {
    const action = routeSlash(input);
    const clear = () => setText("");
    switch (action.kind) {
      case "sheet": clear(); setSheet(action.sheet); return true;
      case "settings": clear(); router.push("/settings"); return true;
      case "desktop_only": setError(`/${action.command} is only available on the computer.`); return false;
      case "copy": { const t = lastAssistantText(); await Clipboard.setStringAsync(t); clear(); setError(t ? undefined : "No assistant message to copy"); return true; }
      case "name": clear(); if (action.name) await doCall(() => call("set_name", { processId: pid, name: action.name! })); else setSheet("rename"); return true;
      case "new": clear(); setConfirm({ title: "Start a new session?", run: () => doCall(() => call("new_session", { processId: pid }, 70_000)) }); return true;
      case "reload": clear(); setConfirm({ title: "Reload extensions and resources?", run: () => doCall(() => call("reload", { processId: pid })) }); return true;
      case "compact": clear(); await doCall(() => call("compact", { processId: pid, customInstructions: action.instructions }, 620_000)); return true;
      case "clone": clear(); setConfirm({
        title: "Clone this session at the current point?",
        run: () => doCall(async () => { const t = await call("get_tree", { processId: pid }); if (t.leafId) await call("fork", { processId: pid, entryId: t.leafId, position: "at" }, 70_000); }),
      }); return true;
      case "prompt": {
        try {
          await call("prompt", { processId: pid, text: input, ...(images.length ? { images } : {}), ...(deliverAs ? { deliverAs } : {}) }, 30_000);
          clear();
          return true;
        } catch (e) {
          const code = errCode(e);
          setError(code === "model_no_image" ? "The current model does not accept images." : code === "replacing" ? "The session is switching; try again in a moment." : code === "busy_need_deliver_as" ? "The agent started running; choose Steer or Queue and send again." : errText(e));
          return false;
        }
      }
    }
  };

  const respondUi = async (uiId: string, response: UiResponse) => {
    try { await call("ui_respond", { processId: pid, uiId, response }); store.markUiAnswered(pid, uiId); }
    catch (e) { if (errCode(e) === "not_found") { setError("Already answered on the computer."); store.markUiAnswered(pid, uiId); } else { setError(errText(e)); throw e; } }
  };

  const loadMore = async () => {
    const first = view?.messages.find((m: WireMessage) => m.entryId)?.entryId;
    if (!first) return;
    try { const r = await call("get_history", { processId: pid, beforeEntryId: first }); store.prependHistory(pid, r.messages, r.hasMoreBefore); }
    catch (e) { setError(errText(e)); }
  };

  const title = info ? processTitle(info) : "Session";
  const usage = info?.contextUsage?.percent;
  const widgetsAbove = Object.entries(view?.extWidgets ?? {}).filter(([, w]) => w.placement !== "belowEditor");
  const widgetsBelow = Object.entries(view?.extWidgets ?? {}).filter(([, w]) => w.placement === "belowEditor");
  const statusLine = Object.values(view?.extStatus ?? {}).join("  ·  ");
  const role = info?.role;

  const Widgets = ({ list }: { list: [string, { lines: string[] }][] }) => list.length ? (
    <View style={{ maxHeight: 160, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.bg }}>
      <ScrollView>
        {list.map(([k, w]) => (
          <ScrollView key={k} horizontal accessibilityLabel={`widget-${k}`}>
            <View style={{ paddingHorizontal: 8, paddingVertical: 2 }}>{w.lines.map((l, i) => <T key={i} mono size={11}>{l || " "}</T>)}</View>
          </ScrollView>
        ))}
      </ScrollView>
    </View>
  ) : null;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="height">
      <Stack.Screen options={{
        headerTitle: () => (
          <Pressable accessibilityRole="button" accessibilityLabel="session-title" onPress={() => info && setSheet("session")} style={{ maxWidth: 220 }}>
            <T bold numberOfLines={1}>{title}</T>
            <T dim size={11} numberOfLines={1}>{info ? (info.status === "waiting_ui" ? "Needs input" : info.status === "running" ? "Running" : "Idle") : ""}{usage != null ? ` · ${usage.toFixed(0)}% context` : ""}</T>
          </Pressable>
        ),
      }} />
      {info ? (
        <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 10, paddingVertical: 6, flexWrap: "wrap", backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border }}>
          <Chip a11y="chip-model" label={info.model ? info.model.id : "No model"} onPress={() => ready && setSheet("model")} />
          <Chip a11y="chip-thinking" label={`think ${info.thinkingLevel}`} onPress={() => ready && setSheet("thinking")} />
          {parent ? <Chip a11y="chip-parent" label={`↑ ${processTitle(parent)}`} onPress={() => openProcess(parent.processId)} /> : null}
        </View>
      ) : null}
      {role && role.kind !== "main" ? (
        <T a11y="session-role" dim size={12} style={{ paddingHorizontal: 10, paddingTop: 4 }}>
          {role.kind === "subagent" ? `Subagent ${role.name}${role.agent ? ` · agent ${role.agent}` : ""}${role.autoExit ? " · exits when done" : ""}`
            : `Member ${role.name}${role.agent ? ` · agent ${role.agent}` : ""} · ${role.write ? `writes branch ${role.branch ?? ""}` : "read-only"}${role.worktree ? `\n${role.worktree}` : ""}`}
        </T>
      ) : null}
      {statusLine ? <T a11y="session-ext-status" dim size={11} numberOfLines={1} style={{ paddingHorizontal: 10, paddingTop: 2 }}>{statusLine}</T> : null}
      <ChildStrip children={children} />

      {view?.gone || (!procInfo && conn === "ready") ? (
        <Card a11y="session-gone" style={{ margin: 10, gap: 8 }}>
          <T bold>The pi process has exited.</T>
          {info?.sessionFile ? <Btn a11y="session-reopen" kind="primary" label="Reopen this session" busy={!!flow.busy} onPress={() => void flow.openSession(info.sessionFile!, info.cwd)} /> : null}
        </Card>
      ) : null}
      {loadError ? <T color={c.danger} style={{ padding: 10 }}>{loadError}</T> : null}

      {view ? (
        <Transcript messages={view.messages} inflight={view.inflight} running={view.runningTools} hasMoreBefore={view.hasMoreBefore} onLoadMore={loadMore} hideThinking={hideThinking} />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>{conn === "ready" && procInfo ? <ActivityIndicator /> : <T dim>{conn === "ready" ? "" : "Not connected"}</T>}</View>
      )}

      {view?.toasts.length ? (
        <View style={{ position: "absolute", top: 90, left: 10, right: 10, gap: 4 }} pointerEvents="none">
          {view.toasts.slice(-3).map((t) => (
            <View key={t.id} accessibilityLabel="toast" style={{ backgroundColor: t.level === "error" ? c.danger : t.level === "warning" ? c.warn : c.cardAlt, borderRadius: 8, padding: 8, opacity: 0.95 }}>
              <T size={13} color={t.level === "info" ? c.text : "#fff"}>{t.text}</T>
            </View>
          ))}
        </View>
      ) : null}

      <Widgets list={widgetsAbove} />
      <View style={{ paddingHorizontal: 8, gap: 6 }}>
        {view?.pendingRpiv.map((p) => (
          <Card key={p.toolCallId} a11y={`rpiv-card-${p.toolCallId}`} onPress={() => setRpivOpen(p)} style={{ borderColor: c.warn, gap: 4 }}>
            <T bold>Questions from pi ({p.questions.length})</T>
            <T dim size={13} numberOfLines={2}>{p.questions.map((q) => q.header || q.question).join(" · ")}</T>
            <T size={13} color={c.accent}>Tap to answer</T>
          </Card>
        ))}
        {view?.pendingUi.filter((u) => !(u.kind === "custom" && u.coveredBy)).map((u) => (
          <UiRequestCard key={u.uiId} req={u} onRespond={(r) => respondUi(u.uiId, r)} />
        ))}
      </View>
      {confirm ? (
        <Card a11y="session-confirm" style={{ margin: 8, gap: 8 }}>
          <T bold>{confirm.title}</T>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn a11y="session-confirm-yes" kind="primary" label="Confirm" onPress={() => { const r = confirm.run; setConfirm(undefined); void r(); }} />
            <Btn a11y="session-confirm-no" label="Cancel" onPress={() => setConfirm(undefined)} />
          </View>
        </Card>
      ) : null}
      <Composer
        disabled={!ready}
        disabledReason={conn !== "ready" ? "Not connected" : undefined}
        running={running}
        imagesAllowed={!!info?.model?.input.includes("image")}
        commands={commands}
        text={text}
        setText={setText}
        onSend={onSend}
        onAbort={() => void doCall(() => call("abort", { processId: pid }))}
      />
      <Widgets list={widgetsBelow} />

      {sheet === "model" ? <ModelSheet processId={pid} onClose={() => setSheet(undefined)} /> : null}
      {sheet === "thinking" ? <ThinkingSheet processId={pid} onClose={() => setSheet(undefined)} /> : null}
      {sheet === "tree" ? <TreeSheet processId={pid} running={running} defaultFilter={treeFilter} onClose={() => setSheet(undefined)} /> : null}
      {sheet === "fork" ? <ForkSheet processId={pid} onClose={() => setSheet(undefined)} onPrefill={setText} /> : null}
      {sheet === "resume" && info ? <ResumeSheet processId={pid} cwd={info.cwd} currentFile={info.sessionFile} onClose={() => setSheet(undefined)} /> : null}
      {sheet === "compact" ? <CompactSheet processId={pid} onClose={() => setSheet(undefined)} /> : null}
      {(sheet === "session" || sheet === "rename") && info ? <SessionInfoSheet info={info} renameFirst={sheet === "rename"} onClose={() => setSheet(undefined)} /> : null}
      <RpivSheet prompt={rpivOpen} onClose={() => setRpivOpen(undefined)} onSubmit={(answer) => call("rpiv_answer", { processId: pid, answer })} />
      <TrustDialog {...flow.trustDialog} />
      <ErrorBox text={error ?? flow.error} onClose={() => { setError(undefined); flow.clearError(); }} />
    </KeyboardAvoidingView>
  );
}

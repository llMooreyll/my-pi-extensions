import { useEffect, useState } from "react";
import { View } from "react-native";
import type { RpivAnswer, RpivAnswerItem, RpivPrompt, UiRequest, UiResponse } from "@pi-remote/protocol";
import { Button, Choice, Field, Rule, Sheet, Txt } from "../ds/primitives";
import { MARGIN, usePalette } from "../ds/tokens";
import { useTestAction } from "../lib/test-hooks";

function useCountdown(timeoutMs?: number): number | undefined {
  const [start] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!timeoutMs) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timeoutMs]);
  return timeoutMs ? Math.max(0, Math.ceil((start + timeoutMs - now) / 1000)) : undefined;
}

/** One dialog an extension opened on the computer, answerable here. */
function UiRequestView({ req, onRespond }: { req: UiRequest; onRespond: (r: UiResponse) => Promise<void> }) {
  const p = usePalette();
  const [submitted, setSubmitted] = useState(false);
  const [value, setValue] = useState(req.kind === "editor" ? req.prefill ?? "" : "");
  const left = useCountdown("timeoutMs" in req ? req.timeoutMs : undefined);
  const dis = submitted || left === 0;
  const answer = async (r: UiResponse) => { setSubmitted(true); try { await onRespond(r); } catch { setSubmitted(false); } };
  if (req.kind === "custom") {
    return (
      <View accessibilityLabel="ui-card" style={{ gap: 8 }}>
        <Txt v="lead">{req.title || "An extension opened its own screen on the computer."}</Txt>
        <Txt v="small" soft>It can only be used there. You can close it from here.</Txt>
        <Button kind="outline" a11y="ui-custom-cancel" label="close it on the computer" color={p.pink} style={{ alignSelf: "flex-start" }} disabled={dis} onPress={() => void answer({ cancelled: true })} />
      </View>
    );
  }
  return (
    <View accessibilityLabel="ui-card" style={{ gap: 10, opacity: dis ? 0.5 : 1 }}>
      <Txt v="title" a11y="ui-title">{req.title}</Txt>
      {req.kind === "confirm" ? <Txt v="body">{req.message}</Txt> : null}
      {req.kind === "select" ? (
        <View>
          {req.options.map((o, i) => <Choice key={i} a11y={`ui-option-${i}`} label={o} disabled={dis} onPress={() => void answer({ value: o })} />)}
        </View>
      ) : null}
      {req.kind === "input" || req.kind === "editor" ? (
        <Field a11y="ui-input" value={value} onChangeText={setValue} placeholder={req.kind === "input" ? req.placeholder : undefined}
          multiline={req.kind === "editor"} style={req.kind === "editor" ? { minHeight: 110, textAlignVertical: "top" } : undefined} editable={!dis} />
      ) : null}
      {req.kind === "confirm" ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Button kind="solid" a11y="ui-confirm" label="Yes" disabled={dis} onPress={() => void answer({ confirmed: true })} style={{ flex: 1 }} />
          <Button kind="outline" a11y="ui-cancel" label="No" disabled={dis} onPress={() => void answer({ confirmed: false })} style={{ flex: 1 }} />
        </View>
      ) : null}
      {req.kind === "input" || req.kind === "editor" ? <Button kind="solid" a11y="ui-submit" label="Send answer" disabled={dis} onPress={() => void answer({ value })} /> : null}
      {req.kind !== "confirm" ? <Button a11y="ui-cancel" label="dismiss" disabled={dis} onPress={() => void answer({ cancelled: true })} /> : null}
      {left !== undefined ? <Txt v="label" soft>{left === 0 ? "timed out on the computer" : `${left}s left`}</Txt> : null}
      {submitted ? <Txt v="label" soft a11y="ui-submitted">sent</Txt> : null}
    </View>
  );
}

/** Everything pi is waiting on, docked above the composer in pink so it cannot be missed. */
export function AttentionDock(props: { ui: UiRequest[]; rpiv: RpivPrompt[]; onRespond: (uiId: string, r: UiResponse) => Promise<void>; onOpenRpiv: (p: RpivPrompt) => void }) {
  const p = usePalette();
  const ui = props.ui.filter((u) => !(u.kind === "custom" && u.coveredBy));
  if (!ui.length && !props.rpiv.length) return null;
  return (
    <View accessibilityLabel="attention-dock" style={{ backgroundColor: p.paper, maxHeight: 420 }}>
      <Rule weight={3} color={p.pink} />
      <View style={{ paddingHorizontal: MARGIN, paddingVertical: 12, gap: 16 }}>
        <Txt v="label" color={p.pink}>● pi is waiting for you</Txt>
        {props.rpiv.map((r) => <RpivLine key={r.toolCallId} prompt={r} onOpen={() => props.onOpenRpiv(r)} />)}
        {ui.map((u) => <UiRequestView key={u.uiId} req={u} onRespond={(r) => props.onRespond(u.uiId, r)} />)}
      </View>
    </View>
  );
}

function RpivLine({ prompt, onOpen }: { prompt: RpivPrompt; onOpen: () => void }) {
  const p = usePalette();
  useTestAction(`rpiv-card-${prompt.toolCallId}`, onOpen);
  return (
    <View style={{ gap: 6 }}>
      <Txt v="title">{prompt.questions.length === 1 ? "One question" : `${prompt.questions.length} questions`} for you</Txt>
      <Txt v="small" soft lines={2}>{prompt.questions.map((q) => q.header || q.question).join(" · ")}</Txt>
      <Button kind="solid" a11y={`rpiv-card-open-${prompt.toolCallId}`} label="Answer" color={p.pink} onPress={onOpen} />
    </View>
  );
}

interface QState { selected: number[]; text: string }

/** ask_user_question: one page per question, then a review page. */
export function RpivSheet({ prompt, onClose, onSubmit }: { prompt?: RpivPrompt; onClose: () => void; onSubmit: (a: RpivAnswer) => Promise<{ ok: boolean; reason?: string }> }) {
  const p = usePalette();
  const [page, setPage] = useState(0);
  const [state, setState] = useState<QState[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPage(0); setState([]); setError(undefined); }, [prompt?.toolCallId]);
  if (!prompt) return null;
  const qs = prompt.questions;
  const st = (i: number): QState => state[i] ?? { selected: [], text: "" };
  const update = (i: number, s: QState) => { const n = [...state]; n[i] = s; setState(n); };
  const review = page >= qs.length;

  const submit = async (cancel: boolean) => {
    setBusy(true);
    setError(undefined);
    let answer: RpivAnswer;
    if (cancel) answer = { toolCallId: prompt.toolCallId, cancel: true };
    else {
      const answers: RpivAnswerItem[] = [];
      qs.forEach((q, i) => {
        const s = st(i);
        if (q.multiSelect) {
          if (s.selected.length || s.text.trim()) answers.push({ questionIndex: i, ...(s.selected.length ? { optionIndexes: s.selected } : {}), ...(s.text.trim() ? { text: s.text.trim() } : {}) });
        } else if (s.text.trim() && !s.selected.length) answers.push({ questionIndex: i, text: s.text.trim() });
        else if (s.selected.length) answers.push({ questionIndex: i, optionIndexes: [s.selected[0]!] });
      });
      answer = { toolCallId: prompt.toolCallId, answers };
    }
    try {
      const r = await onSubmit(answer);
      if (!r.ok) setError(r.reason ?? "pi did not accept the answer"); else onClose();
    } catch (e) { setError((e as Error)?.message ?? String(e)); }
    finally { setBusy(false); }
  };

  const q = qs[page];
  return (
    <Sheet visible a11y="rpiv-sheet" kicker={review ? "check before sending" : `question ${page + 1} of ${qs.length}${q?.header ? ` · ${q.header}` : ""}`}
      title={review ? "Your answers" : q?.multiSelect ? "Pick any" : "Pick one"} onClose={onClose}
      footer={
        <View style={{ gap: 12 }}>
          {!review ? <Button kind="solid" a11y="rpiv-next" label={page === qs.length - 1 ? "Review" : "Next question"} onPress={() => setPage(page + 1)} />
            : <Button kind="solid" a11y="rpiv-submit" label="Send answers" color={p.pink} busy={busy} onPress={() => void submit(false)} />}
          <View style={{ flexDirection: "row", gap: 20 }}>
            {page > 0 ? <Button a11y="rpiv-prev" label="back" onPress={() => setPage(page - 1)} /> : null}
            <Button a11y="rpiv-decline" label="decline to answer" color={p.danger} disabled={busy} onPress={() => void submit(true)} />
          </View>
        </View>
      }>
      {error ? <Txt v="small" color={p.danger} a11y="rpiv-error" style={{ marginTop: 10 }}>{error}</Txt> : null}
      {!review && q ? (
        <>
          <Txt v="title" a11y="rpiv-question" style={{ marginTop: 14, marginBottom: 6 }}>{q.question}</Txt>
          {q.options.map((o, i) => {
            const s = st(page);
            const sel = s.selected.includes(i);
            return (
              <Choice key={i} a11y={`rpiv-option-${i}`} label={o.label} selected={sel}
                sub={[o.description, o.hasPreview ? "preview only on the computer" : ""].filter(Boolean).join(" · ")}
                onPress={() => update(page, { ...s, selected: q.multiSelect ? (sel ? s.selected.filter((x) => x !== i) : [...s.selected, i]) : [i], text: q.multiSelect ? s.text : "" })} />
            );
          })}
          <View style={{ marginTop: 14 }}>
            <Field a11y="rpiv-text" label={q.multiSelect ? "add a note" : "or write your own answer"} value={st(page).text}
              onChangeText={(t) => update(page, { selected: q.multiSelect ? st(page).selected : [], text: t })} />
          </View>
        </>
      ) : (
        qs.map((qq, i) => {
          const s = st(i);
          const picked = [...s.selected.map((x) => qq.options[x]?.label ?? "?"), ...(s.text.trim() ? [`“${s.text.trim()}”`] : [])].join(", ");
          return (
            <View key={i} style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: p.faint }}>
              <Txt v="label" soft>{qq.header || `question ${i + 1}`}</Txt>
              <Txt v="body" color={picked ? p.ink : p.danger}>{picked || "no answer"}</Txt>
            </View>
          );
        })
      )}
    </Sheet>
  );
}

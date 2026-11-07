import { useState } from "react";
import { View } from "react-native";
import type { RpivAnswer, RpivAnswerItem, RpivPrompt } from "@pi-remote/protocol";
import { Btn, Field, T } from "./kit";
import { Option, Sheet } from "./Sheet";
import { usePalette } from "./theme";

interface QState { selected: number[]; text: string }

export function RpivSheet({ prompt, onClose, onSubmit }: { prompt?: RpivPrompt; onClose: () => void; onSubmit: (a: RpivAnswer) => Promise<{ ok: boolean; reason?: string }> }) {
  const c = usePalette();
  const [page, setPage] = useState(0);
  const [state, setState] = useState<QState[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  if (!prompt) return null;
  const qs = prompt.questions;
  const st = (i: number): QState => state[i] ?? { selected: [], text: "" };
  const update = (i: number, s: QState) => { const n = [...state]; n[i] = s; setState(n); };
  const last = page >= qs.length;

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
      if (!r.ok) setError(r.reason ?? "Rejected"); else { setPage(0); setState([]); onClose(); }
    } catch (e) { setError((e as Error)?.message ?? String(e)); }
    finally { setBusy(false); }
  };

  const q = qs[page];
  return (
    <Sheet visible a11y="rpiv-sheet" title={last ? "Review answers" : `${q?.header || "Question"} (${page + 1}/${qs.length})`} onClose={onClose}
      footer={
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {page > 0 ? <Btn a11y="rpiv-prev" label="Back" onPress={() => setPage(page - 1)} /> : null}
          {!last ? <Btn a11y="rpiv-next" kind="primary" label="Next" onPress={() => setPage(page + 1)} /> : <Btn a11y="rpiv-submit" kind="primary" label="Submit" busy={busy} onPress={() => void submit(false)} />}
          <Btn a11y="rpiv-decline" kind="danger" label="Decline" disabled={busy} onPress={() => void submit(true)} />
        </View>
      }>
      {error ? <T color={c.danger} a11y="rpiv-error">{error}</T> : null}
      {!last && q ? (
        <>
          <T bold a11y="rpiv-question">{q.question}</T>
          <T dim size={12}>{q.multiSelect ? "Select any" : "Select one"}</T>
          {q.options.map((o, i) => {
            const s = st(page);
            const sel = s.selected.includes(i);
            return (
              <Option key={i} a11y={`rpiv-option-${i}`} label={o.label} sub={[o.description, o.hasPreview ? "(preview available on the computer)" : ""].filter(Boolean).join(" ")} selected={sel}
                onPress={() => update(page, { ...s, selected: q.multiSelect ? (sel ? s.selected.filter((x) => x !== i) : [...s.selected, i]) : [i], text: q.multiSelect ? s.text : "" })} />
            );
          })}
          <Field a11y="rpiv-text" value={st(page).text} onChangeText={(t) => update(page, { selected: q.multiSelect ? st(page).selected : [], text: t })} placeholder={q.multiSelect ? "Additional note (optional)" : "Other (type your own answer)"} />
        </>
      ) : (
        qs.map((qq, i) => {
          const s = st(i);
          const picked = [...s.selected.map((x) => qq.options[x]?.label ?? "?"), ...(s.text.trim() ? [s.text.trim()] : [])].join(", ");
          return <T key={i} size={14}><T bold size={14}>{qq.header || qq.question}: </T>{picked || "(no answer)"}</T>;
        })
      )}
    </Sheet>
  );
}

import { useEffect, useState } from "react";
import { View } from "react-native";
import type { UiRequest, UiResponse } from "@pi-remote/protocol";
import { Btn, Card, Field, T } from "./kit";
import { usePalette } from "./theme";

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

export function UiRequestCard({ req, onRespond }: { req: UiRequest; onRespond: (r: UiResponse) => Promise<void> }) {
  const c = usePalette();
  const [submitted, setSubmitted] = useState(false);
  const [value, setValue] = useState(req.kind === "editor" ? req.prefill ?? "" : "");
  const left = useCountdown("timeoutMs" in req ? req.timeoutMs : undefined);
  const expired = left === 0;
  const answer = async (r: UiResponse) => { setSubmitted(true); try { await onRespond(r); } catch { setSubmitted(false); } };
  const a = (s: string) => `ui-${s}`;
  const dis = submitted || expired;
  return (
    <Card a11y={a("card")} style={{ gap: 8, borderColor: c.warn, opacity: dis ? 0.6 : 1 }}>
      {req.kind === "custom" ? (
        <>
          <T bold>Extension UI is open on the computer</T>
          {req.title ? <T dim size={13}>{req.title}</T> : null}
          <Btn a11y={a("custom-cancel")} kind="danger" small label="Cancel this UI" disabled={dis} onPress={() => void answer({ cancelled: true })} />
        </>
      ) : (
        <>
          <T bold a11y={a("title")}>{req.title}</T>
          {req.kind === "confirm" ? <T size={14}>{req.message}</T> : null}
          {req.kind === "select" ? req.options.map((o, i) => (
            <Btn key={i} a11y={a(`option-${i}`)} label={o} disabled={dis} onPress={() => void answer({ value: o })} style={{ alignItems: "flex-start", justifyContent: "flex-start" }} />
          )) : null}
          {req.kind === "input" || req.kind === "editor" ? (
            <Field a11y={a("input")} value={value} onChangeText={setValue} placeholder={req.kind === "input" ? req.placeholder : undefined}
              multiline={req.kind === "editor"} style={req.kind === "editor" ? { minHeight: 120, textAlignVertical: "top" } : undefined} editable={!dis} />
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {req.kind === "confirm" ? <Btn a11y={a("confirm")} kind="primary" label="Confirm" disabled={dis} onPress={() => void answer({ confirmed: true })} /> : null}
            {req.kind === "input" || req.kind === "editor" ? <Btn a11y={a("submit")} kind="primary" label="OK" disabled={dis} onPress={() => void answer({ value })} /> : null}
            <Btn a11y={a("cancel")} label="Cancel" disabled={dis} onPress={() => void answer(req.kind === "confirm" ? { confirmed: false } : { cancelled: true })} />
          </View>
          {left !== undefined ? <T dim size={12}>{expired ? "Timed out" : `${left}s left`}</T> : null}
        </>
      )}
      {submitted ? <T dim size={12} a11y={a("submitted")}>Submitted</T> : null}
    </Card>
  );
}

import { useState } from "react";
import { call, errText } from "../net/connection";
import { Btn, Field, T } from "./kit";
import { Sheet } from "./Sheet";
import { usePalette } from "./theme";

export function CompactSheet({ processId, onClose }: { processId: string; onClose: () => void }) {
  const c = usePalette();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = async () => {
    setBusy(true); setError(undefined);
    try { await call("compact", { processId, ...(text.trim() ? { customInstructions: text.trim() } : {}) }, 620_000); onClose(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Sheet visible a11y="compact-sheet" title="Compact context" onClose={onClose}>
      <Field a11y="compact-input" value={text} onChangeText={setText} placeholder="Optional instructions for the summary" multiline />
      {error ? <T color={c.danger} a11y="compact-error">{error}</T> : null}
      {busy ? <T dim>Compacting… this can take a while.</T> : null}
      <Btn a11y="compact-run" kind="primary" label="Compact" busy={busy} onPress={() => void run()} />
    </Sheet>
  );
}

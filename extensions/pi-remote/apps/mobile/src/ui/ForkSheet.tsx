import { useEffect, useState } from "react";
import { ActivityIndicator } from "react-native";
import type { ForkPoint } from "@pi-remote/protocol";
import { call, errText } from "../net/connection";
import { T } from "./kit";
import { Option, Sheet } from "./Sheet";
import { usePalette } from "./theme";

export function ForkSheet({ processId, onClose, onPrefill }: { processId: string; onClose: () => void; onPrefill: (t: string) => void }) {
  const c = usePalette();
  const [points, setPoints] = useState<ForkPoint[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { call("get_fork_points", { processId }).then((r) => setPoints([...r.points].reverse()), (e) => setError(errText(e))); }, [processId]);
  return (
    <Sheet visible a11y="fork-sheet" title="Fork from message" onClose={onClose}>
      {error ? <T color={c.danger} a11y="fork-error">{error}</T> : null}
      {!points && !error ? <ActivityIndicator /> : null}
      {points?.length === 0 ? <T dim>No user messages on this branch.</T> : null}
      {busy ? <ActivityIndicator /> : null}
      {points?.map((p, i) => (
        <Option key={p.entryId} a11y={`fork-point-${i}`} label={p.text.slice(0, 160) || "(empty)"} disabled={busy}
          onPress={async () => {
            setBusy(true);
            try {
              const r = await call("fork", { processId, entryId: p.entryId, position: "before" }, 70_000);
              if (!r.cancelled && r.prefillText !== undefined) onPrefill(r.prefillText);
              onClose();
            } catch (e) { setError(errText(e)); } finally { setBusy(false); }
          }} />
      ))}
    </Sheet>
  );
}

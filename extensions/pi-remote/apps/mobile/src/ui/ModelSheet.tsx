import { Spinner } from "./Spinner";
import { Fragment, useEffect, useState } from "react";
import type { ModelSummary } from "@pi-remote/protocol";
import { call, errCode, errText } from "../net/connection";
import { T } from "./kit";
import { Option, Sheet } from "./Sheet";
import { usePalette } from "./theme";

export function ModelSheet({ processId, onClose }: { processId: string; onClose: () => void }) {
  const c = usePalette();
  const [models, setModels] = useState<ModelSummary[] | undefined>();
  const [current, setCurrent] = useState<ModelSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    call("get_models", { processId }).then((r) => { setModels(r.models); setCurrent(r.current); }, (e) => setError(errText(e)));
  }, [processId]);
  const pick = async (m: ModelSummary) => {
    try { await call("set_model", { processId, provider: m.provider, id: m.id }); onClose(); }
    catch (e) { setError(errCode(e) === "no_auth" ? "This provider is not logged in. Run /login on the computer." : errText(e)); }
  };
  const groups = new Map<string, ModelSummary[]>();
  for (const m of models ?? []) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return (
    <Sheet visible a11y="model-sheet" title="Model" onClose={onClose}>
      {error ? <T color={c.danger} a11y="model-error">{error}</T> : null}
      {!models && !error ? <Spinner /> : null}
      {[...groups].map(([prov, ms]) => (
        <Fragment key={prov}>
          <T dim size={12} bold style={{ marginTop: 6 }}>{prov}</T>
          {ms.map((m) => (
            <Option key={`${m.provider}/${m.id}`} a11y={`model-${m.provider}/${m.id}`} label={m.name} selected={current?.provider === m.provider && current?.id === m.id}
              sub={[m.id, m.input.includes("image") ? "images" : "text only", m.reasoning ? "reasoning" : ""].filter(Boolean).join(" · ")} onPress={() => void pick(m)} />
          ))}
        </Fragment>
      ))}
    </Sheet>
  );
}

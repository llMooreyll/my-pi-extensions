// AI tool send_to_phone: offer files on this computer to the paired phone (plan 7.7.3, D21).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatBytes, type RemoteError, type TransferInfo } from "../../protocol/src/index.ts";
import { logError } from "./log.ts";
import { g } from "./state.ts";

const OFFER_TIMEOUT_MS = 300_000;   // packing a large folder takes a while

export function registerSendTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "send_to_phone",
    label: "Send to phone",
    description:
      "Offer files or folders on this computer to the user's phone (pi-remote app). Folders are sent as a .zip. " +
      "Returns at once after the files are registered; the user downloads them in the app later.",
    promptSnippet: "Send files or folders from this computer to the user's phone",
    promptGuidelines: [
      "Use send_to_phone only when the user asks to receive files on their phone; send_to_phone does not wait for the download to finish.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "File or folder path, absolute or relative to the working directory" }), { minItems: 1, maxItems: 20 }),
      note: Type.Optional(Type.String({ maxLength: 500, description: "Short note shown with the files on the phone" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const s = g();
      if (!s.enabled || !s.conn) throw new Error("pi-remote is not running on this computer (pi-hostd is not connected)");
      const args = {
        processId: s.processId,
        ...(s.binding?.sessionId ? { sessionId: s.binding.sessionId } : {}),
        cwd: ctx.cwd,
        paths: params.paths,
        ...(params.note ? { note: params.note } : {}),
      };
      let res: { transfers: TransferInfo[] };
      try {
        res = await new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error("Cancelled"));
          signal?.addEventListener("abort", onAbort, { once: true });
          s.conn!.call("offer_files", args, OFFER_TIMEOUT_MS).then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
        });
      } catch (e) {
        const r = e as RemoteError;
        if (!(e instanceof Error)) logError("send_to_phone", r);
        throw new Error(typeof r?.message === "string" ? r.message : String(e));
      }
      const lines = res.transfers.map((t) => `${t.name} (${formatBytes(t.size)})`);
      return {
        content: [{ type: "text", text: `Offered to the phone:\n${lines.join("\n")}\nThe user can download them in the pi-remote app.` }],
        details: { transfers: res.transfers },
      };
    },
  });
}

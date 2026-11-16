import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldContextBlocks } from "./blocks.ts";
import { installTurnTracking } from "./turns.ts";

/** Session plumbing used by both the document (text) and the video modules. Install before either. */
export function installShared(pi: ExtensionAPI): void {
  installTurnTracking(pi);
  pi.registerMarkdownTransformer((markdown, { messageType }) => (messageType === "user" ? foldContextBlocks(markdown) : markdown));
}

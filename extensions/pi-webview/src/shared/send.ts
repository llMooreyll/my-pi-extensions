import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { composeMessage } from "./blocks.ts";

export interface SessionBinding {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
}

/** Send blocks + question as one user message; queued as a follow-up while pi is busy. */
export function deliverUserMessage(binding: SessionBinding, blocks: string[], question: string, images: ImageContent[]): "now" | "queued" {
  const text = composeMessage(blocks, question);
  const idle = binding.ctx.isIdle();
  binding.pi.sendUserMessage(images.length ? [{ type: "text", text }, ...images] : text, idle ? undefined : { deliverAs: "followUp" });
  return idle ? "now" : "queued";
}

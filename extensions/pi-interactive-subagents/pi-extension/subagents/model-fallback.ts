import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Parse the comma-separated model list passed through PI_SUBAGENT_MODEL_FALLBACKS. */
export function parseModelFallbacks(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Switch the session to the next usable model in `fallbacks`, which is consumed
 * in place. Unusable entries are appended to `failures`. Returns the chosen
 * `provider/id`, or null when no entry is usable.
 */
export async function switchToNextModel(
  pi: ExtensionAPI,
  registry: { find(provider: string, modelId: string): any },
  fallbacks: string[],
  failures: string[],
): Promise<string | null> {
  while (fallbacks.length > 0) {
    const next = fallbacks.shift()!;
    const slash = next.indexOf("/");
    const model = slash > 0 ? registry.find(next.slice(0, slash), next.slice(slash + 1)) : undefined;
    if (model && (await pi.setModel(model))) return next;
    failures.push(`${next} (unknown model or no credentials)`);
  }
  return null;
}

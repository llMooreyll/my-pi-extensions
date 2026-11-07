import { handleTestUrl } from "../lib/test-hooks";

/** Test-hook URLs are handled here and never reach the router. */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    if (handleTestUrl(path)) return initial ? "/" : null;
  } catch {
    return initial ? "/" : null;
  }
  return path;
}

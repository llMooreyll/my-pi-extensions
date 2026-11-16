import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installShared } from "./shared/index.ts";
import { registerText } from "./text/index.ts";
import { registerVideo } from "./video/index.ts";

export default function piWebview(pi: ExtensionAPI): void {
  // Shared turn tracking must register its session listeners before the feature modules.
  installShared(pi);
  registerText(pi);
  registerVideo(pi);
}

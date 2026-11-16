import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Panel appearance and behaviour: user preferences shared by every site and every pi session. */
export interface VideoSettings {
  side: "right" | "left";
  width: number;
  fontSize: number;
  /** Subtitle size in the fullscreen wheel. */
  fullFontSize: number;
  /** Width of the fullscreen wheel, in percent of the screen width. */
  fullWidth: number;
  lineHeight: number;
  theme: "dark" | "light";
  /** push: the page shrinks to make room; overlay: the panel floats above the page. */
  layout: "push" | "overlay";
  collapsed: boolean;
  /** Show the current line over the video in the panel's style. */
  overlay: boolean;
  overlayFontSize: number;
  /** Hide the site's own captions while a local subtitle is shown. */
  hideNative: boolean;
  /** Keep the current line in view while playing. */
  follow: boolean;
  /** Prepend the playback position to messages typed in the pi terminal. */
  autoContext: boolean;
}

export const DEFAULT_SETTINGS: VideoSettings = {
  side: "right",
  width: 380,
  fontSize: 15,
  fullFontSize: 22,
  fullWidth: 17,
  lineHeight: 1.55,
  theme: "dark",
  layout: "push",
  collapsed: false,
  overlay: true,
  overlayFontSize: 24,
  hideNative: true,
  follow: true,
  autoContext: true,
};

interface StoreData {
  settings: VideoSettings;
  /** Subtitle choices of older versions; choices now live in each pi session. Kept as found. */
  subtitles?: unknown;
}

const clamp = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** Settings arrive from the page and from disk: both are untrusted. */
export function sanitizeSettings(input: unknown, base: VideoSettings = DEFAULT_SETTINGS): VideoSettings {
  const s = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    side: s.side === "left" || s.side === "right" ? s.side : base.side,
    width: Math.round(clamp(s.width, 260, 900, base.width)),
    fontSize: clamp(s.fontSize, 11, 32, base.fontSize),
    fullFontSize: clamp(s.fullFontSize, 14, 48, base.fullFontSize),
    fullWidth: Math.round(clamp(s.fullWidth, 10, 40, base.fullWidth)),
    lineHeight: clamp(s.lineHeight, 1.1, 2.4, base.lineHeight),
    theme: s.theme === "light" || s.theme === "dark" ? s.theme : base.theme,
    layout: s.layout === "push" || s.layout === "overlay" ? s.layout : base.layout,
    collapsed: bool(s.collapsed, base.collapsed),
    overlay: bool(s.overlay, base.overlay),
    overlayFontSize: clamp(s.overlayFontSize, 12, 64, base.overlayFontSize),
    hideNative: bool(s.hideNative, base.hideNative),
    follow: bool(s.follow, base.follow),
    autoContext: bool(s.autoContext, base.autoContext),
  };
}

const STORE_PATH = () => join(getAgentDir(), "pi-webview-video.json");

export class VideoStore {
  private data: StoreData;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    let raw: Partial<StoreData> = {};
    try {
      raw = JSON.parse(readFileSync(STORE_PATH(), "utf8"));
    } catch {
      // First run or unreadable file: defaults.
    }
    this.data = { settings: sanitizeSettings(raw.settings), ...(raw.subtitles ? { subtitles: raw.subtitles } : {}) };
  }

  get settings(): VideoSettings {
    return this.data.settings;
  }

  updateSettings(input: unknown): VideoSettings {
    this.data.settings = sanitizeSettings(input, this.data.settings);
    this.save();
    return this.data.settings;
  }

  private save(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.write(), 300);
  }

  /** Write pending changes now (shutdown). */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.write();
  }

  private write(): void {
    this.timer = undefined;
    const path = STORE_PATH();
    void mkdir(dirname(path), { recursive: true })
      .then(() => writeFile(path, `${JSON.stringify(this.data, null, 2)}\n`, "utf8"))
      .catch(() => undefined);
  }
}

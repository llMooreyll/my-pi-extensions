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
  /** Annotations (ruby) from the subtitle file: below or above their words. */
  rubyPosition: "under" | "over";
  /** Annotation size, in percent of the line's text. */
  rubySize: number;
  /** Annotation opacity, in percent. */
  rubyOpacity: number;
  /** Line on the video: background opacity, in percent. */
  overlayBg: number;
  /** Line on the video: blur of the video behind it, in px. */
  overlayBlur: number;
  /** Line on the video: font weight. */
  overlayWeight: number;
  /** Line on the video: text shadow strength, in percent. */
  overlayShadow: number;
  /** Line on the video: distance from the bottom of the video, in percent of its height. */
  overlayBottom: number;
  /** Line on the video: widest it may get, in percent of the video width. */
  overlayWidth: number;
  /** Line on the video: corner radius, in px. */
  overlayRadius: number;
  /** Hide the site's own captions while a local subtitle is shown. */
  hideNative: boolean;
  /** Keep the current line in view while playing. */
  follow: boolean;
  /** Prepend the playback position to messages typed in the pi terminal. */
  autoContext: boolean;
  // Fullscreen wheel style.
  /** Radius of the wheel, in percent of the screen height: smaller turns lines away faster. */
  wheelRadius: number;
  /** Size of the lines next to the current one, in percent of the current line. */
  wheelSize: number;
  /** Brightness of the other lines, in percent. */
  wheelDim: number;
  /** Opacity of the other lines, in percent. */
  wheelOpacity: number;
  /** Blur of the farthest lines, in px. */
  wheelBlur: number;
  /** How far the rim bends toward the screen edge, in percent of the column width. */
  wheelBend: number;
  /** Gap between the current line and the screen edge, in px. */
  wheelEdge: number;
  /** Dark glow around the current line, in percent. */
  wheelGlow: number;
  /** Outline that thickens the current line, in px (a heavier font weight would rewrap it). */
  wheelBold: number;
  /** Opacity of the other lines when the wheel opens into a list, in percent. */
  listOpacity: number;
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
  rubyPosition: "under",
  rubySize: 60,
  rubyOpacity: 85,
  overlayBg: 40,
  overlayBlur: 18,
  overlayWeight: 400,
  overlayShadow: 50,
  overlayBottom: 7,
  overlayWidth: 86,
  overlayRadius: 12,
  hideNative: true,
  follow: true,
  autoContext: true,
  wheelRadius: 34,
  wheelSize: 86,
  wheelDim: 62,
  wheelOpacity: 62,
  wheelBlur: 2.4,
  wheelBend: 16,
  wheelEdge: 18,
  wheelGlow: 55,
  wheelBold: 0.4,
  listOpacity: 60,
};

type NumericKey = { [K in keyof VideoSettings]: VideoSettings[K] extends number ? K : never }[keyof VideoSettings];

/** Range of every numeric setting; also sent to the panel, which keeps its steppers inside it. */
export const SETTING_LIMITS: Record<NumericKey, [min: number, max: number]> = {
  width: [260, 900],
  fontSize: [11, 32],
  fullFontSize: [14, 48],
  fullWidth: [10, 40],
  lineHeight: [1.1, 2.4],
  overlayFontSize: [12, 64],
  rubySize: [30, 100],
  rubyOpacity: [20, 100],
  overlayBg: [0, 100],
  overlayBlur: [0, 40],
  overlayWeight: [300, 800],
  overlayShadow: [0, 100],
  overlayBottom: [0, 60],
  overlayWidth: [30, 100],
  overlayRadius: [0, 30],
  wheelRadius: [14, 80],
  wheelSize: [50, 100],
  wheelDim: [10, 100],
  wheelOpacity: [10, 100],
  wheelBlur: [0, 6],
  wheelBend: [0, 50],
  wheelEdge: [0, 120],
  wheelGlow: [0, 100],
  wheelBold: [0, 1.2],
  listOpacity: [10, 100],
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
  // Older files and other versions may lack a key: fall back to the defaults, not to undefined.
  const num = (key: NumericKey) => clamp(s[key], ...SETTING_LIMITS[key], base[key] ?? DEFAULT_SETTINGS[key]);
  return {
    side: s.side === "left" || s.side === "right" ? s.side : base.side,
    width: Math.round(num("width")),
    fontSize: num("fontSize"),
    fullFontSize: num("fullFontSize"),
    fullWidth: Math.round(num("fullWidth")),
    lineHeight: num("lineHeight"),
    theme: s.theme === "light" || s.theme === "dark" ? s.theme : base.theme,
    layout: s.layout === "push" || s.layout === "overlay" ? s.layout : base.layout,
    collapsed: bool(s.collapsed, base.collapsed),
    overlay: bool(s.overlay, base.overlay),
    overlayFontSize: num("overlayFontSize"),
    rubyPosition: s.rubyPosition === "under" || s.rubyPosition === "over" ? s.rubyPosition : (base.rubyPosition ?? DEFAULT_SETTINGS.rubyPosition),
    rubySize: num("rubySize"),
    rubyOpacity: num("rubyOpacity"),
    overlayBg: num("overlayBg"),
    overlayBlur: num("overlayBlur"),
    overlayWeight: Math.round(num("overlayWeight") / 100) * 100,
    overlayShadow: num("overlayShadow"),
    overlayBottom: num("overlayBottom"),
    overlayWidth: num("overlayWidth"),
    overlayRadius: num("overlayRadius"),
    hideNative: bool(s.hideNative, base.hideNative),
    follow: bool(s.follow, base.follow),
    autoContext: bool(s.autoContext, base.autoContext),
    wheelRadius: num("wheelRadius"),
    wheelSize: num("wheelSize"),
    wheelDim: num("wheelDim"),
    wheelOpacity: num("wheelOpacity"),
    wheelBlur: num("wheelBlur"),
    wheelBend: num("wheelBend"),
    wheelEdge: num("wheelEdge"),
    wheelGlow: num("wheelGlow"),
    wheelBold: num("wheelBold"),
    listOpacity: num("listOpacity"),
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

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const VIDEO_MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpg",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".3gp": "video/3gpp",
};

/** Gemini inlineData payload recommendation limit (~80MB base64 in request) */
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

/** Provided by pi-input-plus on globalThis[Symbol.for("pi.file-picker.v1")]. */
const FILE_PICKER_SYMBOL = Symbol.for("pi.file-picker.v1");

interface FilePickerService {
  readonly version: number;
  pick(
    ui: ExtensionUIContext,
    options: { cwd: string; title?: string; extensions?: string[]; selectDirectories?: boolean },
  ): Promise<{ path: string; isDirectory: boolean } | undefined>;
}

function getFilePicker(): FilePickerService | undefined {
  const service = (globalThis as unknown as Record<symbol, Partial<FilePickerService> | undefined>)[FILE_PICKER_SYMBOL];
  return service?.version === 1 && typeof service.pick === "function" ? (service as FilePickerService) : undefined;
}

function resolveUserPath(input: string, cwd: string): string {
  const unquoted = input.replace(/^(['"])(.*)\1$/, "$2");
  if (unquoted === "~") return homedir();
  if (unquoted.startsWith("~/")) return join(homedir(), unquoted.slice(2));
  return resolve(cwd, unquoted);
}

export default function registerVideo(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_video",
    description: "Read a local video file (mp4, webm, mov, etc.) and inject its raw multimodal bytes directly into the Gemini model context as an inlineData payload. The video remains embedded in the session context across turns.",
    promptSnippet: "Load a local video file into the model context as raw multimodal data",
    promptGuidelines: [
      "When the user's message contains a video reference written as name.mp4[/absolute/path.mp4], call read_video with the absolute path inside the brackets before answering.",
    ],
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Path to the local video file (relative or absolute)",
        },
      },
    },
    async execute(_id, { path }, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      const absPath = resolve(cwd, path);

      if (!existsSync(absPath)) {
        throw new Error(`Video file not found: ${path}`);
      }

      const ext = extname(absPath).toLowerCase();
      const mimeType = VIDEO_MIME_TYPES[ext] ?? "video/mp4";

      const stat = statSync(absPath);
      const sizeMB = stat.size / (1024 * 1024);

      if (stat.size > MAX_VIDEO_BYTES) {
        throw new Error(`Video file too large (${sizeMB.toFixed(2)} MB). Max supported inline size is 80 MB.`);
      }

      const data = readFileSync(absPath).toString("base64");

      return {
        content: [
          {
            type: "text",
            text: `Successfully loaded video "${path}" (${sizeMB.toFixed(2)} MB, MIME: ${mimeType}). Raw multimodal data is embedded in the conversation context.`,
          },
          {
            type: "image",
            data,
            mimeType,
          },
        ],
      };
    },
  });

  pi.registerCommand("read-video", {
    description: "Pick an .mp4 file and put name.mp4[/abs/path] in the prompt so the model loads it with read_video. Usage: /read-video [file]",
    handler: async (args, ctx) => {
      let path: string | undefined;
      if (args.trim()) {
        path = resolveUserPath(args.trim(), ctx.cwd);
      } else {
        const picker = getFilePicker();
        if (ctx.mode !== "tui" || !picker) {
          ctx.ui.notify("Pass a file: /read-video <file> (the file picker needs the TUI and the pi-input-plus extension)", "error");
          return;
        }
        const picked = await picker.pick(ctx.ui, {
          cwd: ctx.cwd,
          title: "Pick an MP4 video",
          extensions: [".mp4"],
          selectDirectories: false,
        });
        path = picked?.path;
      }
      if (!path) return;

      if (!existsSync(path) || !statSync(path).isFile()) {
        ctx.ui.notify(`Video file not found: ${path}`, "error");
        return;
      }
      ctx.ui.pasteToEditor(`${basename(path)}[${path}] `);
    },
  });
}

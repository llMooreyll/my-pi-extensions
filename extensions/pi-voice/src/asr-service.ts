import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AsyncLimiter } from "./async-limiter.js";
import { FILE_SAMPLE_RATE } from "./file-audio.js";
import type { TranscribeSettings } from "./settings.js";
import type { Transcript, TranscriptionService } from "./transcription-service.js";

export const PI_ASR_SYMBOL = Symbol.for("pi.asr.v1");

const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_DECODES = 2;

export type PiAsrStatus = {
  readonly available: boolean;
  readonly configured: boolean;
  readonly modelId?: string;
  readonly reason?: string;
};

export type PiAsrResult = Transcript & {
  readonly modelId: string;
  readonly seconds: number;
};

export type PiAsrPcmOptions = {
  readonly signal?: AbortSignal;
};

export type PiAsrAudioOptions = {
  readonly mimeType?: string;
  readonly signal?: AbortSignal;
};

export type PiAsrFileOptions = {
  readonly signal?: AbortSignal;
};

export interface PiAsrService {
  readonly version: 1;
  getStatus(): Promise<PiAsrStatus>;
  transcribePcm(pcm: Float32Array, options?: PiAsrPcmOptions): Promise<PiAsrResult>;
  transcribeAudio(audio: Uint8Array, options?: PiAsrAudioOptions): Promise<PiAsrResult>;
  transcribeFile(path: string, options?: PiAsrFileOptions): Promise<PiAsrResult>;
}

export type PiAsrController = PiAsrService & {
  shutdown(): Promise<void>;
};

type AsrServiceDeps = {
  getSettings: () => Promise<TranscribeSettings>;
  getService: () => Promise<TranscriptionService>;
  isLoaded?: () => boolean;
};

export function createPiAsrService(deps: AsrServiceDeps): PiAsrController {
  let shuttingDown = false;
  const shutdownController = new AbortController();
  const operations = new Set<Promise<unknown>>();
  const decodeLimiter = new AsyncLimiter(MAX_CONCURRENT_DECODES);

  function track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      operations.delete(tracked);
    });
    operations.add(tracked);
    return tracked;
  }

  function combinedSignal(signal?: AbortSignal): AbortSignal {
    if (shuttingDown) throw new Error("Pi Voice is shutting down");
    const opSignal = signal
      ? AbortSignal.any([signal, shutdownController.signal])
      : shutdownController.signal;
    opSignal.throwIfAborted();
    return opSignal;
  }

  async function runPcm(pcm: Float32Array, opSignal: AbortSignal): Promise<PiAsrResult> {
    if (pcm.length === 0) throw new Error("No audio samples were provided");
    const configured = await deps.getSettings();
    opSignal.throwIfAborted();
    const service = await deps.getService();
    opSignal.throwIfAborted();
    const transcript = await service.transcribeFile(configured, pcm, opSignal);
    return {
      ...transcript,
      modelId: configured.model.id,
      seconds: pcm.length / FILE_SAMPLE_RATE,
    };
  }

  return {
    version: 1,

    async getStatus(): Promise<PiAsrStatus> {
      if (shuttingDown) {
        return { available: false, configured: false, reason: "Pi Voice is shutting down" };
      }
      if (deps.isLoaded?.()) {
        try {
          const settings = await deps.getSettings();
          return { available: true, configured: true, modelId: settings.model.id };
        } catch (error) {
          return {
            available: true,
            configured: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const { readSettings } = await import("./settings.js");
      const { settings, warning } = await readSettings();
      if (!settings) {
        return {
          available: true,
          configured: false,
          reason: warning ?? "Pi Voice is not configured. Run /voice-settings in Pi's interactive TUI to choose and download a local model.",
        };
      }
      if (!existsSync(settings.model.path)) {
        return {
          available: true,
          configured: false,
          modelId: settings.model.id,
          reason: `Configured transcription model is missing: ${settings.model.path}. Run /voice-settings in Pi to choose a model.`,
        };
      }
      return { available: true, configured: true, modelId: settings.model.id };
    },

    transcribePcm(pcm: Float32Array, options?: PiAsrPcmOptions): Promise<PiAsrResult> {
      const opSignal = combinedSignal(options?.signal);
      return track(runPcm(pcm, opSignal));
    },

    transcribeAudio(audio: Uint8Array, options?: PiAsrAudioOptions): Promise<PiAsrResult> {
      const opSignal = combinedSignal(options?.signal);
      if (audio.byteLength === 0) {
        return Promise.reject(new Error("Audio buffer is empty"));
      }
      if (audio.byteLength > MAX_AUDIO_BYTES) {
        return Promise.reject(new Error("Audio payload exceeds the 64 MiB limit"));
      }
      return track(
        (async () => {
          const configured = await deps.getSettings();
          opSignal.throwIfAborted();
          const decoded = await decodeLimiter.run(async () => {
            const { decodeAudioBuffer } = await import("./file-audio.js");
            return decodeAudioBuffer(audio, { mimeType: options?.mimeType, signal: opSignal });
          }, opSignal);
          opSignal.throwIfAborted();
          const service = await deps.getService();
          opSignal.throwIfAborted();
          const transcript = await service.transcribeFile(configured, decoded.pcm, opSignal);
          return {
            ...transcript,
            modelId: configured.model.id,
            seconds: decoded.seconds,
          };
        })(),
      );
    },

    transcribeFile(path: string, options?: PiAsrFileOptions): Promise<PiAsrResult> {
      const opSignal = combinedSignal(options?.signal);
      const target = resolve(path);
      return track(
        (async () => {
          const configured = await deps.getSettings();
          opSignal.throwIfAborted();
          const decoded = await decodeLimiter.run(async () => {
            const { decodeFileAudio } = await import("./file-audio.js");
            return decodeFileAudio(target, opSignal);
          }, opSignal);
          opSignal.throwIfAborted();
          const service = await deps.getService();
          opSignal.throwIfAborted();
          const transcript = await service.transcribeFile(configured, decoded.pcm, opSignal);
          return {
            ...transcript,
            modelId: configured.model.id,
            seconds: decoded.seconds,
          };
        })(),
      );
    },

    async shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      shutdownController.abort(new Error("Pi Voice is shutting down"));
      await Promise.allSettled([...operations]);
    },
  };
}

import fs from "fs";
import { pathToFileURL } from "url";
import { attachmentContent, MAX_ATTACHMENT_BYTES } from "./attachmentStorage";
import { MEMO_STT_QUALIFICATION, memoSttOwnerFailure, projectMemoTranscript } from "./memoSttBoundary";

/** The installed SDK owns config, credentials, selection, retries and HTTP. */
export type MemoMediaOwner = {
  loadConfig(): unknown;
  runMediaUnderstandingFile(params: any): Promise<unknown>;
};

// Preserve native ESM import in this CommonJS build. Resolve only public exports;
// no guessed installation path, credential reader or provider implementation.
const nativeImport = new Function("url", "return import(url)") as (url: string) => Promise<any>;
export async function loadMemoMediaOwner(): Promise<MemoMediaOwner> {
  const [media, config] = await Promise.all([
    nativeImport(pathToFileURL(require.resolve("openclaw/plugin-sdk/media-understanding-runtime")).href),
    nativeImport(pathToFileURL(require.resolve("openclaw/plugin-sdk/config-runtime")).href),
  ]);
  if (typeof media.runMediaUnderstandingFile !== "function" || typeof config.loadConfig !== "function") {
    throw new Error("memo_transcript_unavailable");
  }
  return { loadConfig: config.loadConfig, runMediaUnderstandingFile: media.runMediaUnderstandingFile };
}

/** Request-scoped config projection, never persisted. Models and auth stay with
 * loadConfig; Amine authorized Gemini first, OpenAI only as its fallback. */
export function memoAudioConfig(value: any): any {
  const media = value?.tools?.media;
  const audio = media?.audio;
  if (!value || typeof value !== "object" || !Array.isArray(media?.models) || audio?.enabled === false) {
    throw new Error("memo_transcript_unavailable");
  }
  // Pin the already configured account chosen by Amine, rather than letting
  // the SDK select another Google profile or a provider-level key by default.
  const googleProfile = "google:claw-gemini-free";
  if (value.auth?.profiles?.[googleProfile]?.provider !== "google") {
    throw new Error("memo_transcript_unavailable");
  }
  const entries = ["google", "openai"].map(provider => media.models.find((entry: any) =>
    entry && (entry.type === undefined || entry.type === "provider") && !entry.command &&
    entry.provider === provider && typeof entry.model === "string" && entry.model.trim() &&
    (provider !== "google" || !entry.profile || entry.profile === googleProfile) &&
    Array.isArray(entry.capabilities) && entry.capabilities.includes("audio")));
  if (entries.some(entry => !entry)) throw new Error("memo_transcript_unavailable");
  const models = entries.map(entry => ({ ...entry, capabilities: ["audio"],
    ...(entry.provider === "google" ? { profile: googleProfile } : {}),
    maxBytes: Math.min(MAX_ATTACHMENT_BYTES, positive(entry.maxBytes ?? audio?.maxBytes, MAX_ATTACHMENT_BYTES)),
    // The SDK silently truncates maxChars. Reject oversized complete text at
    // our projection boundary instead of turning a cut instruction into a run.
    maxChars: undefined,
    timeoutSeconds: Math.min(60, positive(entry.timeoutSeconds ?? audio?.timeoutSeconds, 60)),
  }));
  return { ...value, tools: { ...value.tools, media: { ...media, models,
    audio: { ...audio, maxChars: undefined, preferredModel: "google/" + models[0].model },
  } } };
}

function positive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("memo_transcript_unavailable");
  }
  return value;
}

/** Owner-only seam for offline contracts; no admission or HTTP entry here. */
export async function runMemoAudioOwner(owner: MemoMediaOwner, filePath: string) {
  try {
    const cfg = memoAudioConfig(await owner.loadConfig());
    return projectMemoTranscript(await owner.runMediaUnderstandingFile({
      capability: "audio", filePath, mime: "audio/mp4", cfg,
    }));
  } catch { return memoSttOwnerFailure(); }
}

/** Internal owner adapter, no route/catalog activation before S24 qualification.
 * Accept only an attachment ID: paths, models, config and auth are never client inputs.
 * A failure returns no SDK details and never submits an executable request. */
export async function transcribeMemoAttachment(id: string) {
  // Capture-dependent existing gate is checked before SDK/config/file access.
  if (!MEMO_STT_QUALIFICATION.success) return MEMO_STT_QUALIFICATION;
  try {
    const file = attachmentContent(id);
    try {
      if (file.mime !== "audio/mp4" || file.size < 1024) return memoSttOwnerFailure();
      const owner = await loadMemoMediaOwner();
      return await runMemoAudioOwner(owner, file.file);
    } finally { fs.closeSync(file.fd); }
  } catch { return memoSttOwnerFailure(); }
}

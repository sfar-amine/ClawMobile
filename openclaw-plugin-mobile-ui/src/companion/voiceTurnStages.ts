/**
 * Companion-side latency stages of one Samantha Voix turn (S24 31/10: « merci Samantha » 6.2 s from the end of speech
 * to the first answer audio, with no Companion breakdown). Every stage is a millisecond offset from the end of the
 * owner's speech (turnEnd, app t25), so the app's t25 → t30 can be split without clock alignment. Closed integer
 * fields and a run identifier only: never a request, an answer, a tool name or an argument.
 *
 * Owners of the marks, unchanged: the voice turn protocol (speech end, final transcription, capability execution,
 * receipt handed to the voice model, first receipt audio forwarded to the app) and the run registry's Gateway
 * observation (run accepted, agent request sent, run start, first tool, first assistant text, terminal, settlement).
 */
export type VoiceStageMarks = {
  /** Wall clock of the speech end; joins the protocol's monotonic marks with the run registry's wall-clock marks. */
  inputEndedWall: number;
  runId?: string;
  sttFinalMs?: number; firstAudioMs?: number; capabilityMs?: number; capabilityDoneMs?: number; receiptMs?: number; audioMs?: number;
};
export type ObservedRunTiming = {acceptedAt: number; requestSentAt?: number; runStartedAt?: number; firstToolAt?: number;
  firstTextAt?: number; terminalReceivedAt?: number; settlementStartedAt?: number; toolStarts?: number} | null;

export const VOICE_STAGE_KEYS = ["stt_final", "first_audio", "capability", "accepted", "sent", "run_start", "first_tool",
  "first_text", "terminal", "settled", "capability_done", "receipt", "audio"] as const;
export type VoiceStageKey = typeof VOICE_STAGE_KEYS[number];
export type VoiceTurnStages = {version: 1; runId: string | null; tools: number | null} & Record<VoiceStageKey, number | null>;

const RUN_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const LIMIT_MS = 600_000;
function offset(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded < -LIMIT_MS || rounded > LIMIT_MS ? null : rounded;
}
function wall(at: number | undefined, end: number): number | null {
  return typeof at === "number" && Number.isSafeInteger(at) && at > 0 ? offset(at - end) : null;
}

/** One closed record per voice turn; unknown stages stay null, never a synthetic zero. */
export function voiceTurnStages(marks: VoiceStageMarks, run: ObservedRunTiming): VoiceTurnStages | null {
  if (!marks || !Number.isSafeInteger(marks.inputEndedWall) || marks.inputEndedWall <= 0) return null;
  const end = marks.inputEndedWall;
  const runId = typeof marks.runId === "string" && RUN_ID.test(marks.runId) ? marks.runId : null;
  const brain = runId ? run : null;
  return {
    version: 1, runId,
    stt_final: offset(marks.sttFinalMs), first_audio: offset(marks.firstAudioMs), capability: offset(marks.capabilityMs),
    accepted: wall(brain?.acceptedAt, end), sent: wall(brain?.requestSentAt, end), run_start: wall(brain?.runStartedAt, end),
    first_tool: wall(brain?.firstToolAt, end), first_text: wall(brain?.firstTextAt, end),
    terminal: wall(brain?.terminalReceivedAt, end), settled: wall(brain?.settlementStartedAt, end),
    capability_done: offset(marks.capabilityDoneMs), receipt: offset(marks.receiptMs), audio: offset(marks.audioMs),
    tools: brain && Number.isSafeInteger(brain.toolStarts) && brain.toolStarts! >= 0 && brain.toolStarts! <= 999 ? brain.toolStarts! : null,
  };
}

/** Fixed-format line of the Companion's bounded process log (bounded-log.py owns rotation); integers and the run id only. */
export function voiceStagesLine(stages: VoiceTurnStages): string {
  const show = (value: number | null) => value === null ? "-" : String(value);
  return `[voice-stages] run=${stages.runId ?? "-"} ` + VOICE_STAGE_KEYS.map(key => `${key}_ms=${show(stages[key])}`).join(" ") +
    ` tools=${show(stages.tools)}`;
}

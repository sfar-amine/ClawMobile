/** Preparation only. Neither this module nor its tests invoke the media owner. */
export const MEMO_TRANSCRIPT_CHARS = 12000;
export const MEMO_TRANSCRIPT_BYTES = 48000;
// Codec/credential boundary only, never financial routing. Ordinary amounts,
// phone numbers and digit strings are left to the normal canonical intent path.
const credential = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:password|mot de passe|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/iu;
const namedHumanCode = /\b(?:otp|pin|cvv|cvc|code\s+(?:de\s+)?(?:v[ée]rification|validation|s[ée]curit[ée]))\b[^\n\p{N}]{0,32}\p{N}{3,8}(?!\p{N})/iu;

type MemoRefusal = {
  success: false;
  state: "refused";
  receipt: null;
  error: "memo_stt_not_qualified" | "memo_transcript_unavailable";
};
export type MemoTranscriptProjection = MemoRefusal | {
  success: true;
  state: "transcribed";
  text: string;
};

/** An export probe is not provider, deadline or logging qualification. No caller
 * boolean, attachment or SDK-shaped response may authorize a transcription. */
export const MEMO_STT_QUALIFICATION: Readonly<MemoRefusal> = Object.freeze({
  success: false, state: "refused", receipt: null, error: "memo_stt_not_qualified",
});

/** Future owner errors are deliberately not accepted as public error text. */
export function memoSttOwnerFailure(): MemoRefusal {
  return { success: false, state: "refused", receipt: null, error: "memo_transcript_unavailable" };
}

/** Read only the canonical SDK result's own text property. This projection is
 * not proof of provenance, a receipt or permission to submit a run. In this
 * preparation it has no production caller. Never truncate or silently redact
 * an instruction into a different executable request. */
export function projectMemoTranscript(value: unknown): MemoTranscriptProjection {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return memoSttOwnerFailure();
    const field = Object.getOwnPropertyDescriptor(value, "text");
    if (!field || !("value" in field) || typeof field.value !== "string") return memoSttOwnerFailure();
    const text = field.value;
    if (text.length > MEMO_TRANSCRIPT_CHARS || Buffer.byteLength(text, "utf8") > MEMO_TRANSCRIPT_BYTES ||
      /[\p{C}\p{Zl}\p{Zp}]/u.test(text.replace(/[\r\n\t]/g, "")) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text) ||
      credential.test(text) || namedHumanCode.test(text)) {
      return memoSttOwnerFailure();
    }
    if (!text.trim()) return memoSttOwnerFailure();
    return { success: true, state: "transcribed", text };
  } catch {
    return memoSttOwnerFailure();
  }
}

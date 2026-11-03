/**
 * Closed list of Samantha Voix social reflexes (Amine 25/10/2026): the only turns the voice interface answers by
 * itself, because they carry no fact, state, memory, choice or action. The list is decided by code on the final
 * on-device transcription, never by the voice model. Anything else, including « oui », « non », « d'accord » and every
 * answer to a question, goes to Samantha's brain.
 */
export type VoiceReflexKind = "greeting" | "thanks" | "goodbye" | "presence" | "wait" | "repeat" | "wellbeing";

const REFLEXES: ReadonlyArray<[VoiceReflexKind, ReadonlyArray<string>]> = [
  ["greeting", ["bonjour", "bonsoir", "salut", "coucou", "hello", "hi", "hey", "allo", "aslema", "ahla", "marhba", "good morning", "good evening"]],
  ["thanks", ["merci", "merci beaucoup", "merci bien", "mille merci", "super merci", "thanks", "thank you", "thanks a lot", "chokran", "choukran", "yaishek", "y3aychek", "barcha chokran"]],
  ["goodbye", ["au revoir", "a plus", "a plus tard", "a demain", "bonne nuit", "bonne journee", "bonne soiree", "bye", "goodbye", "good night", "see you", "bislema", "beslema"]],
  ["presence", ["tu m entends", "tu es la", "t es la", "est ce que tu m entends", "can you hear me", "are you there"]],
  ["wait", ["attends", "attends une seconde", "attends un peu", "une seconde", "un instant", "deux secondes", "wait", "one second", "hold on", "stanna"]],
  ["repeat", ["repete", "tu peux repeter", "peux tu repeter", "repete s il te plait", "tu peux repeter s il te plait", "pardon", "comment", "repeat", "say that again", "can you repeat", "3awed"]],
  ["wellbeing", ["ca va", "comment ca va", "comment tu vas", "tu vas bien", "how are you", "chnowa ahwelek", "labes"]],
];
const NAMES = new Set(["samantha", "sam", "sami"]);
const COURTESY = ["s il te plait", "stp", "please"];
const MAX_WORDS = 8;

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("fr")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

const PHRASES = new Map<string, VoiceReflexKind>();
for (const [kind, phrases] of REFLEXES) for (const phrase of phrases) PHRASES.set(normalize(phrase), kind);

/** Removes names and courtesy only at the edges: « merci Samantha », « Sam tu m'entends », « répète s'il te plaît ». */
function core(text: string): string {
  let words = text.split(" ").filter(Boolean);
  while (words.length && NAMES.has(words[0])) words = words.slice(1);
  while (words.length && NAMES.has(words[words.length - 1])) words = words.slice(0, -1);
  let joined = words.join(" ");
  for (const courtesy of COURTESY) {
    if (joined.endsWith(" " + courtesy)) joined = joined.slice(0, -courtesy.length - 1).trim();
  }
  const trimmed = joined.split(" ").filter(Boolean);
  while (trimmed.length && NAMES.has(trimmed[trimmed.length - 1])) trimmed.pop();
  return trimmed.join(" ");
}

/** A whole utterance made of one or two listed reflexes (« merci au revoir »), nothing else. */
export function voiceReflex(request: unknown): VoiceReflexKind | null {
  if (typeof request !== "string" || request.length > 160) return null;
  const text = core(normalize(request));
  if (!text || text.split(" ").length > MAX_WORDS) return null;
  const direct = PHRASES.get(text);
  if (direct) return direct;
  const words = text.split(" ");
  for (let cut = 1; cut < words.length; cut++) {
    const first = PHRASES.get(core(words.slice(0, cut).join(" ")));
    const second = PHRASES.get(core(words.slice(cut).join(" ")));
    if (first && second) return first;
  }
  return null;
}

/** /claw-live/decision answer for a reflex: the voice interface may release its own short sentence, no execution. */
export function voiceReflexDecision(kind: VoiceReflexKind) {
  return {
    success: true, state: "voice_reflex", source: "voice_reflex",
    decision: {version: 2, type: "REASON", capability: null, risk: "read", confirmationRequired: false, parameters: {}},
    harness: {version: 1, tool_policy: "optional", voice_policy: "reflex", reflex: kind, evidence_required: false,
      allow_model_only: true, confidence: 1, reason: "voice_reflex", shortlist: []},
  };
}

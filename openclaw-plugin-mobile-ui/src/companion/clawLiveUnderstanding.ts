import {VOICE_BRAIN_SOURCE} from "./voiceBrainDelegation";
import {voiceReflex, voiceReflexDecision} from "./voiceReflex";

type Owner = {
  executeVoiceCapability(meta: any, request: string, run: () => Promise<any>): Promise<any>;
};
type Execute = (request: string) => Promise<Record<string, any>>;
type Deps = { assertCurrent?: () => void };

/**
 * /claw-live/decision (ADR 02/11 « le cerveau partout », step 3): every turn goes to Samantha's brain, evidence
 * required. Only the closed list of social reflexes is answered by the voice interface itself (Amine 25/10, kept).
 */
export function clawLiveDecision(request: string) {
  const reflex = voiceReflex(request);
  if (reflex) return {...voiceReflexDecision(reflex), voiceFastPath: {version: 1, execute: false}};
  return {success: true, source: VOICE_BRAIN_SOURCE,
    harness: {version: 1, tool_policy: "required", evidence_required: true, allow_model_only: false},
    voiceFastPath: {version: 1, execute: true, owner: VOICE_BRAIN_SOURCE}};
}

/** /claw-live/capability: the admitted voice turn is executed by the brain delegation (`execute`), unchanged. */
export async function clawLiveCapability(owner: Owner, body: any, execute: Execute, deps: Deps = {}) {
  const request = String(body?.request || "");
  const current = () => { deps.assertCurrent?.(); return execute(request); };
  return body?.voiceTurn ? owner.executeVoiceCapability(body.voiceTurn, request, current) : current();
}

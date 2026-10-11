import {readReceiptPresentation, ReceiptPresentation} from './receiptPresentation';

export type VoiceReceiptMetadata = {presentation:ReceiptPresentation;understood:ReceiptPresentation['understood'];alternatives:ReceiptPresentation['alternatives'];failure?:ReceiptPresentation['failure'];spoken:string};

// The shared HS3 reader rejects six-digit values and credential prefixes. A
// designated OTP/PIN can be shorter: do not speak it merely because it passed
// that digit-count guard. This is a closed voice-output exclusion, not a parser
// of payments, a redactor, or an alternative receipt validator.
const shortConfirmationCode=/\b(?:otp|pin|(?:verification|security|authentication|one[- ]time) code|code (?:de |d['’])?(?:v[ée]rification|s[ée]curit[ée]|authentification|unique))\b[\p{L}\p{Zs}:=—-]{0,32}\p{Nd}[\p{Nd}\p{Zs}-]{1,16}\p{Nd}/iu;

function designatedCode(p:ReceiptPresentation):boolean {
  const rendered=[p.label,p.title,p.spoken,p.primary.label,p.understood.label,
    ...p.alternatives.map(row=>row.label),...(p.failure?[p.failure.step,p.failure.reason]:[])];
  return rendered.some(text=>shortConfirmationCode.test(text));
}

/** Closed HS6 adapter used by the deterministic relay terminal renderer.
 * The caller must supply the locale from the existing session owner, never infer it
 * from an assistant message. This does not establish receipt provenance: only the
 * trusted capability/run owner may call it with its typed top-level metadata.
 * Unsupported languages or HS4/HS5 metadata stay absent rather than invented.
 */
export function readVoiceReceiptMetadata(ownerReceipt:unknown, sessionLocale:unknown):VoiceReceiptMetadata|undefined {
  if(sessionLocale!=='fr'&&sessionLocale!=='en')return undefined;
  if(!ownerReceipt||typeof ownerReceipt!=='object'||Array.isArray(ownerReceipt))return undefined;
  const receipt=ownerReceipt as Record<string,unknown>;
  if(!Object.prototype.hasOwnProperty.call(receipt,'presentation'))return undefined;
  const presentation:ReceiptPresentation|undefined=readReceiptPresentation({presentation:receipt.presentation});
  if(!presentation||presentation.locale!==sessionLocale||designatedCode(presentation))return undefined;
  return {presentation,understood:presentation.understood,alternatives:presentation.alternatives,...(presentation.failure?{failure:presentation.failure}:{}),spoken:presentation.spoken};
}

/** Presentation only: the capability owner still controls admission and execution.
 * A caller must emit `before` before executing, and `after` after its receipt.
 * This function never treats the model's prose as either a decision or a receipt.
 */
export function planVoiceReceiptSpeech(ownerReceipt:unknown, sessionLocale:unknown,
  ownerDecision:unknown, confidenceThreshold=0.8):{before?:string;after:string}|undefined {
  const metadata=readVoiceReceiptMetadata(ownerReceipt,sessionLocale);
  if(!metadata)return undefined;
  const decision=ownerDecision && typeof ownerDecision==='object' && !Array.isArray(ownerDecision)
    ? ownerDecision as Record<string,unknown> : {};
  const confidence=typeof decision.confidence==='number' && Number.isFinite(decision.confidence)
    ? decision.confidence : undefined;
  const threshold=Number.isFinite(confidenceThreshold)&&confidenceThreshold>=0&&confidenceThreshold<=1
    ? confidenceThreshold : 0.8;
  const preview=decision.type==='CLARIFY'||decision.risk==='transaction'||
    (decision.risk==='read'&&(confidence===undefined||confidence<threshold));
  const fr=sessionLocale==='fr';
  const before=preview ? (fr?"J’ai compris : ":'I understood: ')+metadata.understood.label : undefined;
  // Do not repeat an arbitrary spoken sentence on error: only the closed failure
  // fields establish the human-readable stage and reason. Unknown debit remains
  // unknown; this adapter never adds a claim of non-debit.
  const after=metadata.failure
    ? (fr?'Étape : ':'Step: ')+metadata.failure.step+'. '+metadata.failure.reason
    : metadata.spoken;
  return {...(before?{before}:{}),after};
}

/** Versioned authored phrases. These are UI correction gestures, never intents.
 * No transcript is retained; the existing turn owner supplies its timestamp and
 * must invoke the same realignment owner as the button, once that owner exists.
 */
export const VOICE_REALIGNMENT_PHRASES_V1=Object.freeze({
  fr:Object.freeze(["non c'est pas ça","non ce n'est pas ça","ce n'est pas ça","c'est pas ça","tu as mal compris"]),
  en:Object.freeze(["no that's not it","that's not what i meant","you misunderstood","no that is not it"]),
  // Authored, pending Amine's language qualification; not S24 speech captures.
  derja:Object.freeze(['le moch haka','la mouch haka','mouch haka','ma fhemtnech','لا موش هكا','موش هكا']),
});
function correctionKey(value:string):string {
  return value.normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'")
    .replace(/[.,!?،؟]+/gu,' ').replace(/\s+/g,' ').trim();
}
export function isVoiceRealignmentRequest(text:unknown, turnAt:unknown, now=Date.now()):boolean {
  if(typeof text!=='string'||text.length>120||typeof turnAt!=='number'||!Number.isFinite(turnAt)||
    !Number.isFinite(now)||now<turnAt||now-turnAt>120_000)return false;
  const key=correctionKey(text);
  return Object.values(VOICE_REALIGNMENT_PHRASES_V1).some(phrases=>phrases.some(phrase=>correctionKey(phrase)===key));
}

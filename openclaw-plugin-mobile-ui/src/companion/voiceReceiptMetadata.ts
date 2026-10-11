import {publicReceiptMetadata, readReceiptPresentation, ReceiptPresentation} from './receiptPresentation';

export type VoiceReceiptMetadata = ReturnType<typeof publicReceiptMetadata> & {spoken:string};

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

/** Prepared HS6 adapter, deliberately not wired to a voice endpoint yet.
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
  return {...publicReceiptMetadata(presentation),spoken:presentation.spoken};
}

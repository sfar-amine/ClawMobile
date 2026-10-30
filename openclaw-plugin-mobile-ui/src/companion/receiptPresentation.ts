/** Closed HS3 metadata. No routing, owner I/O or payment-effect inference. */
export type ReceiptPresentation = {version:1;locale:'fr'|'en';status:'info'|'error';label:string;title:string;rows:[string,string][];spoken:string;primary:{label:string;action:'done'};effect:{debited:'unknown';source:'receipt'};meta:{capability:string|null};understood:{capability:string|null;label:string;slots:ReceiptSlots;text?:string};alternatives:{capability:string;label:string}[];payment?:PaymentOutcome;failure?:{step:string;reason:string;stepId?:string;reasonCode?:string;notDone?:{code:'unknown'}|{code:'payment_not_submitted'|'not_started';text:string}}};
/** Read-time state of the payment request a run handed off to (runPaymentPresentation.ts); never persisted by the run. */
export type InitialPaymentFailure={stepId:'execution_error';reasonCode:string;at:number|null};
export type PaymentHandoff={runState:'done';runUpdatedAt:number;paymentCreatedAt:number;runUpdatedBeforePaymentCreated:boolean};
export type PaymentOutcome={state:string;reasonCode:string|null;stepId:string;initialFailure?:InitialPaymentFailure;handoff?:PaymentHandoff};
// Closed public owner codes, including the precise failures attested by capture184.
const INITIAL_PAYMENT_CODES=new Set(['maxit_topup_command_changed','maxit_order_missing_order_id','gateway_amount_mismatch',
 'payment_quote_changed','payment_effect_unverified','payment_rejection_unverified','bank_declined','bank_verification_failed',
 'payment_cancelled','owner_cancelled','session_expired','payment_not_submitted','payment_rejected_reason_unavailable',
 'owner_confirmation_expired','browser_context_unavailable']);
export function publicInitialPaymentFailure(raw:unknown):InitialPaymentFailure|undefined{
 if(!obj(raw)||raw.stepId!=='execution_error'||typeof raw.reasonCode!=='string'||!INITIAL_PAYMENT_CODES.has(raw.reasonCode)||
   !(raw.at===null||typeof raw.at==='number'&&Number.isSafeInteger(raw.at)&&raw.at>0))return undefined;
 return{stepId:'execution_error',reasonCode:raw.reasonCode,at:raw.at as number|null};
}
export function publicPaymentHandoff(raw:unknown):PaymentHandoff|undefined{
 if(!obj(raw)||raw.runState!=='done'||typeof raw.runUpdatedAt!=='number'||!Number.isSafeInteger(raw.runUpdatedAt)||raw.runUpdatedAt<=0||
   typeof raw.paymentCreatedAt!=='number'||!Number.isSafeInteger(raw.paymentCreatedAt)||raw.paymentCreatedAt<=0||typeof raw.runUpdatedBeforePaymentCreated!=='boolean'||
   raw.runUpdatedBeforePaymentCreated!==(raw.runUpdatedAt<raw.paymentCreatedAt))return undefined;
 return{runState:'done',runUpdatedAt:raw.runUpdatedAt,paymentCreatedAt:raw.paymentCreatedAt,runUpdatedBeforePaymentCreated:raw.runUpdatedBeforePaymentCreated};
}
const PAYMENT_STATES=new Set(['awaiting_owner','executing','requires_bank_action','confirmed','demo_confirmed','failed','blocked','effect_unknown','expired','cancelled']);
/** Closed values mirrored from samantha-ui-playbooks receipt_presentation.py (HS3 v1). */
export type ReceiptSlots={operator?:'orange'|'tt'|'zain';provider?:'topnet'|'steg'|'sonede';amountTnd?:string;beneficiary?:string};
const STEP_IDS=new Set(['unknown','resolution','route_selection','execution','owner_confirmation_consumed','payment_record_created','financial_dispatch_committed','provider_session_started','provider_session_authenticated','invoice_revalidated','checkout_prepared','browser_context_ready','three_ds2_preflight','gateway_submission_started','gateway_submission_result','bank_ui_opened','bank_return_detected','bank_return_requested','bank_return_response','bank_result_presented','provider_callback_correlated','provider_readback','completion_classified','execution_error','bank_timeout_reconciliation_started','bank_resume_started']);
function closedSlots(raw:Record<string,unknown>):ReceiptSlots{const slots:ReceiptSlots={};
 if(raw.operator==='orange'||raw.operator==='tt'||raw.operator==='zain')slots.operator=raw.operator;
 if(raw.provider==='topnet'||raw.provider==='steg'||raw.provider==='sonede')slots.provider=raw.provider;
 if(typeof raw.amountTnd==='string'&&/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/.test(raw.amountTnd)&&Number(raw.amountTnd)>0)slots.amountTnd=raw.amountTnd;
 if(raw.beneficiary==='owner'||(typeof raw.beneficiary==='string'&&/^•• ?\d{2,4}$/.test(raw.beneficiary)))slots.beneficiary=raw.beneficiary;
 return slots;}
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const secret=/\bBearer\s+|\b(?:sk-|ghp_|github_pat_|AKIA|eyJ)[A-Za-z0-9_.-]+|refresh_token|access_token|-----BEGIN|@|[\x00-\x1f]/i;
const shortConfirmationCode=/\b(?:otp|pin|(?:verification|security|authentication|one[- ]time) code|code (?:de |d['’])?(?:v[ée]rification|s[ée]curit[ée]|authentification|unique))\b[\p{L}\p{Zs}:=—-]{0,32}\p{Nd}[\p{Nd}\p{Zs}-]{1,16}\p{Nd}/iu;
function text(v:unknown,max:number):v is string{return typeof v==='string'&&v.length>0&&v.length<=max&&!secret.test(v)&&!shortConfirmationCode.test(v)&&(v.match(/\d/g)||[]).length<6&&!/^[\[{]/.test(v);}
function id(v:unknown):v is string{return typeof v==='string'&&/^[a-z][a-z0-9_.-]{0,159}$/.test(v)&&!secret.test(v);}
export function readReceiptPresentation(raw:unknown):ReceiptPresentation|undefined{
 if(!obj(raw))return undefined;const p=obj(raw.presentation)?raw.presentation:raw;
 if(p.version!==1||(p.locale!=='fr'&&p.locale!=='en')||(p.status!=='info'&&p.status!=='error')||!text(p.label,200)||!text(p.title,200)||!text(p.spoken,240)||!Array.isArray(p.rows)||p.rows.length>8||!obj(p.primary)||p.primary.action!=='done'||!text(p.primary.label,200)||!obj(p.effect)||p.effect.debited!=='unknown'||p.effect.source!=='receipt'||!obj(p.understood)||!text(p.understood.label,200)||!obj(p.understood.slots)||!obj(p.meta)||!Array.isArray(p.alternatives)||p.alternatives.length>3)return undefined;
 const rows:ReceiptPresentation['rows']=[];
 for(const row of p.rows){if(!Array.isArray(row)||row.length!==2||!text(row[0],100)||!text(row[1],240))return undefined;rows.push([row[0],row[1]]);}
 const cid=p.understood.capability;if(cid!==null&&!id(cid))return undefined;if(p.meta.capability!==cid)return undefined;
 const slots=closedSlots(p.understood.slots);const summary=text(p.understood.text,240)?p.understood.text:undefined;
 const alternatives:ReceiptPresentation['alternatives']=[],seen=new Set([cid]);
 for(const row of p.alternatives){if(!obj(row)||!id(row.capability)||!text(row.label,200)||seen.has(row.capability))return undefined;seen.add(row.capability);alternatives.push({capability:row.capability,label:row.label});}
 let failure:ReceiptPresentation['failure'];if(p.status==='error'){if(!obj(p.failure)||!text(p.failure.step,200)||!text(p.failure.reason,240))return undefined;failure={step:p.failure.step,reason:p.failure.reason};
  if(typeof p.failure.stepId==='string'&&STEP_IDS.has(p.failure.stepId))failure.stepId=p.failure.stepId;
  if(id(p.failure.reasonCode))failure.reasonCode=p.failure.reasonCode;
  const done=p.failure.notDone;if(obj(done)&&done.code==='unknown')failure.notDone={code:'unknown'};else if(obj(done)&&(done.code==='payment_not_submitted'||done.code==='not_started')&&text(done.text,200))failure.notDone={code:done.code,text:done.text};}
  const po=p.payment;const payment:PaymentOutcome|undefined=obj(po)&&typeof po.state==='string'&&PAYMENT_STATES.has(po.state)&&(po.reasonCode===null||id(po.reasonCode))&&typeof po.stepId==='string'&&(po.stepId==='unknown'||STEP_IDS.has(po.stepId))?{state:po.state,reasonCode:po.reasonCode as string|null,stepId:po.stepId,...(publicInitialPaymentFailure(po.initialFailure)?{initialFailure:publicInitialPaymentFailure(po.initialFailure)}:{}),...(publicPaymentHandoff(po.handoff)?{handoff:publicPaymentHandoff(po.handoff)}:{})}:undefined;
 return {version:1,locale:p.locale as 'fr'|'en',status:p.status as 'info'|'error',label:p.label,title:p.title,rows,spoken:p.spoken,primary:{label:p.primary.label,action:'done'},effect:{debited:'unknown',source:'receipt'},meta:{capability:cid as string|null},understood:{capability:cid as string|null,label:p.understood.label,slots,...(summary?{text:summary}:{})},alternatives,...(payment?{payment}:{}),...(failure?{failure}:{})};
}
/** Renderer-owned phrases. Producers and relays carry codes, never translations. */
export const FAILURE_PHRASES = {
 fr: {
  native_pulse_protocol_required:"Le service Pulse n’a pas renvoyé le protocole natif attendu. Le résultat doit être vérifié ; aucun nouvel essai automatique n’est lancé.",
  native_pulse_execution_unknown:"Le résultat de la commande Pulse n’est pas établi. Il doit être vérifié ; aucun nouvel essai automatique n’est lancé.",
  verification_required:"Le résultat de la commande doit encore être vérifié. Aucun nouvel essai automatique n’est lancé.",
  native_pulse_admission_required:"L’accès actuel à la pièce Pulse n’est pas établi. La commande ne peut pas être poursuivie.",
  native_pulse_admission_expired:"La vérification de l’accès Pulse a expiré. Il faut vérifier l’accès avant de poursuivre cette commande.",
  native_pulse_event_mismatch:"Le message ou le fil ne correspond pas à la demande Pulse admise. La commande ne peut pas être reprise.",
  native_pulse_contact_revoked:"L’accès de ce contact à la pièce Pulse n’est plus valide. La commande ne peut pas être poursuivie.",
  native_pulse_handoff_not_current:"L’état de la commande Pulse a changé. Sa préparation ou son résultat doit être vérifié avant de poursuivre.",
  native_pulse_bridge_claim_required:"La prise en charge durable de la commande Pulse n’est pas établie. La commande ne peut pas être exécutée.",
  native_pulse_bridge_binding_changed:"Le reçu de prise en charge ne correspond plus à cette commande Pulse. Son état doit être vérifié.",
  native_pulse_handoff_unavailable:"Le suivi de la commande Pulse est indisponible. Son résultat doit être vérifié avant toute nouvelle action.",
  native_pulse_phase_only:"Cette voie native n’accepte que le changement d’état de phase Pulse prévu. Cette commande ne peut pas y être exécutée.",
  pulse_confirmation_not_current:"L’accord ne correspond plus à la commande Pulse actuelle. La commande doit être préparée et confirmée à nouveau.",
  native_contract_unqualified:"Le formulaire natif de cette phase n’est pas encore qualifié. Rien n’a été exécuté.",
  pulse_preparation_required:"La commande de phase ne dispose pas d’une préparation native complète. Rien n’a été exécuté.",
  host_interpretation_failed:"Je n’ai pas réussi à prendre ta demande en compte. Rien n’a été fait : tu peux la reformuler.",
  intent_durable_owner_unqualified:"La voie d’exécution durable de cette commande n’est pas qualifiée. La commande ne peut pas être exécutée.",
  pulse_prepared_capacity:"La commande préparée dépasse la capacité admise. Elle ne peut pas être exécutée.",
  pulse_prepared_command_changed:"La commande préparée a changé. Elle doit être préparée et confirmée à nouveau.",
  pulse_prepared_native_contract_required:"La commande préparée ne dispose pas du contrat natif requis. Elle ne peut pas être exécutée.",
  pulse_native_contract_changed:"Le formulaire Pulse a changé depuis la confirmation. La commande doit être préparée et confirmée à nouveau.",
  pulse_native_patch_unavailable:"Le champ Pulse à modifier n’est plus disponible dans le formulaire. La commande doit être préparée à nouveau.",
  pulse_native_preflight_unavailable:"La vérification du formulaire Pulse avant écriture est indisponible. La commande ne peut pas être poursuivie.",
  pulse_native_action_unsupported:"L’action du formulaire Pulse ne correspond pas à une action native qualifiée. La commande est refusée.",
  pulse_native_capacity:"Le formulaire Pulse dépasse la capacité admise pour sa vérification. La commande est refusée.",
  pulse_native_composition_undefined:"Le formulaire Pulse ne définit pas complètement cette commande. Elle doit être préparée à nouveau.",
  pulse_native_control_ambiguous:"Plusieurs champs du formulaire Pulse correspondent à la même modification. La commande est refusée.",
  pulse_native_control_unsupported:"Un champ du formulaire Pulse n’est pas pris en charge par le contrat natif. La commande est refusée.",
  pulse_native_encoding_unsupported:"L’encodage du formulaire Pulse n’est pas pris en charge par le contrat natif. La commande est refusée.",
  pulse_native_hidden_control_unknown:"Le formulaire Pulse contient un champ masqué non qualifié. La commande est refusée.",
  pulse_native_operation_unsupported:"L’opération Pulse demandée n’est pas qualifiée dans ce contrat natif. La commande est refusée.",
  pulse_native_sensitive_control:"Le formulaire Pulse contient un champ sensible qui ne peut pas être inclus dans la commande. La commande est refusée.",
  pulse_native_submit_unsupported:"Le formulaire Pulse ne possède pas de soumission native qualifiée pour cette commande. La commande est refusée.",
  pulse_native_target_invalid:"La cible de la commande ne correspond pas à un formulaire Pulse natif autorisé. La commande est refusée.",
  native_pulse_read_scope_unqualified:"L’accès professionnel requis pour cette lecture Pulse n’est pas qualifié. La lecture ne peut pas être effectuée.",
  native_pulse_read_scope_stale:"La vérification d’accès de cette lecture Pulse a expiré ou ne correspond plus à la demande. La lecture ne peut pas être effectuée.",
  native_pulse_read_handoff_changed:"La demande de lecture Pulse a changé depuis sa prise en charge. Elle doit être vérifiée avant de poursuivre.",
  native_pulse_read_only_policy:"Cette voie Pulse est limitée aux lectures admises. Cette commande ne peut pas y être exécutée.",
  helper_missing:'Le service de traitement est introuvable.',
  helper_failed:'Le service de traitement n’a pas renvoyé de résultat exploitable.',
  invalid_result:'Le service de traitement a renvoyé un résultat invalide.',
  invalid_check_budget:'Le budget de résolution est invalide.',
  check_budget_exceeded:'Le délai de résolution a été dépassé.',
  web_deadline_exceeded:'La recherche web n’a pas abouti dans le délai imparti.',
  invalid_web_execution_context:'Le contexte de la recherche web est invalide.',
  execution_cancelled:'Le traitement a été interrompu.',
  coordinator_unavailable:'Le suivi de conversation est indisponible.',
  // Interpretation outcomes, same causes as the owner path (Sadok, Pulse room 28-29/10).
  interpretation_unavailable:"Je ne peux pas réfléchir pour le moment : le modèle n’est pas joignable. Rien n’a été exécuté ; réessaie dans un instant.",
  interpretation_not_dispatched:"Je ne peux pas réfléchir pour le moment : le modèle n’est pas joignable. Rien n’a été exécuté ; réessaie dans un instant.",
  // S24 30/10, Pulse room: « Annule la demande en cours » refused as invalid_interpretation was shown as the generic
  // « n’a pas abouti » sentence. The person is told what happened to their message, not the mechanism.
  invalid_interpretation:"Je n’ai pas compris ta réponse de façon fiable. Rien n’a été fait : tu peux la reformuler.",
  generation_context_changed:"Deux messages se sont croisés ; celui-ci n’a pas été traité. Renvoie-le.",
  qa_ingress_deadline_exceeded:'La demande de tests auto n’a pas abouti dans le délai imparti.',
 },
 en: {
  native_pulse_protocol_required:"Pulse did not return the expected native protocol. The result needs checking; no automatic retry is started.",
  native_pulse_execution_unknown:"The Pulse command result is unknown. It needs checking; no automatic retry is started.",
  verification_required:"The command result still needs verification. No automatic retry is started.",
  native_pulse_admission_required:"Current access to the Pulse room is not established. The command cannot continue.",
  native_pulse_admission_expired:"The Pulse access check expired. Access must be checked before this command can continue.",
  native_pulse_event_mismatch:"The message or thread does not match the admitted Pulse request. The command cannot resume.",
  native_pulse_contact_revoked:"This contact no longer has valid access to the Pulse room. The command cannot continue.",
  native_pulse_handoff_not_current:"The Pulse command state changed. Its preparation or result must be checked before continuing.",
  native_pulse_bridge_claim_required:"Durable ownership of the Pulse command is not established. The command cannot execute.",
  native_pulse_bridge_binding_changed:"The ownership receipt no longer matches this Pulse command. Its state needs checking.",
  native_pulse_handoff_unavailable:"Pulse command tracking is unavailable. Its result must be checked before any new action.",
  native_pulse_phase_only:"This native path only accepts the supported Pulse phase status change. It cannot execute this command.",
  pulse_confirmation_not_current:"Consent no longer matches the current Pulse command. The command must be prepared and confirmed again.",
  native_contract_unqualified:"The native form for this phase is not yet qualified. Nothing was executed.",
  pulse_preparation_required:"The phase command does not have complete native preparation. Nothing was executed.",
  host_interpretation_failed:"I couldn’t take your request into account. Nothing was done; you can rephrase it.",
  intent_durable_owner_unqualified:"The durable execution path for this command is not qualified. The command cannot execute.",
  pulse_prepared_capacity:"The prepared command exceeds the admitted capacity. It cannot execute.",
  pulse_prepared_command_changed:"The prepared command changed. It must be prepared and confirmed again.",
  pulse_prepared_native_contract_required:"The prepared command lacks the required native contract. It cannot execute.",
  pulse_native_contract_changed:"The Pulse form changed after confirmation. The command must be prepared and confirmed again.",
  pulse_native_patch_unavailable:"The Pulse field to change is no longer available in the form. The command must be prepared again.",
  pulse_native_preflight_unavailable:"The Pulse form check before writing is unavailable. The command cannot continue.",
  pulse_native_action_unsupported:"The Pulse form action is not a qualified native action. The command is refused.",
  pulse_native_capacity:"The Pulse form exceeds the admitted verification capacity. The command is refused.",
  pulse_native_composition_undefined:"The Pulse form does not fully define this command. It must be prepared again.",
  pulse_native_control_ambiguous:"Multiple Pulse form controls match the same change. The command is refused.",
  pulse_native_control_unsupported:"A Pulse form control is unsupported by the native contract. The command is refused.",
  pulse_native_encoding_unsupported:"The Pulse form encoding is unsupported by the native contract. The command is refused.",
  pulse_native_hidden_control_unknown:"The Pulse form contains an unqualified hidden control. The command is refused.",
  pulse_native_operation_unsupported:"The requested Pulse operation is not qualified in this native contract. The command is refused.",
  pulse_native_sensitive_control:"The Pulse form contains a sensitive control that cannot be included in the command. The command is refused.",
  pulse_native_submit_unsupported:"The Pulse form has no qualified native submission for this command. The command is refused.",
  pulse_native_target_invalid:"The command target does not match an authorized native Pulse form. The command is refused.",
  native_pulse_read_scope_unqualified:"The professional access required for this Pulse read is not qualified. The read cannot proceed.",
  native_pulse_read_scope_stale:"This Pulse read access check expired or no longer matches the request. The read cannot proceed.",
  native_pulse_read_handoff_changed:"The Pulse read request changed after admission. It must be checked before continuing.",
  native_pulse_read_only_policy:"This Pulse path is limited to admitted reads. It cannot execute this command.",
  helper_missing:'The processing service could not be found.',
  helper_failed:'The processing service did not return a usable result.',
  invalid_result:'The processing service returned an invalid result.',
  invalid_check_budget:'The resolution time budget is invalid.',
  check_budget_exceeded:'The request resolution exceeded its time limit.',
  web_deadline_exceeded:'The web search exceeded its time limit.',
  invalid_web_execution_context:'The web search context is invalid.',
  execution_cancelled:'Processing was interrupted.',
  coordinator_unavailable:'Conversation tracking is unavailable.',
  interpretation_unavailable:"I cannot think right now: the model is unreachable. Nothing was run; try again in a moment.",
  interpretation_not_dispatched:"I cannot think right now: the model is unreachable. Nothing was run; try again in a moment.",
  invalid_interpretation:"I couldn’t understand your reply reliably. Nothing was done; you can rephrase it.",
  generation_context_changed:"Two messages crossed; this one was not handled. Send it again.",
  qa_ingress_deadline_exceeded:'The auto test request exceeded its time limit.',
 },
} as const;
/** Only these renderer-owned causes may replace an existing producer sentence. */
export function hasFailurePhrase(code:unknown,locale:'fr'|'en'='fr'):code is string {
 return typeof code==='string'&&Object.prototype.hasOwnProperty.call(FAILURE_PHRASES[locale],code);
}
// One saturating process-local scalar, owned by this renderer, with no retained text or identifiers.
let missingFailureCauseRenders=0;
let genericDisplayRenders=0,otherGenericDisplayRenders=0;
const genericByCapability=new Map<string,number>();
const addCounter=(left:number,right:number)=>Math.min(Number.MAX_SAFE_INTEGER,left+right);
/** Consume once at the helper transport boundary, never on receipt reads/polling. */
export function recordPresentationDiagnostics(raw:unknown){
 if(!obj(raw)||!Array.isArray(raw.genericDisplayByCapability)||raw.genericDisplayByCapability.length>32)return;
 for(const row of raw.genericDisplayByCapability){
  if(!obj(row)||!id(row.capability)||!Number.isSafeInteger(row.renders)||Number(row.renders)<1||Number(row.renders)>1024)continue;
  const count=Number(row.renders);genericDisplayRenders=addCounter(genericDisplayRenders,count);
  if(genericByCapability.has(row.capability)||genericByCapability.size<64)genericByCapability.set(row.capability,addCounter(genericByCapability.get(row.capability)||0,count));
  else otherGenericDisplayRenders=addCounter(otherGenericDisplayRenders,count);
 }
}
export function receiptPresentationCounters(){return {missingFailureCauseRenders,genericDisplayRenders,
 genericDisplayByCapability:[...genericByCapability].map(([capability,renders])=>({capability,renders})),
 otherGenericDisplayRenders,scope:'companion_process' as const};}
function failurePhrase(code:string|undefined,locale:'fr'|'en'):string {
 if(!code){missingFailureCauseRenders=Math.min(Number.MAX_SAFE_INTEGER,missingFailureCauseRenders+1);
  return locale==='en'?'The receipt does not establish the cause.':'La cause n’est pas établie par le reçu.';}
 const phrases:Record<string,string>=FAILURE_PHRASES[locale];
 // Keep an unknown cause structured, never interpolate its internal code into speech.
 return hasFailurePhrase(code,locale)?phrases[code]:locale==='en'?'The receipt reports a failure; its details need checking.':'Le reçu signale un échec ; son détail doit être vérifié.';
}
export function fallbackReceiptPresentation(failed=false,ownerText?:unknown):ReceiptPresentation{
 const ownerReason=failed&&text(ownerText,240)&&text(ownerText.trim(),240)?ownerText:undefined;
 return {version:1,locale:'fr',status:failed?'error':'info',label:'Demande',title:'Résultat à vérifier',rows:[],
  spoken:ownerReason||(failed?'La demande n’a pas abouti. Consulte le détail avant toute nouvelle action.':'Le résultat de la demande reste à vérifier.'),
  primary:{label:'Terminer',action:'done'},effect:{debited:'unknown',source:'receipt'},meta:{capability:null},understood:{capability:null,label:'Demande',slots:{}},alternatives:[],
  ...(failed?{failure:{step:'Étape non établie',reason:ownerReason||failurePhrase(undefined,'fr')}}:{})};
}
/** Public helper failures describe the observed transport boundary, never a business/financial outcome. */
export function fastPathFailurePresentation(raw:unknown,stage:'resolution'|'execution',locale:'fr'|'en'='fr'):ReceiptPresentation {
 const receipt=readReceiptPresentation(raw);if(receipt?.status==='error')return receipt;
 // Do not build a failed fallback before inspecting the code: that would count every known error.
 const p=fallbackReceiptPresentation(false);
 const explicit=obj(raw)&&id(raw.reasonCode)?raw.reasonCode:undefined;
 const transport=obj(raw)&&(raw.status==='error'||raw.status==='known_error')&&typeof raw.reason==='string'&&Object.prototype.hasOwnProperty.call(FAILURE_PHRASES.fr,raw.reason)?raw.reason:undefined;
 const code=explicit||transport;
 const reason=failurePhrase(code,locale);
 const step=locale==='en'?(stage==='resolution'?'Resolving the request':'Reading the execution result'):(stage==='resolution'?'Résolution de la demande':'Lecture du résultat d’exécution');
 return {...p,locale,status:'error',label:locale==='en'?'Request':p.label,title:locale==='en'?'Request interrupted':'Demande interrompue',spoken:reason,primary:{label:locale==='en'?'Done':'Terminer',action:'done'},understood:{...p.understood,label:locale==='en'?'Request':p.understood.label},failure:{step,reason,stepId:stage,...(code?{reasonCode:code}:{}),notDone:{code:'unknown'}}};
}
export function publicReceiptMetadata(p:ReceiptPresentation|undefined){return p?{presentation:p,understood:p.understood,alternatives:p.alternatives,...(p.failure?{failure:p.failure}:{})}:{};}
/** Closed public projection of the stored v2 decision (no recalculation, no raw payload):
 * type, capability, intent, target, risk, confirmationRequired and owner-validated parameters. */
export type ResponseLanguage='fr'|'en'|'tn';
export type PublicDecision={type:'EXECUTE'|'CLARIFY'|'REASON'|'STOP';capability:string|null;intent:string|null;target:string|null;responseLanguage?:ResponseLanguage;risk:'read'|'write'|'transaction'|'destructive'|'sensitive'|'external_send'|'admin';confirmationRequired:boolean;parameters:{amountTnd?:string;beneficiary?:string}};
const DECISION_TYPES=new Set(['EXECUTE','CLARIFY','REASON','STOP']),RISKS=new Set(['read','write','transaction','destructive','sensitive','external_send','admin']);
export function publicDecision(raw:unknown):PublicDecision|undefined{
 if(!obj(raw)||typeof raw.type!=='string'||!DECISION_TYPES.has(raw.type))return undefined;
 const risk=typeof raw.risk==='string'&&RISKS.has(raw.risk)?raw.risk:undefined;if(!risk)return undefined;
 const opt=(v:unknown)=>id(v)?v:null;const parameters:PublicDecision['parameters']={};
 if(obj(raw.parameters)){const s=closedSlots({amountTnd:raw.parameters.amountTnd,beneficiary:raw.parameters.beneficiary});if(s.amountTnd)parameters.amountTnd=s.amountTnd;if(s.beneficiary&&s.beneficiary!=='owner')parameters.beneficiary=s.beneficiary;}
 const responseLanguage=raw.responseLanguage==='fr'||raw.responseLanguage==='en'||raw.responseLanguage==='tn'?raw.responseLanguage:undefined;
 return {type:raw.type as PublicDecision['type'],capability:opt(raw.capability),intent:opt(raw.intent),target:opt(raw.target),...(responseLanguage?{responseLanguage}:{}),risk:risk as PublicDecision['risk'],confirmationRequired:raw.confirmationRequired===true,parameters};
}

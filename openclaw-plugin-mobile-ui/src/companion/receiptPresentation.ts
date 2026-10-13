/** Closed HS3 metadata. No routing, owner I/O or payment-effect inference. */
export type ReceiptPresentation = {version:1;locale:'fr'|'en';status:'info'|'error';label:string;title:string;rows:[];spoken:string;primary:{label:string;action:'done'};effect:{debited:'unknown';source:'receipt'};meta:{capability:string|null};understood:{capability:string|null;label:string;slots:ReceiptSlots;text?:string};alternatives:{capability:string;label:string}[];payment?:PaymentOutcome;failure?:{step:string;reason:string;stepId?:string;reasonCode?:string;notDone?:{code:'unknown'}|{code:'payment_not_submitted'|'not_started';text:string}}};
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
 if(p.version!==1||(p.locale!=='fr'&&p.locale!=='en')||(p.status!=='info'&&p.status!=='error')||!text(p.label,200)||!text(p.title,200)||!text(p.spoken,240)||!Array.isArray(p.rows)||p.rows.length!==0||!obj(p.primary)||p.primary.action!=='done'||!text(p.primary.label,200)||!obj(p.effect)||p.effect.debited!=='unknown'||p.effect.source!=='receipt'||!obj(p.understood)||!text(p.understood.label,200)||!obj(p.understood.slots)||!obj(p.meta)||!Array.isArray(p.alternatives)||p.alternatives.length>3)return undefined;
 const cid=p.understood.capability;if(cid!==null&&!id(cid))return undefined;if(p.meta.capability!==cid)return undefined;
 const slots=closedSlots(p.understood.slots);const summary=text(p.understood.text,240)?p.understood.text:undefined;
 const alternatives:ReceiptPresentation['alternatives']=[],seen=new Set([cid]);
 for(const row of p.alternatives){if(!obj(row)||!id(row.capability)||!text(row.label,200)||seen.has(row.capability))return undefined;seen.add(row.capability);alternatives.push({capability:row.capability,label:row.label});}
 let failure:ReceiptPresentation['failure'];if(p.status==='error'){if(!obj(p.failure)||!text(p.failure.step,200)||!text(p.failure.reason,240))return undefined;failure={step:p.failure.step,reason:p.failure.reason};
  if(typeof p.failure.stepId==='string'&&STEP_IDS.has(p.failure.stepId))failure.stepId=p.failure.stepId;
  if(id(p.failure.reasonCode))failure.reasonCode=p.failure.reasonCode;
  const done=p.failure.notDone;if(obj(done)&&done.code==='unknown')failure.notDone={code:'unknown'};else if(obj(done)&&(done.code==='payment_not_submitted'||done.code==='not_started')&&text(done.text,200))failure.notDone={code:done.code,text:done.text};}
  const po=p.payment;const payment:PaymentOutcome|undefined=obj(po)&&typeof po.state==='string'&&PAYMENT_STATES.has(po.state)&&(po.reasonCode===null||id(po.reasonCode))&&typeof po.stepId==='string'&&(po.stepId==='unknown'||STEP_IDS.has(po.stepId))?{state:po.state,reasonCode:po.reasonCode as string|null,stepId:po.stepId,...(publicInitialPaymentFailure(po.initialFailure)?{initialFailure:publicInitialPaymentFailure(po.initialFailure)}:{}),...(publicPaymentHandoff(po.handoff)?{handoff:publicPaymentHandoff(po.handoff)}:{})}:undefined;
 return {version:1,locale:p.locale as 'fr'|'en',status:p.status as 'info'|'error',label:p.label,title:p.title,rows:[],spoken:p.spoken,primary:{label:p.primary.label,action:'done'},effect:{debited:'unknown',source:'receipt'},meta:{capability:cid as string|null},understood:{capability:cid as string|null,label:p.understood.label,slots,...(summary?{text:summary}:{})},alternatives,...(payment?{payment}:{}),...(failure?{failure}:{})};
}
export function fallbackReceiptPresentation(failed=false):ReceiptPresentation{return {version:1,locale:'fr',status:failed?'error':'info',label:'Demande',title:'Résultat à vérifier',rows:[],spoken:failed?'La demande n’a pas abouti. Consulte le détail avant toute nouvelle action.':'Le résultat de la demande reste à vérifier.',primary:{label:'Terminer',action:'done'},effect:{debited:'unknown',source:'receipt'},meta:{capability:null},understood:{capability:null,label:'Demande',slots:{}},alternatives:[],...(failed?{failure:{step:'Étape non établie',reason:'La cause n’est pas établie par le reçu.'}}:{})};}
/** Public helper failures describe the observed transport boundary, never a business/financial outcome. */
export function fastPathFailurePresentation(raw:unknown,stage:'resolution'|'execution'):ReceiptPresentation {
 const receipt=readReceiptPresentation(raw);if(receipt?.status==='error')return receipt;
 const p=fallbackReceiptPresentation(true);
 const reasons:Record<string,string>={
  helper_missing:'Le service de traitement est introuvable.',
  helper_failed:'Le service de traitement n’a pas renvoyé de résultat exploitable.',
  invalid_result:'Le service de traitement a renvoyé un résultat invalide.',
  invalid_check_budget:'Le budget de résolution est invalide.',
  check_budget_exceeded:'Le délai de résolution a été dépassé.',
 };
 const code=obj(raw)&&raw.status==='error'&&typeof raw.reason==='string'&&Object.prototype.hasOwnProperty.call(reasons,raw.reason)?raw.reason:undefined;
 const reason=code?reasons[code]:p.failure!.reason;
 const step=stage==='resolution'?'Résolution de la demande':'Lecture du résultat d’exécution';
 return {...p,title:'Demande interrompue',spoken:reason,failure:{step,reason,stepId:stage,...(code?{reasonCode:code}:{}),notDone:{code:'unknown'}}};
}
export function publicReceiptMetadata(p:ReceiptPresentation|undefined){return p?{presentation:p,understood:p.understood,alternatives:p.alternatives,...(p.failure?{failure:p.failure}:{})}:{};}
/** Closed public projection of the stored v2 decision (no recalculation, no raw payload):
 * type, capability, intent, target, risk, confirmationRequired and owner-validated parameters. */
export type PublicDecision={type:'EXECUTE'|'CLARIFY'|'REASON'|'STOP';capability:string|null;intent:string|null;target:string|null;risk:'read'|'write'|'transaction'|'destructive'|'sensitive'|'external_send'|'admin';confirmationRequired:boolean;parameters:{amountTnd?:string;beneficiary?:string}};
const DECISION_TYPES=new Set(['EXECUTE','CLARIFY','REASON','STOP']),RISKS=new Set(['read','write','transaction','destructive','sensitive','external_send','admin']);
export function publicDecision(raw:unknown):PublicDecision|undefined{
 if(!obj(raw)||typeof raw.type!=='string'||!DECISION_TYPES.has(raw.type))return undefined;
 const risk=typeof raw.risk==='string'&&RISKS.has(raw.risk)?raw.risk:undefined;if(!risk)return undefined;
 const opt=(v:unknown)=>id(v)?v:null;const parameters:PublicDecision['parameters']={};
 if(obj(raw.parameters)){const s=closedSlots({amountTnd:raw.parameters.amountTnd,beneficiary:raw.parameters.beneficiary});if(s.amountTnd)parameters.amountTnd=s.amountTnd;if(s.beneficiary&&s.beneficiary!=='owner')parameters.beneficiary=s.beneficiary;}
 return {type:raw.type as PublicDecision['type'],capability:opt(raw.capability),intent:opt(raw.intent),target:opt(raw.target),risk:risk as PublicDecision['risk'],confirmationRequired:raw.confirmationRequired===true,parameters};
}

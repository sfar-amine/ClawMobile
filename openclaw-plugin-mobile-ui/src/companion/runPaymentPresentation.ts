/**
 * HS3 reliquat (captures core #176, hs3/failed-payment-handoff.json) — projection, à la lecture, d'un run qui
 * passe la main à une demande de paiement. Aucune écriture, aucun nouveau store : la projection lit les
 * enregistrements existants du registre runs.json (run, ownerConfirmations, paymentRequests) et ne touche ni au
 * parcours de paiement ni à ses états. Elle ne déduit jamais un débit : effect.debited reste « unknown ».
 *
 * Chaîne (S24 11/10) : paymentRequests[].ownerConfirmationId → ownerConfirmations[].id ;
 * ownerConfirmations[].intent.origin.id → runs[].decision.requestId (ou runId / clientRunId).
 * Une demande créée directement pour le run (draft.origin.id = requestId / runId / clientRunId) compte aussi.
 */
import type {PaymentRecord} from "./paymentTypes";
import type {ConfirmationRecord} from "./confirmationCore";
import type {ReceiptPresentation,ReceiptSlots} from "./receiptPresentation";

type RunLike = {runId: string; clientRunId?: string; decision?: Record<string, unknown>; presentation?: ReceiptPresentation};

const ID = /^[a-z][a-z0-9_.-]{0,159}$/;
const LINK_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const AMOUNT = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/;
const TERMINAL_ERROR = new Set(["failed", "blocked", "effect_unknown", "expired", "cancelled"]);
const WAITING = new Set(["awaiting_owner", "approved", "executing", "requires_bank_action"]);
export const PAYMENT_PRESENTATION_STATES = new Set(["awaiting_owner", "executing", "requires_bank_action", "confirmed", "demo_confirmed",
  "failed", "blocked", "effect_unknown", "expired", "cancelled"]);
const OPERATORS: Record<string, ReceiptSlots["operator"]> = {"maxit-tunisie": "orange", "tunisie-telecom": "tt", "zain-bahrain": "zain"};
const ADAPTERS: Record<string, {operator?: ReceiptSlots["operator"]; provider?: ReceiptSlots["provider"]; fr: string; en: string}> = {
  "maxit.topup": {operator: "orange", fr: "Recharger mon numéro", en: "Top up my number"},
  topnet: {provider: "topnet", fr: "Payer la facture", en: "Pay the bill"},
  steg: {provider: "steg", fr: "Payer la facture", en: "Pay the bill"},
  sonede: {provider: "sonede", fr: "Payer la facture", en: "Pay the bill"},
};
const SLOT_NAMES: Record<string, string> = {orange: "Orange", tt: "Tunisie Telecom", zain: "Zain", topnet: "Topnet", steg: "STEG", sonede: "SONEDE"};
const TEXT = {
  fr: {label: "Demande", title: "Résultat à vérifier", confirmedTitle: "Paiement confirmé", failedTitle: "Paiement non abouti",
    spoken: "Le résultat de la demande reste à vérifier.", failed: "La demande n’a pas abouti. Consulte le détail avant toute nouvelle action.",
    confirmed: "Le fournisseur a confirmé le paiement.", waiting: "Ta confirmation est attendue avant de poursuivre.",
    executing: "Le paiement est en cours.", bank: "La validation bancaire est attendue.",
    step: "Étape non établie", cause: "La cause n’est pas établie par le reçu.", understood: "Compris : ", owner: "ta ligne", currency: "DT"},
  en: {label: "Request", title: "Result to verify", confirmedTitle: "Payment confirmed", failedTitle: "Payment not completed",
    spoken: "The result of the request still needs verification.", failed: "The request did not complete. Check its details before taking another action.",
    confirmed: "The provider confirmed the payment.", waiting: "Your confirmation is needed before proceeding.",
    executing: "The payment is in progress.", bank: "Bank verification is awaited.",
    step: "Step not established", cause: "The receipt does not establish the cause.", understood: "Understood: ", owner: "your line", currency: "TND"},
};
/** Mirror of samantha-ui-playbooks receipt_presentation.py REASONS, plus the payment owner's terminal codes. */
const REASONS: Record<string, [string, string]> = {
  payment_quote_changed: ["Le montant ou la facture a changé avant l’envoi.", "The amount or bill changed before sending."],
  payment_effect_unverified: ["L’effet du paiement n’est pas vérifié.", "The payment effect is not verified."],
  payment_rejection_unverified: ["Le refus n’est pas vérifié par le fournisseur.", "The rejection is not verified by the provider."],
  bank_declined: ["La banque a refusé l’opération.", "The bank declined the operation."],
  bank_verification_failed: ["La validation bancaire a échoué.", "Bank verification failed."],
  payment_cancelled: ["Le paiement a été annulé.", "The payment was cancelled."],
  owner_cancelled: ["Le paiement a été annulé.", "The payment was cancelled."],
  session_expired: ["La session du fournisseur a expiré.", "The provider session expired."],
  payment_not_submitted: ["Le paiement n’a pas pu être envoyé au fournisseur.", "The payment could not be sent to the provider."],
  payment_rejected_reason_unavailable: ["Le fournisseur a refusé le paiement sans en donner la raison.", "The provider rejected the payment without a reason."],
  owner_confirmation_expired: ["La confirmation n’a pas été donnée à temps.", "The confirmation was not given in time."],
  browser_context_unavailable: ["Le navigateur de paiement n’était pas disponible.", "The payment browser was not available."],
};
/** Mirror of receipt_presentation.py STAGES (transport telemetry such as state_transition is not a step). */
const STAGES: Record<string, [string, string]> = {
  owner_confirmation_consumed: ["Confirmation par empreinte", "Fingerprint confirmation"],
  payment_record_created: ["Préparation du paiement", "Payment preparation"],
  financial_dispatch_committed: ["Envoi au fournisseur", "Sending to the provider"],
  provider_session_started: ["Connexion au fournisseur", "Provider sign-in"],
  provider_session_authenticated: ["Connexion au fournisseur", "Provider sign-in"],
  invoice_revalidated: ["Vérification de la facture", "Bill check"],
  checkout_prepared: ["Préparation du règlement", "Checkout preparation"],
  browser_context_ready: ["Préparation du règlement", "Checkout preparation"],
  three_ds2_preflight: ["Validation bancaire", "Bank verification"],
  gateway_submission_started: ["Soumission du paiement", "Payment submission"],
  gateway_submission_result: ["Soumission du paiement", "Payment submission"],
  bank_ui_opened: ["Validation bancaire", "Bank verification"],
  bank_return_detected: ["Retour de la banque", "Bank return"],
  bank_return_requested: ["Retour de la banque", "Bank return"],
  bank_return_response: ["Retour de la banque", "Bank return"],
  bank_result_presented: ["Retour de la banque", "Bank return"],
  provider_callback_correlated: ["Vérification du résultat", "Result check"],
  provider_readback: ["Vérification du résultat", "Result check"],
  completion_classified: ["Vérification du résultat", "Result check"],
  execution_error: ["Exécution du paiement", "Payment execution"],
  bank_timeout_reconciliation_started: ["Réconciliation après délai", "Timeout reconciliation"],
  bank_resume_started: ["Reprise après la banque", "Resume after bank"],
};
const NOT_SUBMITTED: [string, string] = ["Rien n’a été envoyé au fournisseur.", "Nothing was sent to the provider."];

const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v) ? v : undefined;
const time = (r: any) => [r?.updatedAt, r?.endedAt, r?.createdAt].find(v => Number.isSafeInteger(v)) ?? 0;

function latest<T>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>((best, row) => !best || time(row) >= time(best) ? row : best, undefined);
}

/** Owner records linked to the run, newest first; undefined when the run never handed off to a payment. */
export function linkedPayment(run: RunLike, payments: PaymentRecord[], confirmations: ConfirmationRecord[]):
  {payment?: PaymentRecord; confirmation?: ConfirmationRecord} | undefined {
  const ids = new Set([str(run.decision?.requestId, LINK_ID), str(run.runId, LINK_ID), str(run.clientRunId, LINK_ID)].filter(Boolean) as string[]);
  if (!ids.size) return undefined;
  const confs = (Array.isArray(confirmations) ? confirmations : []).filter(c => obj(c) && ids.has(String((c as any).intent?.origin?.id ?? "")));
  const confIds = new Set(confs.map(c => c.id));
  const pays = (Array.isArray(payments) ? payments : []).filter(p => obj(p) &&
    ((typeof p.ownerConfirmationId === "string" && confIds.has(p.ownerConfirmationId)) || ids.has(String((p as any).draft?.origin?.id ?? ""))));
  const payment = latest(pays);
  const confirmation = payment?.ownerConfirmationId ? confs.find(c => c.id === payment.ownerConfirmationId) : latest(confs);
  return payment || confirmation ? {payment, confirmation} : undefined;
}

function amountTnd(payment: PaymentRecord | undefined, decision: Record<string, unknown> | undefined): string | undefined {
  const q: any = payment?.quote;
  if (q && q.currency === "TND" && Number.isSafeInteger(q.amountMinor) && q.amountMinor > 0 && Number.isInteger(q.decimals) && q.decimals >= 0 && q.decimals <= 3) {
    const value = (q.amountMinor / 10 ** q.decimals).toFixed(q.decimals).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    if (AMOUNT.test(value)) return value;
  }
  const raw = obj(decision?.parameters) ? decision!.parameters.amountTnd : undefined;
  return typeof raw === "string" && AMOUNT.test(raw) && Number(raw) > 0 ? raw : undefined;
}

/** Payee masked to its last two digits (never the full number); a provider name is not a beneficiary. */
function beneficiary(payment: PaymentRecord | undefined, decision: Record<string, unknown> | undefined): string | undefined {
  if (typeof decision?.intent === "string" && decision.intent.endsWith("_own_number")) return "owner";
  const raw = obj(decision?.parameters) && typeof decision!.parameters.beneficiary === "string" ? decision!.parameters.beneficiary : undefined;
  if (raw && /^•• ?\d{2,4}$/.test(raw)) return raw;
  const digits = String((payment as any)?.quote?.payee ?? "").replace(/\D/g, "");
  return digits.length >= 6 ? "•• " + digits.slice(-2) : undefined;
}

/** Decision intents/targets of the registry that name one payment adapter (lines.orange.topup, bills.*.pay). */
const INTENT_ADAPTERS: Record<string, string> = {"telecom.orange.topup_own_number": "maxit.topup"};
function adapterOf(payment: PaymentRecord | undefined, confirmation: ConfirmationRecord | undefined, decision: Record<string, unknown> | undefined): string | undefined {
  const fromDraft = str((payment as any)?.draft?.adapterId, /^[a-z][a-z0-9_.-]{1,60}$/);
  if (fromDraft) return fromDraft;
  const ref = /^([a-z][a-z0-9_.-]{1,60}):/.exec(String((confirmation as any)?.intent?.action?.reference ?? ""))?.[1];
  if (ref) return ref;
  if (typeof decision?.intent === "string" && INTENT_ADAPTERS[decision.intent]) return INTENT_ADAPTERS[decision.intent];
  return decision?.intent === "billing.pay" && typeof decision.target === "string" && ADAPTERS[decision.target]?.provider ? decision.target : undefined;
}

function lastStage(payment: PaymentRecord | undefined): string {
  const trace = Array.isArray(payment?.trace) ? payment!.trace.slice(-160) : [];
  for (let i = trace.length - 1; i >= 0; i--) { const s = trace[i]?.stage; if (typeof s === "string" && STAGES[s]) return s; }
  return "unknown";
}

export type RunPaymentOutcome = {state: string; reasonCode: string | null; stepId: string};

/**
 * Presentation of a run whose decision handed off to a payment request. The stored presentation keeps its
 * label when no closed label is known; understood/status/failure come from the owner records only.
 */
export function projectRunPayment(run: RunLike, payments: PaymentRecord[], confirmations: ConfirmationRecord[]):
  ReceiptPresentation | undefined {
  const link = linkedPayment(run, payments, confirmations);
  if (!link) return undefined;
  const {payment, confirmation} = link;
  const state = payment ? payment.state : String((confirmation as any)?.state ?? "");
  // A confirmation alone: consumed without a payment record proves nothing more than the stored run.
  const effective = payment ? state : state === "expired" || state === "cancelled" ? state : WAITING.has(state) ? "awaiting_owner" : undefined;
  if (!effective || !PAYMENT_PRESENTATION_STATES.has(effective)) return undefined;
  const reasonCode = payment ? str(payment.reasonCode, ID) ?? null : effective === "expired" ? "owner_confirmation_expired" : effective === "cancelled" ? "owner_cancelled" : null;
  const stored = run.presentation;
  const locale: "fr" | "en" = stored?.locale === "en" ? "en" : "fr";
  const i = locale === "fr" ? 0 : 1, t = TEXT[locale];
  const decision = obj(run.decision) ? run.decision : undefined;
  const capability = str(decision?.capability, ID) ?? (payment || confirmation ? "payment.owner_native" : null);
  const adapter = adapterOf(payment, confirmation, decision), known = adapter ? ADAPTERS[adapter] : undefined;
  const label = known ? known[locale] : stored?.understood?.label || t.label;
  const slots: ReceiptSlots = {};
  const op = known?.operator ?? (typeof decision?.target === "string" ? OPERATORS[decision.target] : undefined);
  if (op) slots.operator = op;
  if (known?.provider) slots.provider = known.provider;
  const amount = amountTnd(payment, decision); if (amount) slots.amountTnd = amount;
  const who = beneficiary(payment, decision); if (who) slots.beneficiary = who;
  const parts = [label];
  const name = slots.operator || slots.provider; if (name) parts.push(SLOT_NAMES[name]);
  if (slots.amountTnd) parts.push(`${slots.amountTnd} ${t.currency}`);
  if (slots.beneficiary) parts.push(slots.beneficiary === "owner" ? t.owner : slots.beneficiary);
  const failed = TERMINAL_ERROR.has(effective);
  const confirmed = effective === "confirmed";
  const spoken = failed ? t.failed : confirmed ? t.confirmed : effective === "executing" ? t.executing
    : effective === "requires_bank_action" ? t.bank : effective === "awaiting_owner" ? t.waiting : t.spoken;
  const stepId = lastStage(payment);
  const out: ReceiptPresentation = {version: 1, locale, status: failed ? "error" : "info", label,
    title: failed ? t.failedTitle : confirmed ? t.confirmedTitle : t.title, rows: [], spoken,
    primary: {label: stored?.primary?.label || (locale === "fr" ? "Terminer" : "Done"), action: "done"},
    effect: {debited: "unknown", source: "receipt"}, meta: {capability},
    understood: {capability, label, slots, text: t.understood + parts.join(" · ")},
    alternatives: [], payment: {state: effective, reasonCode, stepId}};
  if (failed) {
    // blocked = the payment owner proves nothing was submitted (paymentCore applyResult); no record = no dispatch.
    const notSubmitted = !payment || effective === "blocked" && reasonCode === "payment_not_submitted" ||
      (["blocked", "expired", "cancelled"].includes(effective) && (payment.executorAttempts ?? 0) === 0);
    out.failure = {step: STAGES[stepId]?.[i] ?? t.step, stepId, reason: (reasonCode && REASONS[reasonCode]?.[i]) || t.cause,
      ...(reasonCode ? {reasonCode} : {}),
      notDone: notSubmitted ? {code: "payment_not_submitted", text: NOT_SUBMITTED[i]} : {code: "unknown"}};
  }
  return out;
}

import type {OwnerTurnObserver} from "./ownerTurnGateway";
import {readRunWebResult, type RunWebResult} from "./runWeb";
import {MEMO_STT_QUALIFICATION} from "./memoSttBoundary";
import {isTechnicalProgressLabel, runProgressSteps} from "./runProgress";
import {readReceiptPresentation,fallbackReceiptPresentation,publicReceiptMetadata,publicDecision,type ReceiptPresentation} from "./receiptPresentation";
import {projectRunPayment} from "./runPaymentPresentation";
import { structuredNotification } from "./notificationText";
import {capabilityProvenance,type CapabilityProvenance} from "./capabilityProvenance";
import {conversationOwnerIndex,invalidateConversationOwner} from "./conversationOwnerIndex";
import {stripConversationTransport} from "./conversationText";
import {removeAttachments} from "./attachmentStorage";
import fs from "fs/promises";
import {RUN_INACTIVITY_MS, ownerTurnEvidence, protectedRun, type InactivityReceipt} from "./runInactivity";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import {validateVoicePlayback,type VoicePlaybackMetadata} from "./voicePlaybackMetadata";
import type { PaymentRecord } from "./paymentTypes";
import type { ConfirmationRecord } from "./confirmationCore";
import os from "os";
import path from "path";
import { intentCanvas } from "./canvas";
import { callOpenClawGateway, expectedCompanionSessionKey, normalizeCompanionSessionId, type OpenClawAgentSubmitResult } from "./openclawAgentClient";
import type { CompanionRunProgress, CompanionRunProgressEvent, CompanionRunStatus, CompanionRunTokenUsage, IntentAttachment, ReplayLink } from "./types";

import {TURN_BUDGET_MS, validateTurnMeasurement, turnMeasurementLogLine, type TurnMeasurement} from "./turnBudget";

type GatewayObservation = {version:1; epoch:string; state:"following"|"reconcile"|"settled"; deadlineAt:number; reconciled?:true};
type StoredRun = {
  /** Host provenance only: never accepted from a client body or model arguments. */
  semanticOwner?: "main";
  internalOperation?: true;
  gatewayObservation?: GatewayObservation;
  gatewayProgress?: CompanionRunProgress;
  /** Host-owned surface for native turns; absence on retained text runs means app. */
  turnSurface?: "app" | "whatsapp" | "voice";
  measurementOnly?: true;
  nativeTurn?: {version:1;deadlineAt:number;clockEpoch:string;startedMono:number;ingressPending?:true;adoptedByRunId?:string;adoptedMono?:number;notice:"pending"|"attempted"|"accepted"|"uncertain"|"cancelled";
    accountId?:string;ended?:boolean;deliveredMono?:number;route:"tool"|"question"|"answer"|"reflex"|null;model?:string;decisionMs:number|null;toolMs:number|null};
  turnMeasurement?: TurnMeasurement;
  web?: RunWebResult;
  memo?: {attachmentId: string; ownerEpoch: string; phase: "transcribing" | "transcription_pending" | "ready" | "dispatched"; attempts: number; nextAttemptAt?: number};
  presentation?: ReceiptPresentation;
  /** Derived on read from paymentRequests/ownerConfirmations (runPaymentPresentation.ts); stripped on write. */
  paymentPresentation?: ReceiptPresentation;
  provenance?: CapabilityProvenance;
  inactivityCorrectionReceipt?: InactivityReceipt;
  runId: string;
  clientRunId?: string;
  requestHash?: string;
  executionSource?: "gateway" | "capability_first";
  decision?: Record<string, unknown>;
  clarificationState?: "pending" | "resolved" | "abandoned";
  clarificationExpiresAt?: number;
  parentClarificationRunId?: string;
  /** SAM-MIG V2.2: goal of the dialogue coordinator this run projects (display only, never a decision source). */
  dialogueGoalRef?: string;
  sessionId: string;
  sessionKey?: string;
  text: string;
  userText?: string;
  attachments?: IntentAttachment[];
  acceptedAt: number;
  updatedAt?: number;
  state?: CompanionRunStatus["state"];
  error?: string;
  result?: string;
  modality?: "voice";
  transcriptState?: "partial" | "completed" | "interrupted";
  transcriptRevision?: number;
  playback?: VoicePlaybackMetadata;
  notThis?: RunCorrection;
  /** Édition-relecture : lien vers le message modifié d'origine, et marque d'audit sur l'ancienne branche. */
  replayOf?: ReplayLink;
  supersededBy?: ReplayLink;
  /** P1 : tour admis par preuve native signée, persisté (jamais déduit du texte ni du loopback). */
  ownerAdmitted?: true;
  /** P1 : connexion finalement utilisée pour ce tour (l'admission peut expirer avant la remise). */
  ownerTransport?: OwnerTransport;
  /** Sanitized deterministic-runner failure class; no provider detail or free text. */
  reasonClass?: string;
};
export type OwnerTransport = "admin_admitted" | "write_cli" | "write_cli_owner_unavailable";
const OWNER_TRANSPORTS = new Set<string>(["admin_admitted", "write_cli", "write_cli_owner_unavailable"]);
const REASON_CLASS_RE = /^[a-z][a-z0-9_]{0,95}$/;
export function publicReasonClass(value: unknown): string | undefined {
  return typeof value === "string" && REASON_CLASS_RE.test(value) ? value : undefined;
}

/** F3: project only this owner's fixed diagnostic codes into the existing process output sink.
 * bounded-log.py --timestamp owns the wall clock and rotation; no second logger or file owner.
 * No Error/message, request, result, attachment path or arbitrary metadata may enter this projection.
 */
function runDiagnostic(
  level: "warn" | "error",
  code: "memo_attachment_cleanup_unavailable" | "invalid_run_deletion_receipts_ignored" | "submitted_run_failed",
  run?: Pick<StoredRun, "runId" | "clientRunId" | "reasonClass">,
  count?: number,
) {
  const fields: Record<string, string | number> = {};
  for (const key of ["runId", "clientRunId"] as const) {
    const value = run?.[key];
    if (typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)
        && !/^(?:sk-|ghp_|github_pat_|bearer)/i.test(value)) fields[key] = value;
  }
  const reasonClass = publicReasonClass(run?.reasonClass);
  if (reasonClass) fields.reasonClass = reasonClass;
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) fields.count = count;
  // Fixed component, level, bounded correlation fields and code. Never interpolate free strings.
  // A broken diagnostic sink cannot change the result of the existing registry mutation.
  const suffix = Object.entries(fields).map(([key, value]) => key + "=" + value).join(" ");
  try { console.log("component=runs level=" + level + " event=" + code + (suffix ? " " + suffix : "")); } catch {}
}

/** 38 A2 « Ce n'est pas ça » (D3) : trace bornée sur le run existant, sans texte ni montant. */
export type RunCorrection = {version: 1; operationId: string; at: number; neutralized: number;
  counterExample: "recorded" | "not_stored" | "none"; roundSignal: "pending" | "not_captured" | "none"};
const CORRECTION_OPERATION_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
function validRunCorrection(value: any): RunCorrection | undefined {
  if (value?.version !== 1 || typeof value.operationId !== "string" || !CORRECTION_OPERATION_RE.test(value.operationId) ||
      !Number.isFinite(value.at) || !Number.isSafeInteger(value.neutralized) || value.neutralized < 0 ||
      !["recorded", "not_stored", "none"].includes(value.counterExample) || !["pending", "not_captured", "none"].includes(value.roundSignal)) return undefined;
  return {version: 1, operationId: value.operationId, at: value.at, neutralized: value.neutralized,
    counterExample: value.counterExample, roundSignal: value.roundSignal};
}

function validReplayLink(value: any): ReplayLink | undefined {
  if (value?.version !== 1 || typeof value.sessionId !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(value.sessionId) ||
      typeof value.runId !== "string" || !CLIENT_RUN_ID_RE.test(value.runId) || !Number.isFinite(value.at)) return undefined;
  return {version: 1, sessionId: value.sessionId, runId: value.runId, at: value.at};
}
function compareRuns(left: StoredRun, right: StoredRun) {
  return left.acceptedAt - right.acceptedAt || left.runId.localeCompare(right.runId);
}

type CompanionRunRegistry = {
  paymentRequests: PaymentRecord[];
  ownerConfirmations: ConfirmationRecord[];
  runs: StoredRun[];
  archivedSessionIds: string[];
  runDeletions: RunDeletionReceipt[];
};

type RunDeletionReceipt = {version: 1; operationId: string; runId: string; clientRunId?: string;
  sessionId: string; action: "delete_run"; state: "completed"; at: number; attachmentPaths?: string[]};

type TrajectorySummary = {
  runId?: string;
  prompt?: string;
  result?: string;
  state?: CompanionRunStatus["state"];
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  progress?: CompanionRunProgress;
  tokenUsage?: CompanionRunTokenUsage;
};

type TranscriptSummary = {
  prompt: string;
  result: string;
  startedAt?: number;
  endedAt?: number;
  progressEvents: CompanionRunProgressEvent[];
  tokenUsage?: CompanionRunTokenUsage;
};

const submittedRuns = new Map<string, StoredRun>();
const MEMO_OWNER_EPOCH = randomUUID();
const GATEWAY_OBSERVER_EPOCH = randomUUID();
const GATEWAY_FOLLOW_MS = 120000;
const CLIENT_RUN_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_PERSISTED_RUNS = 500;
const MAX_PERSISTED_RUN_BYTES = 8 * 1024 * 1024;

function retainStoredRuns(rows: StoredRun[]): StoredRun[] {
  const retained: StoredRun[] = [];
  const seen = new Set<string>();
  let bytes = 2;
  for (const row of rows) {
    if (seen.has(row.runId) || retained.length >= MAX_PERSISTED_RUNS) continue;
    const encoded = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    // Always keep the newest row even if it is unusually large; subsequent rows are bounded by bytes.
    if (retained.length > 0 && bytes + encoded > MAX_PERSISTED_RUN_BYTES) break;
    retained.push(row); seen.add(row.runId); bytes += encoded;
  }
  return retained;
}

let registryWrite: Promise<unknown> = Promise.resolve();
function mutateRegistry<T>(operation: () => Promise<T>): Promise<T> {
  const next = registryWrite.then(operation, operation);
  registryWrite = next.then(() => undefined, () => undefined);
  return next;
}
async function registryOrEmpty() {
  try { return await readCompanionRunRegistry(); }
  catch (error: any) { if (error?.code === "ENOENT") return defaultCompanionRunRegistry(); throw error; }
}

function requireClientRunId(value: string) {
  const normalized = String(value || "").trim();
  if (!CLIENT_RUN_ID_RE.test(normalized)) {
    throw Object.assign(new Error("invalid_client_run_id"), { statusCode: 400 });
  }
  return normalized;
}

function submissionRequestHash(
  text: string,
  sessionId: string,
  userText: string,
  attachments: IntentAttachment[],
  replayOf?: {sessionId: string; runId: string},
) {
  // La relecture n'entre dans l'empreinte que si elle existe : les empreintes déjà stockées restent valides.
  return createHash("sha256").update(JSON.stringify({
    text,
    sessionId,
    userText,
    attachments,
    ...(replayOf ? {replayOf: [replayOf.sessionId, replayOf.runId]} : {}),
  })).digest("hex");
}

/** Optional admission runs under the existing registry writer before any reservation. */
export type RunReservationAdmission=(run:Readonly<StoredRun>,existing:readonly StoredRun[],canRetain:(rows:StoredRun[])=>boolean)=>void;
export async function reserveSubmittedRun(
  text: string,
  sessionId: string,
  clientRunId: string,
  options: {
    userText?: string;
    attachments?: IntentAttachment[];
    requestText?: string;
    executionSource?: "gateway" | "capability_first";
    decision?: Record<string, unknown>;
    parentClarificationRunId?: string;
    dialogueGoalRef?: string;
    admission?: RunReservationAdmission;
    memoAttachmentId?: string;
    replayOf?: {sessionId: string; runId: string};
    ownerAdmitted?: boolean;
    semanticOwner?: "main";
    internalOperation?: true;
  } = {},
): Promise<{ created: boolean; status: CompanionRunStatus }> {
  const clientId = requireClientRunId(clientRunId);
  const normalizedSessionId = normalizeCompanionSessionId(sessionId || "default");
  const userText = String(options.userText || text);
  const attachments = options.attachments || [];
  const replayOf = options.replayOf ? {sessionId: normalizeCompanionSessionId(options.replayOf.sessionId), runId: String(options.replayOf.runId)} : undefined;
  const requestHash = submissionRequestHash(options.requestText || text, normalizedSessionId, userText, attachments, replayOf);

  return mutateRegistry(async () => {
    const registry = await registryOrEmpty();
    if (registry.runDeletions.some(receipt => receipt.clientRunId === clientId))
      throw Object.assign(new Error("run_deleted"), {statusCode: 409});
    const existing = registry.runs.find((run) => run.clientRunId === clientId);
    if (existing) {
      const expectedSource = options.executionSource || existing.executionSource || "gateway";
      if (existing.requestHash !== requestHash || existing.sessionId !== normalizedSessionId ||
          ((existing.executionSource || "gateway") !== expectedSource &&
           !(options.memoAttachmentId && existing.memo?.attachmentId === options.memoAttachmentId))) {
        throw Object.assign(new Error("client_run_identity_conflict"), { statusCode: 409 });
      }
      submittedRuns.set(existing.runId, existing);
      return { created: false, status: statusFromStoredRun(existing) };
    }

    const now = Date.now();
    // Relecture : revérifiée dans la même écriture du registre (la source peut avoir changé depuis prepareReplay).
    const source = replayOf ? registry.runs.find(run => run.runId === replayOf.runId && run.sessionId === replayOf.sessionId) : undefined;
    if (replayOf && (!source || source.supersededBy)) throw Object.assign(new Error("replay_source_changed"), {statusCode: 409});
    if (replayOf && registry.runs.some(run => run.sessionId === normalizedSessionId))
      throw Object.assign(new Error("replay_target_not_empty"), {statusCode: 409});
    const newRunId = `run_${now}_${randomBytes(4).toString("hex")}`;
    const stored: StoredRun = {
      runId: newRunId,
      clientRunId: clientId,
      requestHash,
      memo: options.memoAttachmentId ? {attachmentId: options.memoAttachmentId, ownerEpoch: MEMO_OWNER_EPOCH, phase: "transcribing", attempts: 1} : undefined,
      executionSource: options.executionSource || "gateway",
      ...(options.semanticOwner === "main" && options.ownerAdmitted === true && options.executionSource === "gateway" ? {semanticOwner:"main" as const} : {}),
      ...(options.internalOperation === true ? {internalOperation:true as const} : {}),
      presentation: options.executionSource === "capability_first" ? fallbackReceiptPresentation() : undefined,
      decision: options.decision && typeof options.decision === "object" ? options.decision : undefined,
      clarificationState: String(options.decision?.type || "") === "CLARIFY" ? "pending" : undefined,
      clarificationExpiresAt: String(options.decision?.type || "") === "CLARIFY" ? now + CLARIFICATION_PROJECTION_MS : undefined,
      parentClarificationRunId: options.parentClarificationRunId,
      dialogueGoalRef: dialogueGoalRefOf(options.dialogueGoalRef),
      sessionId: normalizedSessionId,
      sessionKey: expectedCompanionSessionKey(normalizedSessionId),
      text,
      userText,
      attachments: attachments.length > 0 ? attachments : undefined,
      acceptedAt: now,
      updatedAt: now,
      state: "running",
      ...(replayOf ? {replayOf: {version: 1 as const, ...replayOf, at: now}} : {}),
      ...(options.ownerAdmitted === true ? {ownerAdmitted: true as const} : {}),
    };
    // Audit : le message modifié et les tours suivants de l'ancienne branche sont marqués, jamais supprimés.
    const link: ReplayLink | undefined = source ? {version: 1, sessionId: normalizedSessionId, runId: newRunId, at: now} : undefined;
    const marked = source && link ? registry.runs.map(run => run.sessionId === source.sessionId && compareRuns(run, source) >= 0 && !run.supersededBy
      ? {...run, supersededBy: link} : run) : registry.runs;
    options.admission?.(stored,marked,(rows)=>{
      const retained=retainStoredRuns(rows);
      return retained.length===rows.length&&rows.every(row=>retained.some(candidate=>candidate.runId===row.runId))&&
        Buffer.byteLength(JSON.stringify({version:1,...registry,runs:rows},null,2),'utf8')+512<=MAX_PERSISTED_RUN_BYTES;
    });
    // E4 admission runs before any cache update: a refused reservation leaves no superseded mark behind.
    if (link) for (const run of marked) if (run.supersededBy === link && submittedRuns.has(run.runId)) submittedRuns.set(run.runId, run);
    const next = retainStoredRuns([stored, ...marked]);
    const archivedSessionIds = registry.archivedSessionIds.filter((id) => id !== normalizedSessionId);
    submittedRuns.set(stored.runId, stored);
    await writeCompanionRunRegistry(next, archivedSessionIds);
    return { created: true, status: statusFromStoredRun(stored) };
  });
}

/** HS8 internal continuation: durable audio identity is never replaced by transcript identity.
 * A transcript is claimed once, then dispatch is claimed once under the existing registry lock.
 * Deletion/failure wins before either claim; an interrupted claim is never redispatched. */
export async function claimMemoTranscript(runId: string, attachmentId: string, text: string): Promise<boolean> {
  return mutateRegistry(async () => {
    const registry = await registryOrEmpty();
    const row = registry.runs.find(run => run.runId === runId);
    if (!row || row.state !== "running" || row.memo?.phase !== "transcribing" || row.memo.ownerEpoch !== MEMO_OWNER_EPOCH ||
        row.memo.attachmentId !== attachmentId || registry.runDeletions.some(r => r.runId === runId)) return false;
    const claimed: StoredRun = {...row, text, userText: text, memo: {...row.memo, phase: "ready"}, updatedAt: Date.now()};
    await writeCompanionRunRegistry(registry.runs.map(r => r.runId === runId ? claimed : r), registry.archivedSessionIds);
    submittedRuns.set(runId, claimed);
    return true;
  });
}

export const MEMO_MAX_ATTEMPTS = 3;
const MEMO_RETRY_DELAYS = [2 * 60_000, 10 * 60_000];
export const MEMO_FAILED_AUDIO_RETENTION_MS = 60 * 60_000;
const MEMO_TERMINAL_ERROR = "La transcription du mémo a échoué. Enregistrez un nouveau mémo pour réessayer.";
function failedMemoAttachments(row: StoredRun, failedAt: number) {
  const deadline = failedAt + MEMO_FAILED_AUDIO_RETENTION_MS;
  return (row.attachments || []).map(attachment => ({...attachment,
    expiresAt: Math.min(typeof attachment.expiresAt === "number" && Number.isFinite(attachment.expiresAt)
      ? attachment.expiresAt : deadline, deadline)}));
}
/** Provider failure has no executable transcript. Keep audio only while an automatic retry remains. */
export async function deferMemoTranscription(runId: string): Promise<void> {
  await mutateRegistry(async () => {
    const registry = await registryOrEmpty(), row = registry.runs.find(r => r.runId === runId);
    if (!row || row.state !== "running" || row.memo?.phase !== "transcribing" ||
        row.memo.ownerEpoch !== MEMO_OWNER_EPOCH || registry.runDeletions.some(r => r.runId === runId)) return;
    const exhausted = row.memo.attempts >= MEMO_MAX_ATTEMPTS, now = Date.now();
    const next: StoredRun = {...row, attachments: exhausted ? failedMemoAttachments(row, now) : row.attachments,
      state: exhausted ? "failed" : "running",
      error: exhausted ? MEMO_TERMINAL_ERROR : undefined, updatedAt: now,
      memo: {...row.memo, phase: "transcription_pending", nextAttemptAt: exhausted ? undefined
        : now + MEMO_RETRY_DELAYS[row.memo.attempts - 1]}};
    await writeCompanionRunRegistry(registry.runs.map(r => r.runId === runId ? next : r), registry.archivedSessionIds);
    submittedRuns.set(runId, next);
  });
}

/** Status reads claim an eligible retry once, before launching any provider call.
 * No timer, scheduler, new store, client flag or request field can trigger this. */
async function resumeDueMemo(runId: string): Promise<boolean> {
  if (!MEMO_STT_QUALIFICATION.success) return false;
  const claim = await mutateRegistry(async () => {
    const registry = await registryOrEmpty(), row = registry.runs.find(r => r.runId === runId), now = Date.now();
    if (row?.memo && (row.attachments || []).some(a => a.mimeType === "audio/mp4" &&
        typeof a.expiresAt === "number" && Number.isFinite(a.expiresAt) && a.expiresAt <= now)) {
      const expired: StoredRun = {...row, state: "failed", error: row.state === "failed" ? row.error : "Le mémo vocal a expiré.", attachments: undefined,
        updatedAt: now, memo: {...row.memo, nextAttemptAt: undefined}};
      await writeCompanionRunRegistry(registry.runs.map(r => r.runId === runId ? expired : r), registry.archivedSessionIds);
      submittedRuns.set(runId, expired);
      removeAttachments((row.attachments || []).map(a => a.serverPath || a.path || ""),
        new Set(registry.runs.filter(r => r.runId !== runId).flatMap(r => (r.attachments || []).map(a => a.serverPath || a.path || ""))));
      return {waiting: true as const};
    }
    if (!row || row.state !== "running" || !row.memo || !row.clientRunId ||
        registry.archivedSessionIds.includes(row.sessionId) || registry.runDeletions.some(r => r.runId === runId)) return null;
    // A previous process may have stopped in STT, before any canonical dispatch.
    if (row.memo.phase === "transcribing" && row.memo.ownerEpoch !== MEMO_OWNER_EPOCH) {
      const exhausted = row.memo.attempts >= MEMO_MAX_ATTEMPTS;
      const waiting: StoredRun = {...row, updatedAt: now, memo: {...row.memo,
        phase: "transcription_pending", nextAttemptAt: row.memo.attempts >= MEMO_MAX_ATTEMPTS ? undefined : now + MEMO_RETRY_DELAYS[row.memo.attempts - 1]},
        attachments: exhausted ? failedMemoAttachments(row, now) : row.attachments,
        state: exhausted ? "failed" : "running",
        error: exhausted ? MEMO_TERMINAL_ERROR : undefined};
      await writeCompanionRunRegistry(registry.runs.map(r => r.runId === runId ? waiting : r), registry.archivedSessionIds);
      submittedRuns.set(runId, waiting); return {waiting: true as const};
    }
    if (row.memo.phase !== "transcription_pending" || row.memo.attempts >= MEMO_MAX_ATTEMPTS ||
        !Number.isFinite(row.memo.nextAttemptAt) || row.memo.nextAttemptAt! > now) return null;
    const next: StoredRun = {...row, updatedAt: now, memo: {...row.memo, ownerEpoch: MEMO_OWNER_EPOCH,
      phase: "transcribing", attempts: row.memo.attempts + 1, nextAttemptAt: undefined}};
    await writeCompanionRunRegistry(registry.runs.map(r => r.runId === runId ? next : r), registry.archivedSessionIds);
    submittedRuns.set(runId, next);
    return {waiting: false as const, runId, sessionId: row.sessionId, clientRunId: row.clientRunId, attachmentId: row.memo.attachmentId};
  });
  if (!claim) return false;
  if (!claim.waiting) void require("./intent").resumeMemoIntent(claim.runId, claim.sessionId, claim.clientRunId, claim.attachmentId);
  return true;
}

export async function claimMemoDispatch(runId: string, text: string, executionSource: "gateway" | "capability_first",
  decision?: Record<string, unknown>, parentClarificationRunId?: string, authorized?: () => boolean, ownerAdmitted = false,
  dialogueGoalRef?: string, semanticOwner?: "main"): Promise<boolean> {
  return mutateRegistry(async () => {
    const registry = await registryOrEmpty();
    const row = registry.runs.find(run => run.runId === runId);
    if (authorized?.() !== true || !row || row.state !== "running" || row.memo?.phase !== "ready" || row.text !== text ||
        registry.runDeletions.some(r => r.runId === runId)) return false;
    const now = Date.now();
    const claimed: StoredRun = {...row, attachments: undefined, executionSource, decision, parentClarificationRunId, dialogueGoalRef: dialogueGoalRefOf(dialogueGoalRef), ownerAdmitted: ownerAdmitted === true ? true as const : undefined,
      ...(semanticOwner === "main" && ownerAdmitted && executionSource === "gateway" ? {semanticOwner:"main" as const} : {}),
      memo: {...row.memo, phase: "dispatched", ownerEpoch: MEMO_OWNER_EPOCH}, updatedAt: now,
      clarificationState: decision?.type === "CLARIFY" ? "pending" : undefined,
      clarificationExpiresAt: decision?.type === "CLARIFY" ? now + CLARIFICATION_PROJECTION_MS : undefined};
    await writeCompanionRunRegistry(registry.runs.map(r => r.runId === runId ? claimed : r), registry.archivedSessionIds);
    submittedRuns.set(runId, claimed);
    // Release only this authorized dispatch's audio, under the same registry lock.
    const protectedPaths = new Set(registry.runs.filter(r => r.runId !== runId).flatMap(r => (r.attachments || []).map(a => a.serverPath || a.path || "")));
    try { removeAttachments((row.attachments || []).map(a => a.serverPath || a.path || ""), protectedPaths); }
    catch { runDiagnostic("error", "memo_attachment_cleanup_unavailable", row); }
    return true;
  });
}

export async function rememberSubmittedRun(
  text: string,
  result: OpenClawAgentSubmitResult,
  options: { userText?: string; attachments?: IntentAttachment[]; executionSource?: "gateway" | "capability_first"; decision?: Record<string, unknown>; parentClarificationRunId?: string; dialogueGoalRef?: string; ownerAdmitted?: boolean; semanticOwner?: "main" } = {},
) {
  const existing = submittedRuns.get(result.runId)
    || (await findStoredRun(result.runId).catch(() => null));
  const stored = {
    ...existing,
    executionSource: options.executionSource || existing?.executionSource || "gateway",
    ...(options.semanticOwner === "main" && options.ownerAdmitted === true && (options.executionSource || existing?.executionSource || "gateway") === "gateway" ? {semanticOwner:"main" as const} : {}),
    presentation: existing?.presentation || (options.executionSource === "capability_first" ? fallbackReceiptPresentation() : undefined),
    runId: result.runId,
    sessionId: result.sessionId,
    sessionKey: normalizedStoredSessionKey(result.sessionId, result.sessionKey),
    text,
    userText: options.userText || existing?.userText,
    attachments: options.attachments && options.attachments.length > 0 ? options.attachments : existing?.attachments,
    decision: options.decision || existing?.decision,
    clarificationState: String(options.decision?.type || existing?.decision?.type || "") === "CLARIFY" ? (existing?.clarificationState || "pending") : existing?.clarificationState,
    clarificationExpiresAt: String(options.decision?.type || existing?.decision?.type || "") === "CLARIFY" ? (existing?.clarificationExpiresAt || Date.now() + CLARIFICATION_PROJECTION_MS) : existing?.clarificationExpiresAt,
    parentClarificationRunId: options.parentClarificationRunId || existing?.parentClarificationRunId,
    dialogueGoalRef: dialogueGoalRefOf(options.dialogueGoalRef) || existing?.dialogueGoalRef,
    acceptedAt: existing?.acceptedAt || result.acceptedAt || Date.now(),
    updatedAt: Date.now(),
    state: "running" as const,
    error: undefined,
    ...(options.ownerAdmitted === true || existing?.ownerAdmitted ? {ownerAdmitted: true as const} : {}),
    ...(result.ownerTransport || existing?.ownerTransport ? {ownerTransport: result.ownerTransport || existing?.ownerTransport} : {}),
  };
  submittedRuns.set(result.runId, stored);
  await saveStoredRun(stored).catch(() => undefined);
}

/** Volatile observation metadata lives with its existing durable run, never a new execution store. */
function readGatewayObservation(v:any):GatewayObservation|undefined {
  if(v?.version!==1||typeof v.epoch!=="string"||!/^[a-f0-9-]{36}$/.test(v.epoch)||
    !["following","reconcile","settled"].includes(v.state)||!Number.isFinite(v.deadlineAt))return undefined;
  return {version:1,epoch:v.epoch,state:v.state,deadlineAt:v.deadlineAt,...(v.reconciled===true?{reconciled:true as const}:{})};
}
function readGatewayProgress(v:any):CompanionRunProgress|undefined {
  if(!v||!Array.isArray(v.events))return undefined;
  const events=v.events.slice(-48).filter((e:any)=>e&&["tool.call","tool.result","tool.error"].includes(e.type)&&
    typeof e.callId==="string"&&/^[A-Za-z0-9_.:-]{1,160}$/.test(e.callId)&&
    typeof e.label==="string"&&e.label.length<=160&&!isTechnicalProgressLabel(e.label));
  const rawCard=v.card;
  const card=rawCard?projectProgressCard({...rawCard,steps:Array.isArray(rawCard.steps)?rawCard.steps.map((step:any)=>({step:step.label,
    status:step.state==="done"?"completed":step.state==="running"?"in_progress":"pending"})):[]}):null;
  return events.length||card?{text:"",events,...(card?{card}:{})}:undefined;
}
function observedRunStatus(stored:StoredRun):CompanionRunStatus {
  return {...statusFromStoredRun(stored),...(stored.gatewayProgress?{progress:stored.gatewayProgress}:{})};
}
async function updateObservedRun(runId:string,change:(stored:StoredRun)=>StoredRun|undefined) {
  return mutateRegistry(async()=>{
    const registry=await registryOrEmpty();
    if(registry.runDeletions.some(r=>r.runId===runId))return undefined;
    const stored=registry.runs.find(r=>r.runId===runId)||submittedRuns.get(runId);
    if(!stored)return undefined;
    const next=change(stored);if(!next)return undefined;
    submittedRuns.set(runId,next);
    await writeCompanionRunRegistry(retainStoredRuns([next,...registry.runs.filter(r=>r.runId!==runId)]),registry.archivedSessionIds);
    return next;
  });
}
/** The Gateway agent terminal RPC (SDK expectFinal) contains AgentRunResult, not a narrative acknowledgement. */
export function gatewayTerminalResult(value:any,runId:string):{state:"done"|"failed";text:string}|null {
  if(!value||value.runId!==runId||!["ok","error","timeout"].includes(value.status))return null;
  if(value.status!=="ok")return {state:"failed",text:"Samantha n'a pas pu terminer cette demande. Son résultat doit être vérifié avant tout nouvel essai."};
  const result=value.result,meta=result?.meta;
  if(!result||typeof result!=="object"||Array.isArray(result)||meta?.error||meta?.aborted||meta?.stopReason==="timeout"||meta?.stopReason==="error"||
    (Array.isArray(result.payloads)&&result.payloads.some((p:any)=>p?.isError===true)))return null;
  const visible=(text:unknown):text is string=>typeof text==="string"&&text.trim().length>0&&!text.includes("NO_REPLY");
  let text=visible(meta?.finalAssistantVisibleText)?meta.finalAssistantVisibleText:"";
  if(!text&&Array.isArray(result.payloads)&&result.payloads.length<=32)
    text=result.payloads.filter((p:any)=>p&&p.visible!==false&&p.isError!==true&&p.phase!=="commentary"&&
      p.channel!=="commentary"&&p.isReasoning!==true&&p.isCommentary!==true&&p.isCompactionNotice!==true&&
      p.isFallbackNotice!==true&&p.isStatusNotice!==true&&visible(p.text)).map((p:any)=>p.text.trim()).join("\n");
  return text.trim()&&text.length<=32768?{state:"done",text}:null;
}
/** Internal authority proof for an exact existing app/voice run; no Gateway read, prompt, or inferred WA ownership. */
export async function activeObservedGatewayRun(runId:string,sessionKey:string):Promise<boolean> {
  await registryWrite;
  const row=await findStoredRun(runId,false);
  return !!row&&row.ownerAdmitted===true&&row.ownerTransport==="admin_admitted"&&row.executionSource==="gateway"&&
    row.sessionKey===sessionKey&&row.state==="running"&&row.gatewayObservation?.epoch===GATEWAY_OBSERVER_EPOCH&&
    row.gatewayObservation.state==="following"&&Date.now()<row.gatewayObservation.deadlineAt;
}
/** Same admitted run and session throughout. Incoming JSON/HTTP cannot create this callback. */
export async function observeGatewayRun(runId:string,sessionKey:string):Promise<OwnerTurnObserver> {
  const started=await updateObservedRun(runId,stored=>{
    if(stored.gatewayObservation?.epoch===GATEWAY_OBSERVER_EPOCH&&stored.gatewayObservation.state==="following")throw Error("gateway_observation_already_following");
    const active=[...submittedRuns.values()].filter(r=>r.gatewayObservation?.epoch===GATEWAY_OBSERVER_EPOCH&&
      r.gatewayObservation.state==="following"&&!["done","failed"].includes(r.state||"")&&Date.now()<r.gatewayObservation.deadlineAt).length;
    if(active>=8)throw Error("gateway_observation_capacity");
    if(!stored.ownerAdmitted||stored.executionSource!=="gateway"||stored.sessionKey!==sessionKey||["done","failed"].includes(stored.state||""))return undefined;
    return {...stored,gatewayObservation:{version:1,epoch:GATEWAY_OBSERVER_EPOCH,state:"following",deadlineAt:Date.now()+GATEWAY_FOLLOW_MS}};
  });
  if(!started?.gatewayObservation||started.gatewayObservation.epoch!==GATEWAY_OBSERVER_EPOCH)throw Error("gateway_observation_not_admitted");
  let sequence=0,closed=false,queued=0,cardQueued=false,chain=Promise.resolve();
  // A provider burst cannot create an unbounded promise/write queue. Dropped progress is never terminal proof.
  const enqueue=(work:()=>Promise<void>)=>{
    if(queued>=48)return;
    queued++;
    chain=chain.then(work).catch(()=>{}).finally(()=>{queued--;});
  };
  const bound=(r:StoredRun)=>r.sessionKey===sessionKey&&r.gatewayObservation?.epoch===GATEWAY_OBSERVER_EPOCH&&r.gatewayObservation.state==="following";
  const lost=async(requestSent:boolean)=>{
    closed=true;await chain;
    await updateObservedRun(runId,r=>bound(r)?{...r,state:requestSent?"unknown":r.state,...(requestSent?{error:"Le résultat de cette demande reste à vérifier ; aucune relance automatique."}:{}),...(requestSent?{ownerTransport:"admin_admitted" as const}:{}),
      gatewayObservation:{...r.gatewayObservation!,state:"reconcile"}}:undefined);
  };
  return {
    sent(){enqueue(async()=>{await updateObservedRun(runId,r=>bound(r)?{...r,ownerTransport:"admin_admitted"}:undefined);});},
    event(frame:any){
      if(closed||frame?.event!=="agent")return;
      const p=frame.payload;
      if(p?.runId!==runId||p.sessionKey!==sessionKey||!Number.isSafeInteger(p.seq)||p.seq<=sequence)return;
      sequence=p.seq;
      // A card is refreshed only after its actual writer completed, never once per status poll.
      const data=p.data,id=data?.toolCallId;
      if(p.stream==="tool"&&data?.name==="progress_card"&&data?.phase==="result") {
        if(cardQueued||queued>=48)return;
        cardQueued=true;
        enqueue(async()=>{try {
          progressCardCache.delete(sessionKey);
          const card=await readRunProgressCard(sessionKey,started.acceptedAt);
          if(card)await updateObservedRun(runId,r=>bound(r)?{...r,gatewayProgress:withProgressCard(r.gatewayProgress,card)}:undefined);
        } finally {cardQueued=false;}});
        return;
      }
      // Only titled tool boundaries are progress. Assistant deltas never become facts or terminal success.
      const title=cardText(data?.args?.title,160);
      if(p.stream!=="tool"||!["start","result"].includes(data?.phase)||typeof id!=="string"||
        !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)||data.phase==="start"&&(!title||isTechnicalProgressLabel(title)))return;
      enqueue(async()=>{await updateObservedRun(runId,r=>{
        if(!bound(r))return undefined;
        const events=r.gatewayProgress?.events||[],old=events.find(e=>e.callId===id);
        const label=title||old?.label;if(!label)return undefined;
        return {...r,gatewayProgress:{...r.gatewayProgress,text:"",events:[...events,{type:data.phase==="start"?"tool.call":data.isError?"tool.error":"tool.result",callId:id,label,title:label,at:Date.now(),...(data.isError?{isError:true}:{})}].slice(-48)}};
      });});
    },
    async final(value:unknown){
      closed=true;await chain;
      const terminal=gatewayTerminalResult(value,runId);
      if(!terminal){await lost(true);return;}
      await updateObservedRun(runId,r=>r.sessionKey===sessionKey&&r.gatewayObservation?.epoch===GATEWAY_OBSERVER_EPOCH&&
        ["following","reconcile"].includes(r.gatewayObservation.state)&&!["done","failed"].includes(r.state||"")?{...r,state:terminal.state,result:terminal.state==="done"?terminal.text:undefined,error:terminal.state==="failed"?terminal.text:undefined,updatedAt:Date.now(),ownerTransport:"admin_admitted",
        gatewayObservation:{...r.gatewayObservation!,state:"settled"}}:undefined);
    },lost,
  };
}
async function reconcileObservedRun(stored:StoredRun):Promise<CompanionRunStatus> {
  let flight=listEnrichments.get(stored.runId);
  if(flight)return beforeDeadline(flight,Date.now()+1500,observedRunStatus(stored));
  const observed=stored.gatewayObservation!;
  if(observed.epoch===GATEWAY_OBSERVER_EPOCH&&observed.reconciled)return observedRunStatus(stored);
  // Persist the claim before yielding; repeated polls and restart recovery cannot fan out.
  const claimed=await updateObservedRun(stored.runId,r=>{
    if(r.gatewayObservation?.epoch===GATEWAY_OBSERVER_EPOCH&&r.gatewayObservation.reconciled)return undefined;
    return {...r,state:["done","failed"].includes(r.state||"")?r.state:"unknown",
      error:r.error||"Le résultat de cette demande reste à vérifier ; aucune relance automatique.",
      gatewayObservation:{...r.gatewayObservation!,epoch:GATEWAY_OBSERVER_EPOCH,state:"reconcile",reconciled:true}};
  });
  if(!claimed)return observedRunStatus((await findStoredRun(stored.runId,false))||stored);
  flight=(async()=>{
    const deadline=Date.now()+LIST_OWNER_READ_MS;
    const sessions=await readSessionsIndex(deadline,claimed.sessionKey);
    const session=findSessionForStoredRun(sessions,claimed);
    if(!session)return observedRunStatus(claimed);
    const remaining=deadline-Date.now();
    if(remaining<=0)return observedRunStatus(claimed);
    const history=await callOpenClawGateway("chat.history",{sessionKey:claimed.sessionKey,limit:200},{timeoutMs:remaining,hardTimeoutMs:remaining});
    // Reuse the existing conservative owner proof, including unique prompt, freshness and completed tools.
    const proof=ownerTurnEvidence(history?.messages,claimed.text,Date.now());
    if(!proof||proof.outstandingTool||Math.abs(proof.startedAt-claimed.acceptedAt)>30000)return observedRunStatus(claimed);
    const registry=await registryOrEmpty();
    if(registry.runs.filter(r=>r.modality!=="voice"&&r.sessionKey===claimed.sessionKey&&r.text===claimed.text).length!==1)return observedRunStatus(claimed);
    const terminal=terminalConversationResult(proof.messages.map(message=>JSON.stringify({type:"message",message})).join("\n"),claimed.text);
    if(!terminal||terminal.result.length>32768||terminal.result.includes("NO_REPLY")||
      !terminal.endedAt||terminal.endedAt<proof.startedAt||terminal.endedAt>Date.now())return observedRunStatus(claimed);
    const settled=await updateObservedRun(claimed.runId,r=>runIdentity(r)===runIdentity(claimed)&&r.gatewayObservation?.state==="reconcile"?
      {...r,state:"done",result:terminal.result,error:undefined,updatedAt:terminal.endedAt||proof.lastAt,
        gatewayObservation:{...r.gatewayObservation,state:"settled"}}:undefined);
    return observedRunStatus(settled||claimed);
  })().catch(()=>observedRunStatus(claimed)).finally(()=>listEnrichments.delete(stored.runId));
  listEnrichments.set(stored.runId,flight);
  return beforeDeadline(flight,Date.now()+1500,observedRunStatus(claimed));
}

export async function settleSubmittedRun(
  runId: string,
  state: "done" | "failed" | "unknown",
  result: string,
  options: {provenance?: unknown; presentation?: unknown; reasonClass?: unknown; web?: unknown} = {},
) {
  const existing = submittedRuns.get(runId)
    || (await findStoredRun(runId).catch(() => null));
  if (!existing) return;
  const stored: StoredRun = {
    ...existing,
    provenance: capabilityProvenance(options.provenance) || existing.provenance,
    web: readRunWebResult(options.web) || existing.web,
    reasonClass: publicReasonClass(options.reasonClass) || existing.reasonClass,
    state,
    presentation: readReceiptPresentation(options.presentation) || (existing.executionSource === "capability_first" ? fallbackReceiptPresentation(state === "failed") : existing.presentation),
    inactivityCorrectionReceipt: state === "done" && (existing.error === "run_inactivity_expired" || existing.inactivityCorrectionReceipt?.to === "running") ? {
      version: 1, action: "correct_run_expiration", runId, from: "expired", to: "done",
      at: Date.now(), evidenceAt: Date.now(),
    } : existing.inactivityCorrectionReceipt,
    result: state === "done" ? result : undefined,
    error: state !== "done" ? result : undefined,
    updatedAt: Date.now(),
  };
  submittedRuns.set(runId, stored);
  await saveStoredRun(stored).catch(() => undefined);
}

/** Retry only a durably proven pre-effect R16 failure; concurrent claimers cannot redispatch. */
export async function claimFailedApprovalOperation(runId:string,clientRunId:string,identity:string,pendingResult:string):Promise<boolean>{
  if(!/^approval-operation-[a-f0-9]{64}$/.test(clientRunId))return false;
  return mutateRegistry(async()=>{
    const registry=await registryOrEmpty(),row=registry.runs.find(run=>run.runId===runId&&run.clientRunId===clientRunId);
    if(!row||row.text!==identity||row.executionSource!=="capability_first"||row.decision?.capability!=="agent.approval_decide"||row.sessionId!=="native-owner-actions"||row.state!=="done")return false;
    let previous:any,next:any;try{previous=JSON.parse(row.result||"");next=JSON.parse(pendingResult);}catch{return false;}
    if(previous.state!=="failed"||previous.error!=="approval_dispatch_not_started"||previous.receipt?.action!=="agent.approval_decide"||previous.receipt?.state!=="failed"||previous.receipt?.runId!==runId||typeof previous.receipt.operationId!=="string"||"approval-operation-"+createHash("sha256").update(previous.receipt.operationId).digest("hex")!==clientRunId||next.state!=="indeterminate"||next.receipt?.action!=="agent.approval_decide"||next.receipt?.runId!==runId||next.receipt?.targetRunId!==previous.receipt.targetRunId||next.receipt?.operationId!==previous.receipt.operationId||next.receipt?.approvalId!==previous.receipt.approvalId||next.receipt?.decision!==previous.receipt.decision)return false;
    const claimed={...row,result:pendingResult,updatedAt:Date.now()};
    await writeCompanionRunRegistry(registry.runs.map(run=>run.runId===runId?claimed:run),registry.archivedSessionIds,registry.paymentRequests,registry.ownerConfirmations);
    submittedRuns.set(runId,claimed);return true;
  });
}

export async function markSubmittedRunFailed(runId: string, message: string) {
  const existing = submittedRuns.get(runId)
    || (await findStoredRun(runId).catch(() => null));
  if (!existing) return;

  const stored: StoredRun = {
    ...existing,
    state: "failed",
    error: message,
    ...(existing.gatewayObservation ? {gatewayObservation:{...existing.gatewayObservation,state:"settled" as const}} : {}),
    updatedAt: Date.now(),
  };
  submittedRuns.set(runId, stored);
  await saveStoredRun(stored).then(() => {
    if (submittedRuns.has(runId)) runDiagnostic("error", "submitted_run_failed", stored);
  }).catch(() => undefined);
}

/** Local retained-history archive owner. No Gateway transcript deletion. */
export async function conversationArchiveState(sessionId:string):Promise<boolean|null>{
  requireConversationId(sessionId);await registryWrite;
  const registry=await registryOrEmpty();
  if(registry.runs.some(run=>run.sessionId===sessionId&&['accepted','running'].includes(run.state||'')))
    throw Object.assign(new Error('protected_owner_activity'),{statusCode:409});
  return registry.runs.some(run=>run.sessionId===sessionId)?registry.archivedSessionIds.includes(sessionId):null;
}
export async function setConversationArchived(sessionId:string,archived:boolean){
  requireConversationId(sessionId);
  return mutateRegistry(async()=>{
    const registry=await registryOrEmpty();
    if(!registry.runs.some(run=>run.sessionId===sessionId))throw Object.assign(new Error('conversation_not_found'),{statusCode:404,effectNotStarted:true});
    if(sessionId==='native-owner-actions'||registry.runs.some(run=>run.sessionId===sessionId&&['accepted','running'].includes(run.state||''))||
      registry.paymentRequests.some(row=>['awaiting_owner','executing','effect_unknown','requires_bank_action'].includes(row.state))||
      registry.ownerConfirmations.some(row=>row.state==='awaiting_owner'&&row.expiresAt>Date.now()))
      throw Object.assign(new Error('protected_owner_activity'),{statusCode:409,effectNotStarted:true});
    const before=registry.archivedSessionIds.includes(sessionId);
    if(before!==archived){
      const next=archived?[...registry.archivedSessionIds,sessionId]:registry.archivedSessionIds.filter(id=>id!==sessionId);
      await writeCompanionRunRegistry(registry.runs,next,registry.paymentRequests,registry.ownerConfirmations,registry.runDeletions);
    }
    return {sessionId,archived,changed:before!==archived};
  });
}

export async function archiveSession(sessionId: string) {
  return mutateRegistry(async () => {
  const normalizedSessionId = normalizeCompanionSessionId(sessionId || "");
  if (!normalizedSessionId) {
    return {
      success: false,
      message: "Session id is required.",
      sessionId: normalizedSessionId,
    };
  }

  const registry = await registryOrEmpty();
  const archivedSessionIds = Array.from(new Set([
    ...registry.archivedSessionIds,
    normalizedSessionId,
  ]));
  await writeCompanionRunRegistry(registry.runs, archivedSessionIds);

  return {
    success: true,
    message: "Session archived.",
    sessionId: normalizedSessionId,
  };
  });
}

export async function deleteSession(sessionId: string) {
  return mutateRegistry(async () => {
  const normalizedSessionId = normalizeCompanionSessionId(sessionId || "");
  if (!normalizedSessionId) {
    return {
      success: false,
      message: "Session id is required.",
      sessionId: normalizedSessionId,
    };
  }

  const registry = await registryOrEmpty();
  const nextRuns = registry.runs.filter((run) => normalizeCompanionSessionId(run.sessionId || "default") !== normalizedSessionId);
  const archivedSessionIds = Array.from(new Set([
    ...registry.archivedSessionIds.filter((id) => id !== normalizedSessionId),
    normalizedSessionId,
  ]));
  let removedRuns = 0;
  for (const [runId, run] of submittedRuns.entries()) {
    if (normalizeCompanionSessionId(run.sessionId || "default") === normalizedSessionId) {
      submittedRuns.delete(runId);
      removedRuns += 1;
    }
  }
  removedRuns += registry.runs.length - nextRuns.length;
  const memoDeletions: RunDeletionReceipt[] = registry.runs.filter(run => run.memo &&
    normalizeCompanionSessionId(run.sessionId) === normalizedSessionId).map(run => ({
      version: 1, operationId: "memo-session-delete-" + run.runId, runId: run.runId,
      clientRunId: run.clientRunId, sessionId: run.sessionId, action: "delete_run", state: "completed", at: Date.now(),
      attachmentPaths: (run.attachments || []).map(a => a.serverPath || a.path || ""),
    }));
  await writeCompanionRunRegistry(nextRuns, archivedSessionIds, registry.paymentRequests,
    registry.ownerConfirmations, [...registry.runDeletions, ...memoDeletions]);
  const memoPaths = [...registry.runDeletions, ...memoDeletions].filter(r => r.sessionId === normalizedSessionId).flatMap(r => r.attachmentPaths || []);
  removeAttachments(memoPaths, new Set(nextRuns.flatMap(r => (r.attachments || []).map(a => a.serverPath || a.path || ""))));

  return {
    success: true,
    message: "Session deleted from companion history.",
    sessionId: normalizedSessionId,
    removedRuns,
  };
  });
}

/** Delete one terminal history item; never cancels work or removes canonical payment receipts. */
const RUN_DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_DELETION_LIMIT = 1000;
function retainedRunDeletions(rows: RunDeletionReceipt[], now = Date.now()): RunDeletionReceipt[] {
  return rows.filter(row => now - row.at <= RUN_DELETION_RETENTION_MS)
    .sort((left,right) => left.at-right.at).slice(-RUN_DELETION_LIMIT);
}
function parseRunDeletions(value: unknown): RunDeletionReceipt[] {
  if (value === undefined) return [];
  const rows = Array.isArray(value) ? value : [];
  const operations = new Set<string>();
  let invalid = Array.isArray(value) ? 0 : 1;
  const valid: RunDeletionReceipt[] = [];
  for (const row of rows) {
    if (!row || row.version !== 1 || typeof row.operationId !== "string" || !CLIENT_RUN_ID_RE.test(row.operationId) ||
        typeof row.runId !== "string" || !CLIENT_RUN_ID_RE.test(row.runId) || typeof row.sessionId !== "string" ||
        (row.clientRunId !== undefined && (typeof row.clientRunId !== "string" || !CLIENT_RUN_ID_RE.test(row.clientRunId))) ||
        (row.attachmentPaths!==undefined&&(!Array.isArray(row.attachmentPaths)||row.attachmentPaths.some((x:unknown)=>typeof x!=="string"))) ||
        row.action !== "delete_run" || row.state !== "completed" || !Number.isFinite(row.at) || row.at < 0 || operations.has(row.operationId)) {
      invalid++; continue;
    }
    operations.add(row.operationId); valid.push(row);
  }
  if (invalid) runDiagnostic("warn", "invalid_run_deletion_receipts_ignored", undefined, invalid);
  return retainedRunDeletions(valid);
}

export async function deleteRun(runId: string, operationId: string) {
  if (typeof runId !== "string" || !CLIENT_RUN_ID_RE.test(runId) ||
      typeof operationId !== "string" || !CLIENT_RUN_ID_RE.test(operationId))
    throw Object.assign(new Error("invalid_run_deletion"), {statusCode: 400});
  return mutateRegistry(async () => {
    const registry = await registryOrEmpty();
    const old = registry.runDeletions.find(row => row.operationId === operationId);
    if (old) {
      if (old.runId !== runId) throw Object.assign(new Error("operation_id_conflict"), {statusCode: 409});
      removeAttachments(old.attachmentPaths||[],new Set(registry.runs.flatMap(row=>(row.attachments||[]).map(x=>x.serverPath||x.path||""))));
      return {success: true, state: "completed", receipt: old};
    }
    const deleted = registry.runDeletions.find(row => row.runId === runId);
    if (deleted) {removeAttachments(deleted.attachmentPaths||[],new Set(registry.runs.flatMap(row=>(row.attachments||[]).map(x=>x.serverPath||x.path||""))));return {success: true, state: "completed", receipt: deleted};}
    const run = registry.runs.find(row => row.runId === runId);
    if (!run) return {success: false, state: "not_found", receipt: null};
    const matches = (value: unknown) => typeof value === "string" && [run.runId, run.clientRunId, run.sessionId].includes(value);
    if ([run.decision?.capability, run.decision?.capability_id].some(value => String(value || "").startsWith("payment.")) ||
        registry.paymentRequests.some(row => matches(row.draft?.origin?.id)) ||
        registry.ownerConfirmations.some(row => matches(row.intent?.origin?.id)))
      throw Object.assign(new Error("protected_run"), {statusCode: 409});
    if (run.modality === "voice" ? !["completed", "interrupted"].includes(run.transcriptState || "") : !["done", "failed"].includes(run.state || ""))
      throw Object.assign(new Error("run_not_terminal"), {statusCode: 409});
    const receipt: RunDeletionReceipt = {version: 1, operationId, runId, clientRunId: run.clientRunId,
      sessionId: run.sessionId, action: "delete_run", state: "completed", at: Date.now(), attachmentPaths:(run.attachments||[]).map(x=>x.serverPath||x.path||"")};
    const nextRuns = registry.runs.filter(row => row.runId !== runId);
    const archived = nextRuns.some(row => row.sessionId === run.sessionId) ? registry.archivedSessionIds
      : Array.from(new Set([...registry.archivedSessionIds, run.sessionId]));
    await writeCompanionRunRegistry(nextRuns, archived, registry.paymentRequests, registry.ownerConfirmations, [...registry.runDeletions, receipt]);
    submittedRuns.delete(runId);
    removeAttachments(receipt.attachmentPaths||[],new Set(nextRuns.flatMap(row=>(row.attachments||[]).map(x=>x.serverPath||x.path||""))));
    return {success: true, state: "completed", receipt};
  });
}

export async function listRunSummaries(options: { limit?: number } = {}): Promise<CompanionRunStatus[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
  const storedRuns = await readStoredRuns();
  if (storedRuns.length > 0) {
    return storedRuns.slice(0, limit).map((stored) => withNotification(statusFromStoredRun(stored)));
  }
  // Legacy/no-registry fallback only. Normal Samantha history uses the existing registry and avoids
  // sessions.list, transcript and trajectory enrichment on every visible list refresh.
  return (await listRuns({ limit })).map(withNotification);
}

// F4: the Notifications screen reads this summary list; `result` is kept verbatim.
function withNotification(status: CompanionRunStatus): CompanionRunStatus {
  const {web: _detail, ...summary} = status;
  return { ...summary, notification: structuredNotification(status.result, status.userText) };
}

const LIST_LIVE_REFRESH_MAX=3;
/**
 * One budget for the whole live part of a list, counted from the request (11/10: `/runs?limit=50` took 3.82 s for
 * 4 s on the S24 because the unbounded `sessions.list` CLI read, 1.6 to 4.3 s there since the SQLite migration
 * removed sessions.json, came before a separate 2.5 s transcript budget). Reads that miss it keep running in
 * single-flight behind the answer: the sessions index is reused [LIST_SESSIONS_TTL_MS] and a transcript that
 * completes persists its result for the next poll. Each background read keeps the owner 5.5 s bound.
 */
const LIST_LIVE_REFRESH_BUDGET_MS=1500;
const LIST_SESSIONS_TTL_MS=10000;
const LIST_OWNER_READ_MS=5500;
let listSessions:{at:number;value:any[]}|undefined;
let listSessionsRead:Promise<any[]>|undefined;
const listEnrichments=new Map<string,Promise<CompanionRunStatus>>();
function readListSessions(visible:StoredRun[]):Promise<any[]>{
  const cached=listSessions;
  const complete=!!cached&&Date.now()-cached.at<LIST_SESSIONS_TTL_MS&&visible.every(run=>!requiresLiveRefresh(run)||findSessionForStoredRun(cached.value,run));
  if(complete)return Promise.resolve(cached!.value);
  if(!listSessionsRead){
    listSessionsRead=readSessionsIndex(Date.now()+LIST_OWNER_READ_MS)
      .then(value=>{listSessions={at:Date.now(),value};return value;})
      .finally(()=>{listSessionsRead=undefined;});
    // A background re-read may have no awaiting request: its failure is never an unhandled rejection.
    listSessionsRead.catch(()=>undefined);
  }
  // A session missing from a young index is re-read, but the index already held still answers this request.
  return cached?Promise.resolve(cached.value):listSessionsRead;
}
function beforeDeadline<T>(work:Promise<T>,deadline:number,fallback:T):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const late=new Promise<T>(resolve=>{timer=setTimeout(()=>resolve(fallback),Math.max(0,deadline-Date.now()));timer.unref?.();});
  return Promise.race([work.catch(()=>fallback),late]).finally(()=>clearTimeout(timer));
}
function enrichListedRun(fallback:CompanionRunStatus,session:any,stored:StoredRun):Promise<CompanionRunStatus>{
  let read=listEnrichments.get(stored.runId);
  if(!read){
    read=enrichFromSessionFile(fallback,session,stored,true,Date.now()+LIST_OWNER_READ_MS).catch(()=>fallback)
      .finally(()=>{listEnrichments.delete(stored.runId);});
    listEnrichments.set(stored.runId,read);
  }
  return read;
}

export async function listRuns(options: { limit?: number } = {}): Promise<CompanionRunStatus[]> {
  const deadline=Date.now()+LIST_LIVE_REFRESH_BUDGET_MS;
  const storedRuns = await readStoredRuns(false);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
  reconcileInactiveRuns();
  if(storedRuns.length){
    const visible=storedRuns.slice(0,limit);
    const sessions=visible.some(requiresLiveRefresh)?await beforeDeadline(readListSessions(visible),deadline,[] as any[]):[];
    // Each transcript read is one `openclaw gateway call` process on the S24 (~2.4 s): a list refreshes at most
    // LIST_LIVE_REFRESH_MAX runs (newest first), one read per run in flight, within the list budget.
    let refreshes=LIST_LIVE_REFRESH_MAX;
    return Promise.all(visible.map(async stored=>withOwnerFields(await listedRun(stored),stored)));
    async function listedRun(stored:StoredRun):Promise<CompanionRunStatus>{
      if(!requiresLiveRefresh(stored))return statusFromStoredRun(stored);
      const session=findSessionForStoredRun(sessions,stored);
      const fallback=session?statusFromSessionInfo(session,stored.runId,stored):statusFromStoredRun(stored);
      if(refreshes<=0||!session)return fallback;
      refreshes--;
      return beforeDeadline(enrichListedRun(fallback,session,stored),deadline,fallback);
    }
  }
  // Legacy discovery only when no retained snapshot exists.
  const sessions=await readSessionsIndex().catch(()=>[]);
  const archivedSessionIds=await readArchivedSessionIds();

  return Promise.all(
    sessions
      .filter((session: any) => isCompanionSession(session))
      .filter((session: any) => !archivedSessionIds.has(companionSessionIdFromSession(session)))
      .slice(0, limit)
      .map(async (session: any) => {
      const fallback = statusFromSessionInfo(session);
      return enrichFromSessionFile(fallback, session, undefined, false);
    }),
  );
}

/**
 * SAM-MIG V2.2: the run registry is no longer an authority of clarification. A run only PROJECTS the question
 * owned by the dialogue coordinator (display, comprehension metrics). These helpers link and update that
 * projection; nothing reads it to decide (INV-01).
 */
export const CLARIFICATION_PROJECTION_MS = 30 * 60 * 1000; // D-D: question 30 min
const DIALOGUE_GOAL_RE = /^goal-[a-f0-9]{20}$/;
export function dialogueGoalRefOf(value: unknown): string | undefined {
  return typeof value === "string" && DIALOGUE_GOAL_RE.test(value) ? value : undefined;
}

export async function findClarificationProjectionRun(sessionId: string, goalRef: unknown): Promise<string | undefined> {
  const goal = dialogueGoalRefOf(goalRef);
  if (!goal) return undefined;
  const normalizedSessionId = normalizeCompanionSessionId(sessionId || "default");
  const runs = await readStoredRuns();
  return runs.find((run) => run.sessionId === normalizedSessionId && run.dialogueGoalRef === goal && run.clarificationState === "pending")?.runId;
}

export async function projectClarificationRun(
  runId: string, state: "resolved" | "abandoned",
): Promise<void> {
  const existing = submittedRuns.get(runId) || (await findStoredRun(runId).catch(() => null));
  if (!existing || existing.clarificationState !== "pending") return;
  const stored: StoredRun = {
    ...existing, clarificationState: state, clarificationExpiresAt: undefined, updatedAt: Date.now(),
  };
  submittedRuns.set(runId, stored);
  await saveStoredRun(stored);
}

/** 38 A2 : run lu pour « Ce n'est pas ça » (texte et décision v2 restent côté serveur, jamais renvoyés). */
export async function readRunForCorrection(runId: string): Promise<{
  runId: string; text: string; userText: string; decision?: Record<string, unknown>; notThis?: RunCorrection;
} | null> {
  const run = await findStoredRun(runId, false);
  if (!run) return null;
  return {runId: run.runId, text: run.text, userText: run.userText || run.text, decision: run.decision, notThis: run.notThis};
}

/** Pose la trace une seule fois ; une trace existante gagne (idempotence par run). */
export async function markRunNotThis(runId: string, correction: RunCorrection): Promise<RunCorrection> {
  const checked = validRunCorrection(correction);
  if (!checked) throw Object.assign(new Error("invalid_run_correction"), {statusCode: 400});
  const existing = await findStoredRun(runId, false);
  if (!existing) throw Object.assign(new Error("run_not_found"), {statusCode: 404});
  if (existing.notThis) return existing.notThis;
  await saveStoredRun({...existing, notThis: checked, updatedAt: Date.now()});
  return checked;
}

const NATIVE_CLOCK_EPOCH=randomUUID();
const nativeMono=()=>Number(process.hrtime.bigint()/1000000n);
function nativeTurnMetadata(v:any):StoredRun["nativeTurn"]{
  if(!v||v.version!==1||!Number.isFinite(v.deadlineAt)||!Number.isFinite(v.startedMono)||typeof v.clockEpoch!=="string"||
    !["pending","attempted","accepted","uncertain","cancelled"].includes(v.notice)||
    (v.route!==null&&!["tool","question","answer","reflex"].includes(v.route)))return undefined;
  return {version:1,deadlineAt:v.deadlineAt,startedMono:v.startedMono,clockEpoch:v.clockEpoch,notice:v.notice,
    ...(v.ingressPending===true?{ingressPending:true as const}:{}),
    ...(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v.adoptedByRunId||'')?{adoptedByRunId:v.adoptedByRunId}:{}),
    ...(Number.isSafeInteger(v.adoptedMono)&&v.adoptedMono>=0?{adoptedMono:v.adoptedMono}:{}),
    ...(typeof v.accountId==="string"&&/^[A-Za-z0-9_.-]{1,80}$/.test(v.accountId)?{accountId:v.accountId}:{}),
    ...(v.ended===true?{ended:true}:{}),...(Number.isSafeInteger(v.deliveredMono)&&v.deliveredMono>=v.startedMono?{deliveredMono:v.deliveredMono}:{}),route:v.route,
    ...(typeof v.model==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(v.model)?{model:v.model}:{}),
    decisionMs:Number.isSafeInteger(v.decisionMs)&&v.decisionMs>=0&&v.decisionMs<=600000?v.decisionMs:null,
    toolMs:Number.isSafeInteger(v.toolMs)&&v.toolMs>=0&&v.toolMs<=600000?v.toolMs:null};
}
export async function recordNativeWhatsAppIngress(runId:string,sessionKey:string,accountId?:string,observedMonoMs?:number){
  const mono=nativeMono();
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId)||!/^agent:main:whatsapp:direct:\+?[1-9][0-9]{7,14}$/.test(sessionKey)||
    accountId!==undefined&&(typeof accountId!=="string"||!/^[A-Za-z0-9_.-]{1,80}$/.test(accountId))||!Number.isSafeInteger(observedMonoMs)||observedMonoMs! < 0||observedMonoMs! > mono||mono-observedMonoMs! > 600000)
    throw Object.assign(Error("invalid_turn_measurement"),{statusCode:400});
  const observed=await mutateRegistry(async()=>{
    const registry=await registryOrEmpty(),existing=registry.runs.find(r=>r.runId===runId);
    if(existing){
      if(!existing.measurementOnly||existing.sessionKey!==sessionKey||existing.nativeTurn?.accountId&&accountId&&existing.nativeTurn.accountId!==accountId)
        throw Object.assign(Error("turn_measurement_identity_conflict"),{statusCode:409});
      if(existing.nativeTurn?.ingressPending&&existing.nativeTurn.clockEpoch===NATIVE_CLOCK_EPOCH){
        const now=Date.now(),nativeTurn={...existing.nativeTurn,ingressPending:undefined,startedMono:observedMonoMs!,
          deadlineAt:now+TURN_BUDGET_MS-(mono-observedMonoMs!),
          notice:!existing.nativeTurn.ended&&!existing.nativeTurn.adoptedByRunId?"pending" as const:existing.nativeTurn.notice,
          ...(accountId?{accountId}:{})};
        const updated:StoredRun={...existing,nativeTurn,acceptedAt:now-(mono-observedMonoMs!),updatedAt:now,
          state:existing.nativeTurn.ended?existing.state:"running"};
        await writeCompanionRunRegistry(registry.runs.map(r=>r.runId===runId?updated:r),registry.archivedSessionIds,registry.paymentRequests,registry.ownerConfirmations,registry.runDeletions);
        return nativeTurn;
      }
      if(accountId&&existing.nativeTurn&&!existing.nativeTurn.accountId&&existing.nativeTurn.clockEpoch===NATIVE_CLOCK_EPOCH){
        const nativeTurn={...existing.nativeTurn,accountId};
        await writeCompanionRunRegistry(registry.runs.map(r=>r.runId===runId?{...r,nativeTurn}:r),registry.archivedSessionIds,registry.paymentRequests,registry.ownerConfirmations,registry.runDeletions);
        return nativeTurn;
      }
      return existing.nativeTurn;
    }
    const now=Date.now();const row:StoredRun={runId,sessionKey,sessionId:"whatsapp-"+createHash("sha256").update(sessionKey).digest("hex").slice(0,24),
      executionSource:"gateway",text:"",acceptedAt:now-(mono-observedMonoMs!),updatedAt:now,state:"running",turnSurface:"whatsapp",measurementOnly:true,
      nativeTurn:{version:1,deadlineAt:now+TURN_BUDGET_MS-(mono-observedMonoMs!),clockEpoch:NATIVE_CLOCK_EPOCH,startedMono:observedMonoMs!,notice:"pending",route:null,
        decisionMs:null,toolMs:null,...(accountId?{accountId}:{})}};
    await writeCompanionRunRegistry([row,...registry.runs],registry.archivedSessionIds,registry.paymentRequests,registry.ownerConfirmations,registry.runDeletions);
    return row.nativeTurn;
  });
  await finalizeNativeBindingMeasurements(runId);
  return observed;
}
export async function nativeTurnProgressState(runId:string){
  const row=(await registryOrEmpty()).runs.find(r=>r.runId===runId&&r.measurementOnly);
  return row?.nativeTurn?{runId,sessionId:row.sessionId,sessionKey:row.sessionKey!,state:row.state,ended:row.nativeTurn.ended,
    clockEpoch:row.nativeTurn.clockEpoch,deadlineAt:row.nativeTurn.deadlineAt,notice:row.nativeTurn.notice,accountId:row.nativeTurn.accountId,
    ingressPending:row.nativeTurn.ingressPending,adoptedByRunId:row.nativeTurn.adoptedByRunId}:null;
}
/** deadlineAt is 10-minute observation freshness, separate from the stored 30-second delivery budget.
 * Positive observation only: one exact-session live turn in this owner's clock epoch, never the latest turn. */
export async function activeObservedNativeWhatsAppRun(sessionKey:string,options:{excludeRunId?:string}={}){
  const now=nativeMono();
  const candidates=(await registryOrEmpty()).runs.filter(r=>r.measurementOnly&&r.sessionKey===sessionKey&&r.runId!==options.excludeRunId&&
    r.state==="running"&&r.nativeTurn&&!r.nativeTurn.ingressPending&&!r.nativeTurn.adoptedByRunId&&!r.nativeTurn.ended&&r.nativeTurn.clockEpoch===NATIVE_CLOCK_EPOCH&&
    now>=r.nativeTurn.startedMono&&now-r.nativeTurn.startedMono<=600000);
  if(candidates.length!==1)return null;
  const row=candidates[0];return {runId:row.runId,sessionKey:row.sessionKey!,clockEpoch:row.nativeTurn!.clockEpoch,
    deadlineAt:Date.now()+Math.max(0,600000-(now-row.nativeTurn!.startedMono)),state:"running" as const,observationSource:"companion_native_turn_owner" as const};
}
export async function reserveNativeProgressNotice(runId:string){
  return mutateRegistry(async()=>{
    const registry=await registryOrEmpty(),row=registry.runs.find(r=>r.runId===runId&&r.measurementOnly);
    if(!row?.nativeTurn||row.state!=="running"||row.nativeTurn.ended||row.nativeTurn.ingressPending||row.nativeTurn.adoptedByRunId||row.nativeTurn.notice!=="pending"||
      row.nativeTurn.clockEpoch!==NATIVE_CLOCK_EPOCH||nativeMono()-row.nativeTurn.startedMono<TURN_BUDGET_MS||nativeMono()-row.nativeTurn.startedMono>600000)return false;
    const updated={...row,nativeTurn:{...row.nativeTurn,notice:"attempted" as const}};
    await writeCompanionRunRegistry(registry.runs.map(r=>r.runId===runId?updated:r),registry.archivedSessionIds,registry.paymentRequests,registry.ownerConfirmations,registry.runDeletions);
    return true;
  });
}
export async function settleNativeProgressNotice(runId:string,state:"accepted"|"uncertain"){
  await mutateRegistry(async()=>{const registry=await registryOrEmpty(),row=registry.runs.find(r=>r.runId===runId&&r.measurementOnly);
    if(!row?.nativeTurn||row.nativeTurn.notice!=="attempted")return;
    const updated={...row,nativeTurn:{...row.nativeTurn,notice:state}};
    await writeCompanionRunRegistry(registry.runs.map(r=>r.runId===runId?updated:r),registry.archivedSessionIds,registry.paymentRequests,registry.ownerConfirmations,registry.runDeletions);
  });
}
/** Out-of-order callback placeholders stay in the same bounded ledger and are never active evidence. */
function pendingNativeObservation(runId:string,sessionKey:string,mono:number):StoredRun {
  return {runId,sessionKey,sessionId:"whatsapp-"+createHash("sha256").update(sessionKey).digest("hex").slice(0,24),
    executionSource:"gateway",text:"",acceptedAt:Date.now(),updatedAt:Date.now(),state:"unknown",turnSurface:"whatsapp",measurementOnly:true,
    nativeTurn:{version:1,deadlineAt:Date.now()+600000,clockEpoch:NATIVE_CLOCK_EPOCH,startedMono:mono,ingressPending:true,
      notice:"cancelled",route:null,decisionMs:null,toolMs:null}};
}
function requireNativeObservationIdentity(runId:string,sessionKey:string){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId)||
    !/^agent:main:whatsapp:direct:\+?[1-9][0-9]{7,14}$/.test(sessionKey))throw Object.assign(Error("invalid_turn_measurement"),{statusCode:400});
}
export async function observeNativeTurnAdoption(runId:string,sessionKey:string,targetRunId:string,observedMonoMs:number){
  requireNativeObservationIdentity(runId,sessionKey);requireNativeObservationIdentity(targetRunId,sessionKey);
  const mono=nativeMono();
  if(runId===targetRunId||!Number.isSafeInteger(observedMonoMs)||observedMonoMs<0||observedMonoMs>mono||mono-observedMonoMs>10000)
    throw Object.assign(Error("invalid_turn_measurement"),{statusCode:400});
  await mutateRegistry(async()=>{
    const registry=await registryOrEmpty(),existing=registry.runs.find(r=>r.runId===runId),target=registry.runs.find(r=>r.runId===targetRunId);
    const row=existing||pendingNativeObservation(runId,sessionKey,observedMonoMs);
    if(!row.measurementOnly||row.sessionKey!==sessionKey||!row.nativeTurn||row.nativeTurn.clockEpoch!==NATIVE_CLOCK_EPOCH||
      row.nativeTurn.adoptedByRunId&&row.nativeTurn.adoptedByRunId!==targetRunId||target&&(!target.measurementOnly||target.sessionKey!==sessionKey||!target.nativeTurn||target.nativeTurn.clockEpoch!==NATIVE_CLOCK_EPOCH||target.nativeTurn.adoptedByRunId||mono-target.nativeTurn.startedMono>600000))
      throw Object.assign(Error("turn_measurement_identity_conflict"),{statusCode:409});
    // Never extend freshness or reopen a terminal row. A duplicate keeps the first binding timestamp.
    if(mono-row.nativeTurn.startedMono>600000)throw Object.assign(Error("turn_measurement_identity_conflict"),{statusCode:409});
    const ended=target?.nativeTurn?.clockEpoch===NATIVE_CLOCK_EPOCH&&target.nativeTurn.ended===true;
    const updated:StoredRun={...row,updatedAt:Date.now(),...(ended?{state:target!.state}:{}),nativeTurn:{...row.nativeTurn,
      adoptedByRunId:targetRunId,adoptedMono:row.nativeTurn.adoptedMono??observedMonoMs,
      notice:row.nativeTurn.notice==="pending"?"cancelled":row.nativeTurn.notice,
      ...(target?.nativeTurn?.deliveredMono!==undefined?{deliveredMono:target.nativeTurn.deliveredMono}:{}),
      ...(target?.nativeTurn?.model?{model:target.nativeTurn.model}:{}),...(ended?{ended:true}:{})}};
    const rows=existing?registry.runs.map(r=>r.runId===runId?updated:r):[updated,...registry.runs];
    await writeCompanionRunRegistry(rows,registry.archivedSessionIds,registry.paymentRequests,registry.ownerConfirmations,registry.runDeletions);
  });
  await finalizeNativeBindingMeasurements(runId);
}
export async function observeNativeTurnEnd(runId:string,model:string|undefined,success:boolean,sessionKey?:string){
  const closed=await mutateRegistry(async()=>{
    const registry=await registryOrEmpty(),existing=registry.runs.find(r=>r.runId===runId);
    if(!existing&&!sessionKey)return [] as string[];
    if(sessionKey)requireNativeObservationIdentity(runId,sessionKey);
    const row=existing||pendingNativeObservation(runId,sessionKey!,nativeMono());
    if(!row.measurementOnly||!row.nativeTurn||sessionKey&&row.sessionKey!==sessionKey)throw Object.assign(Error("turn_measurement_identity_conflict"),{statusCode:409});
    if(row.nativeTurn.clockEpoch!==NATIVE_CLOCK_EPOCH||row.nativeTurn.ended)return [] as string[];
    const settle=(r:StoredRun):StoredRun=>({...r,state:success?"done":"failed",updatedAt:Date.now(),nativeTurn:{...r.nativeTurn!,ended:true,
      notice:r.nativeTurn!.notice==="pending"?"cancelled":r.nativeTurn!.notice,
      ...(model&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)?{model}:{})}});
    const source=existing?registry.runs:[row,...registry.runs];
    const rows=source.map(r=>r.runId===runId||r.measurementOnly&&r.sessionKey===row.sessionKey&&r.nativeTurn?.clockEpoch===NATIVE_CLOCK_EPOCH&&
      r.nativeTurn.adoptedByRunId===runId?settle(r):r);
    await writeCompanionRunRegistry(rows,registry.archivedSessionIds,registry.paymentRequests,registry.ownerConfirmations,registry.runDeletions);
    return rows.filter(r=>r.measurementOnly&&r.sessionKey===row.sessionKey&&r.nativeTurn?.clockEpoch===NATIVE_CLOCK_EPOCH&&
      (r.runId===runId||r.nativeTurn.adoptedByRunId===runId)).map(r=>r.runId);
  });
  await finalizeNativeBindingMeasurements(runId);
  return closed;
}
/** Native SDK stage metadata uses the same atomic writer as finalization and progress reservation. */
export async function observeNativeTurnStage(runId:string,kind:"model"|"tool",durationMs:unknown,model?:string,sessionKey?:string,outcome?:string){
  await mutateRegistry(async()=>{
    if(!sessionKey)return;
    requireNativeObservationIdentity(runId,sessionKey);
    const registry=await registryOrEmpty(),existing=registry.runs.find(r=>r.runId===runId);
    const row=existing||pendingNativeObservation(runId,sessionKey,nativeMono());
    if(!row.measurementOnly||!row.nativeTurn||row.nativeTurn.clockEpoch!==NATIVE_CLOCK_EPOCH||row.nativeTurn.ended||row.nativeTurn.adoptedByRunId||row.sessionKey!==sessionKey)return;
    const native={...row.nativeTurn};
    if(model&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model))native.model=model;
    if(kind==="tool")native.route=["NEEDS_INPUT","NEEDS_CHOICE"].includes(outcome||"")?"question":"tool";
    if(typeof durationMs==="number"&&Number.isSafeInteger(durationMs)&&durationMs>=0&&durationMs<=600000){
      const key=kind==="model"?"decisionMs":"toolMs";
      const sum=(native[key]??0)+durationMs;native[key]=sum<=600000?sum:null;
    }
    const updated:StoredRun={...row,nativeTurn:native};
    await writeCompanionRunRegistry(existing?registry.runs.map(r=>r.runId===runId?updated:r):[updated,...registry.runs],registry.archivedSessionIds,registry.paymentRequests,registry.ownerConfirmations,registry.runDeletions);
  });
}
async function finalizeNativeMeasurement(runId:string){
  const row=(await registryOrEmpty()).runs.find(r=>r.runId===runId&&r.measurementOnly);
  if(!row?.nativeTurn?.ended||row.nativeTurn.ingressPending||row.nativeTurn.deliveredMono===undefined||row.turnMeasurement)return;
  const elapsed=row.nativeTurn.clockEpoch===NATIVE_CLOCK_EPOCH?row.nativeTurn.deliveredMono-row.nativeTurn.startedMono:null;
  const duration=elapsed!==null&&elapsed>=0&&elapsed<=600000?elapsed:null;
  return recordTurnMeasurement(runId,row.sessionId,{version:1,surface:"whatsapp",route:row.nativeTurn.route,
    ...(row.nativeTurn.model?{model:row.nativeTurn.model}:{}),firstSignMs:null,decisionMs:row.nativeTurn.decisionMs,toolMs:row.nativeTurn.toolMs,
    usefulMs:duration,totalMs:duration});
}
async function finalizeNativeBindingMeasurements(runId:string){
  const rows=(await registryOrEmpty()).runs;
  const observed=rows.find(r=>r.runId===runId&&r.measurementOnly&&r.nativeTurn?.clockEpoch===NATIVE_CLOCK_EPOCH);
  if(!observed)return;
  const targetId=observed.nativeTurn!.adoptedByRunId||runId;
  const ids=rows.filter(r=>r.measurementOnly&&r.sessionKey===observed.sessionKey&&r.nativeTurn?.clockEpoch===NATIVE_CLOCK_EPOCH&&
    (r.runId===targetId||r.runId===runId||r.nativeTurn.adoptedByRunId===targetId)).map(r=>r.runId);
  for(const id of ids)await finalizeNativeMeasurement(id);
}
export async function observeNativeTurnDelivery(runId:string,sessionKey?:string,observedMonoMs=nativeMono()){
  const now=nativeMono();
  if(!Number.isSafeInteger(observedMonoMs)||observedMonoMs<0||observedMonoMs>now||now-observedMonoMs>600000)
    throw Object.assign(Error("invalid_turn_measurement"),{statusCode:400});
  await mutateRegistry(async()=>{
    const registry=await registryOrEmpty(),existing=registry.runs.find(r=>r.runId===runId);
    if(!existing&&!sessionKey)return;
    if(sessionKey)requireNativeObservationIdentity(runId,sessionKey);
    const row=existing||pendingNativeObservation(runId,sessionKey!,observedMonoMs);
    if(!row.measurementOnly||!row.nativeTurn||row.nativeTurn.clockEpoch!==NATIVE_CLOCK_EPOCH||sessionKey&&row.sessionKey!==sessionKey)
      throw Object.assign(Error("turn_measurement_identity_conflict"),{statusCode:409});
    // The exact agent run's managed send callback covers only its positively adopted aliases.
    const rows=(existing?registry.runs:[row,...registry.runs]).map(r=>r.measurementOnly&&r.sessionKey===row.sessionKey&&
      r.nativeTurn?.clockEpoch===NATIVE_CLOCK_EPOCH&&(r.runId===runId||r.nativeTurn.adoptedByRunId===runId)&&r.nativeTurn.deliveredMono===undefined
        ?{...r,nativeTurn:{...r.nativeTurn,deliveredMono:observedMonoMs,...(row.nativeTurn!.model?{model:row.nativeTurn!.model}:{})}}:r);
    await writeCompanionRunRegistry(rows,registry.archivedSessionIds,registry.paymentRequests,registry.ownerConfirmations,registry.runDeletions);
  });
  await finalizeNativeBindingMeasurements(runId);
}

/** Metadata only in the existing run owner. Never executes, settles or resubmits a turn. */
export async function recordTurnMeasurement(runId: string, sessionId: string, raw: unknown) {
  const measurement = validateTurnMeasurement(raw);
  if (!measurement || !/^[A-Za-z0-9_.:-]{1,160}$/.test(runId) || !/^[A-Za-z0-9-]{1,80}$/.test(sessionId))
    throw Object.assign(new Error("invalid_turn_measurement"), {statusCode: 400});
  return mutateRegistry(async () => {
    const registry = await registryOrEmpty();
    const row = registry.runs.find(run => run.runId === runId);
    if (!row || registry.runDeletions.some(r => r.runId === runId))
      throw Object.assign(new Error("run_not_found"), {statusCode: 404});
    if (row.sessionId !== sessionId || (row.turnSurface || (row.modality === "voice" ? "voice" : "app")) !== measurement.surface)
      throw Object.assign(new Error("turn_measurement_identity_conflict"), {statusCode: 409});
    if (row.turnMeasurement) {
      if (JSON.stringify(row.turnMeasurement) !== JSON.stringify(measurement))
        throw Object.assign(new Error("turn_measurement_already_final"), {statusCode: 409});
      return {success: true, state: "recorded", measurement: row.turnMeasurement};
    }
    const terminal = row.modality === "voice" ? ["completed", "interrupted"].includes(row.transcriptState || "")
      : ["done", "failed"].includes(row.state || "");
    if (!terminal) throw Object.assign(new Error("turn_measurement_not_final"), {statusCode: 409});
    const updated: StoredRun = {...row, turnMeasurement: measurement};
    await writeCompanionRunRegistry(registry.runs.map(run => run.runId === runId ? updated : run), registry.archivedSessionIds, registry.paymentRequests, registry.ownerConfirmations, registry.runDeletions);
    if(!row.measurementOnly)submittedRuns.set(runId, updated);
    // Metadata is durable before projection to the existing bounded process log. Idempotent reports never log twice.
    try {console.log(turnMeasurementLogLine(measurement));} catch {}
    return {success: true, state: "recorded", measurement};
  });
}

export async function turnMeasurementFacts() {
  const rows = await readStoredRuns(false,true);
  return {facts: rows.flatMap(run => run.turnMeasurement ? [{acceptedAt: run.acceptedAt, measurement: run.turnMeasurement}] : []),
    retainedRuns: rows.length, retainedCap: MAX_PERSISTED_RUNS,
    oldestRunAt: rows.length ? Math.min(...rows.map(run => run.acceptedAt)) : null};
}

/** 38 M1 : projection minimale des reçus de runs existants (aucun texte). */
export type ComprehensionRunFact = {acceptedAt: number; decisionType?: string; decisionRisk?: string;
  learned: boolean; clarificationAnswer: boolean; notThisAt?: number; agent: boolean;
  semanticOwner?:"main";internalOperation?:true;executionSource?:"gateway"|"capability_first";
  ownerAdmitted?:true;ownerTransport?:StoredRun["ownerTransport"];gatewayObserved:boolean;state?:StoredRun["state"];hasResult:boolean;decisionQualified:boolean};
export async function comprehensionRunFacts(): Promise<{facts: ComprehensionRunFact[]; retainedCap: number}> {
  const facts = (await readStoredRuns(false)).map(run => {
    const decision: any = run.decision;
    return {
      acceptedAt: run.acceptedAt,
      semanticOwner:run.semanticOwner,internalOperation:run.internalOperation,executionSource:run.executionSource,
      ownerAdmitted:run.ownerAdmitted,ownerTransport:run.ownerTransport,gatewayObserved:!!readGatewayObservation(run.gatewayObservation),
      state:run.state,hasResult:typeof run.result==="string"&&run.result.trim().length>0,decisionQualified:!!publicDecision(run.decision),
      decisionType: typeof decision?.type === "string" ? String(decision.type) : undefined,
      decisionRisk: typeof decision?.risk === "string" ? String(decision.risk) : undefined,
      learned: typeof decision?.plan?.learned_association === "string" || typeof decision?.learnedAssociation === "string",
      clarificationAnswer: typeof run.parentClarificationRunId === "string",
      notThisAt: run.notThis?.at,
      agent: !decision && run.executionSource === "gateway",
    };
  });
  return {facts, retainedCap: MAX_PERSISTED_RUNS};
}

export async function findSubmittedRunByClientRunId(
  clientRunId: string,
  expected?: { text: string; sessionId: string; userText?: string; attachments?: IntentAttachment[]; replayOf?: {sessionId: string; runId: string} },
): Promise<CompanionRunStatus | null> {
  const clientId = requireClientRunId(clientRunId);
  const stored = (await readStoredRuns()).find((run) => run.clientRunId === clientId);
  if (!stored) return null;
  if (expected) {
    const sessionId = normalizeCompanionSessionId(expected.sessionId || "default");
    const requestHash = submissionRequestHash(
      expected.text,
      sessionId,
      String(expected.userText || expected.text),
      expected.attachments || [],
      expected.replayOf ? {sessionId: normalizeCompanionSessionId(expected.replayOf.sessionId), runId: String(expected.replayOf.runId)} : undefined,
    );
    if (stored.sessionId !== sessionId || stored.requestHash !== requestHash) {
      throw Object.assign(new Error("client_run_identity_conflict"), { statusCode: 409 });
    }
  }
  return statusFromStoredRun(stored);
}

export async function getRunStatusByClientRunId(clientRunId: string): Promise<CompanionRunStatus> {
  const clientId = requireClientRunId(clientRunId);
  let stored = (await readStoredRuns()).find((run) => run.clientRunId === clientId);
  if (!stored) return unknownRun(clientId, "Client run was not found.");
  if (stored.memo && await resumeDueMemo(stored.runId)) stored = await findStoredRun(stored.runId, false) || stored;
  // Admission truth is the local atomic registry. Reconciliation must not depend
  // on Gateway reachability after the Companion has durably accepted a run.
  return withRunSteps(statusFromStoredRun(stored), stored);
}

/** HS5: progress.steps[] derived on read from the stored run and its receipts; nothing persisted. */
/** P1 : bit d'admission et connexion finale, quelle que soit la source du statut (registre ou session live). */
function withOwnerFields(status: CompanionRunStatus, stored?: StoredRun | null): CompanionRunStatus {
  if (!stored || (!stored.ownerAdmitted && !stored.ownerTransport)) return status;
  return {...status, ...(stored.ownerAdmitted ? {ownerAdmitted: true} : {}), ...(stored.ownerTransport ? {ownerTransport: stored.ownerTransport} : {})};
}

function withRunSteps(status: CompanionRunStatus, stored?: StoredRun | null): CompanionRunStatus {
  if (!stored) return status;
  status = withOwnerFields(status, stored);
  const derived = runProgressSteps({
    executionSource: stored.executionSource, state: status.state, error: stored.error,
    acceptedAt: stored.acceptedAt, updatedAt: stored.updatedAt ?? status.updatedAt, modality: stored.modality,
    decision: stored.decision, clarificationState: stored.clarificationState,
    presentation: runPresentation(stored), events: status.progress?.events, card: status.progress?.card,
  });
  if (!derived) return status;
  const base = status.progress || {text: "", events: []};
  return {...status, progress: {...base, ...derived, text: liveProgressText(status.state, base.text, derived.steps)}};
}

/** Technical transport text is never public: follow the current public step (including a clarification or the answer).
 * A readable terminal or business text is preserved. */
export function liveProgressText(state: string, text: string, steps: {id: string; label: string; state: string}[]): string {
  if (!isTechnicalProgressLabel(text)) return text;
  return steps.filter(step => step.state === "running").at(-1)?.label ?? steps.at(-1)?.label ?? "";
}

export async function getRunStatus(runId: string): Promise<CompanionRunStatus> {
  const normalizedRunId = runId.trim();
  let stored = normalizedRunId
    ? (await findStoredRun(normalizedRunId, false).catch(() => null)) || submittedRuns.get(normalizedRunId)
    : undefined;
  if (stored?.memo && await resumeDueMemo(stored.runId)) stored = await findStoredRun(stored.runId, false) || stored;
  return withRunSteps(await getRunStatusUnstepped(runId, stored), stored);
}

async function getRunStatusUnstepped(runId: string, preloaded: StoredRun | null | undefined): Promise<CompanionRunStatus> {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return unknownRun("", "Run id is required.");
  }
  if ((await registryOrEmpty().catch(() => defaultCompanionRunRegistry())).runDeletions.some(receipt => receipt.runId === normalizedRunId))
    return unknownRun(normalizedRunId, "Run deleted from companion history.");

  const stored = preloaded;
  if (stored?.gatewayObservation) {
    const observation=stored.gatewayObservation;
    if (observation.state==="settled" || observation.epoch===GATEWAY_OBSERVER_EPOCH &&
        observation.state==="following" && Date.now()<observation.deadlineAt)
      return observedRunStatus(stored);
    // A transport loss, expired observation or Companion restart gets one read reconciliation,
    // never a second agent request and never a read per UI/voice poll.
    return reconcileObservedRun(stored);
  }
  reconcileInactiveRuns(normalizedRunId);
  if(stored&&!requiresLiveRefresh(stored)){
    const status=statusFromStoredRun(stored);
    const progress=await terminalDetailProgress(stored,status);
    return progress?{...status,progress}:status;
  }
  // Recent Gateway runs keep their normal live session/transcript refresh.
  // The inactivity single-flight has its own independent deadline.
  const deadline=stored?undefined:Date.now()+1500;
  const listed = await findSessionInfo(normalizedRunId, stored, deadline).catch(() => null);
  if (listed) {
    const fallback = statusFromSessionInfo(listed, normalizedRunId, stored || undefined);
    return enrichFromSessionFile(fallback, listed, stored, true, deadline);
  }
  if (stored) {
    return statusFromStoredRun(stored);
  }

  try {
    const sessionKey = stored?.sessionKey || expectedCompanionSessionKey(stored?.sessionId || "default");
    const history = await callOpenClawGateway("chat.history", { sessionKey });
    return statusFromHistory(normalizedRunId, sessionKey, history, stored);
  } catch (error: any) {
    return unknownRun(normalizedRunId, error?.message || "Run was not found.");
  }
}

/** Detail-only reconstruction of recorded terminal progress. It never settles/reopens a run or replaces its receipt.
 * Same runs owner and Gateway readers; bounded process-local projection (64 entries,30s), no persisted source.
 * A slow owner read finishes behind the 2.5s detail response and serves the next poll. Lists never call this reader. */
const TERMINAL_PROGRESS_RESPONSE_MS=2500,TERMINAL_PROGRESS_OWNER_MS=5500,TERMINAL_PROGRESS_TTL_MS=30000;
const terminalProgressCache=new Map<string,{at:number;value:Promise<CompanionRunProgress|undefined>}>();
async function terminalDetailProgress(stored:StoredRun,status:CompanionRunStatus):Promise<CompanionRunProgress|undefined>{
  if(stored.modality==='voice'||stored.executionSource==='capability_first'||!['done','failed'].includes(stored.state||'')||
    stored.inactivityCorrectionReceipt||stored.error==='run_inactivity_expired'||!stored.text)return undefined;
  const key=JSON.stringify([stored.runId,stored.sessionKey,stored.sessionId,stored.acceptedAt,stored.updatedAt,stored.state]);
  let cached=terminalProgressCache.get(key);
  if(!cached||Date.now()-cached.at>=TERMINAL_PROGRESS_TTL_MS){
    const deadline=Date.now()+TERMINAL_PROGRESS_OWNER_MS;
    const value=(async()=>{
      const expected=stored.sessionKey||expectedCompanionSessionKey(stored.sessionId);
      const session=findSessionForStoredRun(await readSessionsIndex(deadline,expected),stored);
      if(!session||!/^[A-Za-z0-9_-]{1,128}$/.test(String(session.sessionId||'')))return undefined;
      const [transcript,card]=await Promise.all([
        readSessionTranscript(session.sessionId,stored.text,String(session.key||''),deadline,stored.acceptedAt).catch(()=>null),
        readRunProgressCard(String(session.key||''),stored.acceptedAt).catch(()=>null),
      ]);
      // A same-text later turn must not contribute its steps to this terminal receipt.
      const exact=transcript?.startedAt&&Math.abs(transcript.startedAt-stored.acceptedAt)<=30000;
      const events=exact?transcript.progressEvents:[];
      const ownCard=card&&stored.updatedAt&&card.updatedAt<=stored.updatedAt?card:null;
      if(!events.length&&!ownCard)return undefined;
      return withProgressCard(mergeProgress(status.progress,events),ownCard);
    })().catch(()=>undefined);
    cached={at:Date.now(),value};terminalProgressCache.set(key,cached);
    if(terminalProgressCache.size>64)terminalProgressCache.delete(terminalProgressCache.keys().next().value!);
  }
  return beforeDeadline(cached.value,Date.now()+TERMINAL_PROGRESS_RESPONSE_MS,undefined);
}

function requiresLiveRefresh(stored:StoredRun):boolean {
  if (stored.gatewayObservation) return false;
  return stored.modality!=="voice"&&stored.executionSource!=="capability_first"&&
    stored.error!=="run_inactivity_expired"&&!stored.inactivityCorrectionReceipt&&
    stored.state!=="failed"&&!stored.result;
}

function statusFromHistory(runId: string, sessionKey: string, history: any, stored?: StoredRun): CompanionRunStatus {
  const sessionInfo = history?.sessionInfo || {};
  const state = normalizeState(sessionInfo.status, sessionInfo.hasActiveRun, sessionInfo);
  const result = latestAssistantText(history?.messages);
  const prompt = stored?.text || latestUserText(history?.messages) || "";
  const userText = stored?.userText || latestUserText(history?.messages) || prompt;
  const message = result || messageForState(state);

  return {
    success: state !== "failed" && state !== "unknown",
    runId,
    clientRunId: stored?.clientRunId,
    sessionId: stored?.sessionId,
    sessionKey: includeTechnicalIds() ? sessionKey : undefined,
    state,
    status: typeof sessionInfo.status === "string" ? sessionInfo.status : undefined,
    message,
    result,
    prompt,
    userText,
    attachments: stored?.attachments,
    submittedAt: stored?.acceptedAt,
    startedAt: numberOrUndefined(sessionInfo.startedAt),
    updatedAt: numberOrUndefined(sessionInfo.updatedAt),
    endedAt: numberOrUndefined(sessionInfo.endedAt),
    runtimeMs: numberOrUndefined(sessionInfo.runtimeMs),
    canvas: intentCanvas(prompt, message),
    raw: includeRaw() ? {
      sessionInfo,
    } : undefined,
  };
}

async function enrichFromSessionFile(
  status: CompanionRunStatus,
  sessionInfo: any,
  stored?: StoredRun,
  allowGatewayHistory = true,
  deadline?: number,
): Promise<CompanionRunStatus> {
  if (stored?.executionSource === "capability_first") return statusFromStoredRun(stored);
  const sessionId = String(sessionInfo?.sessionId || "");
  if (!sessionId) return status;

  const sessionKey = String(sessionInfo?.key || stored?.sessionKey || "");
  const [transcript, trajectory, card] = await Promise.all([
    readSessionTranscript(sessionId, stored?.text, allowGatewayHistory ? String(sessionInfo?.key || "") : undefined, deadline).catch(() => null),
    readSessionTrajectory(sessionId, status.runId, stored?.text).catch(() => null),
    readRunProgressCard(sessionKey, stored?.acceptedAt || status.submittedAt).catch(() => null),
  ]);
  if (!transcript && !trajectory) return card ? {...status, progress: withProgressCard(status.progress, card)} : status;

  const prompt = stored?.text || transcript?.prompt || trajectory?.prompt || status.prompt || "";
  const userText = stored?.userText || status.userText;
  const result = transcript?.result || trajectory?.result || status.result;
  const progress = withProgressCard(mergeProgress(status.progress, transcript?.progressEvents || [], trajectory?.progress), card);
  const state = resolveState(status.state, result, trajectory?.state, progress);
  const message = result || progress?.text || status.message;
  const startedAt = transcript?.startedAt || trajectory?.startedAt || status.startedAt;
  const endedAt = transcript?.endedAt || trajectory?.endedAt || status.endedAt;
  const tokenUsage = mergeTokenUsage(status.tokenUsage, transcript?.tokenUsage, trajectory?.tokenUsage);
  if (stored && result && state === "done" && (stored.state !== "done" || stored.result !== result)) {
    await saveStoredRun({ ...stored, result, state: "done", updatedAt: Date.now() });
  }

  return {
    ...status,
    success: state !== "failed" && state !== "unknown",
    state,
    message,
    result,
    progress,
    prompt,
    userText,
    attachments: stored?.attachments || status.attachments,
    submittedAt: stored?.acceptedAt || status.submittedAt,
    startedAt,
    updatedAt: trajectory?.updatedAt || status.updatedAt,
    endedAt,
    runtimeMs: startedAt && endedAt ? endedAt - startedAt : status.runtimeMs,
    tokenUsage,
    canvas: prompt || result ? intentCanvas(prompt, message) : status.canvas,
  };
}

function statusFromSessionInfo(sessionInfo: any, preferredRunId?: string, stored?: StoredRun): CompanionRunStatus {
  const sessionKey = String(sessionInfo?.key || "");
  const runId = preferredRunId || runIdFromSessionKey(sessionKey) || sessionKey;
  const sessionId = stored?.sessionId || sessionIdFromSessionKey(sessionKey);
  const storedStatus = stored ? statusFromStoredRun(stored) : undefined;
  const sessionState = normalizeState(sessionInfo?.status, sessionInfo?.hasActiveRun, sessionInfo);
  const state = storedStatus?.state || sessionState;
  const message = messageForState(state);

  return {
    success: state !== "failed" && state !== "unknown",
    runId,
    clientRunId: stored?.clientRunId,
    sessionId,
    sessionKey: includeTechnicalIds() ? sessionKey : undefined,
    state,
    status: typeof sessionInfo?.status === "string" ? sessionInfo.status : undefined,
    message,
    result: stored?.result,
    progress: state === "running" ? storedStatus?.progress : undefined,
    prompt: stored?.text,
    userText: stored?.userText,
    attachments: stored?.attachments,
    submittedAt: stored?.acceptedAt,
    startedAt: numberOrUndefined(sessionInfo?.startedAt),
    updatedAt: numberOrUndefined(sessionInfo?.updatedAt),
    endedAt: numberOrUndefined(sessionInfo?.endedAt),
    runtimeMs: numberOrUndefined(sessionInfo?.runtimeMs),
    raw: includeRaw() ? {
      sessionInfo,
    } : undefined,
  };
}

/** O9: a voice turn whose transcript is final (completed or interrupted, see terminal()) is terminal.
 * "interrupted" is a normal end of turn (barge-in or hang-up), not an error: state "done", status "interrupted".
 * Only a partial transcript stays non-terminal. S24 capture: fixtures/s24-2026-10-11/o9-voice-unknown-runs.json. */
export function voiceRunState(transcriptState: StoredRun["transcriptState"]): CompanionRunStatus["state"] {
  return transcriptState === "completed" || transcriptState === "interrupted" ? "done" : "unknown";
}

/** Payment handoff projection first (derived on read), else the stored HS3 presentation. */
function runPresentation(stored: StoredRun): ReceiptPresentation | undefined {
  return stored.paymentPresentation || readReceiptPresentation(stored.presentation);
}

function statusFromStoredRun(stored: StoredRun): CompanionRunStatus {
  if (stored.modality === "voice") return {
    success: true, runId: stored.runId, clientRunId: stored.clientRunId, sessionId: stored.sessionId,
    state: voiceRunState(stored.transcriptState),
    ...(stored.transcriptState === "interrupted" ? {status: "interrupted"} : {}),
    message: stored.transcriptState || "partial", userText: stored.userText || "",
    result: stored.result || "", submittedAt: stored.acceptedAt, updatedAt: stored.updatedAt,
    modality: "voice", transcriptState: stored.transcriptState, playback: stored.playback, turnMeasurement: stored.turnMeasurement,
    ...replayFields(stored),
  };

  const interruptedMemo = !!stored.memo && stored.memo.ownerEpoch !== MEMO_OWNER_EPOCH &&
    (stored.memo.phase === "dispatched" && stored.executionSource === "capability_first") && stored.state === "running";
  const failed = stored.state === "failed" || interruptedMemo;
  const expired = stored.error === "run_inactivity_expired";
  const done = stored.state === "done";
  const unknown = stored.state === "unknown";
  const message = stored.memo?.phase === "ready" && !failed ? "Mémo transcrit, prêt à poursuivre." : stored.memo?.phase === "transcription_pending" && !failed ? "Transcription en attente, nouvel essai automatique." : interruptedMemo ? "Prise en charge du mémo interrompue ; aucune relance automatique." : failed
    ? expired ? "Run expired after verified inactivity. A later result can still correct this status." : stored.error || "OpenClaw did not accept this run."
    : unknown ? stored.error || "Le résultat de la recherche reste à vérifier ; aucune relance automatique." : done
      ? stored.result || "OpenClaw completed this run."
      : stored.memo && stored.memo.phase !== "dispatched" ? "Transcription du mémo en cours."
        : "OpenClaw is still working on this run.";
  return {
    success: !failed,
    turnMeasurement: stored.turnMeasurement,
    provenance: capabilityProvenance(stored.provenance),
    web: readRunWebResult(stored.web),
    memoTranscription: stored.memo ? {phase: stored.memo.phase, attempts: stored.memo.attempts,
      nextAttemptAt: stored.memo.nextAttemptAt, retryAllowed: stored.error === MEMO_TERMINAL_ERROR} : undefined,
    status: stored.memo && stored.memo.phase !== "dispatched" && !failed ? stored.memo.phase === "ready" ? "memo_ready_to_continue" : stored.memo.phase === "transcription_pending" ? "transcription_pending" : "transcribing"
      : stored.error === "run_inactivity_expired" ? "expired" : undefined,
    ...publicReceiptMetadata(runPresentation(stored)),
    ...(publicDecision(stored.decision) ? {decision: publicDecision(stored.decision)} : {}),
    inactivityCorrectionReceipt: stored.inactivityCorrectionReceipt,
    runId: stored.runId,
    clientRunId: stored.clientRunId,
    sessionId: stored.sessionId,
    ...(stored.ownerAdmitted ? {ownerAdmitted: true} : {}),
    ...(stored.ownerTransport ? {ownerTransport: stored.ownerTransport} : {}),
    ...(stored.reasonClass ? {reasonClass: stored.reasonClass} : {}),
    state: failed ? "failed" : unknown ? "unknown" : stored.state === "done" ? "done" : "running",
    message,
    progress: {
      text: failed ? expired ? "Expired after verified inactivity." : "OpenClaw submit failed." : done ? "Completed." : "Working...",
      detail: failed || done ? message : undefined,
      updatedAt: stored.updatedAt || stored.acceptedAt,
      events: [
        {
          type: failed ? "companion.failed" : done ? "companion.completed" : "companion.accepted",
          label: failed ? expired ? "Expired after verified inactivity." : "OpenClaw submit failed." : done ? "Completed." : "Working...",
          detail: failed || done ? message : undefined,
          at: stored.updatedAt || stored.acceptedAt,
        },
      ],
    },
    result: stored.result,
    prompt: stored.text,
    userText: stored.userText,
    attachments: stored.attachments,
    submittedAt: stored.acceptedAt,
    updatedAt: stored.updatedAt,
    ...replayFields(stored),
  };
}

function replayFields(stored: StoredRun) {
  return {...(stored.replayOf ? {replayOf: stored.replayOf} : {}), ...(stored.supersededBy ? {supersededBy: stored.supersededBy} : {}),
    replayEffect: replayEffect(stored)};
}

/** Ce que le registre sait de l'effet d'un tour, sans déduction : seule une décision v2 typée peut dire « rien » ou « exécuté ». */
export function replayEffect(stored: StoredRun): "none" | "executed" | "unknown" {
  if (stored.modality === "voice" || stored.executionSource !== "capability_first") return "unknown";
  const decision = publicDecision(stored.decision);
  if (!decision) return "unknown";
  if (decision.type !== "EXECUTE" || decision.risk === "read") return "none";
  return stored.state === "done" ? "executed" : "unknown";
}

async function findSessionInfo(runId: string, stored?: StoredRun | null, deadline?: number): Promise<any | null> {
  const sessions = await readSessionsIndex(deadline);
  if (stored) {
    return findSessionForStoredRun(sessions, stored);
  }
  return sessions.find((session: any) => runIdFromSessionKey(String(session?.key || "")) === runId) || null;
}

function findSessionForStoredRun(sessions: any[], stored: StoredRun): any | null {
  const expected = stored.sessionKey || expectedCompanionSessionKey(stored.sessionId);
  return sessions.find((session: any) => session?.key === expected) || null;
}

function normalizedStoredSessionKey(sessionId: string, sessionKey?: string) {
  const value = String(sessionKey || "").trim();
  if (!value) return expectedCompanionSessionKey(sessionId);
  if (value.startsWith("agent:")) return value;
  return `agent:${agentId()}:${value}`;
}

async function readSessionsIndex(deadline?: number, exactKey?: string): Promise<any[]> {
  const filePath = path.join(openClawStateDir(), "agents", agentId(), "sessions", "sessions.json");
  let data: any;
  try {
    data = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    // OpenClaw SQLite migration removed the legacy index. Use the owner Gateway API.
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) return [];
    data = await callOpenClawGateway("sessions.list", { search: exactKey || "companion-", limit: exactKey ? 20 : 100 },
      remaining === undefined ? {} : {timeoutMs: remaining, hardTimeoutMs: remaining});
  }
  if (Array.isArray(data?.sessions)) return data.sessions;
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  return Object.entries(data)
      .map(([key, value]: [string, any]) => ({ key, ...(value || {}) }))
    .sort((left: any, right: any) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
}

async function readSessionTranscript(
  sessionId: string,
  targetPrompt?: string,
  sessionKey?: string,
  deadline?: number,
  targetAcceptedAt?: number,
): Promise<TranscriptSummary> {
  const filePath = path.join(openClawStateDir(), "agents", agentId(), "sessions", `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT" || !sessionKey) throw error;
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) throw new Error("inactivity_read_budget_exceeded");
    const history = await callOpenClawGateway("chat.history", { sessionKey, limit: 200 },
      remaining === undefined ? {} : {timeoutMs: remaining, hardTimeoutMs: remaining});
    raw = (Array.isArray(history?.messages) ? history.messages : [])
      .map((message: any) => JSON.stringify({ type: "message", message, timestamp: message.timestamp }))
      .join("\n");
  }
  return summarizeTranscript(raw, targetPrompt, targetAcceptedAt);
}

/** Exported for the progress tests (real S24 chat.history captures); the runtime reads it through readSessionTranscript. */
export function summarizeTranscript(raw: string, targetPrompt?: string, targetAcceptedAt?: number): TranscriptSummary {
  let prompt = "";
  let result = "";
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  const progressEvents: CompanionRunProgressEvent[] = [];
  let tokenUsage: CompanionRunTokenUsage | undefined;
  let isTargetTurn = !targetPrompt;
  let candidatePrompt = "";
  let candidateResult = "";
  let candidateStartedAt: number | undefined;
  let candidateEndedAt: number | undefined;
  let candidateProgressEvents: CompanionRunProgressEvent[] = [];
  let candidateTokenUsage: CompanionRunTokenUsage | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.type !== "message") continue;
    const role = event?.message?.role;
    const text = contentText(event?.message?.content);
    const at = messageTimestamp(event, true);
    const turnIsActive = targetPrompt ? isTargetTurn : true;

    if (role === "assistant" && turnIsActive) {
      const toolEvents = toolCallEventsFromMessage(event);
      progressEvents.push(...toolEvents);
      if (targetPrompt) candidateProgressEvents.push(...toolEvents);
      const messageUsage = tokenUsageFromMessage(event);
      if (messageUsage) {
        tokenUsage = accumulateTokenUsage(tokenUsage, messageUsage);
        if (targetPrompt) candidateTokenUsage = accumulateTokenUsage(candidateTokenUsage, messageUsage);
      }
    } else if (role === "toolResult" && turnIsActive) {
      const toolEvent = toolResultEventFromMessage(event);
      if (toolEvent) {
        progressEvents.push(toolEvent);
        if (targetPrompt) candidateProgressEvents.push(toolEvent);
      }
    }

    if (!text) continue;

    if (role === "user") {
      const clean = stripOpenClawTimestamp(text);
      prompt = clean;
      startedAt = messageTimestamp(event);
      if (targetPrompt) {
        if (clean === targetPrompt && (targetAcceptedAt===undefined || at!==undefined && Math.abs(at-targetAcceptedAt)<=30000)) {
          isTargetTurn = true;
          candidatePrompt = clean;
          candidateResult = "";
          candidateStartedAt = messageTimestamp(event);
          candidateEndedAt = undefined;
          candidateProgressEvents = [];
          candidateTokenUsage = undefined;
        } else if (isTargetTurn && candidateResult) {
          isTargetTurn = false;
        } else if (isTargetTurn) {
          isTargetTurn = false;
        }
      }
    } else if (role === "assistant") {
      result = text;
      endedAt = at;
      if (isTargetTurn) {
        candidateResult = text;
        candidateEndedAt = at;
      }
    }
  }

  if (targetPrompt) {
    return {
      prompt: candidatePrompt || targetPrompt,
      result: candidateResult,
      startedAt: candidateStartedAt,
      endedAt: candidateEndedAt,
      progressEvents: candidateProgressEvents,
      tokenUsage: candidateTokenUsage,
    };
  }
  return { prompt, result, startedAt, endedAt, progressEvents, tokenUsage };
}

async function readSessionTrajectory(
  sessionId: string,
  runId?: string,
  targetPrompt?: string,
): Promise<TrajectorySummary | null> {
  const filePath = path.join(openClawStateDir(), "agents", agentId(), "sessions", `${sessionId}.trajectory.jsonl`);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = raw
    .split(/\r?\n/)
    .map((line) => parseJsonLine(line))
    .filter(Boolean);
  if (parsed.length === 0) return null;

  const targetRunId = isOpenClawRunId(runId)
    ? runId
    : runIdForPrompt(parsed, targetPrompt) || latestRunId(parsed);
  const events = targetRunId
    ? parsed.filter((event: any) => event?.runId === targetRunId)
    : parsed;
  if (events.length === 0) return null;

  let prompt = "";
  let result = "";
  let state: CompanionRunStatus["state"] | undefined;
  let startedAt: number | undefined;
  let updatedAt: number | undefined;
  let endedAt: number | undefined;
  const progressEvents: CompanionRunProgressEvent[] = [];
  let tokenUsage: CompanionRunTokenUsage | undefined;

  for (const event of events) {
    const at = trajectoryTimestamp(event);
    if (at) updatedAt = at;

    if (event?.type === "session.started" && at && !startedAt) {
      startedAt = at;
    }

    if (event?.type === "prompt.submitted" && typeof event?.data?.prompt === "string") {
      prompt = stripOpenClawTimestamp(event.data.prompt);
    }

    const assistantText = assistantTextFromTrajectory(event);
    if (assistantText) {
      result = assistantText;
      if (state !== "failed") state = "done";
    }

    if (event?.type === "session.ended") {
      endedAt = at || endedAt;
      state = stateFromSessionEnd(event?.data?.status) || state;
    }

    const progressEvent = progressEventFromTrajectory(event);
    if (progressEvent) progressEvents.push(progressEvent);
    tokenUsage = accumulateTokenUsage(tokenUsage, tokenUsageFromTrajectory(event));
  }

  const latestProgress = progressEvents[progressEvents.length - 1];
  return {
    runId: targetRunId,
    prompt,
    result,
    state,
    startedAt,
    updatedAt,
    endedAt,
    tokenUsage,
    progress: latestProgress
      ? {
        text: latestProgress.label,
        detail: latestProgress.detail,
        updatedAt: latestProgress.at,
        events: progressEvents.slice(-8),
      }
      : undefined,
  };
}

function isCompanionSession(session: any) {
  const key = String(session?.key || "");
  return key.includes(":companion-chat-") || key.includes(":companion-run-") || key.includes(":companion-test-") || session?.label === "ClawMobile Companion";
}

function companionSessionIdFromSession(session: any) {
  const sessionId = sessionIdFromSessionKey(String(session?.key || ""));
  return sessionId ? normalizeCompanionSessionId(sessionId) : "";
}

function normalizeState(status: any, hasActiveRun: any, sessionInfo?: any): CompanionRunStatus["state"] {
  const value = String(status || "").toLowerCase();
  if (hasActiveRun || ["queued", "pending", "processing", "running"].includes(value)) return "running";
  if (["done", "completed", "complete", "success"].includes(value)) return "done";
  if (["failed", "error", "cancelled", "aborted"].includes(value)) return "failed";
  if (!value && sessionInfo?.updatedAt && !sessionInfo?.endedAt) return "running";
  return "unknown";
}

function messageForState(state: CompanionRunStatus["state"]) {
  switch (state) {
    case "running":
      return "OpenClaw is still working on this run.";
    case "done":
      return "OpenClaw finished this run.";
    case "failed":
      return "OpenClaw reported that this run failed.";
    default:
      return "Run status is not available yet.";
  }
}

function latestAssistantText(messages: any): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = contentText(message.content);
    if (text) return text;
  }
  return "";
}

function latestUserText(messages: any): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = contentText(message.content);
    if (text) return text;
  }
  return "";
}

function contentText(content: any): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * User-oriented live progress (Amine 25/10/2026): the agent's own OpenClaw progress card for this session, written for
 * Amine by rule (no tool, file or model names). Read only for a live single-run status, through the existing Gateway
 * transport, with a short single-flight cache so frequent polls never multiply Gateway calls. A card older than the run
 * belongs to an earlier task of the same conversation and is ignored. Nothing is stored.
 */
const PROGRESS_CARD_TTL_MS = 1500;
const PROGRESS_CARD_TIMEOUT_MS = 1500;
const PROGRESS_CARD_MAX_STEPS = 12;
const progressCardCache = new Map<string, {at: number; value: Promise<RunProgressCard | null>}>();
export type RunProgressCard = {revision: number; updatedAt: number; steps: {label: string; state: "pending" | "running" | "done"}[]; note?: string};

function cardText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/<[^>]*>/g, " ").replace(/[*_`#>|]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

export function projectProgressCard(raw: unknown): RunProgressCard | null {
  const card = raw && typeof raw === "object" ? (raw as any).card ?? raw : null;
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  const revision = Number(card.revision), updatedAt = Number(card.updatedAt);
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const steps = (Array.isArray(card.steps) ? card.steps : []).slice(0, PROGRESS_CARD_MAX_STEPS).flatMap((step: any) => {
    const label = cardText(step?.step, 160);
    const state = step?.status === "completed" ? "done" as const : step?.status === "in_progress" ? "running" as const
      : step?.status === "pending" ? "pending" as const : null;
    return label && state ? [{label, state}] : [];
  });
  const note = cardText(card.markdown, 200);
  if (!steps.length && !note) return null;
  return {revision, updatedAt, steps, ...(note ? {note} : {})};
}

export async function readRunProgressCard(sessionKey: string, runAcceptedAt: number | undefined,
  read: (key: string) => Promise<unknown> = (key) => callOpenClawGateway("progressCard.get", {sessionKey: key}, {timeoutMs: PROGRESS_CARD_TIMEOUT_MS}),
  now: () => number = Date.now): Promise<RunProgressCard | null> {
  if (!/^agent:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9:._-]{1,200}$/.test(sessionKey)) return null;
  const cached = progressCardCache.get(sessionKey);
  let pending: Promise<RunProgressCard | null>;
  if (cached && now() - cached.at < PROGRESS_CARD_TTL_MS) pending = cached.value;
  else {
    pending = read(sessionKey).then(projectProgressCard, () => null);
    progressCardCache.set(sessionKey, {at: now(), value: pending});
    if (progressCardCache.size > 64) progressCardCache.delete(progressCardCache.keys().next().value!);
  }
  const card = await pending;
  if (!card) return null;
  return typeof runAcceptedAt === "number" && card.updatedAt < runAcceptedAt ? null : card;
}

/** The card's current step is the run's live text; its steps feed the HS5 steps (runProgress.ts). */
export function withProgressCard(progress: CompanionRunProgress | undefined, card: RunProgressCard | null): CompanionRunProgress | undefined {
  if (!card) return progress;
  const current = card.steps.find(step => step.state === "running")?.label || card.note || card.steps.at(-1)?.label;
  return {...(progress || {events: []}), text: current || progress?.text || "", updatedAt: card.updatedAt, card};
}

function mergeProgress(
  fallback: CompanionRunProgress | undefined,
  transcriptEvents: CompanionRunProgressEvent[],
  trajectoryProgress?: CompanionRunProgress,
): CompanionRunProgress | undefined {
  const events = dedupeProgressEvents([
    ...(fallback?.events || []),
    ...transcriptEvents,
    ...(trajectoryProgress?.events || []),
  ]);
  if (events.length === 0) return trajectoryProgress || fallback;

  const latest = events[events.length - 1];
  return {
    text: latest.label,
    detail: latest.detail,
    updatedAt: latest.at || trajectoryProgress?.updatedAt || fallback?.updatedAt,
    // Enough history for the agent's titled steps of a long run (point E); runProgress shows at most 8 of them.
    events: events.slice(-48),
  };
}

/** Start-up reads of the canonical context files (rules, memory view, voice notes): one « preparing » line at most. */
const STARTUP_CONTEXT_PATH = /(?:^|\/)(?:context\/(?:OPERATING_RULES|HYBRID_CONTEXT|INDEX)\.md|context\/rules\/[^/]+\.(?:md|json)|interaction-fast-path\.md|AGENTS\.md|SOUL\.md|IDENTITY\.md|USER\.md|memory\/voice\/amine\.md)$/;

function dedupeProgressEvents(events: CompanionRunProgressEvent[]) {
  const seen = new Set<string>();
  return events
    .filter((event) => event && event.label)
    .sort((left, right) => Number(left.at || 0) - Number(right.at || 0))
    .filter((event) => {
      const key = `${event.type}|${event.label}|${event.detail || ""}|${event.at || ""}|${event.callId || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function toolCallEventsFromMessage(event: any): CompanionRunProgressEvent[] {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((part: any) => part?.type === "toolCall" && typeof part?.name === "string")
    .map((part: any) => {
      const toolName = String(part.name);
      const args = part?.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments) ? part.arguments : {};
      const title = typeof args.title === "string" && args.title.trim() && args.title.length <= 160 ? args.title.trim() : undefined;
      return {
        type: "tool.call",
        label: `Calling ${toolName}.`,
        detail: toolArgumentsSummary(part),
        at: messageTimestamp(event, true),
        ...(typeof part.id === "string" && part.id ? {callId: part.id} : {}),
        ...(title ? {title} : {}),
        ...(toolName === "read" && typeof args.path === "string" && STARTUP_CONTEXT_PATH.test(args.path) ? {context: true} : {}),
      };
    });
}

function toolResultEventFromMessage(event: any): CompanionRunProgressEvent | null {
  const toolName = typeof event?.message?.toolName === "string" ? event.message.toolName : "";
  if (!toolName) return null;
  const failed = event?.message?.isError === true || toolResultLooksFailed(event?.message);
  const callId = typeof event?.message?.toolCallId === "string" && event.message.toolCallId ? event.message.toolCallId : undefined;
  return {
    type: failed ? "tool.error" : "tool.result",
    label: `${failed ? "Tool failed" : "Completed"} ${toolName}.`,
    detail: toolResultSummary(event?.message),
    at: messageTimestamp(event, true),
    ...(callId ? {callId} : {}),
  };
}

function toolArgumentsSummary(part: any): string | undefined {
  const args = part?.arguments ?? part?.partialJson;
  if (args == null) return undefined;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed || trimmed === "{}") return undefined;
    return truncateOneLine(trimmed, 120);
  }
  const json = JSON.stringify(args);
  return json && json !== "{}" ? truncateOneLine(json, 120) : undefined;
}

function toolResultLooksFailed(message: any) {
  const parsed = parseToolResultJson(message);
  return parsed?.ok === false || parsed?.isError === true;
}

function toolResultSummary(message: any): string | undefined {
  const parsed = parseToolResultJson(message);
  if (!parsed) return message?.isError ? "error" : "ok";
  if (parsed.ok === false) {
    return truncateOneLine(String(parsed.error || parsed.stderr || "error"), 140);
  }
  if (parsed.data && typeof parsed.data === "object") {
    const data = parsed.data;
    if (typeof data.percentage === "number" || typeof data.level === "number") {
      const level = typeof data.percentage === "number" ? data.percentage : data.level;
      const status = typeof data.status === "string" ? `, ${data.status}` : "";
      return `${level}%${status}`;
    }
  }
  if (typeof parsed.code === "number") return `exit code ${parsed.code}`;
  return "ok";
}

function parseToolResultJson(message: any): any | null {
  const text = contentText(message?.content);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncateOneLine(value: string, maxLength: number) {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}...`;
}

function resolveState(
  fallback: CompanionRunStatus["state"],
  result: string | undefined,
  trajectoryState?: CompanionRunStatus["state"],
  progress?: CompanionRunProgress,
): CompanionRunStatus["state"] {
  if (fallback === "failed" || trajectoryState === "failed") return "failed";
  if (result) return "done";
  if (trajectoryState) return trajectoryState;
  if (progress && fallback === "unknown") return "running";
  return fallback;
}

function parseJsonLine(line: string): any | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isOpenClawRunId(runId: string | undefined): runId is string {
  return typeof runId === "string" && /^run[_-]/.test(runId);
}

function runIdForPrompt(events: any[], targetPrompt?: string): string | undefined {
  if (!targetPrompt) return undefined;
  for (const event of events) {
    if (event?.type !== "prompt.submitted") continue;
    const prompt = typeof event?.data?.prompt === "string" ? stripOpenClawTimestamp(event.data.prompt) : "";
    if (prompt === targetPrompt && typeof event?.runId === "string") return event.runId;
  }
  return undefined;
}

function latestRunId(events: any[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const runId = events[index]?.runId;
    if (typeof runId === "string" && runId) return runId;
  }
  return undefined;
}

function assistantTextFromTrajectory(event: any): string {
  const assistantTexts = event?.data?.assistantTexts;
  if (!Array.isArray(assistantTexts)) return "";
  for (let index = assistantTexts.length - 1; index >= 0; index -= 1) {
    const text = assistantTexts[index];
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

function progressEventFromTrajectory(event: any): CompanionRunProgressEvent | null {
  const at = trajectoryTimestamp(event);
  const type = String(event?.type || "");
  const seq = numberOrUndefined(event?.sourceSeq) || numberOrUndefined(event?.seq);

  switch (type) {
    case "session.started":
      return {
        type,
        label: "Started OpenClaw session.",
        detail: modelDetail(event) || "Runtime accepted the task.",
        at,
        seq,
      };
    case "context.compiled":
      return {
        type,
        label: "Prepared context.",
        detail: "System context and tools are ready.",
        at,
        seq,
      };
    case "prompt.submitted":
      return {
        type,
        label: "Submitted prompt.",
        detail: "Waiting for the model response.",
        at,
        seq,
      };
    case "model.completed":
      return {
        type,
        label: "Model response received.",
        detail: tokenDetail(event),
        at,
        seq,
      };
    case "trace.artifacts":
      return {
        type,
        label: "Saved run artifacts.",
        detail: finalStatusDetail(event),
        at,
        seq,
      };
    case "session.ended":
      return {
        type,
        label: stateFromSessionEnd(event?.data?.status) === "failed" ? "Run ended with an error." : "Run finished.",
        detail: finalStatusDetail(event),
        at,
        seq,
      };
    case "turn.client_closed":
      return {
        type,
        label: "Client connection closed.",
        detail: "OpenClaw may still finish writing the run transcript.",
        at,
        seq,
      };
    default:
      return null;
  }
}

function trajectoryTimestamp(event: any): number | undefined {
  const parsed = Date.parse(String(event?.ts || event?.timestamp || ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stateFromSessionEnd(status: any): CompanionRunStatus["state"] | undefined {
  const value = String(status || "").toLowerCase();
  if (["success", "done", "complete", "completed"].includes(value)) return "done";
  if (["failed", "error", "cancelled", "aborted", "timeout", "timed_out"].includes(value)) return "failed";
  return undefined;
}

function modelDetail(event: any): string | undefined {
  const modelId = typeof event?.modelId === "string" ? event.modelId : "";
  const provider = typeof event?.provider === "string" ? event.provider : "";
  if (modelId && provider) return `${provider} / ${modelId}`;
  return modelId || provider || undefined;
}

function tokenDetail(event: any): string | undefined {
  const usage = event?.data?.usage;
  const output = numberOrUndefined(usage?.output);
  if (output) return `${output} output tokens.`;
  return undefined;
}

function tokenUsageFromTrajectory(event: any): CompanionRunTokenUsage | undefined {
  if (String(event?.type || "") !== "model.completed") return undefined;
  return tokenUsageFromRaw(event?.data?.usage);
}

function tokenUsageFromMessage(event: any): CompanionRunTokenUsage | undefined {
  return tokenUsageFromRaw(event?.message?.usage);
}

function tokenUsageFromRaw(usage: any): CompanionRunTokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;

  const inputTokens = firstNumber(
    usage.inputTokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.prompt_tokens,
    usage.input,
  );
  const outputTokens = firstNumber(
    usage.outputTokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.completion_tokens,
    usage.output,
  );
  const cachedTokens = firstNumber(
    usage.cachedTokens,
    usage.cached_tokens,
    usage.cacheRead,
    usage.cache_read,
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_tokens,
  );
  const reasoningTokens = firstNumber(
    usage.reasoningTokens,
    usage.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
  );
  const totalTokens = firstNumber(
    usage.totalTokens,
    usage.total_tokens,
    usage.total,
  );
  const fallbackTotalTokens = totalTokens ?? fallbackTotalTokenCount(inputTokens, outputTokens, reasoningTokens);
  const estimatedCostUsd = firstNumber(
    usage.estimatedCostUsd,
    usage.estimated_cost_usd,
    usage.estimatedCost,
    usage.estimated_cost,
    usage.costUsd,
    usage.cost_usd,
    usage.cost?.total,
    usage.cost,
  );
  const estimatedCost = formatEstimatedCost(estimatedCostUsd);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedTokens === undefined &&
    reasoningTokens === undefined &&
    fallbackTotalTokens === undefined &&
    estimatedCost === undefined &&
    estimatedCostUsd === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: fallbackTotalTokens,
    cachedTokens,
    reasoningTokens,
    estimatedCost,
    estimatedCostUsd,
  };
}

function accumulateTokenUsage(
  left?: CompanionRunTokenUsage,
  right?: CompanionRunTokenUsage,
): CompanionRunTokenUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return compactTokenUsage({
    inputTokens: sumDefined(left.inputTokens, right.inputTokens),
    outputTokens: sumDefined(left.outputTokens, right.outputTokens),
    totalTokens: sumDefined(left.totalTokens, right.totalTokens),
    cachedTokens: sumDefined(left.cachedTokens, right.cachedTokens),
    reasoningTokens: sumDefined(left.reasoningTokens, right.reasoningTokens),
    estimatedCostUsd: sumDefined(left.estimatedCostUsd, right.estimatedCostUsd),
    estimatedCost: formatEstimatedCost(sumDefined(left.estimatedCostUsd, right.estimatedCostUsd)) || right.estimatedCost || left.estimatedCost,
  });
}

function mergeTokenUsage(
  ...items: Array<CompanionRunTokenUsage | undefined>
): CompanionRunTokenUsage | undefined {
  const merged = items.reduce<CompanionRunTokenUsage>((current, usage) => {
    if (!usage) return current;
    return {
      inputTokens: usage.inputTokens ?? current.inputTokens,
      outputTokens: usage.outputTokens ?? current.outputTokens,
      totalTokens: usage.totalTokens ?? current.totalTokens,
      cachedTokens: usage.cachedTokens ?? current.cachedTokens,
      reasoningTokens: usage.reasoningTokens ?? current.reasoningTokens,
      estimatedCostUsd: usage.estimatedCostUsd ?? current.estimatedCostUsd,
      estimatedCost: usage.estimatedCost ?? current.estimatedCost,
    };
  }, {});
  return compactTokenUsage(merged);
}

function compactTokenUsage(usage: CompanionRunTokenUsage): CompanionRunTokenUsage | undefined {
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.totalTokens === undefined &&
    usage.cachedTokens === undefined &&
    usage.reasoningTokens === undefined &&
    usage.estimatedCost === undefined &&
    usage.estimatedCostUsd === undefined
  ) {
    return undefined;
  }
  return usage;
}

function firstNumber(...values: any[]): number | undefined {
  for (const value of values) {
    const number = numberOrUndefined(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => value !== undefined);
  if (numbers.length === 0) return undefined;
  return numbers.reduce((sum, value) => sum + value, 0);
}

function fallbackTotalTokenCount(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  reasoningTokens: number | undefined,
): number | undefined {
  if (inputTokens !== undefined || outputTokens !== undefined) {
    return sumDefined(inputTokens, outputTokens ?? reasoningTokens);
  }
  return reasoningTokens;
}

function formatEstimatedCost(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value <= 0) return undefined;
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function finalStatusDetail(event: any): string | undefined {
  const finalStatus = typeof event?.data?.finalStatus === "string" ? event.data.finalStatus : "";
  const status = typeof event?.data?.status === "string" ? event.data.status : "";
  const value = finalStatus || status;
  return value ? `status: ${value}` : undefined;
}

function stripOpenClawTimestamp(text: string) {
  return stripConversationTransport(text);
}

function messageTimestamp(event: any, preferEventTimestamp = false): number | undefined {
  const parsed = Date.parse(String(event?.timestamp || ""));
  if (preferEventTimestamp && Number.isFinite(parsed)) return parsed;
  const value = event?.message?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function runIdFromSessionKey(sessionKey: string): string {
  const match = sessionKey.match(/:companion-(run-[a-zA-Z0-9-]+)/);
  if (!match) return "";
  return match[1].replace(/-/g, "_").replace(/^run_([0-9]+)_/, "run_$1_");
}

function sessionIdFromSessionKey(sessionKey: string): string | undefined {
  const match = sessionKey.match(/:companion-chat-([a-zA-Z0-9-]+)/);
  return match?.[1];
}

function unknownRun(runId: string, message: string): CompanionRunStatus {
  return {
    success: false,
    runId,
    state: "unknown",
    message,
  };
}

function numberOrUndefined(value: any) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function includeRaw() {
  return ["1", "true", "yes"].includes((process.env.CLAWMOBILE_RUNS_INCLUDE_RAW || "").toLowerCase());
}

function includeTechnicalIds() {
  return includeRaw() || ["1", "true", "yes"].includes((process.env.CLAWMOBILE_RUNS_INCLUDE_TECHNICAL_IDS || "").toLowerCase());
}

function openClawStateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

function agentId() {
  return (process.env.CLAWMOBILE_AGENT_ID || "main").trim() || "main";
}

async function findStoredRun(runId: string, reconcile = false): Promise<StoredRun | null> {
  return (await readStoredRuns(reconcile)).find((run) => run.runId === runId) || null;
}

function validInactivityReceipt(value: any, runId: string): InactivityReceipt | undefined {
  if (value?.version !== 1 || value.action !== "correct_run_expiration" || value.runId !== runId ||
      value.from !== "expired" || !["running", "done"].includes(value.to) ||
      !Number.isFinite(value.at) || !Number.isFinite(value.evidenceAt)) return undefined;
  return {version: 1, action: "correct_run_expiration", runId, from: "expired", to: value.to,
    at: value.at, evidenceAt: value.evidenceAt};
}

/** Injectable inactivity clock boundary; production defaults to the system clock. */
export const runInactivityClock={now:()=>Date.now()};
let inactivityRead: Promise<void> | undefined;
/** Wait only for an already-started owner pass, including its persisted settlement. No new read. */
export async function awaitRunInactivity():Promise<void>{await inactivityRead;}
let inactivityCursor = 0;
const INACTIVITY_READ_BUDGET_MS = 10000;
/** Read snapshots never await reconciliation. One bounded owner pass at a time. */
function reconcileInactiveRuns(targetRunId?:string):void {
  if(inactivityRead)return;
  inactivityRead=reconcileInactiveRunsOnce(targetRunId,runInactivityClock.now()+INACTIVITY_READ_BUDGET_MS)
    .catch(()=>undefined).finally(()=>{inactivityRead=undefined;});
}

async function reconcileInactiveRunsOnce(targetRunId: string | undefined, deadline: number): Promise<void> {
  await registryWrite;
  const initial = await registryOrEmpty(), now = runInactivityClock.now();
  const eligible = (run: StoredRun, registry: CompanionRunRegistry) => !run.measurementOnly && run.modality !== "voice" && !run.gatewayObservation &&
    (!run.memo || run.memo.phase === "dispatched") &&
    !run.result && (!run.state || run.state === "running" || run.error === "run_inactivity_expired") &&
    run.acceptedAt >= 1000000000000 && (run.error === "run_inactivity_expired" || !!run.inactivityCorrectionReceipt || now - (run.updatedAt || run.acceptedAt) >= RUN_INACTIVITY_MS) &&
    !registry.archivedSessionIds.includes(run.sessionId) &&
    !registry.runDeletions.some(row => row.runId === run.runId) &&
    !protectedRun(run, registry.paymentRequests, registry.ownerConfirmations);
  const pool = initial.runs.filter(run => eligible(run, initial) &&
    run.error !== "run_inactivity_expired" && (!targetRunId || run.runId === targetRunId));
  const start = targetRunId || !pool.length ? 0 : inactivityCursor % pool.length;
  const candidates = [...pool.slice(start), ...pool.slice(0, start)].slice(0, 3);
  if (!targetRunId) inactivityCursor += candidates.length;
  if (!candidates.length) return;
  // The owner API works across SQLite migrations; absent legacy files prove nothing.
  const ownerRead = (method: string, params: Record<string, unknown>) => {
    const remaining = deadline - runInactivityClock.now();
    if (remaining <= 0) return Promise.reject(new Error("inactivity_read_budget_exceeded"));
    return callOpenClawGateway(method, params, {timeoutMs: remaining, hardTimeoutMs: remaining});
  };
  const listed = await ownerRead("sessions.list", {search: "companion-", limit: 100});
  const sessions = Array.isArray(listed?.sessions) ? listed.sessions : Array.isArray(listed) ? listed : [];
  const changes = new Map<string, {before: StoredRun; after: StoredRun}>();
  // Retired expirations are never polled. A sessions.list already read for a
  // live candidate may provide explicit contrary proof naming a retired run.
  const revived=initial.runs.filter(run=>run.error==="run_inactivity_expired"&&eligible(run,initial)&&sessions.some((session:any)=>
    (session.key===(run.sessionKey||expectedCompanionSessionKey(run.sessionId))||session.sessionKey===(run.sessionKey||expectedCompanionSessionKey(run.sessionId)))&&
    Array.isArray(session.activeRunIds)&&session.activeRunIds.includes(run.runId)));
  for (const run of [...candidates,...revived]) {
    const key = run.sessionKey || expectedCompanionSessionKey(run.sessionId);
    const session = sessions.find((row: any) => row?.key === key || row?.sessionKey === key);
    if (!session || runInactivityClock.now() >= deadline) continue;
    const active = session.hasActiveRun === true || session.status === "running" || (Array.isArray(session.activeRunIds) && session.activeRunIds.length > 0);
    if (active) {
      if (run.error === "run_inactivity_expired" && Array.isArray(session.activeRunIds) && session.activeRunIds.includes(run.runId)) changes.set(run.runId, {before: run, after: {
        ...run, state: "running", error: undefined, updatedAt: now,
        inactivityCorrectionReceipt: {version: 1, action: "correct_run_expiration", runId: run.runId,
          from: "expired", to: "running", at: now, evidenceAt: now}}});
      continue;
    }
    // Closed proof from the real sessions.list shape. Missing/unknown fields
    // never prove absence of activity or a pending permission transition.
    const lastActivityAt = typeof session.lastActivityAt === "number" ? session.lastActivityAt : Date.parse(session.lastActivityAt);
    const quiescent = Number.isFinite(lastActivityAt) && lastActivityAt >= 1000000000000 && lastActivityAt <= now && session.hasActiveRun === false && Array.isArray(session.activeRunIds) &&
      session.activeRunIds.length === 0 && session.permissionModePending === false &&
      session.abortedLastRun === false;

    const history = await ownerRead("chat.history", {sessionKey: key, limit: 200}).catch(() => null);
    const proof = ownerTurnEvidence(history?.messages, run.text, now);
    if (!proof || Math.abs(proof.startedAt - run.acceptedAt) > 30_000) continue;
    const terminal = terminalConversationResult(proof.messages.map(message => JSON.stringify({type: "message", message})).join("\n"), run.text);
    const expired = run.error === "run_inactivity_expired";
    let after: StoredRun | undefined;
    if (terminal && !proof.outstandingTool) after = {...run, state: "done", result: terminal.result, error: undefined, updatedAt: terminal.endedAt || proof.lastAt};
    else if (expired && (proof.outstandingTool || proof.lastAt > (run.updatedAt || run.acceptedAt)))
      after = {...run, state: "running", error: undefined, updatedAt: proof.lastAt};
    else if (!expired && !proof.outstandingTool && quiescent && now - Math.max(proof.lastAt, lastActivityAt, run.updatedAt || run.acceptedAt) >= RUN_INACTIVITY_MS)
      after = {...run, state: "failed", error: "run_inactivity_expired", updatedAt: proof.lastAt, inactivityCorrectionReceipt:undefined};
    if (!after) continue;
    if ((expired || run.inactivityCorrectionReceipt?.to === "running") && after.state !== "failed") after.inactivityCorrectionReceipt = {
      version: 1, action: "correct_run_expiration", runId: run.runId, from: "expired",
      to: after.state === "done" ? "done" : "running", at: now, evidenceAt: proof.lastAt};
    changes.set(run.runId, {before: run, after});
  }
  if (!changes.size) return;
  await mutateRegistry(async () => {
    const current = await registryOrEmpty(), applied: StoredRun[] = [];
    const next = current.runs.map(run => {
      const change = changes.get(run.runId), cached = submittedRuns.get(run.runId);
      if (!change || !eligible(run, current) || runIdentity(run) !== runIdentity(change.before) ||
          JSON.stringify(run.decision) !== JSON.stringify(change.before.decision) ||
          (cached && runIdentity(cached) !== runIdentity(change.before))) return run;
      applied.push(change.after); return change.after;
    });
    if (!applied.length) return;
    await writeCompanionRunRegistry(next, current.archivedSessionIds, current.paymentRequests, current.ownerConfirmations, current.runDeletions);
    for (const run of applied) if (submittedRuns.has(run.runId)) submittedRuns.set(run.runId, run);
  });
}

async function readStoredRuns(reconcile = true, includeMeasurements = false): Promise<StoredRun[]> {
  if (reconcile) reconcileInactiveRuns();
  for (const run of submittedRuns.values()) {
    if (!run.sessionId) run.sessionId = "default";
  }

  const fromMemory = Array.from(submittedRuns.values());
  const registry = await registryOrEmpty();
  const archivedSessionIds = new Set(registry.archivedSessionIds);
  const deletedRunIds = new Set(registry.runDeletions.map(receipt => receipt.runId));
  const byId = new Map<string, StoredRun>();
  for (const run of [...registry.runs, ...fromMemory]) {
    byId.set(run.runId, {
      ...run,
      sessionId: normalizeCompanionSessionId(run.sessionId || "default"),
    });
  }
  return Array.from(byId.values())
    .filter(run => !deletedRunIds.has(run.runId) && (includeMeasurements || !run.measurementOnly))
    .filter((run) => !archivedSessionIds.has(normalizeCompanionSessionId(run.sessionId || "default")))
    .sort((left, right) => right.acceptedAt - left.acceptedAt);
}

async function saveStoredRun(run: StoredRun) {
  return mutateRegistry(async () => {
  const registry = await registryOrEmpty();
  if (registry.runDeletions.some(receipt => receipt.runId === run.runId)) {
    submittedRuns.delete(run.runId); return;
  }
  const storedRun = {
    ...run,
    sessionId: normalizeCompanionSessionId(run.sessionId || "default"),
  };
  const next = retainStoredRuns([storedRun, ...registry.runs.filter((existing) => existing.runId !== storedRun.runId)]);
  const archivedSessionIds = registry.archivedSessionIds.filter((id) => id !== storedRun.sessionId);
  submittedRuns.set(storedRun.runId, storedRun);
  await writeCompanionRunRegistry(next, archivedSessionIds);
  });
}

async function writeCompanionRunRegistry(runs: StoredRun[], archivedSessionIds: string[], paymentRequests?: PaymentRecord[], ownerConfirmations?: ConfirmationRecord[], runDeletions?: RunDeletionReceipt[]) {
  // Payment guards share this registry but never inherit the 100-turn history eviction.
  const current = await registryOrEmpty();
  const payments = paymentRequests ?? current.paymentRequests;
  const confirmations = ownerConfirmations ?? current.ownerConfirmations;
  const deletions = retainedRunDeletions(runDeletions ?? current.runDeletions);
  const deletedIds = new Set(deletions.map(row => row.runId));
  // The payment projection is derived on read: it never reaches the file nor the byte budget.
  const boundedRuns = retainStoredRuns(runs.filter(row => !deletedIds.has(row.runId))
    .map(({paymentPresentation: _derived, ...row}) => row as StoredRun));
  await fs.mkdir(path.dirname(runRegistryPath()), { recursive: true });
  const tmp = runRegistryPath() + ".tmp-" + process.pid;
  const file = await fs.open(tmp, "w", 0o600);
  try { await file.writeFile(JSON.stringify({ version: 1, runs: boundedRuns, archivedSessionIds, paymentRequests: payments, ownerConfirmations: confirmations, runDeletions: deletions }, null, 2)); await file.sync(); }
  finally { await file.close(); }
  await fs.rename(tmp, runRegistryPath());
  const directory = await fs.open(path.dirname(runRegistryPath()), "r");
  try { await directory.sync(); } finally { await directory.close(); }
  publishConversationChanges(current.runs, boundedRuns, current.archivedSessionIds, archivedSessionIds);
}

async function readCompanionRunRegistry(): Promise<CompanionRunRegistry> {
  const raw = await fs.readFile(runRegistryPath(), "utf8");
  const data = JSON.parse(raw);
  const runs = Array.isArray(data?.runs) ? data.runs : [];
  if (data.paymentRequests !== undefined && !Array.isArray(data.paymentRequests)) throw new Error("invalid_payment_registry");
  const paymentRequests = (data.paymentRequests || []) as PaymentRecord[];
  if (data.ownerConfirmations !== undefined && !Array.isArray(data.ownerConfirmations)) throw new Error("invalid_confirmation_registry");
  const ownerConfirmations = (data.ownerConfirmations || []) as ConfirmationRecord[];
  const runDeletions = parseRunDeletions(data.runDeletions);
  const archivedSessionIds: string[] = Array.isArray(data?.archivedSessionIds)
    ? Array.from(new Set<string>(
      data.archivedSessionIds
        .map((id: any) => normalizeCompanionSessionId(String(id || "")))
        .filter((id: string) => id.length > 0),
    ))
    : [];
  const parsedRuns: StoredRun[] = runs
      .filter((run: any) => typeof run?.runId === "string")
    .map((run: any) => ({
      turnMeasurement: validateTurnMeasurement(run.turnMeasurement),
      turnSurface: ["app","whatsapp","voice"].includes(run.turnSurface) ? run.turnSurface : undefined,
      measurementOnly: run.measurementOnly===true ? true : undefined,
      nativeTurn: nativeTurnMetadata(run.nativeTurn),
      semanticOwner:run.semanticOwner==="main"&&run.ownerAdmitted===true&&run.executionSource==="gateway"?"main":undefined,
      internalOperation:run.internalOperation===true?true:undefined,
      inactivityCorrectionReceipt: validInactivityReceipt(run.inactivityCorrectionReceipt, run.runId),
      presentation: readReceiptPresentation(run.presentation),
      provenance: capabilityProvenance(run.provenance),
      web: readRunWebResult(run.web),
      runId: run.runId,
      clientRunId: typeof run.clientRunId === "string" && CLIENT_RUN_ID_RE.test(run.clientRunId) ? run.clientRunId : undefined,
      memo: run.memo && /^[A-Za-z0-9_-]{1,100}$/.test(run.memo.attachmentId || "") &&
        ["transcribing", "transcription_pending", "ready", "dispatched"].includes(run.memo.phase) &&
        (run.memo.attempts === undefined || Number.isInteger(run.memo.attempts) && run.memo.attempts >= 1 && run.memo.attempts <= MEMO_MAX_ATTEMPTS) &&
        (run.memo.nextAttemptAt === undefined || typeof run.memo.nextAttemptAt === "number" && Number.isFinite(run.memo.nextAttemptAt) && run.memo.nextAttemptAt > 0) &&
        /^[a-f0-9-]{36}$/.test(run.memo.ownerEpoch || "")
        ? {attachmentId: run.memo.attachmentId, ownerEpoch: run.memo.ownerEpoch, phase: run.memo.phase, attempts: run.memo.attempts ?? 1, nextAttemptAt: run.memo.nextAttemptAt} : undefined,
      requestHash: typeof run.requestHash === "string" && /^[a-f0-9]{64}$/.test(run.requestHash) ? run.requestHash : undefined,
      executionSource: ["gateway", "capability_first"].includes(String(run.executionSource || ""))
        ? run.executionSource
        : undefined,
      decision: run.decision && typeof run.decision === "object" && Number(run.decision.version) === 2
        ? run.decision
        : undefined,
      // D-C at cutover: a legacy pending question (no coordinator goal) or an expired one is shown abandoned.
      clarificationState: ["pending", "resolved", "abandoned"].includes(String(run.clarificationState || ""))
        ? (run.clarificationState === "pending" && (!dialogueGoalRefOf(run.dialogueGoalRef) ||
            (typeof run.clarificationExpiresAt === "number" && run.clarificationExpiresAt <= Date.now())) ? "abandoned" : run.clarificationState)
        : undefined,
      clarificationExpiresAt: typeof run.clarificationExpiresAt === "number" ? run.clarificationExpiresAt : undefined,
      parentClarificationRunId: typeof run.parentClarificationRunId === "string" ? run.parentClarificationRunId : undefined,
      dialogueGoalRef: dialogueGoalRefOf(run.dialogueGoalRef),
      sessionId: normalizeCompanionSessionId(String(run.sessionId || "default")),
      sessionKey: typeof run.sessionKey === "string" ? run.sessionKey : undefined,
      text: typeof run.text === "string" ? run.text : "",
      userText: typeof run.userText === "string" ? run.userText : undefined,
      attachments: Array.isArray(run.attachments) ? run.attachments : undefined,
      acceptedAt: typeof run.acceptedAt === "number" ? run.acceptedAt : 0,
      updatedAt: typeof run.updatedAt === "number" ? run.updatedAt : undefined,
      // O9 reconciliation on read: stored voice runs left "unknown" with a final transcript become terminal,
      // and the next registry write persists it (no migration job, no second store).
      state: run.modality === "voice" && ["completed", "interrupted"].includes(run.transcriptState)
        ? voiceRunState(run.transcriptState)
        : ["running", "done", "failed", "unknown"].includes(String(run.state || ""))
        ? run.state
        : undefined,
      error: typeof run.error === "string" ? run.error : undefined,
      result: typeof run.result === "string" ? run.result : undefined,
      modality: run.modality === "voice" ? "voice" : undefined,
      transcriptState: ["partial", "completed", "interrupted"].includes(run.transcriptState) ? run.transcriptState : undefined,
      transcriptRevision: Number.isSafeInteger(run.transcriptRevision) ? run.transcriptRevision : undefined,
      playback: run.playback ? validateVoicePlayback(run.playback) : undefined,
      notThis: run.notThis ? validRunCorrection(run.notThis) : undefined,
      replayOf: validReplayLink(run.replayOf),
      supersededBy: validReplayLink(run.supersededBy),
      ownerAdmitted: run.ownerAdmitted === true ? true as const : undefined,
      ownerTransport: OWNER_TRANSPORTS.has(String(run.ownerTransport || "")) ? run.ownerTransport : undefined,
      gatewayObservation: readGatewayObservation(run.gatewayObservation),
      gatewayProgress: readGatewayProgress(run.gatewayProgress),
      reasonClass: publicReasonClass(run.reasonClass),
    }));
  // HS3: a run that handed off to a payment request shows that request's state (read-time projection only).
  for (const run of parsedRuns) {
    if (run.modality === "voice" || run.executionSource !== "capability_first") continue;
    const projected = projectRunPayment(run, paymentRequests, ownerConfirmations);
    if (projected) run.paymentPresentation = projected;
  }
  return {archivedSessionIds, paymentRequests, ownerConfirmations, runDeletions, runs: parsedRuns};
}

async function readArchivedSessionIds(): Promise<Set<string>> {
  const registry = await registryOrEmpty();
  return new Set(registry.archivedSessionIds);
}

function defaultCompanionRunRegistry(): CompanionRunRegistry {
  return { runs: [], archivedSessionIds: [], paymentRequests: [], ownerConfirmations: [], runDeletions: [] };
}

function runRegistryPath() {
  return path.join(openClawStateDir(), "clawmobile-companion", "runs.json");
}


function requireConversationId(value: string) {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(value)) throw Object.assign(new Error("invalid_session_id"), {statusCode: 400});
  return value;
}

/** Transcript upsert only. Never executes an intent or accepts audio. Uses the existing runs registry. */
// Android v2 names Samantha's opening greeting `voice-greeting-<uuid>` (no user input, output only).
// Refusing it left that turn in the app's pending queue and blocked every later voice start (17/10).
// Deferred native readback is also output-only and uses the closed `voice-readback-<uuid>` shape.
export const VOICE_TURN_ID_RE = /^voice-(?:(?:greeting|readback)-)?[a-f0-9-]{36}$/;

export async function saveVoiceTurn(sessionId: string, value: any) {
  requireConversationId(sessionId);
  const allowed = new Set(["runId", "revision", "input", "output", "state", "playback"]);
  if (!value || Object.keys(value).some(key => !allowed.has(key)) ||
      !VOICE_TURN_ID_RE.test(value.runId || "") || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.input !== "string" || typeof value.output !== "string" ||
      value.input.length > 12000 || value.output.length > 24000 ||
      !["partial", "completed", "interrupted"].includes(value.state)) {
    throw Object.assign(new Error("invalid_voice_transcript"), {statusCode: 400});
  }
  const playback=validateVoicePlayback(value.playback);
  return mutateRegistry(async () => {
    const registry = await registryOrEmpty();
    if (registry.runDeletions.some(receipt => receipt.runId === value.runId)) throw Object.assign(new Error("run_deleted"), {statusCode: 409});
    if (registry.archivedSessionIds.includes(sessionId)) throw Object.assign(new Error("session_archived"), {statusCode: 409});
    const old = registry.runs.find(run => run.runId === value.runId);
    if (old && (old.sessionId !== sessionId || old.modality !== "voice")) throw Object.assign(new Error("turn_identity_conflict"), {statusCode: 409});
    if (old && (old.transcriptRevision || 0) >= value.revision) return statusFromStoredRun(old);
    if (old && old.transcriptState !== "partial") {
      const amendment=old.playback&&playback&&old.playback.state!=="completed"&&old.playback.state!=="interrupted"&&
        old.playback.outputGenerationId===playback.outputGenerationId&&old.userText===value.input&&old.result===value.output&&
        value.state==="interrupted"&&playback.state==="interrupted";
      if(!amendment)throw Object.assign(new Error("turn_already_final"), {statusCode:409});
    }
    const run: StoredRun = {runId: value.runId, sessionId, text: value.input, userText: value.input,
      result: value.output, modality: "voice", transcriptState: value.state, transcriptRevision: value.revision,playback,
      acceptedAt: old?.acceptedAt || Date.now(), updatedAt: Date.now(), state: voiceRunState(value.state)};
    await writeCompanionRunRegistry([run, ...registry.runs.filter(row => row.runId !== run.runId)], registry.archivedSessionIds);
    submittedRuns.set(run.runId,run);
    return statusFromStoredRun(run);
  });
}

/** A text fragment is not a terminal result. Only a unique, explicitly stopped turn qualifies. */
export function terminalConversationResult(raw:string, target:string):{result:string;endedAt?:number}|undefined {
  const messages=raw.split(/\r?\n/).flatMap(line=>{
    try{const v=JSON.parse(line);return v.type==="message"?[v]:[];}catch{return [];}
  });
  const matches=messages.map((v,i)=>v.message?.role==="user"&&stripOpenClawTimestamp(contentText(v.message.content))===target?i:-1).filter(i=>i>=0);
  if(matches.length!==1)return undefined;
  let end=messages.findIndex((v,i)=>i>matches[0]&&v.message?.role==="user");if(end<0)end=messages.length;
  const turn=messages.slice(matches[0]+1,end),last=turn[turn.length-1];
  if(last?.message?.role!=="assistant"||last.message.stopReason!=="stop")return undefined;
  if(Array.isArray(last.message.content)&&last.message.content.some((c:any)=>c?.type==="toolCall"))return undefined;
  const result=contentText(last.message.content);
  return result?{result,endedAt:messageTimestamp(last)}:undefined;
}

function runIdentity(run:StoredRun){return JSON.stringify([run.runId,run.sessionId,run.acceptedAt,run.updatedAt,run.state,run.result,run.text,run.executionSource,run.modality,run.transcriptRevision]);}

export async function getConversationTurns(sessionId: string) {
  requireConversationId(sessionId);
  await registryWrite;
  const stored=(await readStoredRuns()).filter(run=>run.sessionId===sessionId).slice(0,40).reverse();
  if(stored.some(run=>run.gatewayObservation?.epoch===GATEWAY_OBSERVER_EPOCH&&run.gatewayObservation.state==="following"&&Date.now()<run.gatewayObservation.deadlineAt))return stored.map(observedRunStatus);
  const unresolved=stored.filter(run=>!run.gatewayObservation&&run.modality!=="voice"&&run.executionSource!=="capability_first"&&!run.result&&(run.state!=="failed"||run.error==="run_inactivity_expired"));
  if(!unresolved.length)return stored.map(statusFromStoredRun);
  const history=await callOpenClawGateway("chat.history",{sessionKey:expectedCompanionSessionKey(sessionId),limit:200});
  const raw=(Array.isArray(history?.messages)?history.messages:[]).map((message:any)=>JSON.stringify({type:"message",message,timestamp:message.timestamp})).join("\n");
  const proofs=unresolved.flatMap<{before:StoredRun;result?:string;endedAt?:number;activeEvidenceAt?:number}>(run=>{
    // Repeated equal requests require a stronger owner correlation, never guess the last match.
    if(stored.filter(x=>x.text===run.text).length!==1)return [];
    if(run.error==="run_inactivity_expired"){
      const evidence=ownerTurnEvidence(history?.messages,run.text,Date.now());
      if(!evidence||Math.abs(evidence.startedAt-run.acceptedAt)>30000)return [];
      if(evidence.outstandingTool||evidence.lastAt>(run.updatedAt||run.acceptedAt)){
        const terminal=terminalConversationResult(raw,run.text);
        if(!terminal||evidence.outstandingTool)return [{before:run,activeEvidenceAt:evidence.lastAt}];
      }
    }
    const proof=terminalConversationResult(raw,run.text);
    return proof?[{before:run,...proof}]:[];
  });
  if(proofs.length)await backfillConversationResults(sessionId,proofs);
  // A concurrent delete/archive/revision wins over the old read and its candidate proof.
  await registryWrite;
  return (await readStoredRuns()).filter(run=>run.sessionId===sessionId).slice(0,40).reverse().map(statusFromStoredRun);
}

async function backfillConversationResults(sessionId:string,proofs:{before:StoredRun;result?:string;endedAt?:number;activeEvidenceAt?:number}[]) {
  await mutateRegistry(async()=>{
    const registry=await registryOrEmpty();
    if(registry.archivedSessionIds.includes(sessionId))return;
    const byId=new Map(proofs.map(p=>[p.before.runId,p]));const updates:StoredRun[]=[];
    const next=registry.runs.map(run=>{
      const proof=byId.get(run.runId);
      if(!proof||run.sessionId!==sessionId||run.modality==="voice"||run.result||(run.state==="failed"&&run.error!=="run_inactivity_expired")||(run.error==="run_inactivity_expired"&&protectedRun(run,registry.paymentRequests,registry.ownerConfirmations))||runIdentity(run)!==runIdentity(proof.before))return run;
      const nextState=proof.result?"done" as const:"running" as const;
      const updated={...run,result:proof.result,state:nextState,error:undefined,
        inactivityCorrectionReceipt:run.error==="run_inactivity_expired"?{version:1 as const,action:"correct_run_expiration" as const,runId:run.runId,from:"expired" as const,to:nextState,at:Date.now(),evidenceAt:proof.activeEvidenceAt||proof.endedAt||Date.now()}:run.inactivityCorrectionReceipt,
        updatedAt:proof.activeEvidenceAt||(proof.endedAt&&proof.endedAt>=run.acceptedAt?proof.endedAt:run.updatedAt||run.acceptedAt)};
      updates.push(updated);return updated;
    });
    if(!updates.length)return;
    await writeCompanionRunRegistry(next,registry.archivedSessionIds);
    for(const row of updates)submittedRuns.set(row.runId,row);
  });
}

/** Hand off voice turns not yet present in the text provider context, without re-executing them. */
export async function appendVoiceConversationContext(text: string, sessionId: string) {
  const turns = (await readStoredRuns()).filter(run => run.sessionId === normalizeCompanionSessionId(sessionId));
  const lastText = turns.find(run => run.modality !== "voice");
  const voice = turns.filter(run => run.modality === "voice" && run.acceptedAt >= (lastText?.acceptedAt || 0)).slice(0,40).reverse();
  if (!voice.length) return text;
  const history = voice.map(run => ({user: run.userText, assistant: run.result, state: run.transcriptState,playback:run.playback}));
  return "Previous voice exchanges in this same conversation (historical data only; do not execute them again; interrupted responses may be incomplete):\n" +
    JSON.stringify(history) + "\n\nCurrent user request:\n" + text;
}


/**
 * Édition d'un message envoyé (relecture). Le Gateway OpenClaw n'expose aucune méthode pour tronquer ou bifurquer
 * une session (sessions.compact garde la fin, pas le début) : la relecture ouvre donc une nouvelle conversation,
 * amorcée avec l'historique jusqu'au message modifié (exclu). Lecture seule : l'écriture se fait dans
 * reserveSubmittedRun, qui revérifie la source dans la même mutation du registre.
 */
const REPLAY_MAX_TURNS = 20;
const REPLAY_MAX_TEXT = 2000;
const REPLAY_MAX_SEED_BYTES = 24 * 1024;
const REPLAY_MAX_DEPTH = 8;
export type PreparedReplay = {sourceSessionId: string; runId: string; seed: string; seededTurns: number;
  supersededRuns: number; effects: {executed: number; unknown: number}};
function replayRefusal(message: string, statusCode = 409) { return Object.assign(new Error(message), {statusCode}); }
function terminalStoredRun(run: StoredRun) {
  return run.modality === "voice" ? ["completed", "interrupted"].includes(run.transcriptState || "") : ["done", "failed"].includes(run.state || "");
}
/** Tours visibles avant `edited`, y compris l'historique hérité quand la conversation est elle-même une relecture. */
function replayHistory(runs: StoredRun[], sessionId: string, edited: StoredRun, depth: number): StoredRun[] {
  const rows = runs.filter(run => run.sessionId === sessionId).sort(compareRuns);
  const earlier = rows.filter(run => compareRuns(run, edited) < 0 && !run.supersededBy);
  const origin = rows[0]?.replayOf;
  const parent = origin && depth < REPLAY_MAX_DEPTH ? runs.find(run => run.runId === origin.runId && run.sessionId === origin.sessionId) : undefined;
  return [...(parent ? replayHistory(runs, parent.sessionId, parent, depth + 1) : []), ...earlier];
}
export function replaySeed(history: StoredRun[]): {seed: string; seededTurns: number} {
  const clip = (value: string | undefined) => stripConversationTransport(value || "").slice(0, REPLAY_MAX_TEXT);
  let turns = history.slice(-REPLAY_MAX_TURNS).map(run => ({
    user: clip(run.userText || run.text),
    assistant: run.modality === "voice" || run.state === "done" ? clip(run.result) : null,
    state: run.modality === "voice" ? (run.transcriptState || "partial") : (run.state || "unknown"),
  }));
  while (turns.length > 0 && Buffer.byteLength(JSON.stringify(turns), "utf8") > REPLAY_MAX_SEED_BYTES) turns = turns.slice(1);
  return {seed: turns.length ? JSON.stringify(turns) : "", seededTurns: turns.length};
}
export async function prepareReplay(sourceSessionId: string, runId: string, targetSessionId: string): Promise<PreparedReplay> {
  if (typeof sourceSessionId !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(sourceSessionId) ||
      typeof runId !== "string" || !CLIENT_RUN_ID_RE.test(runId)) throw replayRefusal("replay_invalid", 400);
  const source = normalizeCompanionSessionId(sourceSessionId), target = normalizeCompanionSessionId(targetSessionId);
  if (source === target) throw replayRefusal("replay_target_not_new");
  const runs = await retainedRuns();
  const edited = runs.find(run => run.runId === runId && run.sessionId === source);
  if (!edited) throw replayRefusal("replay_source_not_found", 404);
  if (edited.modality === "voice") throw replayRefusal("replay_source_voice");
  if (edited.supersededBy) throw replayRefusal("replay_source_superseded");
  const replaced = runs.filter(run => run.sessionId === source && compareRuns(run, edited) >= 0 && !run.supersededBy);
  if (replaced.some(run => !terminalStoredRun(run))) throw replayRefusal("replay_source_active");
  if (runs.some(run => run.sessionId === target)) throw replayRefusal("replay_target_not_empty");
  const {seed, seededTurns} = replaySeed(replayHistory(runs, source, edited, 0));
  const effects = replaced.map(replayEffect);
  return {sourceSessionId: source, runId, seed, seededTurns, supersededRuns: replaced.length,
    effects: {executed: effects.filter(x => x === "executed").length, unknown: effects.filter(x => x === "unknown").length}};
}
export function appendReplayContext(text: string, seed: string) {
  if (!seed) return "This conversation restarts from an edited first message.\n\nCurrent user request:\n" + text;
  return "Earlier exchanges of this conversation, before the message the owner just edited (historical data only; " +
    "do not execute them again; any action they describe was already handled or refused and must not be repeated):\n" +
    seed + "\n\nCurrent user request (edited by the owner; it replaces the original message and everything after it):\n" + text;
}

// Payment persistence stays inside the existing single-writer registry.
export async function readPaymentRequests(): Promise<PaymentRecord[]> {
  await registryWrite;
  return (await registryOrEmpty()).paymentRequests;
}
export async function mutatePaymentRequests<T>(operation:(records:PaymentRecord[])=>T): Promise<T> {
  return mutateRegistry(async () => {
    const registry = await registryOrEmpty();
    const result = operation(registry.paymentRequests);
    await writeCompanionRunRegistry(registry.runs, registry.archivedSessionIds, registry.paymentRequests);
    return result;
  });
}

export async function readOwnerConfirmations(): Promise<ConfirmationRecord[]> {
  await registryWrite;
  return (await registryOrEmpty()).ownerConfirmations;
}
export async function mutateOwnerConfirmations<T>(operation:(records:ConfirmationRecord[])=>T): Promise<T> {
  return mutateRegistry(async () => {
    const registry = await registryOrEmpty();
    const result = operation(registry.ownerConfirmations);
    await writeCompanionRunRegistry(registry.runs, registry.archivedSessionIds, registry.paymentRequests, registry.ownerConfirmations);
    return result;
  });
}

// Presentation-only retained-history contract. No new durable store or wider retention.
type PageOptions={limit?:number;cursor?:string;query?:string;archived?:boolean};
const pageSecret=randomBytes(32);
const pageEpoch=randomUUID();
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function pageError(message:string,statusCode=409){return Object.assign(new Error(message),{statusCode});}
function normalizedPageOptions(options:PageOptions){
  const limit=options.limit??20,query=options.query??"";
  if(options.archived!==undefined&&typeof options.archived!=="boolean")throw pageError("invalid_pagination",400);
  if(!Number.isSafeInteger(limit)||limit<1||limit>40||query.length>512||(options.cursor?.length??0)>2048)throw pageError("invalid_pagination",400);
  return {limit,query,cursor:options.cursor};
}
function pageScope(view:string,query:string,limit:number){return digest(["native-loopback",openClawStateDir(),agentId(),2,view,query,limit]);}
function cursorFor(scope:string,revision:string,anchor:string){
  const payload=Buffer.from(JSON.stringify({v:2,epoch:pageEpoch,scope,revision,anchor,createdAt:Date.now()})).toString("base64url");
  return payload+"."+createHmac("sha256",pageSecret).update(payload).digest("base64url");
}
function cursorAnchor(cursor:string|undefined,scope:string,revision:string):string|undefined {
  if(!cursor)return undefined;
  const parts=cursor.split(".");
  if(parts.length!==2)throw pageError("invalid_pagination",400);
  const expected=createHmac("sha256",pageSecret).update(parts[0]).digest();
  let signature:Buffer,value:any;
  try{signature=Buffer.from(parts[1],"base64url");value=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));}catch{throw pageError("invalid_pagination",400);}
  if(signature.length!==expected.length||!timingSafeEqual(signature,expected)||value.epoch!==pageEpoch||value.scope!==scope||value.revision!==revision||value.v!==2||typeof value.anchor!=="string"||!Number.isFinite(value.createdAt)||Date.now()-value.createdAt>900000)
    throw pageError("pagination_invalidated");
  return value.anchor;
}
async function retainedRuns(archiveScope:boolean|null=false):Promise<StoredRun[]> {
  reconcileInactiveRuns();
  await registryWrite;
  const registry=await registryOrEmpty(),archived=new Set(registry.archivedSessionIds);
  return registry.runs.filter(x=>!x.measurementOnly&&(archiveScope===null||archived.has(x.sessionId)===archiveScope)).sort((a,b)=>b.acceptedAt-a.acceptedAt||a.runId.localeCompare(b.runId));
}

/** The Companion's own retained view of one conversation (no Gateway read). */
export async function retainedConversation(sessionId:string):Promise<{runCount:number;lastActivityAt:number|null}|null>{
  const rows=(await retainedRuns()).filter(run=>run.sessionId===sessionId);
  if(!rows.length)return null;
  const at=rows[0].updatedAt||rows[0].acceptedAt;
  return {runCount:rows.length,lastActivityAt:Number.isSafeInteger(at)&&at>0?at:null};
}

const previewSecret=/(?:token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|otp|cvv|cvc|pin|iban|card|bearer|amount|montant|price|prix|balance|solde|total|cost|phone|email|mail)/i;
const previewKey=/^[A-Za-z][A-Za-z0-9_]{0,40}$/;
/**
 * A tool/operation result stored as JSON ({"ok":true,"provider":…}) is not a
 * conversation preview: show a short readable summary instead of raw JSON.
 * Only short scalar fields with plain keys are kept; nothing that looks like an
 * address, a number sequence, a URL or a credential.
 */
export function readablePreview(raw:string,max=140):string{
  const text=(raw||"").trim();
  if(!text.startsWith("{")&&!text.startsWith("["))return (raw||"").slice(0,max);
  let value:any;
  try{value=JSON.parse(text);}catch{return "Résultat technique";}
  if(!value||typeof value!=="object"||Array.isArray(value))return "Résultat technique";
  const ok=value.ok??value.success;
  const head=ok===true?"Action terminée":ok===false?"Action en échec":"Résultat technique";
  const parts:string[]=[];
  for(const [key,item] of Object.entries(value)){
    if(parts.length>=3)break;
    if(["ok","success"].includes(key)||!previewKey.test(key)||previewSecret.test(key))continue;
    let shown:string|null=null;
    if(typeof item==="boolean")shown=item?"oui":"non";
    else if(typeof item==="number"&&Number.isFinite(item)&&Math.abs(item)<1e6)shown=String(item);
    else if(typeof item==="string"&&item.length>0&&item.length<=40&&!/[@:/\\]|\d{6,}|[\p{C}]/u.test(item)&&!previewSecret.test(item))shown=item;
    if(shown!==null)parts.push(key.replace(/_/g," ")+" : "+shown);
  }
  return [head,...parts].join(" · ").slice(0,max);
}

export async function conversationSummariesPage(options:PageOptions={}){
  const {limit,query,cursor}=normalizedPageOptions(options);
  const archiveScope=options.archived===true;
  const runs=await retainedRuns(archiveScope);const grouped=new Map<string,StoredRun[]>();
  // Background single-flight refresh; pagination never waits on a Gateway process.
  const following=runs.some(run=>run.gatewayObservation?.epoch===GATEWAY_OBSERVER_EPOCH&&run.gatewayObservation.state==="following"&&Date.now()<run.gatewayObservation.deadlineAt);
  const ownerIndex=runs.length?conversationOwnerIndex({refresh:!following}):{rows:new Map<string,any>(),state:'pending'};
  const metadata=ownerIndex.rows;
  for(const run of runs){const rows=grouped.get(run.sessionId)||[];rows.push(run);grouped.set(run.sessionId,rows);}
  const items=[...grouped.entries()].filter(([,rows])=>!query||rows.some(r=>(r.userText||r.text||"").toLocaleLowerCase().includes(query.toLocaleLowerCase())||(r.result||"").toLocaleLowerCase().includes(query.toLocaleLowerCase())))
    .map(([sessionId,rows])=>{
      const latest=rows[0],status=statusFromStoredRun(latest),owner:any=metadata.get(latest.sessionKey||expectedCompanionSessionKey(sessionId));
      const title=typeof owner?.label==='string'&&owner.label.length<=160&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(owner.label)?owner.label:null;
      const pinned=typeof owner?.pinned==='boolean'?owner.pinned:null;
      // First retained authentic request; routed prompt, assistant text and catalogue labels are not title evidence.
      const original=[...rows].reverse().find(row=>typeof row.userText==='string'&&row.userText.trim().length>0);
      const titlePreview=(original?.userText||'').slice(0,160);
      return {sessionId,archived:archiveScope,title,pinned,metadataSource:owner?'gateway_sessions_list':null,lastRunId:latest.runId,titlePreview,
        lastResultPreview:readablePreview(latest.result||""),lastRunState:status.state,
        lastActivityAt:latest.updatedAt||latest.acceptedAt,sortAt:latest.acceptedAt,
        modality:latest.modality||"text",transcriptState:latest.transcriptState||"",
        availableTurnCount:rows.length,previewTruncated:(!/^\s*[{\[]/.test(latest.result||"")&&(latest.result?.length||0)>140)||(original?.userText||"").length>160};
    }).sort((a,b)=>b.sortAt-a.sortAt||a.sessionId.localeCompare(b.sessionId));
  const revision=digest({archived:archiveScope,items,retainedRunCount:runs.length,availableConversations:grouped.size}),scope=pageScope("conversations:"+(archiveScope?"archived":"active"),query,limit),anchor=cursorAnchor(cursor,scope,revision);
  const index=anchor?items.findIndex(x=>x.sessionId===anchor):-1;
  if(anchor&&index<0)throw pageError("pagination_invalidated");
  const start=index+1,page=items.slice(start,start+limit),more=start+page.length<items.length;
  return {schemaVersion:2,resourceKey:"conversations",dataRevision:revision,items:page.map(({sortAt,...row})=>row),
    nextCursor:more?cursorFor(scope,revision,page[page.length-1].sessionId):null,
    hasMore:more,coverage:{source:"companion_retained_registry",fullHistory:false,retainedRunCount:runs.length,
      availableConversations:grouped.size,matchingConversations:items.length,metadataState:ownerIndex.state,persistedRunLimit:MAX_PERSISTED_RUNS,persistedRunBytesLimit:MAX_PERSISTED_RUN_BYTES},sort:"latest_accepted_desc_session_id_asc"};
}
export async function conversationTurnsPage(sessionId:string,options:PageOptions={}){
  requireConversationId(sessionId);const {limit,cursor}=normalizedPageOptions(options);
  if(options.query||options.archived!==undefined)throw pageError("unsupported_turn_query",400);
  // Keep the canonical full preparation path separate from this UI page.
  let partial=false;
  if(!cursor)try{await getConversationTurns(sessionId);}catch{partial=true;}
  const all=(await retainedRuns(null)).filter(x=>x.sessionId===sessionId).sort((a,b)=>a.acceptedAt-b.acceptedAt||a.runId.localeCompare(b.runId));
  const revision=digest(all.map(statusFromStoredRun));
  const scope=pageScope("turns:"+sessionId,"",limit),anchor=cursorAnchor(cursor,scope,revision);
  const end=anchor?all.findIndex(x=>x.runId===anchor):all.length;
  if(end<0)throw pageError("pagination_invalidated");
  const start=Math.max(0,end-limit),selected=all.slice(start,end);
  return {schemaVersion:2,resourceKey:"turns/"+sessionId,sessionId,dataRevision:revision,
    turns:selected.map(statusFromStoredRun),hasMore:start>0,partial,
    issues:partial?["history_resolution_unavailable"]:[],
    nextCursor:start>0?cursorFor(scope,revision,selected[0].runId):null,
    coverage:{source:"companion_retained_registry",fullHistory:false,availableTurnCount:all.length,
      unresolvedResults:selected.filter(r=>r.modality!=="voice"&&!r.result).length,persistedRunLimit:MAX_PERSISTED_RUNS,persistedRunBytesLimit:MAX_PERSISTED_RUN_BYTES},sort:"accepted_asc_run_id_asc"};
}

type ConversationChange={id:string;epoch:string;sequence:number;scope:"conversations";sessionIds:string[];resyncRequired:boolean};
const changeEpoch=randomUUID();let changeSequence=0;
const changeRing:ConversationChange[]=[];
const changeListeners=new Set<(event:ConversationChange)=>void>();
function publishConversationChanges(before:StoredRun[],after:StoredRun[],oldArchived:string[],newArchived:string[]){
  const left=new Map(before.filter(r=>!r.measurementOnly).map(r=>[r.runId,r])),right=new Map(after.filter(r=>!r.measurementOnly).map(r=>[r.runId,r]));
  const sessions=new Set<string>();
  for(const id of new Set([...left.keys(),...right.keys()])){
    const a=left.get(id),b=right.get(id);
    const terminal=(run:StoredRun|undefined)=>!!run&&(run.modality==='voice'?['completed','interrupted'].includes(run.transcriptState||''):['done','failed'].includes(run.state||''));
    if(b&&terminal(b)&&!terminal(a))invalidateConversationOwner(expectedCompanionSessionKey(b.sessionId));
    if(JSON.stringify(a)!==JSON.stringify(b)){if(a)sessions.add(a.sessionId);if(b)sessions.add(b.sessionId);}
  }
  for(const id of new Set([...oldArchived,...newArchived]))if(oldArchived.includes(id)!==newArchived.includes(id))sessions.add(id);
  if(!sessions.size)return;
  const tooMany=sessions.size>32;
  const sequence=++changeSequence;
  const event:ConversationChange={id:changeEpoch+":"+sequence,epoch:changeEpoch,sequence,scope:"conversations",sessionIds:tooMany?[]:[...sessions],resyncRequired:tooMany};
  changeRing.push(event);while(changeRing.length>128)changeRing.shift();
  for(const listener of [...changeListeners]){try{listener(event);}catch{changeListeners.delete(listener);}}
}
export function subscribeConversationChanges(listener:(event:ConversationChange)=>void,lastId?:string){
  if(changeListeners.size>=4)throw pageError("conversation_stream_busy",429);
  changeListeners.add(listener);
  const current={epoch:changeEpoch,sequence:changeSequence,id:changeEpoch+":"+changeSequence};
  let replay:ConversationChange[]=[];let resyncRequired=false;
  if(lastId){
    const prefix=changeEpoch+":";const number=lastId.startsWith(prefix)?Number(lastId.slice(prefix.length)):-1;
    if(!Number.isSafeInteger(number)||number<0||number>changeSequence||number<(changeRing[0]?.sequence??changeSequence)-1)resyncRequired=true;
    else replay=changeRing.filter(e=>e.sequence>number);
  }
  return {current,replay,resyncRequired,close:()=>changeListeners.delete(listener)};
}

export async function protectedAttachmentPaths(){return new Set((await registryOrEmpty()).runs.flatMap(row=>(row.attachments||[]).map(x=>x.serverPath||x.path||"")));}

export async function withAttachmentReferences<T>(effect:(paths:Set<string>)=>T):Promise<T>{
 return mutateRegistry(async()=>{
  const registry=await registryOrEmpty(), now=Date.now();
  // Canonical audio expiry comes from fstat upload mtime, reconstructed by HTTP.
  const expiredPaths:string[]=[];
  const runs=registry.runs.map(row=>{
   if(!row.memo||!(row.attachments||[]).some(a=>a.mimeType==='audio/mp4'&&typeof a.expiresAt==='number'&&Number.isFinite(a.expiresAt)&&a.expiresAt<=now))return row;
   expiredPaths.push(...(row.attachments||[]).map(a=>a.serverPath||a.path||''));
   const next:StoredRun={...row,attachments:undefined,updatedAt:now,
    state:row.memo.phase==='dispatched'?row.state:'failed',error:row.state==='failed'?row.error:row.memo.phase==='dispatched'?row.error:'Le mémo vocal a expiré.',
    memo:{...row.memo,nextAttemptAt:undefined}};
   submittedRuns.set(row.runId,next);return next;
  });
  const protectedPaths=new Set(runs.flatMap(row=>(row.attachments||[]).map(x=>x.serverPath||x.path||'')));
  if(expiredPaths.length)removeAttachments(expiredPaths,protectedPaths);
  if(runs.some((r,i)=>r!==registry.runs[i]))await writeCompanionRunRegistry(runs,registry.archivedSessionIds);
  return effect(protectedPaths);
 });
}

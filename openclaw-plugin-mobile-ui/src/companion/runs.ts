import {runProgressSteps} from "./runProgress";
import {readReceiptPresentation,fallbackReceiptPresentation,publicReceiptMetadata,publicDecision,type ReceiptPresentation} from "./receiptPresentation";
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
import type { CompanionRunProgress, CompanionRunProgressEvent, CompanionRunStatus, CompanionRunTokenUsage, IntentAttachment } from "./types";

type StoredRun = {
  presentation?: ReceiptPresentation;
  inactivityCorrectionReceipt?: InactivityReceipt;
  runId: string;
  clientRunId?: string;
  requestHash?: string;
  executionSource?: "gateway" | "capability_first";
  decision?: Record<string, unknown>;
  clarificationState?: "pending" | "resolved" | "abandoned";
  clarificationExpiresAt?: number;
  parentClarificationRunId?: string;
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
};

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
) {
  return createHash("sha256").update(JSON.stringify({
    text,
    sessionId,
    userText,
    attachments,
  })).digest("hex");
}

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
  } = {},
): Promise<{ created: boolean; status: CompanionRunStatus }> {
  const clientId = requireClientRunId(clientRunId);
  const normalizedSessionId = normalizeCompanionSessionId(sessionId || "default");
  const userText = String(options.userText || text);
  const attachments = options.attachments || [];
  const requestHash = submissionRequestHash(options.requestText || text, normalizedSessionId, userText, attachments);

  return mutateRegistry(async () => {
    const registry = await registryOrEmpty();
    if (registry.runDeletions.some(receipt => receipt.clientRunId === clientId))
      throw Object.assign(new Error("run_deleted"), {statusCode: 409});
    const existing = registry.runs.find((run) => run.clientRunId === clientId);
    if (existing) {
      const expectedSource = options.executionSource || existing.executionSource || "gateway";
      if (existing.requestHash !== requestHash || existing.sessionId !== normalizedSessionId ||
          (existing.executionSource || "gateway") !== expectedSource) {
        throw Object.assign(new Error("client_run_identity_conflict"), { statusCode: 409 });
      }
      submittedRuns.set(existing.runId, existing);
      return { created: false, status: statusFromStoredRun(existing) };
    }

    const now = Date.now();
    const stored: StoredRun = {
      runId: `run_${now}_${randomBytes(4).toString("hex")}`,
      clientRunId: clientId,
      requestHash,
      executionSource: options.executionSource || "gateway",
      presentation: options.executionSource === "capability_first" ? fallbackReceiptPresentation() : undefined,
      decision: options.decision && typeof options.decision === "object" ? options.decision : undefined,
      clarificationState: String(options.decision?.type || "") === "CLARIFY" ? "pending" : undefined,
      clarificationExpiresAt: String(options.decision?.type || "") === "CLARIFY" ? now + 10 * 60 * 1000 : undefined,
      parentClarificationRunId: options.parentClarificationRunId,
      sessionId: normalizedSessionId,
      sessionKey: expectedCompanionSessionKey(normalizedSessionId),
      text,
      userText,
      attachments: attachments.length > 0 ? attachments : undefined,
      acceptedAt: now,
      updatedAt: now,
      state: "running",
    };
    const next = retainStoredRuns([stored, ...registry.runs]);
    const archivedSessionIds = registry.archivedSessionIds.filter((id) => id !== normalizedSessionId);
    submittedRuns.set(stored.runId, stored);
    await writeCompanionRunRegistry(next, archivedSessionIds);
    return { created: true, status: statusFromStoredRun(stored) };
  });
}

export async function rememberSubmittedRun(
  text: string,
  result: OpenClawAgentSubmitResult,
  options: { userText?: string; attachments?: IntentAttachment[]; executionSource?: "gateway" | "capability_first"; decision?: Record<string, unknown>; parentClarificationRunId?: string } = {},
) {
  const existing = submittedRuns.get(result.runId)
    || (await findStoredRun(result.runId).catch(() => null));
  const stored = {
    ...existing,
    executionSource: options.executionSource || existing?.executionSource || "gateway",
    presentation: existing?.presentation || (options.executionSource === "capability_first" ? fallbackReceiptPresentation() : undefined),
    runId: result.runId,
    sessionId: result.sessionId,
    sessionKey: normalizedStoredSessionKey(result.sessionId, result.sessionKey),
    text,
    userText: options.userText || existing?.userText,
    attachments: options.attachments && options.attachments.length > 0 ? options.attachments : existing?.attachments,
    decision: options.decision || existing?.decision,
    clarificationState: String(options.decision?.type || existing?.decision?.type || "") === "CLARIFY" ? (existing?.clarificationState || "pending") : existing?.clarificationState,
    clarificationExpiresAt: String(options.decision?.type || existing?.decision?.type || "") === "CLARIFY" ? (existing?.clarificationExpiresAt || Date.now() + 10 * 60 * 1000) : existing?.clarificationExpiresAt,
    parentClarificationRunId: options.parentClarificationRunId || existing?.parentClarificationRunId,
    acceptedAt: existing?.acceptedAt || result.acceptedAt || Date.now(),
    updatedAt: Date.now(),
    state: "running" as const,
    error: undefined,
  };
  submittedRuns.set(result.runId, stored);
  await saveStoredRun(stored).catch(() => undefined);
}

export async function settleSubmittedRun(
  runId: string,
  state: "done" | "failed",
  result: string,
  metadata?: unknown,
) {
  const existing = submittedRuns.get(runId)
    || (await findStoredRun(runId).catch(() => null));
  if (!existing) return;
  const stored: StoredRun = {
    ...existing,
    state,
    presentation: readReceiptPresentation(metadata) || (existing.executionSource === "capability_first" ? fallbackReceiptPresentation(state === "failed") : existing.presentation),
    inactivityCorrectionReceipt: state === "done" && (existing.error === "run_inactivity_expired" || existing.inactivityCorrectionReceipt?.to === "running") ? {
      version: 1, action: "correct_run_expiration", runId, from: "expired", to: "done",
      at: Date.now(), evidenceAt: Date.now(),
    } : existing.inactivityCorrectionReceipt,
    result: state === "done" ? result : undefined,
    error: state === "failed" ? result : undefined,
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
    updatedAt: Date.now(),
  };
  submittedRuns.set(runId, stored);
  await saveStoredRun(stored).catch(() => undefined);
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
  await writeCompanionRunRegistry(nextRuns, archivedSessionIds);

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
  if (invalid) console.warn("companion: invalid_run_deletion_receipts_ignored count=" + invalid);
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
    return storedRuns.slice(0, limit).map(statusFromStoredRun);
  }
  // Legacy/no-registry fallback only. Normal Samantha history uses the existing registry and avoids
  // sessions.list, transcript and trajectory enrichment on every visible list refresh.
  return listRuns({ limit });
}

const LIST_LIVE_REFRESH_MAX=3;
const LIST_LIVE_REFRESH_BUDGET_MS=2500;

export async function listRuns(options: { limit?: number } = {}): Promise<CompanionRunStatus[]> {
  const storedRuns = await readStoredRuns(false);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
  reconcileInactiveRuns();
  if(storedRuns.length){
    const visible=storedRuns.slice(0,limit);
    const sessions=visible.some(requiresLiveRefresh)?await readSessionsIndex().catch(()=>[]):[];
    // Each transcript read is one `openclaw gateway call` process on the S24 (~2.4 s): a list refreshes at most
    // LIST_LIVE_REFRESH_MAX runs (newest first) within one shared budget; the others keep the sessions-index view.
    let refreshes=LIST_LIVE_REFRESH_MAX;
    const deadline=Date.now()+LIST_LIVE_REFRESH_BUDGET_MS;
    return Promise.all(visible.map(async stored=>{
      if(!requiresLiveRefresh(stored))return statusFromStoredRun(stored);
      const session=findSessionForStoredRun(sessions,stored);
      const fallback=session?statusFromSessionInfo(session,stored.runId,stored):statusFromStoredRun(stored);
      if(refreshes<=0)return fallback;
      refreshes--;
      // Preserve the normal live-list refresh from the base; only expiration
      // evidence moved out of the request path.
      let timer:ReturnType<typeof setTimeout>|undefined;
      const late=new Promise<CompanionRunStatus>(resolve=>{timer=setTimeout(()=>resolve(fallback),Math.max(0,deadline-Date.now()));timer.unref?.();});
      return Promise.race([enrichFromSessionFile(fallback,session,stored,true).catch(()=>fallback),late]).finally(()=>clearTimeout(timer));
    }));
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

export async function findPendingClarificationRun(sessionId: string): Promise<{
  runId: string; text: string; userText: string; decision: Record<string, unknown>; expiresAt: number;
} | null> {
  const normalizedSessionId = normalizeCompanionSessionId(sessionId || "default");
  const runs = await readStoredRuns();
  const latest = runs.find((run) => run.sessionId === normalizedSessionId && run.modality !== "voice");
  if (!latest || latest.clarificationState !== "pending" || !latest.decision || String(latest.decision.type || "") !== "CLARIFY") {
    return null;
  }
  const expiresAt = Number(latest.clarificationExpiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await markClarificationRun(latest.runId, "abandoned");
    return null;
  }
  return {
    runId: latest.runId,
    text: latest.text,
    userText: latest.userText || latest.text,
    decision: latest.decision,
    expiresAt,
  };
}

export async function markClarificationRun(
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

export async function findSubmittedRunByClientRunId(
  clientRunId: string,
  expected?: { text: string; sessionId: string; userText?: string; attachments?: IntentAttachment[] },
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
    );
    if (stored.sessionId !== sessionId || stored.requestHash !== requestHash) {
      throw Object.assign(new Error("client_run_identity_conflict"), { statusCode: 409 });
    }
  }
  return statusFromStoredRun(stored);
}

export async function getRunStatusByClientRunId(clientRunId: string): Promise<CompanionRunStatus> {
  const clientId = requireClientRunId(clientRunId);
  const stored = (await readStoredRuns()).find((run) => run.clientRunId === clientId);
  if (!stored) return unknownRun(clientId, "Client run was not found.");
  // Admission truth is the local atomic registry. Reconciliation must not depend
  // on Gateway reachability after the Companion has durably accepted a run.
  return withRunSteps(statusFromStoredRun(stored), stored);
}

/** HS5: progress.steps[] derived on read from the stored run and its receipts; nothing persisted. */
function withRunSteps(status: CompanionRunStatus, stored?: StoredRun | null): CompanionRunStatus {
  if (!stored) return status;
  const derived = runProgressSteps({
    executionSource: stored.executionSource, state: status.state, error: stored.error,
    acceptedAt: stored.acceptedAt, updatedAt: stored.updatedAt ?? status.updatedAt, modality: stored.modality,
    decision: stored.decision, clarificationState: stored.clarificationState,
    presentation: readReceiptPresentation(stored.presentation), events: status.progress?.events,
  });
  if (!derived) return status;
  const base = status.progress || {text: "", events: []};
  return {...status, progress: {...base, ...derived}};
}

export async function getRunStatus(runId: string): Promise<CompanionRunStatus> {
  const normalizedRunId = runId.trim();
  const stored = normalizedRunId
    ? (await findStoredRun(normalizedRunId, false).catch(() => null)) || submittedRuns.get(normalizedRunId)
    : undefined;
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
  reconcileInactiveRuns(normalizedRunId);
  if(stored&&!requiresLiveRefresh(stored))return statusFromStoredRun(stored);
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

function requiresLiveRefresh(stored:StoredRun):boolean {
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

  const [transcript, trajectory] = await Promise.all([
    readSessionTranscript(sessionId, stored?.text, allowGatewayHistory ? String(sessionInfo?.key || "") : undefined, deadline).catch(() => null),
    readSessionTrajectory(sessionId, status.runId, stored?.text).catch(() => null),
  ]);
  if (!transcript && !trajectory) return status;

  const prompt = stored?.text || transcript?.prompt || trajectory?.prompt || status.prompt || "";
  const userText = stored?.userText || status.userText;
  const result = transcript?.result || trajectory?.result || status.result;
  const progress = mergeProgress(status.progress, transcript?.progressEvents || [], trajectory?.progress);
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

function statusFromStoredRun(stored: StoredRun): CompanionRunStatus {
  if (stored.modality === "voice") return {
    success: true, runId: stored.runId, clientRunId: stored.clientRunId, sessionId: stored.sessionId,
    state: stored.transcriptState === "completed" ? "done" : "unknown",
    message: stored.transcriptState || "partial", userText: stored.userText || "",
    result: stored.result || "", submittedAt: stored.acceptedAt, updatedAt: stored.updatedAt,
    modality: "voice", transcriptState: stored.transcriptState, playback: stored.playback,
  };

  const failed = stored.state === "failed";
  const expired = stored.error === "run_inactivity_expired";
  const done = stored.state === "done";
  const message = failed
    ? expired ? "Run expired after verified inactivity. A later result can still correct this status." : stored.error || "OpenClaw did not accept this run."
    : done
      ? stored.result || "OpenClaw completed this run."
      : "OpenClaw is still working on this run.";
  return {
    success: !failed,
    status: stored.error === "run_inactivity_expired" ? "expired" : undefined,
    ...publicReceiptMetadata(readReceiptPresentation(stored.presentation)),
    ...(publicDecision(stored.decision) ? {decision: publicDecision(stored.decision)} : {}),
    inactivityCorrectionReceipt: stored.inactivityCorrectionReceipt,
    runId: stored.runId,
    clientRunId: stored.clientRunId,
    sessionId: stored.sessionId,
    state: failed ? "failed" : stored.state === "done" ? "done" : "running",
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
  };
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

async function readSessionsIndex(deadline?: number): Promise<any[]> {
  const filePath = path.join(openClawStateDir(), "agents", agentId(), "sessions", "sessions.json");
  let data: any;
  try {
    data = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    // OpenClaw SQLite migration removed the legacy index. Use the owner Gateway API.
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) return [];
    data = await callOpenClawGateway("sessions.list", { search: "companion-", limit: 100 },
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
  return summarizeTranscript(raw, targetPrompt);
}

function summarizeTranscript(raw: string, targetPrompt?: string): TranscriptSummary {
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
        if (clean === targetPrompt) {
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
    events: events.slice(-12),
  };
}

function dedupeProgressEvents(events: CompanionRunProgressEvent[]) {
  const seen = new Set<string>();
  return events
    .filter((event) => event && event.label)
    .sort((left, right) => Number(left.at || 0) - Number(right.at || 0))
    .filter((event) => {
      const key = `${event.type}|${event.label}|${event.detail || ""}|${event.at || ""}`;
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
      return {
        type: "tool.call",
        label: `Calling ${toolName}.`,
        detail: toolArgumentsSummary(part),
        at: messageTimestamp(event, true),
      };
    });
}

function toolResultEventFromMessage(event: any): CompanionRunProgressEvent | null {
  const toolName = typeof event?.message?.toolName === "string" ? event.message.toolName : "";
  if (!toolName) return null;
  const failed = event?.message?.isError === true || toolResultLooksFailed(event?.message);
  return {
    type: failed ? "tool.error" : "tool.result",
    label: `${failed ? "Tool failed" : "Completed"} ${toolName}.`,
    detail: toolResultSummary(event?.message),
    at: messageTimestamp(event, true),
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

let inactivityRead: Promise<void> | undefined;
let inactivityCursor = 0;
const INACTIVITY_READ_BUDGET_MS = 10000;
/** Read snapshots never await reconciliation. One bounded owner pass at a time. */
function reconcileInactiveRuns(targetRunId?:string):void {
  if(inactivityRead)return;
  inactivityRead=reconcileInactiveRunsOnce(targetRunId,Date.now()+INACTIVITY_READ_BUDGET_MS)
    .catch(()=>undefined).finally(()=>{inactivityRead=undefined;});
}

async function reconcileInactiveRunsOnce(targetRunId: string | undefined, deadline: number): Promise<void> {
  await registryWrite;
  const initial = await registryOrEmpty(), now = Date.now();
  const eligible = (run: StoredRun, registry: CompanionRunRegistry) => run.modality !== "voice" &&
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
    const remaining = deadline - Date.now();
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
    if (!session || Date.now() >= deadline) continue;
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

async function readStoredRuns(reconcile = true): Promise<StoredRun[]> {
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
    .filter(run => !deletedRunIds.has(run.runId))
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
  const boundedRuns = retainStoredRuns(runs.filter(row => !deletedIds.has(row.runId)));
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
  return {
    archivedSessionIds,
    paymentRequests,
    ownerConfirmations,
    runDeletions,
    runs: runs
      .filter((run: any) => typeof run?.runId === "string")
    .map((run: any) => ({
      inactivityCorrectionReceipt: validInactivityReceipt(run.inactivityCorrectionReceipt, run.runId),
      presentation: readReceiptPresentation(run.presentation),
      runId: run.runId,
      clientRunId: typeof run.clientRunId === "string" && CLIENT_RUN_ID_RE.test(run.clientRunId) ? run.clientRunId : undefined,
      requestHash: typeof run.requestHash === "string" && /^[a-f0-9]{64}$/.test(run.requestHash) ? run.requestHash : undefined,
      executionSource: ["gateway", "capability_first"].includes(String(run.executionSource || ""))
        ? run.executionSource
        : undefined,
      decision: run.decision && typeof run.decision === "object" && Number(run.decision.version) === 2
        ? run.decision
        : undefined,
      clarificationState: ["pending", "resolved", "abandoned"].includes(String(run.clarificationState || ""))
        ? run.clarificationState
        : undefined,
      clarificationExpiresAt: typeof run.clarificationExpiresAt === "number" ? run.clarificationExpiresAt : undefined,
      parentClarificationRunId: typeof run.parentClarificationRunId === "string" ? run.parentClarificationRunId : undefined,
      sessionId: normalizeCompanionSessionId(String(run.sessionId || "default")),
      sessionKey: typeof run.sessionKey === "string" ? run.sessionKey : undefined,
      text: typeof run.text === "string" ? run.text : "",
      userText: typeof run.userText === "string" ? run.userText : undefined,
      attachments: Array.isArray(run.attachments) ? run.attachments : undefined,
      acceptedAt: typeof run.acceptedAt === "number" ? run.acceptedAt : 0,
      updatedAt: typeof run.updatedAt === "number" ? run.updatedAt : undefined,
      state: ["running", "done", "failed", "unknown"].includes(String(run.state || ""))
        ? run.state
        : undefined,
      error: typeof run.error === "string" ? run.error : undefined,
      result: typeof run.result === "string" ? run.result : undefined,
      modality: run.modality === "voice" ? "voice" : undefined,
      transcriptState: ["partial", "completed", "interrupted"].includes(run.transcriptState) ? run.transcriptState : undefined,
      transcriptRevision: Number.isSafeInteger(run.transcriptRevision) ? run.transcriptRevision : undefined,
      playback: run.playback ? validateVoicePlayback(run.playback) : undefined,
    })),
  };
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
export async function saveVoiceTurn(sessionId: string, value: any) {
  requireConversationId(sessionId);
  const allowed = new Set(["runId", "revision", "input", "output", "state", "playback"]);
  if (!value || Object.keys(value).some(key => !allowed.has(key)) ||
      !/^voice-[a-f0-9-]{36}$/.test(value.runId || "") || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
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
      acceptedAt: old?.acceptedAt || Date.now(), updatedAt: Date.now(), state: value.state === "completed" ? "done" : "unknown"};
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
  const unresolved=stored.filter(run=>run.modality!=="voice"&&run.executionSource!=="capability_first"&&!run.result&&(run.state!=="failed"||run.error==="run_inactivity_expired"));
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
type PageOptions={limit?:number;cursor?:string;query?:string};
const pageSecret=randomBytes(32);
const pageEpoch=randomUUID();
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function pageError(message:string,statusCode=409){return Object.assign(new Error(message),{statusCode});}
function normalizedPageOptions(options:PageOptions){
  const limit=options.limit??20,query=options.query??"";
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
async function retainedRuns():Promise<StoredRun[]> {
  reconcileInactiveRuns();
  await registryWrite;
  const registry=await registryOrEmpty(),archived=new Set(registry.archivedSessionIds);
  return registry.runs.filter(x=>!archived.has(x.sessionId)).sort((a,b)=>b.acceptedAt-a.acceptedAt||a.runId.localeCompare(b.runId));
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
  const runs=await retainedRuns();const grouped=new Map<string,StoredRun[]>();
  // Background single-flight refresh; pagination never waits on a Gateway process.
  const ownerIndex=runs.length?conversationOwnerIndex():{rows:new Map<string,any>(),state:'pending'};
  const metadata=ownerIndex.rows;
  for(const run of runs){const rows=grouped.get(run.sessionId)||[];rows.push(run);grouped.set(run.sessionId,rows);}
  const items=[...grouped.entries()].filter(([,rows])=>!query||rows.some(r=>(r.userText||r.text||"").toLocaleLowerCase().includes(query.toLocaleLowerCase())||(r.result||"").toLocaleLowerCase().includes(query.toLocaleLowerCase())))
    .map(([sessionId,rows])=>{
      const latest=rows[0],status=statusFromStoredRun(latest),owner:any=metadata.get(latest.sessionKey||expectedCompanionSessionKey(sessionId));
      const title=typeof owner?.label==='string'&&owner.label.length<=160&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(owner.label)?owner.label:null;
      const pinned=typeof owner?.pinned==='boolean'?owner.pinned:null;
      return {sessionId,title,pinned,metadataSource:owner?'gateway_sessions_list':null,lastRunId:latest.runId,titlePreview:(latest.userText||latest.text||"").slice(0,160),
        lastResultPreview:readablePreview(latest.result||""),lastRunState:status.state,
        lastActivityAt:latest.updatedAt||latest.acceptedAt,sortAt:latest.acceptedAt,
        modality:latest.modality||"text",transcriptState:latest.transcriptState||"",
        availableTurnCount:rows.length,previewTruncated:(!/^\s*[{\[]/.test(latest.result||"")&&(latest.result?.length||0)>140)||(latest.userText||latest.text||"").length>160};
    }).sort((a,b)=>b.sortAt-a.sortAt||a.sessionId.localeCompare(b.sessionId));
  const revision=digest({items,retainedRunCount:runs.length,availableConversations:grouped.size}),scope=pageScope("conversations",query,limit),anchor=cursorAnchor(cursor,scope,revision);
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
  if(options.query)throw pageError("unsupported_turn_query",400);
  // Keep the canonical full preparation path separate from this UI page.
  let partial=false;
  if(!cursor)try{await getConversationTurns(sessionId);}catch{partial=true;}
  const all=(await retainedRuns()).filter(x=>x.sessionId===sessionId).sort((a,b)=>a.acceptedAt-b.acceptedAt||a.runId.localeCompare(b.runId));
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
  const left=new Map(before.map(r=>[r.runId,r])),right=new Map(after.map(r=>[r.runId,r]));
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

export async function withAttachmentReferences<T>(effect:(paths:Set<string>)=>T):Promise<T>{return mutateRegistry(async()=>effect(new Set((await registryOrEmpty()).runs.flatMap(row=>(row.attachments||[]).map(x=>x.serverPath||x.path||"")))));}

import {readReceiptPresentation,publicReceiptMetadata} from "./receiptPresentation";
import crypto from "crypto";
import {MEMO_STT_QUALIFICATION} from "./memoSttBoundary";
import {transcribeMemoAttachment} from "./memoSttOwner";
import { getGatewayStatus } from "./openclawGatewayClient";
import { describeOpenClawResult, expectedCompanionSessionKey, normalizeCompanionSessionId, submitToOpenClawAgent } from "./openclawAgentClient";
import { intentCanvas } from "./canvas";
import { appendReplayContext, appendVoiceConversationContext, prepareReplay, type PreparedReplay, findSubmittedRunByClientRunId, markSubmittedRunFailed, rememberSubmittedRun, reserveSubmittedRun, claimMemoTranscript, claimMemoDispatch, deferMemoTranscription, observeGatewayRun } from "./runs";
import type { OpenClawAgentSubmitResult } from "./openclawAgentClient";
import type { CompanionRunStatus, IntentAttachment, IntentSubmitResponse } from "./types";
import { turnAdmission, type AdmissionTicket } from "./ownerTurnAdmission";

type SubmissionOptions = {userText?: string; clientRunId?: string; learningOnly?: true; authority?: "owner"; admission?: AdmissionTicket; voiceDelegation?: true; replayOf?: {sessionId: string; runId: string}};

function currentMemoOwner(admission: unknown, clientRunId: string | undefined, sessionId: string): boolean {
  try { return require("./ownerTurnAdmission").turnAdmission.isCurrent(admission, {clientRunId, sessionId}) === true; }
  catch { return false; }
}

/** The HTTP owner passes only ordinary submission fields. Continuation never comes from request data. */
export async function submitIntent(text: string, sessionId = "default", attachments: IntentAttachment[] = [],
  options: SubmissionOptions = {}): Promise<IntentSubmitResponse> {
  if (attachments.some(a => a.mimeType?.startsWith("audio/"))) {
    return submitMemoIntent(text, sessionId, attachments, options);
  }
  return submitTextIntent(text, sessionId, attachments, options);
}

async function submitMemoIntent(text: string, sessionId: string, attachments: IntentAttachment[],
  options: SubmissionOptions): Promise<IntentSubmitResponse> {
  const session = normalizeCompanionSessionId(sessionId);
  if (!MEMO_STT_QUALIFICATION.success) return notSubmitted(session, options.clientRunId, "Le mémo vocal n’est pas encore disponible.");
  const audio = attachments[0];
  if (options.authority !== "owner" || !currentMemoOwner(options.admission, options.clientRunId, session) || options.learningOnly || options.replayOf || text.trim() || attachments.length !== 1 ||
      audio?.mimeType !== "audio/mp4" || !/^[A-Za-z0-9_-]{1,100}$/.test(audio.serverId || audio.id || "")) {
    return notSubmitted(session, options.clientRunId, "Le mémo vocal ne peut pas être envoyé.");
  }
  const attachmentId = audio.serverId || audio.id;
  const identity = "memo:" + attachmentId;
  const clientRunId = options.clientRunId || "memo_" + crypto.createHash("sha256").update(JSON.stringify([session, attachmentId])).digest("hex");
  const reservation = await reserveSubmittedRun(identity, session, clientRunId, {
    userText: "Mémo vocal", attachments, requestText: identity, executionSource: "capability_first", memoAttachmentId: attachmentId, ownerAdmitted: true,
  });
  if (reservation.created) {
    // One durable reservation is the worker claim. A duplicate/restart never invokes STT again.
    void continueMemoIntent(reservation.status.runId, session, clientRunId, attachmentId, options.admission);
  }
  if (!reservation.created && reservation.status.memoTranscription?.phase === "ready") {
    return submitTextIntent(reservation.status.userText || "", session, [],
      {userText: reservation.status.userText, clientRunId, authority: "owner", admission: options.admission}, reservation.status.runId);
  }
  return {...responseFromExisting(reservation.status, reservation.status.userText || "Mémo vocal"), duplicate: !reservation.created};
}

export const resumeMemoIntent = (runId: string, sessionId: string, clientRunId: string, attachmentId: string) =>
  continueMemoIntent(runId, sessionId, clientRunId, attachmentId, undefined);

async function continueMemoIntent(runId: string, sessionId: string, clientRunId: string, attachmentId: string,
  admission?: AdmissionTicket): Promise<void> {
  try {
    const transcript = await transcribeMemoAttachment(attachmentId);
    if (!transcript.success) {
      await deferMemoTranscription(runId);
      return;
    }
    if (!await claimMemoTranscript(runId, attachmentId, transcript.text)) return;
    // A deferred GET retry has no ticket. Preserve ready state for a fresh signed POST.
    if (!currentMemoOwner(admission, clientRunId, sessionId)) return;
    const result = await submitTextIntent(transcript.text, sessionId, [], {userText: transcript.text, clientRunId, authority: "owner", admission}, runId);
    if (!result.accepted && currentMemoOwner(admission, clientRunId, sessionId))
      await markSubmittedRunFailed(runId, "Le mémo n'a pas pu être pris en charge.");
  } catch {
    // Never expose provider errors, paths, config or raw details; never retry an uncertain effect.
    await deferMemoTranscription(runId);
  }
}

async function submitTextIntent(
  text: string,
  sessionId = "default",
  attachments: IntentAttachment[] = [],
  options: SubmissionOptions = {},
  reservedMemoRunId?: string,
): Promise<IntentSubmitResponse> {
  if (reservedMemoRunId && !currentMemoOwner(options.admission, options.clientRunId, sessionId))
    return notSubmitted(sessionId, options.clientRunId, "Une nouvelle validation du propriétaire est nécessaire.");
  const normalized = reservedMemoRunId ? text : text.trim();
  const visibleUserText = reservedMemoRunId ? text : (options.userText || normalized).trim();
  const normalizedSessionId = normalizeCompanionSessionId(sessionId);
  const clientRunId = String(options.clientRunId || "").trim() || undefined;
  const learningOnly = options.learningOnly === true;
  const currentOwner = () => !learningOnly && turnAdmission.isCurrent(options.admission, {clientRunId, sessionId: normalizedSessionId});
  if (options.voiceDelegation === true && (!currentOwner() || !clientRunId || learningOnly || options.replayOf || attachments.length))
    return notSubmitted(normalizedSessionId, clientRunId, "owner_required");
  if (learningOnly && (normalizedSessionId !== "skill-learning" || attachments.length)) return notSubmitted(normalizedSessionId, clientRunId, "Invalid learning submission.");
  if (!normalized) {
    return notSubmitted(normalizedSessionId, clientRunId, "Intent text is required.");
  }

  if (clientRunId && !reservedMemoRunId) {
    const existing = await findSubmittedRunByClientRunId(clientRunId, {
      text: normalized,
      sessionId: normalizedSessionId,
      userText: visibleUserText,
      attachments,
      replayOf: options.replayOf,
    });
    if (existing) return responseFromExisting(existing, visibleUserText);
  }

  // Édition d'un message : le texte modifié part ensuite au cerveau comme un nouveau message (aucune
  // confirmation ni action de l'ancienne branche n'est reprise) ; seul le contexte historique est amorcé.
  let replay: PreparedReplay | undefined;
  if (options.replayOf) {
    // P1 : la relecture exige l'admission native signée (jamais le loopback ni le drapeau legacy).
    if (!clientRunId || !currentOwner() || attachments.length || learningOnly)
      return notSubmitted(normalizedSessionId, clientRunId, "replay_invalid");
    try { replay = await prepareReplay(options.replayOf.sessionId, options.replayOf.runId, normalizedSessionId); }
    catch (error: any) {
      return notSubmitted(normalizedSessionId, clientRunId, /^replay_[a-z_]+$/.test(String(error?.message)) ? error.message : "replay_unavailable");
    }
  }
  const replayOf = replay ? {sessionId: replay.sourceSessionId, runId: replay.runId} : undefined;

  // P1 : bit d'admission de ce tour, persisté sur le run. Une clarification ouverte par un tour non admis
  // n'est jamais reprise par un tour admis (aucun texte dérivé d'un tiers sur la connexion admin).
  const ownerAdmitted = currentOwner();
  // Owner turns reach the brain directly (ADR 02/11, step 3): no coordinator, clock or skill router before it.
  const gateway = await getGatewayStatus();
  if (!gateway.reachable) {
    return notSubmitted(normalizedSessionId, clientRunId, gateway.message);
  }

  const semanticOwner=ownerAdmitted?"main" as const:undefined;
  const promptWithAttachments = appendAttachmentContext(normalized, attachments);
  const contextualPrompt = learningOnly ? promptWithAttachments : await appendVoiceConversationContext(promptWithAttachments, normalizedSessionId);
  const submittedPrompt = replay ? appendReplayContext(contextualPrompt, replay.seed) : contextualPrompt;

  let runId = reservedMemoRunId || `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  let duplicate = false;
  if (reservedMemoRunId) {
    if (!await claimMemoDispatch(runId, normalized, "gateway", undefined, undefined, () => currentMemoOwner(options.admission, clientRunId, normalizedSessionId), ownerAdmitted, undefined, semanticOwner)) return notSubmitted(normalizedSessionId, clientRunId, "Mémo annulé ou déjà pris en charge.");
  } else if (clientRunId) {
    const reservation = await reserveSubmittedRun(
      submittedPrompt,
      normalizedSessionId,
      clientRunId,
      { userText: visibleUserText, attachments, requestText: normalized, executionSource: "gateway", replayOf, ownerAdmitted, semanticOwner,
        ...(options.voiceDelegation === true ? {voiceDelegation: true as const} : {}) },
    );
    runId = reservation.status.runId;
    duplicate = !reservation.created;
    if (duplicate) return responseFromExisting(reservation.status, visibleUserText);
  }

  const accepted = acceptedRun(runId, normalizedSessionId, options.voiceDelegation);
  if (!clientRunId) {
    await rememberSubmittedRun(submittedPrompt, accepted, { userText: visibleUserText, attachments, ownerAdmitted, semanticOwner });
  }
  void submitIntentInBackground(submittedPrompt, runId, normalizedSessionId, visibleUserText, attachments, options.authority,
    learningOnly ? undefined : options.admission, clientRunId, options.voiceDelegation);

  const message = describeOpenClawResult(accepted);
  return {
    success: true,
    accepted: true,
    submissionState: "accepted",
    retrySafe: false,
    duplicate,
    runId,
    clientRunId,
    sessionId: normalizedSessionId,
    state: "running",
    result: message,
    message,
    userText: visibleUserText,
    canvas: intentCanvas(visibleUserText, message),
    attachments,
    ...(replay ? {replay: publicReplay(replay)} : {}),
    gatewayRun: includeRawIntent() ? accepted : undefined,
  };
}

export function notSubmitted(
  sessionId: string,
  clientRunId: string | undefined,
  message: string,
): IntentSubmitResponse {
  return {
    success: false,
    accepted: false,
    submissionState: "not_submitted",
    retrySafe: true,
    runId: "",
    clientRunId,
    sessionId,
    state: "failed",
    result: message,
    message,
    canvas: intentCanvas("", message),
  };
}

function responseFromExisting(
  status: CompanionRunStatus,
  userText: string,
): IntentSubmitResponse {
  const message = status.result || status.message;
  return {
    success: true,
    accepted: true,
    submissionState: "accepted",
    retrySafe: false,
    duplicate: true,
    ...publicReceiptMetadata(readReceiptPresentation(status.presentation)),
    ...(status.decision ? {decision: status.decision} : {}),
    runId: status.runId,
    clientRunId: status.clientRunId,
    sessionId: status.sessionId,
    state: status.state,
    ...(status.web ? {web:status.web} : {}),
    result: status.result || message,
    message,
    userText,
    canvas: intentCanvas(userText, message),
    attachments: status.attachments,
    ...(status.reasonClass ? {reasonClass: status.reasonClass} : {}),
  };
}

async function submitIntentInBackground(
  text: string,
  runId: string,
  sessionId: string,
  userText: string,
  attachments: IntentAttachment[],
  authority?:"owner",
  admission?: AdmissionTicket,
  clientRunId?: string,
  voiceDelegation?: true,
) {
  let observer: Awaited<ReturnType<typeof observeGatewayRun>> | undefined;
  try {
    if (admission !== undefined && !currentMemoOwner(admission, clientRunId, sessionId)) {
      await markSubmittedRunFailed(runId, "Validation du propriétaire expirée."); return;
    }
    if(admission)observer=await observeGatewayRun(runId,expectedCompanionSessionKey(sessionId,voiceDelegation?"main":undefined));
    const openclaw = await submitToOpenClawAgent(text, runId, sessionId, {authority, admission, clientRunId, voiceDelegation, observer});
    if (admission) console.log(`[companion] P1 turn ${runId}: transport=${openclaw.ownerTransport}`);
    if(observer)return; // The terminal RPC and events already updated this exact run.
    await rememberSubmittedRun(text, {
      ...openclaw,
      runId,
      sessionId,
    }, { userText, attachments, ownerAdmitted: admission !== undefined });
  } catch (error: any) {
    if(error?.message==="gateway_observation_already_following")return; // Existing admitted work wins over duplicate background entry.
    if(observer && error?.requestSent===true)return; // Observation lost: reconcile status, never claim failure or replay.
    await markSubmittedRunFailed(
      runId,
      error?.message==="gateway_observation_capacity" ? "Samantha traite déjà plusieurs demandes. Cette demande n’a pas été envoyée." :
        `OpenClaw gateway accepted the connection but did not run the intent: ${error?.message || error}`,
    );
  }
}

export function appendAttachmentContext(text: string, attachments: IntentAttachment[]) {
  const imageAttachments = attachments.filter((attachment) =>
    ["image", "file"].includes(String(attachment.type || "").toLowerCase()) && (attachment.path || attachment.serverPath),
  );
  if (imageAttachments.length === 0) return text;

  const attachmentLines = imageAttachments.map((attachment, index) => {
    const label = attachment.displayName || attachment.id || `image-${index + 1}`;
    const mime = attachment.mimeType ? `, ${attachment.mimeType}` : "";
    const size = attachment.sizeBytes ? `, ${attachment.sizeBytes} bytes` : "";
    return `- ${label}${mime}${size}: ${attachment.path || attachment.serverPath}`;
  });

  return [
    text,
    "",
    "Attached files are available on the local Termux filesystem:",
    ...attachmentLines,
    "Use these file paths as supporting evidence when the task depends on the shared file.",
  ].join("\n");
}

function publicReplay(replay: PreparedReplay) {
  return {sourceSessionId: replay.sourceSessionId, runId: replay.runId, seededTurns: replay.seededTurns,
    supersededRuns: replay.supersededRuns, effects: replay.effects};
}

function acceptedRun(runId: string, sessionId: string, voiceDelegation?: true): OpenClawAgentSubmitResult {
  return {
    runId,
    sessionId,
    sessionKey: expectedCompanionSessionKey(sessionId, voiceDelegation ? "main" : undefined),
    status: "accepted",
    acceptedAt: Date.now(),
    waitedForFinal: false,
    raw: {
      accepted: true,
      mode: "background",
    },
  };
}

function includeRawIntent() {
  return ["1", "true", "yes"].includes((process.env.CLAWMOBILE_INTENT_INCLUDE_RAW || "").toLowerCase());
}

import {readReceiptPresentation,fallbackReceiptPresentation,fastPathFailurePresentation,publicReceiptMetadata,publicDecision,type ResponseLanguage} from "./receiptPresentation";
import crypto from "crypto";
import {MEMO_STT_QUALIFICATION} from "./memoSttBoundary";
import {transcribeMemoAttachment} from "./memoSttOwner";
import { getGatewayStatus } from "./openclawGatewayClient";
import { describeOpenClawResult, expectedCompanionSessionKey, normalizeCompanionSessionId, submitToOpenClawAgent } from "./openclawAgentClient";
import { intentCanvas } from "./canvas";
import { appendReplayContext, appendVoiceConversationContext, findClarificationProjectionRun, prepareReplay, type PreparedReplay, findSubmittedRunByClientRunId, projectClarificationRun, markSubmittedRunFailed, rememberSubmittedRun, reserveSubmittedRun, settleSubmittedRun, claimMemoTranscript, claimMemoDispatch, deferMemoTranscription, publicReasonClass } from "./runs";
import { buildAutoSkillContextForIntent } from "./skills";
import type { OpenClawAgentSubmitResult } from "./openclawAgentClient";
import type { CompanionRunStatus, IntentAttachment, IntentSubmitResponse } from "./types";
import { runModelFastPath, type FastPathResult } from "../modelFastPath";
import { dialogueHandoff, dialogueTurn, isDoneReply, isQuestionReply, transportEventRef, type DialogueInput, type DialogueReply } from "../dialogueSurface";
import { turnAdmission, type AdmissionTicket } from "./ownerTurnAdmission";
import {phoneDateTimeDecision} from "./phoneDateTime";

type SubmissionOptions = {userText?: string; clientRunId?: string; learningOnly?: true; authority?: "owner"; admission?: AdmissionTicket; voiceDelegation?: true; replayOf?: {sessionId: string; runId: string};phoneDateTime?:unknown};

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

  // Édition d'un message : le texte modifié passe ensuite par le résolveur comme un nouveau message (aucune
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
  const caller = ownerAdmitted ? "owner" as const : "other" as const;
  const phoneAnswer=ownerAdmitted?phoneDateTimeDecision(normalized,options.phoneDateTime):null;
  if(phoneAnswer){
    // SAM-MIG V2.2: the dialogue coordinator owns any pending question (it expires there, D-D); nothing to touch here.
    return executePhoneDateTimeFirst(normalizedSessionId,visibleUserText,attachments,clientRunId,phoneAnswer,options.admission,options.voiceDelegation,ownerAdmitted);
  }
  // SAM-MIG V2.2: one admitted event for the dialogue coordinator, the only owner of the pending question. The
  // conversation is split by admission bit (P1): a question opened by a non-admitted turn is never answered by an
  // admitted one, and conversely. The hand-off is deferred so the ticket is revalidated before any effect.
  let dialogue: DialogueReply | undefined;
  let dialogueInput: DialogueInput | undefined;
  if (attachments.length === 0 && !learningOnly) {
    dialogueInput = {
      surface: "app", graphSurface: "claw_live",
      conversationKey: `app:${normalizedSessionId}:${ownerAdmitted ? "owner" : "other"}`,
      eventRef: transportEventRef(clientRunId, reservedMemoRunId), text: normalized, caller,
      admittedAt: Date.now(), policy: { modelAllowed: true, deferHandoff: true }, timeoutSeconds: 75,
    };
    dialogue = await dialogueTurn(runModelFastPath, dialogueInput);
  }

  if (ownerAdmitted && !currentOwner()) {
    if (dialogue?.pendingHandoff && dialogueInput) await dialogueHandoff(runModelFastPath, dialogueInput, dialogue.pendingHandoff.goalRef, true);
    return notSubmitted(normalizedSessionId, clientRunId, "owner_admission_expired");
  }

  if (dialogue?.outcome === "TECHNICAL_FAILURE" && dialogue.reasonCode === "coordinator_unavailable") {
    // N1: nothing was admitted by the coordinator; the turn is not submitted (retry-safe), with a readable cause.
    const presentation=fastPathFailurePresentation({status:"error",reason:dialogue.source} as FastPathResult,'resolution');
    return {...notSubmitted(normalizedSessionId,clientRunId,presentation.spoken),...publicReceiptMetadata(presentation)};
  }
  if (dialogue && dialogueInput && dialogue.handled) {
    if (options.voiceDelegation === true && !currentOwner()) {
      if (dialogue.pendingHandoff) await dialogueHandoff(runModelFastPath, dialogueInput, dialogue.pendingHandoff.goalRef, true);
      return notSubmitted(normalizedSessionId, clientRunId, "owner_required");
    }
    return executeCapabilityFirst(
      normalized, normalizedSessionId, visibleUserText, attachments, clientRunId, dialogue, dialogueInput,
      replayOf, reservedMemoRunId, options.admission, ownerAdmitted,
    );
  }
  const fastPathCheck: FastPathResult = { status: "miss", reason: dialogue ? "dialogue_unresolved" : "attachments_require_model", decision: dialogue?.decision || undefined };
  const gateway = await getGatewayStatus();
  if (!gateway.reachable) {
    return notSubmitted(normalizedSessionId, clientRunId, gateway.message);
  }

  const responseLanguage=publicDecision(fastPathCheck.decision)?.responseLanguage;
  const promptWithAttachments = appendAttachmentContext(normalized, attachments);
  const routed = learningOnly ? null : buildAutoSkillContextForIntent(promptWithAttachments);
  const contextualPrompt = learningOnly ? promptWithAttachments : await appendVoiceConversationContext(routed?.prompt || promptWithAttachments, normalizedSessionId);
  const submittedPrompt = replay ? appendReplayContext(contextualPrompt, replay.seed) : contextualPrompt;

  let runId = reservedMemoRunId || `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  let duplicate = false;
  if (reservedMemoRunId) {
    if (!await claimMemoDispatch(runId, normalized, "gateway", undefined, undefined, () => currentMemoOwner(options.admission, clientRunId, normalizedSessionId), ownerAdmitted)) return notSubmitted(normalizedSessionId, clientRunId, "Mémo annulé ou déjà pris en charge.");
  } else if (clientRunId) {
    const reservation = await reserveSubmittedRun(
      submittedPrompt,
      normalizedSessionId,
      clientRunId,
      { userText: visibleUserText, attachments, requestText: normalized, executionSource: "gateway", decision: fastPathCheck.decision, replayOf, ownerAdmitted },
    );
    runId = reservation.status.runId;
    duplicate = !reservation.created;
    if (duplicate) return responseFromExisting(reservation.status, visibleUserText);
  }

  const accepted = acceptedRun(runId, normalizedSessionId, options.voiceDelegation);
  if (!clientRunId) {
    await rememberSubmittedRun(submittedPrompt, accepted, { userText: visibleUserText, attachments, decision: fastPathCheck.decision, ownerAdmitted });
  }
  void submitIntentInBackground(submittedPrompt, runId, normalizedSessionId, visibleUserText, attachments, options.authority,
    learningOnly ? undefined : options.admission, clientRunId, options.voiceDelegation, responseLanguage);

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
    gatewayRun: includeRawIntent() ? { ...accepted, skillRouting: routed?.routed } : undefined,
  };
}

async function executePhoneDateTimeFirst(sessionId:string,userText:string,attachments:IntentAttachment[],clientRunId:string|undefined,
  answer:NonNullable<ReturnType<typeof phoneDateTimeDecision>>,admission?:AdmissionTicket,voiceDelegation?:true,ownerAdmitted=false):Promise<IntentSubmitResponse>{
  if(!ownerAdmitted||!turnAdmission.isCurrent(admission,{clientRunId,sessionId}))return notSubmitted(sessionId,clientRunId,"owner_admission_expired");
  let runId=`run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,duplicate=false;
  if(clientRunId){
    const reservation=await reserveSubmittedRun(userText,sessionId,clientRunId,{userText,attachments,requestText:userText,
      executionSource:"capability_first",decision:answer.decision,ownerAdmitted});
    runId=reservation.status.runId;duplicate=!reservation.created;
    if(duplicate)return responseFromExisting(reservation.status,userText);
  }else await rememberSubmittedRun(userText,acceptedRun(runId,sessionId,voiceDelegation),{userText,attachments,
    executionSource:"capability_first",decision:answer.decision,ownerAdmitted});
  if(!turnAdmission.isCurrent(admission,{clientRunId,sessionId})){
    await markSubmittedRunFailed(runId,"owner_admission_expired");return notSubmitted(sessionId,clientRunId,"owner_admission_expired");
  }
  const state=answer.state==="done"?"done" as const:"failed" as const,decision=publicDecision(answer.decision);
  await settleSubmittedRun(runId,state,answer.text,{});
  return{success:true,accepted:true,submissionState:"accepted",retrySafe:false,duplicate,...(decision?{decision}:{}),
    runId,clientRunId,sessionId,state,result:answer.text,message:answer.text,userText,canvas:intentCanvas(userText,answer.text),attachments};
}

async function executeCapabilityFirst(
  text: string,
  sessionId: string,
  userText: string,
  attachments: IntentAttachment[],
  clientRunId: string | undefined,
  first: DialogueReply,
  input: DialogueInput,
  replayOf?: {sessionId: string; runId: string},
  reservedMemoRunId?: string,
  admission?: AdmissionTicket,
  ownerAdmitted = false,
): Promise<IntentSubmitResponse> {
  // Projection links only (display, comprehension metrics): the coordinator decided, the run records.
  const parentClarificationRunId = await findClarificationProjectionRun(sessionId, first.goalRef);
  const replacedRunId = await findClarificationProjectionRun(sessionId, (first as any).replacedGoalRef);
  const goalRef = first.goalRef || undefined;
  let runId = reservedMemoRunId || `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  let duplicate = false;
  const abort = async () => { if (first.pendingHandoff) await dialogueHandoff(runModelFastPath, input, first.pendingHandoff.goalRef, true); };
  if (reservedMemoRunId) {
    if (!await claimMemoDispatch(runId, userText, "capability_first", first.decision || undefined, parentClarificationRunId, () => currentMemoOwner(admission, clientRunId, sessionId), ownerAdmitted, goalRef)) {
      await abort();
      return notSubmitted(sessionId, clientRunId, "Mémo annulé ou déjà pris en charge.");
    }
  } else if (clientRunId) {
    const reservation = await reserveSubmittedRun(text, sessionId, clientRunId, {
      userText, attachments, requestText: text, executionSource: "capability_first",
      decision: first.decision || undefined, parentClarificationRunId, dialogueGoalRef: goalRef, replayOf, ownerAdmitted,
    });
    runId = reservation.status.runId;
    duplicate = !reservation.created;
    if (duplicate) return responseFromExisting(reservation.status, userText);
  } else {
    await rememberSubmittedRun(text, acceptedRun(runId, sessionId), {
      userText, attachments, executionSource: "capability_first", decision: first.decision || undefined, parentClarificationRunId, dialogueGoalRef: goalRef, ownerAdmitted,
    });
  }
  if (parentClarificationRunId) await projectClarificationRun(parentClarificationRunId, "resolved");
  if (replacedRunId) await projectClarificationRun(replacedRunId, "abandoned");

  if (reservedMemoRunId && !currentMemoOwner(admission, clientRunId, sessionId)) {
    await abort();
    await markSubmittedRunFailed(runId, "Validation du propriétaire expirée.");
    return notSubmitted(sessionId, clientRunId, "Une nouvelle validation du propriétaire est nécessaire.");
  }
  let reply = first;
  if (first.outcome === "READY" && first.pendingHandoff) {
    if (ownerAdmitted && !turnAdmission.isCurrent(admission, {clientRunId, sessionId})) {
      await abort();
      await markSubmittedRunFailed(runId, "owner_admission_expired");
      return notSubmitted(sessionId, clientRunId, "owner_admission_expired");
    }
    reply = await dialogueHandoff(runModelFastPath, input, first.pendingHandoff.goalRef);
  }
  const metadata = (reply.metadata || {}) as FastPathResult;
  let presentation = readReceiptPresentation(metadata);
  const provenance: FastPathResult["provenance"] = metadata.provenance;
  const state: "done" | "failed" = isQuestionReply(reply) || isDoneReply(reply) ? "done" : "failed";
  let message = String(reply.text || (state === "done" ? "Claw completed the capability." : "Claw could not complete the known capability."));
  if (!presentation && state === "failed" && reply.outcome === "TECHNICAL_FAILURE") presentation = fastPathFailurePresentation({status: "error", reason: reply.source || reply.reasonCode} as FastPathResult, "execution");
  const spoken = !reply.metadata && reply.reasonCode === "coordinator_unavailable" && presentation ? presentation.spoken : undefined;
  presentation ||= fallbackReceiptPresentation(state === "failed");
  if (spoken) message = spoken;
  const reasonClass=publicReasonClass((metadata as any).reasonClass ?? (metadata as any).reason_class);
  await settleSubmittedRun(runId, state, message, {provenance, presentation, reasonClass});
  return {
    success: true,
    accepted: true,
    submissionState: "accepted",
    retrySafe: false,
    duplicate,
    ...publicReceiptMetadata(presentation),
    ...(publicDecision(reply.decision || first.decision || undefined) ? {decision: publicDecision(reply.decision || first.decision || undefined)} : {}),
    ...(publicDecision(reply.decision || first.decision || undefined)?.responseLanguage ? {responseLanguage: publicDecision(reply.decision || first.decision || undefined)!.responseLanguage} : {}),
    runId,
    clientRunId,
    sessionId,
    state,
    result: state === "done" ? message : undefined,
    message,
    userText,
    canvas: intentCanvas(userText, message),
    attachments,
    ...(reasonClass ? {reasonClass} : {}),
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
  responseLanguage?: ResponseLanguage,
) {
  try {
    if (admission !== undefined && !currentMemoOwner(admission, clientRunId, sessionId)) {
      await markSubmittedRunFailed(runId, "Validation du propriétaire expirée."); return;
    }
    const openclaw = await submitToOpenClawAgent(text, runId, sessionId, {authority, admission, clientRunId, voiceDelegation, responseLanguage});
    if (admission) console.log(`[companion] P1 turn ${runId}: transport=${openclaw.ownerTransport}`);
    await rememberSubmittedRun(text, {
      ...openclaw,
      runId,
      sessionId,
    }, { userText, attachments, ownerAdmitted: admission !== undefined });
  } catch (error: any) {
    await markSubmittedRunFailed(
      runId,
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

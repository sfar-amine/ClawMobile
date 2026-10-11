import {readReceiptPresentation,fallbackReceiptPresentation,publicReceiptMetadata,publicDecision} from "./receiptPresentation";
import crypto from "crypto";
import {MEMO_STT_QUALIFICATION} from "./memoSttBoundary";
import {transcribeMemoAttachment} from "./memoSttOwner";
import { getGatewayStatus } from "./openclawGatewayClient";
import { describeOpenClawResult, expectedCompanionSessionKey, normalizeCompanionSessionId, submitToOpenClawAgent } from "./openclawAgentClient";
import { intentCanvas } from "./canvas";
import { appendVoiceConversationContext, findPendingClarificationRun, findSubmittedRunByClientRunId, markClarificationRun, markSubmittedRunFailed, rememberSubmittedRun, reserveSubmittedRun, settleSubmittedRun, claimMemoTranscript, claimMemoDispatch } from "./runs";
import { buildAutoSkillContextForIntent } from "./skills";
import type { OpenClawAgentSubmitResult } from "./openclawAgentClient";
import type { CompanionRunStatus, IntentAttachment, IntentSubmitResponse } from "./types";
import { runModelFastPath, type FastPathResult } from "../modelFastPath";

type SubmissionOptions = {userText?: string; clientRunId?: string; learningOnly?: true; authority?: "owner"};

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
  if (options.authority !== "owner" || options.learningOnly || text.trim() || attachments.length !== 1 ||
      audio?.mimeType !== "audio/mp4" || !/^[A-Za-z0-9_-]{1,100}$/.test(audio.serverId || audio.id || "")) {
    return notSubmitted(session, options.clientRunId, "Le mémo vocal ne peut pas être envoyé.");
  }
  const attachmentId = audio.serverId || audio.id;
  const identity = "memo:" + attachmentId;
  const clientRunId = options.clientRunId || "memo_" + crypto.createHash("sha256").update(JSON.stringify([session, attachmentId])).digest("hex");
  const reservation = await reserveSubmittedRun(identity, session, clientRunId, {
    userText: "Mémo vocal", attachments, requestText: identity, executionSource: "capability_first", memoAttachmentId: attachmentId,
  });
  if (reservation.created) {
    // One durable reservation is the worker claim. A duplicate/restart never invokes STT again.
    void continueMemoIntent(reservation.status.runId, session, clientRunId, attachmentId, options.authority);
  }
  return {...responseFromExisting(reservation.status, reservation.status.userText || "Mémo vocal"), duplicate: !reservation.created};
}

async function continueMemoIntent(runId: string, sessionId: string, clientRunId: string, attachmentId: string,
  authority: "owner"): Promise<void> {
  try {
    const transcript = await transcribeMemoAttachment(attachmentId);
    if (!transcript.success) {
      await markSubmittedRunFailed(runId, "Transcription du mémo indisponible.");
      return;
    }
    if (!await claimMemoTranscript(runId, attachmentId, transcript.text)) return;
    const result = await submitTextIntent(transcript.text, sessionId, [], {userText: transcript.text, clientRunId, authority}, runId);
    if (!result.accepted) await markSubmittedRunFailed(runId, "Le mémo n'a pas pu être pris en charge.");
  } catch {
    // Never expose provider errors, paths, config or raw details; never retry an uncertain effect.
    await markSubmittedRunFailed(runId, "Transcription du mémo indisponible.");
  }
}

async function submitTextIntent(
  text: string,
  sessionId = "default",
  attachments: IntentAttachment[] = [],
  options: SubmissionOptions = {},
  reservedMemoRunId?: string,
): Promise<IntentSubmitResponse> {
  const normalized = reservedMemoRunId ? text : text.trim();
  const visibleUserText = reservedMemoRunId ? text : (options.userText || normalized).trim();
  const normalizedSessionId = normalizeCompanionSessionId(sessionId);
  const clientRunId = String(options.clientRunId || "").trim() || undefined;
  const learningOnly = options.learningOnly === true;
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
    });
    if (existing) return responseFromExisting(existing, visibleUserText);
  }

  let routingText = normalized;
  let parentClarificationRunId: string | undefined;
  let fastPathCheck: FastPathResult = { status: "miss", reason: "attachments_require_model" };
  if (attachments.length === 0 && !learningOnly) {
    const pending = await findPendingClarificationRun(normalizedSessionId);
    if (pending) {
      const clarified = await runModelFastPath(normalized, {
        surface: "claw_live", caller: "owner", originId: clientRunId || normalizedSessionId,
        timeoutSeconds: 12, checkOnly: true,
        clarificationDecision: pending.decision, clarificationOriginalText: pending.text,
      });
      if (clarified.status === "clarification_unrelated") {
        await markClarificationRun(pending.runId, "abandoned");
      } else {
        parentClarificationRunId = pending.runId;
        fastPathCheck = clarified;
        routingText = String((clarified.resolution as any)?.text || normalized);
      }
    }
    if (!parentClarificationRunId) {
      fastPathCheck = await runModelFastPath(normalized, {
        surface: "claw_live", caller: "owner", originId: clientRunId || normalizedSessionId,
        timeoutSeconds: 12, checkOnly: true,
      });
    }
  }

  if (["eligible", "clarification", "known_error"].includes(String(fastPathCheck.status || ""))) {
    return executeCapabilityFirst(
      routingText, normalizedSessionId, visibleUserText, attachments, clientRunId, fastPathCheck,
      parentClarificationRunId, reservedMemoRunId,
    );
  }
  if (fastPathCheck.status === "error") {
    return notSubmitted(
      normalizedSessionId, clientRunId,
      "Claw capability routing is temporarily unavailable.",
    );
  }

  if (parentClarificationRunId) {
    await markClarificationRun(parentClarificationRunId, "resolved");
  }

  const gateway = await getGatewayStatus();
  if (!gateway.reachable) {
    return notSubmitted(normalizedSessionId, clientRunId, gateway.message);
  }

  const promptWithAttachments = appendAttachmentContext(parentClarificationRunId ? routingText : normalized, attachments);
  const routed = learningOnly ? null : buildAutoSkillContextForIntent(promptWithAttachments);
  const submittedPrompt = learningOnly ? promptWithAttachments : await appendVoiceConversationContext(routed?.prompt || promptWithAttachments, normalizedSessionId);

  let runId = reservedMemoRunId || `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  let duplicate = false;
  if (reservedMemoRunId) {
    if (!await claimMemoDispatch(runId, normalized, "gateway")) return notSubmitted(normalizedSessionId, clientRunId, "Mémo annulé ou déjà pris en charge.");
  } else if (clientRunId) {
    const reservation = await reserveSubmittedRun(
      submittedPrompt,
      normalizedSessionId,
      clientRunId,
      { userText: visibleUserText, attachments, requestText: normalized, executionSource: "gateway" },
    );
    runId = reservation.status.runId;
    duplicate = !reservation.created;
    if (duplicate) return responseFromExisting(reservation.status, visibleUserText);
  }

  const accepted = acceptedRun(runId, normalizedSessionId);
  if (!clientRunId) {
    await rememberSubmittedRun(submittedPrompt, accepted, { userText: visibleUserText, attachments });
  }
  void submitIntentInBackground(submittedPrompt, runId, normalizedSessionId, visibleUserText, attachments, options.authority);

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
    gatewayRun: includeRawIntent() ? { ...accepted, skillRouting: routed?.routed } : undefined,
  };
}

async function executeCapabilityFirst(
  text: string,
  sessionId: string,
  userText: string,
  attachments: IntentAttachment[],
  clientRunId: string | undefined,
  check: FastPathResult,
  parentClarificationRunId?: string,
  reservedMemoRunId?: string,
): Promise<IntentSubmitResponse> {
  let runId = reservedMemoRunId || `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  let duplicate = false;
  if (reservedMemoRunId) {
    if (!await claimMemoDispatch(runId, userText, "capability_first", check.decision, parentClarificationRunId)) return notSubmitted(sessionId, clientRunId, "Mémo annulé ou déjà pris en charge.");
  } else if (clientRunId) {
    const reservation = await reserveSubmittedRun(text, sessionId, clientRunId, {
      userText, attachments, requestText: text, executionSource: "capability_first",
      decision: check.decision, parentClarificationRunId,
    });
    runId = reservation.status.runId;
    duplicate = !reservation.created;
    if (duplicate) return responseFromExisting(reservation.status, userText);
  } else {
    await rememberSubmittedRun(text, acceptedRun(runId, sessionId), {
      userText, attachments, executionSource: "capability_first", decision: check.decision, parentClarificationRunId,
    });
  }
  if (parentClarificationRunId) {
    await markClarificationRun(parentClarificationRunId, "resolved");
  }

  let presentation = readReceiptPresentation(check);
  let provenance: FastPathResult["provenance"];
  let state: "done" | "failed";
  let message: string;
  if (check.status === "clarification") {
    state = "done";
    message = String(check.text || "Précise ce que tu veux faire.");
  } else if (check.status === "known_error") {
    state = "failed";
    message = String(check.text || "Claw identified this capability but did not authorize its execution.");
  } else {
    const result = await runModelFastPath(text, {
      surface: "claw_live",
      caller: "owner",
      originId: clientRunId || runId,
      timeoutSeconds: 75,
      preparedDecision: check.decision,
    });
    presentation = readReceiptPresentation(result);
    provenance = result.provenance;
    if (result.status === "hit") {
      state = "done";
      message = String(result.text || "Claw completed the capability.");
    } else if (result.status === "known_error") {
      state = "failed";
      message = String(result.text || "Claw could not complete the known capability.");
    } else {
      state = "failed";
      message = "Claw capability state changed before deterministic execution; no model fallback was used.";
    }
  }

  presentation ||= fallbackReceiptPresentation(state === "failed");
  await settleSubmittedRun(runId, state, message, {provenance, presentation});
  return {
    success: true,
    accepted: true,
    submissionState: "accepted",
    retrySafe: false,
    duplicate,
    ...publicReceiptMetadata(presentation),
    ...(publicDecision(check.decision) ? {decision: publicDecision(check.decision)} : {}),
    runId,
    clientRunId,
    sessionId,
    state,
    result: state === "done" ? message : undefined,
    message,
    userText,
    canvas: intentCanvas(userText, message),
    attachments,
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
  };
}

async function submitIntentInBackground(
  text: string,
  runId: string,
  sessionId: string,
  userText: string,
  attachments: IntentAttachment[],
  authority?:"owner",
) {
  try {
    const openclaw = await submitToOpenClawAgent(text, runId, sessionId, {authority});
    await rememberSubmittedRun(text, {
      ...openclaw,
      runId,
      sessionId,
    }, { userText, attachments });
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

function acceptedRun(runId: string, sessionId: string): OpenClawAgentSubmitResult {
  return {
    runId,
    sessionId,
    sessionKey: expectedCompanionSessionKey(sessionId),
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

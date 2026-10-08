import crypto from "crypto";
import { getGatewayStatus } from "./openclawGatewayClient";
import { describeOpenClawResult, expectedCompanionSessionKey, normalizeCompanionSessionId, submitToOpenClawAgent } from "./openclawAgentClient";
import { intentCanvas } from "./canvas";
import { appendVoiceConversationContext, findSubmittedRunByClientRunId, markSubmittedRunFailed, rememberSubmittedRun, reserveSubmittedRun, settleSubmittedRun } from "./runs";
import { buildAutoSkillContextForIntent } from "./skills";
import type { OpenClawAgentSubmitResult } from "./openclawAgentClient";
import type { CompanionRunStatus, IntentAttachment, IntentSubmitResponse } from "./types";
import { runModelFastPath, type FastPathResult } from "../modelFastPath";

export async function submitIntent(
  text: string,
  sessionId = "default",
  attachments: IntentAttachment[] = [],
  options: { userText?: string; clientRunId?: string } = {},
): Promise<IntentSubmitResponse> {
  const normalized = text.trim();
  const visibleUserText = (options.userText || normalized).trim();
  const normalizedSessionId = normalizeCompanionSessionId(sessionId);
  const clientRunId = String(options.clientRunId || "").trim() || undefined;
  if (!normalized) {
    return notSubmitted(normalizedSessionId, clientRunId, "Intent text is required.");
  }

  if (clientRunId) {
    const existing = await findSubmittedRunByClientRunId(clientRunId, {
      text: normalized,
      sessionId: normalizedSessionId,
      userText: visibleUserText,
      attachments,
    });
    if (existing) return responseFromExisting(existing, visibleUserText);
  }

  const fastPathCheck: FastPathResult = attachments.length === 0
    ? await runModelFastPath(normalized, {
        surface: "claw_live",
        caller: "owner",
        originId: clientRunId || normalizedSessionId,
        timeoutSeconds: 12,
        checkOnly: true,
      })
    : { status: "miss", reason: "attachments_require_model" };

  if (["eligible", "clarification", "known_error"].includes(String(fastPathCheck.status || ""))) {
    return executeCapabilityFirst(
      normalized, normalizedSessionId, visibleUserText, attachments, clientRunId, fastPathCheck,
    );
  }
  if (fastPathCheck.status === "error") {
    return notSubmitted(
      normalizedSessionId, clientRunId,
      "Claw capability routing is temporarily unavailable.",
    );
  }

  const gateway = await getGatewayStatus();
  if (!gateway.reachable) {
    return notSubmitted(normalizedSessionId, clientRunId, gateway.message);
  }

  const promptWithAttachments = appendAttachmentContext(normalized, attachments);
  const routed = buildAutoSkillContextForIntent(promptWithAttachments);
  const submittedPrompt = await appendVoiceConversationContext(routed?.prompt || promptWithAttachments, normalizedSessionId);

  let runId = `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  let duplicate = false;
  if (clientRunId) {
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
  void submitIntentInBackground(submittedPrompt, runId, normalizedSessionId, visibleUserText, attachments);

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
): Promise<IntentSubmitResponse> {
  let runId = `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  let duplicate = false;
  if (clientRunId) {
    const reservation = await reserveSubmittedRun(text, sessionId, clientRunId, {
      userText, attachments, requestText: text, executionSource: "capability_first",
    });
    runId = reservation.status.runId;
    duplicate = !reservation.created;
    if (duplicate) return responseFromExisting(reservation.status, userText);
  } else {
    await rememberSubmittedRun(text, acceptedRun(runId, sessionId), { userText, attachments });
  }

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
    });
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

  await settleSubmittedRun(runId, state, message);
  return {
    success: true,
    accepted: true,
    submissionState: "accepted",
    retrySafe: false,
    duplicate,
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
) {
  try {
    const openclaw = await submitToOpenClawAgent(text, runId, sessionId);
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

function appendAttachmentContext(text: string, attachments: IntentAttachment[]) {
  const imageAttachments = attachments.filter((attachment) =>
    String(attachment.type || "").toLowerCase() === "image" && (attachment.path || attachment.serverPath),
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
    "Attached image files are available on the local Termux filesystem:",
    ...attachmentLines,
    "Use these image paths as supporting evidence when the task depends on the shared image.",
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

import crypto from "crypto";
import {compactOwnerAgentContext} from "./clawLive";
import fs from "fs";
import os from "os";
import path from "path";
import { capabilityBridge } from "./capabilityBridge";
import { handleMcpRelayRequest } from "./mcpBridge";
import { reconnectDelay } from "./reconnectPolicy";
import {
  isVoiceRealignment, planVoiceSpeech, readVoiceUnderstood, realignmentChoice, realignmentRoundPayload,
  realignmentSpeech, voiceTurnContext, type VoiceTurnContext,
} from "./voiceUnderstanding";
import { captureVoiceRound, type RoundCaptureRunner } from "./voiceRoundLearning";
import { readReceiptPresentation } from "./receiptPresentation";
import { DialogueSurface, type SurfaceTurn } from "../dialogueSurface";
import { runModelFastPath } from "../modelFastPath";
export { reconnectDelay } from "./reconnectPolicy";
import {
  callOpenClawGateway,
  assertCanonicalAgentPayload,
  expectedCompanionSessionKey,
} from "./openclawAgentClient";

type RelayConfig = {
  url: string;
  tokenFile: string;
  heartbeatMs: number;
};

type RelayState =
  | "disabled"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "unavailable";

type PendingConversation = {
  kind: "deterministic" | "agent" | "realignment" | "capability";
  realignment?: VoiceTurnContext;
  clarificationId?: string;
  originalRequest: string;
  target?: string;
  agentSessionId?: string;
  at: number;
};

type AgentTurn =
  | { state: "done"; text: string }
  | { state: "needs_clarification"; question: string };

const CONFIG_PATH =
  process.env.CLAW_VOICE_RELAY_CONFIG ||
  path.join(os.homedir(), ".openclaw", "voice-relay", "config.json");
const MAX_REQUEST_CHARS = 12000;
const RECENT_TTL_MS = 10 * 60_000;
const CONVERSATION_TTL_MS = 30 * 60_000;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
// A socket that is not authenticated within this delay is abandoned: after a network
// switch a dead TCP connection can stay CONNECTING or CLOSING without ever emitting close.
const CONNECT_DEADLINE_MS = Number(process.env.CLAW_VOICE_RELAY_CONNECT_DEADLINE_MS || 20_000);

let config: RelayConfig | null = null;
let socket: any = null;
let state: RelayState = "disabled";
let authenticated = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let connectTimer: NodeJS.Timeout | null = null;
let attempts = 0;
let lastConnectedAt = 0;
let lastPongAt = 0;
let lastError = "";

const recent = new Map<string, { hash: string; at: number; response: any }>();
const VOICE_SURFACE = "bixby_claw";
// SAM-MIG V2.2: the dialogue coordinator owns the pending question; `conversations` below keeps only the relay's
// transport binding (conversationId -> coordinator conversation id), never a question nor a decision.
let voiceDialogue = new DialogueSurface(runModelFastPath, "voice", VOICE_SURFACE);
const conversations = new Map<string, PendingConversation>();
// Lot 41 V2: last deterministic voice turn (bounded projection, no transcript), 2-minute window.
let lastRelayTurn: VoiceTurnContext | null = null;
let roundCapture: RoundCaptureRunner = captureVoiceRound;
/** Test seam only: the production runner is the canonical learning_gate capture-round. */
export function setVoiceRelayRoundCaptureForTest(runner: RoundCaptureRunner | null) { roundCapture = runner || captureVoiceRound; }
export function resetVoiceRelayUnderstandingForTest() { lastRelayTurn = null; }

function expandHome(value: string) {
  return value.replace(/^~(?=\/|$)/, os.homedir());
}

function readConfig(): RelayConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const url = String(raw?.url || "").trim();
  if (!/^wss:\/\//.test(url)) throw new Error("voice_relay_url_must_be_wss");
  const tokenFile = expandHome(
    String(
      raw?.tokenFile ||
        path.join(
          os.homedir(),
          ".openclaw",
          "credentials",
          "voice-relay-device.token",
        ),
    ),
  );
  if (!fs.existsSync(tokenFile)) throw new Error("voice_relay_token_missing");
  const heartbeatSeconds = Math.max(
    20,
    Math.min(180, Number(raw?.heartbeatSeconds || 45)),
  );
  return {
    url,
    tokenFile,
    heartbeatMs: Math.round(heartbeatSeconds * 1000),
  };
}

function deviceToken(cfg: RelayConfig) {
  const value = fs.readFileSync(cfg.tokenFile, "utf8").trim();
  if (value.length < 24) throw new Error("voice_relay_token_invalid");
  return value;
}

function requestHash(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function newConversationId() {
  return "conv-" + crypto.randomBytes(12).toString("hex");
}

function cleanupRecent(now = Date.now()) {
  for (const [key, value] of recent) {
    if (now - value.at > RECENT_TTL_MS) recent.delete(key);
  }
}

function cleanupConversations(now = Date.now()) {
  for (const [key, value] of conversations) {
    if (now - value.at > CONVERSATION_TTL_MS) conversations.delete(key);
  }
}

export function voiceRelayHealth() {
  cleanupConversations();
  return {
    state,
    configured: Boolean(config),
    connected: state === "connected" && authenticated,
    authenticated,
    attempts,
    lastConnectedAt: lastConnectedAt || null,
    lastPongAt: lastPongAt || null,
    lastError: lastError || null,
    heartbeatSeconds: config ? Math.round(config.heartbeatMs / 1000) : null,
    pendingConversations: conversations.size,
  };
}

function labelsForChoices(choices: unknown[]) {
  const labels: Record<string, string> = {
    recharge: "solde de recharge",
    balances: "tous les soldes",
    principal: "solde principal",
  };
  return choices.map((value) => labels[String(value)] || String(value));
}

function questionForChoices(choices: unknown[]) {
  return "Précise : " + labelsForChoices(choices).join(" ou ") + ".";
}

/** Voice executes a resolved capability directly only when it is deterministic, needs no confirmation and its
 * registry risk is "read" or "low". O10 (fichier 37) : "low" is the owner-only voice decision record
 * (samantha.voice.decision.record, no biometrics, no confirmation, decision of Amine 10/10). Anything else, and
 * every payment or confirmed path, keeps going to the agent turn. */
export const VOICE_DIRECT_RISKS = new Set(["read", "low"]);
export function deterministicVoiceAdmission(resolved: any): boolean {
  const selected = resolved?.selected;
  return !(
    resolved?.success === false ||
    selected?.deterministic !== true ||
    !VOICE_DIRECT_RISKS.has(String(selected?.risk || "")) ||
    resolved?.confirmation_required === true ||
    selected?.confirmation_required === true
  );
}

export function extractFastClarification(value: any) {
  const execution = value?.execution;
  const result = execution?.result;
  if (
    !execution ||
    execution.state !== "completed" ||
    !result ||
    typeof result !== "object"
  ) {
    return null;
  }
  // A capability that lacks one parameter asks its own question (O10: "Quelle décision veux-tu que je note ?").
  if (result.state === "needs_parameter" && typeof result.question === "string" && result.question.trim()) {
    return { question: result.question.trim().slice(0, 300), choices: [] as string[] };
  }
  if (
    result.state === "needs_counter" &&
    result.sent === false &&
    Array.isArray(result.choices) &&
    result.choices.length
  ) {
    return {
      question: questionForChoices(result.choices),
      choices: result.choices.map((item: any) => String(item)),
    };
  }
  return null;
}

export function renderFastVoiceResult(value: any): string | null {
  const execution = value?.execution;
  const result = execution?.result;
  if (
    !execution ||
    execution.state !== "completed" ||
    !result ||
    typeof result !== "object"
  ) {
    return null;
  }
  if (extractFastClarification(value)) return null;
  if (result.ok !== true) return null;

  for (const key of ["text", "message", "summary"]) {
    if (typeof result[key] === "string" && result[key].trim()) {
      return result[key].trim();
    }
  }

  const data = result.data;
  if (!data || typeof data !== "object") return null;
  const labels: Record<string, string> = {
    recharge: "solde de recharge",
    forfait: "forfait",
    forfait_bonus: "bonus sur recharge",
    data: "data restante",
    voice: "voix restante",
    phone_number: "numéro",
    offer: "offre",
  };
  const parts: string[] = [];
  const pushValue = (label: string, item: any) => {
    if (!item || typeof item !== "object" || item.value === undefined) return;
    const unit = item.unit ? " " + String(item.unit) : "";
    parts.push(label + " : " + String(item.value) + unit);
  };

  const balances = (data as Record<string, any>).balances;
  if (balances && typeof balances === "object") {
    for (const [key, item] of Object.entries(balances as Record<string, any>)) {
      pushValue(labels[key] || key, item);
    }
  }

  for (const [key, item] of Object.entries(data as Record<string, any>)) {
    if (key === "balances" || key === "cards") continue;
    pushValue(labels[key] || key, item);
  }

  const cards = (data as Record<string, any>).cards;
  if (Array.isArray(cards)) {
    const duplicateTitles = new Set([
      "compte de recharge",
      "forfait du mois en cours",
      "bonus sur recharge",
    ]);
    for (const card of cards) {
      if (!card || typeof card !== "object" || card.value === undefined) continue;
      const title = String(card.title || "").trim();
      if (!title || duplicateTitles.has(title.toLowerCase())) continue;
      pushValue(title, card);
    }
  }

  return parts.length ? [...new Set(parts)].slice(0, 8).join(", ") + "." : null;
}

function extractAgentText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  for (const key of ["result", "message", "text", "output", "summary"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].trim();
    }
  }
  return extractAgentText(value.final) || extractAgentText(value.response);
}

function explicitClarificationQuestion(value: any, depth = 0): string {
  if (!value || typeof value !== "object" || depth > 5) return "";

  if (
    value.state === "needs_clarification" &&
    typeof value.question === "string" &&
    value.question.trim()
  ) {
    return value.question.trim();
  }

  const execution = value.execution;
  if (
    execution &&
    typeof execution === "object" &&
    execution.state === "needs_clarification"
  ) {
    if (typeof execution.question === "string" && execution.question.trim()) {
      return execution.question.trim();
    }
    if (Array.isArray(execution.choices) && execution.choices.length) {
      return questionForChoices(execution.choices);
    }
  }

  for (const key of ["final", "response", "result"]) {
    const nested = explicitClarificationQuestion(value[key], depth + 1);
    if (nested) return nested;
  }
  return "";
}

export function looksLikeClarificationQuestion(text: string) {
  const value = String(text || "").trim();
  if (!value || value.length > 600 || !/\?\s*$/.test(value)) return false;

  const lead =
    /^(pr[eé]cise|peux-tu pr[eé]ciser|quel|quelle|quels|quelles|quand|o[uù]|combien|lequel|laquelle|lesquels|lesquelles|dois-je|veux-tu|souhaites-tu|est-ce que)\b/i;
  if (lead.test(value)) return true;

  const sentences = value
    .split(/[.!?]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return sentences.length === 1 && value.length <= 240;
}

export function classifyAgentTurn(value: any): AgentTurn {
  const explicit = explicitClarificationQuestion(value);
  if (explicit) {
    return { state: "needs_clarification", question: explicit };
  }

  const text = extractAgentText(value);
  if (looksLikeClarificationQuestion(text)) {
    return { state: "needs_clarification", question: text };
  }
  return { state: "done", text };
}

export function composeContinuationRequest(
  originalRequest: string,
  answer: string,
) {
  const original = String(originalRequest || "").trim();
  const clarification = String(answer || "").trim();
  return (original + "\nPrécision utilisateur : " + clarification).slice(
    0,
    MAX_REQUEST_CHARS,
  );
}

async function resolveDeterministic(request: string, targetHint?: string) {
  const resolved: any = await capabilityBridge(request, {
    execute: false,
    surface: "bixby_claw",
    caller: "owner",
    timeoutSeconds: 20,
    targetHint,
  });
  if (!deterministicVoiceAdmission(resolved)) {
    return null;
  }

  const executed: any = await capabilityBridge(request, {
    execute: true,
    surface: "bixby_claw",
    caller: "owner",
    timeoutSeconds: 30,
    targetHint,
  });

  const clarification = extractFastClarification(executed);
  // Lot 41 V1/V3: imposed text built from the owner receipt (HS3 understood/failure, else decision v2).
  const speech = planVoiceSpeech(executed, { locale: "fr" });
  const context = voiceTurnContext(executed, request, { locale: "fr", scope: "bixby_claw" });
  lastRelayTurn = context;
  if (clarification) {
    return {
      state: "needs_clarification" as const,
      context,
      question: speech.understood ? speech.understood + " " + clarification.question : clarification.question,
      choices: clarification.choices,
      capability: executed?.capability || null,
      route: executed?.selected?.route || executed?.execution?.route || null,
      target: executed?.selected?.target || executed?.skill_plan?.target || targetHint || null,
    };
  }

  if (speech.failure && explicitExecutionFailure(executed)) {
    // V3: the step and the readable reason, never a code; no agent fallback that could rephrase it.
    return {
      state: "failed" as const,
      context,
      text: speech.verbatim as string,
      capability: executed?.capability || null,
      route: executed?.selected?.route || executed?.execution?.route || null,
      target: executed?.selected?.target || executed?.skill_plan?.target || targetHint || null,
    };
  }
  const rendered = renderFastVoiceResult(executed);
  if (!rendered) return null;
  const text = speech.understood ? speech.understood + " " + rendered : rendered;
  return {
    state: "done" as const,
    context,
    text,
    capability: executed?.capability || null,
    route: executed?.selected?.route || executed?.execution?.route || null,
    target: executed?.selected?.target || executed?.skill_plan?.target || targetHint || null,
  };
}

/** V3 applies to an explicit failure of the owner: HS3 failure, or a failed/timeout/unavailable execution. */
function explicitExecutionFailure(value: any) {
  const p = readReceiptPresentation(value);
  if (p?.status === "error" && p.failure) return true;
  return ["failed", "timeout", "unavailable"].includes(String(value?.execution?.state || ""));
}

async function runAgentTurn(
  sessionId: string,
  requestId: string,
  message: string,
) {
  lastRelayTurn = null; // a free agent turn has no harness understanding to correct
  const sessionKey = expectedCompanionSessionKey(sessionId);
  const canonical=compactOwnerAgentContext({authority:"owner"});
  const params = {
      sessionKey,
      label: "Bixby Voice",
      message,
      deliver: false,
      bootstrapContextMode: "lightweight",
      ...(canonical?{extraSystemPrompt:canonical}:{}),
      idempotencyKey: requestId,
  };
  assertCanonicalAgentPayload(params);
  const raw = await callOpenClawGateway(
    "agent", params,
    { expectFinal: true, timeoutMs: 20_000 },
  );
  return classifyAgentTurn(raw);
}

function clarificationResponse(
  conversationId: string,
  source: string,
  question: string,
  extra: Record<string, any> = {},
) {
  return {
    success: true,
    state: "needs_clarification",
    source,
    conversationId,
    question,
    text: question,
    ...extra,
  };
}

function realignmentResponse(context: VoiceTurnContext, learning: any) {
  const conversationId = newConversationId();
  conversations.set(conversationId, { kind: "realignment", originalRequest: "", realignment: context, at: Date.now() });
  return clarificationResponse(conversationId, "voice_realignment", realignmentSpeech(context), {
    alternatives: context.alternatives,
    understood: { capability: context.understood.capability, label: context.understood.label, source: context.understood.source },
    learning,
  });
}

async function runVoiceRequest(requestId: string, request: string) {
  // V2: a listed correction gesture within 2 minutes of the last voice turn reopens the guided realignment.
  const previous = lastRelayTurn;
  if (previous && isVoiceRealignment(request, previous.at)) {
    const payload = realignmentRoundPayload(previous, "requested");
    const learning = payload ? await roundCapture(payload) : { state: "skipped", reason: "no_target_intent" };
    return realignmentResponse(previous, learning);
  }
  const turn = await voiceDialogue.turn(request, { originId: requestId });
  if (turn.state !== "continue") lastRelayTurn = voiceTurnContext(surfaceVoiceReceipt(turn), request, { locale: "fr", scope: "bixby_claw" });
  if (turn.state === "needs_clarification") {
    const conversationId = newConversationId();
    conversations.set(conversationId, {
      kind: "capability", originalRequest: request, clarificationId: turn.clarificationId, at: Date.now(),
    });
    return clarificationResponse(conversationId, "capability", spokenCapabilityText(turn), { choices: turn.choices });
  }
  if (turn.state === "done" || turn.state === "failed") {
    return { success: turn.state === "done", state: turn.state, source: "capability", text: spokenCapabilityText(turn), capability: readVoiceUnderstood(surfaceVoiceReceipt(turn))?.capability || null, route: readVoiceUnderstood(surfaceVoiceReceipt(turn))?.route || null };
  }
  return runVoiceLegacy(requestId, turn.text);
}

function surfaceVoiceReceipt(turn: SurfaceTurn) {
  return { ...turn, success: turn.state !== "failed", execution: {
    state: turn.state === "failed" ? "failed" : turn.state === "needs_clarification" ? "needs_clarification" : "completed",
    result: "result" in turn ? turn.result : undefined,
  } };
}
function spokenCapabilityText(turn: SurfaceTurn) {
  const envelope = surfaceVoiceReceipt(turn);
  const speech = planVoiceSpeech(envelope, { locale: "fr" });
  if (speech.failure) return speech.verbatim || ("text" in turn ? turn.text : turn.question);
  const rendered = "result" in turn && turn.result && typeof turn.result === "object"
    ? renderFastVoiceResult(envelope) : null;
  const text = rendered || ("text" in turn ? turn.text : turn.question);
  return speech.understood ? speech.understood + " " + text : text;
}

async function runVoiceCapabilityContinuation(requestId: string, conversationId: string, pending: PendingConversation, answer: string) {
  const turn = await voiceDialogue.turn(answer, { id: pending.clarificationId, originId: requestId });
  if (turn.state !== "continue") lastRelayTurn = voiceTurnContext(surfaceVoiceReceipt(turn), answer, { locale: "fr", scope: "bixby_claw" });
  if (turn.state === "needs_clarification") {
    pending.clarificationId = turn.clarificationId;
    pending.at = Date.now();
    return clarificationResponse(conversationId, "capability", spokenCapabilityText(turn), { choices: turn.choices });
  }
  conversations.delete(conversationId);
  if (turn.state === "done" || turn.state === "failed") {
    return { success: turn.state === "done", state: turn.state, source: "capability", text: spokenCapabilityText(turn), capability: readVoiceUnderstood(surfaceVoiceReceipt(turn))?.capability || null, route: readVoiceUnderstood(surfaceVoiceReceipt(turn))?.route || null };
  }
  // Resolved (or unrelated) text from resolve-clarification; never "original + Précision utilisateur".
  return runVoiceLegacy(requestId, turn.text);
}

async function runVoiceLegacy(requestId: string, request: string) {
  const deterministic = await resolveDeterministic(request);
  if (deterministic?.state === "failed") {
    return {
      success: false,
      state: "failed",
      source: "deterministic",
      text: deterministic.text,
      capability: deterministic.capability,
      route: deterministic.route,
    };
  }
  if (deterministic?.state === "needs_clarification") {
    const conversationId = newConversationId();
    conversations.set(conversationId, {
      kind: "deterministic",
      originalRequest: request,
      target: deterministic.target || undefined,
      at: Date.now(),
    });
    return clarificationResponse(
      conversationId,
      "deterministic",
      deterministic.question,
      {
        choices: deterministic.choices,
        capability: deterministic.capability,
        route: deterministic.route,
      },
    );
  }
  if (deterministic?.state === "done") {
    return {
      success: true,
      state: "done",
      source: "deterministic",
      text: deterministic.text,
      capability: deterministic.capability,
      route: deterministic.route,
    };
  }

  const conversationId = newConversationId();
  const agentSessionId = "bixby-voice-" + conversationId;
  const turn = await runAgentTurn(agentSessionId, requestId, request);
  if (turn.state === "needs_clarification") {
    conversations.set(conversationId, {
      kind: "agent",
      originalRequest: request,
      agentSessionId,
      at: Date.now(),
    });
    return clarificationResponse(conversationId, "agent", turn.question);
  }

  return {
    success: Boolean(turn.text),
    state: "done",
    source: "agent",
    text: turn.text || "Claw n'a pas retourné de réponse exploitable.",
  };
}

async function runVoiceContinuation(
  requestId: string,
  conversationId: string,
  answer: string,
) {
  cleanupConversations();
  const pending = conversations.get(conversationId);
  if (!pending) {
    return { success: false, error: "conversation_expired" };
  }

  pending.at = Date.now();

  if (pending.kind === "realignment" && pending.realignment) {
    // The answer goes through the normal path (E1); an ordinal/label picks that candidate.
    conversations.delete(conversationId);
    const context = pending.realignment;
    const choice = realignmentChoice(answer, context);
    const response: any = await runVoiceRequest(requestId, choice ? choice.label : answer);
    const payload = realignmentRoundPayload(context, "resolved", { capability: response?.capability || null, route: response?.route || null });
    return payload ? { ...response, realignment_learning: await roundCapture(payload) } : response;
  }
  if (pending.kind === "capability") {
    return runVoiceCapabilityContinuation(requestId, conversationId, pending, answer);
  }

  if (pending.kind === "deterministic") {
    const scoped = pending.target
      ? await resolveDeterministic(answer, pending.target)
      : null;
    if (scoped?.state === "needs_clarification") {
      pending.originalRequest = composeContinuationRequest(pending.originalRequest, answer);
      pending.target = scoped.target || pending.target;
      pending.at = Date.now();
      return clarificationResponse(
        conversationId,
        "deterministic",
        scoped.question,
        {
          choices: scoped.choices,
          capability: scoped.capability,
          route: scoped.route,
        },
      );
    }
    if (scoped?.state === "failed") {
      conversations.delete(conversationId);
      return { success: false, state: "failed", source: "deterministic", text: scoped.text, capability: scoped.capability, route: scoped.route };
    }
    if (scoped?.state === "done") {
      conversations.delete(conversationId);
      return {
        success: true,
        state: "done",
        source: "deterministic",
        text: scoped.text,
        capability: scoped.capability,
        route: scoped.route,
      };
    }

    const refined = composeContinuationRequest(pending.originalRequest, answer);
    const deterministic = await resolveDeterministic(refined);
    if (deterministic?.state === "needs_clarification") {
      pending.originalRequest = refined;
      pending.target = deterministic.target || pending.target;
      pending.at = Date.now();
      return clarificationResponse(
        conversationId,
        "deterministic",
        deterministic.question,
        {
          choices: deterministic.choices,
          capability: deterministic.capability,
          route: deterministic.route,
        },
      );
    }
    if (deterministic?.state === "failed") {
      conversations.delete(conversationId);
      return { success: false, state: "failed", source: "deterministic", text: deterministic.text, capability: deterministic.capability, route: deterministic.route };
    }
    if (deterministic?.state === "done") {
      conversations.delete(conversationId);
      return {
        success: true,
        state: "done",
        source: "deterministic",
        text: deterministic.text,
        capability: deterministic.capability,
        route: deterministic.route,
      };
    }

    const agentSessionId = "bixby-voice-" + conversationId;
    const turn = await runAgentTurn(agentSessionId, requestId, refined);
    if (turn.state === "needs_clarification") {
      conversations.set(conversationId, {
        kind: "agent",
        originalRequest: refined,
        agentSessionId,
        at: Date.now(),
      });
      return clarificationResponse(conversationId, "agent", turn.question);
    }
    conversations.delete(conversationId);
    return {
      success: Boolean(turn.text),
      state: "done",
      source: "agent",
      text: turn.text || "Claw n'a pas retourné de réponse exploitable.",
    };
  }

  const agentSessionId =
    pending.agentSessionId || "bixby-voice-" + conversationId;
  const turn = await runAgentTurn(agentSessionId, requestId, answer);
  if (turn.state === "needs_clarification") {
    pending.agentSessionId = agentSessionId;
    pending.at = Date.now();
    return clarificationResponse(conversationId, "agent", turn.question);
  }

  conversations.delete(conversationId);
  return {
    success: Boolean(turn.text),
    state: "done",
    source: "agent",
    text: turn.text || "Claw n'a pas retourné de réponse exploitable.",
  };
}

async function handleRequest(message: any) {
  const requestId = String(message?.requestId || "").trim();
  const request = String(message?.request || "").trim();
  const conversationId = String(message?.conversationId || "").trim();
  const answer = String(message?.answer || "").trim();
  const isContinuation = Boolean(conversationId || answer);

  const invalidInitial =
    !isContinuation && (!request || request.length > MAX_REQUEST_CHARS);
  const invalidContinuation =
    isContinuation &&
    (!ID_RE.test(conversationId) ||
      !answer ||
      answer.length > MAX_REQUEST_CHARS ||
      Boolean(request));

  if (!ID_RE.test(requestId) || invalidInitial || invalidContinuation) {
    socket?.send(
      JSON.stringify({
        type: "response",
        requestId,
        response: { success: false, error: "invalid_request" },
      }),
    );
    return;
  }

  cleanupRecent();
  cleanupConversations();

  const hash = requestHash({ request, conversationId, answer });
  const prior = recent.get(requestId);
  if (prior) {
    const response =
      prior.hash === hash
        ? prior.response
        : { success: false, error: "request_id_conflict" };
    socket?.send(
      JSON.stringify({ type: "response", requestId, response }),
    );
    return;
  }

  let response: any;
  try {
    response = isContinuation
      ? await runVoiceContinuation(requestId, conversationId, answer)
      : await runVoiceRequest(requestId, request);
  } catch (error: any) {
    response = {
      success: false,
      error: String(error?.message || error).slice(0, 500),
    };
  }

  recent.set(requestId, { hash, at: Date.now(), response });
  socket?.send(JSON.stringify({ type: "response", requestId, response }));
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat() {
  stopHeartbeat();
  if (!config) return;
  heartbeatTimer = setInterval(() => {
    if (!socket || socket.readyState !== 1 || !authenticated) return;
    if (
      lastPongAt &&
      Date.now() - lastPongAt > config!.heartbeatMs * 2.5
    ) {
      abandonSocket(socket, "heartbeat_timeout");
      return;
    }
    try {
      socket.send("ping");
    } catch {}
  }, config.heartbeatMs);
  heartbeatTimer.unref?.();
}

function clearConnectTimer() {
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
}

/**
 * Drops the current socket and reconnects without waiting for its close event, which
 * a half-open connection may never emit. Events from an abandoned socket are ignored.
 */
function abandonSocket(ws: any, reason: string) {
  if (!ws || socket !== ws) return;
  lastError = reason;
  stopHeartbeat();
  clearConnectTimer();
  authenticated = false;
  socket = null;
  try {
    ws.close();
  } catch {}
  if (config) scheduleReconnect();
}

function scheduleReconnect() {
  if (!config || reconnectTimer) return;
  state = "reconnecting";
  const delay = reconnectDelay(attempts++);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  reconnectTimer.unref?.();
}

async function handleMcpMessage(message: any) {
  const requestId = String(message?.requestId || "").slice(0, 128);
  let response: any;
  try {
    response = await handleMcpRelayRequest(message);
  } catch (error: any) {
    response = {
      state: "failed",
      error: String(error?.message || error || "mcp_bridge_failed").slice(0, 500),
    };
  }
  socket?.send(JSON.stringify({ type: "response", requestId, response }));
}

function connect() {
  if (!config) return;
  const WS: any = (globalThis as any).WebSocket;
  if (!WS) {
    state = "unavailable";
    lastError = "websocket_unavailable";
    return;
  }
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
    return;
  }

  state = "connecting";
  authenticated = false;
  const ws = new WS(config.url);
  socket = ws;
  clearConnectTimer();
  connectTimer = setTimeout(() => abandonSocket(ws, "connect_timeout"), CONNECT_DEADLINE_MS);
  connectTimer.unref?.();

  ws.addEventListener("open", () => {
    state = "authenticating";
    try {
      ws.send(
        JSON.stringify({ type: "auth", token: deviceToken(config!) }),
      );
    } catch (error: any) {
      lastError = String(error?.message || error);
      ws.close();
    }
  });

  ws.addEventListener("message", async (event: any) => {
    if (socket !== ws) return;
    try {
      const raw =
        typeof event.data === "string" ? event.data : await event.data.text();

      if (raw === "pong") {
        lastPongAt = Date.now();
        return;
      }

      const message = JSON.parse(raw);
      if (message.type === "auth_ok") {
        clearConnectTimer();
        authenticated = true;
        state = "connected";
        attempts = 0;
        lastConnectedAt = Date.now();
        lastPongAt = Date.now();
        startHeartbeat();
        return;
      }

      if (message.type === "mcp_request" && authenticated) {
        void handleMcpMessage(message);
        return;
      }

      if (message.type === "request" && authenticated) {
        void handleRequest(message);
      }
    } catch (error: any) {
      lastError = String(error?.message || error).slice(0, 500);
    }
  });

  ws.addEventListener("error", () => {
    abandonSocket(ws, "voice_relay_websocket_error");
  });

  ws.addEventListener("close", () => {
    abandonSocket(ws, lastError || "voice_relay_closed");
  });
}

/** Test seam: canonical voice turns with an injected fast-path runner (no relay socket). */
export const voiceRelayTurnsForTest = {
  useDialogue(value: DialogueSurface) { voiceDialogue = value; },
  request: (requestId: string, request: string) => runVoiceRequest(requestId, request),
  continuation: (requestId: string, conversationId: string, answer: string) => runVoiceContinuation(requestId, conversationId, answer),
};

export function startVoiceRelay() {
  try {
    config = readConfig();
    if (!config) {
      state = "disabled";
      return voiceRelayHealth();
    }
    connect();
  } catch (error: any) {
    state = "unavailable";
    lastError = String(error?.message || error).slice(0, 500);
  }
  return voiceRelayHealth();
}

export function stopVoiceRelay() {
  config = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopHeartbeat();
  clearConnectTimer();
  try {
    socket?.close();
  } catch {}
  socket = null;
  authenticated = false;
  conversations.clear();
  state = "disabled";
}

/** Test seam: one relay turn without a socket (initial request, or continuation with conversationId + answer). */
export async function voiceRelayTurnForTest(requestId: string, request: string, conversationId = "", answer = "") {
  return conversationId ? runVoiceContinuation(requestId, conversationId, answer) : runVoiceRequest(requestId, request);
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MODEL = "gemini-3.8-live";
const WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const OPENCLAW_DIST = "/data/data/com.termux/files/usr/lib/node_modules/openclaw/dist";
const CAPABILITY_URL = "http://127.0.0.1:8765/v1/extensions/capability-bridge/execute";
const TOOL_NAME = "clawmobile_capability";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
export async function resolveGeminiApiKey(env = process.env) {
  if (env.GEMINI_API_KEY) return String(env.GEMINI_API_KEY);
  const names = fs.readdirSync(OPENCLAW_DIST)
    .filter((name) => /^secret-store-.*\.mjs$/.test(name))
    .sort();
  for (const name of names) {
    try {
      const mod = await import(pathToFileURL(path.join(OPENCLAW_DIST, name)).href);
      if (typeof mod.c !== "function") continue;
      const result = mod.c({ name: "GEMINI_API_KEY", scope: { kind: "team", id: "" } });
      if (result?.ok === true && typeof result.value === "string" && result.value) {
        return result.value;
      }
    } catch {}
  }
  throw new Error("gemini_api_key_unavailable");
}

export function buildSetupMessage(surface = "claw_live") {
  return {
    setup: {
      model: `models/${MODEL}`,
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: {
        parts: [{
          text: [
            "You are Samantha in Claw Live.",
            "Use concise natural French unless the user asks otherwise.",
            "A capability belongs to Claw, not to a provider.",
            "For personal state, device actions, telecom, contacts, calendar, messaging, automation or any request that Claw may know how to execute, call clawmobile_capability.",
            "When calling clawmobile_capability, pass the user's request verbatim whenever possible; do not generalize or drop qualifiers.",
            "Treat execution.state=completed with execution.result.ok=true as authoritative and answer from that result.",
            "If execution.state=needs_clarification, ask only for one of the returned choices and do not suggest external apps.",
            "Do not claim a Claw action is impossible before using the tool.",
            "Respect confirmation_required returned by Claw and never invent successful execution."
          ].join(" ")
        }]
      },
      tools: [{
        functionDeclarations: [{
          name: TOOL_NAME,
          description: "Resolve and execute the shortest healthy reachable Claw capability route for the owner's request.",
          behavior: "BLOCKING",
          parameters: {
            type: "OBJECT",
            properties: {
              request: { type: "STRING", description: "The user's request to resolve and execute through Claw." }
            },
            required: ["request"]
          }
        }]
      }]
    }
  };
}
function bounded(value, maxChars = 12000) {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= maxChars) return value;
  } catch {}
  return { state: "result_too_large", summary: String(value).slice(0, 1000) };
}

export function compactCapabilityResult(value) {
  if (!value || typeof value !== "object") return { result: value };
  const selected = value.selected && typeof value.selected === "object" ? value.selected : null;
  const execution = value.execution && typeof value.execution === "object" ? value.execution : null;
  const rawResult = execution?.result;
  const needsCounter = execution?.state === "completed"
    && rawResult && typeof rawResult === "object"
    && rawResult.state === "needs_counter"
    && rawResult.sent === false
    && Array.isArray(rawResult.choices);
  return bounded({
    capability_revision: value.capability_revision,
    capability: value.capability,
    confirmation_required: Boolean(value.confirmation_required),
    selected: selected ? {
      executor: selected.executor,
      route: selected.route,
      risk: selected.risk,
      state: selected.state
    } : null,
    execution: execution ? {
      state: needsCounter ? "needs_clarification" : execution.state,
      executor: execution.executor,
      route: execution.route,
      ...(needsCounter ? {
        choices: rawResult.choices,
        instruction: "Ask the user to choose one of the listed choices. This is not a route failure."
      } : {
        result: bounded(rawResult, 8000)
      })
    } : null
  });
}
export async function executeCapability(request, {
  surface = "claw_live",
  fetchImpl = globalThis.fetch,
  timeoutMs = 35000,
  url = CAPABILITY_URL
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, surface, caller: "owner", timeoutSeconds: Math.ceil(timeoutMs / 1000) }),
      signal: controller.signal
    });
    const value = await response.json();
    if (!response.ok || value?.success === false) {
      throw new Error(`capability_bridge_failed:${response.status}`);
    }
    return compactCapabilityResult(value);
  } finally {
    clearTimeout(timer);
  }
}

export function buildToolResponse(toolCall, results) {
  return {
    toolResponse: {
      functionResponses: toolCall.functionCalls.map((fc, index) => ({
        name: fc.name,
        id: fc.id,
        response: { result: results[index] }
      }))
    }
  };
}
function wavHeader(dataLength, sampleRate = 24000, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bits / 8;
  const blockAlign = channels * bits / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

export function writePcmWav(filePath, chunks, sampleRate = 24000) {
  const pcm = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]));
  return pcm.length;
}

async function eventText(event) {
  if (typeof event.data === "string") return event.data;
  if (event.data && typeof event.data.text === "function") return await event.data.text();
  if (event.data instanceof ArrayBuffer) return Buffer.from(event.data).toString("utf8");
  return String(event.data ?? "");
}
export async function runLiveSession({
  text = "",
  pcmFile = "",
  audioOut = "",
  surface = "claw_live",
  timeoutMs = 60000,
  paceAudio = false,
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  apiKey
} = {}) {
  if (!WebSocketImpl) throw new Error("websocket_unavailable");
  if (!text && !pcmFile) throw new Error("live_input_required");
  const key = apiKey || await resolveGeminiApiKey();
  const ws = new WebSocketImpl(`${WS_BASE}?key=${encodeURIComponent(key)}`);
  let setupResolve, setupReject, turnResolve, turnReject;
  const setupReady = new Promise((resolve, reject) => { setupResolve = resolve; setupReject = reject; });
  const turnDone = new Promise((resolve, reject) => { turnResolve = resolve; turnReject = reject; });
  const audioChunks = [];
  const outputText = [];
  const inputText = [];
  const toolTrace = [];
  let toolCalls = 0;
  let closed = false;
  const started = Date.now();

  ws.addEventListener("open", () => ws.send(JSON.stringify(buildSetupMessage(surface))));
  ws.addEventListener("error", () => {
    setupReject?.(new Error("gemini_live_websocket_error"));
    turnReject?.(new Error("gemini_live_websocket_error"));
  });
  ws.addEventListener("close", () => {
    closed = true;
  });
  ws.addEventListener("message", async (event) => {
    try {
      const raw = await eventText(event);
      const message = JSON.parse(raw);
      if (message.setupComplete !== undefined) setupResolve?.(true);
      if (message.toolCall?.functionCalls) {
        toolCalls += message.toolCall.functionCalls.length;
        const results = [];
        for (const fc of message.toolCall.functionCalls) {
          if (fc.name !== TOOL_NAME) {
            results.push({ error: "unsupported_tool" });
            continue;
          }
          const request = String(fc.args?.request || "").trim();
          if (!request) {
            results.push({ error: "request_required" });
            continue;
          }
          try {
            const result = await executeCapability(request, { surface, fetchImpl });
            results.push(result);
            toolTrace.push({
              request,
              capability: result?.capability ?? null,
              selected_executor: result?.selected?.executor ?? null,
              route: result?.selected?.route ?? result?.execution?.route ?? null,
              execution_state: result?.execution?.state ?? null,
              result_ok: result?.execution?.result?.ok === true
            });
          } catch (error) {
            const message = String(error?.message || error).slice(0, 500);
            results.push({ error: message });
            toolTrace.push({ request, error: message });
          }
        }
        ws.send(JSON.stringify(buildToolResponse(message.toolCall, results)));
      }
      const sc = message.serverContent;
      if (sc?.inputTranscription?.text) inputText.push(sc.inputTranscription.text);
      if (sc?.outputTranscription?.text) outputText.push(sc.outputTranscription.text);
      for (const part of sc?.modelTurn?.parts || []) {
        if (part.inlineData?.data && String(part.inlineData.mimeType || "").startsWith("audio/")) {
          audioChunks.push(Buffer.from(part.inlineData.data, "base64"));
        }
      }
      if (sc?.turnComplete) turnResolve?.(true);
    } catch (error) {
      turnReject?.(error);
    }
  });

  await withTimeout(setupReady, Math.min(timeoutMs, 15000), "gemini_live_setup");
  if (text) {
    ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true
      }
    }));
  } else {
    const pcm = fs.readFileSync(pcmFile);
    const chunkBytes = 3200;
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
      ws.send(JSON.stringify({
        realtimeInput: {
          audio: { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" }
        }
      }));
      if (paceAudio) await sleep(100);
    }
    ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  await withTimeout(turnDone, timeoutMs, "gemini_live_turn");
  try { ws.close(); } catch {}
  if (!closed) await sleep(50);
  let audioBytes = 0;
  if (audioOut && audioChunks.length) audioBytes = writePcmWav(audioOut, audioChunks, 24000);
  return {
    status: "ok",
    model: MODEL,
    surface,
    tool_calls: toolCalls,
    tool_trace: toolTrace,
    input_transcript: inputText.join(" ").trim(),
    output_transcript: outputText.join(" ").trim(),
    audio_bytes: audioBytes,
    audio_out: audioBytes ? audioOut : null,
    duration_ms: Date.now() - started
  };
}
function parseArgs(argv) {
  const out = { text: "", pcmFile: "", audioOut: "", surface: "claw_live", timeoutMs: 60000, paceAudio: false, play: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--text") out.text = argv[++i] || "";
    else if (arg === "--pcm-file") out.pcmFile = argv[++i] || "";
    else if (arg === "--audio-out") out.audioOut = argv[++i] || "";
    else if (arg === "--surface") out.surface = argv[++i] || "claw_live";
    else if (arg === "--timeout") out.timeoutMs = Math.max(5000, Number(argv[++i] || 60) * 1000);
    else if (arg === "--pace-audio") out.paceAudio = true;
    else if (arg === "--play") out.play = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (!out.text) out.text = arg;
  }
  if (!out.audioOut) out.audioOut = path.join(os.homedir(), ".openclaw/tmp/claw-live-response.wav");
  return out;
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: gemini-live-client.mjs --text <request> [--play] [--timeout 60]");
    console.log("       gemini-live-client.mjs --pcm-file <16k-s16le.pcm> [--pace-audio] [--play]");
    return;
  }
  try {
    const result = await runLiveSession(args);
    console.log(JSON.stringify(result));
    if (args.play && result.audio_out) {
      const child = spawn("termux-media-player", ["play", result.audio_out], { stdio: "ignore", detached: true });
      child.unref();
    }
  } catch (error) {
    console.log(JSON.stringify({ status: "error", reason: String(error?.message || error).slice(0, 800) }));
    process.exitCode = 75;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await cli();
}

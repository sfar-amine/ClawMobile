import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { capabilityBridge } from "./capabilityBridge";
import {
  getRemoteBridgeRequest,
  submitRemoteBridgeRequest,
} from "./remoteBridge";

const execFileAsync = promisify(execFile);
// External MCP V1 stays read-only until live Claude acceptance.
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,24}$/;
const ACTION_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const STEP_ID_RE = /^[A-Za-z0-9._-]{1,24}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ARTIFACT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const WORKSPACE = path.join(os.homedir(), ".openclaw", "workspace");
const REQUEST_CONTEXT = path.join(
  WORKSPACE,
  "ui-playbooks",
  "tools",
  "request_context.py",
);

type McpRelayMessage = {
  requestId?: unknown;
  clientId?: unknown;
  profile?: unknown;
  tool?: unknown;
  arguments?: unknown;
};

function cleanObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeValue(value: any, depth = 0): any {
  if (depth > 20) return "[depth_limit]";
  if (Array.isArray(value)) return value.map((item) => safeValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(authorization|cookie|set-cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|credentials|private[_-]?key|stderr)$/i.test(key)) continue;
    out[key] = safeValue(item, depth + 1);
  }
  return out;
}

function projectReceipt(receipt: any) {
  const base = {
    request_id: receipt.requestId,
    task_id: receipt.taskId,
    step_id: receipt.stepId,
    retry_allowed: false,
  };
  if (receipt.state !== "completed") {
    return { ...base, state: receipt.state, error: receipt.error ? "claw_execution_failed" : undefined };
  }
  const value = receipt.result;
  if (value?.artifact) {
    return { ...base, state: "result_available", artifact: safeValue(value.artifact), preview: String(value.preview || "").slice(0, 8000) };
  }
  if (receipt.method === "mcp_capability_execute_readonly") {
    const execution = value?.execution || {};
    const domain = execution?.result;
    let state = "blocked";
    if (execution.state === "completed") state = domain?.ok === false || domain?.success === false ? "failed" : "completed";
    else if (execution.state === "failed") state = "failed";
    else if (execution.state === "running" || execution.state === "indeterminate") state = execution.state;
    else if (execution.state === "low_confidence" || domain?.state === "needs_counter" || domain?.state === "needs_clarification") state = "needs_clarification";
    return {
      ...base,
      state,
      capability: value?.capability,
      route: value?.selected?.route,
      reason: state === "blocked" ? (execution.reason || execution.state) : undefined,
      result: safeValue(domain),
      question: domain?.question,
      choices: safeValue(domain?.choices),
    };
  }
  return { ...base, state: "completed", result: safeValue(value) };
}

function requiredString(
  value: unknown,
  name: string,
  max: number,
  pattern?: RegExp,
) {
  const text = String(value || "").trim();
  if (!text || text.length > max || (pattern && !pattern.test(text))) {
    throw new Error(`invalid_${name}`);
  }
  return text;
}

function optionalString(
  value: unknown,
  name: string,
  max: number,
  pattern?: RegExp,
) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, name, max, pattern);
}

function actionTaskId(clientId: string, actionKey: string) {
  return `mcp:${clientId}:${actionKey}`;
}

function actionRequestId(clientId: string, actionKey: string, stepKey: string) {
  const value = `mcp-${clientId}-${actionKey}-${stepKey}`;
  if (!REQUEST_ID_RE.test(value)) throw new Error("invalid_action_identity");
  return value;
}

function withinWorkspace(filePath: string) {
  const resolved = path.resolve(filePath);
  return resolved === WORKSPACE || resolved.startsWith(WORKSPACE + path.sep);
}

function sanitizeRequestContext(raw: any) {
  const contracts = Array.isArray(raw?.contracts)
    ? raw.contracts.map((row: any) => {
        const { path: _path, ...rest } = row || {};
        return rest;
      })
    : [];
  const global = raw?.global && typeof raw.global === "object"
    ? (() => {
        const { path: _path, ...rest } = raw.global;
        return rest;
      })()
    : raw?.global;
  return { ...raw, contracts, global };
}

async function contextBundle(args: Record<string, unknown>) {
  const query = requiredString(args.query, "query", 2000);
  const argv = [REQUEST_CONTEXT, "--query", query];

  const after = args.after_revision;
  if (after !== undefined && after !== null) {
    const revision = Number(after);
    if (!Number.isInteger(revision) || revision < 0) {
      throw new Error("invalid_after_revision");
    }
    argv.push("--after", String(revision));
  }

  const known = cleanObject(args.known_contracts);
  if (Object.keys(known).length) {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(known)) {
      const hash = String(value || "").trim();
      if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("invalid_known_contract");
      normalized[key] = hash.toLowerCase();
    }
    argv.push("--known-contracts", JSON.stringify(normalized));
  }

  const baseline = cleanObject(args.global_baseline);
  if (Object.keys(baseline).length) {
    argv.push("--global-baseline", JSON.stringify(baseline));
  }
  if (args.uncertain === true) argv.push("--uncertain");

  const run: any = await execFileAsync("python3", argv, {
    cwd: path.dirname(REQUEST_CONTEXT),
    timeout: 12_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env },
  });
  const stdout = typeof run === "string" ? run : String(run?.stdout ?? "");
  const raw = JSON.parse(stdout || "{}");
  const required = new Set<string>(
    Array.isArray(raw?.readiness?.required_reads)
      ? raw.readiness.required_reads.map((item: unknown) => String(item))
      : [],
  );
  const reads: Array<{ key: string; sha256?: string; content: string }> = [];

  for (const row of Array.isArray(raw?.contracts) ? raw.contracts : []) {
    const key = String(row?.key || "");
    const filePath = String(row?.path || "");
    if (!required.has(key) || !filePath || !withinWorkspace(filePath)) continue;
    reads.push({
      key,
      sha256: row?.sha256 ? String(row.sha256) : undefined,
      content: fs.readFileSync(filePath, "utf8"),
    });
  }

  if (raw?.global?.read_required === true) {
    const filePath = String(raw?.global?.path || "");
    if (!filePath || !withinWorkspace(filePath)) throw new Error("invalid_global_context_path");
    if (!reads.some((row) => row.key === "context/HYBRID_CONTEXT.md")) {
      reads.push({
        key: "context/HYBRID_CONTEXT.md",
        sha256: raw?.global?.sha256 ? String(raw.global.sha256) : undefined,
        content: fs.readFileSync(filePath, "utf8"),
      });
    }
  }

  return {
    state: "context",
    bundle: sanitizeRequestContext(raw),
    required_reads: reads,
    attestation: reads.length
      ? "Read and integrate every required_reads item before reusing its hash/baseline."
      : "No additional contract read is required for this delta.",
  };
}

async function resolveCapability(args: Record<string, unknown>) {
  const request = requiredString(args.request, "request", 12000);
  const targetHint = optionalString(args.target_hint, "target_hint", 128, /^[A-Za-z0-9._-]+$/);
  return capabilityBridge(request, {
    execute: false,
    surface: "external_mcp",
    caller: "owner",
    timeoutSeconds: 20,
    targetHint,
  });
}

async function executeReadonly(
  requestId: string,
  clientId: string,
  args: Record<string, unknown>,
) {
  const request = requiredString(args.request, "request", 12000);
  const actionKey = requiredString(args.action_key, "action_key", 40, ACTION_ID_RE);
  const stepKey = optionalString(args.step_key, "step_key", 24, STEP_ID_RE) || "execute";
  const targetHint = optionalString(args.target_hint, "target_hint", 128, /^[A-Za-z0-9._-]+$/);
  const expectedRequestId = actionRequestId(clientId, actionKey, stepKey);
  if (requestId !== expectedRequestId) throw new Error("action_request_id_mismatch");

  const receipt = await submitRemoteBridgeRequest({
    requestId,
    taskId: actionTaskId(clientId, actionKey),
    stepId: stepKey,
    sessionId: `external_mcp:${clientId}`,
    method: "mcp_capability_execute_readonly",
    params: {
      request,
      targetHint: targetHint || "",
    },
  });

  return projectReceipt(receipt);
}

function statusFor(
  clientId: string,
  args: Record<string, unknown>,
) {
  const actionKey = requiredString(args.action_key, "action_key", 40, ACTION_ID_RE);
  const stepKey = optionalString(args.step_key, "step_key", 24, STEP_ID_RE) || "execute";
  const requestId = actionRequestId(clientId, actionKey, stepKey);
  const receipt = getRemoteBridgeRequest(requestId);
  if (!receipt) {
    return {
      state: "not_found",
      request_id: requestId,
      retry_allowed: false,
    };
  }
  return projectReceipt(receipt);
}

async function readArtifact(
  requestId: string,
  clientId: string,
  args: Record<string, unknown>,
) {
  const artifactId = requiredString(args.artifact_id, "artifact_id", 128, ARTIFACT_ID_RE);
  const sourceRequestId = requiredString(args.source_request_id, "source_request_id", 128, REQUEST_ID_RE);
  const source = getRemoteBridgeRequest(sourceRequestId);
  if (!source || source.sessionId !== `external_mcp:${clientId}`) throw new Error("artifact_source_not_allowed");
  if ((source.result as any)?.artifact?.artifactId !== artifactId) throw new Error("artifact_not_allowed");
  const offset = args.offset === undefined ? 0 : Number(args.offset);
  const maxBytes = args.max_bytes === undefined ? 48 * 1024 : Number(args.max_bytes);
  if (!Number.isInteger(offset) || offset < 0) throw new Error("invalid_offset");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 48 * 1024) {
    throw new Error("invalid_max_bytes");
  }
  const stableId = `mcp-artifact:${crypto
    .createHash("sha256")
    .update(JSON.stringify([clientId, sourceRequestId, artifactId, offset, maxBytes]))
    .digest("hex")
    .slice(0, 32)}`;

  const receipt = await submitRemoteBridgeRequest({
    requestId: stableId,
    sessionId: `external_mcp:${clientId}`,
    method: "artifact_read",
    params: { artifactId, offset, maxBytes },
  });
  if (receipt.state !== "completed") {
    return { state: receipt.state, error: receipt.error ? "artifact_read_failed" : undefined, request_id: receipt.requestId };
  }
  return { state: "completed", request_id: receipt.requestId, result: safeValue(receipt.result) };
}

export async function handleMcpRelayRequest(message: McpRelayMessage) {
  const requestId = requiredString(message.requestId, "request_id", 128, REQUEST_ID_RE);
  const clientId = requiredString(message.clientId, "client_id", 24, CLIENT_ID_RE);
  const profile = requiredString(message.profile, "profile", 64);
  const tool = requiredString(message.tool, "tool", 64, /^[a-z][a-z0-9_]{1,63}$/);
  const args = cleanObject(message.arguments);

  if (profile !== "chat-owner-shadow") {
    return { state: "failed", error: "unsupported_profile" };
  }

  switch (tool) {
    case "claw_context":
      return contextBundle(args);
    case "claw_resolve":
      return { state: "resolved", result: await resolveCapability(args) };
    case "claw_execute":
      return executeReadonly(requestId, clientId, args);
    case "claw_status":
      return statusFor(clientId, args);
    case "claw_artifact_read":
      return readArtifact(requestId, clientId, args);
    default:
      return { state: "failed", error: "unsupported_mcp_tool" };
  }
}

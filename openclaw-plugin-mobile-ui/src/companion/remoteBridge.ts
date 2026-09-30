import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR || path.join(os.homedir(), ".openclaw", "remote-bridge");
const REQUEST_DIR = path.join(ROOT, "requests");
const ARTIFACT_DIR = path.join(ROOT, "artifacts");
const INSTANCE_ID = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

export function remoteBridgeHealth() {
  for (const dir of [ROOT, REQUEST_DIR, ARTIFACT_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return {
    ok: true,
    state: "ready",
    instanceId: INSTANCE_ID,
    protocol: "claw-rpc-v1",
  };
}
type BridgeState = "received" | "running" | "completed" | "failed" | "indeterminate";

export type RemoteBridgeRequest = {
  requestId: string;
  taskId?: string;
  stepId?: string;
  sessionId?: string;
  method: string;
  params?: Record<string, unknown>;
};

export type RemoteBridgeReceipt = {
  requestId: string;
  taskId?: string;
  stepId?: string;
  sessionId?: string;
  method: string;
  paramsHash: string;
  state: BridgeState;
  instanceId: string;
  receivedAt: number;
  startedAt?: number;
  completedAt?: number;
  mutationRisk: "read" | "write" | "unknown";
  result?: unknown;
  error?: string;
};function ensureDirs() {
  for (const dir of [ROOT, REQUEST_DIR, ARTIFACT_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function validateRequestId(value: string) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error("invalid_request_id");
  }
}

function validateCorrelationId(value: string, kind: "task" | "step") {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`invalid_${kind}_id`);
  }
}

function requestPath(requestId: string) {
  return path.join(REQUEST_DIR, `${requestId}.json`);
}

function sha256(value: Buffer | string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashParams(method: string, params: Record<string, unknown>) {
  return sha256(JSON.stringify({ method, params }));
}function atomicWrite(filePath: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existingMode = fs.existsSync(filePath) ? (fs.statSync(filePath).mode & 0o777) : 0o600;
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tempPath, content, { mode: existingMode });
  fs.chmodSync(tempPath, existingMode);
  fs.renameSync(tempPath, filePath);
}

function readReceipt(requestId: string): RemoteBridgeReceipt | null {
  const filePath = requestPath(requestId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as RemoteBridgeReceipt;
}

function writeReceipt(receipt: RemoteBridgeReceipt) {
  atomicWrite(requestPath(receipt.requestId), JSON.stringify(receipt, null, 2));
}

function normalizeStaleReceipt(receipt: RemoteBridgeReceipt) {
  if (receipt.state !== "running" || receipt.instanceId === INSTANCE_ID) return receipt;
  const next: RemoteBridgeReceipt = {
    ...receipt,
    state: "indeterminate",
    completedAt: Date.now(),
    error: "Bridge restarted while request was running. Verify effect before retry.",
  };
  writeReceipt(next);
  return next;
}

function receiptFiles() {
  ensureDirs();
  return fs.readdirSync(REQUEST_DIR)
    .filter((name) => /^[A-Za-z0-9._:-]{1,128}\.json$/.test(name))
    .map((name) => path.join(REQUEST_DIR, name));
}

function findTaskStepReceipt(taskId: string, stepId: string) {
  for (const filePath of receiptFiles()) {
    try {
      const receipt = JSON.parse(fs.readFileSync(filePath, "utf8")) as RemoteBridgeReceipt;
      if (receipt.taskId === taskId && receipt.stepId === stepId) return receipt;
    } catch {}
  }
  return null;
}

function summarizeReceipt(receipt: RemoteBridgeReceipt) {
  const normalized = normalizeStaleReceipt(receipt);
  const result = normalized.result && typeof normalized.result === "object"
    ? normalized.result as Record<string, unknown>
    : {};
  return {
    requestId: normalized.requestId,
    taskId: normalized.taskId,
    stepId: normalized.stepId,
    method: normalized.method,
    paramsHash: normalized.paramsHash,
    state: normalized.state,
    mutationRisk: normalized.mutationRisk,
    receivedAt: normalized.receivedAt,
    startedAt: normalized.startedAt,
    completedAt: normalized.completedAt,
    processId: typeof result.processId === "string" ? result.processId : undefined,
    error: normalized.error,
  };
}

export function getRemoteBridgeTask(taskId: string, rawLimit = 50) {
  ensureDirs();
  validateCorrelationId(taskId, "task");
  const limit = Math.max(1, Math.min(100, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50));
  const receipts: RemoteBridgeReceipt[] = [];
  for (const filePath of receiptFiles()) {
    try {
      const receipt = JSON.parse(fs.readFileSync(filePath, "utf8")) as RemoteBridgeReceipt;
      if (receipt.taskId === taskId) receipts.push(receipt);
    } catch {}
  }
  receipts.sort((a, b) => a.receivedAt - b.receivedAt);
  const selected = receipts.slice(Math.max(0, receipts.length - limit));
  return {
    taskId,
    total: receipts.length,
    receipts: selected.map(summarizeReceipt),
  };
}

function mutationRisk(method: string): "read" | "write" | "unknown" {
  if (["ping", "request_status", "task_status", "read_file", "read_binary_file", "artifact_read", "process_status"].includes(method)) return "read";
  if (["write_file", "patch_file", "write_binary_file", "process_input", "process_stop"].includes(method)) return "write";
  return "unknown";
}const INLINE_LIMIT = 48 * 1024;
const MAX_FILE_READ_LINES = 5000;
const MAX_FILE_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_BINARY_CHUNK_BYTES = 16 * 1024;

function allowedRoots() {
  const configured = String(process.env.CLAWMOBILE_REMOTE_BRIDGE_ALLOWED_DIRS || "")
    .split(":")
    .map((value) => value.trim())
    .filter(Boolean);
  const defaults = [
    os.homedir(),
    process.env.PREFIX || "",
    "/sdcard",
    "/storage/emulated/0",
    "/data/local/tmp",
  ].filter(Boolean);
  return [...new Set(configured.length ? configured : defaults)]
    .filter((root) => fs.existsSync(root))
    .map((root) => path.resolve(root));
}

function resolveAllowedPath(value: string, allowMissing = false) {
  if (!value) throw new Error("path_required");
  const resolved = path.resolve(value.replace(/^~(?=\/|$)/, os.homedir()));  const allowed = allowedRoots().some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  if (!allowed) throw new Error("path_not_allowed");
  if (!allowMissing && !fs.existsSync(resolved)) throw new Error("path_not_found");
  return resolved;
}

function readTextFile(params: Record<string, unknown>) {
  const filePath = resolveAllowedPath(String(params.path || ""));
  const raw = fs.readFileSync(filePath);
  const text = raw.toString("utf8");
  const lines = text.split(/\r?\n/);
  const rawOffset = Number(params.offset ?? 0);
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
  const rawLength = Number(params.length ?? 1000);
  const length = Number.isFinite(rawLength)
    ? Math.max(1, Math.min(MAX_FILE_READ_LINES, rawLength))
    : 1000;
  const start = offset < 0
    ? Math.max(0, lines.length + offset)
    : Math.min(lines.length, offset);
  const end = Math.min(lines.length, start + length);
  return {
    path: filePath,
    start,
    end,
    totalLines: lines.length,    text: lines.slice(start, end).join("\n"),
    sha256: sha256(raw),
  };
}

function writeTextFile(params: Record<string, unknown>) {
  const filePath = resolveAllowedPath(String(params.path || ""), true);
  const content = String(params.content ?? "");
  if (Buffer.byteLength(content) > MAX_FILE_WRITE_BYTES) {
    throw new Error("write_too_large");
  }
  const mode = params.mode === "append" ? "append" : "rewrite";
  const expected = params.previousSha256
    ? String(params.previousSha256)
    : "";
  if (expected && fs.existsSync(filePath)) {
    const actual = sha256(fs.readFileSync(filePath));
    if (actual !== expected) throw statusError(409, "compare_and_set_failed");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (mode === "append") {
    fs.appendFileSync(filePath, content, "utf8");
  } else {
    atomicWrite(filePath, content);
  }
  const bytes = fs.readFileSync(filePath);
  return { path: filePath, mode, bytes: bytes.length, sha256: sha256(bytes) };
}

function decodePatchValue(params: Record<string, unknown>, textKey: string, base64Key: string) {
  if (params[base64Key] !== undefined) {
    return Buffer.from(String(params[base64Key] || ""), "base64").toString("utf8");
  }
  return String(params[textKey] ?? "");
}

function patchTextFile(params: Record<string, unknown>) {
  const filePath = resolveAllowedPath(String(params.path || ""));
  const raw = fs.readFileSync(filePath);
  const previousSha256 = String(params.previousSha256 || "");
  if (previousSha256 && sha256(raw) !== previousSha256) {
    throw statusError(409, "compare_and_set_failed");
  }
  const before = raw.toString("utf8");
  const oldString = decodePatchValue(params, "oldString", "oldBase64");
  const newString = decodePatchValue(params, "newString", "newBase64");
  if (!oldString) throw new Error("old_string_required");
  const rawExpected = Number(params.expectedReplacements ?? 1);
  const expectedReplacements = Number.isFinite(rawExpected) ? Math.max(1, Math.min(1000, Math.trunc(rawExpected))) : 1;
  const actualReplacements = before.split(oldString).length - 1;
  if (actualReplacements !== expectedReplacements) throw statusError(409, `replacement_count_mismatch:${actualReplacements}`);
  const after = before.split(oldString).join(newString);
  if (Buffer.byteLength(after) > MAX_FILE_WRITE_BYTES) throw new Error("write_too_large");
  atomicWrite(filePath, after);
  const bytes = fs.readFileSync(filePath);
  return { path: filePath, replacements: actualReplacements, bytes: bytes.length, sha256: sha256(bytes) };
}

function readBinaryFile(params: Record<string, unknown>) {
  const filePath = resolveAllowedPath(String(params.path || ""));
  const data = fs.readFileSync(filePath);
  const rawOffset = Number(params.offset ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  const rawMax = Number(params.maxBytes ?? 12 * 1024);
  const maxBytes = Number.isFinite(rawMax) ? Math.max(1, Math.min(MAX_BINARY_CHUNK_BYTES, Math.trunc(rawMax))) : 12 * 1024;
  const chunk = data.subarray(offset, Math.min(data.length, offset + maxBytes));
  return { path: filePath, offset, nextOffset: offset + chunk.length, totalBytes: data.length, encoding: "base64", dataBase64: chunk.toString("base64"), sha256: sha256(data) };
}

function writeBinaryFile(params: Record<string, unknown>) {
  const filePath = resolveAllowedPath(String(params.path || ""), true);
  const encoded = String(params.dataBase64 || "").replace(/\s+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error("invalid_base64");
  const chunk = Buffer.from(encoded, "base64");
  const previousSha256 = String(params.previousSha256 || "");
  if (previousSha256 && fs.existsSync(filePath) && sha256(fs.readFileSync(filePath)) !== previousSha256) throw statusError(409, "compare_and_set_failed");
  const mode = params.mode === "append" ? "append" : "rewrite";
  const currentBytes = mode === "append" && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (currentBytes + chunk.length > MAX_FILE_WRITE_BYTES) throw new Error("write_too_large");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (mode === "append") fs.appendFileSync(filePath, chunk); else atomicWrite(filePath, chunk);
  const bytes = fs.readFileSync(filePath);
  return { path: filePath, mode, bytes: bytes.length, sha256: sha256(bytes) };
}
import {
  bridgeProcessInput,
  bridgeProcessStatus,
  bridgeProcessStop,
  runExecWait,
  startBridgeProcess,
} from "./remoteBridgeExec";

function compactResult(requestId: string, result: unknown) {
  const encoded = Buffer.from(JSON.stringify(result), "utf8");
  if (encoded.length <= INLINE_LIMIT) return result;
  const artifactId = `${requestId}-${Date.now()}.json`;
  fs.writeFileSync(path.join(ARTIFACT_DIR, artifactId), encoded, { mode: 0o600 });
  return {
    artifact: {
      artifactId,
      bytes: encoded.length,
      contentType: "application/json",
    },
    preview: encoded.subarray(0, 8 * 1024).toString("utf8"),
  };
}

function readArtifact(params: Record<string, unknown>) {
  const artifactId = String(params.artifactId || "");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(artifactId)) {
    throw new Error("invalid_artifact_id");
  }
  const artifactPath = path.join(ARTIFACT_DIR, artifactId);  if (!fs.existsSync(artifactPath)) throw new Error("artifact_not_found");
  const data = fs.readFileSync(artifactPath);
  const offset = Math.max(0, Number(params.offset || 0));
  const rawMax = Number(params.maxBytes ?? 48 * 1024);
  const maxBytes = Number.isFinite(rawMax)
    ? Math.max(1, Math.min(128 * 1024, rawMax))
    : 48 * 1024;
  const chunk = data.subarray(offset, Math.min(data.length, offset + maxBytes));
  return {
    artifactId,
    offset,
    nextOffset: offset + chunk.length,
    totalBytes: data.length,
    text: chunk.toString("utf8"),
  };
}

async function dispatch(request: RemoteBridgeRequest) {
  const params = (request.params || {}) as Record<string, unknown>;
  switch (request.method) {
    case "ping":
      return { pong: true, at: Date.now(), instanceId: INSTANCE_ID };
    case "request_status":
      return { receipt: getRemoteBridgeRequest(String(params.requestId || "")) };
    case "task_status":
      return getRemoteBridgeTask(String(params.taskId || ""), Number(params.limit || 50));
    case "exec_wait":
      return runExecWait(params);    case "read_file":
      return readTextFile(params);
    case "read_binary_file":
      return readBinaryFile(params);
    case "write_file":
      return writeTextFile(params);
    case "patch_file":
      return patchTextFile(params);
    case "write_binary_file":
      return writeBinaryFile(params);
    case "artifact_read":
      return readArtifact(params);
    case "process_start":
      return startBridgeProcess(params);
    case "process_status":
      return bridgeProcessStatus(params);
    case "process_input":
      return bridgeProcessInput(params);
    case "process_stop":
      return bridgeProcessStop(params);
    default:
      throw new Error(`unsupported_method:${request.method}`);
  }
}

function normalizeRequest(body: RemoteBridgeRequest): RemoteBridgeRequest {
  const requestId = String(body?.requestId || "").trim();
  const method = String(body?.method || "").trim();
  validateRequestId(requestId);
  if (!method || !/^[a-z][a-z0-9_]{1,63}$/.test(method)) {
    throw new Error("invalid_method");
  }
  const taskId = body?.taskId ? String(body.taskId).trim() : undefined;
  const stepId = body?.stepId ? String(body.stepId).trim() : undefined;
  if (taskId) validateCorrelationId(taskId, "task");
  if (stepId) {
    if (!taskId) throw new Error("step_id_requires_task_id");
    validateCorrelationId(stepId, "step");
  }
  return {
    requestId,
    taskId,
    stepId,
    sessionId: body?.sessionId ? String(body.sessionId) : undefined,
    method,
    params: body?.params && typeof body.params === "object"
      ? body.params
      : {},
  };
}export async function submitRemoteBridgeRequest(
  body: RemoteBridgeRequest,
): Promise<RemoteBridgeReceipt> {
  ensureDirs();
  const request = normalizeRequest(body);
  const params = (request.params || {}) as Record<string, unknown>;
  const paramsHash = hashParams(request.method, params);
  const existing = readReceipt(request.requestId);

  if (existing) {
    if (existing.paramsHash !== paramsHash || existing.method !== request.method) {
      throw statusError(409, "request_id_conflict");
    }
    if (existing.taskId && request.taskId && existing.taskId !== request.taskId) {
      throw statusError(409, "request_task_conflict");
    }
    if (existing.stepId && request.stepId && existing.stepId !== request.stepId) {
      throw statusError(409, "request_step_conflict");
    }
    return normalizeStaleReceipt(existing);
  }

  if (request.taskId && request.stepId) {
    const prior = findTaskStepReceipt(request.taskId, request.stepId);
    if (prior) {
      if (prior.paramsHash !== paramsHash || prior.method !== request.method) {
        throw statusError(409, "task_step_conflict");
      }
      return normalizeStaleReceipt(prior);
    }
  }

  let receipt: RemoteBridgeReceipt = {
    requestId: request.requestId,
    taskId: request.taskId,
    stepId: request.stepId,
    sessionId: request.sessionId,
    method: request.method,
    paramsHash,    state: "received",
    instanceId: INSTANCE_ID,
    receivedAt: Date.now(),
    mutationRisk: mutationRisk(request.method),
  };
  writeReceipt(receipt);
  receipt = {
    ...receipt,
    state: "running",
    startedAt: Date.now(),
  };
  writeReceipt(receipt);

  try {
    const result = compactResult(request.requestId, await dispatch(request));
    receipt = {
      ...receipt,
      state: "completed",
      completedAt: Date.now(),
      result,
    };
  } catch (error: any) {
    receipt = {
      ...receipt,
      state: "failed",
      completedAt: Date.now(),
      error: error?.message || String(error),
    };
  }
  writeReceipt(receipt);
  return receipt;
}export function getRemoteBridgeRequest(
  requestId: string,
): RemoteBridgeReceipt | null {
  ensureDirs();
  validateRequestId(requestId);
  const receipt = readReceipt(requestId);
  if (!receipt) return null;
  return normalizeStaleReceipt(receipt);
}

function statusError(statusCode: number, message: string) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  return error;
}

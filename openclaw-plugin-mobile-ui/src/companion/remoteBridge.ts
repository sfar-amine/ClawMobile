import {readRunWebResult} from "./runWeb";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { capabilityBridge } from "./capabilityBridge";
import { delegateMcpOwnerRequest } from "./mcpOwnerDelegate";
import { memoryRemember } from "./memoryControl";

const ROOT = process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR || path.join(os.homedir(), ".openclaw", "remote-bridge");
const REQUEST_DIR = path.join(ROOT, "requests");
const ARTIFACT_DIR = path.join(ROOT, "artifacts");
const CONTINUUM_DIR = process.env.CLAW_CONTINUUM_FOREGROUND_DIR ||
  path.join(os.homedir(), ".openclaw", "continuations", "foreground");
const MAX_CONTINUUM_JOURNAL_BYTES = 4 * 1024 * 1024;
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
    abandonSweep: remoteBridgeAbandonSweep(),
  };
}
export function remoteBridgeReceiptDirectory() { return REQUEST_DIR; }

/** Existing receipt owner only. Proofs of mutations/unknown effects never expire.
 * Not wired until Claude qualifies the directory and replay guarantee on S24.
 * Caller invokes during an existing maintenance cycle, outside request latency.
 */
export async function pruneRemoteBridgeReadReceipts(keep = 50000) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100000) throw new Error("invalid_receipt_retention");
  const candidates: { file: string; at: number; hash: string }[] = [];
  let preserved = 0, removed = 0;
  let entries: fs.Dirent[];
  try {
    if (!(await fs.promises.lstat(ROOT)).isDirectory() || !(await fs.promises.lstat(REQUEST_DIR)).isDirectory() ||
        await fs.promises.realpath(REQUEST_DIR) !== path.resolve(REQUEST_DIR)) {
      return { removed: 0, preserved: 0, state: "source_unavailable" };
    }
    entries = await fs.promises.readdir(REQUEST_DIR, { withFileTypes: true });
  }
  catch (error: any) { if (error?.code === "ENOENT") return { removed: 0, preserved: 0, state: "not_present" }; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Za-z0-9._:-]{1,128}\.json$/.test(entry.name)) { preserved++; continue; }
    const file = path.join(REQUEST_DIR, entry.name);
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) { preserved++; continue; }
      const raw = await fs.promises.readFile(file, "utf8"), row = JSON.parse(raw);
      if (row.requestId + ".json" !== entry.name || row.mutationRisk !== "read" ||
          !["completed", "failed"].includes(row.state) || row.continuumFence ||
          !Number.isSafeInteger(row.completedAt) || row.completedAt <= 0 ||
          typeof row.method !== "string" || mutationRisk(row.method) !== "read") { preserved++; continue; }
      candidates.push({ file, at: row.completedAt, hash: sha256(raw) });
    } catch { preserved++; }
  }
  candidates.sort((a, b) => b.at - a.at || a.file.localeCompare(b.file));
  for (const candidate of candidates.slice(keep)) {
    try {
      // Preserve a changed receipt, including an operation now active/uncertain.
      const stat = await fs.promises.lstat(candidate.file);
      if (!stat.isFile() || stat.nlink !== 1 || sha256(await fs.promises.readFile(candidate.file)) !== candidate.hash) { preserved++; continue; }
      await fs.promises.unlink(candidate.file); removed++;
    } catch { preserved++; }
  }
  return { removed, preserved, retainedRead: Math.min(keep, candidates.length), state: "applied" };
}

export type ClawAccess = {client_id:string;profile:"chat-owner"|"chat-owner-shadow";owner:boolean;read_only:boolean};
type BridgeState = "received" | "running" | "completed" | "failed" | "indeterminate" | "abandoned";

export type ContinuumFence = {
  version: 1;
  attemptId: string;
  effectKey: string;
  ownershipEpoch: number;
  ownerId: string;
  bootId: string;
};

export type RemoteBridgeRequest = {
  requestId: string;
  taskId?: string;
  stepId?: string;
  sessionId?: string;
  method: string;
  params?: Record<string, unknown>;
  continuumFence?: ContinuumFence;
  _claw_access?: ClawAccess;
};

export type RemoteBridgeReceipt = {
  requestId: string;
  taskId?: string;
  stepId?: string;
  sessionId?: string;
  method: string;
  paramsHash: string;
  _claw_access?: ClawAccess;
  state: BridgeState;
  instanceId: string;
  receivedAt: number;
  startedAt?: number;
  completedAt?: number;
  mutationRisk: "read" | "write" | "unknown";
  continuumFence?: { version: 1; attemptId: string; effectKey: string; ownershipEpoch: number };
  result?: unknown;
  error?: string;
  abandonment?: RemoteBridgeAbandonment;
};

// F6 (fichiers 35/41) : terminal state of a receipt whose owner instance is gone.
// "not_applied_verified" only when dispatch never started (state "received": the
// receipt is moved to "running" before dispatch). Otherwise the past effect stays
// unknown and mutationRisk is preserved; abandoned never authorizes a replay.
export type RemoteBridgeAbandonment = {
  version: 1;
  at: number;
  previousState: "received" | "running" | "indeterminate";
  reason: "owner_instance_gone";
  application: "not_applied_verified" | "effect_uncertain";
  ownerInstanceAlive: false;
  liveCommandEvidence: false;
  ageMs: number;
  afterMs: number;
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
}

function continuumJournalPath(taskId: string) {
  return path.join(CONTINUUM_DIR, `${taskId}.events.jsonl`);
}

function continuumProjectionPath(taskId: string) {
  return path.join(CONTINUUM_DIR, `${taskId}.json`);
}

function readContinuumState(taskId: string): any | null {
  const projectionPath = continuumProjectionPath(taskId);
  const journalPath = continuumJournalPath(taskId);
  const projectionExists = fs.existsSync(projectionPath);
  const journalExists = fs.existsSync(journalPath);
  if (!projectionExists && !journalExists) return null;
  if (projectionExists) {
    try {
      const projection = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
      if (!projection?.continuum && !journalExists) return null;
      if (projection?.run_id && projection.run_id !== taskId) {
        throw statusError(409, "continuum_task_mismatch");
      }
    } catch (error: any) {
      if (!journalExists) throw statusError(409, "continuum_projection_invalid");
    }
  }
  if (!journalExists) throw statusError(409, "continuum_journal_missing");
  const stat = fs.statSync(journalPath);
  if (stat.size <= 0 || stat.size > MAX_CONTINUUM_JOURNAL_BYTES) {
    throw statusError(409, "continuum_journal_invalid");
  }
  const raw = fs.readFileSync(journalPath, "utf8").trimEnd();
  const line = raw.split(/\r?\n/).at(-1) || "";
  let event: any;
  try { event = JSON.parse(line); }
  catch { throw statusError(409, "continuum_journal_invalid"); }
  const state = event?.after;
  const seqMismatch = event?.seq !== undefined && event.seq !== state?.continuum?.event_seq;
  const revisionMismatch = event?.revision !== undefined && event.revision !== state?.continuum?.revision;
  if (event?.taskId !== taskId || state?.run_id !== taskId || !state?.continuum || seqMismatch || revisionMismatch) {
    throw statusError(409, "continuum_journal_invalid");
  }
  return state;
}

/** Use the Bridge's canonical validated journal reader; absence alone preserves standalone exec. */
export function hasContinuumTask(taskId: string): boolean {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(taskId)) throw statusError(409, "invalid_continuum_task_id");
  return readContinuumState(taskId) !== null;
}

function normalizeContinuumFence(value: any): ContinuumFence {
  if (!value || typeof value !== "object" || value.version !== 1) {
    throw statusError(409, "continuum_fence_required");
  }
  const attemptId = String(value.attemptId || "");
  const effectKey = String(value.effectKey || "");
  const ownerId = String(value.ownerId || "");
  const bootId = String(value.bootId || "");
  for (const [kind, ident] of [["attempt", attemptId], ["effect", effectKey], ["owner", ownerId], ["boot", bootId]]) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ident)) throw statusError(409, `invalid_continuum_${kind}`);
  }
  const ownershipEpoch = Number(value.ownershipEpoch);
  if (!Number.isSafeInteger(ownershipEpoch) || ownershipEpoch < 1) {
    throw statusError(409, "invalid_continuum_epoch");
  }
  return { version: 1, attemptId, effectKey, ownershipEpoch, ownerId, bootId };
}

/** Same classification as the receipt: an owner capability whose decision says `read` needs no effect fence. */
export function continuumFenceRequired(method: string, params?: Record<string, unknown>): boolean {
  return mutationRisk(method, params) !== "read";
}

function validateContinuumFence(
  request: RemoteBridgeRequest,
  paramsHash: string,
): RemoteBridgeReceipt["continuumFence"] | undefined {
  if (!continuumFenceRequired(request.method, request.params)) return undefined;
  if (!request.taskId) {
    if (request.continuumFence) throw statusError(409, "continuum_task_required");
    return undefined;
  }
  const state = readContinuumState(request.taskId);
  if (!state) {
    if (request.continuumFence) throw statusError(409, "continuum_task_not_found");
    return undefined;
  }
  const fence = normalizeContinuumFence(request.continuumFence);
  const continuum = state.continuum || {};
  const owner = state.owner || {};
  const attempts = continuum.attempts || {};
  const row = attempts[fence.attemptId];
  const binding = row?.transport_binding;
  const now = Date.now() / 1000;
  if (state.state !== "running" || continuum.control !== "active") {
    throw statusError(409, "continuum_not_runnable");
  }
  if (continuum.ownership_epoch !== fence.ownershipEpoch || owner.id !== fence.ownerId ||
      owner.boot_id !== fence.bootId || Number(owner.lease_until || 0) <= now) {
    throw statusError(409, "continuum_owner_stale");
  }
  if (continuum.current_attempt !== fence.attemptId || !row || row.state !== "submitted") {
    throw statusError(409, "continuum_attempt_not_armed");
  }
  if (row.effect_key !== fence.effectKey) throw statusError(409, "continuum_effect_mismatch");
  const persistedFence = row.dispatch_fence;
  if (!persistedFence || persistedFence.version !== 1 ||
      persistedFence.attemptId !== fence.attemptId || persistedFence.effectKey !== fence.effectKey ||
      persistedFence.ownershipEpoch !== fence.ownershipEpoch || persistedFence.ownerId !== fence.ownerId ||
      persistedFence.bootId !== fence.bootId) {
    throw statusError(409, "continuum_fence_mismatch");
  }
  if (!binding || binding.version !== 1 || binding.requestId !== request.requestId ||
      binding.taskId !== request.taskId || binding.stepId !== request.stepId ||
      binding.method !== request.method || binding.paramsHash !== paramsHash) {
    throw statusError(409, "continuum_transport_binding_mismatch");
  }
  return { version: 1, attemptId: fence.attemptId, effectKey: fence.effectKey,
           ownershipEpoch: fence.ownershipEpoch };
}
function atomicWrite(filePath: string, content: string | Buffer) {
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

// Bounded delay before a receipt of a dead instance becomes terminal. Above the
// longest dispatch the bridge allows (exec_wait 300 s, capability 30 s).
export const REMOTE_BRIDGE_ABANDON_AFTER_MS = Number(process.env.CLAWMOBILE_REMOTE_BRIDGE_ABANDON_AFTER_MS || 0) > 0
  ? Number(process.env.CLAWMOBILE_REMOTE_BRIDGE_ABANDON_AFTER_MS)
  : 60 * 60 * 1000;
const LIVE_SCRIPT_WINDOW_MS = 10_000;
const MAX_PROC_ENTRIES = 4096;
let liveScriptCache: { until: number; starts: number[] | null } | null = null;

function instancePid(instanceId: string) {
  const match = /^(\d{1,10})-\d{10,16}-[0-9a-f]{8}$/.exec(String(instanceId || ""));
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

// Unknown liveness (unparseable instance, EPERM, unexpected error) counts as alive.
export function remoteBridgeInstanceAlive(instanceId: string) {
  if (instanceId === INSTANCE_ID) return true;
  const pid = instancePid(instanceId);
  if (pid === null) return true;
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code !== "ESRCH"; }
}

// Start times (ms) of exec_wait/process scripts still in a live command line.
// null = /proc unreadable: liveness of the command cannot be excluded.
function liveBridgeScriptStarts(): number[] | null {
  const now = Date.now();
  if (liveScriptCache && liveScriptCache.until > now) return liveScriptCache.starts;
  let starts: number[] | null = [];
  try {
    const pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
    // A truncated inventory cannot prove that a command is no longer alive.
    // Keep the existing bound; unknown liveness must preserve the receipt.
    if (pids.length > MAX_PROC_ENTRIES) {
      liveScriptCache = { until: now + 5_000, starts: null };
      return null;
    }
    for (const pid of pids) {
      let cmdline = "";
      try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
      for (const match of cmdline.matchAll(/remote-bridge\/processes\/cmd-(\d{10,16})-[0-9a-f]+\.sh/g)) {
        starts.push(Number(match[1]));
      }
    }
  } catch { starts = null; }
  liveScriptCache = { until: now + 5_000, starts };
  return starts;
}

function abandonmentFor(receipt: RemoteBridgeReceipt, now = Date.now()): RemoteBridgeAbandonment | null {
  if (!["received", "running", "indeterminate"].includes(receipt.state)) return null;
  if (receipt.instanceId === INSTANCE_ID) return null;
  const origin = Number(receipt.startedAt || receipt.receivedAt || 0);
  if (!Number.isFinite(origin) || origin <= 0) return null;
  const ageMs = now - origin;
  if (ageMs < REMOTE_BRIDGE_ABANDON_AFTER_MS) return null;
  if (remoteBridgeInstanceAlive(receipt.instanceId)) return null;
  const starts = liveBridgeScriptStarts();
  if (starts === null) return null;
  if (starts.some((start) => Math.abs(start - origin) <= LIVE_SCRIPT_WINDOW_MS)) return null;
  return {
    version: 1,
    at: now,
    previousState: receipt.state as RemoteBridgeAbandonment["previousState"],
    reason: "owner_instance_gone",
    application: receipt.state === "received" ? "not_applied_verified" : "effect_uncertain",
    ownerInstanceAlive: false,
    liveCommandEvidence: false,
    ageMs,
    afterMs: REMOTE_BRIDGE_ABANDON_AFTER_MS,
  };
}

function writeAbandoned(receipt: RemoteBridgeReceipt, abandonment: RemoteBridgeAbandonment) {
  const next: RemoteBridgeReceipt = {
    ...receipt,
    state: "abandoned",
    completedAt: receipt.completedAt || abandonment.at,
    error: abandonment.application === "not_applied_verified"
      ? "Bridge instance gone before dispatch. Not applied."
      : "Bridge instance gone while request was running. Effect unknown: verify before any new request.",
    abandonment,
  };
  const filePath = requestPath(receipt.requestId);
  let times: fs.Stats | null = null;
  try { times = fs.statSync(filePath); } catch {}
  writeReceipt(next);
  // Keep the original mtime: readers rank receipts by mtime as last activity.
  if (times) { try { fs.utimesSync(filePath, times.atime, times.mtime); } catch {} }
  return next;
}

// One bounded pass over the existing receipt directory. Called once after startup
// (no timer loop); lazy reads below apply the same rule.
export function abandonStaleRemoteBridgeReceipts(options: { budgetMs?: number; maxFiles?: number } = {}) {
  const budgetMs = Math.max(50, Math.min(10_000, Number(options.budgetMs || 3_000)));
  const maxFiles = Math.max(1, Math.min(200_000, Number(options.maxFiles || 100_000)));
  const deadline = Date.now() + budgetMs;
  const summary = { state: "complete" as "complete" | "partial", scanned: 0, abandoned: 0,
    notAppliedVerified: 0, effectUncertain: 0, keptAlive: 0, at: Date.now() };
  const files = receiptFiles();
  for (const filePath of files.slice(0, maxFiles)) {
    if (Date.now() > deadline) { summary.state = "partial"; break; }
    summary.scanned++;
    let receipt: RemoteBridgeReceipt;
    try { receipt = JSON.parse(fs.readFileSync(filePath, "utf8")) as RemoteBridgeReceipt; } catch { continue; }
    if (!["received", "running", "indeterminate"].includes(receipt.state)) continue;
    if (path.basename(filePath) !== `${receipt.requestId}.json`) continue;
    const abandonment = abandonmentFor(receipt);
    if (!abandonment) { summary.keptAlive++; continue; }
    writeAbandoned(receipt, abandonment);
    summary.abandoned++;
    if (abandonment.application === "not_applied_verified") summary.notAppliedVerified++;
    else summary.effectUncertain++;
  }
  if (files.length > maxFiles) summary.state = "partial";
  lastAbandonSweep = summary;
  return summary;
}
let lastAbandonSweep: ReturnType<typeof abandonStaleRemoteBridgeReceipts> | null = null;
export function remoteBridgeAbandonSweep() { return lastAbandonSweep; }

function normalizeStaleReceipt(receipt: RemoteBridgeReceipt) {
  const abandonment = abandonmentFor(receipt);
  if (abandonment) return writeAbandoned(receipt, abandonment);
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
    continuumFence: normalized.continuumFence,
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

function mutationRisk(method: string, params?: Record<string, unknown>): "read" | "write" | "unknown" {
  if (["ping", "request_status", "task_status", "read_file", "read_binary_file", "artifact_read", "process_status", "mcp_capability_execute_readonly", "capability_execute_readonly"].includes(method)) return "read";
  if (["write_file", "patch_file", "write_binary_file", "process_input", "process_stop", "context_remember"].includes(method)) return "write";
  if (["mcp_capability_execute_owner", "capability_execute_owner"].includes(method)) {
    const decision = params?.decision && typeof params.decision === "object" ? params.decision as Record<string, unknown> : undefined;
    const risk = String(decision?.risk || "").trim();
    if (risk === "read") return "read";
    if (risk) return "write";
  }
  return "unknown";
}

function resolvedMutationRisk(
  method: string,
  result: unknown,
  fallback: "read" | "write" | "unknown",
): "read" | "write" | "unknown" {
  if (!["mcp_capability_execute_owner", "capability_execute_owner"].includes(method) || !result || typeof result !== "object") return fallback;
  if ((result as any)?.execution?.delegated === true) return "unknown";
  const risk = String((result as any)?.selected?.risk || (result as any)?.decision?.risk || "").trim();
  if (risk === "read") return "read";
  if (risk) return "write";
  return fallback;
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

async function runCapabilityAtSurface(
  params: Record<string, unknown>,
  readOnly: boolean,
  requestId: string,
  defaultSurface = "external_mcp",
  trustedSessionId?: string,
  webBounds?: {startedMonotonic:number;deadlineEpochMs:number},
) {
  const request = String(params.request || "").trim();
  if (!request || request.length > 12000) throw new Error("invalid_capability_request");
  const rawTargetHint = String(params.targetHint || "").trim();
  if (rawTargetHint && !/^[A-Za-z0-9._-]{1,128}$/.test(rawTargetHint)) {
    throw new Error("invalid_target_hint");
  }
  const surface = String(params.surface || defaultSurface).trim();
  const caller = String(params.caller || "owner").trim();
  const allowedSurfaces = new Set(["external_mcp", "claw_live", "whatsapp", "chatgpt", "samantha_android", "gemini_claw", "gemini_live", "bixby"]);
  if (!allowedSurfaces.has(surface)) throw new Error("invalid_capability_surface");
  if (!["owner", "trusted", "other"].includes(caller)) throw new Error("invalid_capability_caller");
  const targetHint = rawTargetHint || undefined;
  const decision = params.decision && typeof params.decision === "object"
    ? params.decision as Record<string, unknown>
    : undefined;
  if (decision && Number(decision.version) !== 2) throw new Error("invalid_capability_decision");
  const capability = String(decision?.capability || (decision?.selected as any)?.capability || "");
  const isWeb = ["samantha.app.web.search","samantha.app.web.answer"].includes(capability);
  const bounds = webBounds || {startedMonotonic:performance.now(),deadlineEpochMs:Date.now()+12000};
  const remaining = Math.floor(Math.min(12000-(performance.now()-bounds.startedMonotonic),bounds.deadlineEpochMs-Date.now()));
  if(isWeb && (!decision?.requestId || remaining<1))return {success:false,execution:{state:"failed",reason:"web_execution_context_unavailable"}};
  const result: any = await capabilityBridge(request, {
    execute: true,
    readOnly,
    surface,
    caller,
    timeoutSeconds: 30,
    targetHint,
    decision,
    ...(isWeb ? {requestId:String(decision!.requestId),runId:requestId,sessionId:trustedSessionId,remainingBudgetMs:remaining,deadlineEpochMs:bounds.deadlineEpochMs} : {}),
  });
  if(isWeb){
    const raw=result?.execution?.result?.web;
    const web=readRunWebResult(raw);
    if(raw!==undefined&&!web)return {...result,execution:{state:"failed",reason:"invalid_web_result",result:null}};
    if(web)result.execution.result={web};
    return result;
  }
  if (surface === "external_mcp" && !readOnly && result?.execution?.state === "delegation_required") {
    const capability = String(result?.capability || result?.selected?.capability || "");
    return {
      ...result,
      execution: await delegateMcpOwnerRequest(request, requestId, capability),
    };
  }
  return result;
}

async function runMcpCapability(
  params: Record<string, unknown>,
  readOnly: boolean,
  requestId: string,
  sessionId?: string,
  webBounds?: {startedMonotonic:number;deadlineEpochMs:number},
) {
  return runCapabilityAtSurface(params, readOnly, requestId, "external_mcp",sessionId,webBounds);
}

async function dispatch(request: RemoteBridgeRequest, webBounds?: {startedMonotonic:number;deadlineEpochMs:number}) {
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
    case "mcp_capability_execute_readonly":
      return runMcpCapability(params, true, request.requestId,request.sessionId,webBounds);
    case "mcp_capability_execute_owner":
      return runMcpCapability(params, false, request.requestId,request.sessionId,webBounds);
    case "capability_execute_readonly":
      return runCapabilityAtSurface(params, true, request.requestId, "claw_live",request.sessionId,webBounds);
    case "capability_execute_owner":
      return runCapabilityAtSurface(params, false, request.requestId, "claw_live",request.sessionId,webBounds);
    case "process_start":
      return startBridgeProcess(params);
    case "process_status":
      return bridgeProcessStatus(params);
    case "process_input":
      return bridgeProcessInput(params);
    case "process_stop":
      return bridgeProcessStop(params);
    case "context_remember":
      // M2: only an admitted MCP owner identity may write shared memory through the bridge.
      if (request._claw_access?.owner !== true || request._claw_access.profile !== "chat-owner") {
        throw new Error("owner_mcp_access_required");
      }
      return memoryRemember(params);
    default:
      throw new Error(`unsupported_method:${request.method}`);
  }
}

// Process-local provenance cannot be supplied through HTTP or serialized JSON.
const authenticatedMcpAccess = new WeakMap<object, ClawAccess>();
export async function submitAuthenticatedMcpRequest(body: RemoteBridgeRequest, webBounds?: {startedMonotonic:number;deadlineEpochMs:number}): Promise<RemoteBridgeReceipt> {
  const access = body._claw_access;
  if (!access) throw statusError(400,"invalid_claw_access");
  const trusted = {...body}; delete trusted._claw_access;
  authenticatedMcpAccess.set(trusted, {...access});
  return submitRemoteBridgeRequest(trusted,webBounds);
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
  if (body?._claw_access) throw statusError(400,"invalid_claw_access");
  const access = authenticatedMcpAccess.get(body);
  if (access && (!/^[A-Za-z0-9._-]{1,24}$/.test(access.client_id) ||
      !["chat-owner","chat-owner-shadow"].includes(access.profile) ||
      body.sessionId !== `external_mcp:${access.client_id}` ||
      access.owner !== (access.profile === "chat-owner") || access.read_only !== (access.profile !== "chat-owner"))) {
    throw statusError(400,"invalid_claw_access");
  }
  return {
    requestId,
    taskId,
    stepId,
    ...(access ? {_claw_access:{client_id:access.client_id,profile:access.profile,owner:access.owner,read_only:access.read_only}} : {}),
    sessionId: body?.sessionId ? String(body.sessionId) : undefined,
    method,
    params: body?.params && typeof body.params === "object"
      ? body.params
      : {},
    continuumFence: body?.continuumFence,
  };
}export async function submitRemoteBridgeRequest(
  body: RemoteBridgeRequest,
  webBounds?: {startedMonotonic:number;deadlineEpochMs:number},
): Promise<RemoteBridgeReceipt> {
  const bounds=webBounds || {startedMonotonic:performance.now(),deadlineEpochMs:Date.now()+12000};
  ensureDirs();
  const request = normalizeRequest(body);
  const params = (request.params || {}) as Record<string, unknown>;
  const paramsHash = hashParams(request.method, params);
  const existing = readReceipt(request.requestId);

  if (existing) {
    if (request._claw_access && existing._claw_access && JSON.stringify(request._claw_access)!==JSON.stringify(existing._claw_access)) throw statusError(409,"request_access_conflict");
    if (existing.paramsHash !== paramsHash || existing.method !== request.method) {
      throw statusError(409, "request_id_conflict");
    }
    if (request.taskId && existing.taskId !== request.taskId) {
      throw statusError(409, "request_task_conflict");
    }
    if (request.stepId && existing.stepId !== request.stepId) {
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

  const continuumFence = validateContinuumFence(request, paramsHash);

  let receipt: RemoteBridgeReceipt = {
    requestId: request.requestId,
    ...(request._claw_access ? {_claw_access:request._claw_access} : {}),
    taskId: request.taskId,
    stepId: request.stepId,
    sessionId: request.sessionId,
    method: request.method,
    paramsHash,    state: "received",
    instanceId: INSTANCE_ID,
    receivedAt: Date.now(),
    mutationRisk: mutationRisk(request.method, params),
    continuumFence,
  };
  writeReceipt(receipt);
  receipt = {
    ...receipt,
    state: "running",
    startedAt: Date.now(),
  };
  writeReceipt(receipt);

  const completion = (async () => {
  try {
    const rawResult = await dispatch(request,bounds);
    const result = compactResult(request.requestId, rawResult);
    receipt = {
      ...receipt,
      state: "completed",
      completedAt: Date.now(),
      mutationRisk: resolvedMutationRisk(request.method, rawResult, receipt.mutationRisk),
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
  })();
  if (request.method !== "exec_wait") return completion;
  // The relay stops waiting after 28 seconds. Keep execution owned by this
  // receipt, but acknowledge within the public 15-second response budget.
  // Polling the existing status route never dispatches the command again.
  let responseTimer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      completion,
      new Promise<RemoteBridgeReceipt>((resolve) => {
        responseTimer = setTimeout(() => resolve(receipt), 12_000);
      }),
    ]);
  } finally {
    clearTimeout(responseTimer);
  }
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

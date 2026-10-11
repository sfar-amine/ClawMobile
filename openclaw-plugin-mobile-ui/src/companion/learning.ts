import {execFile} from "child_process";
import {stat} from "fs/promises";
import os from "os";
import path from "path";
import {controlPaths} from "./control";
import {markRunNotThis, readRunForCorrection, type RunCorrection} from "./runs";

/**
 * 38 A2 — routes owner d'apprentissage. Propriétaire unique : `engineering.learning_gate` (improvements.db),
 * via `python3 -m reporting.control_learning` du playbooks épinglé. Aucun store, routeur ni démon ici :
 * un cache de lecture court (5 s, invalidé par la signature du store) et un cache de rejeu borné.
 */
const nativeError = (code: string, statusCode = 400) => Object.assign(new Error(code), {statusCode});
const ID_RE = /^[a-f0-9]{64}$/;
const OPERATION_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const RUN_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const VIEWS = new Set(["candidate", "learned", "counter_example", "default_slot", "outside_catalog"]);
const LIST_TTL_MS = 5000;
const MAX_REPLAYS = 64;

function storePath() {
  return process.env.SAMANTHA_IMPROVEMENT_STORE || path.join(os.homedir(), ".openclaw/skill-intelligence/improvements.db");
}

async function storeSignature(): Promise<string> {
  const parts: string[] = [];
  for (const file of [storePath(), storePath() + "-wal"]) {
    try { const s = await stat(file); parts.push(`${s.ino}:${s.size}:${s.mtimeMs}`); } catch { parts.push("-"); }
  }
  return parts.join("|");
}

function callOwner(args: string[], stdin?: unknown, timeout = 2500): Promise<any> {
  return new Promise((resolve, reject) => {
    const env = {...process.env, SAMANTHA_IMPROVEMENT_STORE: storePath(), PYTHONDONTWRITEBYTECODE: "1"};
    const child = execFile("python3", ["-m", "reporting.control_learning", ...args], {
      cwd: controlPaths().playbooks, env, timeout, maxBuffer: 512 * 1024,
    }, (error, stdout) => {
      let value: any;
      try { value = JSON.parse(String(stdout || "")); } catch { reject(nativeError("learning_owner_unavailable", 503)); return; }
      if (error) {
        if ((error as any).code === 2 && value?.state === "refused") { reject(nativeError("invalid_learning_request", 400)); return; }
        reject(nativeError("learning_owner_unavailable", 503)); return;
      }
      resolve(value);
    });
    if (stdin !== undefined) { child.stdin?.on("error", () => {}); child.stdin?.end(JSON.stringify(stdin)); }
  });
}

let listCache: {key: string; at: number; value: any} | null = null;
export function resetLearningCache() { listCache = null; replays.clear(); }

export async function learningList(parameters: URLSearchParams) {
  for (const [key] of parameters) {
    if (!["offset", "limit", "view"].includes(key) || parameters.getAll(key).length !== 1) throw nativeError("invalid_learning_query");
  }
  const offset = parameters.get("offset") || "0", limit = parameters.get("limit") || "50", view = parameters.get("view") || "";
  if (!/^\d{1,4}$/.test(offset) || Number(offset) > 5000 || !/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 50 ||
      (view && !VIEWS.has(view))) throw nativeError("invalid_learning_query");
  const key = JSON.stringify([controlPaths().playbooks, await storeSignature(), offset, limit, view]);
  if (listCache && listCache.key === key && Date.now() - listCache.at < LIST_TTL_MS) return listCache.value;
  const args = ["list", "--offset", offset, "--limit", limit, ...(view ? ["--view", view] : [])];
  const value = await callOwner(args);
  if (value?.receipt !== null || !Array.isArray(value?.items) || value.items.length > 50 || !["ok", "empty", "unavailable"].includes(value.state)) {
    throw nativeError("learning_owner_unavailable", 503);
  }
  // Défense en profondeur : gabarits seulement, jamais de chiffre.
  value.items = value.items.filter((item: any) => typeof item?.template === "string" && !/\d/.test(item.template) && ID_RE.test(item?.id || ""));
  listCache = {key, at: Date.now(), value};
  return value;
}

const replays = new Map<string, any>();
function remember(key: string, value: any) {
  replays.set(key, value);
  while (replays.size > MAX_REPLAYS) replays.delete(replays.keys().next().value as string);
  return value;
}

function operationId(body: any, keys: string[]) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join() !== [...keys].sort().join() ||
      typeof body.operationId !== "string" || !OPERATION_RE.test(body.operationId)) throw nativeError("invalid_learning_operation");
  return body.operationId as string;
}

export async function learningForget(id: string, body: any) {
  if (!ID_RE.test(id)) throw nativeError("invalid_learning_operation");
  const op = operationId(body, ["operationId"]);
  const key = `forget:${id}:${op}`;
  if (replays.has(key)) return replays.get(key);
  const value = await callOwner(["forget", id, "--operation-id", op]);
  if (!["forgotten", "already_forgotten", "not_found"].includes(value?.state)) throw nativeError("learning_owner_unavailable", 503);
  listCache = null;
  return remember(key, value);
}

const inFlight = new Map<string, Promise<any>>();
export async function learningNotThis(body: any) {
  const op = operationId(body, ["operationId", "runId"]);
  if (typeof body.runId !== "string" || !RUN_RE.test(body.runId)) throw nativeError("invalid_learning_operation");
  const runId = body.runId as string;
  const running = inFlight.get(runId);
  if (running) return running;
  const work = (async () => {
    const run = await readRunForCorrection(runId);
    if (!run) return {success: false, state: "not_found", receipt: null, runId};
    if (run.notThis) return {success: true, state: "already_recorded", runId, receipt: {action: "learning.not_this", runId, operationId: run.notThis.operationId}, correction: run.notThis};
    const value = await callOwner(["not-this"], {runId, operationId: op, text: run.text, userText: run.userText, decision: run.decision});
    if (value?.state !== "recorded" || !Array.isArray(value.neutralized)) throw nativeError("learning_owner_unavailable", 503);
    const correction: RunCorrection = {version: 1, operationId: op, at: Date.now(), neutralized: value.neutralized.length,
      counterExample: value.counterExample?.state === "recorded" ? "recorded" : value.counterExample ? "not_stored" : "none",
      roundSignal: value.roundSignal?.state === "pending" ? "pending" : value.roundSignal ? "not_captured" : "none"};
    const stored = await markRunNotThis(runId, correction);
    listCache = null;
    // Ni texte, ni gabarit, ni décision dans la réponse : l'app relit la liste si besoin.
    return {success: true, state: "recorded", runId, receipt: {action: "learning.not_this", runId, operationId: stored.operationId},
      correction: stored, effect: "La même demande reposera la question au prochain run."};
  })();
  inFlight.set(runId, work);
  try { return await work; } finally { inFlight.delete(runId); }
}

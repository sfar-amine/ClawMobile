import {runtimeFile} from "../runtimeRoot";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {PUBLIC_WEB_BUDGET_MS} from "./runWeb";

const execFileAsync = promisify(execFile);

/** Existing helper transport, with optional bounded read cancellation. A process group includes Python/Graph children. */
export async function runCapabilityHelperProcess(args: string[], options: {
  timeoutMs:number;maxBuffer:number;env:NodeJS.ProcessEnv;signal?:AbortSignal;killGroup?:boolean;
  /** Private host-owned metadata pipe, never a model/public request argument. */
  privateInput?:string;
}): Promise<any> {
  if (options.signal?.aborted) throw Object.assign(new Error("capability_cancelled"),{code:"ABORT_ERR"});
  if(options.privateInput!==undefined&&Buffer.byteLength(options.privateInput)>32768)throw new Error('private_input_limit');
  // Also establish the group in the Python leader: hosted launchers may strip Node's detached flag.
  const groupLeader = "import os,sys; os.getpgrp()==os.getpid() or os.setsid(); os.execv(sys.executable,[sys.executable,*sys.argv[1:]])";
  const commandArgs = options.killGroup ? ["-c",groupLeader,...args] : args;
  const promise = execFileAsync("python3", commandArgs, {
    timeout:options.killGroup?0:options.timeoutMs,maxBuffer:options.maxBuffer,env:options.env,
    ...(options.killGroup?{detached:true,killSignal:"SIGTERM" as const}:options.signal?{signal:options.signal}:{}),
  });
  const child = promise.child;
  if(options.privateInput!==undefined){
    child.stdin?.on('error',()=>{});
    child.stdin?.end(options.privateInput);
  }
  let shutdown:Promise<void>|undefined;
  const stop = () => {
    if (!options.killGroup || !child?.pid || shutdown) return;
    let active=false;try {process.kill(-child.pid,"SIGTERM");active=true;} catch {}
    if(active)shutdown=new Promise(resolve=>setTimeout(()=>{try{process.kill(-child.pid!,"SIGKILL");}catch{}resolve();},250));
  };
  const groupDeadline=options.killGroup?setTimeout(stop,options.timeoutMs):undefined;
  const groupHardDeadline=options.killGroup?setTimeout(()=>{try{process.kill(-child.pid!,"SIGKILL");}catch{}try{child.kill("SIGKILL");}catch{}},options.timeoutMs+300):undefined;
  options.signal?.addEventListener("abort",stop,{once:true});
  if (options.signal?.aborted) stop();
  try {return await promise;}
  finally {
    if(groupDeadline)clearTimeout(groupDeadline);
    if(groupHardDeadline)clearTimeout(groupHardDeadline);
    options.signal?.removeEventListener("abort",stop);stop();
    if(shutdown)await shutdown;
  }
}

function helpers(home = os.homedir()): string[] {
  const configured = String(process.env.CLAW_CAPABILITY_HELPER || "").trim();
  return [
    configured,
    runtimeFile("claw-capability.py", home),
  ].filter(Boolean);
}

export async function capabilityBridge(
  request: string,
  options: {
    execute?: boolean;
    readOnly?: boolean;
    surface?: string;
    caller?: string;
    timeoutSeconds?: number;
    checkBudgetMs?: number;
    requestId?: string;
    runId?: string;
    sessionId?: string;
    remainingBudgetMs?: number;
    deadlineEpochMs?: number;
    signal?: AbortSignal;
    targetHint?: string;
    helperPath?: string;
    decision?: Record<string, unknown>;
  } = {},
): Promise<Record<string, unknown>> {
  const text = String(request || "").trim();
  if (!text) return { success: false, error: "request_required" };
  if (text.length > 12000) return { success: false, error: "request_too_large" };

  const execute = options.execute === true;
  const surface = String(options.surface || "bixby");
  const caller = String(options.caller || "owner");
  const targetHint = String(options.targetHint || "").trim();
  if (targetHint && !/^[A-Za-z0-9._-]{1,128}$/.test(targetHint)) {
    return { success: false, error: "invalid_target_hint" };
  }
  const timeout = Math.max(2, Math.min(Number(options.timeoutSeconds || 30), 120));
  const bounded = options.remainingBudgetMs !== undefined;
  const checkBounded=options.checkBudgetMs!==undefined;
  if(checkBounded&&(execute||!Number.isSafeInteger(options.checkBudgetMs)||options.checkBudgetMs!<1||options.checkBudgetMs!>12000))return {success:false,error:"invalid_check_budget"};
  const started = performance.now();
  if (bounded && (!Number.isSafeInteger(options.remainingBudgetMs) || options.remainingBudgetMs! < 1 || options.remainingBudgetMs! > PUBLIC_WEB_BUDGET_MS ||
      !Number.isSafeInteger(options.deadlineEpochMs) || options.deadlineEpochMs! <= Date.now() || !options.requestId ||
      options.decision && options.decision.requestId !== options.requestId)) return {success:false,error:"invalid_web_execution_context"};
  if(options.signal?.aborted)return {success:false,error:"execution_cancelled",execution:{state:"cancelled"}};
  const candidates = options.helperPath ? [options.helperPath] : helpers();

  for (const helper of candidates) {
    try {
      const prepared = execute && options.decision && typeof options.decision === "object";
      const argv = prepared
        ? [helper, "execute-decision", text, "--decision-b64", Buffer.from(JSON.stringify(options.decision), "utf8").toString("base64"), "--timeout", String(timeout)]
        : [helper, execute ? "execute" : "resolve", text, "--surface", surface, "--caller", caller];
      if (!prepared && targetHint) argv.push("--target", targetHint);
      if (!prepared && execute) argv.push("--timeout", String(timeout));
      if (execute && options.readOnly === true) argv.push("--read-only");
      if(options.requestId)argv.push("--request-id",options.requestId);
      if(execute&&options.runId)argv.push("--run-id",options.runId);
      if(execute&&options.sessionId)argv.push("--session-id",options.sessionId);
      const remaining=bounded?Math.floor(Math.min(options.remainingBudgetMs!-(performance.now()-started),options.deadlineEpochMs!-Date.now())):checkBounded?Math.floor(options.checkBudgetMs!-(performance.now()-started)):undefined;
      if(remaining!==undefined&&remaining<=0)return {success:false,error:"web_deadline_exceeded",execution:{state:"timeout"}};
      if(execute&&bounded)argv.push("--remaining-budget-ms",String(remaining),"--deadline-epoch-ms",String(options.deadlineEpochMs));
      const raw: any = await runCapabilityHelperProcess(argv, {
        timeoutMs: remaining===undefined?(timeout+8)*1000:remaining,
        maxBuffer: bounded?128*1024:2*1024*1024,
        env: { ...process.env },signal:options.signal,killGroup:bounded||checkBounded,
      });
      const stdout = typeof raw === "string" ? raw : String(raw?.stdout ?? "");
      const parsed = JSON.parse(stdout || "{}");
      if(options.signal?.aborted)return {success:false,error:"execution_cancelled",execution:{state:"cancelled"}};
      if(checkBounded&&performance.now()-started>=options.checkBudgetMs!)return {success:false,error:"check_budget_exceeded"};
      if(bounded&&(Date.now()>=options.deadlineEpochMs!||performance.now()-started>=options.remainingBudgetMs!))return {success:false,error:"web_deadline_exceeded",execution:{state:"timeout"}};
      return { success: true, ...parsed };
    } catch (error: any) {
      if (options.signal?.aborted) return {success:false,error:"execution_cancelled",execution:{state:"cancelled"}};
      if(checkBounded&&(error?.killed||performance.now()-started>=options.checkBudgetMs!))return {success:false,error:"check_budget_exceeded"};
      if(bounded && (error?.killed || Date.now()>=options.deadlineEpochMs!))return {success:false,error:"web_deadline_exceeded",execution:{state:"timeout"}};
      if (error?.code === "ENOENT") continue;
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      try {
        const parsed = JSON.parse(stdout || "{}");
        return { success: false, ...parsed };
      } catch {}
      return { success: false, error: "capability_bridge_failed" };
    }
  }
  return { success: false, error: "capability_bridge_unavailable" };
}
export async function validateCapabilityDecision(
  request: string,
  decision: Record<string, unknown>,
  options: { helperPath?: string; timeoutSeconds?: number; checkBudgetMs?:number } = {},
): Promise<Record<string, unknown>> {
  const text = String(request || "").trim();
  if (!text) return { success: false, error: "request_required" };
  if (!decision || typeof decision !== "object" || Number(decision.version) !== 2) {
    return { success: false, error: "invalid_decision" };
  }
  const timeout = Math.max(2, Math.min(Number(options.timeoutSeconds || 20), 120));
  const started=performance.now();
  if(options.checkBudgetMs!==undefined&&(!Number.isSafeInteger(options.checkBudgetMs)||options.checkBudgetMs<1||options.checkBudgetMs>12000))return {success:false,error:"invalid_check_budget"};
  const candidates = options.helperPath ? [options.helperPath] : helpers();
  const encoded = Buffer.from(JSON.stringify(decision), "utf8").toString("base64");
  for (const helper of candidates) {
    try {
      const remaining=options.checkBudgetMs===undefined?undefined:Math.floor(options.checkBudgetMs-(performance.now()-started));
      if(remaining!==undefined&&remaining<1)return {success:false,error:"check_budget_exceeded"};
      const raw: any = await runCapabilityHelperProcess([helper, "validate-decision", text, "--decision-b64", encoded], {
        timeoutMs: remaining??(timeout+8)*1000,maxBuffer:2*1024*1024,env:{...process.env},killGroup:remaining!==undefined,
      });
      if(options.checkBudgetMs!==undefined&&performance.now()-started>=options.checkBudgetMs)return {success:false,error:"check_budget_exceeded"};
      const stdout = typeof raw === "string" ? raw : String(raw?.stdout ?? "");
      const parsed = JSON.parse(stdout || "{}");
      return { success: true, ...parsed };
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      try {
        const parsed = JSON.parse(stdout || "{}");
        return { success: false, ...parsed };
      } catch {}
      return { success: false, error: options.checkBudgetMs!==undefined&&performance.now()-started>=options.checkBudgetMs?"check_budget_exceeded":"decision_validation_failed" };
    }
  }
  return { success: false, error: "capability_bridge_unavailable" };
}

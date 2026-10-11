import { spawn } from "child_process";
import {opendirSync,readFileSync} from "fs";
import {compactOwnerAgentContext} from "./clawLive";
import {turnAdmission,type AdmissionTicket} from "./ownerTurnAdmission";
import {submitOwnerTurn} from "./ownerTurnGateway";

export type OpenClawAgentSubmitResult = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  status?: string;
  acceptedAt?: number;
  waitedForFinal: boolean;
  raw: any;
  /** P1 : connexion effectivement utilisée pour ce tour. */
  ownerTransport?: import("./runs").OwnerTransport;
};

const DEFAULT_SUBMIT_TIMEOUT_MS = 15_000;
const DEFAULT_FINAL_TIMEOUT_MS = 120_000;
const DEFAULT_GATEWAY_CALL_TIMEOUT_MS = 10_000;

export async function submitToOpenClawAgent(
  text: string,
  runId: string,
  sessionId = "default",
  options: {authority?:"owner"; admission?:AdmissionTicket; clientRunId?:string} = {},
): Promise<OpenClawAgentSubmitResult> {
  const waitedForFinal = shouldWaitForFinal();
  const timeoutMs = configuredTimeoutMs(waitedForFinal);
  const normalizedSessionId = normalizeCompanionSessionId(sessionId);
  const sessionKey = companionSessionKey(normalizedSessionId);
  const agentId = (process.env.CLAWMOBILE_AGENT_ID || "").trim();
  const canonical=compactOwnerAgentContext(options);
  const params = {
    sessionKey,
    ...(agentId ? { agentId } : {}),
    label: "ClawMobile Companion",
    // Slash commands must remain first for Gateway dispatch. Ordinary turns carry one transport label; later lookalikes remain user content.
    message: text.trimStart().startsWith("/") ? text : `[companion-session:${normalizedSessionId}]\n${text}`,
    deliver: false,
    bootstrapContextMode: "lightweight",
    ...(canonical?{extraSystemPrompt:canonical}:{}),
    idempotencyKey: runId,
  };

  assertCanonicalAgentPayload(params);
  // P1 : seul un ticket d'admission natif courant, pour ce tour et cette session, ouvre la connexion admin.
  // `authority` (contexte canonique) ne choisit jamais la connexion.
  const admitted = options.admission !== undefined &&
    turnAdmission.isCurrent(options.admission, {clientRunId: options.clientRunId, sessionId: normalizedSessionId});
  let raw: any;
  let ownerTransport: OpenClawAgentSubmitResult["ownerTransport"] = "write_cli";
  if (admitted) {
    try {
      raw = await submitOwnerTurn(params, {expectFinal: waitedForFinal, timeoutMs, admission: options.admission!, binding: {clientRunId: options.clientRunId, sessionId: normalizedSessionId}});
      ownerTransport = "admin_admitted";
    } catch (error: any) {
      // Avant envoi uniquement : le tour reste non-owner sur le CLI. Après envoi : jamais de rejeu.
      if (error?.requestSent !== false) throw error;
      ownerTransport = "write_cli_owner_unavailable";
    }
  }
  if (ownerTransport !== "admin_admitted") {
    raw = await callOpenClawGateway("agent", params, {
      expectFinal: waitedForFinal,
      timeoutMs,
    });
  }
  return {
    ownerTransport,
    runId: String(raw?.runId || runId),
    sessionId: normalizedSessionId,
    sessionKey: typeof raw?.sessionKey === "string" ? raw.sessionKey : undefined,
    status: typeof raw?.status === "string" ? raw.status : undefined,
    acceptedAt: typeof raw?.acceptedAt === "number" ? raw.acceptedAt : undefined,
    waitedForFinal,
    raw,
  };
}

export function assertCanonicalAgentPayload(params:Record<string,any>){
  if(typeof params.extraSystemPrompt==='string'&&Buffer.byteLength(JSON.stringify(params),'utf8')>120000)
    throw new Error('canonical_bootstrap_budget_exceeded');
}

export async function callOpenClawGateway(
  method: string,
  params: Record<string, any> = {},
  options: { expectFinal?: boolean; timeoutMs?: number; hardTimeoutMs?: number; strictOutput?: {stdoutMaxBytes:number;stderrMaxBytes:number;killGraceMs:number} } = {},
): Promise<any> {
  const timeoutMs = options.timeoutMs || DEFAULT_GATEWAY_CALL_TIMEOUT_MS;
  const args = ["gateway", "call", method, "--json", "--timeout", String(timeoutMs), "--params", JSON.stringify(params)];
  if (options.expectFinal) {
    args.splice(3, 0, "--expect-final");
  }
  const hard=Math.min(timeoutMs + 5_000, options.hardTimeoutMs ?? Infinity);
  return options.strictOutput ? runStrictOpenClaw(args,hard,options.strictOutput) : runOpenClaw(args,hard);
}

export function describeOpenClawResult(result: OpenClawAgentSubmitResult) {
  if (result.waitedForFinal) {
    const text = extractText(result.raw);
    if (text) return text;
    return `OpenClaw finished run ${result.runId}.`;
  }

  return "OpenClaw is working on your task.";
}

function runOpenClaw(args: string[], hardTimeoutMs: number): Promise<any> {
  const command = process.env.CLAWMOBILE_OPENCLAW_BIN || "openclaw";

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`OpenClaw gateway call timed out after ${hardTimeoutMs}ms.`));
    }, hardTimeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(err || out || `OpenClaw gateway call exited with code ${code}.`));
        return;
      }

      try {
        resolve(parseJsonOutput(out));
      } catch (error: any) {
        reject(new Error(`OpenClaw gateway returned invalid JSON: ${error?.message || error}`));
      }
    });
  });
}

/** Fixed /proc metadata only; an unreadable/truncated census never proves exit. */
async function strictGroupState(pid:number|undefined,grouped:boolean,until:number):Promise<"confirmed"|"alive"|"unknown">{
  if(!pid)return "confirmed";
  try{process.kill(grouped?-pid:pid,0);}catch(error:any){return error?.code==="ESRCH"?"confirmed":"unknown";}
  if(!grouped)return "alive";
  if(process.platform!=="linux"&&process.platform!=="android")return "unknown";
  let directory:ReturnType<typeof opendirSync>|undefined;
  try{
    directory=opendirSync("/proc");let entries=0;
    while(true){
      if(Date.now()>=until||++entries>32768)return "unknown";
      // Yield metadata chunks so close/signal effects are not starved by a large /proc.
      if(entries%32===0)await new Promise<void>(resolve=>setImmediate(resolve));
      if(Date.now()>=until)return "unknown";
      const entry=directory.readSync();if(!entry)return "confirmed";
      if(!/^[0-9]+$/.test(entry.name))continue;
      let stat:string;
      try{stat=readFileSync(`/proc/${entry.name}/stat`,"utf8");}
      catch(error:any){if(error?.code==="ENOENT"||error?.code==="ESRCH")continue;return "unknown";}
      if(stat.length>4096)return "unknown";
      const end=stat.lastIndexOf(")");if(end<1)return "unknown";
      const fields=stat.slice(end+2).trim().split(/\s+/);
      if(fields.length<3||!/^\d+$/.test(fields[2]))return "unknown";
      if(Number(fields[2])===pid&&!['Z','X'].includes(fields[0]))return "alive";
    }
  }catch{return "unknown";}finally{try{directory?.closeSync();}catch{}}
}

/** Opt-in bounded read collector; existing callers retain their default behavior. */
function runStrictOpenClaw(args:string[],hardMs:number,bounds:{stdoutMaxBytes:number;stderrMaxBytes:number;killGraceMs:number}):Promise<any>{
  if(!Number.isFinite(hardMs)||hardMs<1||hardMs>30000||!Number.isSafeInteger(bounds.stdoutMaxBytes)||bounds.stdoutMaxBytes<256||bounds.stdoutMaxBytes>9*1024*1024||!Number.isSafeInteger(bounds.stderrMaxBytes)||bounds.stderrMaxBytes<256||bounds.stderrMaxBytes>128*1024||!Number.isSafeInteger(bounds.killGraceMs)||bounds.killGraceMs<1||bounds.killGraceMs>1000)return Promise.reject(new Error("gateway_read_limits_invalid"));
  return new Promise((resolve,reject)=>{
    const grouped=process.platform!=="win32";
    const child=spawn(process.env.CLAWMOBILE_OPENCLAW_BIN||"openclaw",args,{env:process.env,stdio:["ignore","pipe","pipe"],detached:grouped});
    const output:Buffer[]=[],errors:Buffer[]=[];let outBytes=0,errBytes=0,failed=false,settled=false,closed=false;
    let cleanupState:"confirmed"|"alive"|"unknown"="unknown",killTimer:ReturnType<typeof setTimeout>|undefined,cleanupTimer:ReturnType<typeof setTimeout>|undefined;
    const kill=(signal:NodeJS.Signals)=>{try{if(grouped&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{try{child.kill(signal);}catch{}}};
    const rejectFailure=()=>{if(settled)return;settled=true;clearTimeout(deadline);if(killTimer)clearTimeout(killTimer);if(cleanupTimer)clearTimeout(cleanupTimer);reject(Object.assign(new Error("gateway_read_failed"),{cleanupState:cleanupState==="confirmed"&&closed?"confirmed":"unknown"}));};
    const fail=()=>{
      if(failed||settled)return;failed=true;output.length=0;errors.length=0;kill("SIGTERM");
      const until=Date.now()+bounds.killGraceMs;
      // TERM and verification share the original grace; SIGKILL is not an ack.
      const verify=async()=>{
        if(settled)return;
        const observed=await strictGroupState(child.pid,grouped,until);
        if(settled)return;cleanupState=observed;
        if(cleanupState==="confirmed"&&closed){rejectFailure();return;}
        if(Date.now()>=until){kill("SIGKILL");rejectFailure();return;}
        cleanupTimer=setTimeout(()=>{void verify();},Math.min(2,Math.max(1,until-Date.now())));
      };
      killTimer=setTimeout(()=>{kill("SIGKILL");void verify();},Math.floor(bounds.killGraceMs/2));
    };
    const deadline=setTimeout(fail,hardMs);
    child.stdout.on("data",chunk=>{if(failed)return;outBytes+=chunk.length;if(outBytes>bounds.stdoutMaxBytes)fail();else output.push(Buffer.from(chunk));});
    child.stderr.on("data",chunk=>{if(failed)return;errBytes+=chunk.length;if(errBytes>bounds.stderrMaxBytes)fail();else errors.push(Buffer.from(chunk));});
    child.once("error",()=>{if(settled)return;if(child.pid){fail();return;}closed=true;cleanupState="confirmed";rejectFailure();});
    child.once("close",code=>{
      if(settled)return;closed=true;clearTimeout(deadline);if(failed){if(cleanupState==="confirmed")rejectFailure();return;}
      if(code!==0){fail();return;}
      try{const value=parseJsonOutput(Buffer.concat(output).toString("utf8").trim());settled=true;resolve(value);}catch{fail();}
    });
  });
}

function parseJsonOutput(output: string) {
  if (!output) return {};
  try {
    return JSON.parse(output);
  } catch {
    const first = output.indexOf("{");
    const last = output.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(output.slice(first, last + 1));
    }
    throw new Error("no JSON object found");
  }
}

function companionSessionKey(sessionId: string) {
  return `companion-chat-${normalizeCompanionSessionId(sessionId)}`;
}

export function expectedCompanionSessionKey(sessionId: string) {
  const agentId = (process.env.CLAWMOBILE_AGENT_ID || "main").trim() || "main";
  return `agent:${agentId}:${companionSessionKey(sessionId)}`;
}

export function normalizeCompanionSessionId(sessionId: string) {
  const safe = (sessionId || "default")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return safe || "default";
}

function shouldWaitForFinal() {
  return ["1", "true", "yes"].includes((process.env.CLAWMOBILE_INTENT_WAIT_FOR_FINAL || "").toLowerCase());
}

function configuredTimeoutMs(waitedForFinal: boolean) {
  const raw = Number.parseInt(process.env.CLAWMOBILE_INTENT_TIMEOUT_MS || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return waitedForFinal ? DEFAULT_FINAL_TIMEOUT_MS : DEFAULT_SUBMIT_TIMEOUT_MS;
}

function extractText(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  for (const key of ["result", "message", "text", "output", "summary"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].trim();
    }
  }
  if (value.final) return extractText(value.final);
  if (value.response) return extractText(value.response);
  return "";
}

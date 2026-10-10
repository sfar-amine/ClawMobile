import { spawn } from "child_process";
import { PersistentGatewayTransport } from "./persistentGatewayTransport";
import { createOfficialGatewayOwner } from "./officialGatewayOwner";

export type OpenClawAgentSubmitResult = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  status?: string;
  acceptedAt?: number;
  waitedForFinal: boolean;
  raw: any;
};

const DEFAULT_SUBMIT_TIMEOUT_MS = 15_000;
const DEFAULT_FINAL_TIMEOUT_MS = 120_000;
const DEFAULT_GATEWAY_CALL_TIMEOUT_MS = 10_000;

export async function submitToOpenClawAgent(
  text: string,
  runId: string,
  sessionId = "default",
): Promise<OpenClawAgentSubmitResult> {
  const waitedForFinal = shouldWaitForFinal();
  const timeoutMs = configuredTimeoutMs(waitedForFinal);
  const normalizedSessionId = normalizeCompanionSessionId(sessionId);
  const sessionKey = companionSessionKey(normalizedSessionId);
  const agentId = (process.env.CLAWMOBILE_AGENT_ID || "").trim();
  const params = {
    sessionKey,
    ...(agentId ? { agentId } : {}),
    label: "ClawMobile Companion",
    // Slash commands must remain first for Gateway dispatch. Ordinary turns carry one transport label; later lookalikes remain user content.
    message: text.trimStart().startsWith("/") ? text : `[companion-session:${normalizedSessionId}]\n${text}`,
    deliver: false,
    bootstrapContextMode: "lightweight",
    idempotencyKey: runId,
  };

  const raw = await callOpenClawGateway("agent", params, {
    expectFinal: waitedForFinal,
    timeoutMs,
  });
  return {
    runId: String(raw?.runId || runId),
    sessionId: normalizedSessionId,
    sessionKey: typeof raw?.sessionKey === "string" ? raw.sessionKey : undefined,
    status: typeof raw?.status === "string" ? raw.status : undefined,
    acceptedAt: typeof raw?.acceptedAt === "number" ? raw.acceptedAt : undefined,
    waitedForFinal,
    raw,
  };
}

export async function callOpenClawGateway(
  method: string,
  params: Record<string, any> = {},
  options: { expectFinal?: boolean; timeoutMs?: number; hardTimeoutMs?: number; strictOutput?: {stdoutMaxBytes:number;stderrMaxBytes:number;killGraceMs:number} } = {},
): Promise<any> {
  if (!gatewayTransport) {
    gatewayTransport = new PersistentGatewayTransport(createOfficialGatewayOwner, callOpenClawGatewayCli);
  }
  return gatewayTransport.call(method, params, {
    ...options, timeoutMs: options.timeoutMs ?? DEFAULT_GATEWAY_CALL_TIMEOUT_MS,
  });
}

let gatewayTransport: PersistentGatewayTransport | undefined;
export function closeOpenClawGateway() {
  gatewayTransport?.close(); gatewayTransport = undefined;
}
process.once("exit", closeOpenClawGateway);

/** Original CLI owner retained solely for confirmed pre-dispatch unavailability. */
async function callOpenClawGatewayCli(method: string, params: Record<string, any>,
  options: {expectFinal?: boolean; timeoutMs?: number; hardTimeoutMs?: number; strictOutput?: {stdoutMaxBytes:number;stderrMaxBytes:number;killGraceMs:number}}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_CALL_TIMEOUT_MS;
  const args = ["gateway", "call", method, "--json", "--timeout", String(timeoutMs), "--params", JSON.stringify(params)];
  if (options.expectFinal) args.splice(3, 0, "--expect-final");
  try {
    const hard = Math.min(timeoutMs + 5_000, options.hardTimeoutMs ?? Infinity);
    return await (options.strictOutput ? runStrictOpenClaw(args, hard, options.strictOutput) : runOpenClaw(args, hard));
  } catch (cause: any) {
    const cas = ["config base hash unavailable; re-run config.get and retry",
      "config base hash required; re-run config.get and retry",
      "config changed since last load; re-run config.get and retry"];
    if (method === "config.patch" && cas.some(message => String(cause?.message).trim() === message)) {
      throw Object.assign(new Error("config baseHash conflict"), {
        code: "gateway_config_revision_conflict", effectNotStarted: true, requestSent: true,
      });
    }
    throw cause;
  }

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
        // The official --json CLI error formatter keeps refusal metadata machine-readable.
        try {
          const failure = JSON.parse(out);
          if (failure?.ok === false && failure.error?.type === "gateway_request_error" &&
            typeof failure.error.code === "string" && typeof failure.error.message === "string") {
            reject(Object.assign(new Error(failure.error.message), {
              name: "GatewayClientRequestError", gatewayCode: failure.error.code,
            }));
            return;
          }
        } catch { /* Unrecognized stderr/stdout is normalized by the transport boundary. */ }
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

/** Opt-in bounded read collector; existing callers retain their default behavior. */
function runStrictOpenClaw(args:string[],hardMs:number,bounds:{stdoutMaxBytes:number;stderrMaxBytes:number;killGraceMs:number}):Promise<any>{
  if(!Number.isFinite(hardMs)||hardMs<1||hardMs>30000||!Number.isSafeInteger(bounds.stdoutMaxBytes)||bounds.stdoutMaxBytes<256||bounds.stdoutMaxBytes>9*1024*1024||!Number.isSafeInteger(bounds.stderrMaxBytes)||bounds.stderrMaxBytes<256||bounds.stderrMaxBytes>128*1024||!Number.isSafeInteger(bounds.killGraceMs)||bounds.killGraceMs<1||bounds.killGraceMs>1000)return Promise.reject(new Error("gateway_read_limits_invalid"));
  return new Promise((resolve,reject)=>{
    const grouped=process.platform!=="win32";
    const child=spawn(process.env.CLAWMOBILE_OPENCLAW_BIN||"openclaw",args,{env:process.env,stdio:["ignore","pipe","pipe"],detached:grouped});
    const output:Buffer[]=[],errors:Buffer[]=[];let outBytes=0,errBytes=0,failed=false,settled=false,closed=false,cleanupDone=false,killTimer:ReturnType<typeof setTimeout>|undefined;
    const kill=(signal:NodeJS.Signals)=>{try{if(grouped&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{try{child.kill(signal);}catch{}}};
    const fail=()=>{if(failed||settled)return;failed=true;output.length=0;errors.length=0;kill("SIGTERM");killTimer=setTimeout(()=>{kill("SIGKILL");cleanupDone=true;if(closed&&!settled){settled=true;reject(new Error("gateway_read_failed"));}},bounds.killGraceMs);};
    const deadline=setTimeout(fail,hardMs);
    child.stdout.on("data",chunk=>{if(failed)return;outBytes+=chunk.length;if(outBytes>bounds.stdoutMaxBytes)fail();else output.push(Buffer.from(chunk));});
    child.stderr.on("data",chunk=>{if(failed)return;errBytes+=chunk.length;if(errBytes>bounds.stderrMaxBytes)fail();else errors.push(Buffer.from(chunk));});
    child.once("error",()=>{if(settled)return;settled=true;clearTimeout(deadline);if(killTimer)clearTimeout(killTimer);reject(new Error("gateway_read_failed"));});
    // Wait for physical close, including pipes, before releasing a pool slot.
    child.once("close",code=>{
      if(settled)return;closed=true;clearTimeout(deadline);if(failed){if(cleanupDone){settled=true;reject(new Error("gateway_read_failed"));}return;}settled=true;
      if(code!==0){reject(new Error("gateway_read_failed"));return;}
      try{resolve(parseJsonOutput(Buffer.concat(output).toString("utf8").trim()));}catch{reject(new Error("gateway_read_failed"));}
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

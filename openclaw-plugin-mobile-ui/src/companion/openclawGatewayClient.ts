import fs from "fs";
import net from "net";
import path from "path";
import { checkoutFile } from "../runtimeRoot";
import { spawn } from "child_process";
import { ensureLogsDir } from "../tools/workspace";
import type { GatewayStatus, RuntimeCommandResponse, RuntimeLogResponse } from "./types";

const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_RUNTIME_START_WAIT_MS = 180_000;
const DEFAULT_RUNTIME_STOP_WAIT_MS = 10_000;
// Graceful Gateway shutdown before SIGKILL. OpenClaw 2026.10.9 retires its plugins with 5 s
// timeouts each (S24 01/11); a SIGKILL after 750 ms left its spawn-broker workers and locks behind.
const DEFAULT_RUNTIME_STOP_GRACE_MS = 15_000;
const GATEWAY_OWNER_LEASE_TIMEOUT_MS = 3_000;
const GATEWAY_LOG_FILE = "companion-openclaw-gateway.log";
const GATEWAY_PID_FILE = "companion-openclaw-gateway.pid";
const TERMUX_PREFIX = "/data/data/com.termux/files/usr";
const TERMUX_TMPDIR = "/data/data/com.termux/files/usr/tmp";
const EXISTING_GATEWAY_GRACE_MS = 30_000;
const STARTUP_MAINTENANCE_REPAIR_ATTEMPTS = 2;
const STARTUP_MAINTENANCE_REPAIR_TIMEOUT_S = 60;
const STARTUP_MAINTENANCE_MARKERS = [
  "gateway.maintenance_required",
  "requires state migration",
  "sqlite-maintenance-unavailable",
] as const;

type StartInFlight = {
  startedAt: number;
  logPath: string;
  pid: number | null;
};

let startInFlight: StartInFlight | null = null;

type RuntimeOperationKind = "start" | "stop" | "restart";
type RuntimeOperationInFlight = {
  kind: RuntimeOperationKind;
  startedAt: number;
  promise: Promise<RuntimeCommandResponse>;
};

let runtimeOperationInFlight: RuntimeOperationInFlight | null = null;

class RuntimeRepairGuardError extends Error {}

// The --repair-lease protocol is versioned with this checkout, not with Tier0's
// current release: promotion happens after a deploy restart, and a Tier0 rollback
// may restore a release whose runtime_mode.py predates the lease. Both the deploy
// CLI and the Companion therefore use the helper shipped with this code; the lock
// path is unchanged. HTTP imports never receive the private CLI context or a deploy fd.
const deployRestartOwner = require.main===module && process.argv.length===4 &&
  process.argv[2]==="--deploy-restart" && path.isAbsolute(process.argv[3]) &&
  path.basename(process.argv[3])==="runtime_mode.py" ? process.argv[3] : null;
type RuntimeRepairLease = { release: () => Promise<void> };
async function acquireRuntimeRepairLease(): Promise<RuntimeRepairLease> {
  let helper: string;
  try { helper = deployRestartOwner || checkoutFile("runtime_mode.py"); }
  catch { throw new RuntimeRepairGuardError("runtime_guard_unavailable"); }
  // The owner retains the same open file description locked by Python. A
  // helper crash cannot release EX while a stop/start is still in progress.
  const openclawHome = process.env.OPENCLAW_HOME !== undefined
    ? process.env.OPENCLAW_HOME : process.env.HOME ? path.join(process.env.HOME, ".openclaw") : undefined;
  if (!openclawHome || !path.isAbsolute(openclawHome)) throw new RuntimeRepairGuardError("runtime_guard_unavailable");
  const lockPath = path.join(openclawHome, "deploys", "companion-deploy.lock");
  let lockFd: number;
  try {
    const directory=path.dirname(lockPath);
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const parent=fs.lstatSync(directory);
    if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o022)!==0)throw new Error("invalid_lock_parent");
    if(deployRestartOwner){
      const raw=process.env.SAMANTHA_DEPLOY_LOCK_FD||"";
      if(!/^[0-9]{1,4}$/.test(raw)||Number(raw)<3)throw new Error("missing_deploy_fd");
      lockFd=Number(raw);
    }else lockFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,0o600);
    const actual=fs.fstatSync(lockFd),current=fs.lstatSync(lockPath);
    if (!actual.isFile()||actual.uid!==process.getuid?.()||actual.nlink!==1||(actual.mode&0o022)!==0||
      !current.isFile()||current.ino!==actual.ino||current.dev!==actual.dev)throw new Error("invalid_lock");
  } catch {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    throw new RuntimeRepairGuardError("runtime_guard_unavailable");
  }
  const child = (() => {
    try {
      return spawn("python3", [helper, "--repair-lease",...(deployRestartOwner?["--require-existing-exclusive"]:[])],
        { env: { ...runtimeEnv(), SAMANTHA_DEPLOY_LOCK_FD: "3" }, stdio: ["pipe", "pipe", "ignore", lockFd] });
    } catch {
      fs.closeSync(lockFd);
      throw new RuntimeRepairGuardError("runtime_guard_unavailable");
    }
  })();
  child.stdin.on("error", () => {}); // A refused lease may exit before its stdin is closed.
  let exited = false;
  const closed = new Promise<void>(resolve => child.once("close", () => { exited = true; resolve(); }));
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false, received = "";
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new RuntimeRepairGuardError("runtime_guard_unavailable")), 3000);
      child.once("error", () => finish(new RuntimeRepairGuardError("runtime_guard_unavailable")));
      child.once("close", () => finish(new RuntimeRepairGuardError("runtime_guard_unavailable")));
      child.stdout.on("data", (data: Buffer) => {
        if (settled) return; // Drain subsequent output without retaining it.
        received += data.toString("utf8");
        if (received.length > 256) { finish(new RuntimeRepairGuardError("runtime_guard_unavailable")); return; }
        if (!received.includes("\n")) return;
        // Closed, exact protocol. Any refusal, additional field or malformed ACK refuses mutation.
        if (received !== '{"version":1,"state":"acquired"}\n') {
          const cause = ["lock_busy", "emergency_stop", "unavailable"].find(value =>
            received === `{"version":1,"state":"refused","cause":"${value}"}\n`);
          finish(new RuntimeRepairGuardError(cause ? `runtime_guard_${cause}` : "runtime_guard_unavailable")); return;
        }
        finish();
      });
    });
  } catch (error) {
    child.stdin.end(); child.kill("SIGKILL"); fs.closeSync(lockFd);
    throw error;
  }
  if (exited) { fs.closeSync(lockFd); throw new RuntimeRepairGuardError("runtime_guard_unavailable"); }
  return { release: async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    try { if (!exited) await closed; } finally { clearTimeout(timer); fs.closeSync(lockFd); }
  } };
}

export async function runSerializedRuntimeOperation(
  kind: RuntimeOperationKind,
  operation: () => Promise<RuntimeCommandResponse>,
  status: () => Promise<GatewayStatus> = () => getGatewayStatus(),
): Promise<RuntimeCommandResponse> {
  const current = runtimeOperationInFlight;
  if (current) {
    const gateway = await status();
    return {
      success: false,
      state: gateway.reachable ? "running" : "not_started",
      message: `OpenClaw runtime ${current.kind} is already in progress.`,
      gateway,
    };
  }

  const promise = Promise.resolve().then(async () => {
    let lease: RuntimeRepairLease;
    try { lease = await acquireRuntimeRepairLease(); }
    catch (error) {
      const gateway = await status();
      return { success: false, state: gateway.reachable ? "running" as const : "not_started" as const,
        message: error instanceof RuntimeRepairGuardError && error.message === "runtime_guard_lock_busy"
          ? "Runtime lock is held by another operation (deployment, repair or test campaign). No runtime change was performed."
          : error instanceof RuntimeRepairGuardError && error.message === "runtime_guard_emergency_stop"
            ? "The runtime emergency stop is active. No runtime change was performed."
            : "Runtime protection could not be verified. No runtime change was performed.", gateway };
    }
    try { return await operation(); } finally { await lease.release(); }
  });
  const owned: RuntimeOperationInFlight = {
    kind,
    startedAt: Date.now(),
    promise,
  };
  runtimeOperationInFlight = owned;
  try {
    return await promise;
  } finally {
    if (runtimeOperationInFlight === owned) runtimeOperationInFlight = null;
  }
}

export function gatewayHost() {
  return process.env.CLAWMOBILE_GATEWAY_HOST || DEFAULT_GATEWAY_HOST;
}

export function gatewayPort() {
  const raw = process.env.CLAWMOBILE_GATEWAY_PORT || process.env.GATEWAY_PORT || "";
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_GATEWAY_PORT;
}

export async function getGatewayStatus(timeoutMs = 500): Promise<GatewayStatus> {
  const host = gatewayHost();
  const port = gatewayPort();

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (reachable: boolean, message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, port, reachable, message });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, `OpenClaw gateway is reachable at ${host}:${port}.`));
    socket.once("timeout", () => finish(false, `OpenClaw gateway timed out at ${host}:${port}.`));
    socket.once("error", (error) => finish(false, `OpenClaw gateway is not reachable: ${error.message}`));
  });
}

export function runtimeLogNeedsMaintenance(text: string) {
  return STARTUP_MAINTENANCE_MARKERS.some((marker) => text.includes(marker));
}

type StartupMaintenanceRepair = {
  success: boolean;
  message: string;
};

type StartupMaintenanceRepairDeps = {
  gatewayReachable: () => Promise<boolean>;
  gatewayOwnerPids: () => Promise<number[]>;
  runDoctor: () => Promise<void>;
  wait: (ms: number) => Promise<void>;
};

export async function runBoundedStartupMaintenanceRepair(
  deps: StartupMaintenanceRepairDeps,
  attempts = STARTUP_MAINTENANCE_REPAIR_ATTEMPTS,
): Promise<StartupMaintenanceRepair> {
  let lastError = "";
  const boundedAttempts = Math.max(1, Math.min(attempts, STARTUP_MAINTENANCE_REPAIR_ATTEMPTS));

  for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
    if (await deps.gatewayReachable()) {
      return { success: true, message: "Gateway recovered before Doctor repair was needed." };
    }

    const ownerPids = await deps.gatewayOwnerPids();
    if (ownerPids.length > 0) {
      return {
        success: false,
        message: `Refusing Doctor repair while gateway process ownership is still present: ${ownerPids.join(",")}.`,
      };
    }

    try {
      await deps.runDoctor();
      return {
        success: true,
        message: `OpenClaw Doctor repair completed on attempt ${attempt}/${boundedAttempts}.`,
      };
    } catch (error: any) {
      lastError = String(error?.message || error);
      if (attempt < boundedAttempts) await deps.wait(2_000);
    }
  }

  return {
    success: false,
    message: `OpenClaw Doctor repair exhausted its bounded attempts: ${lastError}`,
  };
}

async function repairStartupMaintenance(): Promise<StartupMaintenanceRepair> {
  const openclaw =
    process.env.CLAWMOBILE_OPENCLAW_COMMAND || `${TERMUX_PREFIX}/bin/openclaw`;
  const timeout = `${TERMUX_PREFIX}/bin/timeout`;
  return runBoundedStartupMaintenanceRepair({
    gatewayReachable: async () => (await getGatewayStatus(750)).reachable,
    gatewayOwnerPids: async () => (await listOwnStateGatewayCandidates()).map((candidate) => candidate.pid),
    runDoctor: async () => {
      await runCommand(timeout, [
        String(STARTUP_MAINTENANCE_REPAIR_TIMEOUT_S),
        openclaw,
        "doctor",
        "--fix",
        "--non-interactive",
      ]);
    },
    wait: async (ms) => {
      await delay(ms);
    },
  });
}

export async function startRuntime(): Promise<RuntimeCommandResponse> {
  return runSerializedRuntimeOperation("start", () => startRuntimeInternal(true));
}

async function startRuntimeInternal(
  allowMaintenanceRepair: boolean,
): Promise<RuntimeCommandResponse> {
  const before = await getGatewayStatus();
  if (before.reachable) {
    return {
      success: true,
      state: "running",
      message: "OpenClaw gateway is already running.",
      gateway: before,
    };
  }

  if (startInFlight) {
    const currentStart = startInFlight;
    const stale =
      Date.now() - currentStart.startedAt >= runtimeStartWaitMs() ||
      (currentStart.pid !== null && !isProcessAlive(currentStart.pid));
    if (stale) {
      await clearTrackedStart(currentStart);
    }
  }

  if (startInFlight) {
    return {
      success: false,
      state: "not_started",
      message: `OpenClaw gateway start is already in progress. Logs: ${startInFlight.logPath}`,
      gateway: before,
    };
  }

  // A Gateway proven to run on another state directory (preprod rehearsal) is neither awaited nor killed.
  const existingGateways = await listOwnStateGatewayCandidates();
  if (existingGateways.length > 0) {
    const graceDeadline = Date.now() + EXISTING_GATEWAY_GRACE_MS;

    while (Date.now() < graceDeadline) {
      await delay(1_000);
      const status = await getGatewayStatus(750);
      if (status.reachable) {
        return {
          success: true,
          state: "running",
          message: "Existing OpenClaw gateway became reachable.",
          gateway: status,
        };
      }
    }

    for (const candidate of existingGateways) {
      killPidBestEffort(candidate.pid, "SIGTERM");
    }
    await delay(1_500);

    for (const candidate of await listOwnStateGatewayCandidates()) {
      killPidBestEffort(candidate.pid, "SIGKILL");
    }
    await delay(500);
  }

  const configuredCommand = process.env.CLAWMOBILE_RUNTIME_START_COMMAND || "";
  const command =
    configuredCommand || "/data/data/com.termux/files/usr/bin/openclaw";
  const args = process.env.CLAWMOBILE_RUNTIME_START_ARGS
    ? process.env.CLAWMOBILE_RUNTIME_START_ARGS.split(/\s+/).filter(Boolean)
    : configuredCommand
      ? []
      : [
          "gateway",
          "--bind",
          "loopback",
          "--port",
          String(gatewayPort()),
          "--verbose",
        ];

  let childExited = false;
  let childExitCode: number | null = null;

  try {
    const logPath = gatewayLogPath();
    let out: number | null = null;
    try {
      fs.writeFileSync(logPath, `--- OpenClaw gateway start ${new Date().toISOString()} ---\n`);
      out = fs.openSync(logPath, "a");
      const child = spawn(command, args, {
        detached: true,
        stdio: ["ignore", out, out],
        env: runtimeEnv(),
      });
      if (child.pid) {
        fs.writeFileSync(gatewayPidPath(), `${child.pid}\n`);
      }
      const trackedStart: StartInFlight = {
        startedAt: Date.now(),
        logPath,
        pid: child.pid ?? null,
      };
      startInFlight = trackedStart;
      child.once("exit", (code) => {
        childExited = true;
        childExitCode = code;
        if (startInFlight === trackedStart) startInFlight = null;
      });
      child.once("error", () => {
        if (startInFlight === trackedStart) startInFlight = null;
      });
      child.unref();
    } finally {
      if (out !== null) fs.closeSync(out);
    }

    const deadline = Date.now() + runtimeStartWaitMs();
    while (Date.now() < deadline) {
      await delay(500);
      const status = await getGatewayStatus();
      if (status.reachable) {
        startInFlight = null;
        return {
          success: true,
          state: "running",
          message: `Started OpenClaw gateway. Logs: ${logPath}`,
          gateway: status,
        };
      }

      if (childExited) {
        await delay(100);
        cleanupGatewayPidFile();
        const failedLog = getRuntimeLog();
        if (allowMaintenanceRepair && runtimeLogNeedsMaintenance(failedLog.text)) {
          const maintenance = await repairStartupMaintenance();
          if (!maintenance.success) {
            return {
              success: false,
              state: "failed",
              message: `${maintenance.message} Gateway log: ${logPath}`,
              gateway: status,
            };
          }
          return startRuntimeInternal(false);
        }

        return {
          success: false,
          state: "failed",
          message: `OpenClaw gateway start exited before readiness (code ${childExitCode ?? "unknown"}). Logs: ${logPath}`,
          gateway: status,
        };
      }
    }

    const after = await getGatewayStatus();
    const timedOutStart = startInFlight;
    if (timedOutStart) {
      await clearTrackedStart(timedOutStart);
    } else {
      cleanupGatewayPidFile();
    }
    return {
      success: false,
      state: "not_started",
      message: `OpenClaw gateway start timed out and the tracked start process was cleaned up. Logs: ${logPath}`,
      gateway: after,
    };
  } catch (error: any) {
    const after = await getGatewayStatus();
    startInFlight = null;
    cleanupGatewayPidFile();
    return {
      success: false,
      state: "failed",
      message: `Unable to start OpenClaw gateway: ${error?.message || error}`,
      gateway: after,
    };
  }
}

export function getRuntimeLog(maxBytes = 64 * 1024): RuntimeLogResponse {
  const logPath = gatewayLogPath();
  if (!fs.existsSync(logPath)) {
    return {
      success: false,
      message: "Gateway log is not available yet. Start Runtime to create it.",
      path: logPath,
      text: "",
      exists: false,
      size: 0,
      truncated: false,
    };
  }

  const stat = fs.statSync(logPath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(logPath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  return {
    success: true,
    message: start > 0 ? `Showing last ${length} bytes of gateway log.` : "Gateway log loaded.",
    path: logPath,
    text: buffer.toString("utf8"),
    exists: true,
    size: stat.size,
    truncated: start > 0,
    updatedAt: stat.mtimeMs,
  };
}

export async function stopRuntime(): Promise<RuntimeCommandResponse> {
  return runSerializedRuntimeOperation("stop", () => stopRuntimeInternal());
}

async function stopRuntimeInternal(): Promise<RuntimeCommandResponse> {
  const before = await getGatewayStatus();
  if (!before.reachable) {
    if (startInFlight) {
      await clearTrackedStart(startInFlight);
    } else {
      cleanupGatewayPidFile();
    }
    return {
      success: true,
      state: "not_started",
      message: "OpenClaw gateway is stopped and any pending tracked start was cleared.",
      gateway: before,
    };
  }

  try {
    const stop = await stopGatewayProcess();
    // Nothing was signalled: waiting the stop budget would only delay the same verdict.
    const after = stop.targets === 0 && !stop.custom ? await getGatewayStatus() : await waitForGatewayStopped();
    if (!after.reachable) cleanupGatewayPidFile();
    // Pids and counts only: never a command line or an environment value.
    const detail = stop.custom ? "" : ` Targets: ${stop.targets} (adopted ${stop.adopted}); descendants stopped: ${stop.descendants}.`;
    return {
      success: !after.reachable,
      state: after.reachable ? "running" : "not_started",
      message: after.reachable
        ? stop.targets === 0 && !stop.custom
          ? `Stop command ran, but OpenClaw gateway is still reachable: no Gateway process of this state directory was found to stop.${detail}`
          : `Stop command ran, but OpenClaw gateway is still reachable.${detail}`
        : `OpenClaw gateway stopped.${detail}`,
      gateway: after,
    };
  } catch (error: any) {
    const after = await getGatewayStatus();
    return {
      success: false,
      state: after.reachable ? "running" : "failed",
      message: `Unable to stop OpenClaw gateway: ${error?.message || error}`,
      gateway: after,
    };
  }
}

export async function restartRuntime(): Promise<RuntimeCommandResponse> {
  return runSerializedRuntimeOperation("restart", async () => {
    const stopped = await stopRuntimeInternal();
    if (!stopped.success) {
      return {
        success: false,
        state: stopped.state,
        message: `Unable to restart runtime: ${stopped.message}`,
        gateway: stopped.gateway,
      };
    }

    const started = await startRuntimeInternal(true);
    if(deployRestartOwner && started.success && started.gateway.reachable) {
      // Only this short-lived CLI owns this socket. Keep the same EX repair
      // lease until the existing SDK metadata warm finishes, never use or
      // close the Companion's shared client. No user/model turn or retry.
      const preparation=await prepareMainToolCatalog();
      process.stderr.write(JSON.stringify({component:"runtime-preparation",service_state:"started",...preparation})+"\n");
    }
    return {
      ...started,
      message: started.success
        ? `Restarted OpenClaw gateway. ${stopped.message} ${started.message}`
        : `Gateway stopped, but restart failed: ${stopped.message} ${started.message}`,
    };
  });
}

type StopOutcome = { custom: boolean; targets: number; adopted: number; descendants: number };

async function stopGatewayProcess(): Promise<StopOutcome> {
  const command = process.env.CLAWMOBILE_RUNTIME_STOP_COMMAND || "";
  if (command) {
    await runCommand(command, []);
    return { custom: true, targets: 0, adopted: 0, descendants: 0 };
  }

  const pid = readGatewayPid();
  const processes = await listProcesses();
  const candidates = processes.filter(isGatewayProcessCandidate);
  const adopted = await adoptableGatewayPids(candidates);
  const targets = selectGatewayStopTargets(candidates, pid, adopted);
  if (targets.length === 0) return { custom: false, targets: 0, adopted: 0, descendants: 0 };
  const identity = new Map<number, number | null>();
  for (const candidate of targets) identity.set(candidate.pid, processStartTime(candidate.pid));
  // Workers the Gateway spawned (spawn-broker, sqlite readers, esbuild): snapshot them with their start
  // time now, so only these very processes are stopped later, never a reused pid.
  const tree = new Map<number, number | null>();
  for (const child of descendantPids(processes, new Set(targets.map((candidate) => candidate.pid)))) {
    tree.set(child, processStartTime(child));
  }

  for (const candidate of targets) killPidBestEffort(candidate.pid, "SIGTERM");
  const alive = () => targets.filter((candidate) => sameProcess(candidate.pid, identity.get(candidate.pid) ?? null));
  const deadline = Date.now() + runtimeStopGraceMs();
  await delay(250);
  while (Date.now() < deadline && (alive().length > 0 || (await getGatewayStatus(300)).reachable)) {
    await delay(250);
  }
  for (const candidate of alive()) killPidBestEffort(candidate.pid, "SIGKILL");

  let descendants = 0;
  const leftover = () => [...tree.entries()].filter(([child, started]) => started !== null && sameProcess(child, started));
  for (const [child] of leftover()) { killPidBestEffort(child, "SIGTERM"); descendants++; }
  if (descendants > 0) {
    await delay(1_000);
    for (const [child] of leftover()) killPidBestEffort(child, "SIGKILL");
  }
  return {
    custom: false,
    targets: targets.length,
    adopted: targets.filter((candidate) => adopted.has(candidate.pid)).length,
    descendants,
  };
}

async function waitForGatewayStopped() {
  const deadline = Date.now() + runtimeStopWaitMs();
  let status = await getGatewayStatus();
  while (status.reachable && Date.now() < deadline) {
    await delay(500);
    status = await getGatewayStatus();
  }
  return status;
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", env: runtimeEnv() });
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.once("error", reject);
  });
}

export type ProcessCandidate = {
  pid: number;
  ppid: number;
  command: string;
};

async function listProcesses(): Promise<ProcessCandidate[]> {
  const output = await captureCommand("ps", ["-ef"]).catch(() => "");
  return parseProcessTable(output);
}

/** `ps -ef` rows: UID PID PPID C STIME TTY TIME CMD. */
export function parseProcessTable(output: string): ProcessCandidate[] {
  return output
    .split(/\r?\n/)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) return null;
      const pid = Number.parseInt(parts[1] || "", 10);
      const ppid = Number.parseInt(parts[2] || "", 10);
      const command = parts.slice(7).join(" ");
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
      return { pid, ppid, command };
    })
    .filter((candidate): candidate is ProcessCandidate => candidate != null);
}

function isGatewayProcessCandidate(candidate: ProcessCandidate) {
  return isGatewayRuntimeCommand(candidate.command) && !candidate.command.includes("companion/server.js");
}

/** Gateway processes and wrappers, minus those whose environment proves another state directory. */
async function listOwnStateGatewayCandidates(): Promise<ProcessCandidate[]> {
  const candidates = (await listProcesses()).filter(isGatewayProcessCandidate);
  const own = canonicalPath(gatewayStateDir(process.env));
  if (!own) return candidates;
  return candidates.filter((candidate) => {
    const env = readProcessEnvironment(candidate.pid);
    const state = env ? canonicalPath(gatewayStateDir(env)) : null;
    return state === null || state === own;
  });
}

export function selectGatewayStopTargets(
  candidates: ProcessCandidate[],
  recordedPid: number | null,
  adopted: ReadonlySet<number> = new Set(),
  ownPid: number = process.pid,
) {
  const selected = new Map<number, ProcessCandidate>();
  for (const candidate of candidates) {
    const launchedByCompanion = candidate.ppid === ownPid;
    const isRecordedProcess = recordedPid != null && candidate.pid === recordedPid;
    const isRecordedChild = recordedPid != null && candidate.ppid === recordedPid;
    // A Gateway this process did not launch (openclaw-upgrade, gateway-start.sh by hand, a previous
    // Companion): S24 01/11, the 2026.10.9 Gateway started by the switch (ppid 1, no pidfile) was
    // never stopped and every deploy restart failed. Adoption is decided by adoptableGatewayPids.
    if (launchedByCompanion || isRecordedProcess || isRecordedChild || adopted.has(candidate.pid)) {
      selected.set(candidate.pid, candidate);
    }
  }
  return [...selected.values()];
}

/** The Gateway server process itself, never its shell wrappers (gateway-start.sh, run.sh) nor a CLI
 * subcommand such as `openclaw gateway status`: the 2026.10.9 title `openclaw-gateway`, or
 * `openclaw[.mjs] gateway` followed by options only (foreground run, no respawn in 2026.10.9). */
export function isGatewayServiceCommand(command: string) {
  if (!isGatewayRuntimeCommand(command)) return false;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.some((token) => /(?:^|\/)openclaw-gateway$/.test(token))) return true;
  const openclawIndex = tokens.findIndex((token) => /(?:^|\/)(?:openclaw|openclaw\.mjs)$/.test(token));
  if (openclawIndex < 0 || tokens[openclawIndex + 1] !== "gateway") return false;
  const next = tokens[openclawIndex + 2];
  return next === undefined || next === "run" || next.startsWith("-");
}

export type GatewayAdoptionEvidence = {
  leasePid: number | null;
  ownStateDir: string;
  stateDirOf: (pid: number) => string | null;
};

/** Same identity as openclaw-upgrade's gateway_pids(): OpenClaw's own gateway-owner lease, or the Gateway
 * process running on this state directory. A preprod Gateway (other state directory) is never adopted. */
export function selectAdoptableGateways(candidates: ProcessCandidate[], evidence: GatewayAdoptionEvidence) {
  const adopted = new Set<number>();
  for (const candidate of candidates) {
    if (!isGatewayServiceCommand(candidate.command)) continue;
    if (evidence.leasePid !== null && candidate.pid === evidence.leasePid) { adopted.add(candidate.pid); continue; }
    const state = evidence.stateDirOf(candidate.pid);
    if (state !== null && state === evidence.ownStateDir) adopted.add(candidate.pid);
  }
  return adopted;
}

async function adoptableGatewayPids(candidates: ProcessCandidate[]): Promise<Set<number>> {
  if (!candidates.some((candidate) => isGatewayServiceCommand(candidate.command))) return new Set();
  const ownStateDir = canonicalPath(gatewayStateDir(process.env));
  if (!ownStateDir) return new Set();
  return selectAdoptableGateways(candidates, {
    leasePid: await readGatewayOwnerLeasePid(ownStateDir),
    ownStateDir,
    stateDirOf: (pid) => {
      const env = readProcessEnvironment(pid);
      return env ? canonicalPath(gatewayStateDir(env)) : null;
    },
  });
}

function gatewayStateDir(env: NodeJS.ProcessEnv | Record<string, string>) {
  if (env.OPENCLAW_STATE_DIR) return env.OPENCLAW_STATE_DIR;
  return env.HOME ? path.join(env.HOME, ".openclaw") : "";
}

function canonicalPath(value: string) {
  if (!value || !path.isAbsolute(value)) return null;
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function readProcessEnvironment(pid: number): Record<string, string> | null {
  try {
    const out: Record<string, string> = {};
    for (const item of fs.readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0")) {
      const index = item.indexOf("=");
      if (index > 0) out[item.slice(0, index)] = item.slice(index + 1);
    }
    return out;
  } catch {
    return null;
  }
}

/** OpenClaw's record of the live Gateway (state_leases/gateway-owner), read through the checkout's helper. */
function readGatewayOwnerLeasePid(stateDir: string): Promise<number | null> {
  let helper: string;
  try { helper = deployRestartOwner || checkoutFile("runtime_mode.py"); } catch { return Promise.resolve(null); }
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (pid: number | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(pid); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("python3", [helper, "--gateway-owner-pid", stateDir], { stdio: ["ignore", "pipe", "ignore"], env: runtimeEnv() });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, GATEWAY_OWNER_LEASE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => { if (out.length < 256) out += String(chunk); });
    child.once("error", () => finish(null));
    child.once("close", () => {
      try {
        const pid = JSON.parse(out.trim()).pid;
        finish(Number.isInteger(pid) && pid > 1 ? pid : null);
      } catch { finish(null); }
    });
  });
}

export function descendantPids(processes: ProcessCandidate[], roots: ReadonlySet<number>) {
  const out = new Set<number>(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of processes) {
      if (out.has(row.ppid) && !out.has(row.pid)) { out.add(row.pid); changed = true; }
    }
  }
  for (const root of roots) out.delete(root);
  return [...out];
}

function processStartTime(pid: number): number | null {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const value = Number.parseInt(fields[19] || "", 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Alive (a zombie awaiting its parent counts as gone) and, when its start time is known, still the very
 * process observed earlier. */
function sameProcess(pid: number, startedAt: number | null) {
  if (!isProcessAlive(pid)) return false;
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    if (text.slice(text.lastIndexOf(")") + 2).startsWith("Z")) return false;
  } catch {
    // No procfs entry readable: rely on the signal probe and start time below.
  }
  return startedAt === null || processStartTime(pid) === startedAt;
}

export function isGatewayRuntimeCommand(command: string) {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  const shellIndex = tokens.findIndex((token) => /(?:^|\/)(?:bash|sh|zsh)$/.test(token));
  if (shellIndex >= 0) {
    const shellArgs = tokens.slice(shellIndex + 1, shellIndex + 6);
    if (shellArgs.includes("-c") || shellArgs.includes("-lc") || shellArgs.includes("-cl")) {
      return false;
    }
  }

  if (tokens.some((token) => /(?:^|\/)openclaw-gateway$/.test(token))) return true;

  const openclawIndex = tokens.findIndex((token) =>
    /(?:^|\/)(?:openclaw|openclaw\.mjs)$/.test(token),
  );
  if (openclawIndex >= 0 && tokens.slice(openclawIndex + 1, openclawIndex + 6).includes("gateway")) {
    return true;
  }

  return tokens.some((token) => /(?:^|\/)(?:gateway-start|run)\.sh$/.test(token));
}

function captureCommand(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: runtimeEnv() });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `${command} exited ${code}`))));
    child.once("error", reject);
  });
}

function killPidBestEffort(pid: number, signal: NodeJS.Signals) {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Best effort. The process may have already exited.
  }
}

function isProcessAlive(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function clearTrackedStart(current: StartInFlight) {
  if (current.pid !== null && isProcessAlive(current.pid)) {
    killPidBestEffort(current.pid, "SIGTERM");
    await delay(750);
    if (isProcessAlive(current.pid)) {
      killPidBestEffort(current.pid, "SIGKILL");
      await delay(250);
    }
  }
  if (startInFlight === current) {
    startInFlight = null;
  }
  cleanupGatewayPidFile();
}

function readGatewayPid() {
  try {
    const raw = fs.readFileSync(gatewayPidPath(), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function cleanupGatewayPidFile() {
  try {
    fs.unlinkSync(gatewayPidPath());
  } catch {
    // Nothing to clean.
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME || "/data/data/com.termux/files/home";
  const currentPath = process.env.PATH || "";
  const requiredPath = [
    `${home}/.openclaw-android/bin`,
    `${home}/.openclaw-android/node/bin`,
    `${TERMUX_PREFIX}/bin`,
  ].join(":");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PREFIX: process.env.PREFIX || TERMUX_PREFIX,
    TMPDIR: process.env.TMPDIR || TERMUX_TMPDIR,
    PATH: currentPath ? `${requiredPath}:${currentPath}` : requiredPath,
  };
  // A deploy lock fd number is private to the process that inherited it (deploy
  // --deploy-restart). The relaunched Gateway and other runtime children must never
  // read it as their own authority; the lease helper sets its own value explicitly.
  delete env.SAMANTHA_DEPLOY_LOCK_FD;
  return env;
}

function runtimeStartWaitMs() {
  const raw = Number.parseInt(process.env.CLAWMOBILE_RUNTIME_START_WAIT_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RUNTIME_START_WAIT_MS;
}

function runtimeStopGraceMs() {
  const raw = Number.parseInt(process.env.CLAWMOBILE_RUNTIME_STOP_GRACE_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RUNTIME_STOP_GRACE_MS;
}

function runtimeStopWaitMs() {
  const raw = Number.parseInt(process.env.CLAWMOBILE_RUNTIME_STOP_WAIT_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RUNTIME_STOP_WAIT_MS;
}

function gatewayLogPath() {
  return path.join(ensureLogsDir(), GATEWAY_LOG_FILE);
}

function gatewayPidPath() {
  return path.join(ensureLogsDir(), GATEWAY_PID_FILE);
}

/** Metadata preparation belongs to the existing Gateway startup lifecycle, never a user/model turn. */
export const MAIN_TOOLS_PREPARE_BUDGET_MS=20_000;
type CatalogReader=(method:string,params:Record<string,unknown>,options:{timeoutMs:number;hardTimeoutMs:number})=>Promise<any>;
export async function prepareMainToolCatalog(reader?:CatalogReader,clock:()=>number=()=>performance.now()) {
  const started=clock();let close:(()=>void)|undefined;
  const elapsed=()=>Math.max(0,Math.round(clock()-started));
  const unverified=(reason:string)=>({state:"unverified",agentId:"main",elapsed_ms:elapsed(),
    budget_ms:MAIN_TOOLS_PREPARE_BUDGET_MS,reason});
  try {
    if(!reader) {
      // Public, version-pinned SDK adapter and transport already own config/auth/connection/fallback policy.
      // This default is used only by the short-lived private CLI action; its own socket is then closed.
      const owner=await import("./openclawAgentClient");reader=owner.callOpenClawGateway;close=owner.closeOpenClawGateway;
    }
    const result=await reader("tools.catalog",{agentId:"main",includePlugins:true},
      {timeoutMs:MAIN_TOOLS_PREPARE_BUDGET_MS,hardTimeoutMs:MAIN_TOOLS_PREPARE_BUDGET_MS});
    if(elapsed()>MAIN_TOOLS_PREPARE_BUDGET_MS)return unverified("tools_catalog_budget_exceeded");
    if(!result||result.agentId!=="main"||!Array.isArray(result.groups)||result.groups.length>256)
      return unverified("tools_catalog_invalid");
    let tools=0;
    for(const group of result.groups) {
      if(!group||!Array.isArray(group.tools)||group.tools.length>4096)return unverified("tools_catalog_invalid");
      tools+=group.tools.length;if(tools>4096)return unverified("tools_catalog_invalid");
    }
    // Never copy descriptions, schemas, tool arguments, prompt text or arbitrary SDK fields to logs/user surfaces.
    return {state:"ready",agentId:"main",elapsed_ms:elapsed(),budget_ms:MAIN_TOOLS_PREPARE_BUDGET_MS,
      groups:result.groups.length,tools};
  } catch {return unverified("tools_catalog_unavailable");}
  finally {close?.();}
}

// Fixed private deploy action; no public tool, HTTP option or caller command.
if(require.main===module){
  if(process.argv.length===3&&process.argv[2]==="--prepare-main-tools") {
    void prepareMainToolCatalog().then(result=>{
      process.stdout.write(JSON.stringify(result)+"\n");if(result.state!=="ready")process.exitCode=75;
    }).catch(()=>{process.stdout.write('{"state":"unverified","reason":"tools_catalog_unavailable"}\n');process.exitCode=75;});
  }
  else if(!deployRestartOwner){process.stdout.write('{"success":false}\n');process.exitCode=2;}
  else void restartRuntime().then(result=>{
    // The deploy log keeps why a restart failed (S24 01/11: the receipt only said gateway_restart_failed).
    // Owner messages carry pids, counts and log paths only.
    process.stderr.write(JSON.stringify({component:"runtime-restart",success:result.success,state:result.state,
      message:String(result.message||"").slice(0,600)})+"\n");
    process.stdout.write(JSON.stringify({success:result.success})+"\n");
    if(!result.success)process.exitCode=75;
  }).catch(()=>{process.stdout.write('{"success":false}\n');process.exitCode=75;});
}

import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import { ensureLogsDir } from "../tools/workspace";
import type { GatewayStatus, RuntimeCommandResponse, RuntimeLogResponse } from "./types";

const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_RUNTIME_START_WAIT_MS = 180_000;
const DEFAULT_RUNTIME_STOP_WAIT_MS = 10_000;
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

type RuntimeRepairLease = { release: () => Promise<void> };
async function acquireRuntimeRepairLease(): Promise<RuntimeRepairLease> {
  const root = process.env.CLAW_RUNTIME_ROOT;
  if (!root || !path.isAbsolute(root)) throw new RuntimeRepairGuardError("runtime_guard_unavailable");
  // The owner retains the same open file description locked by Python. A
  // helper crash cannot release EX while a stop/start is still in progress.
  const openclawHome = process.env.OPENCLAW_HOME !== undefined
    ? process.env.OPENCLAW_HOME : process.env.HOME ? path.join(process.env.HOME, ".openclaw") : undefined;
  if (!openclawHome || !path.isAbsolute(openclawHome)) throw new RuntimeRepairGuardError("runtime_guard_unavailable");
  const lockPath = path.join(openclawHome, "deploys", "companion-deploy.lock");
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(lockFd).isFile()) throw new Error("invalid_lock");
  } catch {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    throw new RuntimeRepairGuardError("runtime_guard_unavailable");
  }
  const child = (() => {
    try {
      return spawn("python3", [path.join(root, "runtime_mode.py"), "--repair-lease"],
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
    gatewayOwnerPids: async () => (await listGatewayProcessCandidates()).map((candidate) => candidate.pid),
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

  const existingGateways = await listGatewayProcessCandidates();
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

    for (const candidate of await listGatewayProcessCandidates()) {
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
    await stopGatewayProcess();
    const after = await waitForGatewayStopped();
    if (!after.reachable) cleanupGatewayPidFile();
    return {
      success: !after.reachable,
      state: after.reachable ? "running" : "not_started",
      message: after.reachable ? "Stop command ran, but OpenClaw gateway is still reachable." : "OpenClaw gateway stopped.",
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
    return {
      ...started,
      message: started.success
        ? `Restarted OpenClaw gateway. ${started.message}`
        : `Gateway stopped, but restart failed: ${started.message}`,
    };
  });
}

async function stopGatewayProcess() {
  const command = process.env.CLAWMOBILE_RUNTIME_STOP_COMMAND || "";
  if (command) {
    await runCommand(command, []);
    return;
  }

  const pid = readGatewayPid();
  const candidates = await listGatewayProcessCandidates();
  const targets = selectGatewayStopTargets(candidates, pid);
  for (const candidate of targets) {
    killPidBestEffort(candidate.pid, "SIGTERM");
  }

  await delay(750);
  const stillReachable = await getGatewayStatus(300);
  if (!stillReachable.reachable) return;

  const remaining = selectGatewayStopTargets(await listGatewayProcessCandidates(), pid);
  for (const candidate of remaining) {
    killPidBestEffort(candidate.pid, "SIGKILL");
  }
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

type ProcessCandidate = {
  pid: number;
  ppid: number;
  command: string;
};

async function listGatewayProcessCandidates(): Promise<ProcessCandidate[]> {
  const output = await captureCommand("ps", ["-ef"]).catch(() => "");
  return output
    .split(/\r?\n/)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) return null;
      const pid = Number.parseInt(parts[1] || "", 10);
      const ppid = Number.parseInt(parts[2] || "", 10);
      const command = parts.slice(7).join(" ");
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
      if (!isGatewayRuntimeCommand(command)) return null;
      if (command.includes("companion/server.js")) return null;
      return { pid, ppid, command };
    })
    .filter((candidate): candidate is ProcessCandidate => candidate != null);
}

function selectGatewayStopTargets(candidates: ProcessCandidate[], recordedPid: number | null) {
  const selected = new Map<number, ProcessCandidate>();
  for (const candidate of candidates) {
    const launchedByCompanion = candidate.ppid === process.pid;
    const isRecordedProcess = recordedPid != null && candidate.pid === recordedPid;
    const isRecordedChild = recordedPid != null && candidate.ppid === recordedPid;
    if (launchedByCompanion || isRecordedProcess || isRecordedChild) {
      selected.set(candidate.pid, candidate);
    }
  }
  return [...selected.values()];
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

  return {
    ...process.env,
    HOME: home,
    PREFIX: process.env.PREFIX || TERMUX_PREFIX,
    TMPDIR: process.env.TMPDIR || TERMUX_TMPDIR,
    PATH: currentPath ? `${requiredPath}:${currentPath}` : requiredPath,
  };
}

function runtimeStartWaitMs() {
  const raw = Number.parseInt(process.env.CLAWMOBILE_RUNTIME_START_WAIT_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RUNTIME_START_WAIT_MS;
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

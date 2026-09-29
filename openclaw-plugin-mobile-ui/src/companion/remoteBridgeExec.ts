import { execFile, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const ROOT = process.env.CLAWMOBILE_REMOTE_BRIDGE_DIR || path.join(os.homedir(), ".openclaw", "remote-bridge");
const PROCESS_DIR = path.join(ROOT, "processes");
const MAX_COMMAND_CHARS = 32 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;

type BridgeProcess = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  outputPath: string;
  startedAt: number;
  command: string;
  cwd: string;
};

const processes = new Map<string, BridgeProcess>();

function ensureDir() {
  fs.mkdirSync(PROCESS_DIR, { recursive: true, mode: 0o700 });
}

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}function resolveCwd(value: unknown) {
  const raw = String(value || "").trim();
  const resolved = path.resolve(raw || os.homedir());
  const roots = [os.homedir(), process.env.PREFIX || "", "/sdcard", "/storage/emulated/0", "/data/local/tmp"]
    .filter(Boolean)
    .filter((root) => fs.existsSync(root))
    .map((root) => path.resolve(root));
  if (!roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error("cwd_not_allowed");
  }
  if (!fs.existsSync(resolved)) throw new Error("cwd_not_found");
  return resolved;
}

export async function runExecWait(params: Record<string, unknown>) {
  const command = String(params.command || "").trim();
  if (!command) throw new Error("empty_command");
  if (command.length > MAX_COMMAND_CHARS) throw new Error("command_too_long");
  const cwd = resolveCwd(params.cwd);
  const timeoutMs = boundedInt(params.timeoutMs, 30_000, 100, 300_000);
  const shell = process.env.SHELL || "bash";
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    execFile(shell, ["-lc", command], {
      cwd,
      env: process.env,
      timeout: timeoutMs,
      maxBuffer: MAX_EXEC_OUTPUT_BYTES,
    }, (error: any, stdout = "", stderr = "") => {      resolve({
        success: !error,
        command,
        cwd,
        exitCode: typeof error?.code === "number" ? error.code : 0,
        signal: error?.signal || null,
        timedOut: Boolean(error?.killed) || error?.signal === "SIGTERM",
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
  });
}

export function startBridgeProcess(params: Record<string, unknown>) {
  ensureDir();
  const command = String(params.command || "").trim();
  if (!command) throw new Error("empty_command");
  if (command.length > MAX_COMMAND_CHARS) throw new Error("command_too_long");
  const cwd = resolveCwd(params.cwd);
  const id = `proc-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const outputPath = path.join(PROCESS_DIR, `${id}.log`);
  const shell = process.env.SHELL || "bash";
  const child = spawn(shell, ["-lc", command], {
    cwd,
    env: process.env,
    stdio: "pipe",
  });  const entry: BridgeProcess = {
    id,
    child,
    outputPath,
    startedAt: Date.now(),
    command,
    cwd,
  };
  processes.set(id, entry);
  fs.writeFileSync(outputPath, "");
  writeMeta(entry, { state: "running", pid: child.pid });

  const append = (chunk: Buffer | string) => {
    fs.appendFileSync(outputPath, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("close", (code, signal) => {
    writeMeta(entry, {
      state: "completed",
      pid: child.pid,
      exitCode: typeof code === "number" ? code : null,
      signal: signal || null,
      completedAt: Date.now(),
    });
    processes.delete(id);
  });  child.once("error", (error) => {
    append(`\n[process error] ${error.message}\n`);
    writeMeta(entry, {
      state: "failed",
      pid: child.pid,
      error: error.message,
      completedAt: Date.now(),
    });
    processes.delete(id);
  });

  return {
    processId: id,
    pid: child.pid,
    cwd,
    startedAt: entry.startedAt,
  };
}

export function bridgeProcessStatus(params: Record<string, unknown>) {
  ensureDir();
  const processId = validateProcessId(String(params.processId || ""));
  const metaPath = path.join(PROCESS_DIR, `${processId}.json`);
  if (!fs.existsSync(metaPath)) throw new Error("process_not_found");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const outputPath = path.join(PROCESS_DIR, `${processId}.log`);
  const buffer = fs.existsSync(outputPath) ? fs.readFileSync(outputPath) : Buffer.alloc(0);  const offset = Math.max(0, Number(params.offset || 0));
  const maxBytes = boundedInt(params.maxBytes, 32 * 1024, 1, 128 * 1024);
  const chunk = buffer.subarray(offset, Math.min(buffer.length, offset + maxBytes));
  return {
    ...meta,
    outputOffset: offset,
    nextOffset: offset + chunk.length,
    outputBytes: buffer.length,
    output: chunk.toString("utf8"),
  };
}

export function bridgeProcessInput(params: Record<string, unknown>) {
  const processId = validateProcessId(String(params.processId || ""));
  const entry = processes.get(processId);
  if (!entry || entry.child.stdin.destroyed) {
    throw new Error("process_input_unavailable");
  }
  const input = String(params.input ?? "");
  if (Buffer.byteLength(input) > 64 * 1024) {
    throw new Error("process_input_too_large");
  }
  entry.child.stdin.write(input);
  return { processId, acceptedBytes: Buffer.byteLength(input) };
}export function bridgeProcessStop(params: Record<string, unknown>) {
  const processId = validateProcessId(String(params.processId || ""));
  const entry = processes.get(processId);
  if (!entry) throw new Error("process_not_owned_by_current_instance");
  entry.child.kill("SIGTERM");
  return { processId, signal: "SIGTERM", requested: true };
}

function validateProcessId(value: string) {
  if (!/^proc-[A-Za-z0-9-]{1,96}$/.test(value)) {
    throw new Error("invalid_process_id");
  }
  return value;
}

function writeMeta(entry: BridgeProcess, state: Record<string, unknown>) {
  const value = {
    processId: entry.id,
    command: entry.command,
    cwd: entry.cwd,
    startedAt: entry.startedAt,
    ...state,
  };
  const finalPath = path.join(PROCESS_DIR, `${entry.id}.json`);
  const tempPath = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, finalPath);
}

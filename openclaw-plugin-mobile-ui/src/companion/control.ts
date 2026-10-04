import { execFile, spawn } from "child_process";
import type { IncomingMessage, ServerResponse } from "http";
import os from "os";
import path from "path";
import readline from "readline";

const sections = new Set(["snapshot", "activity", "requests", "automations", "intelligence", "health", "situations"]);
let activeStreams = 0;

export function controlPaths() {
  return {
    playbooks: process.env.SAMANTHA_CONTROL_PLAYBOOKS || path.join(os.homedir(), ".openclaw/workspace/ui-playbooks"),
    live: process.env.SAMANTHA_CONTROL_LIVE || path.join(os.homedir(), "ClawMobile/installer/termux-lite/claw-live.py"),
  };
}

export function readControl(section: string, signal?: AbortSignal): Promise<unknown> {
  if (!sections.has(section)) return Promise.reject(new Error("unsupported_control_section"));
  const roots = controlPaths();
  return new Promise((resolve, reject) => {
    execFile("python3", ["-m", "reporting.control_snapshot", "--section", section], {
      cwd: roots.playbooks, env: { ...process.env, SAMANTHA_CONTROL_LIVE: roots.live },
      timeout: 6500, maxBuffer: 1024 * 1024, signal,
    }, (error, stdout) => {
      if (error) return reject(new Error("control_unavailable"));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("control_invalid_response")); }
    });
  });
}

export function streamControl(req: IncomingMessage, res: ServerResponse) {
  if (activeStreams >= 2) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "control_stream_busy" }));
    return;
  }
  const child = spawn("python3", ["-u", controlPaths().live, "--control-json"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  activeStreams++;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    activeStreams--;
    clearInterval(heartbeat);
    lines.close();
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
    const kill = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
    }, 2500);
    kill.unref();
    if (!res.writableEnded) res.end();
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
    "Connection": "keep-alive", "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const lines = readline.createInterface({ input: child.stdout });
  const heartbeat = setInterval(() => {
    if (!res.write(": keep-alive\n\n")) close();
  }, 10000);
  heartbeat.unref();
  let count = 0, windowStart = Date.now();
  lines.on("line", line => {
    if (closed) return;
    if (line.length > 8192) return close();
    try {
      const event = JSON.parse(line);
      if (event.type === "ready") {
        res.write("event: ready\ndata: {}\n\n");
        return;
      }
      if (!event.id || event.source !== "claw-live") return close();
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); count = 0; }
      // Bound the app queue; don't silently represent a truncated stream as complete.
      if (++count > 120) {
        res.write("event: gap\ndata: {}\n\n");
        return close();
      }
      if (!res.write("event: activity\ndata: " + JSON.stringify(event) + "\n\n")) close();
    } catch { close(); }
  });
  child.stderr.resume(); // Never return raw diagnostics to Android.
  child.once("error", close);
  child.once("exit", close);
  res.once("close", close);
  req.once("aborted", close);
}

export async function handleControl(req: IncomingMessage, res: ServerResponse, route: string): Promise<boolean> {
  if (!route.startsWith("/control/")) return false;
  // This façade is always local native-app only, even when other Companion CORS
  // endpoints are explicitly enabled. Existing transport/auth stays untouched.
  const address = req.socket.remoteAddress || "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) ||
      req.headers.origin || req.headers["sec-fetch-site"]) {
    res.writeHead(403); res.end(); return true;
  }
  if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }); res.end(); return true; }
  const section = route.slice("/control/".length);
  if (section === "activity/stream") { streamControl(req, res); return true; }
  if (!sections.has(section)) { res.writeHead(404); res.end(); return true; }
  const abort = new AbortController();
  const cancel = () => { if (!res.writableEnded) abort.abort(); };
  res.once("close", cancel);
  try {
    const value = await readControl(section, abort.signal);
    if (!res.destroyed) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    }
  } catch {
    if (!res.destroyed) {
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "control_unavailable" }));
    }
  } finally {
    res.removeListener("close", cancel);
  }
  return true;
}

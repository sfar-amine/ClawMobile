import os from "node:os";
import path from "node:path";

/** Tier0 exports the termux-lite directory, not the Git checkout. No environment mutation. */
export function runtimeRoot(home = os.homedir()): string {
  const configured = process.env.CLAW_RUNTIME_ROOT?.trim();
  if (configured && !path.isAbsolute(configured)) throw new Error("runtime_root_not_absolute");
  return configured || path.join(home, ".openclaw", "releases", "current", "termux-lite");
}

export function runtimeFile(name: string, home = os.homedir()): string {
  return path.join(runtimeRoot(home), name);
}

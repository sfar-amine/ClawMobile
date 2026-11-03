import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Single code root (Amine 02/11/2026): production reads the activated playbooks pin
 * (`~/.openclaw/runtime-ui-playbooks/current`, activate-ui-playbooks.sh). The workspace checkout is dev-only.
 * No rigidity: when the pin lacks the needed file, the caller keeps running on the workspace copy and a
 * throttled event file is left in `~/.openclaw/health/code-root/events/<component>.json`, the same format as
 * installer/termux-lite/code_root.py. `runtime-sync.sh --check` (health manager, every 30 min) turns a recent
 * event into a named drift and the existing alert. Resolved per call (the pin switch is an atomic symlink),
 * with the link spelling kept so a later activation or rollback is followed. Never throws.
 */

export const PIN_REL = path.join(".openclaw", "runtime-ui-playbooks", "current");
export const WORKSPACE_REL = path.join(".openclaw", "workspace", "ui-playbooks");
const EVENTS_REL = path.join(".openclaw", "health", "code-root", "events");
const COMPONENT_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const THROTTLE_MS = 10 * 60_000;
const MAX_EVENT_FILES = 64;

export type PlaybooksRootOptions = {
  /** Explicit roots, honoured in order. */
  overrides?: Array<string | undefined>;
  /** true: an override is used only when it carries `required` (otherwise: as given, legacy behaviour). */
  overridesMustContain?: boolean;
  home?: string;
  now?: () => number;
};

function hasFile(root: string, required: string): boolean {
  try { return fs.statSync(path.join(root, required)).isFile(); } catch { return false; }
}

export function recordCodeRootEvent(component: string, root: string, reason = "pin_missing", home = os.homedir(), now = Date.now()): boolean {
  try {
    if (!COMPONENT_RE.test(component)) return false;
    const dir = path.join(home, EVENTS_REL);
    const target = path.join(dir, `${component}.json`);
    try {
      if (now - fs.statSync(target).mtimeMs < THROTTLE_MS) return false;
    } catch {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length >= MAX_EVENT_FILES) return false;
    }
    const body = { version: 1, component, event: "fallback", reason: reason.slice(0, 80), root: root.slice(0, 300), at: new Date(now).toISOString() };
    const tmp = path.join(dir, `.${component}.json.${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(body) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, target);
    const seconds = now / 1000;
    fs.utimesSync(target, seconds, seconds);
    console.warn(`[code-root] fallback component=${component} reason=${body.reason}`);
    return true;
  } catch {
    return false;
  }
}

/** Overrides, then the activated pin, then (event recorded) the workspace checkout, which is also the last
 * resort when nothing carries `required`, as before this lot. */
export function playbooksRootFor(component: string, required: string, options: PlaybooksRootOptions = {}): string {
  const home = options.home ?? os.homedir();
  for (const value of options.overrides ?? []) {
    if (!value) continue;
    if (!options.overridesMustContain || hasFile(value, required)) return value;
  }
  const pinned = path.join(home, PIN_REL);
  if (hasFile(pinned, required)) return pinned;
  const workspace = path.join(home, WORKSPACE_REL);
  const reason = fs.existsSync(pinned) ? "pin_lacks_file" : "pin_missing";
  recordCodeRootEvent(component, workspace, reason, home, options.now ? options.now() : Date.now());
  return workspace;
}

export function playbooksRootHas(root: string, required: string): boolean {
  return hasFile(root, required);
}

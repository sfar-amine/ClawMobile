import os from "node:os";
import path from "node:path";

/** Companion/Gateway helpers follow Tier0's current link, including after promotion.
 * CLAW_RUNTIME_ROOT is inherited from the pinned Tier0 daemon; it is not a helper override.
 * Keep the link spelling (no realpath/cache) and never mutate the caller environment.
 */
export function runtimeRoot(home = os.homedir()): string {
  return path.join(home, ".openclaw", "releases", "current", "termux-lite");
}

export function runtimeFile(name: string, home = os.homedir()): string {
  return path.join(runtimeRoot(home), name);
}

/** Helper shipped with this compiled code: `<repo>/installer/termux-lite/<name>`.
 * For a CLI protocol versioned with the checkout (deploy `$SRC`), which a Tier0
 * rollback to an older `current` release must not downgrade. Resolved from this
 * module's location only (dist/ or src/ sit at the same depth); no environment override.
 */
export function checkoutFile(name: string): string {
  return path.resolve(__dirname, "..", "..", "installer", "termux-lite", name);
}

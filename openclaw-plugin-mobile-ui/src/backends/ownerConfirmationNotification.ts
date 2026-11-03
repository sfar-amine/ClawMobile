import {spawn} from "child_process";
import path from "path";

/**
 * Amine 02/11 — owner confirmation of a room contact's WhatsApp send. Same pattern as the QA campaign notification
 * (qaCampaignNotificationAction.ts): the Termux notification click only OPENS the app's existing biometric
 * confirmation screen (OwnerConfirmationActivity, kind « confirmation »). The screen re-reads the request from the
 * Companion, shows who asks, the recipient and the exact text, and signs or refuses. Nothing is decided here.
 */
// Installed package confirmed read-only on the S24 (02/11, pm list packages: ai.samantha.android.dev).
export const OWNER_CONFIRMATION_COMPONENT = "ai.samantha.android.dev/ai.samantha.android.OwnerConfirmationActivity";
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NODE = "/data/data/com.termux/files/home/.openclaw-android/bin/node";

export function confirmationRequestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw Error("owner_confirmation_request_id_invalid");
  return value;
}

export function ownerConfirmationOpenArgs(value: unknown): string[] {
  return ["start", "-n", OWNER_CONFIRMATION_COMPONENT, "--es", "confirmation_request_id", confirmationRequestId(value)];
}

const shellArg = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/** termux-notification arguments: title and content shown on Amine's phone, the click opens the confirmation. */
export function ownerConfirmationNotificationArgs(value: unknown, title: string, content: string): string[] {
  const id = confirmationRequestId(value);
  const action = [NODE, path.join(__dirname, "ownerConfirmationNotification.js"), id].map(shellArg).join(" ");
  return ["--id", "owner-confirmation:" + id, "--title", title, "--content", content, "--priority", "high",
    "--action", action];
}

/** Private click script: opens the confirmation screen only. */
export async function openOwnerConfirmation(argv: string[]): Promise<number> {
  if (argv.length !== 1) throw Error("owner_confirmation_arguments_invalid");
  const args = ownerConfirmationOpenArgs(argv[0]);
  return new Promise(resolve => {
    const child = spawn("/data/data/com.termux/files/usr/bin/am", args, {stdio: "ignore"});
    let finished = false;
    const finish = (code: number) => {if (!finished) {finished = true; clearTimeout(timer); resolve(code);}};
    const timer = setTimeout(() => {try {child.kill("SIGKILL");} catch {/* Still unconfirmed. */} finish(1);}, 5000);
    child.once("error", () => finish(1));
    child.once("close", code => finish(code === 0 ? 0 : 1));
  });
}
if (require.main === module) {
  openOwnerConfirmation(process.argv.slice(2)).then(code => {process.exitCode = code;}, () => {process.exitCode = 1;});
}

import {spawn} from "child_process";

// Installed component confirmed readonly on S24, PR196#6250854589.
export const QA_COMPONENT = "ai.samantha.android.dev/ai.samantha.android.MainActivity";
export const QA_ACTION = "ai.samantha.android.OPEN_QA_CAMPAIGN";
export function qaRunId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value))
    throw Error("qa_notification_run_id_invalid");
  return value;
}
export function qaCampaignOpenArgs(value: unknown): string[] {
  const id = qaRunId(value);
  return ["start", "-n", QA_COMPONENT, "-a", QA_ACTION,
    "--ei", "qa_version", "1", "--es", "qa_run_id", id];
}

/** Private click script. It only opens the app; the authenticated app rereads the run. */
export async function openQaCampaign(argv: string[]): Promise<number> {
  if (argv.length !== 1) throw Error("qa_notification_arguments_invalid");
  const args = qaCampaignOpenArgs(argv[0]);
  return new Promise(resolve => {
    const child = spawn("/data/data/com.termux/files/usr/bin/am", args, {stdio:"ignore"});
    let finished = false;
    const finish = (code:number) => {if (!finished) {finished=true; clearTimeout(timer); resolve(code);}};
    const timer = setTimeout(() => {try {child.kill("SIGKILL");} catch {/* Still unconfirmed. */} finish(1);}, 5000);
    child.once("error", () => finish(1));
    child.once("close", code => finish(code === 0 ? 0 : 1));
  });
}
if (require.main === module) {
  openQaCampaign(process.argv.slice(2)).then(code => {process.exitCode=code;}, () => {process.exitCode=1;});
}

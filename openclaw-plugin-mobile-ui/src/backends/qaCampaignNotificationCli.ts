import {tx_notify} from "./termux";
import {qaRunId} from "./qaCampaignNotificationAction";

/** Private canonical producer used by QA, not registered as a public tool. */
export async function notifyQaCampaign(argv:string[]) {
  if (argv.length !== 1) throw Error("qa_notification_arguments_invalid");
  const runId = qaRunId(argv[0]);
  const result = await tx_notify({title:"Samantha",content:"Campagne de tests lancée. Ouvrir le suivi."},
    {kind:"qa_campaign",runId});
  // Termux acceptance does not establish display, click, app admission or delivery.
  return {state:result.ok?"ACCEPTED":"UNKNOWN",display_verified:false,click_verified:false};
}
if (require.main === module) {
  const argv = process.argv.slice(2);
  let valid = false;
  try {valid=argv.length===1 && !!qaRunId(argv[0]);} catch {/* Refused before invoking Termux. */}
  if (!valid) {
    process.stdout.write('{"state":"NOT_SENT","reason":"qa_notification_request_invalid"}\n');process.exitCode=1;
  } else notifyQaCampaign(argv).then(receipt => {
    process.stdout.write(JSON.stringify(receipt)+"\n");
    process.exitCode=receipt.state==="ACCEPTED"?0:1;
  }, () => {process.stdout.write('{"state":"UNKNOWN","reason":"qa_notification_dispatch_unconfirmed"}\n');process.exitCode=1;});
}

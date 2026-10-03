import fs from "fs";
import os from "os";
import path from "path";
import {createConfirmationCore} from "./confirmationCore";
import {ownerKey,ownerError} from "./ownerConfirmationProtocol";
import {readOwnerConfirmations,mutateOwnerConfirmations} from "./runs";
export const confirmations=createConfirmationCore({
 store:{read:readOwnerConfirmations,change:mutateOwnerConfirmations},
 key:()=>{
  const state=process.env.OPENCLAW_STATE_DIR||path.join(os.homedir(),".openclaw");
  try {return ownerKey(fs.readFileSync(path.join(state,"clawmobile-companion","owner-confirmation-public.pem")));}
  catch {return ownerError("owner_key_not_provisioned",503);}
 }
});

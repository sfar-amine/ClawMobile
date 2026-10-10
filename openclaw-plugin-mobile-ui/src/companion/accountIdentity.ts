import {createHash} from "crypto";

/**
 * Account identifiers never leave the Companion towards the app.
 *
 * An OpenClaw auth profile id is `<provider>:<label>`, and the label of an OAuth
 * profile is the account e-mail (S24 10/10: `openai:<e-mail>`). Model references
 * may carry it as `provider/model@<profileId>`. The app only needs a stable,
 * opaque handle for its CAS/biometric payload, so profiles are published as
 * `acct-<12 hex>` and resolved back against the canonical Gateway profiles on
 * POST. No new store: the alias is a pure function of the profile id.
 */
export const ACCOUNT_ALIAS=/^acct-[a-f0-9]{12}$/;
export const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function accountAlias(profileId:string):string{
 return "acct-"+createHash("sha256").update("samantha-auth-profile:v1:"+profileId).digest("hex").slice(0,12);
}

/** `provider/model@profile` -> `provider/model@acct-…`; a reference without profile is unchanged. */
export function publicModelRef(ref:string|null|undefined):string|null{
 if(typeof ref!=="string")return null;
 const at=ref.indexOf("@");
 if(at<0)return ref;
 const suffix=ref.slice(at+1);
 return ref.slice(0,at)+"@"+(ACCOUNT_ALIAS.test(suffix)?suffix:accountAlias(suffix));
}

/** Neutral account presentation: provider + « compte connecté », never the label. */
export function accountView(ref:string|null|undefined){
 if(typeof ref!=="string"||!ref.includes("@"))return null;
 const base=ref.slice(0,ref.indexOf("@")),provider=base.includes("/")?base.split("/")[0]:null;
 const id=publicModelRef(ref)!.slice(base.length+1);
 return {id,provider,label:(provider?provider+" · ":"")+"compte connecté"};
}

/**
 * Back from the app: `base@acct-…` is resolved against the canonical profiles,
 * a raw profile id (older clients) is accepted as is, an unknown alias is null.
 */
export function resolveModelRef(ref:string,profiles:string[]):string|null{
 const at=ref.indexOf("@");
 if(at<0)return ref;
 const suffix=ref.slice(at+1);
 if(!ACCOUNT_ALIAS.test(suffix))return ref;
 const match=profiles.filter(profile=>accountAlias(profile)===suffix);
 return match.length===1?ref.slice(0,at)+"@"+match[0]:null;
}

/** Every profile id the canonical auth status and config know (no other source). */
export function knownProfiles(auth:any,...refs:any[]):string[]{
 const out=new Set<string>();
 for(const row of Array.isArray(auth?.providers)?auth.providers:[])for(const profile of Array.isArray(row?.profiles)?row.profiles:[])if(typeof profile?.profileId==="string")out.add(profile.profileId);
 for(const ref of refs.flat())if(typeof ref==="string"&&ref.includes("@"))out.add(ref.slice(ref.indexOf("@")+1));
 return [...out];
}

/**
 * Last-resort output guard for app-facing state routes: e-mail-shaped text in a
 * key or a value is masked. Content routes (chat turns, memory, files) are not
 * guarded here: the owner's own words stay intact.
 */
export function redactAccountIdentifiers<T>(value:T):T{
 const mask=(text:string)=>text.replace(EMAIL,"compte masqué");
 const walk=(node:any,depth:number):any=>{
  if(depth>64)return node;
  if(typeof node==="string")return node.includes("@")?mask(node):node;
  if(Array.isArray(node))return node.map(item=>walk(item,depth+1));
  if(node&&typeof node==="object"){
   const out:any={};
   for(const [key,item] of Object.entries(node))out[key.includes("@")?mask(key):key]=walk(item,depth+1);
   return out;
  }
  return node;
 };
 return walk(value,0);
}

/** Routes whose JSON is state/configuration for the app, never owner-authored content. */
export function accountGuardedRoute(routePath:string):boolean{
 return /^\/(agent\/config|providers|usage|updates|health|security\/surfaces|notifications\/sources|laptop-access\/computers|voice\/voices|control\/(engineering|diagnostic\/export)|skills\/candidates|conversations\/[^/]+\/metadata)$/.test(routePath);
}

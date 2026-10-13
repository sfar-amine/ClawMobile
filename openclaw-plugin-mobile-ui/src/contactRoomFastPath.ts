import crypto from "node:crypto";
import { SurfaceClarifications } from "./capabilityClarification";
import { contactRoomSession, type ContactRoom } from "./contactRoomProfile";
import { runModelFastPath, type FastPathResult, type RunnerOptions } from "./modelFastPath";

type Event = { messageId?: string; content?: string; body?: string; sessionKey?: string; channel?: string; isGroup?: boolean };
type Context = { messageId?: string; sessionKey?: string; channelId?: string; agentId?: string };
type Runner = (message: string, options?: RunnerOptions) => Promise<FastPathResult>;
type Verdict = "allowed" | "outside" | "forbidden";
const ACTIVE = new Set<ContactRoom>(["agenda", "actions", "messages"]);
const pending = new Map<string,{original:string;decision:Record<string,unknown>;at:number}>();
const TTL = 10 * 60_000;

function field(value: unknown, key: string) { return value && typeof value === "object" ? String((value as any)[key] ?? "") : ""; }

/** Closed authorization on the canonical decision; payment and owner-only data never match these grants. */
export function contactRoomVerdict(decision: unknown, rooms: ReadonlySet<ContactRoom>): Verdict {
  if (!decision || typeof decision !== "object") return "outside";
  const selected = (decision as any).selected;
  const capability = field(decision,"capability") || field(selected,"capability");
  const target = field(decision,"target") || field(selected,"target");
  const intent = field(decision,"intent") || field(selected,"intent");
  const route = field(decision,"route") || field(selected,"route");
  const risk = field(decision,"risk") || field(selected,"risk");
  const confirmation = (decision as any).confirmationRequired === true || (selected as any)?.confirmation_required === true;
  // Pulse has its own existing owner and validation boundary, which runs next in before_dispatch.
  if (rooms.has("pulse") && (target === "pulse" || route.startsWith("pulse."))) return "outside";
  if (confirmation || /payment|bank|transaction/i.test(capability+" "+target+" "+intent+" "+route)) return "forbidden";
  if (rooms.has("agenda") && capability === "agenda.google_whatsapp" && target === "agenda" && risk === "read") return "allowed";
  if (rooms.has("messages") && capability === "notification.whatsapp.owner" && target === "whatsapp" && intent === "messaging.send") return "allowed";
  if (rooms.has("actions") && (capability === "device.assistance" || capability === "device.modes_routines")) return "allowed";
  return capability || target || intent || route ? "forbidden" : "outside";
}

function response(text:string){return {handled:true,text};}

export async function handleContactRoomBeforeDispatch(event:Event,ctx:Context,runner:Runner=runModelFastPath,now:()=>number=Date.now){
  if(event.isGroup===true)return {handled:false};
  const key=String(ctx.sessionKey||event.sessionKey||"");const profile=contactRoomSession(key);
  if(!profile||ctx.agentId&&ctx.agentId!==profile.agent||![...profile.rooms].some(r=>ACTIVE.has(r)))return {handled:false};
  if(String(event.channel||ctx.channelId||"whatsapp").toLowerCase()!=="whatsapp")return {handled:false};
  const message=String(event.content||event.body||"").trim();if(!message||message.length>4000)return response("Écris la demande en texte, en moins de 4 000 caractères.");
  const id="wa-"+crypto.createHash("sha256").update(profile.e164).digest("hex").slice(0,16);
  const run=String(event.messageId||ctx.messageId||now()).slice(0,60);
  const common:RunnerOptions={surface:"whatsapp",caller:"owner",originId:`contact-room:${id}:${run}`,timeoutSeconds:30};
  const conversation=SurfaceClarifications.idFor(key);
  try{
    for(const [k,v] of pending)if(now()-v.at>TTL)pending.delete(k);
    const prior=pending.get(conversation);let result:FastPathResult|undefined;
    if(prior){pending.delete(conversation);const answered=await runner(message,{...common,checkOnly:true,clarificationDecision:prior.decision,clarificationOriginalText:prior.original});if(answered.status!=="clarification_unrelated")result=answered;}
    result??=await runner(message,{...common,checkOnly:true});
    if(result.status==="miss"||result.status==="assist")return {handled:false};
    if(result.status==="error")return response("Cette pièce est momentanément indisponible. Réessaie dans un instant.");
    const decision=(result.decision&&typeof result.decision==="object"?result.decision:null) as Record<string,unknown>|null;
    if(!decision)return {handled:false};
    const verdict=contactRoomVerdict(decision,profile.rooms);
    if(verdict==="outside")return {handled:false};
    if(verdict!=="allowed")return response("Cette demande n’est pas autorisée dans les pièces qui te sont ouvertes.");
    if(result.status==="clarification"){
      pending.set(conversation,{original:prior?.original||message,decision,at:now()});
      return response(String(result.text||"Précise la demande.").trim());
    }
    if(result.status==="known_error")return response(String(result.text||"La demande n’a pas pu être terminée.").trim());
    if(result.status!=="eligible")return response("La demande n’a pas pu être qualifiée sans ambiguïté.");
    const done=await runner(prior&&String((result.resolution as any)?.text||"").trim()?String((result.resolution as any).text):message,{...common,checkOnly:false,timeoutSeconds:75,preparedDecision:decision});
    if(done.status==="hit"||done.status==="known_error")return response(String(done.text||"La demande a été traitée.").trim());
    return response("La demande n’a pas pu être terminée. Réessaie dans un instant.");
  }catch{return response("Cette pièce est momentanément indisponible. Réessaie dans un instant.");}
}

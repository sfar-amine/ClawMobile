import {createHash} from 'node:crypto';
import {contactRoomSession} from './contactRoomProfile';
import {allowlistRead} from './companion/whatsappAllowlist';
import {dialogueChildRequest,splitRequests,type DialogueRequestContext} from './dialogueSurface';

export const NATIVE_PULSE_PROTOCOL='native-pulse.v1';
const seal=Symbol('native-pulse-host');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
type AuthorityRead=(contactId:string)=>Promise<any>;
const canonicalRead:AuthorityRead=id=>allowlistRead('get',id);

/** Ephemeral host event, not serializable authority. No conversation state. */
export class NativePulseContact {
  #seal:symbol; #read:AuthorityRead;
  constructor(token:symbol,readonly contactId:string,readonly conversationKey:string,
    readonly eventRef:string,readonly originalText:string,readonly sessionKey:string,read:AuthorityRead,
    readonly requestContext?:Readonly<DialogueRequestContext>) {
    if(token!==seal)throw Error('native_pulse_admission_required');this.#seal=token;this.#read=read;
  }
  async packet(event:any,text:string) {
    if(this.#seal!==seal||event?.surface!=='pulse_room'||event?.conversationKey!==this.conversationKey||
       event?.eventRef!==this.eventRef||text!==this.originalText||
       (this.requestContext?(!event.requestContext||Object.keys(event.requestContext).sort().join(',')!=='originalText,parentEventRef'||
         event.requestContext.parentEventRef!==this.requestContext.parentEventRef||event.requestContext.originalText!==this.requestContext.originalText):
         event.requestContext!==undefined))throw Error('native_pulse_event_mismatch');
    const current=await this.#read(this.contactId);
    const profile=contactRoomSession(this.sessionKey);
    if(!profile||!['contacts-pulse','contacts-projet-pulse'].includes(profile.agent)||current?.success!==true||current.state!=='active'||
       current.owner!==false||current.contactId!==this.contactId||
       !Array.isArray(current.rooms)||!current.rooms.includes('pulse')||current.rooms.includes('maison')||
       !current.e164||'wa-'+digest(current.e164).slice(0,16)!==this.contactId||current.e164!==profile.e164||
       current.expiresAt!==null&&(!Number.isFinite(Date.parse(current.expiresAt))||Date.parse(current.expiresAt)<=Date.now()))
      throw Error('native_pulse_contact_revoked');
    const now=Date.now();
    return {schema_version:NATIVE_PULSE_PROTOCOL,contact_id:this.contactId,conversation_key:this.conversationKey,
      event_ref:this.eventRef,observed_at:now,valid_until:now+30000};
  }
}

/** Called only by the existing authenticated OpenClaw contacts-pulse hook. */
export async function admitNativePulseContact(input:{sessionKey:string;eventRef:string;text:string;isGroup:boolean;requestContext?:DialogueRequestContext},
  read:AuthorityRead=canonicalRead):Promise<NativePulseContact> {
  const profile=contactRoomSession(input.sessionKey);
  if(!profile||!['contacts-pulse','contacts-projet-pulse'].includes(profile.agent)||input.isGroup||!input.eventRef||
     input.eventRef.startsWith('untracked:')||input.eventRef.length>300||
     !input.text.trim()||input.text.length>4000)throw Error('native_pulse_admission_required');
  let context:Readonly<DialogueRequestContext>|undefined;
  if(input.requestContext!==undefined){
    const value=input.requestContext;
    if(!value||Object.keys(value).sort().join(',')!=='originalText,parentEventRef'||
      typeof value.parentEventRef!=='string'||!value.parentEventRef||value.parentEventRef.length>300||value.parentEventRef.startsWith('untracked:')||
      typeof value.originalText!=='string'||!value.originalText||value.originalText.length>4000||
      !splitRequests(value.originalText).some((text,n)=>text===input.text&&
        dialogueChildRequest(value.parentEventRef,text,n+1).eventRef===input.eventRef))throw Error('native_pulse_event_mismatch');
    context=Object.freeze({parentEventRef:value.parentEventRef,originalText:value.originalText});
  }
  const id='wa-'+digest(profile.e164).slice(0,16);
  const key=`pulse-room:${profile.agent}:${id}:${input.sessionKey}`;
  const admission=new NativePulseContact(seal,id,key,input.eventRef,input.text,input.sessionKey,read,context);
  await admission.packet({surface:'pulse_room',conversationKey:key,eventRef:input.eventRef,...(context?{requestContext:context}:{})},input.text);
  return admission;
}

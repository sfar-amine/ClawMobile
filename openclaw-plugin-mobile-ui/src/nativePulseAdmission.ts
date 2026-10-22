import {createHash} from 'node:crypto';
import {contactRoomSession} from './contactRoomProfile';
import {allowlistRead} from './companion/whatsappAllowlist';

export const NATIVE_PULSE_PROTOCOL='native-pulse.v1';
const seal=Symbol('native-pulse-host');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
type AuthorityRead=(contactId:string)=>Promise<any>;
const canonicalRead:AuthorityRead=id=>allowlistRead('get',id);

/** Ephemeral host event, not serializable authority. No conversation state. */
export class NativePulseContact {
  #seal:symbol; #read:AuthorityRead;
  constructor(token:symbol,readonly contactId:string,readonly conversationKey:string,
    readonly eventRef:string,readonly originalText:string,readonly sessionKey:string,read:AuthorityRead) {
    if(token!==seal)throw Error('native_pulse_admission_required');this.#seal=token;this.#read=read;
  }
  async packet(event:any,text:string) {
    if(this.#seal!==seal||event?.surface!=='pulse_room'||event?.conversationKey!==this.conversationKey||
       event?.eventRef!==this.eventRef||text!==this.originalText)throw Error('native_pulse_event_mismatch');
    const current=await this.#read(this.contactId);
    const profile=contactRoomSession(this.sessionKey);
    if(!profile||profile.agent!=='contacts-pulse'||current?.success!==true||current.state!=='active'||
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
export async function admitNativePulseContact(input:{sessionKey:string;eventRef:string;text:string;isGroup:boolean},
  read:AuthorityRead=canonicalRead):Promise<NativePulseContact> {
  const profile=contactRoomSession(input.sessionKey);
  if(!profile||profile.agent!=='contacts-pulse'||input.isGroup||!input.eventRef||
     input.eventRef.startsWith('untracked:')||input.eventRef.length>300||
     !input.text.trim()||input.text.length>4000)throw Error('native_pulse_admission_required');
  const id='wa-'+digest(profile.e164).slice(0,16);
  const key=`pulse-room:contacts-pulse:${id}:${input.sessionKey}`;
  const admission=new NativePulseContact(seal,id,key,input.eventRef,input.text,input.sessionKey,read);
  await admission.packet({surface:'pulse_room',conversationKey:key,eventRef:input.eventRef},input.text);
  return admission;
}

import {createHash} from 'crypto';
import {ownerUuid} from './ownerConfirmationProtocol';
import {boundedFileContent} from './fileReadBoundary';
// E3 preparation only. No route imports this module; no Gateway mutation or backup store.
export const AGENT_EDIT_NAMES=Object.freeze(['AGENTS.md','SOUL.md','USER.md','IDENTITY.md','DREAMS.md'] as const);
const fail=(code:string,statusCode=400):never=>{throw Object.assign(new Error(code),{statusCode});};
export type AgentFileWritePlan={name:string;content:string;baseHash:string;operationId:string;confirmationId:string;action:{type:'agent.file_write';reference:string;payloadHash:string}};
export function prepareAgentFileWrite(value:any):AgentFileWritePlan {
 const keys=['name','content','baseHash','operationId','confirmationId'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(value,k)))fail('invalid_file_write');
 if(typeof value.name!=='string'||!(AGENT_EDIT_NAMES as readonly string[]).includes(value.name))fail('file_write_not_available',404);
 if(typeof value.content!=='string'||value.content.includes('\0'))fail('invalid_file_content');
 const preview=boundedFileContent(value.name,Buffer.from(value.content,'utf8'));
 if(preview.truncated)fail('file_content_not_fully_reviewable');
 if(preview.redacted)fail('file_content_protected',403);
 if(typeof value.baseHash!=='string'||!/^[a-f0-9]{64}$/.test(value.baseHash))fail('invalid_file_revision');
 if(typeof value.operationId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(value.operationId))fail('invalid_operation_id');
 if(typeof value.confirmationId!=='string'||!ownerUuid.test(value.confirmationId))fail('confirmation_required',403);
 return {...value,action:{type:'agent.file_write',reference:value.name,payloadHash:createHash('sha256').update(value.content,'utf8').digest('hex')}};
}
// This pure check is not a claim of atomic CAS in agents.files.set. That schema is unconfirmed.
export function assertAgentFileRevision(baseHash:string,currentHash:string):void {
 if(!/^[a-f0-9]{64}$/.test(baseHash)||!/^[a-f0-9]{64}$/.test(currentHash))fail('file_owner_unavailable',503);
 if(baseHash!==currentHash)fail('file_revision_changed',409);
}
export function agentFileWriteReadiness(){return {ready:false,state:'blocked',missing:['agents.files.set_S24_schema_and_capture','atomic_owner_CAS','existing_owner_backup_retention_5']} as const;}

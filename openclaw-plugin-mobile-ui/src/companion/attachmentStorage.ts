import fs from 'fs';
import path from 'path';
import os from 'os';
import {randomUUID,createHash} from 'crypto';
import {MEMO_STT_QUALIFICATION} from './memoSttBoundary';
export const MAX_ATTACHMENT_BYTES=10*1024*1024;
export const ATTACHMENT_QUOTA=500*1024*1024;
export const RETENTION_MS=30*86400000;
const formats:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','application/pdf':'pdf','text/plain':'txt','audio/mp4':'m4a'};
const error=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
export function attachmentDir(){return (process.env.CLAWMOBILE_ATTACHMENT_DIR||'').trim()||path.join(os.homedir(),'.clawmobile','companion-attachments');}
export function attachmentId(value:string){if(!/^[A-Za-z0-9_-]{1,100}$/.test(value))throw error('invalid_attachment_id');return value;}
function directory(create=false){const dir=attachmentDir();for(let p=dir;p!==path.dirname(p);p=path.dirname(p)){try{if(fs.lstatSync(p).isSymbolicLink())throw error('attachment_storage_unavailable',503);}catch(e:any){if(e.code!=='ENOENT')throw e;}}
 if(create)fs.mkdirSync(dir,{recursive:true,mode:0o700});return dir;}
export function validateAttachment(body:Buffer,mime:string){
 if(mime==='audio/mp4'&&!MEMO_STT_QUALIFICATION.success)throw error('memo_stt_not_qualified',503);
 if(!formats[mime]||!body.length||body.length>MAX_ATTACHMENT_BYTES)throw error(body.length>MAX_ATTACHMENT_BYTES?'attachment_too_large':'unsupported_attachment',body.length>MAX_ATTACHMENT_BYTES?413:400);
 const matches=mime==='image/png'?body.length>=24&&body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&body.toString('ascii',12,16)==='IHDR':
 mime==='image/jpeg'?body.length>=4&&body[0]===255&&body[1]===216&&body[2]===255:
 mime==='image/webp'?body.length>=16&&body.toString('ascii',0,4)==='RIFF'&&body.toString('ascii',8,12)==='WEBP':
 mime==='image/gif'?body.length>=13&&['GIF87a','GIF89a'].includes(body.toString('ascii',0,6)):
 mime==='application/pdf'?body.toString('ascii',0,5)==='%PDF-':
 mime==='audio/mp4'?isM4aContainer(body):
 !body.includes(0)&&Buffer.from(body.toString('utf8'),'utf8').equals(body)&&!/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(body.toString('utf8'))&&!/^\s*(?:<!doctype\s+html|<html|<svg|<script|<\?xml)/i.test(body.toString('utf8'));
 if(!matches)throw error('attachment_type_mismatch');
}
/** Bounded ISO-BMFF structure proof: an audio handler inside moov/trak/mdia.
 * A brand or the string "soun" in media payload is never track evidence. */
export function isM4aContainer(body:Buffer){
 if(body.length<24||body.toString('ascii',4,8)!=='ftyp')return false;
 const size=body.readUInt32BE(0);if(size<16||size>body.length||size>1024||(size-16)%4!==0)return false;
 const brands=[body.toString('ascii',8,12)];for(let i=16;i<size;i+=4)brands.push(body.toString('ascii',i,i+4));
 if(!brands.some(brand=>['M4A ','mp42','isom'].includes(brand)))return false;
 let boxes=0,audio=false;
 function scan(start:number,end:number,depth:number,ancestors:string[]):boolean{
  for(let at=start;at<end;){
   if(++boxes>1024||end-at<8)return false;
   let length=body.readUInt32BE(at),header=8;
   if(length===1){if(end-at<16)return false;const n=body.readBigUInt64BE(at+8);if(n>BigInt(end-at))return false;length=Number(n);header=16;}
   if(length===0)length=end-at;
   if(length<header||length>end-at)return false;
   const kind=body.toString('ascii',at+4,at+8),content=at+header,next=at+length;
   if(kind==='hdlr'&&ancestors.join('/')==='moov/trak/mdia'){
    if(next-content<24)return false;
    if(body.toString('ascii',content+8,content+12)==='soun')audio=true;
   }
   if(['moov','trak','mdia'].includes(kind)){
    if(depth>=4||!scan(content,next,depth+1,[...ancestors,kind]))return false;
   }
   at=next;
  }return true;
 }
 return scan(0,body.length,0,[])&&audio;
}
export function attachmentContent(id:string){const dir=directory();attachmentId(id);for(const [mime,ext] of Object.entries(formats)){
 if(mime==='audio/mp4'&&!MEMO_STT_QUALIFICATION.success)continue;
 const file=path.join(dir,id+'.'+ext);try{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const info=fs.fstatSync(fd);if(!info.isFile()||info.size>MAX_ATTACHMENT_BYTES){fs.closeSync(fd);throw error('attachment_storage_unavailable',503);}return {fd,mime,size:info.size,file,createdAt:info.mtimeMs,expiresAt:info.mtimeMs+RETENTION_MS};}catch(e:any){if(e.code!=='ENOENT')throw e;}
 }throw error('attachment_not_found',404);}
export function purgeAttachments(protectedPaths:Set<string>,now=Date.now()){
 const dir=directory();let names:string[];try{names=fs.readdirSync(dir);}catch(e:any){if(e.code==='ENOENT')return 0;throw e;}
 if(names.length>10000)throw error('attachment_storage_unavailable',503);
 let total=0;for(const name of names){const file=path.join(dir,name);const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())continue;
 if(!protectedPaths.has(file)&&now-info.mtimeMs>RETENTION_MS){fs.unlinkSync(file);continue;}total+=info.size;}return total;
}
export function saveAttachments(inputs:{id?:string;mimeType:string;body:Buffer;displayName?:string}[],protectedPaths:Set<string>,now=Date.now(),quota=ATTACHMENT_QUOTA){
 if(!inputs.length||inputs.length>5||inputs.reduce((sum,x)=>sum+x.body.length,0)>25*1024*1024)throw error('attachment_share_limit',413);
 const dir=directory(true);const planned=inputs.map(x=>{validateAttachment(x.body,x.mimeType);const id=attachmentId(x.id||'att_'+randomUUID());return {...x,id,file:path.join(dir,id+'.'+formats[x.mimeType])};});
 if(new Set(planned.map(x=>x.id)).size!==planned.length)throw error('attachment_id_collision',409);
 const existing=new Set<string>();
 for(const item of planned)for(const ext of Object.values(formats)){
  const file=path.join(dir,item.id+'.'+ext);
  try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||file!==item.file||stat.size!==item.body.length)throw error('attachment_id_collision',409);
   const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
   try{const stored=fs.readFileSync(fd);if(!createHash('sha256').update(stored).digest().equals(createHash('sha256').update(item.body).digest()))throw error('attachment_id_collision',409);}finally{fs.closeSync(fd);}
   existing.add(file);
  }catch(e:any){if(e.code!=='ENOENT')throw e;}
 }

 if(purgeAttachments(new Set([...protectedPaths,...existing]),now)+planned.filter(x=>!existing.has(x.file)).reduce((sum,x)=>sum+x.body.length,0)>quota)throw error('quota_full',409);
 const written:string[]=[];
 try{for(const item of planned){if(existing.has(item.file))continue;const fd=fs.openSync(item.file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);written.push(item.file);try{fs.writeFileSync(fd,item.body);fs.fsyncSync(fd);fs.futimesSync(fd,now/1000,now/1000);}finally{fs.closeSync(fd);}}}catch(e){for(const f of written)try{fs.unlinkSync(f);}catch{}throw error('attachment_write_failed',503);}
 return planned.map(x=>({id:x.id,serverId:x.id,type:x.mimeType.startsWith('image/')?'image':'file',mimeType:x.mimeType,displayName:x.displayName||x.id+'.'+formats[x.mimeType],sizeBytes:x.body.length,path:x.file,serverPath:x.file,downloadUrl:'/v1/attachments/'+x.id+'/content',createdAt:Math.round(fs.statSync(x.file).mtimeMs),expiresAt:Math.round(fs.statSync(x.file).mtimeMs)+RETENTION_MS}));
}
export function removeAttachments(paths:string[],protectedPaths:Set<string>){const dir=directory();for(const file of paths){if(path.dirname(file)!==dir||protectedPaths.has(file))continue;try{if(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink())fs.unlinkSync(file);}catch(e:any){if(e.code!=='ENOENT')throw error('attachment_cleanup_failed',503);}}}
export const attachmentDigest=(inputs:{id?:string;mimeType:string;body:Buffer;displayName?:string}[])=>createHash('sha256').update(JSON.stringify(inputs.map(x=>({id:x.id,mime:x.mimeType,hash:createHash('sha256').update(x.body).digest('hex')})))).digest('hex');

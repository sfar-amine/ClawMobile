import {protectedJob} from "./automations";

/** Local safety primitives only. No installed Gateway file schema is assumed here. */
export const FILE_LIST_LIMIT=250;
export const FILE_TEXT_BYTES=256*1024;
export const FILE_IMAGE_BYTES=FILE_TEXT_BYTES;
const denied=()=>Object.assign(new Error("file_not_available"),{statusCode:404});
const secretName=/credential|token|secret|password|backup|\.bak(?:$|[._-])|authorized_keys|(?:^|[._-])private(?:$|[._-])|\.env$|\.key$|\.pem$|\.p12$|\.pfx$|\.db$|\.sqlite3?$|^auth.*\.json$/i;
const pathSecret=/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|https?:\/\/|@|-----BEGIN/i;
const sensitiveText=/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})|token|password|mot de passe|secret|credential|authorization|bearer|\bcvv\b|\bcvc\b|api[_ -]?key|iban|(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)|(?<!\d)\d{6}(?!\d)|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|https?:\/\/|@|-----BEGIN .*PRIVATE KEY-----/i;

/** Line masked by every read and kept verbatim by every write (E3): payment, secret or identifier material. */
export const MASKED_LINE="[masqué]";
export function protectedFileLine(line:string):boolean{return sensitiveText.test(line)||protectedJob(line);}

export function safeFileName(name:unknown):string{
 if(typeof name!=="string"||name.length<1||name.length>512||name!==name.normalize("NFC")||/[\p{C}\p{Zl}\p{Zp}\\%]/u.test(name)||name.startsWith("/")||name.includes(":"))throw denied();
 const segments=name.split("/");
 if(segments.some(part=>!part||part==="."||part===".."||part.startsWith(".")||/^context(?:-backup)?$/i.test(part)||secretName.test(part)||pathSecret.test(part)||protectedJob(part)))throw denied();
 return name;
}

/** Validate a root returned by the owner without exposing its physical path. */
export function fileOwnerRootAllowed(root:unknown):string{
 if(typeof root!=='string'||!root.startsWith('/')||/[\p{C}\\]/u.test(root)||root.split('/').some(part=>part==='.'||part==='..'||/^context(?:-backup)?$/i.test(part)||secretName.test(part)||pathSecret.test(part)||protectedJob(part)))throw denied();
 return root;
}

export function fileContentAllowed(name:unknown):string{
 const checked=safeFileName(name);
 // Screenshots and UI dumps lack a qualified non-financial receipt: list only.
 if(checked.split("/").some(part=>/^(?:screenshots?|ui[-_]dumps?)$/i.test(part)))throw denied();
 return checked;
}

export function boundedFileContent(name:unknown,bytes:Buffer):{contentType:string;bytes:Buffer;truncated:boolean;redacted:boolean}{
 fileContentAllowed(name);
 if(!Buffer.isBuffer(bytes))throw denied();
 const png=bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpeg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 const gif=bytes.length>=6&&/^(?:GIF87a|GIF89a)$/.test(bytes.subarray(0,6).toString('ascii'));
 const webp=bytes.length>=12&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';
 const avif=bytes.length>=16&&bytes.subarray(4,8).toString('ascii')==='ftyp'&&[...Array(Math.floor((Math.min(bytes.length,64)-8)/4)).keys()].some(i=>['avif','avis'].includes(bytes.subarray(8+4*i,12+4*i).toString('ascii')));
 if(png||jpeg||gif||webp||avif){if(bytes.length>FILE_IMAGE_BYTES)throw denied();return {contentType:png?'image/png':jpeg?'image/jpeg':gif?'image/gif':webp?'image/webp':'image/avif',bytes,truncated:false,redacted:false};}
 // Reject binary rather than infer image type from extension or headers.
 if(bytes.subarray(0,FILE_TEXT_BYTES+1).includes(0))throw denied();
 let end=Math.min(bytes.length,FILE_TEXT_BYTES),text:string|undefined;
 // UTF-8 boundary trimming is limited to the maximum incomplete sequence length.
 for(let trim=0;trim<4&&end>=trim;trim++){
  if(trim>0){
   if(bytes.length<=FILE_TEXT_BYTES)break;
   const lead=bytes[end-trim],width=lead>=0xc2&&lead<=0xdf?2:lead>=0xe0&&lead<=0xef?3:lead>=0xf0&&lead<=0xf4?4:0;
   if(width<=trim||end-trim+width>bytes.length)continue;
   try{new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(end-trim,end-trim+width));}catch{continue;}
  }
  try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,end-trim));end-=trim;break;}catch{}
 }
 if(text===undefined)throw denied();
 if(/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text))return {contentType:"text/plain; charset=utf-8",bytes:Buffer.from("[masqué]"),truncated:bytes.length>end,redacted:true};
 let redacted=false;
 const output=text.split(/\r?\n/).map(line=>{
  if(protectedFileLine(line)){redacted=true;return MASKED_LINE;}
  return line;
 }).join("\n");
 const rendered=Buffer.from(output);
 let safeBytes=rendered;
 if(rendered.length>FILE_TEXT_BYTES){
  for(let trim=0;trim<4;trim++){try{safeBytes=Buffer.from(new TextDecoder("utf-8",{fatal:true}).decode(rendered.subarray(0,FILE_TEXT_BYTES-trim)));break;}catch{}}
 }
 return {contentType:"text/plain; charset=utf-8",bytes:safeBytes,truncated:bytes.length>end||rendered.length>FILE_TEXT_BYTES,redacted};
}

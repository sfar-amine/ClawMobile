import {protectedJob} from "./automations";

/** Local safety primitives only. No installed Gateway file schema is assumed here. */
export const FILE_LIST_LIMIT=200;
export const FILE_TEXT_BYTES=256*1024;
export const FILE_IMAGE_BYTES=5*1024*1024;
const denied=()=>Object.assign(new Error("file_not_available"),{statusCode:404});
const secretName=/credential|token|secret|password|backup|\.bak(?:$|[._-])|authorized_keys|(?:^|[._-])private(?:$|[._-])|\.env$|\.key$|\.pem$|\.p12$|\.pfx$|\.db$|\.sqlite3?$|^auth.*\.json$/i;
const sensitiveText=/token|password|mot de passe|secret|credential|authorization|bearer|\bcvv\b|\bcvc\b|api[_ -]?key|iban|(?:\d[ -]?){8,19}|(?<!\d)\d{6}(?!\d)|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|https?:\/\/|@|-----BEGIN .*PRIVATE KEY-----/i;

export function safeFileName(name:unknown):string{
 if(typeof name!=="string"||name.length<1||name.length>512||name!==name.normalize("NFC")||/[\x00-\x1f\x7f\\%]/.test(name)||name.startsWith("/")||name.includes(":"))throw denied();
 const segments=name.split("/");
 if(segments.some(part=>!part||part==="."||part===".."||part.startsWith(".")||/^context(?:-backup)?$/i.test(part)||secretName.test(part)||protectedJob(part)))throw denied();
 return name;
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
 if(png||jpeg){if(bytes.length>FILE_IMAGE_BYTES)throw denied();return {contentType:png?"image/png":"image/jpeg",bytes,truncated:false,redacted:false};}
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
 let redacted=false;
 const output=text.split(/\r?\n/).map(line=>{
  if(sensitiveText.test(line)||protectedJob(line)){redacted=true;return "[masqué]";}
  return line;
 }).join("\n");
 const rendered=Buffer.from(output);
 let safeBytes=rendered;
 if(rendered.length>FILE_TEXT_BYTES){
  for(let trim=0;trim<4;trim++){try{safeBytes=Buffer.from(new TextDecoder("utf-8",{fatal:true}).decode(rendered.subarray(0,FILE_TEXT_BYTES-trim)));break;}catch{}}
 }
 return {contentType:"text/plain; charset=utf-8",bytes:safeBytes,truncated:bytes.length>end||rendered.length>FILE_TEXT_BYTES,redacted};
}

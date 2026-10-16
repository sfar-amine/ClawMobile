export type PhoneDateTimeFact = {version:1;epochMs:number;zoneId:string};
export type PhoneDateTimeQuery = {kind:"time"|"date"|"day"|"date_time";language:"fr"|"en"|"derja"};

const fold=(value:string)=>value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()
  .replace(/[’']/g," ").replace(/[^a-z0-9]+/g," ").trim();

/** Narrow owner questions only: dates embedded in an agenda or another request keep their normal route. */
export function phoneDateTimeQuery(request:string):PhoneDateTimeQuery|null {
  const q=fold(String(request||""));
  if(!q||q.split(" ").length>14)return null;
  const derja=/\b(?:ch7al|chhal|chnowa|chneya|wa9tech|lyoum|tawa|se3a|sa3a|nhar)\b/.test(q);
  const english=/\b(?:what|which|today|current)\b/.test(q)&&/\b(?:time|date|day)\b/.test(q);
  const french=/\b(?:quelle?|donne moi|aujourd hui|on est|sommes nous)\b/.test(q)&&/\b(?:heure|date|jour)\b/.test(q);
  if(!derja&&!english&&!french)return null;
  const language:PhoneDateTimeQuery["language"]=derja?"derja":english?"en":"fr";
  const wantsTime=/\b(?:heure|time|se3a|sa3a)\b/.test(q),wantsDate=/\bdate\b/.test(q),wantsDay=/\b(?:jour|day|nhar|lyoum)\b/.test(q);
  if(wantsTime&&(wantsDate||wantsDay))return{kind:"date_time",language};
  if(wantsTime)return{kind:"time",language};if(wantsDate)return{kind:"date",language};if(wantsDay)return{kind:"day",language};return null;
}

export function readPhoneDateTimeFact(raw:unknown):PhoneDateTimeFact|null {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;const value=raw as Record<string,unknown>;
  if(Object.keys(value).sort().join(",")!=="epochMs,version,zoneId"||value.version!==1||typeof value.epochMs!=="number"||
    !Number.isSafeInteger(value.epochMs)||value.epochMs<1577836800000||value.epochMs>4102444800000||typeof value.zoneId!=="string"||value.zoneId.length<1||value.zoneId.length>80)return null;
  try{new Intl.DateTimeFormat("en",{timeZone:value.zoneId}).format(value.epochMs);}catch{return null;}
  return{version:1,epochMs:value.epochMs,zoneId:value.zoneId};
}

const derjaDays=["el a7ad","el ithnin","eth-thletha","el arb3a","el khmis","el jom3a","es-sebt"];
const derjaMonths=["janvier","fevrier","mars","avril","mai","juin","juillet","aout","septembre","octobre","novembre","decembre"];
function parts(fact:PhoneDateTimeFact){
  const values=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:fact.zoneId,weekday:"short",year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(fact.epochMs).map(p=>[p.type,p.value]));
  const weekday={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[values.weekday as "Sun"|"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"];
  return{hour:values.hour,minute:values.minute,day:Number(values.day),month:Number(values.month),year:Number(values.year),weekday};
}

export function phoneDateTimeText(query:PhoneDateTimeQuery,fact:PhoneDateTimeFact):string {
  const p=parts(fact),time=`${p.hour}:${p.minute}`;
  if(query.language==="derja"){
    const date=`${derjaDays[p.weekday]} ${p.day} ${derjaMonths[p.month-1]} ${p.year}`;
    if(query.kind==="time")return `Tawa esse3a ${time}.`;if(query.kind==="day")return `El youm ${derjaDays[p.weekday]}.`;
    if(query.kind==="date")return `El youm ${date}.`;return `El youm ${date}, w esse3a ${time}.`;
  }
  const locale=query.language==="en"?"en-GB":"fr-FR";
  const date=new Intl.DateTimeFormat(locale,{timeZone:fact.zoneId,weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(fact.epochMs);
  const weekday=new Intl.DateTimeFormat(locale,{timeZone:fact.zoneId,weekday:"long"}).format(fact.epochMs);
  if(query.language==="en"){
    if(query.kind==="time")return `It is ${time}.`;if(query.kind==="day")return `Today is ${weekday}.`;
    if(query.kind==="date")return `Today is ${date}.`;return `Today is ${date}, and it is ${time}.`;
  }
  if(query.kind==="time")return `Il est ${time}.`;if(query.kind==="day")return `Nous sommes ${weekday}.`;
  if(query.kind==="date")return `Nous sommes le ${date}.`;return `Nous sommes le ${date}, et il est ${time}.`;
}

export function phoneDateTimeDecision(request:string,factRaw:unknown){
  const query=phoneDateTimeQuery(request);if(!query)return null;const fact=readPhoneDateTimeFact(factRaw);
  const unavailable=query.language==="en"?"The phone's date and time are unavailable.":query.language==="derja"?"Date w esse3a mta3 et-telephone moch mawjoudin.":"La date et l’heure du téléphone ne sont pas disponibles.";
  const text=fact?phoneDateTimeText(query,fact):unavailable,capability="device.assistance",intent="device.datetime.read";
  const decision={version:2,type:"EXECUTE",capability,intent,target:"phone_clock",risk:"read",confirmationRequired:false,parameters:{},selected:{capability,intent,deterministic:true,model_required:false}};
  return{success:true,state:fact?"done":"failed",text,result:fact?text:undefined,capability,intent,source:fact?"android_phone_clock":"android_phone_clock_unavailable",model_bypassed:true,decision,
    harness:{version:1,tool_policy:"required",evidence_required:true,allow_model_only:false,confidence:1,reason:"phone_datetime",shortlist:[]},
    voice:{version:1,locale:query.language==="en"?"en":"fr",phase:"result",verbatim:text}};
}

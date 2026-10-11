const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {serverLanguage,localizedRoute,localizeServerPresentation}=require('../dist/companion/serverLocale.js');
const captureRoot=path.resolve(__dirname,'../fixtures/s24-2026-10-10');
const health=JSON.parse(fs.readFileSync(path.join(captureRoot,'control/health.json'),'utf8'));
const automations=JSON.parse(fs.readFileSync(path.join(captureRoot,'ui-recette/companion.control-automations.json'),'utf8')).response;
const original=JSON.stringify([health,automations]);
for(const [header,expected] of [[undefined,'fr'],['en-US,en;q=0.8','en'],['en;q=0.1,fr;q=0.9','fr'],['de,en;q=0.7','en'],['en;q=0','fr'],['en;q=invalid','fr'],['fr-CA','fr']])assert.equal(serverLanguage(header),expected);
for(const language of ['fr','en']){
 const projection=localizeServerPresentation(health,language);
 assert.equal(projection.sections.health.data.status,'healthy');
 assert.equal(projection.sections.health.data.statusLabel,language==='fr'?'Sain':'Healthy');
 const components=projection.sections.health.data.components;
 for(let i=0;i<components.length;i++){
  const source=health.sections.health.data.components[i];
  if(typeof source.label?.[language]==='string')assert.equal(components[i].name,source.label[language]);
  assert.equal(components[i].description,source.description);
 }
 const jobs=localizeServerPresentation(automations,language).sections.automations.data.items;
 const sourceJobs=automations.sections.automations.data.items;
 for(let i=0;i<jobs.length;i++){
  assert.equal(jobs[i].name,sourceJobs[i].name);
  assert.equal(jobs[i].nextRunAt,sourceJobs[i].nextRunAt);
  if(sourceJobs[i].scheduleType==='every')assert.equal(jobs[i].scheduleLabel,language==='fr'?sourceJobs[i].scheduleLabel:sourceJobs[i].scheduleLabel.replace('Toutes les','Every'));
  else assert.equal(jobs[i].scheduleLabel,sourceJobs[i].scheduleLabel);
 }
}
assert.equal(JSON.stringify([health,automations]),original,'shared cached source is never mutated');
const volume={items:Array.from({length:1000},(_,i)=>({id:String(i),status:'healthy',name:'User name',scheduleType:'every',scheduleLabel:'Toutes les 15 min'}))};
const started=performance.now();const projectedVolume=localizeServerPresentation(volume,'en');assert.equal(projectedVolume.items.length,1000);assert.equal(projectedVolume.items[999].scheduleLabel,'Every 15 min');assert.ok(performance.now()-started<100,'local presentation overhead stays below 100ms for scheduler bound');
const user={summary:'Toutes les 15 min',message:'Indisponible',note:'Healthy',receipt:{state:'completed'},facts:[{status:'healthy',label:{fr:'Utilisateur',en:'User'}}]};
assert.deepEqual(localizeServerPresentation(user,'en'),user);
assert.equal(localizeServerPresentation({reason:'protected_automation'},'en').reasonLabel,'Protected automation');
assert.equal(localizeServerPresentation({reason:'private_user_text'},'en').reasonLabel,undefined);
assert.equal(localizedRoute('/payments'),false);
assert.equal(localizedRoute('/runs'),false);
assert.equal(localizedRoute('/control/health'),true);
for(const route of ['/control/memory','/control/engineering','/control/diagnostic','/laptop-access/computers','/confirmations'])assert.equal(localizedRoute(route),false);
// Stable captured bodies exercise the existing ETag owner; live Control envelopes
// have decreasing remainingFreshMs, so this is no claim of identical live bodies.
const {conditionalRead}=require('../dist/companion/readEtag.js');
function conditionalProjection(language,tag){
 const value=localizeServerPresentation(automations,language),body=JSON.stringify(value);
 const headers={};let output;
 const req={method:'GET',url:'/v1/control/automations?contract=2',socket:{remoteAddress:'127.0.0.1'},headers:tag?{'if-none-match':tag}:{}};
 const res={statusCode:200,setHeader:(name,value)=>{headers[name.toLowerCase()]=value;},removeHeader:name=>{delete headers[name.toLowerCase()];},end:value=>{output=value;}};
 const notModified=conditionalRead(req,res,200,value,body);
 if(!notModified)res.end(body);
 return {status:res.statusCode,tag:headers.etag,body:output};
}
const french=conditionalProjection('fr'),english=conditionalProjection('en');
assert.equal(french.status,200);assert.equal(english.status,200);assert.notEqual(french.tag,english.tag,'language variants use distinct localized-body ETags');
for(const [language,previous,foreign] of [['fr',french,english],['en',english,french]]){
 const same=conditionalProjection(language,previous.tag);assert.equal(same.status,304);assert.equal(same.tag,previous.tag);assert.equal(same.body,undefined);
 const changed=conditionalProjection(language,foreign.tag);assert.equal(changed.status,200);assert.equal(changed.tag,previous.tag);assert.equal(changed.body,previous.body);
}
assert.equal(JSON.stringify([health,automations]),original,'conditional projections preserve the shared captured source');

async function verifyHttp(){
 const http=require('node:http');
 const cp=require('node:child_process');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
 const originalSpawn=cp.spawn;const ownerCalls=[];
 process.env.SAMANTHA_CONTROL_CACHE='1';process.env.SAMANTHA_CONTROL_PLAYBOOKS=__dirname;
 // Writer-regression test only: captured public contract projections are test inputs.
 // It does not qualify raw native-owner equality or replay S24 latency (#70 owns that proof).
 cp.spawn=(command,args,options)=>{
  if(command==='python3'&&args[0]==='-m'&&args[1]==='reporting.control_snapshot'){
   const section=args[5];assert.ok(['health','automations'].includes(section));assert.deepEqual(args,['-m','reporting.control_snapshot','--contract','2','--sections',section]);
   ownerCalls.push(section);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
   setImmediate(()=>{child.stdout.end(JSON.stringify(section==='health'?health:automations));child.emit('close',0);});return child;
  }
  return originalSpawn(command,args,options);
 };
 const {route}=require('../dist/companion/server.js');
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.statusCode=500;res.end();}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}/v1`;
  for(const language of ['fr','en']){
   const response=await fetch(base+'/notifications/sources?unsupported=1',{headers:{'Accept-Language':language}});
   assert.equal(response.status,400);assert.equal(response.headers.get('content-language'),language);assert.equal(response.headers.get('vary'),'Accept-Language');assert.equal((await response.json()).error,'unsupported_parameter');
  }
  for(const language of ['fr','en']){
   const refused=await fetch(base+'/control/automations?contract=2&unsupported=1',{headers:{'Accept-Language':language}});
   assert.equal(refused.status,400);assert.equal(refused.headers.get('content-language'),language);assert.equal(refused.headers.get('vary'),'Accept-Language');
   assert.equal((await refused.json()).error,'invalid_control_request');assert.deepEqual(ownerCalls,[],'refused parameters never invoke the owner');
  }
  const response=await fetch(base+'/notifications/sources?unsupported=1');assert.equal(response.headers.get('content-language'),'fr');
  for(const section of ['health','automations']){
   let revision;
   for(const language of ['fr','en']){
    const result=await fetch(base+`/control/${section}?contract=2`,{headers:{'Accept-Language':language}});
    assert.equal(result.status,200);assert.equal(result.headers.get('content-language'),language);assert.equal(result.headers.get('vary'),'Accept-Language');
    const body=await result.json(),data=body.sections[section].data;
    if(section==='health'){assert.equal(data.statusLabel,language==='fr'?'Sain':'Healthy');for(const component of data.components)if(component.label?.[language])assert.equal(component.name,component.label[language]);}
    else{assert.equal(data.items[0].scheduleLabel,language==='fr'?'Toutes les 15 min':'Every 15 min');assert.equal(data.items[0].name,automations.sections.automations.data.items[0].name);}
    if(revision)assert.equal(body.sections[section].dataRevision,revision,'same owner cache revision across presentation languages');revision=body.sections[section].dataRevision;
   }
  }
  assert.deepEqual(ownerCalls,['health','automations'],'one shared owner read per section across languages');
 }finally{cp.spawn=originalSpawn;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
verifyHttp().then(()=>console.log(JSON.stringify({lot:'F3',healthComponents:health.sections.health.data.components.length,automationRows:automations.sections.automations.data.items.length,cachedSourceUnchanged:true,gatewayCalls:0}))).catch(error=>{console.error(error);process.exitCode=1;});

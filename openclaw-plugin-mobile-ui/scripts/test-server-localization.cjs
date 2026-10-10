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
async function verifyHttp(){
 const http=require('node:http');
 const {route}=require('../dist/companion/server.js');
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.statusCode=500;res.end();}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}/v1`;
  for(const language of ['fr','en']){
   const response=await fetch(base+'/notifications/sources?unsupported=1',{headers:{'Accept-Language':language}});
   assert.equal(response.status,400);assert.equal(response.headers.get('content-language'),language);assert.equal(response.headers.get('vary'),'Accept-Language');assert.equal((await response.json()).error,'unsupported_parameter');
  }
  const response=await fetch(base+'/notifications/sources?unsupported=1');assert.equal(response.headers.get('content-language'),'fr');
 }finally{await new Promise(resolve=>server.close(resolve));}
}
verifyHttp().then(()=>console.log(JSON.stringify({lot:'F3',healthComponents:health.sections.health.data.components.length,automationRows:automations.sections.automations.data.items.length,cachedSourceUnchanged:true,gatewayCalls:0}))).catch(error=>{console.error(error);process.exitCode=1;});

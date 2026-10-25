// HTTP regression from the native source contract; not a fabricated S24 deferred-readback capture.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-readback-'));
process.env.OPENCLAW_STATE_DIR=root;process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN='1';
const {route}=require('../dist/companion/server.js');
const server=http.createServer((req,res)=>route(req,res).catch(e=>{res.statusCode=e.statusCode||500;res.end(JSON.stringify({message:e.message}));}));
(async()=>{
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const session='samantha-readback-test',id='voice-readback-00000000-0000-4000-8000-000000000001';
  const body={runId:id,revision:1,input:'',output:'La réponse est disponible.',state:'completed',playback:{version:1,outputGenerationId:'out-'+id,generationState:'completed',state:'completed',receivedFrames:24000,writtenFrames:24000,playedFrames:24000,sampleRate:24000,clock:'audio_track_head'}};
  async function save(value){const r=await fetch(base+'/v1/sessions/'+session+'/voice-turns',{method:'POST',headers:{'Content-Type':'application/json','X-ClawMobile-Owner-Flow':'v1'},body:JSON.stringify(value)});return {code:r.status,body:await r.json()};}
  const saved=await save(body);assert.equal(saved.code,200);assert.equal(saved.body.runId,id);assert.equal(saved.body.state,'done');
  assert.equal((await save(body)).code,200); // Exact lost-response retry keeps one row.
  const turns=await (await fetch(base+'/v1/sessions/'+session+'/turns')).json();assert.equal(turns.turns.length,1);assert.equal(turns.turns[0].runId,id);
  for(const invalid of ['voice-readback-','voice-readbacks-00000000-0000-4000-8000-000000000001','voice-anything-00000000-0000-4000-8000-000000000001','voice-readback-00000000-0000-4000-8000-00000000000Z'])
   assert.equal((await save({...body,runId:invalid})).code,400,invalid);
  const other=await fetch(base+'/v1/sessions/samantha-other/voice-turns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(other.status,409);
  console.log('PASS voice-readback persistence via existing HTTP owner, replay and closed identity fences');
 }finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

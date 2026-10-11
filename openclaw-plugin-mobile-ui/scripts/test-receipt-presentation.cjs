const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hs3-run-transport-'));process.env.OPENCLAW_STATE_DIR=root;
const reader=require('../dist/companion/receiptPresentation');
// Graph presentation computed on a real S24 PaymentRecord capture (fixtures/s24-2026-10-11c), plus one alternative.
const captures=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11c/hs3-presentations-from-captures.json'),'utf8')).cases;
const p=JSON.parse(JSON.stringify(captures.payment_effect_unknown_fr.presentation));
p.alternatives=[{capability:'telecom.tt.consultation',label:'Ligne TT'}];
assert.deepEqual(reader.readReceiptPresentation(captures.topup_confirmation_fr.presentation).understood.slots,{operator:'orange',amountTnd:'5',beneficiary:'owner'});
assert.deepEqual(reader.readReceiptPresentation({...captures.payment_expired_not_submitted_fr.presentation}).failure.notDone.code,'payment_not_submitted');
for(const bad of [null,[],{}, {...p,locale:['fr']},{...p,status:['error']},{...p,effect:{debited:false,source:'receipt'}},{...p,spoken:'Bearer abcdefghijklmnop'},{...p,label:'Contact 99 123 456'},{...p,alternatives:[...p.alternatives,...p.alternatives]}])assert.equal(reader.readReceiptPresentation(bad),undefined);
const closed=reader.readReceiptPresentation({...p,nonce:'private',understood:{...p.understood,slots:{...p.understood.slots,amount:10,nonce:'private'}},raw:{private:'private'}});
assert.ok(closed);assert.ok(!JSON.stringify(closed).includes('private'));assert.equal(closed.effect.debited,'unknown');
const helper=path.join(root,'helper.py');fs.writeFileSync(helper,`import sys,json\np=json.loads(${JSON.stringify(JSON.stringify(closed))})\nprint(json.dumps({'status':'eligible'} if '--check' in sys.argv else {'status':'known_error','text':p['spoken'],'presentation':p}))\n`);process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=helper;
const {submitIntent}=require('../dist/companion/intent'),runs=require('../dist/companion/runs'),{route}=require('../dist/companion/server');
const request=(port,runId)=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:'/v1/runs/'+runId},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(body)})}catch(e){reject(e)}})}).on('error',reject)});
(async()=>{const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 const accepted=await submitIntent('test generic metadata','hs3-session',[],{clientRunId:'hs3-terminal-error'});
 assert.equal(accepted.state,'failed');assert.deepEqual(accepted.presentation,closed);assert.deepEqual(accepted.failure,closed.failure);
 const duplicate=await submitIntent('test generic metadata','hs3-session',[],{clientRunId:'hs3-terminal-error'});assert.equal(duplicate.duplicate,true);assert.deepEqual(duplicate.presentation,closed);
 const started=performance.now(),response=await request(server.address().port,accepted.runId);assert.equal(response.status,200);assert.deepEqual(response.body.presentation,closed);assert.deepEqual(response.body.understood,closed.understood);assert.ok(performance.now()-started<4000);
 const file=path.join(root,'clawmobile-companion/runs.json');const state=JSON.parse(fs.readFileSync(file));assert.deepEqual(state.runs[0].presentation,closed);
 // A fresh process validates persisted metadata, not just the in-memory object.
 const fresh=cp.spawnSync(process.execPath,['-e',`const a=require(${JSON.stringify(path.resolve(__dirname,'../dist/companion/runs'))});a.getRunStatus(${JSON.stringify(accepted.runId)}).then(s=>{if(!s.presentation||s.presentation.effect.debited!=='unknown'||s.failure.stepId!=='execution_error'||s.failure.notDone.code!=='unknown')process.exit(2);process.stdout.write('persisted-ok')}).catch(()=>process.exit(3))`],{env:{...process.env},encoding:'utf8',timeout:5000});assert.equal(fresh.status,0);assert.equal(fresh.stdout,'persisted-ok');
 state.runs[0].presentation={...closed,label:'ghp_abcdefghijklmnop'};fs.writeFileSync(file,JSON.stringify(state));
 const invalid=cp.spawnSync(process.execPath,['-e',`require(${JSON.stringify(path.resolve(__dirname,'../dist/companion/runs'))}).getRunStatus(${JSON.stringify(accepted.runId)}).then(s=>{if(s.presentation)process.exit(2);process.stdout.write('rejected-ok')})`],{env:{...process.env},encoding:'utf8',timeout:5000});assert.equal(invalid.status,0);assert.equal(invalid.stdout,'rejected-ok');
 console.log(JSON.stringify({suite:'hs3-run-transport',captureMetadata:true,httpResponses:1,persisted:true}));
}finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}})().catch(()=>{console.error('hs3_run_transport_failed');process.exit(1)});

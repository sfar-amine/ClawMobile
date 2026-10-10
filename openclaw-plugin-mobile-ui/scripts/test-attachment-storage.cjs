const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'attachment-tests-'));process.env.CLAWMOBILE_ATTACHMENT_DIR=path.join(root,'attachments');process.env.OPENCLAW_STATE_DIR=path.join(root,'state');
 const storage=require('../dist/companion/attachmentStorage');const text=(id,body=Buffer.from('plain text'))=>({id,mimeType:'text/plain',body});const png=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);
 try{
 assert.throws(()=>storage.saveAttachments([text('large',Buffer.alloc(storage.MAX_ATTACHMENT_BYTES+1))],new Set()),/attachment_too_large/);
 assert.throws(()=>storage.saveAttachments(Array.from({length:6},(_,i)=>text('n'+i)),new Set()),/attachment_share_limit/);
 assert.throws(()=>storage.saveAttachments([text('quota')],new Set(),Date.now(),1),/attachment_quota_exceeded/);
 assert.throws(()=>storage.saveAttachments([{id:'fake',mimeType:'image/png',body:Buffer.from('<html>fake</html>')}],new Set()),/attachment_type_mismatch/);
 assert.throws(()=>storage.saveAttachments([text('html',Buffer.from('<html>fake</html>'))],new Set()),/attachment_type_mismatch/);
 const saved=storage.saveAttachments([text('valid'),{id:'image',mimeType:'image/png',body:png}],new Set());assert.equal(fs.statSync(saved[0].path).mode&0o777,0o600);
 assert.throws(()=>storage.saveAttachments([text('valid')],new Set()),/attachment_id_collision/);
 let fd=storage.attachmentContent('valid');assert.equal(fd.mime,'text/plain');fs.closeSync(fd.fd);
 const old=storage.saveAttachments([text('old'),text('protected')],new Set());for(const x of old)fs.utimesSync(x.path,new Date(0),new Date(0));
 storage.saveAttachments([text('next')],new Set([old[1].path]));assert.ok(!fs.existsSync(old[0].path));assert.ok(fs.existsSync(old[1].path));
 const runs=require('../dist/companion/runs');const dir=path.join(process.env.OPENCLAW_STATE_DIR,'clawmobile-companion');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'runs.json'),JSON.stringify({version:1,runs:[{runId:'test-delete',sessionId:'test-session',state:'done',acceptedAt:Date.now(),attachments:[saved[0]]}],archivedSessionIds:[],ownerConfirmations:[],paymentRequests:[],runDeletions:[]}));
 const result=await runs.deleteRun('test-delete','delete-operation');assert.equal(result.state,'completed');assert.ok(!fs.existsSync(saved[0].path));assert.equal((await runs.deleteRun('test-delete','delete-operation')).receipt.operationId,'delete-operation');
 console.log('Attachment signatures, limits, quota, retention, collision, mode, protected files and R3 cleanup passed');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

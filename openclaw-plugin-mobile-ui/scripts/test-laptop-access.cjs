const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'laptop-owner-'));process.env.SAMANTHA_CONTROL_HOME=root;process.env.OPENCLAW_STATE_DIR=path.join(root,'.openclaw');
 if(!process.env.SAMANTHA_CONTROL_PLAYBOOKS){
  process.env.SAMANTHA_CONTROL_PLAYBOOKS=root;fs.mkdirSync(path.join(root,'device'));
  fs.writeFileSync(path.join(root,'device/laptop_access.py'),`import json,os,sys,hashlib,time
from pathlib import Path
home=Path(os.environ['SAMANTHA_CONTROL_HOME']);body=json.load(sys.stdin);action=sys.argv[1];state=json.loads((home/'.openclaw/laptop-access/state.json').read_text());pair=next(iter(state['nativeAccess']['pairings'].values()));file=home/'.ssh/authorized_keys'
if body.get('slowProbe'):time.sleep(4)
if action=='pair-start':out={'success':True,'state':'waiting_pc','receipt':None}
elif action=='pair-status':out={k:v for k,v in pair.items() if k!='keyLine'};out.update(success=True,receipt=None)
elif action=='list':out={'success':True,'state':'ready','receipt':None,'computers':([{'id':pair['fingerprint'],'label':'Test-PC','payloadHash':pair['payloadHash'],'lastSeenAt':None}] if file.exists() else [])}
elif action=='pair-commit':
 registry=json.loads((home/'.openclaw/clawmobile-companion/runs.json').read_text());confirmation=next(r for r in registry['ownerConfirmations'] if r['id']==body['confirmationId']);assert confirmation['state']=='consumed';assert confirmation['intent']['action']=={'type':'laptop_access.authorize_key','reference':pair['pairingId'],'payloadHash':pair['payloadHash']};file.parent.mkdir(exist_ok=True);file.write_text(pair['keyLine']+'\\n');out={'success':True,'state':'committed','receipt':{'version':1,'operationId':body['operationId']}}
else:out={'success':False,'state':'refused','receipt':None}
print(json.dumps(out))
`);
 }

 const pairId='a'.repeat(32);const folder=path.join(root,'.openclaw/laptop-access');fs.mkdirSync(folder,{recursive:true});
 const blob=Buffer.concat([Buffer.from('0000000b','hex'),Buffer.from('ssh-ed25519'),Buffer.from('00000020','hex'),Buffer.alloc(32,7)]);
 const fingerprint='SHA256:'+crypto.createHash('sha256').update(blob).digest('base64').replace(/=/g,'');const line='ssh-ed25519 '+blob.toString('base64')+' samantha-pc:'+fingerprint.slice(7,15)+':Test-PC';const hash=crypto.createHash('sha256').update(line).digest('hex');
 fs.writeFileSync(path.join(folder,'state.json'),JSON.stringify({nativeAccess:{pairings:{[pairId]:{pairingId:pairId,state:'awaiting_owner',expiresAt:Date.now()+600000,attempts:0,keyLine:line,label:'Test-PC',fingerprint,payloadHash:hash}},operations:{}}}));
 const state=path.join(root,'.openclaw/clawmobile-companion');fs.mkdirSync(state,{recursive:true});const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});fs.writeFileSync(path.join(state,'owner-confirmation-public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));const paymentFixture=[{id:'payment-fixture',state:'requires_bank_action',draft:{origin:{id:'bank-run'}}}];fs.writeFileSync(path.join(state,'runs.json'),JSON.stringify({version:1,runs:[],archivedSessionIds:[],ownerConfirmations:[],paymentRequests:paymentFixture,runDeletions:[]}));
 const {confirmations}=require('../dist/companion/confirmations');const api=require('../dist/companion/laptopAccess');
 const prepare=async(type,reference,payloadHash)=>{let record=await confirmations.prepare({requestKey:crypto.randomUUID(),action:{type,reference,payloadHash},presentation:{title:'Accès PC',subtitle:'Test local',description:'Autoriser cette clé'},origin:{channel:'samantha',id:'fixture'}});const challenge=await confirmations.challenge(record.requestId);await confirmations.confirm(record.requestId,{keyId:challenge.keyId,nonce:challenge.nonce,bindingHash:challenge.bindingHash,signature:crypto.sign('sha256',Buffer.from(challenge.challenge),keys.privateKey).toString('base64')});return record;};
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const request=(method,url,body,headers={})=>new Promise(resolve=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.end(body?JSON.stringify(body):undefined);});
 try{
 assert.equal((await request('POST','/v1/laptop-access/pairings',{operationId:'bad'})).status,403);
 const other=await prepare('payment.authorize','payment-ref',hash);let refused=await api.laptopChange('commit',pairId,{operationId:'wrong-scope',confirmationId:other.requestId});assert.equal(refused.state,'refused');assert.ok(!fs.existsSync(path.join(root,'.ssh/authorized_keys')));assert.equal((await confirmations.status(other.requestId)).state,'approved');
 const approved=await prepare('laptop_access.authorize_key',pairId,hash);
 // A laptop approval cannot be consumed as a payment approval.
 await assert.rejects(confirmations.consume(approved.requestId,{...approved.intent,action:{...approved.intent.action,type:'payment.authorize'}}));
 const first=await api.laptopChange('commit',pairId,{operationId:'authorize',confirmationId:approved.requestId});assert.equal(first.state,'committed');assert.equal((await confirmations.status(approved.requestId)).state,'consumed');
 const content=fs.readFileSync(path.join(root,'.ssh/authorized_keys'));assert.equal(content.toString(),line+'\n');assert.deepEqual(await api.laptopChange('commit',pairId,{operationId:'authorize',confirmationId:approved.requestId}),first);assert.deepEqual(fs.readFileSync(path.join(root,'.ssh/authorized_keys')),content);
 const list=await request('GET','/v1/laptop-access/computers');assert.equal(list.status,200);assert.equal(list.body.computers[0].lastSeenAt,null);assert.equal((await api.laptopChange('revoke',fingerprint,{operationId:'last-key',confirmationId:approved.requestId})).state,'refused');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'runs.json'))).paymentRequests,paymentFixture);
 if(process.env.SAMANTHA_CONTROL_PLAYBOOKS===root){
 const started=Date.now();assert.equal((await api.laptopOwner('pair-start',{slowProbe:true})).state,'waiting_pc');assert.ok(Date.now()-started>=3900);
 const readStart=Date.now();await assert.rejects(api.laptopOwner('list',{slowProbe:true}),/laptop_owner_indeterminate/);assert.ok(Date.now()-readStart<3900);
 }
 console.log('P2-f paired controller, signed biometric consumption, cross-domain isolation, replay and HTTP owner boundaries passed');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

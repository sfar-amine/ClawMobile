const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'whatsapp-allowlist-'));process.env.OPENCLAW_STATE_DIR=path.join(root,'.openclaw');
 const hash=text=>crypto.createHash('sha256').update(text).digest('hex'),id=number=>'wa-'+hash(number).slice(0,16),ownerNumber='+12025550001',number='+12025550002',ownerId=id(ownerNumber),contactId=id(number);
 const file=path.join(root,'fixture.json'),helper=path.join(root,'people-trusted.py');process.env.SAMANTHA_PEOPLE_TRUSTED=helper;
 const item=(e164,owner=false)=>({contactId:id(e164),e164,name:'Private Name',owner,scope:'standard',scopeText:null,state:'active',expiresAt:null,lastActivityAt:null,addedAt:new Date().toISOString()});
 fs.writeFileSync(file,JSON.stringify({items:[item(ownerNumber,true)],operations:{},effects:0,history:[],notes:{}}));
 fs.writeFileSync(helper,`import json,sys,os,hashlib,datetime
from pathlib import Path
p=Path(__file__).with_name('fixture.json');s=json.loads(p.read_text());a=sys.argv[2];b=json.load(sys.stdin);op=b.get('operationId');cid=b.get('contactId');c=next((c for c in s['items'] if c['contactId']==cid),None)
def out(v): print(json.dumps(v));raise SystemExit()
if a=='operation':
 if s.get('unavailable'):raise SystemExit(2)
 old=s['operations'].get(op)
 if old and old['hash']!=b['requestHash']:out({'success':False,'state':'refused','receipt':None,'reason':'operation_conflict'})
 out(old['result'] if old else {'success':False,'state':'not_found','receipt':None})
if a=='prepare':
 actual=b['action'];body=b['body'];op=body['operationId'];c=next((c for c in s['items'] if c['contactId']==body['contactId']),None);old=s['operations'].get(op);claim=None
 if body.get('confirmationId') and not (actual=='add' and c):
  records=json.loads((Path(os.environ['OPENCLAW_STATE_DIR'])/'clawmobile-companion/runs.json').read_text())['ownerConfirmations'];r=next(r for r in records if r['id']==body['confirmationId']);intent=r['intent']['action'];claim={'operationId':op,'requestHash':body['requestHash'],'confirmationId':body['confirmationId'],'type':intent['type'],'reference':intent['reference'],'payloadHash':intent['payloadHash']}
 result={'success':False,'state':'failed','receipt':None,'retryable':True};s['operations'][op]={'hash':body['requestHash'],'result':result};p.write_text(json.dumps(s));out({'success':True,'state':'prepared','receipt':None,'confirmationClaim':claim,'allowConsumedRetry':bool(old)})
if a=='list':out({'success':True,'state':'ok','receipt':None,'items':s['items'],'issues':[]})
if a=='get' and s.get('getUnavailable'):out({'success':False,'state':'failed','receipt':None,'reason':'contacts_unavailable'})
if a=='get':out({'success':True,'state':'ok','receipt':None,'contact':c,'historyCount':len(s['history'])} if c else {'success':False,'state':'not_found','receipt':None,'reason':'unknown_contact'})
if a=='history':out({'success':True,'state':'ok','receipt':None,'items':s['history'][:b.get('limit',50)],'nextBefore':None})
if a=='note-get':out({'success':True,'state':'ok','receipt':None,'text':s['notes'].get(cid,''),'updatedAt':None})
if b.get('confirmationId') and not (a=='add' and c):
 records=json.loads((Path(os.environ['OPENCLAW_STATE_DIR'])/'clawmobile-companion/runs.json').read_text())['ownerConfirmations'];r=next(r for r in records if r['id']==b['confirmationId']);assert r['state']=='consumed';assert r['intent']['action']['reference']==cid
if op=='before-effect-raise' and not s.get('failedBeforeEffect'):
 s['failedBeforeEffect']=True;p.write_text(json.dumps(s));raise SystemExit(2)
now=datetime.datetime.now(datetime.timezone.utc).isoformat();state='updated';history=None
if a=='add':
 if c:state='already_present'
 else:
  c={'contactId':cid,'e164':b['e164'],'name':b.get('displayName'),'owner':False,'scope':b['scope'],'scopeText':b.get('scopeText'),'state':'active','expiresAt':None,'lastActivityAt':None,'addedAt':now};s['items'].append(c);state='added';history='added'
elif a=='remove':
 state='removed' if c else 'already_absent'
 if c:s['items'].remove(c);history='removed'
elif a=='scope':c['scope']=b.get('scope',c['scope']);c['scopeText']=b.get('scopeText');history='scope_changed'
elif a=='suspend':c['state']='suspended';state='suspended';history='suspended'
elif a=='reactivate':c['state']='active';state='reactivated';history='reactivated'
elif a=='expiry':c['expiresAt']=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=b['durationDays'])).isoformat() if b['durationDays'] else None;history='extended'
elif a=='note':s['notes'][cid]=b['text'];history='note_updated'
if history:s['effects']+=1;s['history'].append({'at':now,'action':history,'contactId':cid,'name':'Private Name','e164':c['e164'] if c else 'secret','text':'private note'})
result={'success':True,'state':state,'receipt':{'version':1,'operationId':op,'action':{'add':'added','remove':'removed','scope':'scope_changed','suspend':'suspended','reactivate':'reactivated','expiry':'extended','note':'note_updated'}[a],'contactId':cid,'state':state,'at':now}};s['operations'][op]={'hash':b['requestHash'],'result':result};p.write_text(json.dumps(s))
if op.startswith('uncertain'):raise SystemExit(2)
out(result)
`);
 const stateDir=path.join(process.env.OPENCLAW_STATE_DIR,'clawmobile-companion');fs.mkdirSync(stateDir,{recursive:true});const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});fs.writeFileSync(path.join(stateDir,'owner-confirmation-public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
 const paymentFixture=[{id:'payment-fixture',state:'requires_bank_action',draft:{origin:{id:'bank-run'}}}];fs.writeFileSync(path.join(stateDir,'runs.json'),JSON.stringify({version:1,runs:[],archivedSessionIds:[],ownerConfirmations:[],paymentRequests:paymentFixture,runDeletions:[]}));
 const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 const {confirmations}=require('../dist/companion/confirmations');
 const approve=async(type,reference,payloadHash)=>{const record=await confirmations.prepare({requestKey:crypto.randomUUID(),action:{type:'whatsapp.allowlist_'+type,reference,payloadHash},presentation:{title:'Contact',subtitle:'Test fixture',description:'Confirmer action'},origin:{channel:'samantha',id:'fixture'}});const challenge=await confirmations.challenge(record.requestId);await confirmations.confirm(record.requestId,{keyId:challenge.keyId,nonce:challenge.nonce,bindingHash:challenge.bindingHash,signature:crypto.sign('sha256',Buffer.from(challenge.challenge),keys.privateKey).toString('base64')});return record.requestId;};
 const {route}=require('../dist/companion/server');const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='/v1/whatsapp/allowlist',headers={'content-type':'application/json','x-clawmobile-owner-flow':'v1'};
 const request=(method,url,body,custom=headers,raw)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers:{...custom,...(body?{'content-length':Buffer.byteLength(raw||JSON.stringify(body))}:{})}},res=>{let value='';res.on('data',x=>value+=x);res.on('end',()=>{if(!value)return reject(new Error(method+' '+url+' empty HTTP '+res.statusCode));resolve({status:res.statusCode,body:JSON.parse(value)});});});req.on('error',reject);req.end(raw||(body?JSON.stringify(body):undefined));});
 const effect=()=>JSON.parse(fs.readFileSync(file)).effects;
 try{
 assert.equal((await request('POST',base,{},{})).status,403);assert.equal((await request('GET',base,undefined,{Origin:'https://foreign.invalid'})).status,403);assert.equal((await request('GET',base+'?extra=1')).status,400);assert.equal((await request('GET',base+'/history?limit=51')).status,400);
 let body={operationId:'add-first',e164:number,displayName:'Private Name',scope:'standard',durationDays:null,notify:false};
 assert.equal((await request('POST',base,{...body,e164:'2025550002'})).body.reason,'country_code_required');assert.equal((await request('POST',base,{...body,e164:'+0123456789'})).body.reason,'invalid_e164');assert.equal((await request('POST',base,{...body,durationDays:2})).body.reason,'invalid_duration');assert.equal((await request('POST',base,{...body,scope:'custom'})).body.reason,'invalid_scope');
 assert.equal((await request('POST',base,body)).body.reason,'confirmation_required');assert.equal(effect(),0);
 const addHash=hash(number+'|standard||permanent');for(const [type,ref,payload] of [['remove',contactId,addHash],['add',ownerId,addHash],['add',contactId,hash('wrong')]]){const confirmationId=await approve(type,ref,payload);assert.equal((await request('POST',base,{...body,confirmationId})).body.reason,'confirmation_mismatch');assert.equal((await confirmations.status(confirmationId)).state,'approved');}
 const expired=await approve('add',contactId,addHash);now+=120001;assert.equal((await request('POST',base,{...body,confirmationId:expired})).body.reason,'confirmation_expired');now=originalNow();
 body.confirmationId=await approve('add',contactId,addHash);const before=effect(),parallel=await Promise.all(Array.from({length:3},()=>request('POST',base,body)));assert.equal(parallel[0].status,200);assert.equal(parallel[0].body.state,'added');assert.equal(effect(),before+1);assert.deepEqual(parallel[1].body,parallel[0].body);assert.equal((await confirmations.status(body.confirmationId)).state,'consumed');assert.deepEqual((await request('POST',base,body)).body,parallel[0].body);assert.equal((await request('POST',base,{...body,notify:true})).status,409);
 const again={...body,operationId:'add-again',confirmationId:await approve('add',contactId,addHash)};assert.equal((await request('POST',base,again)).body.state,'already_present');assert.equal(effect(),before+1);assert.equal((await confirmations.status(again.confirmationId)).state,'approved');
 const retryProof=await approve('raise',contactId,hash(number+'|claw|'));const retryBody={operationId:'before-effect-raise',scope:'claw',confirmationId:retryProof};const retryEffects=effect();assert.equal((await request('PATCH',base+'/'+contactId,retryBody)).status,503);assert.equal(effect(),retryEffects);assert.equal((await confirmations.status(retryProof)).state,'consumed');assert.equal((await request('PATCH',base+'/'+contactId,retryBody)).status,200);assert.equal(effect(),retryEffects+1);assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'reset-after-retry',scope:'standard'})).status,200);assert.equal((await request('PATCH',base+'/'+contactId,{...retryBody,operationId:'different-op-consumed'})).status,403);
 let patch={operationId:'raise',scope:'claw'};assert.equal((await request('PATCH',base+'/'+contactId,patch)).status,403);patch.confirmationId=await approve('raise',contactId,hash(number+'|claw|'));assert.equal((await request('PATCH',base+'/'+contactId,patch)).body.state,'updated');
 assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'custom-raise',scope:'custom',scopeText:'Limit runtime'})).status,403);const customId=await approve('raise',contactId,hash(number+'|custom|Limit runtime'));assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'custom-raise',scope:'custom',scopeText:'Limit runtime',confirmationId:customId})).status,200);
 assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'custom-change',scopeText:'Different limit'})).status,403);const textId=await approve('raise',contactId,hash(number+'|custom|Different limit'));assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'custom-change',scopeText:'Different limit',confirmationId:textId})).status,200);
 assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'lower',scope:'standard'})).status,200);assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'suspend',state:'suspended'})).body.state,'suspended');
 assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'reactivate',state:'active'})).body.reason,'confirmation_required');const reactivate=await approve('reactivate',contactId,hash(number+'|standard|'));assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'reactivate',state:'active',confirmationId:reactivate})).body.state,'reactivated');
 assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'shorten',durationDays:1})).status,200);assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'extend',durationDays:3})).status,403);const extend=await approve('extend',contactId,hash(number+'|3'));assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'extend',durationDays:3,confirmationId:extend})).status,200);
 assert.equal((await request('PATCH',base+'/'+ownerId,{operationId:'suspend-owner',state:'suspended'})).body.reason,'owner_contact_protected');assert.equal((await request('PATCH',base+'/'+ownerId,{operationId:'temporary-owner',durationDays:1})).status,409);assert.equal((await request('DELETE',base+'/'+ownerId,{operationId:'remove-owner'})).status,409);
 assert.equal((await request('PATCH',base+'/'+contactId,{operationId:'two-types',state:'active',durationDays:null})).status,400);assert.equal((await request('PUT',base+'/'+contactId+'/note',{operationId:'bad-note',text:'x'.repeat(2001)})).body.reason,'note_too_long');assert.equal((await request('PUT',base+'/'+contactId+'/note',{operationId:'control-note',text:'bad\ntext'})).status,400);
 assert.equal((await request('PUT',base+'/'+contactId+'/note',{operationId:'note',text:'Private note text'})).status,200);assert.equal((await request('GET',base+'/'+contactId+'/note')).body.text,'Private note text');
 let unavailable=JSON.parse(fs.readFileSync(file));unavailable.getUnavailable=true;fs.writeFileSync(file,JSON.stringify(unavailable));const failed=await request('PUT',base+'/'+contactId+'/note',{operationId:'preflight-retry',text:'Retry note'});assert.equal(failed.status,503);assert.equal(failed.body.error,'allowlist_unavailable');unavailable.getUnavailable=false;fs.writeFileSync(file,JSON.stringify(unavailable));assert.equal((await request('PUT',base+'/'+contactId+'/note',{operationId:'preflight-retry',text:'Retry note'})).status,200);
 assert.equal((await request('PUT',base+'/'+contactId+'/note',{operationId:'unicode-note',text:'😀'.repeat(2000)})).status,200);const escaped='{'+'\"operationId\":\"escaped-unicode-note\",\"text\":\"'+String.raw`\uD83D\uDE00`.repeat(2000)+'\"}';assert.equal((await request('PUT',base+'/'+contactId+'/note',{},headers,escaped)).status,200);assert.equal((await request('PUT',base+'/'+contactId+'/note',{operationId:'too-many-codepoints',text:'😀'.repeat(2001)})).body.reason,'note_too_long');assert.equal((await request('PUT',base+'/'+contactId+'/note',{},headers,' '.repeat(32769))).status,400);
 const uncertain=await request('PUT',base+'/'+contactId+'/note',{operationId:'uncertain-note',text:'Second private note'});assert.equal(uncertain.status,200);assert.equal(uncertain.body.state,'updated');const count=effect();assert.deepEqual((await request('PUT',base+'/'+contactId+'/note',{operationId:'uncertain-note',text:'Second private note'})).body,uncertain.body);assert.equal(effect(),count);
 const history=await request('GET',base+'/history');assert.ok(!JSON.stringify(history).includes(number));assert.ok(!JSON.stringify(history).includes('Private Name'));assert.ok(!JSON.stringify(history).includes('private note'));assert.ok(history.body.items.every(row=>row.name===null&&!('text' in row)));
 const removal=await approve('remove',contactId,hash(number));assert.equal((await request('DELETE',base+'/'+contactId,{operationId:'remove',confirmationId:removal})).body.state,'removed');assert.equal((await request('DELETE',base+'/'+contactId,{operationId:'remove-again',confirmationId:removal})).body.state,'already_absent');
 const registry=JSON.parse(fs.readFileSync(path.join(stateDir,'runs.json')));assert.deepEqual(registry.paymentRequests,paymentFixture);assert.equal(registry.runs.length,0);assert.equal((await request('GET',base)).body.items.length,1);
 console.log('R17: owner HTTP, strict numbers, complete biometric matrix, linked/expired proofs, single-flight/replay/conflict, private notes/history, uncertain readback, and untouched payment/history passed');
 }finally{Date.now=originalNow;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});

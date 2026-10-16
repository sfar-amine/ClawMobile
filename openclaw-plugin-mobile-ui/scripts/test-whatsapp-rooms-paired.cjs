const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r17-rooms-'));process.env.OPENCLAW_STATE_DIR=path.join(root,'state');
 const owner='+12025550101',other='+12025550102',number='+12025550103',hash=x=>crypto.createHash('sha256').update(x).digest('hex'),id=x=>'wa-'+hash(x).slice(0,16),cid=id(number);
 const canonical=process.env.SAMANTHA_ALLOWLIST_CANONICAL||path.resolve(__dirname,'../../installer/termux-lite/people-trusted.py');
 const helper=path.join(root,'wrapper.py'),config=path.join(root,'config.json');process.env.SAMANTHA_PEOPLE_TRUSTED=helper;
 const wildcard={agentId:'contacts',match:{channel:'whatsapp',accountId:'*',peer:{kind:'direct',id:'*'}}};const original={commands:{ownerAllowFrom:['whatsapp:'+owner]},agents:{entries:{main:{},contacts:{},'contacts-projet':{}}},bindings:[{agentId:'main',match:{channel:'whatsapp',accountId:'*',peer:{kind:'direct',id:owner}}},wildcard],channels:{whatsapp:{allowFrom:[other,owner],direct:{'*':{systemPrompt:'Shared policy'}}}}};fs.writeFileSync(config,JSON.stringify(original));
 fs.writeFileSync(path.join(root,'counter.json'),JSON.stringify({patches:0,messages:0}));
 fs.writeFileSync(helper,`import importlib.util,json,sys,hashlib,copy
from pathlib import Path
root=Path(__file__).parent;spec=importlib.util.spec_from_file_location('real_people',${JSON.stringify(canonical)});m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.ROOT=root/'people';m.DB=m.ROOT/'directory.db';m.CONTACTS=root/'workspace/memory/whatsapp/contacts';m.CONFIG=root/'config.json';m.SESSION_DB=root/'sessions.sqlite'
def gw(method,params=None,timeout_ms=7000):
 before=m.CONFIG.read_text();cfg=json.loads(before);revision=hashlib.sha256(before.encode()).hexdigest()
 if method=='config.get':return {'config':cfg,'hash':revision}
 if method!='config.patch':raise RuntimeError('unsupported fixture method')
 assert params['baseHash']==revision
 raw=json.loads(params['raw']);fields=raw['channels']['whatsapp'];cfg['channels']['whatsapp'].update(fields)\n if 'bindings' in raw:cfg['bindings']=raw['bindings']\n m.CONFIG.write_text(json.dumps(cfg));count=json.loads((root/'counter.json').read_text());count['patches']+=1;(root/'counter.json').write_text(json.dumps(count));return {'config':cfg}
def send(*args):
 count=json.loads((root/'counter.json').read_text());count['messages']+=1;(root/'counter.json').write_text(json.dumps(count));raise AssertionError('silent operation sent a message')
m.gateway_call=gw;m.whatsapp_send=send
original_write=m.Contacts.write_context
def write_context(self,*args,**kwargs):
 flag=root/'fail-before-effect'
 if flag.exists():flag.unlink();raise OSError('fixture before effect')
 return original_write(self,*args,**kwargs)
m.Contacts.write_context=write_context
try:result=m.Contacts(m._ExistingPeopleOwner(),state_dir=root/'state').call(sys.argv[2],json.load(sys.stdin))
except m.Refused as error:result={'success':False,'state':'refused','receipt':None,'reason':error.code,'statusCode':error.status}
except Exception:result={'success':False,'state':'failed','receipt':None,'statusCode':503}
print(json.dumps(result))
`);
 const stateDir=path.join(process.env.OPENCLAW_STATE_DIR,'clawmobile-companion');fs.mkdirSync(stateDir,{recursive:true});const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});fs.writeFileSync(path.join(stateDir,'owner-confirmation-public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));const payment=[{id:'bank-private',state:'requires_bank_action',draft:{origin:{id:'bank-run'}}}];fs.writeFileSync(path.join(stateDir,'runs.json'),JSON.stringify({version:1,runs:[],archivedSessionIds:[],ownerConfirmations:[],paymentRequests:payment,runDeletions:[]}));
 const {confirmations}=require('../dist/companion/confirmations'),{route}=require('../dist/companion/server');
 const approve=async(type,payloadHash,reference=cid)=>{const record=await confirmations.prepare({requestKey:crypto.randomUUID(),action:{type:'whatsapp.allowlist_'+type,reference,payloadHash},presentation:{title:'Contact',subtitle:'Fixture réelle',description:'Mutation liée'},origin:{channel:'samantha',id:'fixture'}});const challenge=await confirmations.challenge(record.requestId);await confirmations.confirm(record.requestId,{keyId:challenge.keyId,nonce:challenge.nonce,bindingHash:challenge.bindingHash,signature:crypto.sign('sha256',Buffer.from(challenge.challenge),keys.privateKey).toString('base64')});return record.requestId;};
 let consumes=0;const originalConsume=confirmations.consume;confirmations.consume=async(...args)=>{consumes++;return originalConsume(...args);};
 const server=http.createServer((req,res)=>route(req,res).catch(()=>{res.writeHead(500);res.end('{}')}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='/v1/whatsapp/allowlist';
 const request=(method,suffix='',body)=>new Promise((resolve,reject)=>{const bytes=body?JSON.stringify(body):undefined;const req=http.request({host:'127.0.0.1',port:server.address().port,path:base+suffix,method,headers:{'x-clawmobile-owner-flow':'v1','content-type':'application/json',...(bytes?{'content-length':Buffer.byteLength(bytes)}:{})}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}));});req.on('error',reject);req.end(bytes);});
 const counters=()=>JSON.parse(fs.readFileSync(path.join(root,'counter.json'))),readConfig=()=>JSON.parse(fs.readFileSync(config));
 try{
 const input={operationId:'rooms-add',e164:number,scope:'standard',durationDays:null,notify:false};input.confirmationId=await approve('add',hash(number+'|standard||permanent'));assert.equal((await request('POST','',input)).status,200);
 assert.deepEqual((await request('GET')).body.items.find(x=>x.contactId===cid).rooms,['conversation']);
 assert.equal((await request('PATCH','/'+cid,{operationId:'rooms-unconfirmed',rooms:['projet']})).status,403);
 const grant=await approve('rooms',hash(number+'|conversation|projet'));const granted=await request('PATCH','/'+cid,{operationId:'rooms-projet',rooms:['projet'],confirmationId:grant});
 assert.equal(granted.status,200,JSON.stringify(granted.body));assert.equal(granted.body.receipt.action,'rooms_changed');
 const routed=readConfig().bindings.map(b=>[b.agentId,b.match.peer.id]);assert.deepEqual(routed,[['main',owner],['contacts-projet',number],['contacts','*']]);
 assert.deepEqual((await request('GET')).body.items.find(x=>x.contactId===cid).rooms,['conversation','projet']);
 const refused=await request('PATCH','/'+cid,{operationId:'rooms-agenda',rooms:['agenda']});assert.equal(refused.status,409,JSON.stringify(refused.body));assert.equal(refused.body.reason,'room_not_available');
 const owned=await request('PATCH','/'+id(owner),{operationId:'rooms-owner',rooms:['projet']});assert.equal(owned.status,409);
 const narrowed=await request('PATCH','/'+cid,{operationId:'rooms-narrow',rooms:['conversation']});assert.equal(narrowed.status,200,JSON.stringify(narrowed.body));
 assert.deepEqual(readConfig().bindings,original.bindings);assert.equal(counters().messages,0);
 console.log('R17 rooms paired HTTP → actual Contacts owner: biometric widening, routed binding before wildcard, unenforced room and owner refused, free narrowing passed');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});

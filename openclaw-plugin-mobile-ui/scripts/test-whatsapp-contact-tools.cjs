const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createContactTool,contactToolCaller}=require('../dist/contactTools.js');
const {handleWhatsAppAccessBeforeDispatch}=require('../dist/whatsappAccessFastPath.js');

(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'contact-tools-'));
 const helper=path.join(dir,'helper.py'),capture=path.join(dir,'capture.json');
 fs.writeFileSync(helper,`import json,os,sys\nb=json.load(sys.stdin);open(os.environ['CAPTURE'],'w').write(json.dumps(b));print(json.dumps({'success':True,'state':'completed','receipt':{'operationId':b['operationId']}}))\n`);
 process.env.SAMANTHA_PEOPLE_TRUSTED=helper;process.env.CAPTURE=capture;
 const ctx={agentId:'contacts',sessionKey:'agent:contacts:whatsapp:direct:+21612345678',messageId:'m1'};
 assert.deepEqual(contactToolCaller(ctx),{agent:'contacts',e164:'+21612345678'});
 let out=await createContactTool('transmettre_a_amine',ctx).execute('call',{text:'Bonjour Amine'});
 assert.equal(JSON.parse(out.content[0].text).success,true);let sent=JSON.parse(fs.readFileSync(capture));
 assert.equal(sent.e164,'+21612345678');assert.equal(sent.action,'transmettre_a_amine');assert.equal(Object.hasOwn(sent,'contactId'),false);
 out=await createContactTool('noter_contact',{agentId:'main',sessionKey:'agent:main:whatsapp:direct:+21612345678'}).execute('call',{text:'secret'});
 assert.equal(JSON.parse(out.content[0].text).reason,'contact_tool_not_allowed');

 const item={contactId:'wa-1234567890abcdef',name:'Mehdi',owner:false,state:'active',rooms:['conversation','projet']};
 const deps={owners:()=>new Set(['+21611111111']),read:async()=>({items:[item]}),change:async(kind,id,input)=>({value:{success:true},kind,id,input})};
 const event={messageId:'x1',content:'liste mes contacts WhatsApp',channel:'whatsapp',sessionKey:'agent:main:whatsapp:direct:+21611111111'};
 let result=await handleWhatsAppAccessBeforeDispatch(event,{},deps);assert.equal(result.handled,true);assert.match(result.text,/Mehdi : conversation, projet/);
 event.content="retire le projet à Mehdi";let called;deps.change=async(...args)=>(called=args,{value:{success:true}});
 result=await handleWhatsAppAccessBeforeDispatch(event,{},deps);assert.equal(result.handled,true);assert.deepEqual(called[2].rooms,['conversation']);
 event.content="donne à Mehdi la pièce maison";deps.change=async()=>{let e=Error('confirmation_required');e.statusCode=403;throw e};
 result=await handleWhatsAppAccessBeforeDispatch(event,{},deps);assert.match(result.text,/biométrie/);
 event.content='raconte une blague';result=await handleWhatsAppAccessBeforeDispatch(event,{},deps);assert.equal(result.handled,false);
 console.log('whatsapp contact tools: PASS');
})().catch(e=>{console.error(e);process.exit(1)});

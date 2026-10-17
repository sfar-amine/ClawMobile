const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createContactTool,contactToolCaller}=require('../dist/contactTools.js');

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

 // The owner WhatsApp access commands (regex pre-router) are not shipped: AGENTS.md rule 8 (17/10 review of #261).
 assert.equal(fs.existsSync(path.join(__dirname,'../dist/whatsappAccessFastPath.js')),false);
 console.log('whatsapp contact tools: PASS');
})().catch(e=>{console.error(e);process.exit(1)});

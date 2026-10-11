const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {projectModelRoles}=require('../dist/companion/providers');
const {configuredModelAllow}=require('../dist/companion/modelOwner');
const capture=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-10/ui-recette/gateway.config.get.json'),'utf8'));
assert.equal(capture._capture.sanitized,true);
const before=JSON.stringify(capture.response.config);
const roles=projectModelRoles({config:capture.response.config,auth:{providers:[]},catalog:{models:[]},revision:null,updatedAt:0});
const conversation=roles.find(row=>row.id==='conversation');
const raw=capture.response.config.agents.entries.main.model;
assert.equal(conversation.model,(typeof raw==='string'?raw:raw.primary).split('@')[0]);
assert.ok(roles.length<=12);assert.equal(roles.find(row=>row.id==='realtime_voice').state,'unavailable');
assert.equal(roles.find(row=>row.id==='routing').state,'deterministic');
assert.equal(roles.find(row=>row.id==='spoken_voice').model,null);
assert.equal(JSON.stringify(capture.response.config),before);
// Explicit synthetic negative: public projection must drop private account identifiers and secrets.
const synthetic={config:{agents:{entries:{main:{model:{primary:'openai/synthetic@private-account',fallbacks:['openai/synthetic@private-account','sk-synthetic-private-token']}}}}},auth:{providers:[]}};
assert.ok(!JSON.stringify(projectModelRoles(synthetic)).includes('private-account'));
assert.ok(!JSON.stringify(projectModelRoles(synthetic)).includes('sk-synthetic-private-token'));
assert.deepEqual(configuredModelAllow({agents:{defaults:{modelPolicy:{allow:['openai/gpt-5.6-terra']}}}}),['openai/gpt-5.6-terra']);
assert.deepEqual(configuredModelAllow({agents:{entries:{main:{modelPolicy:{allow:[]}}},defaults:{modelPolicy:{allow:['openai/gpt-5.6-terra']}}}}),[]);
assert.deepEqual(configuredModelAllow({agents:{entries:{main:{modelPolicy:{allow:null}}},defaults:{modelPolicy:{allow:['openai/synthetic']}}}}),[]);
assert.equal(projectModelRoles({config:{talk:{realtime:{model:{malformed:true}}}},auth:{providers:[]}}).find(row=>row.id==='realtime_voice').state,'unavailable');
console.log('R1 model roles: real S24 config, unknown sources refused, deterministic contracts, bounded projection and source immutability passed');

// PR170 a75955f8: exact cleaned capture, dotted path projection reconstructed
// only for feeding the existing projector; no provider/model values invented.
const fresh=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/lot-r/config-models-projection.json'),'utf8'));
assert.equal(fresh._capture.sanitized,true);
const freshConfig={agents:{defaults:fresh['agents.defaults'],entries:{main:fresh['agents.entries.main'],'engineering-lite':fresh['agents.entries.engineering-lite'],gemini:fresh['agents.entries.gemini']}},talk:{...fresh.talk,realtime:fresh['talk.realtime']},memory:{search:fresh['memory.search']}};
const freshBefore=JSON.stringify(freshConfig);
const freshAuth=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/s24-2026-10-11/lot-r/models.authStatus.json'),'utf8'));
const freshRoles=projectModelRoles({config:freshConfig,auth:freshAuth.response});
const role=id=>freshRoles.find(row=>row.id===id);
assert.deepEqual(role('conversation').fallbacks,['openai/gpt-5.6-terra','openai/gpt-5.6-luna','google/gemini-3.5-flash-lite']);
assert.ok(!configuredModelAllow(freshConfig).includes('openai/gpt-5.6-terra'));
assert.equal(role('spoken_voice').model,'microsoft/fr-FR-DeniseNeural');
assert.equal(role('conversation_summary').model,'openai/gpt-5.6-luna');
for(const [id,provider] of [['realtime_voice','google'],['memory_search','gemini']]){assert.equal(role(id).provider,provider);assert.equal(role(id).state,'provider_default');assert.equal(role(id).model,null);assert.equal(role(id).source,'gateway_config');}
assert.equal(role('immune_system').verdictState,'unavailable');
assert.equal(role('copilot').state,'connected_not_used');
assert.equal(JSON.stringify(freshConfig),freshBefore);
assert.ok(!JSON.stringify(freshRoles).includes('owner@example.invalid'));
assert.equal(projectModelRoles({config:{talk:{realtime:{provider:'google',model:{bad:true}}}}}).find(row=>row.id==='realtime_voice').state,'unavailable');
console.log('R1 fresh PR170 capture: Terra fallback outside explicit main allow, configured spoken voice, Luna summary, provider defaults without invented models; immune verdict stays Health owner');

const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const fixture=require('../fixtures/s24-2026-10-26-native-sdk/google-schema-serializer.json');
const catalogue=require('../fixtures/s24-2026-10-25-typed-tools/compiled-agent-tools.json');
const {createTypedCapabilityTools}=require('../dist/typedCapabilityTools');
const tools=createTypedCapabilityTools({senderIsOwner:true,agentId:'main',sessionKey:'agent:main:companion-chat-authored'},
 {catalogue:catalogue.tools});assert(tools.length>0);
// The captured installed function owns the conversion. Only sorting/message conversion are inert dependencies.
const sandbox={sortPromptCacheToolsByName:items=>[...items].sort((a,b)=>a.name.localeCompare(b.name)),
 convertMessages:()=>[],sanitizeSurrogates:x=>x,stripSystemPromptCacheBoundary:x=>x,
 processJsonSchema(){throw Error('legacy Google Schema sanitizer must not run for parametersJsonSchema')}};
vm.createContext(sandbox);vm.runInContext(fixture.modules.map(m=>Object.values(m.functions).join('\n')).join('\n')+'\n'+fixture.genai.schema_map_source,sandbox);
const source=JSON.stringify(tools.map(t=>t.parameters));
const request=sandbox.buildGoogleGenerateContentParams({id:'authored-free-model',reasoning:false},{messages:[],tools},{});
const clean=v=>JSON.parse(JSON.stringify(v));
const declarations=request.config.tools.flatMap(t=>sandbox.tTool(t).functionDeclarations);
assert.equal(declarations.length,tools.length);
for(const tool of tools){
 const declaration=declarations.find(d=>d.name===tool.name);assert(declaration);
 assert.equal(Object.hasOwn(declaration,'parameters'),false);
 assert.deepEqual(clean(declaration.parametersJsonSchema),clean(tool.parameters));
 assert.equal(declaration.parametersJsonSchema.additionalProperties,false);
 if(tool.name!=='samantha_catalogue')assert(Array.isArray(declaration.parametersJsonSchema.properties.params.anyOf));
 else assert.equal(declaration.parametersJsonSchema.properties.query.type,'string');
 const mcp=sandbox.mcpToGeminiTool({name:tool.name,description:tool.description,inputSchema:tool.inputSchema});
 assert.deepEqual(clean(mcp.functionDeclarations[0].parametersJsonSchema),clean(tool.inputSchema));
}
assert.equal(JSON.stringify(tools.map(t=>t.parameters)),source,'neither serializer weakens or mutates backend schemas');
const union={type:'object',properties:{choice:{oneOf:[{type:'string'},{type:'number'}]}},additionalProperties:false};
const authored=sandbox.convertGoogleTools([{name:'authored_union',parameters:union}]);
assert.deepEqual(clean(sandbox.tTool(authored[0]).functionDeclarations[0].parametersJsonSchema),union);
assert.equal(sandbox.convertGoogleTools([]),undefined);
console.log('Google typed schema: installed @openclaw/ai → parametersJsonSchema → @google/genai preserves every canonical domain schema/anyOf/oneOf/closed objects PASS');

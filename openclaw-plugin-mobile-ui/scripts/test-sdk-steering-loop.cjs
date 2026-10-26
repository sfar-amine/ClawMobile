const assert=require('node:assert/strict'),vm=require('node:vm');
const fixture=require('../fixtures/s24-2026-10-26-native-sdk/steering-loop.json');
(async()=>{
 const queue=[],events=[],modelContexts=[];let begin,release;
 const started=new Promise(r=>begin=r),gate=new Promise(r=>release=r);
 const sandbox={getInternalSyncSteeringGetter:()=>undefined,isActiveTurnTainted:()=>false,
 toolResultTaintsTurn:()=>false,resolveAgentReasoningOption:()=>undefined,
 async streamAgentResponse(context){
  modelContexts.push(JSON.parse(JSON.stringify(context.messages)));
  if(modelContexts.length===1){begin();await gate;}
  return {message:{role:'assistant',content:[{type:'text',text:'authored-provider-response'}],stopReason:'stop'},
   executedIds:new Set(),batches:[],continuationRequired:false};
 }};
 vm.createContext(sandbox);vm.runInContext(Object.values(fixture.module.functions).join('\n'),sandbox);
 const original={role:'user',content:[{type:'text',text:'authored ongoing work'}]},stop={role:'user',content:[{type:'text',text:'authored later Stop'}]};
 const context={messages:[original],tools:[]};let ended=false;
 const config={getSteeringMessages:async()=>queue.splice(0),getFollowUpMessages:async()=>[],model:{id:'authored-model'}};
 const running=sandbox.runLoop({context},[],config,undefined,async event=>{
  events.push(event);if(event.type==='agent_end')ended=true;
 });
 await started;assert.equal(ended,false,'the original loop is still running when new owner input is queued');
 queue.push(stop);release();await running;
 assert.equal(modelContexts.length,2,'same loop calls the main provider with the newly consumed user input');
 assert.deepEqual(modelContexts[1],[original,stop],'existing context is retained; no isolated second interpreter');
 const injection=events.findIndex(e=>e.type==='message_end'&&e.message===stop),end=events.findIndex(e=>e.type==='agent_end');
 assert(injection>=0&&end>injection,'new input is committed before agent_end');
 assert.equal(events.filter(e=>e.type==='agent_end').length,1);
 console.log('SDK steering loop: captured installed loop consumes later user input with original context before agent_end; no automatic interrupt/self-abort PASS');
})().catch(e=>{console.error(e);process.exitCode=1});

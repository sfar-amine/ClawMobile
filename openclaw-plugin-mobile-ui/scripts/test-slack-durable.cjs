const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const tmpRoot = process.env.CLAW_TEST_TMPDIR || process.env.TMPDIR || path.join(os.homedir(), '.cache', 'tmp');
fs.mkdirSync(tmpRoot, {recursive:true});
const root = fs.mkdtempSync(path.join(tmpRoot, 'slack-durable-'));
const adapter = path.resolve(__dirname, '../../installer/termux-lite/claw-slack-bridge.mjs');
const rows = new Map(), posts = [], attempts = [], sockets = new Set();
let executions = 0, child, logs = '', seq = 0, history = [], posting = 'ok', wsPort;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 12000) { const start=Date.now(); while(Date.now()-start<ms) {if(fn())return;await wait(20);} throw new Error('timeout: '+logs); }
function json(res, value, code=200, headers={}) {res.writeHead(code, {'content-type':'application/json',...headers});res.end(JSON.stringify(value));}
function receipt(request) {return {requestId:request.requestId, method:request.method,
  paramsHash:crypto.createHash('sha256').update(JSON.stringify({method:request.method,params:request.params||{}})).digest('hex'),
  state:'completed', result:{success:true,stdout:'OK',exitCode:0}};}
const server=http.createServer((req,res)=>{
  let raw='';req.on('data',x=>raw+=x);req.on('end',()=>{
    const body=raw?JSON.parse(raw):{}, route=req.url;
    if(route==='/api/auth.test')return json(res,{ok:true,user_id:'BOT'});
    if(route==='/api/apps.connections.open')return json(res,{ok:true,url:`ws://127.0.0.1:${wsPort}`});
    if(route==='/api/conversations.history')return json(res,{ok:true,
      messages:body.cursor?history.slice(1):history.slice(0,1),
      has_more:!body.cursor&&history.length>1,
      response_metadata:{next_cursor:!body.cursor&&history.length>1?'page2':''}});
    if(route==='/api/chat.postMessage'){
      attempts.push({at:Date.now(),text:body.text});
      if(posting==='429')return json(res,{ok:false,error:'ratelimited'},429,{'retry-after':'1'});
      if(posting==='hang')return;
      posts.push(body);return json(res,{ok:true,ts:String(Date.now())});
    }
    if(route==='/bridge/requests' && req.method==='POST'){
      let row=rows.get(body.requestId);
      if(!row){row=receipt(body);rows.set(body.requestId,row);executions++;}
      else if(row.paramsHash!==receipt(body).paramsHash)return json(res,{error:'request_id_conflict'},409);
      if(body.params?.loseResponse)return;
      return json(res,row);
    }
    if(route.startsWith('/bridge/requests/')){
      const row=rows.get(decodeURIComponent(route.split('/').pop()));
      return json(res,row||{error:'request_not_found'},row?200:404);
    }
    json(res,{error:'unknown'},404);
  });
});
const wss=new WebSocketServer({port:0});
wss.on('connection',ws=>{sockets.add(ws);ws.on('close',()=>sockets.delete(ws));});
const request=(id,params={})=>({requestId:id,method:'exec_wait',params});
function event(request, ts=String(Date.now()/1000+(++seq)/10000)) {return {type:'message',channel:'TEST',user:'OWNER',ts,text:'CLAW_RPC_V1 '+JSON.stringify(request)};}
async function send(ev) {
  const ws=[...sockets][0], envelope_id='env'+(++seq);
  let acked=false;
  ws.on('message',raw=>{if(JSON.parse(String(raw)).envelope_id===envelope_id)acked=true;});
  ws.send(JSON.stringify({type:'events_api',envelope_id,payload:{event:ev}}));
  await until(()=>acked,1500);
  const key=crypto.createHash('sha256').update(ev.channel+':'+ev.ts).digest('hex');
  assert.ok(fs.existsSync(path.join(root,'delivery',key+'.json')),'input persisted before Slack ACK');
}
function start() {
  const port=server.address().port;
  child=spawn(process.execPath,[adapter],{env:{...process.env,
    CLAW_SLACK_STATE_DIR:root,CLAW_SLACK_APP_TOKEN:'test',CLAW_SLACK_BOT_TOKEN:'test',
    CLAW_SLACK_CHANNEL_ID:'TEST',CLAW_SLACK_ALLOWED_USER_IDS:'OWNER',CLAW_SLACK_MODE:'active',
    CLAW_SLACK_API_BASE:`http://127.0.0.1:${port}/api`,CLAW_SLACK_BRIDGE_URL:`http://127.0.0.1:${port}/bridge`,
    CLAW_SLACK_HTTP_TIMEOUT_MS:'200',CLAW_SLACK_BRIDGE_TIMEOUT_MS:'200'},stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',x=>logs+=x);child.stdout.on('data',x=>logs+=x);
}
async function stop() {if(child&&child.exitCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}await until(()=>sockets.size===0);}
function has(id,state='completed'){return posts.some(p=>p.text.includes(`request=${id} state=${state}`));}
async function main(){
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  if(!wss.address())await new Promise(r=>wss.once('listening',r));wsPort=wss.address().port;
  start();await until(()=>sockets.size===1);
  posting='429';const first=event(request('restart-output'));
  await send(first);await until(()=>attempts.length>0);assert.equal(executions,1);
  await stop();posting='ok';start();await until(()=>sockets.size===1);await until(()=>has('restart-output'));
  assert.equal(executions,1,'restart republishes without executing again');
  await send(first);await wait(300);assert.equal(executions,1,'duplicate Slack event deduped');
  await send(event(request('lost-http',{loseResponse:true})));
  await until(()=>has('lost-http'));assert.equal(executions,2,'timeout reconciled by GET');
  posting='hang';await send(event(request('hung-publication')));
  await until(()=>attempts.some(x=>x.text.includes('hung-publication')));
  await wait(300);posting='ok';await send(event(request('next-publication')));
  await until(()=>has('next-publication'));await until(()=>has('hung-publication'));
  assert.equal(executions,4);
  // History discovery reports an absent request, but never executes it.
  const missed=event(request('missed-command'));history=[missed,event(request('missed-page2'))];
  [...sockets][0].send(JSON.stringify({type:'disconnect'}));
  await until(()=>has('missed-command','not_received'));
  await until(()=>has('missed-page2','not_received'));
  assert.equal(executions,4,'history catch-up is observation-only');
  // The same request ID with different parameters remains rejected.
  await send(event(request('lost-http',{different:true})));
  await until(()=>has('lost-http','rejected'));assert.equal(executions,4);
  // Durable inbox entry at restart is picked up; no Slack redelivery required.
  await stop();const queued=event(request('restart-input'));
  const key=crypto.createHash('sha256').update(queued.channel+':'+queued.ts).digest('hex');
  fs.writeFileSync(path.join(root,'delivery',key+'.json'),JSON.stringify({key,channel:queued.channel,
    user:queued.user,ts:queued.ts,threadTs:queued.ts,request:request('restart-input'),
    state:'received',createdAt:Date.now(),attempts:0,nextAt:0}),{mode:0o600});
  history=[];start();await until(()=>has('restart-input'));assert.equal(executions,5);
  await until(()=>JSON.parse(fs.readFileSync(path.join(root,'delivery',key+'.json'))).state==='delivered');
  const stored=JSON.parse(fs.readFileSync(path.join(root,'delivery',key+'.json')));
  assert.equal(stored.state,'delivered');assert.equal(stored.request,undefined);assert.equal(stored.text,undefined);
  console.log(JSON.stringify({ok:true,scenarios:9,executions,posts:posts.length,
    checks:['persist-before-ack','restart-outbox','event-dedup','http-timeout-reconcile','unblock-publication',
      'history-no-replay','history-pagination','conflict-rejected','restart-inbox-payload-cleanup']}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  await stop();for(const ws of sockets)ws.terminate();wss.close();server.closeAllConnections();server.close();
  fs.rmSync(root,{recursive:true,force:true});
});

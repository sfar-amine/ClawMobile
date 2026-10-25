const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const fixture = require('../fixtures/s24-2026-10-25-turn-measurement/voice-qa2-observation.json');
const budget = require('../dist/companion/turnBudget.js');

(async () => {
  assert.equal(budget.TURN_BUDGET_MS, 30000);
  assert.equal(budget.remainingTurnBudgetMs(1000, 30999), 1);
  assert.equal(budget.remainingTurnBudgetMs(1000, 31000), 0);
  assert.equal(budget.remainingTurnBudgetMs(1000, 999), 0, 'a clock discontinuity cannot extend admission');
  const {kind, ...measurement} = fixture.expectedProjection;
  assert.equal(measurement.firstSignMs, fixture.observed.firstSignMs);
  assert.equal(measurement.usefulMs, fixture.observed.usefulMs);
  assert.equal(fixture.observed.receivedFrames, fixture.observed.playedFrames);
  assert.deepEqual(budget.validateTurnMeasurement(measurement), measurement);
  const unknownRoute={...measurement,route:null};assert.equal(budget.validateTurnMeasurement(unknownRoute).route,null);assert.ok(budget.turnMeasurementLogLine(unknownRoute).includes('route=-'),'unknown classification is not invented as answer');
  const line = budget.turnMeasurementLogLine(measurement);
  assert.equal(line, '[turn] surface=voice route=answer model=openai/gpt-5.6-sol first_sign_ms=567 decision_ms=- tool_ms=- useful_ms=31317 total_ms=-');
  for (const malformed of [{...measurement, prompt:'private'}, {...measurement, model:'bad\nsecret'},
    {...measurement, firstSignMs:-1}, {...measurement, totalMs:1}, {...measurement, surface:'contacts'},
    {...measurement, firstSignMs:undefined}, {...measurement, usefulMs:Infinity}]) {
    assert.equal(budget.validateTurnMeasurement(malformed), undefined);
  }
  const samples = Array.from({length:20}, (_,i) => ({...measurement, usefulMs:(i+1)*1000}));
  const stats = budget.summarizeTurnMeasurements([...samples, {...measurement, usefulMs:null}, {usefulMs:0}]);
  assert.equal(stats[2].medianUsefulMs, 10500); assert.equal(stats[2].p95UsefulMs,19000);
  assert.equal(stats[2].usefulSamples,20); assert.equal(stats[0].medianUsefulMs,null);

  const root = await fs.mkdtemp(path.join(os.tmpdir(),'turn-measurement-'));
  process.env.OPENCLAW_STATE_DIR = root;
  const runs = require('../dist/companion/runs.js');
  const {route} = require('../dist/companion/server.js');
  const originalLog = console.log, lines=[];
  console.log = (...args) => {if (String(args[0]).startsWith('[turn]')) lines.push(args[0]);};
  let server;
  try {
    const created = await runs.reserveSubmittedRun('authored test', 'measure-session', 'measure-client');
    const id = created.status.runId;
    const app = {...measurement, surface:'app', firstSignMs:null, usefulMs:4000, totalMs:4500};
    await assert.rejects(runs.recordTurnMeasurement(id,'measure-session',app), e=>e.statusCode===409);
    await runs.settleSubmittedRun(id,'done','authored response');
    await assert.rejects(runs.recordTurnMeasurement(id,'foreign-session',app), e=>e.statusCode===409);
    await assert.rejects(runs.recordTurnMeasurement(id,'measure-session',measurement), e=>e.statusCode===409);
    await assert.rejects(runs.recordTurnMeasurement(id,'measure-session',{...app,surface:'whatsapp'}), e=>e.statusCode===409);
    server=http.createServer((req,res)=>{route(req,res).catch(()=>{res.statusCode=500;res.end('{}');});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const request=(body,headers={})=>new Promise((resolve,reject)=>{
      const encoded=JSON.stringify(body);const req=http.request({host:'127.0.0.1',port:server.address().port,
        path:'/v1/runs/'+id+'/measurement',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded),...headers}},res=>{
        let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end(encoded);
    });
    const body={sessionId:'measure-session',measurement:app}, owner={'X-Clawmobile-Owner-Flow':'v1'};
    assert.equal((await request(body)).status,403);
    assert.equal((await request(body,{...owner,Origin:'https://invalid.example'})).status,403);
    assert.equal((await request({...body, authority:'owner'},owner)).status,400);
    assert.equal((await request(body,owner)).status,200);
    assert.equal((await request(body,owner)).status,200);
    assert.equal((await request({...body,measurement:{...app,usefulMs:3999}},owner)).status,409);
    assert.equal(lines.length,1,'read/report replay must never duplicate the measurement line');
    const stored=JSON.parse(await fs.readFile(path.join(root,'clawmobile-companion/runs.json'),'utf8'));
    const row=stored.runs.find(r=>r.runId===id);
    assert.equal(row.state,'done');assert.equal(row.result,'authored response');assert.equal(row.userText,'authored test');
    assert.deepEqual(row.turnMeasurement,app);
    assert.equal((await runs.turnMeasurementFacts()).facts.length,1);
    const health = require('../dist/companion/control-health.js');
    const projected=health.projectTurnLatency(await runs.turnMeasurementFacts());
    assert.equal(projected.windows['24h'].surfaces[0].usefulSamples,1);
    assert.equal(projected.windows['24h'].surfaces[0].firstSignSamples,0,'unknown sign is never counted as a <1s success');
  } finally {
    console.log=originalLog;if(server)await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});
  }
  console.log('PASS shared budget, real timing projection, retained run owner and guarded idempotent measurements');
})().catch(e=>{console.error(e);process.exitCode=1;});

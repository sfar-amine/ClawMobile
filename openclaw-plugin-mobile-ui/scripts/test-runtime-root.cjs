const assert = require('node:assert/strict');
const path = require('node:path');
const {runtimeRoot, runtimeFile} = require('../dist/runtimeRoot');
const previous = process.env.CLAW_RUNTIME_ROOT;
try {
  delete process.env.CLAW_RUNTIME_ROOT;
  assert.equal(runtimeFile('helper.py', '/synthetic-home'), path.join('/synthetic-home', '.openclaw', 'releases', 'current', 'termux-lite', 'helper.py'));
  process.env.CLAW_RUNTIME_ROOT='/synthetic/pinned/termux-lite';
  assert.equal(runtimeRoot(), '/synthetic/pinned/termux-lite');
  assert.equal(runtimeFile('helper.py'), '/synthetic/pinned/termux-lite/helper.py');
  assert.equal(process.env.CLAW_RUNTIME_ROOT, '/synthetic/pinned/termux-lite');
  process.env.CLAW_RUNTIME_ROOT='../pruned';
  assert.throws(() => runtimeRoot(), /runtime_root_not_absolute/);
} finally {
  if(previous === undefined) delete process.env.CLAW_RUNTIME_ROOT;
  else process.env.CLAW_RUNTIME_ROOT=previous;
}
console.log('runtime root contract: 5/5 assertions passed');

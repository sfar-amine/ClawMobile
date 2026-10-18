const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {runtimeRoot, runtimeFile} = require('../dist/runtimeRoot');
const {runModelFastPath} = require('../dist/modelFastPath');

async function main() {
  const previous = process.env.CLAW_RUNTIME_ROOT;
  const previousHelper = process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-current-'));
  const releases = path.join(home, '.openclaw', 'releases');
  const current = path.join(releases, 'current');
  let assertions = 0;
  const equal = (actual, expected) => { assert.equal(actual, expected); assertions++; };
  const promote = n => {
    const root = path.join(releases, `release-${n}`, 'termux-lite');
    fs.mkdirSync(root, {recursive:true});
    fs.writeFileSync(path.join(root, 'model-fast-path.py'), `import json\nprint(json.dumps({'status':'hit','text':'release-${n}'}))\n`);
    for(const name of ['claw-capability.py','gemini-live-client.mjs','context-store.py','people-trusted.py','tier0-native-read.py']) {
      fs.writeFileSync(path.join(root,name),`release-${n}`);
    }
    if(fs.existsSync(current)) fs.unlinkSync(current);
    fs.symlinkSync(`release-${n}`, current);
    return root;
  };
  try {
    const pinned = promote(0);
    process.env.CLAW_RUNTIME_ROOT = pinned; // Real Tier0 shape, not the Companion checkout.
    delete process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER;
    equal(runtimeRoot(home), path.join(current,'termux-lite'));
    const cachedHelper = runtimeFile('people-trusted.py',home);
    equal(fs.readFileSync(cachedHelper,'utf8'),'release-0');
    equal((await runModelFastPath('synthetic read',{home,checkOnly:true})).text,'release-0');
    // Gateway can be loaded before promotion. Its retained path must keep following the link.
    promote(1);
    equal(fs.readFileSync(cachedHelper,'utf8'),'release-1');
    equal((await runModelFastPath('synthetic read',{home,checkOnly:true})).text,'release-1');
    for(let n=2;n<=6;n++) promote(n);
    fs.rmSync(path.dirname(pinned),{recursive:true}); // Bounded release retention prunes the inherited pin.
    equal(fs.existsSync(pinned),false);
    for(const name of ['claw-capability.py','gemini-live-client.mjs','context-store.py','people-trusted.py','tier0-native-read.py']) {
      equal(fs.readFileSync(runtimeFile(name,home),'utf8'),'release-6');
    }
    equal(fs.readFileSync(cachedHelper,'utf8'),'release-6');
    equal((await runModelFastPath('synthetic read',{home,checkOnly:true})).text,'release-6');
    equal(process.env.CLAW_RUNTIME_ROOT,pinned);
    process.env.CLAW_RUNTIME_ROOT='../pruned'; // Also not a Companion helper override.
    equal(runtimeRoot(home),path.join(current,'termux-lite'));
    equal(process.env.CLAW_RUNTIME_ROOT,'../pruned');
    console.log(JSON.stringify({passed:assertions,failed:0,scope:'synthetic releases with real modelFastPath consumer; no device/provider'}));
  } finally {
    if(previous===undefined) delete process.env.CLAW_RUNTIME_ROOT; else process.env.CLAW_RUNTIME_ROOT=previous;
    if(previousHelper===undefined) delete process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER; else process.env.CLAWMOBILE_MODEL_FAST_PATH_HELPER=previousHelper;
    fs.rmSync(home,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});

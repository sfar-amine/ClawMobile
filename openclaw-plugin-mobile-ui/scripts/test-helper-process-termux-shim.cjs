// REQ-3278 (S24 26/10): under the Termux glibc shim (NODE_OPTIONS=-r glibc-compat.js), promisify(execFile)
// returned a promise without `.child`. A WhatsApp Pulse turn never wrote its private input, the helper ended
// (native_pulse_input_timeout, exit 1) and the orphaned rejection restarted the Gateway three times
// (stability bundles 11:29:10Z, 11:43:12Z, 13:21:02Z). This runs the real shim and the real transport.
const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "helper-termux-shim-"));
try {
  // The shim only patches child_process where the glibc loader exists; this stand-in loader runs the binary it gets.
  fs.mkdirSync(path.join(root, "glibc", "lib"), {recursive: true});
  fs.writeFileSync(path.join(root, "glibc", "lib", "ld-linux-aarch64.so.1"), "#!/bin/sh\nshift 2\nexec \"$@\"\n", {mode: 0o755});
  const helper = path.join(root, "helper.py");
  fs.writeFileSync(helper, [
    "import select,sys",
    "ready=select.select([0],[],[],2)[0]",
    "data=sys.stdin.read() if ready else ''",
    "print('{\"received\":%d}'%len(data))",
    "sys.exit(0 if data and sys.argv[1]=='ok' else 1)",
  ].join("\n"));
  const probe = `
    let orphaned=false;process.on("unhandledRejection",()=>{orphaned=true;});
    const util=require("node:util"),cp=require("node:child_process");
    const shimmed=typeof cp.execFile[util.promisify.custom]!=="function";
    const {runCapabilityHelperProcess}=require(${JSON.stringify(path.resolve(__dirname, "../dist/companion/capabilityBridge.js"))});
    const run=mode=>runCapabilityHelperProcess([${JSON.stringify(helper)},mode],
      {timeoutMs:5000,maxBuffer:4096,env:process.env,privateInput:'{"request":"x"}'});
    (async()=>{
      const ok=await run("ok");
      let failed;try{await run("fail");}catch(error){failed={code:error.code,stdout:String(error.stdout).trim()};}
      await new Promise(r=>setTimeout(r,300));
      console.log(JSON.stringify({shimmed,ok:ok.stdout.trim(),failed,orphaned}));
    })().catch(error=>console.log(JSON.stringify({shimmed,error:error.message})));`;
  const out = spawnSync(process.execPath, ["-r", path.resolve(__dirname, "../../installer/termux-lite/openclaw-compat/glibc-compat.js"), "-e", probe],
    {env: {...process.env, PREFIX: root, NODE_OPTIONS: ""}, encoding: "utf8", timeout: 20000});
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout.trim().split("\n").pop());
  assert.equal(result.shimmed, true, "the real shim must be active, as on the S24");
  assert.equal(result.error, undefined);
  assert.equal(result.ok, '{"received":15}');
  assert.deepEqual(result.failed, {code: 1, stdout: '{"received":15}'});
  assert.equal(result.orphaned, false);
  console.log("helper process under the Termux shim: private input written, failure handled");
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}

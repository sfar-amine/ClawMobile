// F2 (doc 62): a failed Gemini Live token helper keeps its cause, bounded and without credential or command line.
const assert=require('node:assert/strict');
const {tokenHelperFailure}=require('../dist/companion/clawLive');
const timeout=tokenHelperFailure({code:null,signal:'SIGTERM',killed:true,stderr:''},15003);
assert.equal(timeout,'gemini_live_token_helper_failed exit=none signal=SIGTERM killed=true ms=15003 stderr=empty');
const quota=tokenHelperFailure({code:1,signal:null,killed:false,stderr:'\nError: 429 RESOURCE_EXHAUSTED key=AIzaSyA1234567890abcdefghijklmnop\nstack'},812);
assert.match(quota,/^gemini_live_token_helper_failed exit=1 signal=none killed=false ms=812 stderr=Error: 429 RESOURCE_EXHAUSTED key=<redacted>$/);
assert(!quota.includes('AIza'));assert(!quota.includes('/data/data'));
assert(tokenHelperFailure({code:1,stderr:'x'.repeat(5000)},1).length<220);
console.log(JSON.stringify({suite:'claw-live-token-failure',passed:4}));

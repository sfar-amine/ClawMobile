import assert from 'node:assert/strict';
import { googleOwnerClaimAllowed, googleOAuthSettings } from './auth/google-oidc.mjs';
const exp=Math.floor(Date.now()/1000)+300;
const valid={iss:'https://accounts.google.com',aud:'web-client',sub:'owner-id',exp,email_verified:true};
assert.equal(googleOwnerClaimAllowed(valid,'web-client','owner-id'),true);
for (const changed of [{aud:'wrong'},{sub:'wrong'},{iss:'https://evil.example'},{exp:1},{email_verified:false}]) assert.equal(googleOwnerClaimAllowed({...valid,...changed},'web-client','owner-id'),false);
assert.equal(googleOwnerClaimAllowed(valid,'','owner-id'),false);
assert.equal(googleOAuthSettings({}),null);
console.log('Google OIDC owner claim policy: PASS (8 cases)');

import assert from 'node:assert/strict';
import { assess } from './remote-desktop-health.mjs';
const healthy=()=>({remoteChannel:{channel:{state:'joined'},presenceTracked:true,lastHeartbeatOkAt:100},isShuttingDown:false});
assert.equal(assess(healthy(),1000,true).healthy,true);
assert.equal(assess(healthy(),1000,false).healthy,false);
assert.equal(assess(healthy(),76000,true).healthy,false);
assert.equal(assess(healthy(),50,true).healthy,false);
for(const [key,value] of [['sessionLost',true],['shuttingDown',true],['presenceTracked',false],['lastHeartbeatOkAt',null]]){
 const d=healthy();d.remoteChannel[key]=value;assert.equal(assess(d,1000,true).healthy,false);
}
const d=healthy();d.remoteChannel.channel.state='joining';assert.equal(assess(d,1000,true).healthy,false);
console.log('PASS: 9 remote/local health assertions');

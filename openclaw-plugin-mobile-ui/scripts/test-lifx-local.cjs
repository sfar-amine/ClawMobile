const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const os=require("node:os");
const dgram=require("node:dgram");
const native=require("../dist/companion/nativeOperation");
const saved=new Map();let effects=0;
native.existingNativeOperation=async(id,identity)=>{
 const v=saved.get(id);if(v&&v.identity!==identity)throw Object.assign(new Error("operation_conflict"),{statusCode:409});return v?.result||null;
};
native.nativeOperation=async(id,action,target,effect)=>{
 const identity=JSON.stringify({action,target});if(saved.has(id))return saved.get(id).result;
 effects++;const v=await effect();const result={state:v.state,artifact:v.artifact,receipt:{version:1,runId:"test-run",action,target}};
 saved.set(id,{identity,result});return result;
};
os.networkInterfaces=()=>({wlan0:[{address:"192.168.1.75",netmask:"255.255.255.0",family:"IPv4",internal:false}]});
const fixture=require("../fixtures/lifx-a19-s24-20261013.json");
let wire={...fixture.state.raw_hsbk,power:fixture.state.power,label:fixture.state.label};
let writes=0,dropSetReply=false,dropReads=false;
function light(){const p=Buffer.alloc(52);p.writeUInt16LE(wire.hue,0);p.writeUInt16LE(wire.saturation,2);p.writeUInt16LE(wire.brightness,4);p.writeUInt16LE(wire.kelvin,6);p.writeUInt16LE(wire.power==="on"?65535:0,10);p.write(wire.label,12);return p;}
class Socket extends EventEmitter{
 bind(_port,_local,cb){setImmediate(cb);}
 setBroadcast(){}
 close(){this.removeAllListeners();}
 send(d,port,ip,cb){
  cb?.(null);const t=d.readUInt16LE(32);let type,payload;const before=light();
  if(t===2){type=3;payload=Buffer.alloc(5);payload[0]=1;payload.writeUInt32LE(56700,1);}
  else if(t===101){if(dropReads)return;type=107;payload=light();}
  else if(t===32){type=33;payload=Buffer.alloc(12);payload.writeUInt32LE(1,0);payload.writeUInt32LE(27,4);}
  else if(t===14){type=15;payload=Buffer.alloc(20);payload.writeUInt16LE(90,16);payload.writeUInt16LE(2,18);}
  else if(t===102){writes++;wire={...wire,hue:d.readUInt16LE(37),saturation:d.readUInt16LE(39),brightness:d.readUInt16LE(41),kelvin:d.readUInt16LE(43)};if(dropSetReply)return;type=107;payload=before;}
  else if(t===117){writes++;wire.power=d.readUInt16LE(36)?"on":"off";if(dropSetReply)return;type=118;payload=Buffer.alloc(2);payload.writeUInt16LE(wire.power==="on"?65535:0);}
  else if(t===16){type=17;payload=Buffer.alloc(14);payload.writeFloatLE(2.511887e-6);}
  else if(t===34){type=35;payload=Buffer.alloc(24);payload.writeBigUInt64LE(158000000000n,8);}
  else return;
  const h=Buffer.alloc(36);h.writeUInt16LE(36+payload.length);h.writeUInt16LE(0x1400,2);h.writeUInt32LE(d.readUInt32LE(4),4);
  Buffer.from("d073d5225b23","hex").copy(h,8);h[23]=d[23];h.writeUInt16LE(type,32);
  setImmediate(()=>this.emit("message",Buffer.concat([h,payload]),{address:"192.168.1.79",port:56700}));
 }
}
dgram.createSocket=()=>new Socket();
const lifx=require("../dist/companion/lifxLocal");
const body=(id,desired)=>({contract_version:"0.1",request_id:id,device_id:"d073d5225b23",origin:"screen",expires_at:new Date(Date.now()+5000).toISOString(),desired,transition_ms:0});
(async()=>{
 assert.deepEqual(lifx.wifiRoute("192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.75"),{local:"192.168.1.75",broadcast:"192.168.1.255"});
 assert.throws(()=>lifx.wifiRoute("192.0.0.0/27 dev rmnet_data0 src 192.0.0.2"),/LOCAL_NETWORK_UNAVAILABLE/);
 const packet=lifx.lifxPacket("d073d5225b23",117,123,9,Buffer.alloc(6));assert.equal(packet.length,42);assert.equal(packet.readUInt16LE(32),117);assert.equal(packet[23],9);
 const read=await lifx.readLifx("d073d5225b23");assert.equal(read.status,"observed");assert.equal(read.state.power,"on");assert.equal(read.state.color.kelvin,3005);
 const a=body("brightness-1",{brightness_percent:30});const r=await lifx.setLifx(a);assert.equal(r.artifact.status,"verified");
 assert.equal(wire.hue,fixture.state.raw_hsbk.hue);assert.equal(wire.kelvin,3005);assert.equal(wire.power,"on");assert.ok(Math.abs(wire.brightness/65535*100-30)<.01);
 const n=writes;assert.deepEqual(await lifx.setLifx(a),r);assert.equal(writes,n);
 await assert.rejects(()=>lifx.setLifx({...a,desired:{power:"off"}}),/operation_conflict/);
 dropSetReply=true;const off=await lifx.setLifx(body("off-1",{power:"off"}));assert.equal(off.artifact.status,"verified");assert.equal(wire.power,"off");
 const white=await lifx.setLifx(body("white-1",{color:{mode:"white",kelvin:2700}}));assert.equal(white.artifact.status,"verified");assert.equal(wire.power,"off");assert.equal(wire.kelvin,2700);
 dropSetReply=false;
 const zero=await lifx.setLifx(body("zero-1",{brightness_percent:0}));assert.equal(zero.artifact.status,"verified");assert.equal(wire.power,"off");
 assert.throws(()=>lifx.validateLifxSet(body("invalid",{brightness_percent:101})),/INVALID_ARGUMENT/);
 await assert.rejects(()=>lifx.setLifx({...body("expired",{power:"on"}),expires_at:new Date(Date.now()-1).toISOString()}),/REQUEST_EXPIRED/);
 dropReads=true;const failed=await lifx.readLifx("d073d5225b23");assert.equal(failed.status,"failed");assert.equal(failed.state,null);
 assert.equal(effects,4);console.log("LIFX local: packet, read, preserve fields, verified readback, dedup, conflict, expiry, ACK-loss, off-state and unreachable tests passed.");
})().catch(e=>{console.error(e);process.exitCode=1;});

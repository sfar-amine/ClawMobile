import {execFileSync} from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export type VoiceTelemetryCode="t01"|"t02"|"t03"|"t04"|"t05"|"t06"|"t07"|"t25p"|"t30p"|"t44";
const CODES=new Set(["t01","t02","t03","t04","t05","t06","t07","t25p","t30p","t44"]);
const CLOCK_PROBE="import time; print(time.clock_gettime_ns(time.CLOCK_BOOTTIME))";
export type TelemetryOptions={enabled?:boolean;home?:string;clock?:()=>bigint;wall?:()=>number;append?:(file:string,line:string)=>void};

/** Lab-only C1 producer. Never substitutes wall time or MONOTONIC for BOOTTIME. */
export class VoiceTelemetry {
  private readonly enabled:boolean;
  private readonly home:string;
  private readonly clock:()=>bigint;
  private readonly wall:()=>number;
  private readonly append:(file:string,line:string)=>void;
  private failed=0;
  private written=0;
  private maxProbeUs=0;
  private unavailable=false;
  constructor(options:TelemetryOptions={}) {
    this.enabled=options.enabled??process.env.CLAW_VOICE_TELEMETRY==="1";
    this.home=options.home||os.homedir();
    this.clock=options.clock||(()=>BigInt(execFileSync("python3",["-c",CLOCK_PROBE],{timeout:250,maxBuffer:128,stdio:["ignore","pipe","ignore"]}).toString().trim()));
    this.wall=options.wall||Date.now;
    this.append=options.append||((file,line)=>{
      fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
      const fd=fs.openSync(file,"a",0o600);
      try{fs.fchmodSync(fd,0o600);fs.writeSync(fd,line);}finally{fs.closeSync(fd);}
    });
  }
  status(){return {enabled:this.enabled,available:!this.unavailable,written:this.written,failed:this.failed,maxProbeUs:this.maxProbeUs,clock:"CLOCK_BOOTTIME",mode:"lab_sync_probe"};}
  emit(sid:string,turn:number,ev:VoiceTelemetryCode,x:Record<string,number|boolean>={}) {
    if(!this.enabled)return;
    if(this.unavailable){this.failed++;return;}
    // No free text accepted, even if it resembles a technical diagnostic.
    if(!/^[A-Za-z0-9._:-]{1,160}$/.test(sid)||!Number.isSafeInteger(turn)||turn<0||!CODES.has(ev)){this.failed++;return;}
    try {
      const safe:Record<string,number|boolean>={};
      for(const [key,value] of Object.entries(x)) {
        if(!["connection","cached","attempt"].includes(key)||!(typeof value==="boolean"||typeof value==="number"&&Number.isSafeInteger(value)&&value>=0))throw Error("invalid_metadata");
        safe[key]=value;
      }
      const before=process.hrtime.bigint();const stamp=this.clock();
      const probeUs=Number((process.hrtime.bigint()-before)/1000n);
      const wall=this.wall();
      if(stamp<0n||!Number.isSafeInteger(wall)||wall<0)throw Error("invalid_clock");
      this.maxProbeUs=Math.max(this.maxProbeUs,probeUs);safe.clock_probe_us=probeUs;
      // Serialize the integer directly: nanoseconds must never be rounded through JS Number.
      const prefix=JSON.stringify({schema:"samantha.voice.telemetry.v1",src:"companion",sid,turn,ev});
      const line=prefix.slice(0,-1)+`,"boot_ns":${stamp},"wall_ms":${wall},"x":${JSON.stringify(safe)}}\n`;
      const file=path.join(this.home,".openclaw","telemetry","voice",new Date(wall).toISOString().slice(0,10)+".jsonl");
      this.append(file,line);this.written++;
    }catch{this.failed++;this.unavailable=true;} // Fail once; never repeat a slow failed probe in the Voice foreground. Instrumentation failure must not break Voice or expose stderr.
  }
}

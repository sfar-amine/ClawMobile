import {execFile} from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export type VoiceTelemetryCode="t01"|"t02"|"t03"|"t04"|"t05"|"t06"|"t07"|"t25p"|"t30p"|"t44";
const CODES=new Set(["t01","t02","t03","t04","t05","t06","t07","t25p","t30p","t44"]);
/** C1 t99: close-time clock check of a session, x.clock_drift_us = offset at close - offset used for that session. */
const CLOSE_CHECK="t99";
/** One process reads MONOTONIC, BOOTTIME, MONOTONIC back to back: offset = BOOTTIME - midpoint(MONOTONIC). */
const CALIBRATION_PROBE="import time; m=time.clock_gettime_ns; M=time.CLOCK_MONOTONIC; a=m(M); b=m(time.CLOCK_BOOTTIME); c=m(M); print(a, b, c)";
const MAX_PENDING=256;
const DRIFT_ALERT_NS=1_000_000n;
export type Calibration={boot:bigint;mono:bigint;monoAfter?:bigint};
export type TelemetryOptions={enabled?:boolean;home?:string;clock?:()=>bigint;wall?:()=>number;append?:(file:string,line:string)=>void;
  calibrate?:()=>Promise<Calibration>;monotonic?:()=>bigint};
type Pending={sid:string;turn:number;ev:VoiceTelemetryCode;x:Record<string,number|boolean>;mono:bigint;wall:number};

function probeClocks():Promise<Calibration> {
  return new Promise((resolve,reject)=>execFile("python3",["-c",CALIBRATION_PROBE],{timeout:2_000,maxBuffer:256},(error,stdout)=>{
    if(error)return reject(Error("clock_probe_failed"));
    const parts=String(stdout).trim().split(/\s+/);
    if(parts.length!==3||!parts.every(p=>/^\d{1,20}$/.test(p)))return reject(Error("clock_probe_invalid"));
    resolve({mono:BigInt(parts[0]),boot:BigInt(parts[1]),monoAfter:BigInt(parts[2])});
  }));
}

/**
 * Lab-only C1 producer. Never substitutes wall time for BOOTTIME.
 * S24 qualification (2026-10-09): a python3 probe per event costs ~134 ms p50 and blocked the Voice relay, so the clock is
 * calibrated once per session, off the audio path: process.hrtime is CLOCK_MONOTONIC (checked on every calibration by
 * bracketing the probe's MONOTONIC reading), and boot_ns = hrtime + (BOOTTIME - MONOTONIC), stable to ~2 us on the S24.
 * Events emitted before the calibration resolves are stamped at emit time and written once the offset is known.
 * An injected `clock` keeps the former synchronous behaviour (fixtures).
 */
export class VoiceTelemetry {
  private readonly enabled:boolean;
  private readonly home:string;
  private readonly clock?:()=>bigint;
  private readonly wall:()=>number;
  private readonly append:(file:string,line:string)=>void;
  private readonly calibrate:()=>Promise<Calibration>;
  private readonly monotonic:()=>bigint;
  private failed=0;
  private written=0;
  private maxProbeUs=0;
  private unavailable=false;
  private offset:bigint|null=null;
  private calibratedSid="";
  private sessionOffsets=new Map<string,bigint>();
  private calibrating:Promise<void>|null=null;
  private pending:Pending[]=[];
  private lastCalibrationUs=0;
  private lastDriftUs:number|null=null;
  private suspendDetected=false;
  constructor(options:TelemetryOptions={}) {
    this.enabled=options.enabled??process.env.CLAW_VOICE_TELEMETRY==="1";
    this.home=options.home||os.homedir();
    this.clock=options.clock;
    this.wall=options.wall||Date.now;
    this.calibrate=options.calibrate||probeClocks;
    this.monotonic=options.monotonic||(()=>process.hrtime.bigint());
    this.append=options.append||((file,line)=>{
      fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
      const fd=fs.openSync(file,"a",0o600);
      try{fs.fchmodSync(fd,0o600);fs.writeSync(fd,line);}finally{fs.closeSync(fd);}
    });
  }
  status(){return {enabled:this.enabled,available:!this.unavailable,written:this.written,failed:this.failed,maxProbeUs:this.maxProbeUs,
    clock:"CLOCK_BOOTTIME",mode:this.clock?"injected_sync":"session_offset",pending:this.pending.length,
    calibrationUs:this.lastCalibrationUs,driftUs:this.lastDriftUs,suspendDetected:this.suspendDetected};}
  /** Resolves once queued events are written (tests and orderly shutdown). */
  async flush(){while(this.calibrating)await this.calibrating;}
  emit(sid:string,turn:number,ev:VoiceTelemetryCode,x:Record<string,number|boolean>={}) {
    if(!this.enabled)return;
    if(this.unavailable){this.failed++;return;}
    // No free text accepted, even if it resembles a technical diagnostic.
    if(!/^[A-Za-z0-9._:-]{1,160}$/.test(sid)||!Number.isSafeInteger(turn)||turn<0||!CODES.has(ev)){this.failed++;return;}
    let safe:Record<string,number|boolean>;
    try {
      safe={};
      for(const [key,value] of Object.entries(x)) {
        if(!["connection","cached","attempt"].includes(key)||!(typeof value==="boolean"||typeof value==="number"&&Number.isSafeInteger(value)&&value>=0))throw Error("invalid_metadata");
        safe[key]=value;
      }
    }catch{this.failed++;return;}
    if(this.clock){this.emitInjected(sid,turn,ev,safe);return;}
    const before=this.monotonic();const wall=this.wall();
    this.maxProbeUs=Math.max(this.maxProbeUs,Number((this.monotonic()-before)/1000n));
    if(!Number.isSafeInteger(wall)||wall<0){this.failed++;return;}
    const item:Pending={sid,turn,ev,x:safe,mono:before,wall};
    // A new session (or a first event) recalibrates: the offset only changes across a suspend.
    if(this.offset!==null&&this.calibratedSid===sid&&!this.calibrating){this.write(item,this.offset);return;}
    if(this.pending.length>=MAX_PENDING){this.failed++;return;}
    this.pending.push(item);
    if(!this.calibrating)this.startCalibration(sid);
  }
  /** Measures BOOTTIME - MONOTONIC and re-qualifies hrtime as MONOTONIC; throws when the bracket check fails. */
  private async measureOffset():Promise<{offset:bigint;us:number}> {
    const h0=this.monotonic();
    const sample=await this.calibrate();
    const h1=this.monotonic();
    const after=sample.monoAfter??sample.mono;
    if(sample.mono<h0||after>h1||after<sample.mono)throw Error("hrtime_not_monotonic");
    const offset=sample.boot-(sample.mono+after)/2n;
    // BOOTTIME >= MONOTONIC; a few hundred ns below zero is read jitter on a device that never slept.
    if(offset< -DRIFT_ALERT_NS)throw Error("invalid_clock");
    return {offset,us:Number((h1-h0)/1000n)};
  }
  /** Close-time check: a suspend during the session shows as drift, and the analyzer then excludes the whole sid. */
  closeSession(sid:string):Promise<void> {
    if(!this.enabled||this.clock||this.unavailable||!/^[A-Za-z0-9._:-]{1,160}$/.test(sid))return Promise.resolve();
    const check=(async()=>{
      await this.flush();
      const used=this.sessionOffsets.get(sid);
      if(used===undefined||this.unavailable)return;
      try {
        const {offset}=await this.measureOffset();
        const drift=offset-used;
        this.lastDriftUs=Number(drift/1000n);this.suspendDetected||=drift>DRIFT_ALERT_NS||drift< -DRIFT_ALERT_NS;
        const wall=this.wall();
        if(Number.isSafeInteger(wall)&&wall>=0)this.line(sid,0,CLOSE_CHECK,this.monotonic()+offset,wall,{clock_drift_us:Number(drift)/1000,clock_drift_truncated:false});
      }catch{this.failed++;}
    })();
    return check;
  }
  private startCalibration(sid:string) {
    this.calibratedSid=sid;
    const previous=this.offset;
    const run=(async()=>{
      try {
        // Qualification on every calibration: the probe's MONOTONIC must fall inside our hrtime bracket.
        const {offset,us}=await this.measureOffset();
        this.lastCalibrationUs=us;
        // A drift beyond 1 ms between sessions means a suspend happened in between; it is reported, never smoothed.
        if(previous!==null){const drift=offset-previous;this.lastDriftUs=Number(drift/1000n);this.suspendDetected||=drift>DRIFT_ALERT_NS||drift< -DRIFT_ALERT_NS;}
        this.offset=offset;
        this.sessionOffsets.set(sid,offset);
        while(this.sessionOffsets.size>8)this.sessionOffsets.delete(this.sessionOffsets.keys().next().value!);
        const queued=this.pending.filter(item=>item.sid===sid);
        this.pending=this.pending.filter(item=>item.sid!==sid);
        for(const item of queued)this.write(item,offset);
      }catch{
        // Fail once; instrumentation failure must not break Voice or expose stderr.
        this.failed+=this.pending.length;this.pending=[];this.unavailable=true;this.offset=null;
      }
    })();
    const done=run.finally(()=>{
      if(this.calibrating===done){
        this.calibrating=null;
        if(this.pending.length&&!this.unavailable)this.startCalibration(this.pending[0].sid);
      }
    });
    this.calibrating=done;
  }
  private write(item:Pending,offset:bigint) {
    try {
      const stamp=item.mono+offset;
      if(stamp<0n)throw Error("invalid_clock");
      this.line(item.sid,item.turn,item.ev,stamp,item.wall,{...item.x,clock_probe_us:0});
    }catch{this.failed++;this.unavailable=true;}
  }
  private emitInjected(sid:string,turn:number,ev:VoiceTelemetryCode,safe:Record<string,number|boolean>) {
    try {
      const before=process.hrtime.bigint();const stamp=this.clock!();
      const probeUs=Number((process.hrtime.bigint()-before)/1000n);
      const wall=this.wall();
      if(stamp<0n||!Number.isSafeInteger(wall)||wall<0)throw Error("invalid_clock");
      this.maxProbeUs=Math.max(this.maxProbeUs,probeUs);
      this.line(sid,turn,ev,stamp,wall,{...safe,clock_probe_us:probeUs});
    }catch{this.failed++;this.unavailable=true;}
  }
  private line(sid:string,turn:number,ev:string,stamp:bigint,wall:number,x:Record<string,number|boolean>) {
    // Serialize the integer directly: nanoseconds must never be rounded through JS Number.
    const prefix=JSON.stringify({schema:"samantha.voice.telemetry.v1",src:"companion",sid,turn,ev});
    const line=prefix.slice(0,-1)+`,"boot_ns":${stamp},"wall_ms":${wall},"x":${JSON.stringify(x)}}\n`;
    const file=path.join(this.home,".openclaw","telemetry","voice",new Date(wall).toISOString().slice(0,10)+".jsonl");
    this.append(file,line);this.written++;
  }
}

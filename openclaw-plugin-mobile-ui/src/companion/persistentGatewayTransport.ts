/** Preparation around the existing OpenClaw GatewayClient owner; no credential reader or wire protocol fork. */
export type GatewayCallOptions={expectFinal?:boolean;timeoutMs?:number;hardTimeoutMs?:number};
export type GatewayClientOwner={connected:boolean;start():void;stop():void;request(method:string,params:any,options:{expectFinal?:boolean;timeoutMs:number}):Promise<any>};
export type GatewayClientFactory=(callbacks:{onHelloOk:()=>void;onClose:()=>void;onConnectError:(error:any)=>void})=>GatewayClientOwner;
type Job={method:string;params:any;options:GatewayCallOptions;deadline:number;resolve:(v:any)=>void;reject:(e:any)=>void;timer:ReturnType<typeof setTimeout>;started:boolean};
const error=(code:string,sent=false)=>Object.assign(new Error(code),{code,requestSent:sent});
const socketDown=new Set(['ECONNREFUSED','ENOTFOUND','EHOSTUNREACH','ENETUNREACH']);
export class PersistentGatewayTransport{
 private client:GatewayClientOwner;private closed=false;private queue:Job[]=[];private running=new Set<Job>();private waiters=new Set<(available:boolean)=>void>();private unavailable=false;private authenticationRejected=false;
 constructor(factory:GatewayClientFactory,private cli:(method:string,params:any,options:GatewayCallOptions)=>Promise<any>){
  this.client=factory({onHelloOk:()=>{this.unavailable=false;this.authenticationRejected=false;this.wake(true);},onClose:()=>{this.unavailable=true;this.wake(false);},onConnectError:e=>{if(socketDown.has(e?.code)){this.unavailable=true;this.wake(false);}else{this.authenticationRejected=true;this.wake(false);}}});
  // GatewayClient owns handshake, identity, reconnect/backoff. No request is replayed here.
  this.client.start();
 }
 call(method:string,params:any={},options:GatewayCallOptions={}):Promise<any>{
  if(this.closed)return Promise.reject(error('gateway_transport_closed'));
  if(typeof method!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(method)||!params||typeof params!=='object'||Array.isArray(params))return Promise.reject(error('gateway_call_invalid'));
  let captured:any;try{const encoded=JSON.stringify(params);if(Buffer.byteLength(encoded)>256*1024)return Promise.reject(error('gateway_call_too_large'));captured=JSON.parse(encoded);}catch{return Promise.reject(error('gateway_call_invalid'));}
  const timeout=options.timeoutMs??10000,hard=options.hardTimeoutMs??timeout;
  if(!Number.isFinite(timeout)||timeout<1||timeout>300000||!Number.isFinite(hard)||hard<1||hard>300000)return Promise.reject(error('gateway_call_invalid'));
  if(this.queue.length>=32)return Promise.reject(error('gateway_queue_full'));
  return new Promise((resolve,reject)=>{const deadline=Date.now()+Math.min(timeout,hard);const job:Job={method,params:captured,options:{...options},deadline,resolve,reject,started:false,timer:undefined as any};
   job.timer=setTimeout(()=>{if(job.started)return;this.queue=this.queue.filter(x=>x!==job);reject(error('gateway_queue_timeout'));},Math.max(1,deadline-Date.now()));this.queue.push(job);this.drain();});
 }
 private wake(available:boolean){for(const waiter of [...this.waiters])waiter(available);}
 private waitForSocket(deadline:number):Promise<boolean>{
  if(this.client.connected)return Promise.resolve(true);if(this.unavailable||this.authenticationRejected)return Promise.resolve(false);
  return new Promise(resolve=>{let timer:ReturnType<typeof setTimeout>;const done=(available:boolean)=>{clearTimeout(timer);this.waiters.delete(done);resolve(available);};this.waiters.add(done);timer=setTimeout(()=>done(false),Math.max(1,deadline-Date.now()));});
 }
 private drain(){while(!this.closed&&this.running.size<4&&this.queue.length){const job=this.queue.shift()!;clearTimeout(job.timer);if(Date.now()>=job.deadline){job.reject(error('gateway_queue_timeout'));continue;}job.started=true;this.running.add(job);this.execute(job).then(job.resolve,job.reject).finally(()=>{this.running.delete(job);this.drain();});}}
 private async execute(job:Job){
  const ready=await this.waitForSocket(job.deadline);if(this.closed)throw error('gateway_transport_closed');
  const remaining=Math.max(0,job.deadline-Date.now());if(!remaining)throw error('gateway_connect_timeout');
  if(!ready){
   if(this.authenticationRejected)throw error('gateway_connect_refused');
   // Only a confirmed pre-dispatch unavailable socket permits the CLI owner path.
   if(!this.unavailable)throw error('gateway_connect_timeout');
   try{return await this.cli(job.method,job.params,{...job.options,timeoutMs:remaining,hardTimeoutMs:remaining});}catch{throw error('gateway_cli_failed',true);}
  }
  // Crossing request() is the dispatch boundary, including send callback failures.
  // Timeout/close/method rejection cannot cause reconnect or CLI replay of this job.
  try{return await this.client.request(job.method,job.params,{expectFinal:job.options.expectFinal,timeoutMs:remaining});}
  catch{throw error('gateway_dispatch_indeterminate',true);}
 }
 close(){if(this.closed)return;this.closed=true;this.client.stop();this.wake(false);for(const job of this.queue){clearTimeout(job.timer);job.reject(error('gateway_transport_closed'));}this.queue=[];}
}

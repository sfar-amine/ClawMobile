'use strict';
// Synthetic public API fixture. No socket, account, runtime config or effect.
function fakePublicSdk(handler, hooks={}) {
 let current;
 return {
  getRuntimeConfig:()=>hooks.config||{gateway:{mode:'local',port:18789,auth:{mode:'token',token:'synthetic-only'}}},
  resolveGatewayAuth:({authConfig})=>({...authConfig}), resolveGatewayPort:cfg=>cfg.gateway.port,
  resolveConfiguredSecretInputWithFallback:async args=> hooks.secret ? hooks.secret(args) : {value:args.value||args.readFallback()},
  GatewayClient:class {
   constructor(options){this.options=options;current=this;}
   start(){this.options.hostDeps.beforeConnect();hooks.beforeHello?.(this);if(!hooks.deferHello)this.hello();}
   hello(){this.options.onHelloOk({auth:{role:'operator',scopes:hooks.scopes||this.options.scopes},features:{methods:['agent']}});}
   request(method,params,opts){opts.onSent?.('synthetic-request');return handler(method,{json:true,timeout:String(opts.timeoutMs),expectFinal:opts.expectFinal},params,
    {scopes:this.options.scopes,progress:false,expectFinal:opts.expectFinal,timeoutMs:opts.timeoutMs,signal:opts.signal,clientOptions:this.options});}
   stop(){hooks.stops=(hooks.stops||0)+1;} async stopAndWait(){this.stop();}
  },
  startGatewayClientWhenEventLoopReady:async client=>{client.start();return {ready:true}},
  getClient:()=>current,
 };
}
module.exports={fakePublicSdk};

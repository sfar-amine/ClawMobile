import {createHash} from 'crypto';
import type {IncomingMessage,ServerResponse} from 'http';

/** Conditional transport for a closed set of existing read projections. No cache. */
function allowed(req:IncomingMessage):boolean {
 if(req.method!=='GET'||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress||'')||req.headers.origin||req.headers.referer||req.headers['sec-fetch-site'])return false;
 let url:URL;try{url=new URL(req.url||'/','http://localhost');}catch{return false;}
 const path=url.pathname.replace(/^\/v1(?=\/)/,'');
 return ['/control/automations','/providers','/usage','/files','/agent/config'].includes(path)||(path==='/runs'&&url.searchParams.get('view')==='conversations');
}
function complete(value:any):boolean {
 if(!value||value.success===false||value.error||['refused','failed','indeterminate','unavailable','deferred','computing'].includes(value.state)||value.computation?.deliveryMode==='deferred'||value.cost&&['computing','unavailable','unqualified'].includes(value.cost.state))return false;
 return !Object.values(value.sections||{}).some((section:any)=>section?.availability==='unavailable'||section?.freshness==='unknown');
}
function matches(header:string|string[]|undefined,etag:string):boolean {
 if(typeof header!=='string'||header.length>4096)return false;
 if(header.trim()==='*')return true;
 const tags=header.split(',').map(x=>x.trim());
 if(tags.some(x=>! /^(?:W\/)?"[^"\s]*"$/.test(x)))return false;
 return tags.some(x=>x.replace(/^W\//,'')===etag); 
}
/** Called only after the original route has read/projected/validated the owner response. */
export function conditionalRead(req:IncomingMessage,res:ServerResponse,status:number,value:any,body:string):boolean {
 if(status!==200||!allowed(req)||!complete(value))return false;
 const etag='"'+createHash('sha256').update(body).digest('hex')+'"';
 res.setHeader('ETag',etag);
 if(!matches(req.headers['if-none-match'],etag))return false;
 res.statusCode=304;res.removeHeader('Content-Length');res.end();return true;
}

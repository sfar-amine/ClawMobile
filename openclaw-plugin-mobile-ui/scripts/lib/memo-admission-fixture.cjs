// Offline opaque P1 seam only. No HTTP flags, real credential or provider call.
const Module=require('node:module'),original=Module._load,tickets=new WeakSet();let epoch=0;
exports.ticket=(clientRunId,sessionId)=>{const t=Object.freeze({clientRunId,sessionId,epoch,expiresAt:Date.now()+60000});tickets.add(t);return t;};
exports.revoke=()=>epoch++;
Module._load=function(id,parent,...args){if(id==='./ownerTurnAdmission'&&parent?.filename.includes('/companion/'))return {turnAdmission:{isCurrent:(t,b)=>tickets.has(t)&&t.epoch===epoch&&t.expiresAt>Date.now()&&t.clientRunId===b.clientRunId&&t.sessionId===b.sessionId}};return original.call(this,id,parent,...args);};
exports.restore=()=>{Module._load=original;};

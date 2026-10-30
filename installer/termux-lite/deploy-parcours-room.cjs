// deploy-parcours.py, paths 2-3: one message of the test contact « Recette Pulse » (fictitious +216 10 000 001,
// added by Amine with his biometrics on 29/10) through the Pulse-room hook the Gateway has loaded. The reply is
// returned here and never delivered: nothing is sent on WhatsApp. Prints one JSON line {reply, seconds, error}.
'use strict';
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const text=process.argv[2];
const E164='+21610000001',SESSION='agent:contacts-projet-pulse:whatsapp:direct:'+E164;
function gatewayEnv(){
  // The hook spawns the same helpers as inside the Gateway: run it with the Gateway's environment.
  const pid=execFileSync('pgrep',['-f','openclaw-gateway'],{encoding:'utf8'}).trim().split('\n')[0];
  for(const line of fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0')){
    const i=line.indexOf('=');if(i>0&&!(line.slice(0,i) in process.env))process.env[line.slice(0,i)]=line.slice(i+1);
  }
}
(async()=>{
  const began=Date.now();let reply='',error=null;
  try{
    if(!text||text.length>500)throw Error('usage');
    gatewayEnv();
    const dist=path.join(process.env.HOME,'.openclaw/extensions/openclaw-plugin-mobile-ui/dist');
    const {handlePulseRoomBeforeDispatch}=require(path.join(dist,'pulseRoomFastPath'));
    const id='recette-'+Date.now();
    const out=await handlePulseRoomBeforeDispatch({content:text,messageId:id,sessionKey:SESSION,channel:'whatsapp',isGroup:false},
      {messageId:id,sessionKey:SESSION,channelId:'whatsapp'});
    if(!out||out.handled!==true)error='not_handled';else reply=String(out.text||out.reply?.text||'');
  }catch(e){error=String(e&&e.message||e).slice(0,120);}
  console.log(JSON.stringify({reply,seconds:(Date.now()-began)/1000,error}));
  process.exit(0);
})();

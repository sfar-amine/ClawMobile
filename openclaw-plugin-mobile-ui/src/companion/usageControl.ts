import {createHash} from 'crypto';
import {peekUsage,usageAttention} from './usage';
import {peekActiveModel,providerAttention} from './providers';
/** Cached projection only: never starts an owner/Gateway read from Control. */
export function completeUsageAttention(value:any){
 const out=structuredClone(value);
 const alerts=[...usageAttention(peekUsage(),peekActiveModel()),...providerAttention()];
 const additions=alerts.map(item=>({id:item.id,title:item.kind==='usage'?'Quota du fournisseur épuisé':'Fournisseur du modèle à vérifier',description:item.kind==='usage'?'Une fenêtre de consommation est épuisée.':'Le modèle principal ou de secours dépend de ce fournisseur.',status:'attention',route:item.kind==='usage'?'/usage':'/providers',provider:item.provider,...('activeAgentDependency' in item?{activeAgentDependency:item.activeAgentDependency}:{agentDependency:true})}));
 const apply=(data:any)=>{
  if(!data||typeof data!=='object'||!Array.isArray(data.attentionItems)&&!additions.length)return false;
  const existing=Array.isArray(data.attentionItems)?data.attentionItems:[];
  const retained=existing.filter((item:any)=>typeof item?.id!=='string'||!item.id.startsWith('usage:')&&!item.id.startsWith('provider:'));
  const next=[...retained,...additions];if(JSON.stringify(existing)===JSON.stringify(next))return false;
  data.attentionItems=next;return true;
 };
 if(Array.isArray(out?.attentionItems))apply(out);
 if(out?.data&&apply(out.data))out.dataRevision=createHash('sha256').update(JSON.stringify(out.data)).digest('hex');
 for(const name of ['health','situations']){const section=out?.sections?.[name];if(section?.data&&apply(section.data))section.dataRevision=createHash('sha256').update(JSON.stringify(section.data)).digest('hex');}

 return out;
}

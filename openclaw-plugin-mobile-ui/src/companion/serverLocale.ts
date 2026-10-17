/** Presentation only: protocol codes, receipts and all user text remain unchanged. */
export type ServerLanguage = 'fr' | 'en';
const states:Record<string,[string,string]>={healthy:['Sain','Healthy'],ready:['Prêt','Ready'],unknown:['Inconnu','Unknown'],unavailable:['Indisponible','Unavailable'],deferred:['En préparation','Preparing'],fresh:['À jour','Fresh'],stale:['À actualiser','Stale'],running:['En cours','Running'],waiting:['En attente','Waiting'],blocked:['Bloqué','Blocked'],failed:['Échec','Failed'],completed:['Terminé','Completed'],cancelled:['Annulé','Cancelled'],disabled:['Désactivé','Disabled'],attention:['À vérifier','Needs attention'],degraded:['Dégradé','Degraded'],exhausted:['Épuisé','Exhausted'],low:['Faible','Low'],ok:['Disponible','Available'],needs_auth:['Connexion requise','Authentication required']};
const reasons:Record<string,[string,string]>={protected_automation:['Automatisation protégée','Protected automation'],delivery_evidence_unavailable:['Preuve de livraison indisponible','Delivery evidence unavailable'],automation_unavailable:['Automatisation indisponible','Automation unavailable'],computation_pending:['Calcul en cours','Computation pending'],source_revision_unavailable:['Révision de la source indisponible','Source revision unavailable']};
export function serverLanguage(header:unknown):ServerLanguage{
 if(typeof header!=='string'||header.length>512)return 'fr';
 const preferences=header.split(',').map((part,index)=>{const [tag,...params]=part.trim().toLowerCase().split(';');const q=params.find(p=>p.trim().startsWith('q='));const weight=q?Number(q.trim().slice(2)):1;return {tag:tag.split('-')[0],weight,index};}).filter(p=>['fr','en'].includes(p.tag)&&Number.isFinite(p.weight)&&p.weight>0&&p.weight<=1).sort((a,b)=>b.weight-a.weight||a.index-b.index);
 return preferences[0]?.tag==='en'?'en':'fr';
}
export function localizedRoute(path:string){return /^\/(?:control\/(?:health|automations)$|notifications\/sources$|automations(?:\/|$)|agent\/config$|providers$|usage$|updates$)/.test(path);}
function text(pair:[string,string],language:ServerLanguage){return pair[language==='en'?1:0];}
/** Closed presentation fields only. Never inspect/translate prompt, summary, body, note or message. */
export function localizeServerPresentation(value:any,language:ServerLanguage,depth=0):any{
 if(depth>12||value===null||typeof value!=='object')return value;
 if(Array.isArray(value))return value.map(item=>localizeServerPresentation(item,language,depth+1));
 const out:any={};
 const structural=new Set(['sections','health','automations','notifications','data','items','components','providers','windows','computation','canonicalVerdict']);
 for(const [key,item] of Object.entries(value))out[key]=structural.has(key)?localizeServerPresentation(item,language,depth+1):item;
 for(const key of ['state','status','availability','freshness','lastRunStatus'])if(typeof value[key]==='string'&&states[value[key]])out[key+'Label']=text(states[value[key]],language);
 if(typeof value.reason==='string'&&reasons[value.reason])out.reasonLabel=text(reasons[value.reason],language);
 // Health labels are a captured bilingual producer contract, not user-authored names.
 if(value.label&&typeof value.label==='object'&&typeof value.label[language]==='string'&&value.label[language].trim()&&typeof value.id==='string'&&typeof value.status==='string')out.name=value.label[language];
 if(value.scheduleType==='every'&&typeof value.scheduleLabel==='string'){
  const match=/^Toutes les (\d+) min$/.exec(value.scheduleLabel);
  if(match)out.scheduleLabel=language==='en'?`Every ${match[1]} min`:value.scheduleLabel;
 }
 return out;
}

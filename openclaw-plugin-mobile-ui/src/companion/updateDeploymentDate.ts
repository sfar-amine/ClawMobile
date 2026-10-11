/** G5 binding to G4's single receipt owner. No filesystem reader, cache or date estimate. */
export type CompanionDeploymentDateOwner=(target:string)=>Promise<string|null>;
export async function withCompanionDeploymentDate(snapshot:any,deployedCommit:string|null,owner:CompanionDeploymentDateOwner){
 const value=structuredClone(snapshot);
 if(!Array.isArray(value?.items))throw new Error('updates_unavailable');
 let deployedAt:string|null=null;
 if(typeof deployedCommit==='string'&&/^[a-f0-9]{40}$/.test(deployedCommit)){
  try{
   const at=await owner(deployedCommit);
   if(typeof at==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(at)&&Number.isFinite(Date.parse(at))&&new Date(at.slice(0,10)+"T00:00:00Z").toISOString().slice(0,10)===at.slice(0,10))deployedAt=new Date(at).toISOString();
  }catch{/* unavailable proof stays null, never use current time or manifest date */}
 }
 value.items=value.items.map((row:any)=>row?.id==='companion'?{...row,deployedAt}:row);
 return value;
}

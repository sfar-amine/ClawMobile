import {readControlV2} from "./control";
const nativeError=(code:string,statusCode=400)=>Object.assign(new Error(code),{statusCode});
/** The native endpoint uses the same owner projection and route availability as Control. */
export async function notificationSources():Promise<any>{
 try{
  const result=await readControlV2(['notifications'],undefined);
  const value=result.sections?.notifications?.data as any;
  if(!value||!Array.isArray(value.items)||value.items.length>256)throw Error();
  return {...value,sources:value.items};
 }catch{throw nativeError('notification_sources_unavailable',503);}
}

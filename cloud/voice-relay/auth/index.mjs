import { WorkerEntrypoint } from "cloudflare:workers";
import { OAuthAuthorizationServer, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { verifyGoogleOwnerIdToken } from './google-verify.mjs';
import { consentPage } from './consent.mjs';
const ISSUER='https://claw-chatgpt-oauth.claw-s24-voice-260930.workers.dev';
const RESOURCE='https://claw-voice-relay.claw-s24-voice-260930.workers.dev/mcp';
export const oauth=new OAuthAuthorizationServer({issuer:ISSUER,resources:[RESOURCE],scopesSupported:['mcp:read'],clientIdMetadataDocumentEnabled:true});
const deny=(status=503)=>Response.json({error:'authorization_unavailable'},{status,headers:{'cache-control':'no-store'}});
const base64url=(buffer)=>btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function hash(v){return base64url(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)));}
export default class ChatgptOAuthServer extends WorkerEntrypoint {
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path!=='/authorize' && path!=='/callback') return oauth.fetch(request,this.env,this.ctx);
    const env=this.env;
    if(!env.OAUTH_KV||!env.GOOGLE_OAUTH_WEB_CLIENT_ID||!env.GOOGLE_OAUTH_WEB_CLIENT_SECRET||!env.GOOGLE_OWNER_IDENTITY) return deny();
    const api=oauth.getOAuthApi(env);
    try {
      if(path==='/authorize' && request.method==='GET'){
        const pending=await api.parseAuthRequest(request);
        const details=await api.describeConsent(pending);
        const consent=await api.beginConsent(pending);
        consent.headers.set('content-type','text/html; charset=utf-8');
        return new Response(consentPage(details,consent.handle),{headers:consent.headers});
      }
      if(path==='/authorize' && request.method==='POST'){
        const f=await request.formData();
        const handle=String(f.get('handle')||'');
        if(f.get('decision')!=='approve'){
          const rejected=await api.denyConsent(request,handle);
          return new Response(null,{status:302,headers:rejected.headers});
        }
        const accepted=await api.approveConsent(request,handle,{scope:['mcp:read']});
        const verifier=base64url(crypto.getRandomValues(new Uint8Array(32)));
        const nonce=crypto.randomUUID();
        const {state,headers}=await api.beginUpstream(accepted.request,{data:{verifier,nonce},headers:accepted.headers});
        const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
        for(const [k,v] of Object.entries({response_type:'code',client_id:env.GOOGLE_OAUTH_WEB_CLIENT_ID,redirect_uri:ISSUER+'/callback',scope:'openid email',state,nonce,code_challenge:await hash(verifier),code_challenge_method:'S256',prompt:'select_account'}))url.searchParams.set(k,v);
        headers.set('Location',url.toString());return new Response(null,{status:302,headers});
      }
      if(path==='/callback' && request.method==='GET'){
        const {request:original,data,headers}=await api.finishUpstream(request);
        const url=new URL(request.url);
        if(url.searchParams.has('error')){headers.set('Location',authorizationErrorRedirect(original,'access_denied'));return new Response(null,{status:302,headers});}
        const code=url.searchParams.get('code');if(!code||!data?.nonce||!data?.verifier)return deny(400);
        const body=new URLSearchParams({grant_type:'authorization_code',code,client_id:env.GOOGLE_OAUTH_WEB_CLIENT_ID,client_secret:env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,redirect_uri:ISSUER+'/callback',code_verifier:data.verifier});
        const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
        if(!response.ok)return deny(401);
        const token=await response.json();
        const subject=await verifyGoogleOwnerIdToken(token.id_token,env.GOOGLE_OAUTH_WEB_CLIENT_ID,env.GOOGLE_OWNER_IDENTITY,data.nonce);
        const completed=await api.completeAuthorization({request:original,userId:subject,metadata:{},scope:['mcp:read'],props:{userId:subject}});
        headers.set('Location',completed.redirectTo);return new Response(null,{status:302,headers});
      }
      return deny(405);
    } catch {return deny(403);}
  }
  validateToken(resource,token){return oauth.validateToken(resource,token,this.env);}
}

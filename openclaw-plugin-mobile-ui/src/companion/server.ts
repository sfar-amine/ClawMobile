import {conditionalRead} from "./readEtag";
import {readCatalogResponse,catalogETag} from './catalog';
import {readDeploymentReceipts} from "./deploymentReceipts";
import {skillControlDetail,changeSkill} from "./skillControl";
import {learnSkill,learningCandidates,learningCandidate} from "./skillLearning";
import {filesList,filesContent} from "./fileReads";
import {prewarmUsage,readUsage,readUsageDetails} from './usage';
import {readProviders} from './providers';
import {memoryRead,memoryForget,memoryImport} from "./memoryControl";
import {capabilityDetail} from "./capabilityControl";
import {updatesRead} from "./updatesControl";
import {saveAttachments,purgeAttachments,attachmentContent,attachmentDigest} from "./attachmentStorage";
import {withAttachmentReferences} from "./runs";
import {readAgentConfig,changeAgentConfig} from "./agentConfig";
import {engineeringRead} from "./engineeringRead";
import {learningForget, learningList, learningNotThis} from "./learning";
import {cancelControlRequest} from "./controlActions";
import {diagnosticRead} from "./diagnostic";
import {automationDetail,changeAutomation} from "./automations";
import {editAutomation} from "./automationEditValidation";
import {laptopList,laptopPairStart,laptopPairStatus,laptopChange} from "./laptopAccess";
import {notificationSources} from "./notificationSources";
import {allowlistRead,allowlistChange,allowlistBody} from "./whatsappAllowlist";
import { handleControl } from "./control";
import {accountGuardedRoute,redactAccountIdentifiers} from "./accountIdentity";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { URL } from "url";
import { android_health } from "../tools/android";
import { clearAgentConversationMessages, listAgentConversationMessages, listAgentConversations, markAgentMessageRead } from "./agentMessages";
import { getGatewayStatus, getRuntimeLog, restartRuntime, startRuntime, stopRuntime } from "./openclawGatewayClient";
import {readConversationMetadata,changeConversationMetadata} from "./conversationMetadata";
import { submitIntent } from "./intent";
import {securitySurfaces} from "./securitySurfaces";
import { payments } from "./payments";
import { confirmations } from "./confirmations";
import {readRunApproval,decideRunApproval} from './agentApprovals';
import { consumeRecoveryPending, getVoiceRecoveryStatus, markVoiceIntentionalStop, probeChatGptVoiceActive, resumeVoiceRecovery, startVoiceRecoveryWatchdog, suspendVoiceRecovery } from "./voiceRecovery";
import { abandonStaleRemoteBridgeReceipts, getRemoteBridgeRequest, remoteBridgeHealth, submitRemoteBridgeRequest } from "./remoteBridge";
import { capabilityBridge } from "./capabilityBridge";
import { SurfaceClarifications } from "../capabilityClarification";
import { clawLiveCapabilityTurn, createClawLiveToken, clawLivePageHtml, clawLiveVoices, validatedClawLiveVoice } from "./clawLive";
import { attachClawLiveWarmUpgrade, clawLiveWarmCore, clawLiveWarmMeta } from "./clawLiveWarm";
import { startVoiceRelay, stopVoiceRelay, voiceRelayHealth } from "./voiceRelay";
import { deleteNostrContact, fetchNostrInbox, getNostrStatus, listNostrContacts, sendNostrAgentMessage, setupNostrIdentity, shareSkillViaNostr, upsertNostrContact } from "./nostr";
import { archiveSession, deleteSession, deleteRun, getRunStatus, getRunStatusByClientRunId, listRuns, listRunSummaries, getConversationTurns, saveVoiceTurn, conversationSummariesPage, conversationTurnsPage, subscribeConversationChanges } from "./runs";
import { getWorkspaceSkill, listWorkspaceSkills, previewWorkspaceSkill, routeWorkspaceSkills, runWorkspaceFastPath, runWorkspaceSkill } from "./skills";
import { acceptSkillImport, createSkillSharePackage, listPendingSkillImports, rejectSkillImport, storePendingSkillImport } from "./skillSharing";
import type { CompanionHealth, CompanionRunStatus, IntentAttachment, RunCreateRequest, TerminalCommandRequest, TerminalCommandResponse, TerminalSessionRequest, TerminalSessionResponse } from "./types";

const VERSION = "0.1.0";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TERMINAL_COMMAND_CHARS = 2000;
const MAX_TERMINAL_OUTPUT_BYTES = 64 * 1024;
const TERMINAL_COMMAND_TIMEOUT_MS = 30_000;
const MAX_TERMINAL_SESSION_OUTPUT_CHARS = 128 * 1024;
const DEFAULT_WHATSAPP_LISTENER_WATCHDOG_MS = 15_000;
let whatsappListenerWatchdogBusy = false;
const CWD_SENTINEL_PREFIX = "__CLAWMOBILE_CWD:";
const CWD_SENTINEL_SUFFIX = "__";

type TerminalShellSession = {
  child: ChildProcessWithoutNullStreams;
  output: string;
  cwd: string;
  running: boolean;
  updatedAt: number;
};

export function runSubmissionStatusCode(result: { success?: boolean; submissionState?: string }) {
  if (result.success) return 200;
  return result.submissionState === "not_submitted" ? 503 : 400;
}

export function startCompanionServer() {
  withAttachmentReferences(paths=>purgeAttachments(paths)).catch(()=>console.error("[companion] attachment maintenance unavailable"));
  const configuredHost = (process.env.CLAWMOBILE_COMPANION_HOST || DEFAULT_HOST).trim();
  const host = listenHost(configuredHost);
  const port = parsePort(process.env.CLAWMOBILE_COMPANION_PORT, DEFAULT_PORT);

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error: any) {
      writeJson(res, error?.statusCode || 500, {
        success: false,
        message: error?.message || "Internal server error.",
      });
    }
  });

  attachClawLiveWarmUpgrade(server);

  const onListening = () => {
    const address = server.address();
    const resolvedHost = typeof address === "object" && address ? address.address : configuredHost || "::";
    console.log(`[companion] ClawMobile companion server listening on ${resolvedHost}:${port}`);
  };
  if (host) {
    server.listen(port, host, onListening);
  } else {
    server.listen(port, onListening);
  }
  server.once("error", (error: any) => {
    console.error(`[companion] unable to start companion server: ${error?.message || error}`);
    process.exit(1);
  });

  const shutdown = () => {
    console.log("[companion] shutting down companion server");
    stopTerminalShellSession();
    stopVoiceRelay();
    clawLiveWarmCore.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // One usage.status read at startup (1.6-4.4 s CLI on the S24): the first /usage, often the post-deploy
  // acceptance, joins it instead of paying the whole cold read inside its 6 s budget.
  prewarmUsage();
  startTerminalShellSession();
  startWhatsAppListenerWatchdog();
  startVoiceRecoveryWatchdog();
  startVoiceRelay();
  void payments.startBankTimeoutReconciler().then((status:any)=>{
    if(status?.scheduled)console.log(`[payments] scheduled ${status.scheduled} bank timeout reconciliation(s) at ${status.timeoutMs}ms.`);
  }).catch((error:any)=>console.warn(`[payments] bank timeout reconciler unavailable: ${String(error?.message||error).slice(0,160)}`));
  // Bounded provider prewarm: no microphone and no user session context. The first Android session
  // can claim this connection without reconnecting; it cools automatically after the warm idle TTL.
  setTimeout(() => {
    void clawLiveWarmCore.prewarmDefault().then((status) => {
      console.log(`[claw-live-warm] startup prewarm state=${status.state} setupMs=${status.lastSetupMs ?? -1}`);
    }).catch((error: any) => {
      console.warn("[claw-live-warm] startup prewarm failed: " + String(error?.message || error).slice(0, 160));
    });
  }, 1_000).unref();
  // F6: one bounded pass after startup over receipts left by previous instances.
  setTimeout(() => {
    try {
      const sweep = abandonStaleRemoteBridgeReceipts({ budgetMs: 3_000 });
      console.log(`[remote-bridge] abandon sweep state=${sweep.state} scanned=${sweep.scanned} abandoned=${sweep.abandoned} uncertain=${sweep.effectUncertain}`);
    } catch (error: any) {
      console.warn("[remote-bridge] abandon sweep unavailable: " + String(error?.message || error).slice(0, 160));
    }
  }, Number(process.env.CLAWMOBILE_REMOTE_BRIDGE_ABANDON_SWEEP_DELAY_MS || 30_000)).unref();

  return server;
}

function startWhatsAppListenerWatchdog() {
  if (process.env.CLAWMOBILE_WHATSAPP_LISTENER_WATCHDOG === "0") {
    console.log("[companion] WhatsApp listener watchdog disabled.");
    return;
  }

  const configuredMs = Number.parseInt(
    process.env.CLAWMOBILE_WHATSAPP_LISTENER_WATCHDOG_MS || "",
    10,
  );
  const intervalMs =
    Number.isFinite(configuredMs) && configuredMs >= 5_000
      ? configuredMs
      : DEFAULT_WHATSAPP_LISTENER_WATCHDOG_MS;

  const ensureListener = async () => {
    if (whatsappListenerWatchdogBusy) return;
    whatsappListenerWatchdogBusy = true;

    try {
      const status = await getGatewayStatus(1_500);
      if (status.reachable) return;

      console.warn(
        "[companion] OpenClaw gateway is unreachable; listener watchdog is starting it.",
      );

      const result = await startRuntime();
      if (!result.success) {
        console.error(
          "[companion] listener watchdog could not restore OpenClaw: " +
            result.message,
        );
      }
    } catch (error: any) {
      console.error(
        "[companion] listener watchdog error: " +
          (error?.message || String(error)),
      );
    } finally {
      whatsappListenerWatchdogBusy = false;
    }
  };

  setTimeout(() => void ensureListener(), 1_000).unref();
  setInterval(() => void ensureListener(), intervalMs).unref();

  console.log(
    `[companion] WhatsApp listener watchdog enabled every ${intervalMs}ms.`,
  );
}

export async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  conditionalRequests.set(res,req);
  const method = req.method || "GET";
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const routePath = normalizeProtocolPath(requestUrl.pathname);
  if(routePath&&accountGuardedRoute(routePath))accountGuardedResponses.add(res);

  if (shouldBlockBrowserRequest(req, routePath || requestUrl.pathname)) {
    writeJson(res, 403, {
      success: false,
      message: "Browser-origin requests are not allowed for local companion control endpoints.",
    });
    return;
  }

  if (method === "OPTIONS") {
    writeJson(res, 204, {});
    return;
  }

  if (!routePath) {
    writeJson(res, 404, {
      success: false,
      message: `No route for ${method} ${requestUrl.pathname}. Use the /v1 runtime protocol.`,
    });
    return;
  }

  const isLoopback = isLoopbackRequest(req);
  if (isLocalOnlyRoute(routePath, method) && !isLoopback) {
    writeJson(res, 403, {
      success: false,
      message: "This endpoint is restricted to local companion app requests.",
    });
    return;
  }

  if(routePath==="/control/deploys"){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{error:"native_loopback_required"});return;}
    if(method!=="GET"){writeJson(res,405,{error:"method_not_allowed"});return;}
    const query=requestUrl.searchParams;const limit=query.get("limit")??"20";
    if([...query.keys()].some(k=>k!=="limit")||query.getAll("limit").length>1||!/^([1-9]|[1-4][0-9]|50)$/.test(limit)){writeJson(res,400,{error:"invalid_deployments_query"});return;}
    res.setHeader("Cache-Control","no-store");writeJson(res,200,await readDeploymentReceipts(Number(limit)));return;
  }

  if(routePath==="/files"||routePath==="/files/content"){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_loopback_required"});return;}
    if(method!=="GET"){writeJson(res,req.headers["x-clawmobile-owner-flow"]!=="v1"?403:405,{success:false,state:"refused",receipt:null,error:"file_read_only"});return;}
    try{
      const value:any=routePath==="/files"?await filesList(requestUrl.searchParams):await filesContent(requestUrl.searchParams);
      if(value.bytes){
        if(value.contentType.startsWith("image/")){res.writeHead(200,{"Content-Type":value.contentType,"Content-Length":value.bytes.length,"X-Content-Type-Options":"nosniff","Cache-Control":"no-store","X-Samantha-File-Schema-Qualified":"false"});res.end(value.bytes);}
        else{const {bytes,...metadata}=value;res.setHeader("X-Content-Type-Options","nosniff");writeJson(res,200,{...metadata,text:bytes.toString("utf8")});}
      }else writeJson(res,200,value);
    }catch(error:any){const status=[400,404,409].includes(error?.statusCode)?error.statusCode:503;const code=status===404?"file_not_available":status===409?"file_cursor_changed":status===400?"invalid_file_query":"files_owner_unavailable";writeJson(res,status,{success:false,state:"refused",receipt:null,ready:false,installedSchemaQualified:false,error:code});}
    return;
  }

  if(routePath==="/control/memory"||routePath.startsWith("/control/memory/")){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]||(method!=="GET"&&req.headers["x-clawmobile-owner-flow"]!=="v1")){
      writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_owner_flow_required"});return;
    }
    res.setHeader("Cache-Control","no-store");
    try{
      if(routePath==="/control/memory"){
        if(method!=="GET"){writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
        writeJson(res,200,await memoryRead(requestUrl.searchParams));return;
      }
      if(routePath==="/control/memory/import/preview"||routePath==="/control/memory/import"){
        if(method!=="POST"){writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
        if(requestUrl.search)throw Object.assign(new Error(),{statusCode:400});
        const result=await memoryImport(await readJsonBody(req,1024*1024),routePath==="/control/memory/import");
        writeJson(res,result.state==="conflict"?409:result.state==="failed"?503:200,result);return;
      }
      const match=/^\/control\/memory\/([a-f0-9]{64})\/forget$/.exec(routePath);
      if(!match){writeJson(res,404,{success:false,state:"refused",receipt:null,error:"not_found"});return;}
      if(method!=="POST"){writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
      if(requestUrl.search)throw Object.assign(new Error(),{statusCode:400});
      const result=await memoryForget(match[1],await readJsonBody(req,1024));
      writeJson(res,(result.state==="refused"||result.state==="conflict")?409:result.state==="not_found"?404:result.state==="failed"?503:200,result);
    }catch(error:any){const status=[400,409].includes(error?.statusCode)?error.statusCode:503;writeJson(res,status,{success:false,state:status===503?"failed":"refused",receipt:null,error:status===400?"invalid_memory_request":status===409?"memory_preview_changed":"memory_owner_unavailable"});}
    return;
  }

  if(routePath==="/control/engineering"||routePath.startsWith("/control/engineering/")){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_loopback_required"});return;}
    if(method!=="GET"){res.setHeader("Allow","GET");writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
    if(routePath!=="/control/engineering"){writeJson(res,404,{success:false,state:"not_found",receipt:null,error:"not_found"});return;}
    const parameters=requestUrl.searchParams;
    const offset=parameters.get("offset")||"0",limit=parameters.get("limit")||"20",revision=parameters.get("revision")||undefined;
    if([...parameters.keys()].some(key=>!['offset','limit','revision'].includes(key))||['offset','limit','revision'].some(key=>parameters.getAll(key).length>1)||!/^\d{1,3}$/.test(offset)||Number(offset)>500||!/^\d{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100||(revision&&!/^[a-f0-9]{64}$/.test(revision))){writeJson(res,400,{success:false,state:"refused",receipt:null,error:"invalid_pagination"});return;}
    try{const value=await engineeringRead(Number(offset),Number(limit),revision);res.setHeader("Cache-Control","no-store");writeJson(res,value.state==="conflict"?409:200,value);}
    catch{writeJson(res,503,{success:false,state:"unavailable",receipt:null,error:"engineering_unavailable"});}
    return;
  }

  if(routePath==="/learning/associations"||routePath.startsWith("/learning/")){
    // 38 A2 : owner natif uniquement ; mutations avec l'en-tête propriétaire. Jamais d'approve (D1).
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]||(method!=="GET"&&req.headers["x-clawmobile-owner-flow"]!=="v1")){
      writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_owner_flow_required"});return;
    }
    res.setHeader("Cache-Control","no-store");
    try{
      if(routePath==="/learning/associations"){
        if(method!=="GET"){res.setHeader("Allow","GET");writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
        const value=await learningList(requestUrl.searchParams);writeJson(res,value.state==="unavailable"?503:200,value);return;
      }
      const forget=/^\/learning\/associations\/([a-f0-9]{64})\/forget$/.exec(routePath);
      if(!forget&&routePath!=="/learning/not-this"){writeJson(res,404,{success:false,state:"not_found",receipt:null,error:"not_found"});return;}
      if(method!=="POST"){res.setHeader("Allow","POST");writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
      if(requestUrl.search)throw Object.assign(new Error(),{statusCode:400});
      const value=forget?await learningForget(forget[1],await readJsonBody(req,1024)):await learningNotThis(await readJsonBody(req,1024));
      writeJson(res,value.state==="not_found"?404:200,value);
    }catch(error:any){const status=error?.statusCode===400?400:503;writeJson(res,status,{success:false,state:status===400?"refused":"unavailable",receipt:null,error:status===400?"invalid_learning_request":"learning_owner_unavailable"});}
    return;
  }

  if (/^\/control\/requests\/[^/]+\/cancel$/.test(routePath)) {
    if (!isLoopback || req.headers.origin || req.headers.referer || req.headers["sec-fetch-site"] ||
        req.headers["x-clawmobile-owner-flow"] !== "v1") {
      writeJson(res,403,{success:false,error:"native_owner_flow_required"});return;
    }
    if(method!=="POST"){res.setHeader("Allow","POST");writeJson(res,405,{success:false,error:"method_not_allowed"});return;}
    try{
      let reference:string;try{reference=decodeURIComponent(routePath.split("/")[3]);}catch{throw Object.assign(new Error(),{statusCode:400});}
      const value=await cancelControlRequest(reference,await readJsonBody(req,1024));
      res.setHeader("Cache-Control","no-store");writeJson(res,value.state==="refused"?409:value.state==="not_found"?404:200,value);
    }catch(error:any){writeJson(res,error?.statusCode===400?400:503,{success:false,error:error?.statusCode===400?"invalid_cancellation_request":"control_action_unavailable"});}
    return;
  }

  if(routePath.startsWith("/control/diagnostic/")){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_loopback_required"});return;}
    if(method!=="GET"){res.setHeader("Allow","GET");writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
    res.setHeader("Cache-Control","no-store");
    try{
      if(routePath==="/control/diagnostic/export"){
        if(requestUrl.search)throw Object.assign(new Error(),{statusCode:400});
        writeJson(res,200,{success:true,state:"ok",receipt:null,artifact:await diagnosticRead("export")});return;
      }
      const match=/^\/control\/diagnostic\/logs\/(agent|installation|engineering)$/.exec(routePath);
      if(!match){writeJson(res,404,{success:false,state:"not_found",receipt:null,error:"not_found"});return;}
      const value=await diagnosticRead("logs",match[1],requestUrl.searchParams);
      writeJson(res,200,{success:value.available,state:value.available?"ok":"unavailable",receipt:null,...value});
    }catch(e:any){const invalid=e?.statusCode===400;writeJson(res,invalid?400:503,{success:false,state:invalid?"refused":"unavailable",receipt:null,error:invalid?"invalid_diagnostic_request":"diagnostic_source_unavailable"});}
    return;
  }

  if (routePath.startsWith("/automations/")) {
    if (!isLoopback || req.headers.origin || req.headers.referer || req.headers["sec-fetch-site"] ||
        (method !== "GET" && req.headers["x-clawmobile-owner-flow"] !== "v1")) {
      writeJson(res,403,{success:false,error:"native_owner_flow_required"}); return;
    }
    try {
      const match=/^\/automations\/([^/]+)(?:\/(enable|disable|run))?$/.exec(routePath);
      if(!match)throw Object.assign(new Error("invalid_automation_route"),{statusCode:404});
      let id:string;try{id=decodeURIComponent(match[1]);}catch{throw Object.assign(new Error("invalid_automation_id"),{statusCode:400});}
      res.setHeader("Cache-Control","no-store");
      if(method==="GET"&&!match[2]){writeJson(res,200,await automationDetail(id));return;}
      if(method==="PATCH"&&!match[2]){
        // R23 / E1: payment and validation refusals precede any owner read; CAS via If-Match (native configRevision).
        const ifMatch=typeof req.headers["if-match"]==="string"?req.headers["if-match"].replace(/^"|"$/g,""):undefined;
        let result:any;
        try{result=await editAutomation(id,await readJsonBody(req,8*1024),ifMatch);}
        catch(error:any){
          const status=[400,404,409,413,422,428].includes(error?.statusCode)?error.statusCode:503;
          const known=["invalid_automation_edit","invalid_automation_id","automation_sensitive_input","automation_payment_excluded","automation_message_unsupported","automation_protected","automation_not_found","automation_revision_required","operation_conflict"];
          writeJson(res,status,{success:false,state:status===503?"failed":"refused",receipt:null,error:known.includes(error?.message)?error.message:status===503?"automation_unavailable":"invalid_automation_request"});return;
        }
        writeJson(res,result.state==="needs_confirmation"?403:result.state==="refused"||result.state==="blocked"?409:result.state==="completed"?200:503,result);return;
      }
      if((method==="POST"&&match[2])||(method==="DELETE"&&!match[2])){
        const result=await changeAutomation(id,match[2]||"delete",await readJsonBody(req,1024));
        writeJson(res,result.state==="blocked"?409:result.state==="not_found"?404:result.state==="failed"?503:result.state==="refused"?403:200,result);return;
      }
      res.setHeader("Allow",match[2]?"POST":"GET, PATCH, DELETE");writeJson(res,405,{success:false,error:"method_not_allowed"});
    } catch(error:any) {
      const code=[400,404,409].includes(error?.statusCode)?error.statusCode:503;
      writeJson(res,code,{success:false,error:code===400?"invalid_automation_request":code===404?"automation_not_found":code===409?"operation_conflict":"automation_unavailable"});
    }
    return;
  }

  if(routePath.startsWith('/laptop-access/')){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers['sec-fetch-site']||(method!=='GET'&&req.headers['x-clawmobile-owner-flow']!=='v1')){writeJson(res,403,{success:false,state:'refused',receipt:null,reason:'native_owner_flow_required'});return;}
    res.setHeader('Cache-Control','no-store');
    try{
      if(requestUrl.search)throw Object.assign(new Error(),{statusCode:400});
      if(method==='GET'&&routePath==='/laptop-access/computers'){writeJson(res,200,await laptopList());return;}
      if(method==='POST'&&routePath==='/laptop-access/pairings'){writeJson(res,200,await laptopPairStart(await readJsonBody(req,1024)));return;}
      const pair=/^\/laptop-access\/pairings\/([a-f0-9]{32})(\/commit)?$/.exec(routePath);
      if(pair&&method==='GET'&&!pair[2]){writeJson(res,200,await laptopPairStatus(pair[1]));return;}
      if(pair&&method==='POST'&&pair[2]){writeJson(res,200,await laptopChange('commit',pair[1],await readJsonBody(req,2048)));return;}
      const pc=/^\/laptop-access\/computers\/([^/]+)$/.exec(routePath);
      if(pc&&method==='DELETE'){writeJson(res,200,await laptopChange('revoke',decodeURIComponent(pc[1]),await readJsonBody(req,2048)));return;}
      writeJson(res,405,{success:false,state:'refused',receipt:null,reason:'unsupported_laptop_route'});
    }catch(error:any){const invalid=error?.statusCode===400||error instanceof URIError;writeJson(res,invalid?400:503,{success:false,state:invalid?'refused':'indeterminate',receipt:null,reason:invalid?'invalid_laptop_operation':'laptop_owner_indeterminate'});}
    return;
  }

  const conversationMetadata=/^\/conversations\/([^/]+)\/metadata$/.exec(routePath);
  if(conversationMetadata){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]||(method!=="GET"&&req.headers["x-clawmobile-owner-flow"]!=="v1")){writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_owner_flow_required"});return;}
    if(!['GET','POST'].includes(method)){res.setHeader('Allow','GET, POST');writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
    try{
      if(requestUrl.search)throw Object.assign(new Error(),{statusCode:400});
      let id:string;try{id=decodeURIComponent(conversationMetadata[1]);}catch{throw Object.assign(new Error(),{statusCode:400});}
      const value=method==='GET'?await readConversationMetadata(id):await changeConversationMetadata(id,await readJsonBody(req,2048));
      res.setHeader('Cache-Control','no-store');writeJson(res,Number.isInteger(value.httpStatus)?value.httpStatus:value.state==='refused'?409:200,value);
    }catch(error:any){const status=[400,404,409].includes(error?.statusCode)?error.statusCode:503;writeJson(res,status,{success:false,state:status===503?'unavailable':'refused',receipt:null,error:status===400&&error?.message==='unsupported_thinking_level'?'unsupported_thinking_level':status===400?'invalid_conversation_metadata':status===404?'conversation_not_found':status===409&&['run_active','conversation_model_change_requires_idle','unknown_conversation_model','conversation_identity_unavailable','conversation_identity_changed','conversation_identity_ambiguous','conversation_label_already_used','protected_owner_activity','operation_conflict'].includes(error?.message)?error.message:status===409?'operation_conflict':'conversation_owner_unavailable'});}
    return;
  }

  if(routePath==="/security/surfaces"){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_loopback_required"});return;}
    if(method!=="GET"){res.setHeader("Allow","GET");writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
    if(requestUrl.search){writeJson(res,400,{success:false,state:"refused",receipt:null,error:"unsupported_parameter"});return;}
    try{res.setHeader("Cache-Control","no-store");writeJson(res,200,await securitySurfaces());}
    catch{writeJson(res,503,{success:false,state:"unavailable",receipt:null,error:"security_surfaces_unavailable"});}
    return;
  }

  if(routePath==="/updates"||routePath.startsWith("/updates/")){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_loopback_required"});return;}
    if(method!=="GET"){res.setHeader("Allow","GET");writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
    if(routePath!=="/updates"){writeJson(res,404,{success:false,state:"not_found",receipt:null,error:"not_found"});return;}
    if(requestUrl.search){writeJson(res,400,{success:false,state:"refused",receipt:null,error:"unsupported_parameter"});return;}
    try{res.setHeader("Cache-Control","no-store");writeJson(res,200,await updatesRead());}
    catch{writeJson(res,503,{success:false,state:"unavailable",receipt:null,error:"updates_unavailable"});}
    return;
  }

  const agentApprovalMatch=routePath.match(/^\/runs\/([^/]+)\/approval$/);
  if(agentApprovalMatch){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers['sec-fetch-site']||(method!=='GET'&&req.headers['x-clawmobile-owner-flow']!=='v1')){
      writeJson(res,403,{success:false,state:'refused',receipt:null,error:'native_owner_flow_required'});return;
    }
    res.setHeader('Cache-Control','no-store');
    if(!['GET','POST'].includes(method)){res.setHeader('Allow','GET, POST');writeJson(res,405,{success:false,state:'refused',receipt:null,error:'method_not_allowed'});return;}
    try{
      if(requestUrl.search)throw Object.assign(Error(),{statusCode:400});
      const runId=decodeURIComponent(agentApprovalMatch[1]);
      const value=method==='GET'?readRunApproval(runId):await decideRunApproval(runId,await readJsonBody(req,2048));
      writeJson(res,value.state==='refused'?409:value.state==='failed'?503:200,value);
    }catch(error:any){const code=error instanceof URIError?400:[400,403,404,409].includes(error?.statusCode)?error.statusCode:503;
      writeJson(res,code,{success:false,state:code===503?'failed':'refused',receipt:null,error:code===400?'invalid_approval_operation':code===403?(error?.message==='confirmation_not_found'?'confirmation_not_found':'confirmation_scope_mismatch'):code===404?'approval_run_not_found':code===409?'confirmation_not_usable':'approval_owner_unavailable'});}
    return;
  }

  if(routePath==="/usage"||routePath==="/providers"){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{error:"native_loopback_required"});return;}
    res.setHeader("Cache-Control","no-store");
    if(method!=="GET"){writeJson(res,405,{error:"method_not_allowed"});return;}
    const parameters=requestUrl.searchParams;
    if(routePath==="/usage"){
      if([...parameters.keys()].some(k=>k!=="details")||parameters.getAll("details").length>1||parameters.has("details")&&parameters.get("details")!=="cost"){writeJson(res,400,{error:"unsupported_parameter"});return;}
      writeJson(res,200,parameters.has("details")?await readUsageDetails():await readUsage());
    }else{
      if([...parameters.keys()].some(k=>k!=="refresh")||parameters.getAll("refresh").length>1||parameters.has("refresh")&&parameters.get("refresh")!=="1"){writeJson(res,400,{error:"unsupported_parameter"});return;}
      writeJson(res,200,await readProviders(parameters.get("refresh")==="1"));
    }
    return;
  }

  if(routePath==="/agent/config"){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]||(method!=="GET"&&req.headers["x-clawmobile-owner-flow"]!=="v1")){
      writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_owner_flow_required"});return;
    }
    res.setHeader("Cache-Control","no-store");
    if(!['GET','POST'].includes(method)){writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
    try{
      if(requestUrl.search)throw Object.assign(new Error(),{statusCode:400});
      const value=method==='GET'?await readAgentConfig():await changeAgentConfig(await readJsonBody(req,2048));
      writeJson(res,value.state==='refused'?409:200,value);
    }catch(error:any){const status=[400,403,409].includes(error?.statusCode)?error.statusCode:503;writeJson(res,status,{success:false,state:status===503?'failed':'refused',receipt:null,error:status===400?'invalid_agent_config':status===403?'confirmation_scope_mismatch':status===409?'protected_or_conflicting_configuration':'agent_config_unavailable'});}
    return;
  }

  if(routePath==="/whatsapp/allowlist"||routePath.startsWith("/whatsapp/allowlist/")){
    res.setHeader("Cache-Control","no-store");
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]||(method!=="GET"&&req.headers["x-clawmobile-owner-flow"]!=="v1")){writeJson(res,403,{success:false,state:"refused",receipt:null});return;}
    try{
      const suffix=routePath.slice("/whatsapp/allowlist".length);
      if(suffix==="/history"&&method==="GET"){
        const query=requestUrl.searchParams,limit=query.get("limit")||"50",before=query.get("before")||undefined;
        if([...query.keys()].some(k=>!['limit','before'].includes(k))||query.getAll('limit').length>1||query.getAll('before').length>1||!/^\d{1,2}$/.test(limit)||Number(limit)<1||Number(limit)>50||(before&&!/^[A-Za-z0-9_-]{1,160}$/.test(before)))throw Object.assign(new Error(),{statusCode:400});
        writeJson(res,200,await allowlistRead('history',undefined,{limit:Number(limit),...(before?{before}: {})}));return;
      }
      if(requestUrl.search)throw Object.assign(new Error(),{statusCode:400});
      if(!suffix&&method==='GET'){writeJson(res,200,await allowlistRead('list'));return;}
      const match=/^\/(wa-[a-f0-9]{16})(\/note)?$/.exec(suffix);
      if(match&&method==='GET'){writeJson(res,200,await allowlistRead(match[2]?'note-get':'get',match[1]));return;}
      if((!suffix&&method==='POST')||(match&&!match[2]&&['PATCH','DELETE'].includes(method))||(match&&match[2]&&method==='PUT')){
        const value=await allowlistChange(!suffix?'add':match![2]?'note':method==='DELETE'?'remove':'patch',match?.[1],await allowlistBody(req));writeJson(res,value.status,value.value);return;
      }
      writeJson(res,match||!suffix||suffix==='/history'?405:404,{success:false,state:match||!suffix||suffix==='/history'?'refused':'not_found',receipt:null});
    }catch(error:any){
      const reason=error?.message;const known=['owner_contact_protected','country_code_required','invalid_e164','confirmation_required','confirmation_mismatch','confirmation_expired','invalid_scope','invalid_duration','note_too_long','unknown_contact','operation_conflict'].includes(reason);
      const code=error?.statusCode===413?400:[400,403,404,409,503].includes(error?.statusCode)?error.statusCode:503;
      writeJson(res,code,{success:false,state:code===503?'failed':'refused',receipt:null,...(known?{reason}:code===503?{error:'allowlist_unavailable'}:{})});
    }
    return;
  }

  if(routePath==='/catalog'){
    res.setHeader('Cache-Control','private, no-cache');
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers['sec-fetch-site']){writeJson(res,403,{success:false,error:'native_loopback_required'});return;}
    if(method!=='GET'){writeJson(res,405,{success:false,error:'method_not_allowed'});return;}
    // The app sends ?locale=fr|en (HomeCatalog.kt); any other parameter is refused.
    const params=[...requestUrl.searchParams.keys()];const queryLocale=requestUrl.searchParams.get('locale');
    if(params.some(k=>k!=='locale')||params.length>1||(queryLocale!==null&&!['fr','en'].includes(queryLocale))){writeJson(res,400,{success:false,error:'unsupported_parameter'});return;}
    const locale=(queryLocale as 'fr'|'en'|null)||(/^en(?:-|,|;|$)/i.test(String(req.headers['accept-language']||''))?'en':'fr');
    res.setHeader('Vary','Accept-Language');res.setHeader('Content-Language',locale);
    try{const value=await readCatalogResponse(locale);
      const tag=catalogETag(value);res.setHeader('ETag',tag);
      if(req.headers['if-none-match']===tag){res.writeHead(304);res.end();return;}
      writeJson(res,200,value);
    }catch{writeJson(res,503,{success:false,error:'catalog_source_unavailable'});}
    return;
  }

  if(routePath==="/notifications/sources"||routePath.startsWith("/notifications/sources/")){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{success:false,error:"native_loopback_required"});return;}
    if(method!=='GET'){writeJson(res,405,{success:false,error:"canonical_source_toggle_unavailable"});return;}
    if(routePath!=="/notifications/sources"){writeJson(res,404,{success:false,error:"not_found"});return;}
    if(requestUrl.search){writeJson(res,400,{success:false,error:"unsupported_parameter"});return;}
    try{res.setHeader("Cache-Control","no-store");writeJson(res,200,await notificationSources());}
    catch{writeJson(res,503,{success:false,error:"notification_sources_unavailable"});}
    return;
  }

  if (routePath === "/confirmations" || routePath.startsWith("/confirmations/")) {
    if (req.headers.origin || req.headers.referer || req.headers["sec-fetch-site"] ||
        req.headers["x-clawmobile-owner-flow"] !== "v1") {
      writeJson(res,403,{success:false,message:"native_owner_flow_required"}); return;
    }
    if (method === "GET" && routePath === "/confirmations/capabilities") {
      writeJson(res,200,confirmations.capabilities()); return;
    }
    if (method === "POST" && routePath === "/confirmations") {
      writeJson(res,200,await confirmations.prepare(await readJsonBody(req,4096))); return;
    }
    const match = /^\/confirmations\/([a-f0-9-]{36})(?:\/(challenge|owner-confirmation|cancel))?$/.exec(routePath);
    if (match) {
      const [,id,action] = match;
      if (method === "GET" && !action) {writeJson(res,200,await confirmations.status(id)); return;}
      if (method === "GET" && action === "challenge") {writeJson(res,200,await confirmations.challenge(id)); return;}
      if (method === "POST" && action === "owner-confirmation") {
        writeJson(res,200,await confirmations.confirm(id,await readJsonBody(req,2048))); return;
      }
      if (method === "POST" && action === "cancel") {
        const body=await readJsonBody(req,256);
        if (!body || typeof body!=="object" || Array.isArray(body) || Object.keys(body).length)
          throw new HttpError(400,"invalid_cancellation_request");
        writeJson(res,200,await confirmations.cancel(id)); return;
      }
    }
    writeJson(res,404,{success:false,message:"confirmation_route_not_found"}); return;
  }

  if (routePath === "/payments/capabilities" || routePath === "/payments" || routePath.startsWith("/payments/")) {
    // This native boundary never accepts browser-origin control, even when other routes opt in.
    if (req.headers.origin || req.headers.referer || req.headers["sec-fetch-site"] ||
        req.headers["x-clawmobile-owner-flow"] !== "v1") {
      writeJson(res, 403, {success:false, message:"native_owner_flow_required"}); return;
    }
    if (method === "GET" && routePath === "/payments/capabilities") {
      writeJson(res, 200, payments.capabilities()); return;
    }
    if (method === "GET" && routePath === "/payments/payables") {
      const adapterId=requestUrl.searchParams.get("adapterId")||undefined;
      writeJson(res,200,await payments.listPayables(adapterId)); return;
    }
    if (method === "POST" && routePath === "/payments") {
      writeJson(res, 200, await payments.prepare(await readJsonBody(req, 4096))); return;
    }
    if (method === "POST" && routePath === "/payments/local-intents") {
      writeJson(res, 200, await payments.prepareLocalIntent(await readJsonBody(req, 4096))); return;
    }
    if (method === "POST" && routePath === "/payments/local-handoffs") {
      writeJson(res,200,await payments.prepareLocalHandoff(await readJsonBody(req,4096))); return;
    }
    const localIntentStatusMatch = /^\/payments\/local-intents\/([a-f0-9-]{36})$/.exec(routePath);
    if (method === "GET" && localIntentStatusMatch) {
      writeJson(res, 200, await payments.localIntentStatus(localIntentStatusMatch[1])); return;
    }
    if (method === "POST" && routePath === "/payments/local-start") {
      writeJson(res, 200, await payments.localStart(await readJsonBody(req, 512))); return;
    }
    const match = /^\/payments\/([a-f0-9-]{36})(?:\/(challenge|owner-confirmation|bank-authorization|bank-return|bank-ui-event|resume|cancel))?$/.exec(routePath);
    if (match) {
      const [, id, action] = match;
      if (method === "GET" && !action) {
        // view=compact: bounded Android projection (no forensic timeline) used by the bank countdown/reconciliation.
        writeJson(res,200,requestUrl.searchParams.get("view")==="compact"?await payments.statusCompact(id):await payments.status(id)); return;
      }
      if (method === "GET" && action === "challenge") { writeJson(res,200,await payments.challenge(id)); return; }
      if (method === "POST" && action === "cancel") {
        const body=await readJsonBody(req,256);
        if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length)throw new HttpError(400,"invalid_cancellation_request");
        writeJson(res,200,await payments.cancel(id)); return;
      }
      if (method === "POST" && action === "owner-confirmation") {
        writeJson(res,200,await payments.confirm(id,await readJsonBody(req,2048))); return;
      }
      if (method === "POST" && action === "bank-authorization") {
        const body=await readJsonBody(req,256);
        if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length)throw new HttpError(400,"invalid_bank_authorization_request");
        writeJson(res,200,await payments.bankAuthorization(id)); return;
      }
      if (method === "POST" && action === "bank-ui-event") {
        writeJson(res,200,await payments.bankUiEvent(id,await readJsonBody(req,1024))); return;
      }
      if (method === "POST" && action === "bank-return") {
        const body=await readJsonBody(req,256);
        if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).sort().join(",")!=="bankReturnToken"||typeof (body as any).bankReturnToken!=="string")
          throw new HttpError(400,"invalid_bank_return_request");
        writeJson(res,200,await payments.bankReturn(id,(body as any).bankReturnToken)); return;
      }
      if (method === "POST" && action === "resume") {
        const body=await readJsonBody(req,512);
        if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).sort().join(",")!=="confirmationRequestId"||typeof (body as any).confirmationRequestId!=="string")
          throw new HttpError(400,"invalid_payment_resume_request");
        writeJson(res,200,await payments.resume(id,(body as any).confirmationRequestId)); return;
      }
    }
    writeJson(res,404,{success:false,message:"payment_route_not_found"}); return;
  }

  if (await handleControl(req, res, routePath)) return;

  if (method === "GET" && routePath === "/") {
    writeJson(res, 200, {
      name: "ClawMobile Companion Server",
      version: VERSION,
      protocol: "v1",
      endpoints: [
        "/v1/health",
        "/v1/files",
        "/v1/files/content",
        "/v1/capabilities",
        "/v1/attachments",
        "/v1/attachments/:attachmentId/content",
        "/v1/confirmations",
        "/v1/confirmations/:requestId/challenge",
        "/v1/confirmations/:requestId/owner-confirmation",
        "/v1/payments",
        "/v1/payments/local-intents",
        "/v1/payments/local-start",
        "/v1/payments/:requestId/challenge",
        "/v1/payments/:requestId/owner-confirmation",
        "/v1/payments/:requestId/bank-authorization",
        "/v1/payments/:requestId/bank-return",
        "/v1/payments/:requestId/resume",
        "/v1/runs",
        "/v1/runs/by-client/:clientRunId",
        "/v1/runs/:runId",
        "/v1/sessions/:sessionId/archive",
        "/v1/sessions/:sessionId",
        "/v1/learning/associations",
        "/v1/learning/associations/:associationId/forget",
        "/v1/learning/not-this",
        "/v1/runtime/start",
        "/v1/runtime/stop",
        "/v1/runtime/restart",
        "/v1/runtime/log",
        "/v1/skills",
        "/v1/skills/learn",
        "/v1/skills/candidates",
        "/v1/skills/candidates/:traceId",
        "/v1/skills/route",
        "/v1/skills/:skillId",
        "/v1/skills/:skillId/preview",
        "/v1/skills/:skillId/run",
        "/v1/skills/:skillId/fast-paths/:fastPathId/run",
        "/v1/skills/:skillId/runs",
        "/v1/skill-runs/:runId",
        "/v1/extensions/android/terminal/command",
        "/v1/extensions/android/terminal/session",
        "/v1/extensions/android/terminal/session/input",
        "/v1/extensions/android/terminal/session/reset",
        "/v1/extensions/remote-bridge/health",
        "/v1/extensions/remote-bridge/requests",
        "/v1/extensions/remote-bridge/requests/:requestId",
        "/v1/extensions/capability-bridge/resolve",
        "/v1/extensions/capability-bridge/execute",
        "/v1/extensions/voice-relay/health",
        "/v1/extensions/claw-live",
        "/v1/extensions/claw-live/token",
        "/v1/extensions/claw-live/prewarm",
        "/v1/extensions/claw-live/warm-status",
        "/v1/extensions/claw-live/socket",
        "/v1/extensions/claw-live/decision",
        "/v1/extensions/claw-live/capability",
        "/v1/extensions/android/voice-recovery/intentional-stop",
        "/v1/extensions/android/voice-recovery/probe",
        "/v1/extensions/android/voice-recovery/status",
        "/v1/extensions/android/voice-recovery/pending",
        "/v1/extensions/android/voice-recovery/suspend",
        "/v1/extensions/android/voice-recovery/resume",
        "/v1/extensions/nostr/status",
        "/v1/extensions/nostr/setup-key",
        "/v1/extensions/nostr/contacts",
        "/v1/extensions/nostr/contacts/:contactId",
        "/v1/extensions/nostr/send",
        "/v1/extensions/nostr/inbox",
        "/v1/conversations/:sessionId/metadata",
        "/v1/extensions/agent/conversations",
        "/v1/extensions/agent/conversations/:agentId/messages",
        "/v1/extensions/agent/inbox/fetch",
        "/v1/extensions/agent/messages/:messageId/read",
        "/v1/extensions/skill-sharing/skills/:skillId/share",
        "/v1/extensions/skill-sharing/skills/:skillId/share/nostr",
        "/v1/extensions/skill-sharing/imports",
        "/v1/extensions/skill-sharing/imports/:importId/accept",
        "/v1/extensions/skill-sharing/imports/:importId/reject",
      ],
    });
    return;
  }

  if (method === "GET" && routePath === "/health") {
    writeJson(res, 200, await health({ trusted: isLoopback }));
    return;
  }

  if(routePath.startsWith("/capabilities/")){
    res.setHeader("Cache-Control","no-store");
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_loopback_required"});return;}
    if(method!=="GET"){res.setHeader("Allow","GET");writeJson(res,405,{success:false,state:"refused",receipt:null,error:"read_only"});return;}
    try{
      if(requestUrl.search||!/^\/capabilities\/[^/]+$/.test(routePath))throw Object.assign(new Error(),{statusCode:400});
      let id:string;try{id=decodeURIComponent(routePath.split('/')[2]);}catch{throw Object.assign(new Error(),{statusCode:400});}
      const result=await capabilityDetail(id);writeJson(res,result.found?200:404,result);
    }catch(error:any){writeJson(res,error?.statusCode===400?400:503,{success:false,state:error?.statusCode===400?"refused":"unavailable",receipt:null,error:error?.statusCode===400?"invalid_capability_id":"capability_registry_unavailable"});}
    return;
  }

  if (method === "GET" && routePath === "/capabilities") {
    writeJson(res, 200, await capabilities({ trusted: isLoopback }));
    return;
  }

  if (method === "GET" && routePath === "/remote-bridge/health") {
    writeJson(res, 200, remoteBridgeHealth());
    return;
  }

  if (method === "GET" && routePath === "/voice-relay/health") {
    writeJson(res, 200, voiceRelayHealth());
    return;
  }

  if (method === "POST" && routePath === "/remote-bridge/requests") {
    const body = await readJsonBody<any>(req);
    delete body._claw_access; // JSON callers cannot attest their MCP authentication.
    const result = await submitRemoteBridgeRequest(body);
    writeJson(res, result.state === "failed" ? 400 : 200, result);
    return;
  }

  const remoteBridgeRequestMatch = routePath.match(/^\/remote-bridge\/requests\/([^/]+)$/);
  if (method === "GET" && remoteBridgeRequestMatch) {
    const requestId = decodeURIComponent(remoteBridgeRequestMatch[1]);
    const result = getRemoteBridgeRequest(requestId);
    writeJson(res, result ? 200 : 404, result || { error: "request_not_found" });
    return;
  }

  if (method === "POST" && (routePath === "/capability-bridge/resolve" || routePath === "/capability-bridge/execute")) {
    const body = await readJsonBody<any>(req);
    const result = await capabilityBridge(String(body?.request || body?.text || ""), {
      execute: routePath.endsWith("/execute"),
      surface: String(body?.surface || "bixby"),
      caller: String(body?.caller || "owner"),
      timeoutSeconds: Number(body?.timeoutSeconds || 30),
    });
    writeJson(res, result.success === false ? 400 : 200, result);
    return;
  }

  if (method === "GET" && routePath === "/claw-live") {
    writeHtml(res, 200, clawLivePageHtml());
    return;
  }

  if (routePath === "/voice/voices") {
    if (!isLoopback || req.headers.origin || req.headers.referer || req.headers["sec-fetch-site"]) {writeJson(res,403,{success:false,error:"native_loopback_required"});return;}
    if(method!=="GET"){res.setHeader("Allow","GET");writeJson(res,405,{success:false,error:"method_not_allowed"});return;}
    if(requestUrl.search){writeJson(res,400,{success:false,error:"unsupported_voice_parameter"});return;}
    res.setHeader("Cache-Control","no-store");writeJson(res,200,clawLiveVoices());return;
  }

  if (method === "POST" && routePath === "/claw-live/token") {
    res.setHeader("Cache-Control", "no-store");
    try {
      const body = await readJsonBody<any>(req);
      writeJson(res, 200, await createClawLiveToken(undefined, undefined, {
        voice: validatedClawLiveVoice(body?.voice),
        locale: String(body?.locale || "fr"),
        client: String(body?.client || "browser"),
      }));
    } catch (error: any) {
      writeJson(res, error?.statusCode===400 ? 400 : 502, { success: false, ...(error?.statusCode===400 ? {error:"unknown_voice",message:"unknown_voice"} : {message:String(error?.message || "claw_live_token_failed").slice(0, 500)}) });
    }
    return;
  }

  if (method === "POST" && routePath === "/claw-live/prewarm") {
    const body=await readJsonBody<any>(req);
    try { writeJson(res,200,{success:true,...await clawLiveWarmCore.prewarm(clawLiveWarmMeta(body))}); }
    catch(error:any){ writeJson(res,error?.statusCode===400?400:502,{success:false,...clawLiveWarmCore.status(),...(error?.statusCode===400?{error:"unknown_voice",message:"unknown_voice"}:{message:String(error?.message||"claw_live_prewarm_failed").slice(0,240)})}); }
    return;
  }

  if (method === "GET" && routePath === "/claw-live/warm-status") {
    res.setHeader("Cache-Control","no-store");writeJson(res,200,{success:true,...clawLiveWarmCore.status()});return;
  }

  if (method === "POST" && routePath === "/claw-live/decision") {
    const body = await readJsonBody<any>(req);
    const result = await capabilityBridge(String(body?.request || ""), {
      execute: false,
      surface: "claw_live",
      caller: "owner",
      timeoutSeconds: 10,
    });
    res.setHeader("Cache-Control", "no-store");
    writeJson(res, result.success === false ? 400 : 200, result);
    return;
  }

  if (method === "POST" && routePath === "/claw-live/capability") {
    const body = await readJsonBody<any>(req);
    // 38 E3: canonical CLARIFY + resolve-clarification first, then the existing executor.
    const execute = () => clawLiveCapabilityTurn(
      {
        request: body?.request,
        // Android v2 has no clarificationId field: its pending question is scoped to the owned voice session.
        clarificationId: typeof body?.clarificationId === "string" ? body.clarificationId
          : body?.voiceTurn?.sessionEpoch !== undefined ? SurfaceClarifications.idFor("claw-live:" + String(body.voiceTurn.sessionEpoch)) : undefined,
        originId: body?.voiceTurn?.turnId ? "claw-live-" + String(body.voiceTurn.turnId) : undefined,
      },
      (text) => capabilityBridge(text, { execute: true, surface: "claw_live", caller: "owner", timeoutSeconds: 35 }),
    );
    const result = body?.voiceTurn
      ? await clawLiveWarmCore.executeVoiceCapability(body.voiceTurn,String(body?.request||""),execute)
      : await execute();
    res.setHeader("Cache-Control", "no-store");
    writeJson(res, result.success === false ? 400 : 200, result);
    return;
  }

  if (method === "POST" && routePath === "/runs") {
    const body = await readJsonBody<RunCreateRequest>(req);
    try{if(body?.attachments){
     if(!Array.isArray(body.attachments)||body.attachments.length>5)throw Object.assign(new Error('attachment_share_limit'),{statusCode:413});
     body.attachments=body.attachments.map((input:any)=>{const file=attachmentContent(input?.serverId||input?.id||'');fs.closeSync(file.fd);return {id:input.serverId||input.id,serverId:input.serverId||input.id,mimeType:file.mime,type:file.mime.startsWith('image/')?'image':'file',sizeBytes:file.size,path:file.file,serverPath:file.file,displayName:sanitizeFilePart(String(input.displayName||''))||path.basename(file.file)};});
     if(body.attachments.reduce((sum:number,x:any)=>sum+x.sizeBytes,0)>25*1024*1024)throw Object.assign(new Error('attachment_share_limit'),{statusCode:413});
    }
    }catch(e:any){const status=[400,404,413].includes(e?.statusCode)?e.statusCode:503;writeJson(res,status,{success:false,error:status===404?"attachment_not_found":status===413?"attachment_share_limit":"invalid_attachment_request"});return;}
    const instruction = String(body?.instruction || body?.text || "");
    const displayText = String(body?.displayText || body?.userText || body?.text || instruction);
    const result = await submitIntent(
      instruction,
      String(body?.sessionId || "default"),
      body?.attachments || [],
      {
        userText: displayText,
        clientRunId: body?.clientRunId,
        authority:isLoopback&&!req.headers.origin&&!req.headers.referer&&!req.headers["sec-fetch-site"]?"owner":undefined,
      },
    );
    const statusCode = runSubmissionStatusCode(result);
    writeJson(res, statusCode, result);
    return;
  }

  if (method === "POST" && (routePath === "/attachments"||routePath === "/attachments/share")) {
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]||req.headers["x-clawmobile-owner-flow"]!=="v1"){writeJson(res,403,{success:false,state:"refused",receipt:null,error:"owner_required"});return;}
    try{const result = await saveAttachment(req);writeJson(res,result.success?200:result.state==='indeterminate'?503:400,result);}catch(error:any){const status=error.statusCode===413?413:400;writeJson(res,status,{success:false,state:'refused',receipt:null,reason:status===413?'attachment_too_large':'invalid_attachment_request'});}
    return;
  }

  if (method === "GET" && routePath.startsWith("/attachments/") && routePath.endsWith("/content")) {
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{success:false,error:"native_owner_flow_required"});return;}
    try{const attachmentId = decodeURIComponent(routePath.slice("/attachments/".length, -"/content".length));
    await serveAttachmentContent(res, attachmentId);}catch(e:any){const status=e?.statusCode===404?404:e?.statusCode===503?503:400;writeJson(res,status,{success:false,error:status===404?"attachment_not_found":"attachment_unavailable"});}
    return;
  }

  if (method === "POST" && routePath === "/runtime/start") {
    writeJson(res, 200, await startRuntime());
    return;
  }

  if (method === "POST" && routePath === "/runtime/stop") {
    const result = await stopRuntime();
    writeJson(res, result.success ? 200 : 500, result);
    return;
  }

  if (method === "POST" && routePath === "/runtime/restart") {
    const result = await restartRuntime();
    writeJson(res, result.success ? 200 : 500, result);
    return;
  }

  if (method === "GET" && routePath === "/runtime/log") {
    const maxBytes = parsePort(requestUrl.searchParams.get("maxBytes") || undefined, 64 * 1024);
    writeJson(res, 200, getRuntimeLog(maxBytes));
    return;
  }

  if (method === "POST" && routePath === "/terminal/command") {
    const body = await readJsonBody<TerminalCommandRequest>(req);
    const result = await runTerminalCommand(String(body?.command || ""));
    writeJson(res, result.command ? 200 : 400, result);
    return;
  }

  if (method === "GET" && routePath === "/terminal/session") {
    writeJson(res, 200, terminalSessionSnapshot("Shell ready."));
    return;
  }

  if (method === "POST" && routePath === "/terminal/session/input") {
    const body = await readJsonBody<TerminalSessionRequest>(req);
    const result = sendTerminalSessionInput(String(body?.text || ""));
    writeJson(res, result.success ? 200 : 400, result);
    return;
  }

  if (method === "POST" && routePath === "/terminal/session/reset") {
    stopTerminalShellSession();
    const session = startTerminalShellSession();
    appendTerminalShellText(session, "Shell restarted.\n");
    writeJson(res, 200, terminalSessionSnapshot("Shell restarted."));
    return;
  }

  if (method === "GET" && routePath === "/voice-recovery/status") {
    writeJson(res, 200, getVoiceRecoveryStatus());
    return;
  }

  if (method === "GET" && routePath === "/voice-recovery/probe") {
    writeJson(res, 200, await probeChatGptVoiceActive());
    return;
  }

  if (method === "POST" && routePath === "/voice-recovery/pending") {
    writeJson(res, 200, consumeRecoveryPending());
    return;
  }

  if (method === "POST" && routePath === "/voice-recovery/suspend") {
    const body: Record<string, any> = await readJsonBody<Record<string, any>>(req).catch(() => ({}));
    writeJson(res, 200, suspendVoiceRecovery(String(body.reason || "manual")));
    return;
  }

  if (method === "POST" && routePath === "/voice-recovery/resume") {
    writeJson(res, 200, resumeVoiceRecovery());
    return;
  }

  if (method === "POST" && routePath === "/voice-recovery/intentional-stop") {
    const body: Record<string, any> = await readJsonBody<Record<string, any>>(req).catch(() => ({}));
    const ttlMs = Number.isFinite(Number(body.ttlMs)) ? Number(body.ttlMs) : undefined;
    writeJson(res, 200, markVoiceIntentionalStop(ttlMs));
    return;
  }

  if(routePath==="/skills/learn"||routePath==="/skills/candidates"||routePath.startsWith("/skills/candidates/")){
    res.setHeader("Cache-Control","no-store");
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]||(routePath==="/skills/learn"&&req.headers["x-clawmobile-owner-flow"]!=="v1")){writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_owner_required"});return;}
    const expected=routePath==="/skills/learn"?"POST":"GET";
    if(method!==expected){res.setHeader("Allow",expected);writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
    try{
      let result:any;
      if(routePath==="/skills/learn"){
        if(requestUrl.search)throw Object.assign(new Error(),{statusCode:400});
        let body:any;try{body=await readJsonBody(req);}catch{throw Object.assign(new Error("invalid_learning_request"),{statusCode:400});}
        result=await learnSkill(body,undefined,{authority:"owner"});
      }else if(routePath==="/skills/candidates"){
        const keys=[...requestUrl.searchParams.keys()];if(keys.some(key=>key!=="limit")||keys.length>1)throw Object.assign(new Error(),{statusCode:400});
        const raw=requestUrl.searchParams.get("limit");if(raw!==null&&!/^[1-9][0-9]?$/.test(raw))throw Object.assign(new Error(),{statusCode:400});
        result=await learningCandidates(raw===null?20:Number(raw));
      }else{
        if(requestUrl.search||!/^\/skills\/candidates\/[^/]+$/.test(routePath))throw Object.assign(new Error(),{statusCode:400});
        let id:string;try{id=decodeURIComponent(routePath.split('/')[3]);}catch{throw Object.assign(new Error(),{statusCode:400});}
        result=await learningCandidate(id);
      }
      writeJson(res,result.state==="accepted"?202:result.state==="failed"?503:result.state==="refused"?403:200,result);
    }catch(error:any){const code=[400,403,404,409,422].includes(error?.statusCode)?error.statusCode:503;const safe=["invalid_learning_request","learn_payment_excluded","learning_guard_unavailable","learning_guard_budget_exceeded","confirmation_scope_mismatch","operation_conflict","invalid_trace_id","invalid_candidate_limit","candidate_not_found","candidate_invalid","candidate_scan_limit","candidate_unavailable","candidate_timestamp_unavailable"].includes(error?.message)?error.message:code===400?"invalid_learning_request":"learning_unavailable";writeJson(res,code,{success:false,state:code===404?"not_found":code===503?"unavailable":code===422?"invalid":"refused",receipt:null,error:safe,...(safe==="learn_payment_excluded"?{reason:safe}:{})});}
    return;
  }

  if (method === "GET" && routePath === "/skills") {
    writeJson(res, 200, {
      skills: listWorkspaceSkills(),
    });
    return;
  }

  if (method === "POST" && routePath === "/skills/route") {
    const body = await readJsonBody<Record<string, any>>(req);
    writeJson(res, 200, routeWorkspaceSkills(body || {}));
    return;
  }

  if (method === "GET" && routePath === "/nostr/status") {
    writeJson(res, 200, getNostrStatus());
    return;
  }

  if (method === "POST" && routePath === "/nostr/setup-key") {
    const body = await readJsonBody<Record<string, any>>(req);
    writeJson(res, 200, setupNostrIdentity({
      secretKey: body?.secretKey || body?.nsec,
      relays: Array.isArray(body?.relays) ? body.relays : undefined,
      revealSecret: body?.revealSecret === true,
    }));
    return;
  }

  if (method === "GET" && routePath === "/nostr/contacts") {
    writeJson(res, 200, listNostrContacts());
    return;
  }

  if (method === "POST" && routePath === "/nostr/contacts") {
    const body = await readJsonBody<Record<string, any>>(req);
    writeJson(res, 200, upsertNostrContact(body || {}));
    return;
  }

  const nostrContactMatch = routePath.match(/^\/nostr\/contacts\/([^/]+)$/);
  if (method === "DELETE" && nostrContactMatch) {
    const contactId = decodeURIComponent(nostrContactMatch[1]);
    const result = deleteNostrContact({ value: contactId });
    writeJson(res, result.ok ? 200 : 404, result);
    return;
  }

  if (method === "POST" && routePath === "/nostr/send") {
    const body = await readJsonBody<Record<string, any>>(req);
    const result = await sendNostrAgentMessage(body || {});
    writeJson(res, result.ok ? 200 : 502, result);
    return;
  }

  if (method === "GET" && routePath === "/nostr/inbox") {
    const limit = Number.parseInt(requestUrl.searchParams.get("limit") || "", 10);
    const since = Number.parseInt(requestUrl.searchParams.get("since") || "", 10);
    const relays = requestUrl.searchParams.getAll("relay").filter(Boolean);
    writeJson(res, 200, await fetchNostrInbox({
      limit: Number.isFinite(limit) ? limit : undefined,
      since: Number.isFinite(since) ? since : undefined,
      relays: relays.length ? relays : undefined,
      autoStoreSkillShares: requestUrl.searchParams.get("autoStoreSkillShares") !== "0",
    }));
    return;
  }

  if (method === "GET" && routePath === "/agent/conversations") {
    writeJson(res, 200, {
      ok: true,
      conversations: listAgentConversations(listNostrContacts().contacts),
    });
    return;
  }

  const agentMessagesMatch = routePath.match(/^\/agent\/conversations\/([^/]+)\/messages$/);
  if (method === "GET" && agentMessagesMatch) {
    const agentId = decodeURIComponent(agentMessagesMatch[1]);
    const limit = Number.parseInt(requestUrl.searchParams.get("limit") || "", 10);
    const before = requestUrl.searchParams.get("before") || undefined;
    writeJson(res, 200, {
      ok: true,
      agentId,
      messages: listAgentConversationMessages(agentId, {
        limit: Number.isFinite(limit) ? limit : undefined,
        before,
      }),
    });
    return;
  }

  if (method === "POST" && agentMessagesMatch) {
    const agentId = decodeURIComponent(agentMessagesMatch[1]);
    const body = await readJsonBody<Record<string, any>>(req);
    const result = await sendNostrAgentMessage({
      recipientPubkey: agentId,
      message: String(body?.message || body?.text || ""),
      payload: body?.payload,
      relays: Array.isArray(body?.relays) ? body.relays : undefined,
    });
    writeJson(res, result.ok ? 200 : 502, {
      ok: result.ok,
      success: result.ok,
      message: result.message,
      eventId: result.eventId,
      storedMessage: result.storedMessage,
      publish: result.publish,
    });
    return;
  }

  if (method === "DELETE" && agentMessagesMatch) {
    const agentId = decodeURIComponent(agentMessagesMatch[1]);
    const result = clearAgentConversationMessages(agentId);
    writeJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (method === "POST" && routePath === "/agent/inbox/fetch") {
    const body: Record<string, any> = await readJsonBody<Record<string, any>>(req).catch(() => ({}));
    const result = await fetchNostrInbox({
      limit: Number.isFinite(Number(body?.limit)) ? Number(body.limit) : 50,
      since: Number.isFinite(Number(body?.since)) ? Number(body.since) : undefined,
      relays: Array.isArray(body?.relays) ? body.relays : undefined,
      autoStoreSkillShares: body?.autoStoreSkillShares !== false,
    });
    writeJson(res, 200, {
      ok: result.ok,
      success: result.ok,
      message: result.message,
      newMessageCount: result.stored?.insertedCount || 0,
      updatedMessageCount: result.stored?.updatedCount || 0,
      newImportCount: result.messages.filter((message: any) => Boolean(message.pendingImportId)).length,
      updatedConversationIds: result.stored?.conversationIds || [],
    });
    return;
  }

  const markAgentMessageReadMatch = routePath.match(/^\/agent\/messages\/([^/]+)\/read$/);
  if (method === "POST" && markAgentMessageReadMatch) {
    const messageId = decodeURIComponent(markAgentMessageReadMatch[1]);
    const body: Record<string, any> = await readJsonBody<Record<string, any>>(req).catch(() => ({}));
    const result = markAgentMessageRead(messageId, { conversation: body?.conversation === true });
    writeJson(res, result.ok ? 200 : 404, result);
    return;
  }

  if (method === "GET" && routePath === "/skill-imports") {
    writeJson(res, 200, {
      imports: listPendingSkillImports(),
    });
    return;
  }

  if (method === "POST" && routePath === "/skill-imports") {
    const body = await readJsonBody<Record<string, any>>(req);
    const record = storePendingSkillImport(body?.package || body, body?.source || { transport: "manual" });
    writeJson(res, 200, {
      ok: true,
      import: record,
      message: "Skill share stored as a pending import.",
    });
    return;
  }

  const acceptSkillImportMatch = routePath.match(/^\/skill-imports\/([^/]+)\/accept$/);
  if (method === "POST" && acceptSkillImportMatch) {
    const importId = decodeURIComponent(acceptSkillImportMatch[1]);
    const result = acceptSkillImport(importId);
    writeJson(res, result ? 200 : 404, result || {
      ok: false,
      message: `Skill import not found: ${importId}`,
    });
    return;
  }

  const rejectSkillImportMatch = routePath.match(/^\/skill-imports\/([^/]+)\/reject$/);
  if (method === "POST" && rejectSkillImportMatch) {
    const importId = decodeURIComponent(rejectSkillImportMatch[1]);
    const result = rejectSkillImport(importId);
    writeJson(res, result ? 200 : 404, result || {
      ok: false,
      message: `Skill import not found: ${importId}`,
    });
    return;
  }

  const skillStateMatch=/^\/skills\/([^/]+)\/(enable|disable|try)$/.exec(routePath);
  if(skillStateMatch){
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]||req.headers["x-clawmobile-owner-flow"]!=="v1"){
      writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_owner_flow_required"});return;
    }
    if(method!=="POST"){writeJson(res,405,{success:false,state:"refused",receipt:null,error:"method_not_allowed"});return;}
    try{let id:string;try{id=decodeURIComponent(skillStateMatch[1]);}catch{throw Object.assign(new Error(),{statusCode:400});}
      res.setHeader("Cache-Control","no-store");writeJson(res,200,await changeSkill(id,skillStateMatch[2],await readJsonBody(req,4096),{authority:"owner"}));
    }catch(error:any){const status=[400,404,409].includes(error?.statusCode)?error.statusCode:503;writeJson(res,status,{success:false,state:"refused",receipt:null,error:status===503?"skill_owner_unavailable":"invalid_or_protected_skill"});}
    return;
  }
  const skillDetailMatch = routePath.match(/^\/skills\/([^/]+)$/);
  if (method === "GET" && skillDetailMatch) {
    if(!isLoopback||req.headers.origin||req.headers.referer||req.headers["sec-fetch-site"]){writeJson(res,403,{success:false,state:"refused",receipt:null,error:"native_owner_flow_required"});return;}
    let skillId:string;try{skillId=decodeURIComponent(skillDetailMatch[1]);}catch{writeJson(res,400,{success:false,error:"invalid_skill_id"});return;}
    let skill:any;try{skill=await skillControlDetail(skillId);}catch(error:any){writeJson(res,error?.statusCode===400?400:404,{success:false,error:"skill_not_found"});return;}
    writeJson(res, skill ? 200 : 404, skill || {
      success: false,
      message: `Workspace skill not found: ${skillId}`,
    });
    return;
  }

  const skillShareMatch = routePath.match(/^\/skills\/([^/]+)\/share$/);
  if (method === "POST" && skillShareMatch) {
    const skillId = decodeURIComponent(skillShareMatch[1]);
    const result = createSkillSharePackage(skillId);
    writeJson(res, result ? 200 : 404, result || {
      ok: false,
      message: `Workspace skill not found: ${skillId}`,
    });
    return;
  }

  const skillShareNostrMatch = routePath.match(/^\/skills\/([^/]+)\/share\/nostr$/);
  if (method === "POST" && skillShareNostrMatch) {
    const skillId = decodeURIComponent(skillShareNostrMatch[1]);
    const body = await readJsonBody<Record<string, any>>(req);
    const result = await shareSkillViaNostr(skillId, body || {});
    writeJson(res, result ? (result.ok ? 200 : 502) : 404, result || {
      ok: false,
      message: `Workspace skill not found: ${skillId}`,
    });
    return;
  }

  const skillPreviewMatch = routePath.match(/^\/skills\/([^/]+)\/preview$/);
  if (method === "POST" && skillPreviewMatch) {
    const skillId = decodeURIComponent(skillPreviewMatch[1]);
    const body = await readJsonBody<Record<string, any>>(req);
    const result = previewWorkspaceSkill(skillId, body || {});
    writeJson(res, result ? 200 : 404, result || {
      success: false,
      message: `Workspace skill not found: ${skillId}`,
    });
    return;
  }

  const skillRunMatch = routePath.match(/^\/skills\/([^/]+)\/run$/);
  if (method === "POST" && skillRunMatch) {
    const skillId = decodeURIComponent(skillRunMatch[1]);
    const body = await readJsonBody<Record<string, any>>(req);
    const result = await runWorkspaceSkill(skillId, body || {}, {authority:isLoopback&&!req.headers.origin&&!req.headers.referer&&!req.headers["sec-fetch-site"]?"owner":undefined});
    writeJson(res, result ? 200 : 404, result || {
      success: false,
      message: `Workspace skill not found: ${skillId}`,
    });
    return;
  }

  const fastPathRunMatch = routePath.match(/^\/skills\/([^/]+)\/fast-paths\/([^/]+)\/run$/);
  if (method === "POST" && fastPathRunMatch) {
    const skillId = decodeURIComponent(fastPathRunMatch[1]);
    const fastPathId = decodeURIComponent(fastPathRunMatch[2]);
    const body = await readJsonBody<Record<string, any>>(req);
    const result = await runWorkspaceFastPath(skillId, fastPathId, body || {});
    writeJson(res, result ? 200 : 404, result || {
      success: false,
      message: `Workspace fast path not found: ${skillId}/${fastPathId}`,
    });
    return;
  }

  const skillRunsMatch = routePath.match(/^\/skills\/([^/]+)\/runs$/);
  if (method === "GET" && skillRunsMatch) {
    const skillId = decodeURIComponent(skillRunsMatch[1]);
    const runs = (await listRuns())
      .filter((run) => companionRunBelongsToSkill(run, skillId))
      .map((run) => toSkillRunSummary(run, skillId));
    writeJson(res, 200, { runs });
    return;
  }

  if (method === "GET" && routePath.startsWith("/skill-runs/")) {
    const runId = decodeURIComponent(routePath.slice("/skill-runs/".length));
    const result = await getRunStatus(runId);
    writeJson(res, result.success || result.state !== "unknown" ? 200 : 404, toSkillRunSummary(result));
    return;
  }

  if(method === "GET" && routePath === "/sessions/changes") {
    if(!isLoopback||req.headers.origin||req.headers["sec-fetch-site"]){writeJson(res,403,{error:"native_loopback_required"});return;}
    if(process.env.SAMANTHA_CONVERSATION_EVENTS === "0"){writeJson(res,404,{error:"unsupported_contract"});return;}
    const last=req.headers["last-event-id"];
    if(Array.isArray(last)||(last?.length||0)>120){writeJson(res,400,{error:"invalid_cursor"});return;}
    let subscription:ReturnType<typeof subscribeConversationChanges>|undefined;
    let heartbeat:ReturnType<typeof setInterval>|undefined;let closed=false;
    const close=()=>{if(closed)return;closed=true;subscription?.close();if(heartbeat)clearInterval(heartbeat);if(!res.writableEnded)res.end();};
    const send=(event:any)=>{if(closed)return;if(!res.write("id: "+event.id+"\nevent: invalidated\ndata: "+JSON.stringify(event)+"\n\n"))close();};
    try{subscription=subscribeConversationChanges(send,last as string|undefined);}
    catch{writeJson(res,429,{error:"conversation_stream_busy"});return;}
    res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store","Connection":"keep-alive"});res.flushHeaders();
    res.write("event: ready\ndata: "+JSON.stringify({...subscription.current,resyncRequired:subscription.resyncRequired})+"\n\n");
    for(const event of subscription.replay)send(event);
    if(!closed){heartbeat=setInterval(()=>{if(!res.write(": keep-alive\n\n"))close();},10000);heartbeat.unref();}
    res.once("close",close);req.once("aborted",close);if(res.destroyed||req.aborted)close();return;
  }
  const pagedTurns=routePath.match(/^\/sessions\/([^/]+)\/turns$/);
  if(method === "GET" && requestUrl.searchParams.get("contract") === "2" && (routePath === "/runs" || pagedTurns)) {
    if(!isLoopback||req.headers.origin||req.headers["sec-fetch-site"]){writeJson(res,403,{error:"native_loopback_required"});return;}
    if(process.env.SAMANTHA_HISTORY_V2 === "0"){writeJson(res,404,{error:"unsupported_contract"});return;}
    try{
      for(const [key] of requestUrl.searchParams)if(!["contract","view","limit","cursor","q"].includes(key))throw Object.assign(Error(),{statusCode:400});
      const rawLimit=requestUrl.searchParams.get("limit")||"20";
      if(!/^[0-9]{1,2}$/.test(rawLimit))throw Object.assign(Error(),{statusCode:400});
      const options={limit:Number(rawLimit),cursor:requestUrl.searchParams.get("cursor")||undefined,query:requestUrl.searchParams.get("q")||undefined};
      if(routePath === "/runs" && requestUrl.searchParams.get("view")!=="conversations")throw Object.assign(Error(),{statusCode:400});
      const value=pagedTurns?await conversationTurnsPage(decodeURIComponent(pagedTurns[1]),options):await conversationSummariesPage(options);
      res.setHeader("Cache-Control","no-store");writeJson(res,200,value);
    }catch(e:any){const code=e?.statusCode===400?400:e?.statusCode===409?409:503;
      res.setHeader("Cache-Control","no-store");writeJson(res,code,{error:code===409?"pagination_invalidated":code===400?"invalid_pagination":"history_unavailable"});}
    return;
  }

  if (method === "GET" && routePath === "/runs") {
    const rawLimit = Number.parseInt(requestUrl.searchParams.get("limit") || "", 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
    const summary = ["1", "true", "yes"].includes((requestUrl.searchParams.get("summary") || "").toLowerCase());
    res.setHeader("Cache-Control", "no-store");
    writeJson(res, 200, {
      runs: summary ? await listRunSummaries({ limit }) : await listRuns({ limit }),
    });
    return;
  }

  const byClientRunMatch = routePath.match(/^\/runs\/by-client\/([^/]+)$/);
  const deleteRunMatch = routePath.match(/^\/runs\/([^/]+)$/);
  if (method === "DELETE" && deleteRunMatch) {
    if (req.headers.origin || req.headers.referer || req.headers["sec-fetch-site"]) {
      writeJson(res, 403, {success:false, state:"denied", receipt:null, error:"native_owner_required"}); return;
    }
    try {
      const body = await readJsonBody<any>(req, 2048);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.operationId !== "string")
        throw new HttpError(400, "invalid_run_deletion");
      let runId: string;
      try { runId = decodeURIComponent(deleteRunMatch[1]); }
      catch { throw new HttpError(400, "invalid_run_deletion"); }
      const result = await deleteRun(runId, body.operationId);
      res.setHeader("Cache-Control", "no-store"); writeJson(res, result.success ? 200 : 404, result);
    } catch (error: any) {
      const code = [400, 409].includes(error?.statusCode) ? error.statusCode : 503;
      writeJson(res, code, {success:false, state:"failed", receipt:null,
        error:code === 503 ? "run_deletion_unavailable" : error.message});
    }
    return;
  }
  if (method === "GET" && byClientRunMatch) {
    const clientRunId = decodeURIComponent(byClientRunMatch[1]);
    const result = await getRunStatusByClientRunId(clientRunId);
    res.setHeader("Cache-Control", "no-store");
    writeJson(res, result.success || result.state !== "unknown" ? 200 : 404, result);
    return;
  }

  if (method === "GET" && routePath.startsWith("/runs/")) {
    const runId = decodeURIComponent(routePath.slice("/runs/".length));
    const result = await getRunStatus(runId);
    writeJson(res, result.success || result.state !== "unknown" ? 200 : 404, result);
    return;
  }

  const conversationTurns = routePath.match(/^\/sessions\/([^/]+)\/(turns|voice-turns)$/);
  if (conversationTurns && method === "GET" && conversationTurns[2] === "turns") {
    const sessionId = decodeURIComponent(conversationTurns[1]);
    res.setHeader("Cache-Control", "no-store");
    writeJson(res, 200, {sessionId, turns: await getConversationTurns(sessionId)});
    return;
  }
  if (conversationTurns && method === "POST" && conversationTurns[2] === "voice-turns") {
    const body = await readJsonBody<any>(req, 256 * 1024);
    writeJson(res, 200, await saveVoiceTurn(decodeURIComponent(conversationTurns[1]), body));
    return;
  }

  const archiveSessionMatch = routePath.match(/^\/sessions\/([^/]+)\/archive$/);
  if (method === "POST" && archiveSessionMatch) {
    const sessionId = decodeURIComponent(archiveSessionMatch[1]);
    const result = await archiveSession(sessionId);
    writeJson(res, result.success ? 200 : 400, result);
    return;
  }

  const deleteSessionMatch = routePath.match(/^\/sessions\/([^/]+)$/);
  if (method === "DELETE" && deleteSessionMatch) {
    const sessionId = decodeURIComponent(deleteSessionMatch[1]);
    const result = await deleteSession(sessionId);
    writeJson(res, result.success ? 200 : 400, result);
    return;
  }

  writeJson(res, 404, {
    success: false,
    message: `No route for ${method} ${requestUrl.pathname}.`,
  });
}

function normalizeProtocolPath(pathname: string): string | null {
  if (pathname === "/" || pathname === "/v1") return "/";
  if (!pathname.startsWith("/v1/")) return null;

  const path = pathname.slice("/v1".length);
  const extensionMappings: Array<[string, string]> = [
    ["/extensions/android", ""],
    ["/extensions/nostr", "/nostr"],
    ["/extensions/agent", "/agent"],
    ["/extensions/remote-bridge", "/remote-bridge"],
    ["/extensions/capability-bridge", "/capability-bridge"],
    ["/extensions/voice-relay", "/voice-relay"],
    ["/extensions/claw-live", "/claw-live"],
    ["/extensions/samantha-control", "/control"],
    ["/extensions/skill-sharing/imports", "/skill-imports"],
    ["/extensions/skill-sharing/skills", "/skills"],
  ];

  for (const [prefix, replacement] of extensionMappings) {
    if (path === prefix) return replacement || "/";
    if (path.startsWith(`${prefix}/`)) {
      return `${replacement}${path.slice(prefix.length)}` || "/";
    }
  }

  return path;
}

async function health(options: { trusted?: boolean } = { trusted: true }): Promise<CompanionHealth> {
  if (options.trusted === false) {
    return bootstrapHealth();
  }

  const [runtime, gateway] = await Promise.all([
    android_health().catch((error: any) => ({
      ok: false,
      error: error?.message || "android_health failed",
    })),
    getGatewayStatus(),
  ]);

  const runtimeOk = runtime?.ok !== false;
  const runtimeDetails: any = runtime;
  const runtimeStage = typeof runtimeDetails?.stage === "string" ? runtimeDetails.stage : undefined;
  const runtimeError = runtimeDetails?.error ? String(runtimeDetails.error) : undefined;
  const model = modelKeyHealth();
  return {
    status: runtimeOk ? "connected" : "disconnected",
    message: runtimeOk ? "ClawMobile companion server is running." : "Companion server is running with degraded runtime health.",
    version: VERSION,
    stage: runtimeStage,
    checks: [
      {
        id: "companion",
        label: "Companion",
        state: "online",
        detail: "Companion HTTP server is reachable.",
      },
      {
        id: "runtime",
        label: "Runtime",
        state: runtimeOk ? "online" : "offline",
        detail: runtimeOk ? String(runtimeStage || "Runtime capability check passed.") : String(runtimeError || "Runtime capability check failed."),
      },
      {
        id: "gateway",
        label: "OpenClaw",
        state: gateway.reachable ? "online" : "offline",
        detail: gateway.message,
      },
      {
        id: "model",
        label: "Model",
        state: model.configured ? "online" : "offline",
        detail: model.message,
      },
    ],
    gateway,
    runtime,
    model,
  };
}

function bootstrapHealth(): CompanionHealth {
  return {
    status: "unknown",
    message: "ClawMobile companion server is reachable. Pairing or loopback access is required for runtime health.",
    version: VERSION,
    checks: [
      {
        id: "companion",
        label: "Companion",
        state: "online",
        detail: "Companion HTTP server is reachable.",
      },
    ],
    gateway: {
      host: "",
      port: 0,
      reachable: false,
      message: "Runtime gateway status requires pairing or loopback access.",
    },
    runtime: {},
  };
}

async function capabilities(options: { trusted?: boolean } = {}) {
  if (!options.trusted) {
    return bootstrapCapabilities();
  }

  const currentHealth = await health();
  const runtime = currentHealth.runtime || {};
  const rawCapabilities = runtime.capabilities || {};
  const modelConfigured = currentHealth.model?.configured === true;
  const adbReady = rawCapabilities.ui_input === true || rawCapabilities.adb === true;
  const ocrReady = rawCapabilities.ocr === true || rawCapabilities.screen_ocr === true;

  return {
    platform: "android",
    runtime: "termux-openclaw",
    version: VERSION,
    health: currentHealth,
    features: {
      tasks: "available",
      sessions: "available",
      skills: "available",
      attachments: "available",
      artifacts: "planned",
      approvals: "planned",
      nativePaymentConfirmation: "experimental",
      nativeOwnerConfirmation: "experimental",
      events: "unavailable",
      runtimeLifecycle: "available",
      runtimeLog: "available",
      notifications: "frontend",
      adb: adbReady ? "available" : "setup_required",
      ocr: ocrReady ? "available" : "setup_required",
      terminal: "local_only",
      social: "available",
      appIntents: "unavailable",
      model: modelConfigured ? "available" : "setup_required",
    },
    tools: [
      {
        id: "android_health",
        label: "Android Health",
        description: "Read Android runtime health and setup status.",
        status: "available",
        risk: "low",
        requiresApproval: false,
        extension: "android",
        permissions: [],
      },
    ],
    extensions: [
      {
        namespace: "android",
        basePath: "/v1/extensions/android",
        status: "available",
        routes: [
          { id: "terminal.command", method: "POST", path: "terminal/command", status: "local_only", risk: "high", requiresApproval: false, availabilityReason: "Loopback-only companion UI route; not an agent-callable tool." },
          { id: "terminal.session", method: "GET", path: "terminal/session", status: "local_only", risk: "medium", requiresApproval: false },
          { id: "voice-recovery.status", method: "GET", path: "voice-recovery/status", status: "local_only", risk: "low", requiresApproval: false },
          { id: "voice-recovery.pending", method: "POST", path: "voice-recovery/pending", status: "local_only", risk: "low", requiresApproval: false },
          { id: "voice-recovery.suspend", method: "POST", path: "voice-recovery/suspend", status: "local_only", risk: "medium", requiresApproval: false },
          { id: "voice-recovery.resume", method: "POST", path: "voice-recovery/resume", status: "local_only", risk: "medium", requiresApproval: false },
          { id: "voice-recovery.probe", method: "GET", path: "voice-recovery/probe", status: "local_only", risk: "low", requiresApproval: false },
          { id: "voice-recovery.intentional-stop", method: "POST", path: "voice-recovery/intentional-stop", status: "local_only", risk: "medium", requiresApproval: false },
        ],
      },
      {
        namespace: "nostr",
        basePath: "/v1/extensions/nostr",
        status: "available",
        routes: [
          { id: "nostr.status", method: "GET", path: "status", status: "available", risk: "low", requiresApproval: false },
          { id: "nostr.contacts", method: "GET", path: "contacts", status: "available", risk: "low", requiresApproval: false },
          { id: "nostr.send", method: "POST", path: "send", status: "available", risk: "medium", requiresApproval: false },
        ],
      },
      {
        namespace: "agent",
        basePath: "/v1/extensions/agent",
        status: "available",
        routes: [
          { id: "agent.conversations", method: "GET", path: "conversations", status: "available", risk: "low", requiresApproval: false },
        ],
      },
      {
        namespace: "skill-sharing",
        basePath: "/v1/extensions/skill-sharing",
        status: "available",
        routes: [
          { id: "skill-sharing.imports", method: "GET", path: "imports", status: "available", risk: "low", requiresApproval: false },
          { id: "skill-sharing.share", method: "POST", path: "skills/:skillId/share", status: "available", risk: "medium", requiresApproval: false },
        ],
      },
    ],
  };
}

function bootstrapCapabilities() {
  return {
    platform: "android",
    runtime: "termux-openclaw",
    version: VERSION,
    protocol: "v1",
    access: {
      status: "auth_required",
      message: "Pairing or loopback access is required for runtime capabilities.",
    },
    features: {},
    tools: [],
    extensions: [],
  };
}

async function saveAttachment(req: http.IncomingMessage):Promise<any>{
 let inputs:{id?:string;mimeType:string;body:Buffer;displayName?:string}[];
 if((req.url||'').split('?')[0].endsWith('/attachments/share')){
  let value:any;try{value=JSON.parse((await readRawBody(req,35*1024*1024,true)).toString('utf8'));}catch{throw Object.assign(new Error('invalid_attachment_share'),{statusCode:400});}
  if(!value||Object.keys(value).length!==1||!Array.isArray(value.files)||value.files.length>5)throw Object.assign(new Error('attachment_share_limit'),{statusCode:413});
  inputs=value.files.map((x:any)=>{if(!x||Object.keys(x).some(k=>!['id','mimeType','base64'].includes(k))||typeof x.base64!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x.base64))throw Object.assign(new Error('invalid_attachment_share'),{statusCode:400});return {id:x.id,mimeType:x.mimeType,body:Buffer.from(x.base64,'base64')};});
 }else inputs=[{id:String(req.headers['x-clawmobile-attachment-id']||'')||undefined,displayName:sanitizeFilePart(String(req.headers['x-clawmobile-filename']||''))||undefined,mimeType:String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase(),body:await readRawBody(req,MAX_ATTACHMENT_BYTES,true)}];
 if(inputs.some(x=>typeof x.id!=='string'||!x.id))throw Object.assign(new Error('attachment_id_required'),{statusCode:400});
 try{
  const files=await withAttachmentReferences(paths=>saveAttachments(inputs,paths));
  return {success:true,state:'completed',receipt:{version:1,action:'attachments.upload',id:attachmentDigest(inputs),state:'completed'},
   ...(files.length===1?files[0]:{}),attachments:files};
 }catch(error:any){
  if([400,409,413].includes(error.statusCode))return {success:false,state:'refused',receipt:null,reason:error.message};
  throw error;
 }

}
async function serveAttachmentContent(res:http.ServerResponse,id:string){
 const item=attachmentContent(id);res.statusCode=200;res.setHeader('Content-Type',item.mime);res.setHeader('X-Content-Type-Options','nosniff');
 if(!item.mime.startsWith('image/'))res.setHeader('Content-Disposition','attachment');
 fs.createReadStream(item.file,{fd:item.fd,autoClose:true}).on('error',()=>res.destroy()).pipe(res);
}

function attachmentDir() {
  const configured = (process.env.CLAWMOBILE_ATTACHMENT_DIR || "").trim();
  return configured || path.join(os.homedir(), ".clawmobile", "companion-attachments");
}

function mimeForExtension(extension: string) {
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function sanitizeFilePart(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
}

function extensionForMime(mimeType: string) {
  switch (mimeType) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
      return "png";
    default:
      return "img";
  }
}

function runTerminalCommand(command: string): Promise<TerminalCommandResponse> {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return Promise.resolve({
      success: false,
      command: "",
      cwd: terminalCommandCwd(),
      output: "",
      message: "Command is empty.",
    });
  }

  if (trimmedCommand.length > MAX_TERMINAL_COMMAND_CHARS) {
    return Promise.resolve({
      success: false,
      command: trimmedCommand.slice(0, MAX_TERMINAL_COMMAND_CHARS),
      cwd: terminalCommandCwd(),
      output: "",
      message: `Command is too long. Limit is ${MAX_TERMINAL_COMMAND_CHARS} characters.`,
    });
  }

  const cwd = terminalCommandCwd();
  const shell = process.env.SHELL || "bash";
  const startedAt = Date.now();

  return new Promise((resolve) => {
    execFile(
      shell,
      ["-lc", trimmedCommand],
      {
        cwd,
        env: process.env,
        timeout: TERMINAL_COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_TERMINAL_OUTPUT_BYTES,
      },
      (error: any, stdout = "", stderr = "") => {
        const output = [stdout, stderr]
          .filter((text) => text && text.length > 0)
          .join(stdout && stderr ? "\n" : "")
          .trimEnd();
        const exitCode = typeof error?.code === "number" ? error.code : 0;
        const timedOut = Boolean(error?.killed) || error?.signal === "SIGTERM";
        const success = !error;
        const message = timedOut
          ? `Command timed out after ${TERMINAL_COMMAND_TIMEOUT_MS / 1000}s.`
          : success
            ? "Command completed."
            : `Command exited with ${exitCode}.`;

        resolve({
          success,
          command: trimmedCommand,
          cwd,
          output,
          exitCode,
          durationMs: Date.now() - startedAt,
          message,
        });
      },
    );
  });
}

function terminalCommandCwd() {
  const configured = (process.env.CLAWMOBILE_TERMINAL_CWD || "").trim();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

let terminalShellSession: TerminalShellSession | null = null;

function startTerminalShellSession(): TerminalShellSession {
  if (terminalShellSession?.running) return terminalShellSession;

  const cwd = terminalCommandCwd();
  const shell = process.env.SHELL || "bash";
  const child = spawn(shell, ["--noprofile", "--norc"], {
    cwd,
    env: {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
    },
    stdio: "pipe",
  });
  child.stdin.setDefaultEncoding("utf8");

  const session: TerminalShellSession = {
    child,
    output: "",
    cwd,
    running: true,
    updatedAt: Date.now(),
  };
  terminalShellSession = session;
  appendTerminalShellText(session, `ClawMobile shell started in ${cwd}\n`);

  child.stdout.on("data", (chunk) => appendTerminalShellChunk(session, chunk));
  child.stderr.on("data", (chunk) => appendTerminalShellChunk(session, chunk));
  child.once("close", (code, signal) => {
    session.running = false;
    appendTerminalShellText(
      session,
      `\n[shell exited${typeof code === "number" ? ` ${code}` : ""}${signal ? `, ${signal}` : ""}]\n`,
    );
  });
  child.once("error", (error) => {
    session.running = false;
    appendTerminalShellText(session, `\n[shell error] ${error.message}\n`);
  });

  writeTerminalShellInput(session, `printf '${CWD_SENTINEL_PREFIX}%s${CWD_SENTINEL_SUFFIX}\\n' "$PWD"\n`);
  return session;
}

function stopTerminalShellSession() {
  const session = terminalShellSession;
  if (!session) return;
  terminalShellSession = null;
  try {
    session.child.stdin.end("exit\n");
  } catch {
    // ignore shutdown races
  }
  setTimeout(() => {
    if (session.running) {
      try {
        session.child.kill("SIGTERM");
      } catch {
        // ignore shutdown races
      }
    }
  }, 500).unref();
}

function sendTerminalSessionInput(text: string): TerminalSessionResponse {
  const session = startTerminalShellSession();
  if (!session.running || session.child.stdin.destroyed) {
    return terminalSessionSnapshot("Shell is not running.", false);
  }

  const input = text.replace(/\r/g, "").trimEnd();
  if (!input) {
    writeTerminalShellInput(session, "\n");
    return terminalSessionSnapshot("Input sent.");
  }
  if (input.length > MAX_TERMINAL_COMMAND_CHARS) {
    return terminalSessionSnapshot(`Input is too long. Limit is ${MAX_TERMINAL_COMMAND_CHARS} characters.`, false);
  }

  appendTerminalShellText(session, `$ ${input}\n`);
  writeTerminalShellInput(session, `${input}\nprintf '${CWD_SENTINEL_PREFIX}%s${CWD_SENTINEL_SUFFIX}\\n' "$PWD"\n`);
  return terminalSessionSnapshot("Input sent.");
}

function writeTerminalShellInput(session: TerminalShellSession, input: string) {
  session.child.stdin.write(input);
  session.updatedAt = Date.now();
}

function appendTerminalShellChunk(session: TerminalShellSession, chunk: Buffer | string) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  appendTerminalShellText(session, stripCwdSentinels(session, text.replace(/\r/g, "")));
}

function stripCwdSentinels(session: TerminalShellSession, text: string) {
  return text.replace(new RegExp(`${CWD_SENTINEL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\n]*)${CWD_SENTINEL_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g"), (_match, cwd) => {
    const nextCwd = String(cwd || "").trim();
    if (nextCwd) session.cwd = nextCwd;
    return "";
  });
}

function appendTerminalShellText(session: TerminalShellSession, text: string) {
  if (!text) return;
  session.output = (session.output + text).slice(-MAX_TERMINAL_SESSION_OUTPUT_CHARS);
  session.updatedAt = Date.now();
}

function terminalSessionSnapshot(message = "Shell ready.", success = true): TerminalSessionResponse {
  const session = startTerminalShellSession();
  return {
    success,
    message,
    output: session.output,
    cwd: session.cwd,
    running: session.running,
    pid: session.child.pid,
    updatedAt: session.updatedAt,
  };
}

function modelKeyHealth() {
  const envFileValues = readOpenClawEnvFile();
  const providers = [
    { id: "openai", label: "OpenAI", keys: ["OPENAI_API_KEY"] },
    { id: "anthropic", label: "Anthropic", keys: ["ANTHROPIC_API_KEY"] },
    { id: "deepseek", label: "DeepSeek", keys: ["DEEPSEEK_API_KEY"] },
  ];
  const configuredProvider = providers.find((provider) =>
    provider.keys.some((key) => Boolean(process.env[key] || envFileValues[key])),
  );

  if (!configuredProvider) {
    return {
      configured: false,
      message: "No model API key configured.",
    };
  }

  return {
    configured: true,
    provider: configuredProvider.id,
    message: `${configuredProvider.label} key configured.`,
  };
}

function readOpenClawEnvFile(): Record<string, string> {
  const envFile = process.env.OPENCLAW_ENV_FILE || path.join(os.homedir(), ".openclaw", ".env");
  try {
    const raw = fs.readFileSync(envFile, "utf8");
    return raw.split(/\r?\n/).reduce<Record<string, string>>((values, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return values;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) return values;

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[key] = value;
      return values;
    }, {});
  } catch {
    return {};
  }
}

function parsePort(value: string | undefined, fallback: number) {
  const port = Number.parseInt(value || "", 10);
  return Number.isFinite(port) && port > 0 ? port : fallback;
}

function listenHost(value: string): string | undefined {
  const host = value.trim() || DEFAULT_HOST;
  if (host === "localhost" || host === "loopback") {
    return "127.0.0.1";
  }
  return host;
}

function isTerminalRoute(pathname: string) {
  return pathname === "/terminal/command" ||
    pathname === "/terminal/session" ||
    pathname === "/terminal/session/input" ||
    pathname === "/terminal/session/reset";
}

function isLocalOnlyRoute(pathname: string, method = "GET") {
  if (method === "GET" && (pathname === "/" || pathname === "/health" || pathname === "/capabilities")) {
    return false;
  }
  return true;
}

function isLoopbackRequest(req: http.IncomingMessage) {
  const address = String(req.socket.remoteAddress || "").toLowerCase();
  return address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1";
}

function companionRunBelongsToSkill(run: CompanionRunStatus, skillId: string) {
  const expectedSessionId = `skill-${skillId}`;
  return run.sessionId === expectedSessionId ||
    run.runId.includes(`skill-run-${skillId}-`) ||
    String(run.prompt || "").includes(`workspace skill "${skillId}"`);
}

function toSkillRunSummary(run: CompanionRunStatus, fallbackSkillId?: string) {
  const skillId = fallbackSkillId || skillIdFromCompanionRun(run) || "unknown";
  const status = skillRunStatusFromCompanionRun(run);
  return {
    runId: run.runId,
    skillId,
    status,
    startedAt: run.startedAt || run.submittedAt,
    finishedAt: run.endedAt,
    currentStep: run.progress?.text,
    resultSummary: status === "completed" ? run.result || run.message : undefined,
    errorSummary: status === "failed" ? run.message : undefined,
  };
}

function skillIdFromCompanionRun(run: CompanionRunStatus) {
  const sessionMatch = String(run.sessionId || "").match(/^skill-(.+)$/);
  if (sessionMatch) return sessionMatch[1];
  const runIdMatch = run.runId.match(/^skill-run-(.+)-\d+$/);
  if (runIdMatch) return runIdMatch[1];
  const promptMatch = String(run.prompt || "").match(/workspace skill "([^"]+)"/);
  return promptMatch?.[1];
}

function skillRunStatusFromCompanionRun(run: CompanionRunStatus) {
  const raw = String(run.status || run.state || "").toLowerCase();
  if (["running", "queued", "pending", "processing"].includes(raw)) return "running";
  if (["done", "complete", "completed", "success"].includes(raw)) return "completed";
  if (["failed", "error"].includes(raw)) return "failed";
  if (["cancelled", "canceled", "aborted"].includes(raw)) return "cancelled";
  return "pending";
}

function writeHtml(res: http.ServerResponse, statusCode: number, body: string) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Permissions-Policy", "microphone=(self)");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss://generativelanguage.googleapis.com"
  );
  res.end(body);
}

// App-facing state routes: no account e-mail may leave, whatever the producer.
const accountGuardedResponses=new WeakSet<http.ServerResponse>();
const conditionalRequests=new WeakMap<http.ServerResponse,http.IncomingMessage>();
function writeJson(res: http.ServerResponse, statusCode: number, value: any) {
  if(accountGuardedResponses.has(res))value=redactAccountIdentifiers(value);
  const body = statusCode === 204 ? "" : JSON.stringify(value, null, 2);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const corsOrigin = (process.env.CLAWMOBILE_COMPANION_CORS_ORIGIN || "").trim();
  if (corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-clawmobile-client, x-clawmobile-request-id, x-clawmobile-attachment-id, x-clawmobile-filename, x-clawmobile-attachment-type, x-clawmobile-owner-flow, x-clawmobile-operation-id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  }
  const request=conditionalRequests.get(res);
  if(request&&conditionalRead(request,res,statusCode,value,body))return;
  res.end(body);
}

function isClawLiveBrowserRoute(pathname: string) {
  return pathname === "/claw-live" ||
    pathname === "/claw-live/token" ||
    pathname === "/claw-live/prewarm" ||
    pathname === "/claw-live/warm-status" ||
    pathname === "/claw-live/decision" ||
    pathname === "/claw-live/capability";
}

function shouldBlockBrowserRequest(req: http.IncomingMessage, pathname: string) {
  if (process.env.CLAWMOBILE_COMPANION_ALLOW_BROWSER_ORIGIN === "1") {
    return false;
  }
  if (isClawLiveBrowserRoute(pathname) && isLoopbackRequest(req)) {
    const origin = String(req.headers.origin || "").trim();
    if (!origin || refererStartsWithLocalCompanion(origin)) {
      return false;
    }
  }
  if (!isSensitiveCompanionRoute(pathname)) {
    return false;
  }

  const origin = String(req.headers.origin || "").trim();
  if (origin) {
    return !isAllowedCorsOrigin(origin);
  }

  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && fetchSite !== "none" && fetchSite !== "same-origin") {
    return true;
  }

  const referer = String(req.headers.referer || "").trim();
  return Boolean(referer && !refererStartsWithLocalCompanion(referer));
}

function isSensitiveCompanionRoute(pathname: string) {
  return pathname !== "/" && pathname !== "/health";
}

function isAllowedCorsOrigin(origin: string) {
  const configured = (process.env.CLAWMOBILE_COMPANION_CORS_ORIGIN || "").trim();
  return Boolean(configured && (configured === "*" || configured === origin));
}

function refererStartsWithLocalCompanion(referer: string) {
  try {
    const url = new URL(referer);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      port === String(parsePort(process.env.CLAWMOBILE_COMPANION_PORT, DEFAULT_PORT));
  } catch {
    return false;
  }
}

async function readJsonBody<T>(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<T> {
  const raw = (await readRawBody(req, maxBytes)).toString("utf8");
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const raw = await readRawBody(req, MAX_BODY_BYTES);
  return raw.toString("utf8");
}

async function readRawBody(req: http.IncomingMessage, maxBytes: number, closeOnLimit=false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      if(tooLarge)return;
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "Request body is too large."));
        tooLarge=true;chunks.length=0;if(closeOnLimit)req.destroy();else req.resume();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

if (require.main === module) {
  startCompanionServer();
}

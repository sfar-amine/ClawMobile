/** Domain tools derived by the canonical CapabilityGraph compile owner. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {runtimeFile} from "./runtimeRoot";
import {runCapabilityHelperProcess,capabilityBridge} from "./companion/capabilityBridge";
import {consumeTypedInvocation,holdTypedControlInvocation} from "./capabilityAgentGuard";
import {activeNativeWhatsAppGenerations} from "./companion/capabilityControl";
import {expectedCompanionSessionKey} from "./companion/openclawAgentClient";
import {createHash} from "node:crypto";

export type TypedToolContext = {
  senderIsOwner?: boolean; sessionKey?: string; sessionId?: string; agentId?: string;
  messageChannel?: string; assertInvocationCurrent?: () => void;
};
type Action = {action: string; description: string; params: any; examples: string[]; risk: string; confirmationRequired: boolean;
  canonicalStatus?: string; executionMode?: string; nativeOwner?: {owner:string;contract:string;reason:string};
  execution?: {kind: string; method: string; path: string; pathParams?: Record<string, any>; query?: string[]; budgetMs?: number; control?: string}};
export type DomainTool = {name: string; domain: string; description: string; actions: Action[]};
type Options = {home?: string; helperPath?: string; catalogue?: DomainTool[]};
const id = /^[a-z][a-z0-9_.-]{0,127}$/;

export function readTypedToolCatalogue(home = os.homedir()): DomainTool[] {
  try {
    const file = path.join(home, ".openclaw", "capability-views", "agent-tools.json");
    if (fs.statSync(file).size > 512 * 1024) return [];
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.version !== 1 || !/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(value.capabilityRevision) ||
        !Array.isArray(value.tools) || value.tools.length > 32) return [];
    if (value.tools.some((t: any) => !/^samantha_[a-z0-9_]{1,100}$/.test(t.name) || !id.test(t.domain) ||
        typeof t.description !== "string" || !Array.isArray(t.actions) || t.actions.length > 160 ||
        t.actions.some((a: any) => !id.test(a.action) || a.params?.type !== "object" ||
          a.params?.additionalProperties !== false || !["read", "write", "external_send"].includes(a.risk)))) return [];
    return value.tools;
  } catch { return []; }
}

function toolSchema(tool: DomainTool) {
  const publicSchema = (value: any): any => Array.isArray(value) ? value.map(publicSchema)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => !["entity_id", "entity_id_if_numeric"].includes(key)).map(([key, child]) => [key, publicSchema(child)])) : value;
  const shapes = [...new Set(tool.actions.map(a => JSON.stringify(publicSchema(a.params))))].map(encoded => JSON.parse(encoded));
  const confirmation = {type: "object", properties: {
    confirmationId: {type: "string", minLength: 1, maxLength: 160},
    payloadHash: {type: "string", pattern: "^[a-f0-9]{64}$"},
  }, required: ["confirmationId", "payloadHash"], additionalProperties: false};
  return {type: "object", properties: {
    action: {type: "string", enum: [...tool.actions.map(a => a.action), "confirm", "cancel"]},
    params: {anyOf: [...shapes, confirmation]},
    // Amine 28/10 (ADR-20261028-model-decides-relation): the model says how the call relates to an open question.
    relation: {type: "string", enum: ["answer", "new_request"]},
  }, required: ["action", "params"], additionalProperties: false};
}

export function createTypedCapabilityTools(context: TypedToolContext, options: Options = {}) {
  // Contacts do not even see these descriptors. Recheck identity and liveness
  // during execution; a factory snapshot is never permission for a later turn.
  if (context?.senderIsOwner !== true || context.agentId && context.agentId !== "main") return null;
  const tools: any[] = (options.catalogue || readTypedToolCatalogue(options.home)).map(tool => {
    const parameters = toolSchema(tool);
    const actions = tool.actions.map(a => `${a.action}: ${a.description}${a.canonicalStatus === "candidate" ? " (candidate non qualifiée ; ne pas annoncer disponible)" : ""}${a.nativeOwner ? " (propriétaire natif " + a.nativeOwner.owner + ", poursuivre son parcours existant)" : ""}${a.confirmationRequired ? " (récapitulatif puis confirmation)" : ""}`).join("\n");
    const examples = tool.actions.flatMap(a => a.examples || []).slice(0, 5).join(" ; ");
    const currentConversation = /^agent:main:companion-chat-([A-Za-z0-9-]{1,80})$/.exec(context.sessionKey || "")?.[1];
    const nativeWhatsApp=context.messageChannel==='whatsapp'&&/^agent:main:whatsapp:direct:\+?[1-9][0-9]{7,14}$/.test(context.sessionKey||'');
    return {name: tool.name,
      description: `${tool.description}. Choisis l'action et ses paramètres typés. Aucune résolution du texte.${tool.domain === "app" && (currentConversation||nativeWhatsApp) ? " Conversation courante : " + (nativeWhatsApp?'current':currentConversation) + ". Si tu comprends que l’utilisateur demande d’arrêter le travail de ton propre tour, cesse les nouveaux appels et termine naturellement ce tour avec le contexte déjà présent. L’outil interrupt ne cible jamais ton propre run. Pour une autre génération, consulte active_generations et choisis son runId exact ; interrompre la génération n’annule pas les actions déjà envoyées." : ""}\n${actions}\nExemples de demandes : ${examples}. Les écritures métier exigent un récapitulatif puis un nouveau tour utilisateur ; confirm transmet uniquement l'identifiant et le payloadHash reçus, jamais de nouveaux paramètres. Reproduis la réponse prête du reçu sans inventer de fait ; une question du reçu se pose telle quelle, sans format, exemple ni consigne de réponse ajoutés. Quand une question de cet outil attend une réponse, indique relation : answer si l'utilisateur y répond, new_request s'il fait une nouvelle demande, même avec les mêmes mots.`,
      schema: parameters, inputSchema: parameters, parameters,
      async execute(toolCallId: unknown, args: any) {
        try {
          const bound = consumeTypedInvocation(toolCallId, tool.name, args, context);
          if (!args || typeof args !== "object" || Array.isArray(args) ||
              Object.keys(args).some(k => !["action", "params", "relation"].includes(k)) || typeof args.action !== "string" ||
              (args.relation !== undefined && !["answer", "new_request"].includes(args.relation)) ||
              !args.params || typeof args.params !== "object" || Array.isArray(args.params)) throw Error("typed_input_invalid");
          const operation = ["confirm", "cancel"].includes(args.action) ? args.action : "call";
          const action = tool.actions.find(a => a.action === args.action);
          if(operation==='call'&&nativeWhatsApp&&action?.action==='samantha.app.conversation.active_generations'){
            if(Object.keys(args.params).length!==1||args.params.conversationId!=='current')throw Error('typed_target_not_current_conversation');
            const result=await activeNativeWhatsAppGenerations(bound.conversationKey,bound.userRunId,()=>context.assertInvocationCurrent!());
            return {content:[{type:'text',text:JSON.stringify({state:'COMPLETED',facts:result,answer:'Générations observées de cette conversation WhatsApp uniquement.'})}]};
          }
          if (operation === "call" && action?.nativeOwner && action.risk === "read") {
            const resolved:any = await capabilityBridge("typed owner handoff", {execute:true,readOnly:true,caller:"owner",surface:"external_mcp",
              requestId:bound.invocationId,typedSelection:{domain:tool.domain,action:args.action,params:args.params},
              helperPath:options.helperPath,timeoutSeconds:6});
            if (resolved?.decision?.type !== "EXECUTE" || resolved?.selected?.intent !== args.action ||
                resolved?.selected?.target !== tool.domain) throw Error("typed_owner_unavailable");
            if(resolved.execution?.state!=='native_handoff')return {content:[{type:'text',text:JSON.stringify({state:'unavailable',facts:null,
              reason:resolved.execution?.state||'typed_owner_unavailable',answer:resolved.execution?.message||"Cette lecture n’a pas encore de résultat vérifié."})}]};
            return {content:[{type:"text",text:JSON.stringify({state:"owner_handoff",facts:null,verified:false,
              owner:resolved.selected.execution_contract?.native_owner_handoff,parameters:args.params,
              answer:"Poursuis cette lecture avec le propriétaire navigateur existant et son contrat canonique. Aucun fait métier n’est encore vérifié. Conserve tout résultat partiel et les reçus ; ne promeus pas de rejeu HTTP direct."})}]};
          }
          if (operation === "call" && action?.action === "samantha.app.conversation.interrupt" && action.execution?.control === "generation_only") {
            if (Object.keys(args.params).length !== 2 || Object.keys(args.params).some(k => !["conversationId", "runId"].includes(k)) ||
                typeof args.params.conversationId !== "string" || args.params.runId === bound.userRunId ||
                (nativeWhatsApp?args.params.conversationId!=='current':expectedCompanionSessionKey(args.params.conversationId) !== bound.conversationKey)) throw Error("typed_target_not_current_conversation");
            // Same user's Stop intention + exact target keeps its operation id
            // even if a model produces another tool call after a timeout.
            const operationId = "typed-stop-" + createHash("sha256").update(JSON.stringify([bound.userRunId, args.params.conversationId, args.params.runId])).digest("hex");
            const body=JSON.stringify({operationId,runId:args.params.runId,sdk:{invocationId:bound.invocationId,
              sessionKey:bound.conversationKey,currentRunId:bound.userRunId}});
            const release=holdTypedControlInvocation(bound,args,context,body);
            let result:any;
            try{
              const port=Number(process.env.CLAWMOBILE_COMPANION_PORT||8765);
              if(!Number.isInteger(port)||port<1||port>65535)throw Error('typed_owner_unavailable');
              context.assertInvocationCurrent!();
              const response=await fetch('http://127.0.0.1:'+port+'/v1/conversations/'+encodeURIComponent(args.params.conversationId)+'/interrupt',
                {method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(8500)});
              const text=await response.text();if(text.length>131072)throw Error('typed_outcome_unverified');
              result=JSON.parse(text);if(!response.ok)throw Error('typed_outcome_unverified');
            }finally{release();}
            return {content: [{type: "text", text: JSON.stringify({state:result.state,receiptId:result.receipt?.runId,
              facts:result.artifact||{},answer:result.artifact?.message||"Le statut de l’arrêt reste incertain ; vérifie ce reçu avant tout nouvel essai.",receipt:result.receipt})}]};
          }
          const command = operation === "call"
            ? {operation, domain: tool.domain, action: args.action, params: args.params, ...(args.relation ? {relation: args.relation} : {})}
            : {operation, domain: tool.domain, confirmationId: args.params.confirmationId, payloadHash: args.params.payloadHash};
          const whatsapp = context.messageChannel === "whatsapp";
          const privateInput = JSON.stringify({command, host: {...bound,
            surface: whatsapp ? "whatsapp" : "app", graphSurface: whatsapp ? "whatsapp" : "claw_live"}});
          if (Buffer.byteLength(privateInput) > 32768) throw Error("typed_input_too_large");
          context.assertInvocationCurrent!();
          const raw = await runCapabilityHelperProcess([options.helperPath || runtimeFile("claw-capability.py", options.home),
            "typed-tool", "--host-input-stdin", "--timeout", "30"],
            {timeoutMs: 38000, maxBuffer: 128 * 1024, env: {...process.env}, privateInput});
          const result = JSON.parse(typeof raw === "string" ? raw : String(raw?.stdout || "{}"));
          return {content: [{type: "text", text: JSON.stringify(result)}]};
        } catch (error: any) {
          const reason = typeof error?.message === "string" && /^typed_[a-z_]+$/.test(error.message)
            ? error.message : "typed_outcome_unverified";
          return {content: [{type: "text", text: JSON.stringify({state: "unverified", reason,
            answer: "Je n'ai pas de résultat vérifié pour cette action. Vérifie son état avant tout nouvel essai."})}], isError: true};
        }
      },
    };
  });
  const schema = {type: "object", properties: {query: {type: "string", minLength: 1, maxLength: 200}},
    required: ["query"], additionalProperties: false};
  tools.push({name: "samantha_catalogue", description: "Rechercher les capacités du registre canonique et leurs signatures. Découverte uniquement : aucune action n'est choisie ni exécutée.",
    schema, parameters: schema, inputSchema: schema,
    async execute(callId: unknown, args: any) {
      try {
        consumeTypedInvocation(callId, "samantha_catalogue", args, context);
        if (!args || Object.keys(args).length !== 1 || typeof args.query !== "string" || !args.query.trim() || args.query.length > 200)
          throw Error("typed_input_invalid");
        const file = path.join(options.home || os.homedir(), ".openclaw", "capability-views", "agent-tools.json");
        if (fs.statSync(file).size > 512 * 1024) throw Error("typed_catalogue_unavailable");
        const catalogue = JSON.parse(fs.readFileSync(file, "utf8")).catalogue;
        if (!Array.isArray(catalogue) || catalogue.length > 512) throw Error("typed_catalogue_unavailable");
        const words = args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const hits = catalogue.map((row: any) => ({row, score: words.filter(word =>
          [row.id, row.name, row.description, ...(row.aliases || [])].join(" ").toLocaleLowerCase().includes(word)).length}))
          .filter((item: any) => item.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, 8).map((item: any) => item.row);
        return {content: [{type: "text", text: JSON.stringify({state: "discovery", capabilities: hits})}]};
      } catch {
        return {isError: true, content: [{type: "text", text: JSON.stringify({state: "unavailable", reason: "typed_catalogue_unavailable"})}]};
      }
    }});
  return tools;
}

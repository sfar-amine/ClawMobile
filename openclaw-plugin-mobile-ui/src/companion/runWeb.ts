import {isIP} from "node:net";

/** Closed, optional projection inside the existing run; never an execution instruction. */
export type RunWebResult = {
  version: 1;
  operation: "search" | "answer";
  responseLanguage?: "fr" | "en" | "ar" | "aeb";
  outcome: "complete" | "partial" | "insufficient_sources" | "failed" | "cancelled";
  provider: "parallel-free";
  providerAuth: "anonymous";
  model: null | "google/gemini-3.5-flash-lite";
  profile: null | "google:claw-gemini-free";
  sources: Array<{id: string; title: string; url: string; finalUrl?: string;
    searchRetrievedAt: string; fetchedAt?: string; publishedAt: string | null;
    excerpt: string; evidenceType: "search_excerpt" | "fetched_passage"}>;
  claims: Array<{id: string; text: string; sourceIds: string[]; support?: Array<{sourceId: string; quote: string}>}>;
  citations: Array<{claimId: string; sourceId: string}>;
  spokenText?: string;
  metrics: Partial<Record<"searchMs" | "fetchMs" | "synthesisMs" | "totalMs" | "firstUsefulTextMs" |
    "firstInformativeAudioMs" | "cacheAgeMs" | "logicalSearchCalls" | "httpRequests" | "fetchCount" | "transportPosts" | "providerAttempts" | "reportedCostUsd", number | null>> & {cacheHit?: boolean | null};
  error: null | {code: string; stage: string; message: string; retryAfterMs?: number | null; retryable?: boolean};
  degradations: string[];
};

const ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const CODE = /^[a-z][a-z0-9_]{0,79}$/;
const STAGES = new Set(["search", "fetch", "synthesis", "policy", "transport", "normalization"]);
const OUTCOMES = new Set(["complete", "partial", "insufficient_sources", "failed", "cancelled"]);
const METRICS = new Set(["searchMs", "fetchMs", "synthesisMs", "totalMs", "firstUsefulTextMs", "firstInformativeAudioMs", "cacheAgeMs", "logicalSearchCalls", "httpRequests", "fetchCount", "transportPosts", "providerAttempts", "reportedCostUsd"]);
const MAX_BYTES = 64 * 1024;
const SECRET = /\b(?:Bearer\s+[A-Za-z0-9._-]+|(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{8,})|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/i;
function object(v: any): v is Record<string, any> {return !!v && typeof v === "object" && !Array.isArray(v);}
function text(v: unknown, max: number, empty = false): v is string {
  return typeof v === "string" && v.length <= max && (empty || v.trim().length > 0) && !SECRET.test(v);
}
function date(v: unknown): v is string {
  return typeof v === "string" && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
}
function publicationDate(v: unknown): v is string {
  if(typeof v!=="string")return false;
  const day=v.slice(0,10),parsed=Date.parse(day+"T00:00:00Z");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==day)return false;
  return v===day||date(v);
}
function code(v: unknown): v is string {return typeof v === "string" && CODE.test(v);}

/** Presentation guard only. Native fetch owns DNS/connect/redirect SSRF checks. No DNS is performed here. */
export function publicWebUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || !v || v.length > 2048 || SECRET.test(v) || /[\s\\\u0000-\u001f\u007f]/.test(v)) return;
  try {
    const u = new URL(v);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.hash || u.port && !["80","443"].includes(u.port)) return;
    const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (!h || h.split(".").some(label=>label.startsWith("xn--")) || h === "localhost" || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/.test(h) || h === "metadata.google.internal") return;
    if (isIP(h) || !h.includes(".") || !/^[a-z0-9.-]+$/.test(h)) return;
    for (const [k] of u.searchParams) if (/^(?:access_?token|token|api_?key|key|auth|authorization|password|signature|sig|credential|secret)$/i.test(k)) return;
    return u.href;
  } catch {return;}
}

/** Reject the whole malformed contract rather than repairing unsupported claims or changing meaning. */
export function readRunWebResult(value: unknown): RunWebResult | undefined {
  if (!object(value)) return;
  let serialized: string;
  try {serialized = JSON.stringify(value);} catch {return;}
  if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES || value.version !== 1 ||
      !["search", "answer"].includes(value.operation) || !OUTCOMES.has(value.outcome) ||
      value.provider !== "parallel-free" || value.providerAuth !== "anonymous" ||
      value.responseLanguage !== undefined && !["fr","en","ar","aeb"].includes(value.responseLanguage) ||
      !(value.model === null && value.profile === null || value.model === "google/gemini-3.5-flash-lite" && value.profile === "google:claw-gemini-free") ||
      !Array.isArray(value.sources) || value.sources.length > 5 || !Array.isArray(value.claims) || value.claims.length > 12 ||
      !Array.isArray(value.citations) || value.citations.length > 60 || !object(value.metrics) ||
      !Array.isArray(value.degradations) || value.degradations.length > 16 || !value.degradations.every(code)) return;
  if (value.operation === "search" && (value.model !== null || value.claims.length || value.citations.length)) return;
  const sources: RunWebResult["sources"] = []; const sourceIds = new Set<string>();
  for (const s of value.sources) {
    if (!object(s) || !ID.test(s.id) || sourceIds.has(s.id) || !text(s.title, 300) || !text(s.excerpt,1500,true) ||
        !date(s.searchRetrievedAt) || !(s.publishedAt === null || publicationDate(s.publishedAt)) ||
        !["search_excerpt", "fetched_passage"].includes(s.evidenceType)) return;
    const url = publicWebUrl(s.url); const finalUrl = s.finalUrl === undefined ? undefined : publicWebUrl(s.finalUrl);
    if (!url || s.finalUrl !== undefined && !finalUrl || s.fetchedAt !== undefined && !date(s.fetchedAt) ||
        s.evidenceType === "fetched_passage" && (!s.fetchedAt || !finalUrl)) return;
    sourceIds.add(s.id);
    sources.push({id:s.id,title:s.title,url,searchRetrievedAt:s.searchRetrievedAt,publishedAt:s.publishedAt,
      excerpt:s.excerpt,evidenceType:s.evidenceType,...(finalUrl ? {finalUrl} : {}),...(s.fetchedAt ? {fetchedAt:s.fetchedAt} : {})});
  }
  const claims: RunWebResult["claims"] = []; const claimIds = new Set<string>(); let chars = 0;
  for (const c of value.claims) {
    if (!object(c) || !ID.test(c.id) || claimIds.has(c.id) || !text(c.text,4000) ||
        !Array.isArray(c.sourceIds) || !c.sourceIds.length || c.sourceIds.length > 5 ||
        new Set(c.sourceIds).size !== c.sourceIds.length || !c.sourceIds.every((id:any) => typeof id === "string" && sourceIds.has(id))) return;
    chars += c.text.length; if (chars > 4000) return;
    let support: RunWebResult["claims"][number]["support"];
    if (c.support !== undefined) {
      if (!Array.isArray(c.support) || !c.support.length || c.support.length > 10) return;
      support = [];
      for (const p of c.support) {
        if (!object(p) || !c.sourceIds.includes(p.sourceId) || !text(p.quote,1500) || p.quote !== c.text ||
            !sources.find(s=>s.id===p.sourceId)?.excerpt.includes(p.quote)) return;
        support.push({sourceId:p.sourceId,quote:p.quote});
      }
    }
    if(!support || c.sourceIds.some((id:string)=>!support!.some(p=>p.sourceId===id&&p.quote===c.text)))return;
    claimIds.add(c.id); claims.push({id:c.id,text:c.text,sourceIds:[...c.sourceIds],...(support ? {support} : {})});
  }
  const pairs = new Set<string>(); const citations: RunWebResult["citations"] = [];
  for (const c of value.citations) {
    if (!object(c) || !claimIds.has(c.claimId) || !sourceIds.has(c.sourceId) ||
        !claims.find(p=>p.id===c.claimId)?.sourceIds.includes(c.sourceId)) return;
    const key = c.claimId+":"+c.sourceId; if(pairs.has(key))return; pairs.add(key);
    citations.push({claimId:c.claimId,sourceId:c.sourceId});
  }
  if (claims.some(c=>c.sourceIds.some(id=>!pairs.has(c.id+":"+id))) ||
      ["complete", "partial"].includes(value.outcome) && !sources.length ||
      value.operation === "answer" && value.outcome === "complete" && (!claims.length || value.model === null) ||
      value.outcome === "cancelled" && (sources.length || claims.length || citations.length)) return;
  const metrics: RunWebResult["metrics"] = {};
  for (const [k,v] of Object.entries(value.metrics)) {
    if (k === "cacheHit") {if (!(v === null || typeof v === "boolean")) return; metrics.cacheHit=v as boolean|null;}
    else if (METRICS.has(k)) {if (!(v === null || typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 86400000)) return; metrics[k]=v as number|null;}
    // Unknown metrics are intentionally not projected into public labels or the durable result.
  }
  let error: RunWebResult["error"] = null;
  if (value.error !== null) {
    const e=value.error;
    if (!object(e) || !code(e.code) || !STAGES.has(e.stage) || !text(e.message,500) ||
        e.retryAfterMs !== undefined && !(e.retryAfterMs===null || typeof e.retryAfterMs==="number" && Number.isFinite(e.retryAfterMs) && e.retryAfterMs>=0 && e.retryAfterMs<=86400000) ||
        e.retryable !== undefined && typeof e.retryable!=="boolean") return;
    error={code:e.code,stage:e.stage,message:e.message,...(e.retryAfterMs!==undefined?{retryAfterMs:e.retryAfterMs}:{}),...(e.retryable!==undefined?{retryable:e.retryable}:{})};
  }
  if (["failed","insufficient_sources","cancelled"].includes(value.outcome) && !error) return;
  if (value.outcome === "complete" && error) return;
  // spokenText is reconstructed from admitted claims, never trusted as a second answer.
  const spokenClaims: string[] = [];
  for (const c of claims) {if (spokenClaims.join(" ").length+c.text.length+1>1200) break; spokenClaims.push(c.text);}
  const spokenText = spokenClaims.length ? spokenClaims.join(" ") : undefined;
  return {version:1,operation:value.operation,outcome:value.outcome,provider:"parallel-free",providerAuth:"anonymous",
    model:value.model,profile:value.profile,...(value.responseLanguage?{responseLanguage:value.responseLanguage}:{}),sources,claims,citations,metrics,error,degradations:[...value.degradations],...(spokenText?{spokenText}:{})};
}

export function webResultText(web: RunWebResult): string {
  if (web.outcome === "cancelled") return web.error?.message || "Recherche annulée.";
  const parts = web.claims.map(c=>c.text);
  if (!parts.length && web.sources.length) parts.push(...web.sources.map(s=>s.title));
  if (web.error) parts.push(web.error.message);
  if (!parts.length) parts.push("Aucune source suffisamment probante n’a été trouvée.");
  return parts.join("\n\n").slice(0,4000);
}

export function webRunState(web: RunWebResult): "done" | "failed" {
  return web.outcome === "complete" || web.outcome === "partial" ? "done" : "failed";
}

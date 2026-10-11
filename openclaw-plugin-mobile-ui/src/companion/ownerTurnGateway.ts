/**
 * P1 — connexion Gateway des seuls tours owner admis.
 *
 * Le Gateway installé (OpenClaw 2026.9.6) dérive `senderIsOwner` de `operator.admin` sur toute la
 * connexion. Un tour admis passe donc par une connexion à lui, ouverte par le propriétaire
 * OpenClaw (`callGatewayFromCli` de plugin-sdk/gateway-runtime : bootstrap, SecretRef, handshake),
 * avec les scopes admin/write, une seule requête `agent`, puis fermée. Cette connexion n'est
 * partagée ni avec les tours non admis (CLI `operator.write`) ni avec le pool Control P0-1.
 *
 * Ce module n'expose aucune méthode paramétrable : uniquement `agent`. Un échec avant envoi est
 * rapporté `requestSent:false` (l'appelant peut rester non-owner) ; après l'envoi, aucun rejeu.
 */
import fs from "fs/promises";
import path from "path";
import {createRequire} from "module";
import {pathToFileURL} from "url";

export const OWNER_TURN_SCOPES = Object.freeze(["operator.admin", "operator.write"]);
export const OWNER_TURN_METHOD = "agent";
const SUPPORTED_OPENCLAW = "2026.9.6";
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
const unavailable = (code: string) => Object.assign(new Error(code), {code, requestSent: false});

type GatewaySdk = {callGatewayFromCli: (method: string, opts: any, params: any, extra: any) => Promise<any>};
export type OwnerTurnSdkLoader = () => Promise<GatewaySdk>;

async function packageRoot(start: string) {
  let current = path.dirname(start);
  for (let depth = 0; depth < 8; depth++) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8"));
      if (meta?.name === "openclaw") return {root: current, version: meta.version};
    } catch {}
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  throw unavailable("owner_transport_unavailable");
}
async function binaryPath(binary: string) {
  if (!binary || binary.includes("\0")) throw unavailable("owner_transport_unavailable");
  if (binary.includes(path.sep)) return fs.realpath(path.resolve(binary));
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    try { const candidate = path.resolve(directory, binary); await fs.access(candidate, 1); return await fs.realpath(candidate); } catch {}
  }
  throw unavailable("owner_transport_unavailable");
}
/** Paquet installé choisi par la résolution de modules ou par le binaire CLI existant (même découverte que P0-1). */
export async function loadInstalledGatewaySdk(binary = process.env.CLAWMOBILE_OPENCLAW_BIN || "openclaw"): Promise<GatewaySdk> {
  let entry: string;
  try { entry = require.resolve("openclaw/plugin-sdk/gateway-runtime"); }
  catch {
    const {root} = await packageRoot(await binaryPath(binary));
    try { entry = createRequire(path.join(root, "package.json")).resolve("openclaw/plugin-sdk/gateway-runtime"); }
    catch { throw unavailable("owner_transport_unavailable"); }
  }
  const {version} = await packageRoot(entry);
  if (version !== SUPPORTED_OPENCLAW) throw unavailable("owner_transport_version_unsupported");
  const module = await nativeImport(pathToFileURL(entry).href);
  if (typeof module?.callGatewayFromCli !== "function") throw unavailable("owner_transport_unavailable");
  return {callGatewayFromCli: module.callGatewayFromCli};
}

let loader: OwnerTurnSdkLoader = () => loadInstalledGatewaySdk();
let loading: Promise<GatewaySdk> | undefined;
/** Tests uniquement. */
export function setOwnerTurnSdkLoader(next: OwnerTurnSdkLoader) { loader = next; loading = undefined; }

/** Soumet un tour admis owner. Seul appelant : openclawAgentClient, après `turnAdmission.isCurrent`. */
export async function submitOwnerTurn(params: Record<string, any>, options: {expectFinal?: boolean; timeoutMs: number}) {
  if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.idempotencyKey !== "string" ||
    typeof params.sessionKey !== "string" || typeof params.message !== "string") throw unavailable("owner_turn_invalid");
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw unavailable("owner_turn_invalid");
  let sdk: GatewaySdk;
  try { sdk = await (loading ??= loader()); }
  catch (error: any) { loading = undefined; throw unavailable(typeof error?.code === "string" && /^owner_transport_[a-z_]+$/.test(error.code) ? error.code : "owner_transport_unavailable"); }
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(Object.assign(new Error("owner_turn_indeterminate"), {code: "owner_turn_indeterminate", requestSent: true})); }, timeoutMs + 5_000);
  });
  try {
    // Frontière d'envoi : toute erreur après ce point reste indéterminée, sans repli CLI ni rejeu.
    return await Promise.race([
      sdk.callGatewayFromCli(OWNER_TURN_METHOD, {json: true, timeout: String(timeoutMs), expectFinal: options.expectFinal === true},
        params, {scopes: [...OWNER_TURN_SCOPES], progress: false, expectFinal: options.expectFinal === true, timeoutMs, signal: abort.signal}),
      hard,
    ]);
  } catch (error: any) {
    if (error?.code === "owner_turn_indeterminate") throw error;
    throw Object.assign(new Error("owner_turn_failed"), {code: "owner_turn_failed", requestSent: true, gatewayCode: typeof error?.gatewayCode === "string" ? error.gatewayCode : undefined});
  } finally { if (timer) clearTimeout(timer); }
}

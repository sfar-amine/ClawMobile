/** P1 : une connexion GatewayClient publique par tour, une méthode agent, aucun rejeu.
 * Le sous-ensemble local token/password réutilise les propriétaires publics de config,
 * SecretRef et port. Les cibles distantes/TLS/overrides sont refusées avant connexion.
 * Une admission expirée pendant le bootstrap/handshake ne peut émettre agent.
 * Après émission, un échec reste indéterminé : fermer la connexion ne promet pas annuler l'effet.
 */
import fs from "fs/promises";
import path from "path";
import {createRequire} from "module";
import {pathToFileURL} from "url";
import {turnAdmission, type AdmissionTicket} from "./ownerTurnAdmission";

export const OWNER_TURN_SCOPES = Object.freeze(["operator.admin", "operator.write"]);
export const OWNER_TURN_METHOD = "agent";
const SUPPORTED_OPENCLAW = "2026.9.6";
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
const unavailable = (code: string) => Object.assign(new Error(code), {code, requestSent: false});

type GatewaySdk = {
  GatewayClient: new (options: any) => any;
  startGatewayClientWhenEventLoopReady: (client: any, options: any) => Promise<any>;
  getRuntimeConfig: () => any;
  resolveGatewayAuth: (options: any) => any;
  resolveGatewayPort: (config: any, env?: any) => number;
  resolveConfiguredSecretInputWithFallback: (options: any) => Promise<any>;
};
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
/**
 * Racine du paquet `openclaw` à partir du binaire CLI. Sur le S24 (Termux), `$PREFIX/bin/openclaw` est un script
 * enveloppe et non un lien : on retombe sur l'arborescence npm globale `<prefix>/lib/node_modules/openclaw`
 * (11/10 : tous les tours owner non déterministes échouaient en owner_transport_unavailable).
 */
export async function installedPackageRoot(binary: string) {
  const resolved = await binaryPath(binary);
  try { return await packageRoot(resolved); }
  catch (error) {
    const global = path.join(path.dirname(path.dirname(resolved)), "lib", "node_modules", "openclaw", "package.json");
    try {
      const meta = JSON.parse(await fs.readFile(global, "utf8"));
      if (meta?.name === "openclaw") return {root: path.dirname(global), version: meta.version};
    } catch {}
    throw error;
  }
}
/** Paquet installé choisi par la résolution de modules ou par le binaire CLI existant (même découverte que P0-1). */
export async function loadInstalledGatewaySdk(binary = process.env.CLAWMOBILE_OPENCLAW_BIN || "openclaw"): Promise<GatewaySdk> {
  let entry: string;
  try { entry = require.resolve("openclaw/plugin-sdk/gateway-runtime"); }
  catch {
    const {root} = await installedPackageRoot(binary);
    try { entry = createRequire(path.join(root, "package.json")).resolve("openclaw/plugin-sdk/gateway-runtime"); }
    catch { throw unavailable("owner_transport_unavailable"); }
  }
  const {version} = await packageRoot(entry);
  if (version !== SUPPORTED_OPENCLAW) throw unavailable("owner_transport_version_unsupported");
  const packageRequire = createRequire(path.join((await packageRoot(entry)).root, "package.json"));
  const modules = await Promise.all(["gateway-runtime", "config-runtime", "gateway-config-runtime"].map(async (name) => {
    try { return await nativeImport(pathToFileURL(packageRequire.resolve(`openclaw/plugin-sdk/${name}`)).href); }
    catch { throw unavailable("owner_transport_unavailable"); }
  }));
  const sdk = {...modules[0], ...modules[1], ...modules[2]};
  for (const name of ["GatewayClient", "startGatewayClientWhenEventLoopReady", "getRuntimeConfig", "resolveGatewayAuth", "resolveGatewayPort", "resolveConfiguredSecretInputWithFallback"])
    if (typeof sdk[name] !== "function") throw unavailable("owner_transport_unavailable");
  return sdk;

}

let loader: OwnerTurnSdkLoader = () => loadInstalledGatewaySdk();
let loading: Promise<GatewaySdk> | undefined;
/** Tests uniquement. */
export function setOwnerTurnSdkLoader(next: OwnerTurnSdkLoader) { loader = next; loading = undefined; }

/** Soumet un tour admis owner. Seul appelant : openclawAgentClient, après `turnAdmission.isCurrent`. */
export async function submitOwnerTurn(params: Record<string, any>, options: {expectFinal?: boolean; timeoutMs: number; admission: AdmissionTicket; binding: {clientRunId?: string; sessionId: string}}) {
  if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.idempotencyKey !== "string" ||
    typeof params.sessionKey !== "string" || typeof params.message !== "string") throw unavailable("owner_turn_invalid");
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw unavailable("owner_turn_invalid");
  let sdk: GatewaySdk;
  try { sdk = await (loading ??= loader()); }
  catch (error: any) { loading = undefined; throw unavailable(typeof error?.code === "string" && /^owner_transport_[a-z_]+$/.test(error.code) ? error.code : "owner_transport_unavailable"); }
  // Loading the installed SDK may await disk/import. Revocation or expiry during it cannot open admin.
  if (!turnAdmission.isCurrent(options.admission, options.binding)) throw unavailable("owner_turn_admission_expired");
  let config: any;
  try { config = sdk.getRuntimeConfig(); } catch { throw unavailable("owner_transport_config_unavailable"); }
  const gateway = config?.gateway;
  if (!gateway || (gateway.mode !== undefined && gateway.mode !== "local") || gateway.tls?.enabled === true ||
    (process.env.OPENCLAW_GATEWAY_URL || "").trim() || !["token", "password"].includes(gateway.auth?.mode))
    throw unavailable("owner_transport_target_unsupported");
  const mode = gateway.auth.mode;
  let credential: any;
  try {
    const resolvedAuth = sdk.resolveGatewayAuth({authConfig: gateway.auth, env: process.env});
    credential = await sdk.resolveConfiguredSecretInputWithFallback({config, path: `gateway.auth.${mode}`,
      value: gateway.auth[mode], env: process.env, readFallback: () => resolvedAuth[mode]});
  } catch { throw unavailable("owner_transport_auth_unavailable"); }
  if (credential.unresolvedRefReason || typeof credential.value !== "string" || !credential.value.trim())
    throw unavailable("owner_transport_auth_unavailable");
  let port: number;
  try { port = sdk.resolveGatewayPort(config, process.env); } catch { throw unavailable("owner_transport_target_unsupported"); }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw unavailable("owner_transport_target_unsupported");
  const assertCurrent = () => {
    if (!turnAdmission.isCurrent(options.admission, options.binding)) throw unavailable("owner_turn_admission_expired");
  };
  assertCurrent();
  const abort = new AbortController();
  let client: any;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dispatched = false;
  let requestSent = false;
  let done = false;
  let resolveResult!: (value: any) => void;
  let rejectResult!: (error: any) => void;
  const result = new Promise<any>((resolve, reject) => {resolveResult = resolve; rejectResult = reject;});
  // Readiness can fail before result is awaited. Register a handler without swallowing the caller's rejection.
  void result.catch(() => {});
  const fail = (error: any) => {
    if (done) return;
    done = true;
    rejectResult(Object.assign(new Error(requestSent ? "owner_turn_indeterminate" : "owner_turn_failed"), {
      code: requestSent ? "owner_turn_indeterminate" : (typeof error?.code === "string" && /^owner_(transport|turn)_[a-z_]+$/.test(error.code) ? error.code : "owner_turn_failed"), requestSent,
    }));
    client?.stop();
  };
  try {
    client = new sdk.GatewayClient({url: `ws://127.0.0.1:${port}`, [mode]: credential.value,
      clientName: "cli", mode: "cli", role: "operator", deviceIdentity: null, sharedStateMode: "read-only",
      scopes: [...OWNER_TURN_SCOPES], minProtocol: 4, maxProtocol: 4,
      hostDeps: {beforeConnect: assertCurrent},
      onConnectError: fail, onReconnectPaused: () => fail(unavailable("owner_transport_unavailable")),
      onClose: () => fail(unavailable("owner_transport_unavailable")),
      onHelloOk: (hello: any) => {
        if (done || dispatched) return;
        try {
          if (hello?.auth?.role !== "operator" || !OWNER_TURN_SCOPES.every(scope => hello.auth.scopes?.includes(scope)) ||
            !hello.features?.methods?.includes(OWNER_TURN_METHOD)) throw unavailable("owner_transport_scopes_unavailable");
          assertCurrent();
          dispatched = true;
          // The pinned public client sends synchronously: no await between this check and socket.send.
          const pending = client.request(OWNER_TURN_METHOD, params, {expectFinal: options.expectFinal === true, timeoutMs,
            signal: abort.signal, onSent: () => {requestSent = true;}});
          Promise.resolve(pending).then(value => {if (!done) {done = true; resolveResult(value);}}, fail);
        } catch (error) {fail(error);}
      },
    });
    timer = setTimeout(() => {abort.abort(); fail(unavailable("owner_transport_timeout"));}, timeoutMs + 5_000);
    const readiness = await sdk.startGatewayClientWhenEventLoopReady(client, {clientOptions: {}, signal: abort.signal, timeoutMs});
    if (!readiness.ready) fail(unavailable("owner_transport_unavailable"));
    return await result;
  } catch (error) {
    fail(error);
    return await result;
  } finally {
    done = true;
    if (timer) clearTimeout(timer);
    abort.abort();
    if (client) {try {await client.stopAndWait();} catch {client.stop();}}
  }
}

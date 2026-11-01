import fs from "fs";
import path from "path";
import {createRequire} from "module";
import {pathToFileURL} from "url";

/** Single version table of the installed OpenClaw SDK surfaces this plugin imports.
 *
 * 2026.9.6 is production on the S24: its rows are exactly the subpaths, chunk and symbols used before this table.
 * 2026.10.9 is the upgrade candidate, read from the public npm tar (fixtures/openclaw-sdk-surface, provenance there):
 * `plugin-sdk/config-runtime` no longer exists, `getRuntimeConfig` comes from `runtime-config-snapshot`,
 * `resolveConfiguredSecretInputWithFallback` from `secret-input-runtime`, `coerceSecretRef` from `secret-ref-runtime`,
 * and `loadConfig` is gone (`getRuntimeConfig(options)` is the same `loadConfig(options)` call in both versions).
 * The model profile contract lives in the hashed chunk the model-flow-selection compatibility set patches.
 * Any other version is refused before the first import. `scripts/qualify-openclaw-sdk.cjs` checks every row
 * against the real package in CI. A surface set to null is not qualified on that version and stays refused. */
export type SdkExport = readonly [subpath: string, exportName: string];
export type SdkSurface = Readonly<Record<string, SdkExport>>;
export type OpenClawSdkVersion = Readonly<{
  /** Owner turn transport (ownerTurnGateway). Modules are spread in first-use order, then these rows win. */
  ownerTurn: SdkSurface;
  /** Session metadata owner (model flows). The session module is spread, then these rows win. */
  sessionStore: SdkSurface;
  /** Compatibility-patched hashed chunk exporting the model profile contract; absent export means 0 (refused). */
  modelProfileContract: Readonly<{module: string; symbol: string}>;
  /** Official persistent Gateway owner (officialGatewayOwner). */
  officialGateway: SdkSurface;
  /** QA document staging. Null: not qualified on this version. */
  mediaStore: SdkSurface | null;
}>;

const gateway = (name: string): SdkExport => ["gateway-runtime", name];
const sessions = (name: string): SdkExport => ["session-store-runtime", name];
const port: SdkExport = ["gateway-config-runtime", "resolveGatewayPort"];

export const OPENCLAW_SDK_VERSIONS: Readonly<Record<string, OpenClawSdkVersion>> = Object.freeze({
  "2026.9.6": Object.freeze({
    ownerTurn: Object.freeze({
      GatewayClient: gateway("GatewayClient"),
      startGatewayClientWhenEventLoopReady: gateway("startGatewayClientWhenEventLoopReady"),
      resolveGatewayAuth: gateway("resolveGatewayAuth"),
      getRuntimeConfig: ["config-runtime", "getRuntimeConfig"] as SdkExport,
      resolveConfiguredSecretInputWithFallback: ["config-runtime", "resolveConfiguredSecretInputWithFallback"] as SdkExport,
      resolveGatewayPort: port,
    }),
    sessionStore: Object.freeze({
      getSessionEntry: sessions("getSessionEntry"),
      listSessionEntries: sessions("listSessionEntries"),
      patchSessionEntry: sessions("patchSessionEntry"),
      getRuntimeConfig: ["config-runtime", "getRuntimeConfig"] as SdkExport,
    }),
    modelProfileContract: Object.freeze({module: "dist/setup-B7DuERIi.mjs", symbol: "MODEL_PROFILE_CONTRACT_VERSION"}),
    officialGateway: Object.freeze({
      GatewayClient: gateway("GatewayClient"),
      resolveGatewayAuth: gateway("resolveGatewayAuth"),
      loadConfig: ["config-runtime", "loadConfig"] as SdkExport,
      coerceSecretRef: ["config-runtime", "coerceSecretRef"] as SdkExport,
      resolveGatewayPort: port,
      resolveSecretRefValues: ["secret-ref-runtime", "resolveSecretRefValues"] as SdkExport,
    }),
    mediaStore: Object.freeze({
      saveMediaBuffer: ["media-store", "saveMediaBuffer"] as SdkExport,
      resolveMediaBufferPath: ["media-store", "resolveMediaBufferPath"] as SdkExport,
    }),
  }),
  "2026.10.9": Object.freeze({
    ownerTurn: Object.freeze({
      GatewayClient: gateway("GatewayClient"),
      startGatewayClientWhenEventLoopReady: gateway("startGatewayClientWhenEventLoopReady"),
      resolveGatewayAuth: gateway("resolveGatewayAuth"),
      getRuntimeConfig: ["runtime-config-snapshot", "getRuntimeConfig"] as SdkExport,
      resolveConfiguredSecretInputWithFallback: ["secret-input-runtime", "resolveConfiguredSecretInputWithFallback"] as SdkExport,
      resolveGatewayPort: port,
    }),
    sessionStore: Object.freeze({
      getSessionEntry: sessions("getSessionEntry"),
      listSessionEntries: sessions("listSessionEntries"),
      patchSessionEntry: sessions("patchSessionEntry"),
      getRuntimeConfig: ["runtime-config-snapshot", "getRuntimeConfig"] as SdkExport,
    }),
    modelProfileContract: Object.freeze({module: "dist/embedded-agent-DoEPu8ye.mjs", symbol: "MODEL_PROFILE_CONTRACT_VERSION"}),
    officialGateway: Object.freeze({
      GatewayClient: gateway("GatewayClient"),
      resolveGatewayAuth: gateway("resolveGatewayAuth"),
      loadConfig: ["runtime-config-snapshot", "getRuntimeConfig"] as SdkExport,
      coerceSecretRef: ["secret-ref-runtime", "coerceSecretRef"] as SdkExport,
      resolveGatewayPort: port,
      resolveSecretRefValues: ["secret-ref-runtime", "resolveSecretRefValues"] as SdkExport,
    }),
    // media-store changed (commit guard, explicit resource disposal): kept refused until a 2026.10.9 QA staging proof.
    mediaStore: null,
  }),
});

/** The pinned surfaces of an installed version, or undefined (refused) for any other version. */
export function openclawSdkVersion(version: unknown): OpenClawSdkVersion | undefined {
  return typeof version === "string" && Object.prototype.hasOwnProperty.call(OPENCLAW_SDK_VERSIONS, version)
    ? OPENCLAW_SDK_VERSIONS[version] : undefined;
}

/** Distinct subpaths of a surface, in first-use order (the import and spread order). */
export function surfaceSubpaths(surface: SdkSurface): string[] {
  return [...new Set(Object.values(surface).map(([subpath]) => subpath))];
}

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;

/** Imports one module of the installed OpenClaw package (#126).
 * In the Gateway the plugin runs from its source capture, whose `node_modules/openclaw` links the live host package.
 * When this module resolves `specifier` to the same file itself, the bare specifier is imported: the capture leaves
 * `openclaw` to native resolution and the plugin shares the host's own module instances. A file URL to the same file
 * is a module outside the plugin package, which OpenClaw 2026.9.6 and 2026.10.9 copy into the capture with every
 * package it imports (S24 01/11: 21 045 files and 190 MB for the session store surface, at each Gateway restart).
 * The Companion process has no such link: it keeps the file URL found from the installed package. */
export function importHostModule(file: string, specifier: string): Promise<any> {
  return nativeImport(nativeResolution(specifier) === file ? specifier : pathToFileURL(file).href);
}

/** File that the native `import(specifier)` of this module loads, or undefined when it would not resolve.
 * ESM looks a bare specifier up only in the `node_modules` of this module's ancestors, the first existing package
 * folder winning; `require.resolve` also searches NODE_PATH and the global folders, where `import()` then fails with
 * ERR_MODULE_NOT_FOUND. The export map of that package is applied by CommonJS from that same folder. */
function nativeResolution(specifier: string, from: string = __dirname): string | undefined {
  const name = specifier.startsWith("@") ? specifier.split("/", 2).join("/") : specifier.split("/", 1)[0];
  for (let directory = from; ; directory = path.dirname(directory)) {
    if (fs.statSync(path.join(directory, "node_modules", name), {throwIfNoEntry: false})?.isDirectory()) {
      try { return createRequire(path.join(directory, "noop.js")).resolve(specifier); } catch { return undefined; }
    }
    if (path.dirname(directory) === directory) return undefined;
  }
}

/** Value of a numeric constant that a hashed chunk exports, read as text and never imported (#126): importing the
 * model profile chunk made the Gateway capture the agent runtime and its providers' SDKs. Exactly one declaration
 * `const <symbol> = <n>;` exported in place (2026.9.6 patch) or by an `export { … }` clause without alias
 * (2026.10.9 patch); anything else is 0, the refused value. */
export function readChunkConstExport(text: string, symbol: string): number {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return 0;
  const declarations = [...text.matchAll(new RegExp(`^(export )?const ${symbol.replace(/\$/g, "\\$")} = (\\d+);$`, "gm"))];
  if (declarations.length !== 1) return 0;
  const [, inline, value] = declarations[0];
  const exported = Boolean(inline) || [...text.matchAll(/^export \{([^}]*)\};$/gm)]
    .some(clause => clause[1].split(",").map(part => part.trim().split(/\s+as\s+/)).some(([local, alias]) => local === symbol && (alias === undefined || alias === symbol)));
  return exported ? Number(value) : 0;
}

/** Imports each subpath once through the package's own export map, then picks the pinned exports. */
export async function importSurface(surface: SdkSurface, resolve: (specifier: string) => string,
  load: (file: string, specifier: string) => Promise<any> = importHostModule): Promise<{modules: Map<string, any>; picked: Record<string, any>}> {
  const subpaths = surfaceSubpaths(surface);
  const loaded = await Promise.all(subpaths.map(subpath => {
    const specifier = `openclaw/plugin-sdk/${subpath}`;
    return load(resolve(specifier), specifier);
  }));
  const modules = new Map(subpaths.map((subpath, index) => [subpath, loaded[index]]));
  const picked: Record<string, any> = {};
  for (const [name, [subpath, exportName]] of Object.entries(surface)) picked[name] = modules.get(subpath)?.[exportName];
  return {modules, picked};
}

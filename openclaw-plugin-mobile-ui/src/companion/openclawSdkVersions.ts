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

/** Imports each subpath once through the package's own export map, then picks the pinned exports. */
export async function importSurface(surface: SdkSurface, resolve: (specifier: string) => string,
  load: (specifier: string) => Promise<any>): Promise<{modules: Map<string, any>; picked: Record<string, any>}> {
  const subpaths = surfaceSubpaths(surface);
  const loaded = await Promise.all(subpaths.map(subpath => load(resolve(`openclaw/plugin-sdk/${subpath}`))));
  const modules = new Map(subpaths.map((subpath, index) => [subpath, loaded[index]]));
  const picked: Record<string, any> = {};
  for (const [name, [subpath, exportName]] of Object.entries(surface)) picked[name] = modules.get(subpath)?.[exportName];
  return {modules, picked};
}

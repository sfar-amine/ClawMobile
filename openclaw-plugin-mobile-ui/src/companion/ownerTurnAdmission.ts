/**
 * P1 — admission native des tours owner (contrat playbooks 43, v2).
 *
 * Une requête n'est « owner » que si elle porte une preuve signée par la clé d'admission de l'app,
 * générée dans l'Android Keystore (non exportable) et enrôlée une seule fois par une confirmation
 * biométrique du propriétaire (clé owner-confirmation déjà épinglée). Le loopback, un en-tête
 * constant, un champ du corps ou le texte ne donnent jamais cette autorité.
 *
 * La preuve lie : méthode, chemin, empreinte du corps exact, identifiant de tour (clientRunId),
 * session, horodatage, nonce et identifiant de clé. Le Companion refuse les horodatages hors
 * fenêtre et les nonces rejoués (cache mémoire borné, TTL court). Toute erreur => non-owner.
 *
 * Le ticket d'admission est un objet mémoire opaque (WeakSet) : il ne se sérialise pas, ne se
 * restaure pas depuis un journal et n'est valable que pour son tour, sa session et l'époque
 * d'enrôlement courante. La révocation supprime l'enrôlement : les tours suivants sont non-owner ;
 * un tour déjà remis au Gateway se termine avec le bit figé à l'acceptation.
 */
import {createHash,createPublicKey,randomBytes,verify,type KeyObject} from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {confirmations as canonicalConfirmations} from "./confirmations";
import {ownerUuid,type OwnerIntent} from "./ownerConfirmationProtocol";

export const ADMISSION_VERSION = "v1";
export const ADMISSION_DOMAIN = "claw.owner.turn-admission.v1";
export const ENROLL_DOMAIN = "claw.owner.turn-admission.enroll.v1";
export const ENROLL_ACTION = "owner.turn_admission.enroll";
export const ENROLL_ORIGIN = Object.freeze({channel: "samantha", id: "turn-admission"});
export const ADMISSION_HEADERS = Object.freeze({
  version: "x-samantha-admission",
  key: "x-samantha-admission-key",
  timestamp: "x-samantha-admission-ts",
  nonce: "x-samantha-admission-nonce",
  signature: "x-samantha-admission-signature",
});
/** Même appareil, même horloge : fenêtre courte. */
export const ADMISSION_WINDOW_MS = 30_000;
/** Un nonce reste mémorisé plus longtemps que toute la fenêtre acceptable (passé et futur). */
export const NONCE_TTL_MS = 2 * ADMISSION_WINDOW_MS + 5_000;
export const NONCE_CAPACITY = 2048;
/** Délai maximal entre l'admission et la remise au Gateway. */
export const TICKET_TTL_MS = 60_000;
const hex64 = /^[a-f0-9]{64}$/;
const nonceShape = /^[a-f0-9]{32,64}$/;
const timestampShape = /^[0-9]{13}$/;
const signatureShape = /^[A-Za-z0-9+/]{80,104}={0,2}$/;
const runIdShape = /^[A-Za-z0-9._:-]{8,160}$/;

export type AdmissionRefusal =
  | "no_proof" | "malformed_proof" | "not_enrolled" | "unknown_key" | "stale_timestamp"
  | "bad_signature" | "replayed_nonce" | "nonce_cache_full" | "invalid_binding" | "enrollment_unreadable";
export type AdmissionTicket = Readonly<{keyId: string; epoch: string; clientRunId: string; sessionId: string; admittedAt: number; expiresAt: number}>;
export type AdmissionResult = {admitted: true; ticket: AdmissionTicket} | {admitted: false; reason: AdmissionRefusal};
export type AdmissionRequest = {
  method: string; path: string; headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer; clientRunId: unknown; sessionId: unknown;
};
type Enrollment = {version: 1; keyId: string; publicKey: string; enrolledAt: number; confirmationId: string; epoch: string};

export const sha256Hex = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Chaîne signée par l'app, champ par ligne ; aucun champ ne peut contenir de saut de ligne. */
export function admissionMessage(v: {method: string; path: string; bodyHash: string; clientRunId: string; sessionId: string; timestamp: string; nonce: string; keyId: string}) {
  return [ADMISSION_DOMAIN, v.method, v.path, v.bodyHash, v.clientRunId, v.sessionId, v.timestamp, v.nonce, v.keyId].join("\n");
}
export function enrollmentMessage(confirmationId: string, keyId: string) {
  return [ENROLL_DOMAIN, confirmationId, keyId].join("\n");
}
/** Session telle que le Companion la normalise ; la preuve et le ticket utilisent la même forme. */
export function admissionSessionId(value: unknown) {
  const safe = String(value || "default").replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return safe || "default";
}

function admissionError(code: string, statusCode: number): never {
  throw Object.assign(new Error(code), {statusCode, code});
}
function single(headers: AdmissionRequest["headers"], name: string): string | undefined {
  const value = headers[name];
  // Une valeur répétée (tableau, ou jointure « a, b ») n'est jamais une preuve.
  return typeof value === "string" && !value.includes(",") ? value : undefined;
}
function p256(der: Buffer): KeyObject {
  const key = createPublicKey({key: der, format: "der", type: "spki"});
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") admissionError("invalid_admission_key", 400);
  return key;
}

export function createTurnAdmission(options: {
  stateDir?: () => string; clock?: () => number;
  confirmations?: Pick<typeof canonicalConfirmations, "status" | "consume">;
} = {}) {
  const now = options.clock || Date.now;
  const confirmations = options.confirmations || canonicalConfirmations;
  const stateDir = options.stateDir || (() => path.join(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"), "clawmobile-companion"));
  const file = () => path.join(stateDir(), "owner-turn-admission.json");
  const nonces = new Map<string, number>();
  const tickets = new WeakSet<object>();
  let cached: {stamp: string; value: Enrollment & {key: KeyObject}} | undefined;

  /** Relu à chaque vérification (stat) : supprimer le fichier révoque immédiatement. */
  function enrollment(): (Enrollment & {key: KeyObject}) | null {
    let stat: fs.Stats;
    try { stat = fs.statSync(file()); } catch (error: any) {
      cached = undefined;
      if (error?.code === "ENOENT") return null;
      throw admissionError("enrollment_unreadable", 503);
    }
    const stamp = [stat.ino, stat.size, stat.mtimeMs].join(":");
    if (cached?.stamp === stamp) return cached.value;
    try {
      const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
      if (!raw || raw.version !== 1 || typeof raw.publicKey !== "string" || !hex64.test(raw.keyId) ||
        typeof raw.epoch !== "string" || !/^[a-f0-9]{32}$/.test(raw.epoch) || !Number.isSafeInteger(raw.enrolledAt)) throw Error();
      const der = Buffer.from(raw.publicKey, "base64");
      if (sha256Hex(der) !== raw.keyId) throw Error();
      const value = {...raw, key: p256(der)} as Enrollment & {key: KeyObject};
      cached = {stamp, value};
      return value;
    } catch { cached = undefined; return admissionError("enrollment_unreadable", 503); }
  }

  function purge(at: number) {
    for (const [nonce, expiry] of nonces) if (expiry <= at) nonces.delete(nonce);
  }

  function verifyRequest(request: AdmissionRequest): AdmissionResult {
    const h = request.headers || {};
    const names = Object.values(ADMISSION_HEADERS);
    if (names.every(name => h[name] === undefined)) return {admitted: false, reason: "no_proof"};
    const version = single(h, ADMISSION_HEADERS.version), keyId = single(h, ADMISSION_HEADERS.key);
    const timestamp = single(h, ADMISSION_HEADERS.timestamp), nonce = single(h, ADMISSION_HEADERS.nonce);
    const signature = single(h, ADMISSION_HEADERS.signature);
    if (version !== ADMISSION_VERSION || !keyId || !hex64.test(keyId) || !timestamp || !timestampShape.test(timestamp) ||
      !nonce || !nonceShape.test(nonce) || !signature || !signatureShape.test(signature)) return {admitted: false, reason: "malformed_proof"};
    if (!["POST", "DELETE"].includes(request.method) || !/^\/v1\/[a-z0-9/_-]{1,80}$/.test(request.path) || !Buffer.isBuffer(request.rawBody))
      return {admitted: false, reason: "invalid_binding"};
    if (typeof request.clientRunId !== "string" || !runIdShape.test(request.clientRunId)) return {admitted: false, reason: "invalid_binding"};
    const sessionId = admissionSessionId(request.sessionId);
    let enrolled: ReturnType<typeof enrollment>;
    try { enrolled = enrollment(); } catch { return {admitted: false, reason: "enrollment_unreadable"}; }
    if (!enrolled) return {admitted: false, reason: "not_enrolled"};
    if (enrolled.keyId !== keyId) return {admitted: false, reason: "unknown_key"};
    const at = now(), stamped = Number(timestamp);
    if (!Number.isSafeInteger(stamped) || Math.abs(at - stamped) > ADMISSION_WINDOW_MS) return {admitted: false, reason: "stale_timestamp"};
    const message = admissionMessage({method: request.method, path: request.path, bodyHash: sha256Hex(request.rawBody),
      clientRunId: request.clientRunId, sessionId, timestamp, nonce, keyId});
    let valid = false;
    try { valid = verify("sha256", Buffer.from(message, "utf8"), enrolled.key, Buffer.from(signature, "base64")); } catch { valid = false; }
    if (!valid) return {admitted: false, reason: "bad_signature"};
    // Après la signature seulement : une requête non authentifiée ne remplit jamais le cache.
    purge(at);
    if (nonces.has(nonce)) return {admitted: false, reason: "replayed_nonce"};
    if (nonces.size >= NONCE_CAPACITY) return {admitted: false, reason: "nonce_cache_full"};
    nonces.set(nonce, at + NONCE_TTL_MS);
    const ticket: AdmissionTicket = Object.freeze({keyId, epoch: enrolled.epoch, clientRunId: request.clientRunId, sessionId,
      admittedAt: at, expiresAt: at + TICKET_TTL_MS});
    tickets.add(ticket);
    return {admitted: true, ticket};
  }

  /** Vrai seulement pour un ticket émis ici, pour ce tour, cette session et l'enrôlement courant. */
  function isCurrent(ticket: unknown, binding: {clientRunId?: string; sessionId: string}): boolean {
    if (!ticket || typeof ticket !== "object" || !tickets.has(ticket)) return false;
    const t = ticket as AdmissionTicket;
    if (now() >= t.expiresAt || binding.clientRunId !== t.clientRunId || admissionSessionId(binding.sessionId) !== t.sessionId) return false;
    try { const e = enrollment(); return !!e && e.keyId === t.keyId && e.epoch === t.epoch; } catch { return false; }
  }

  function status() {
    let e: ReturnType<typeof enrollment> = null, readable = true;
    try { e = enrollment(); } catch { readable = false; }
    return {schemaVersion: 1, capability: "owner.turn_admission", readable, enrolled: !!e, keyId: e?.keyId ?? null,
      enrolledAt: e?.enrolledAt ?? null, windowMs: ADMISSION_WINDOW_MS, proof: "android_keystore_p256", biometricEnrollment: true};
  }

  /** Enrôlement : preuve de possession de la nouvelle clé + confirmation biométrique consommée (usage unique). */
  async function enroll(body: any) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "confirmationId,possession,publicKey")
      admissionError("invalid_enrollment_request", 400);
    const {confirmationId, publicKey, possession} = body;
    if (typeof confirmationId !== "string" || !ownerUuid.test(confirmationId) || typeof publicKey !== "string" ||
      !/^[A-Za-z0-9+/]{80,200}={0,2}$/.test(publicKey) || typeof possession !== "string" || !signatureShape.test(possession))
      admissionError("invalid_enrollment_request", 400);
    const der = Buffer.from(publicKey, "base64");
    let key: KeyObject;
    try { key = p256(der); } catch { return admissionError("invalid_admission_key", 400); }
    const keyId = sha256Hex(der);
    let possessed = false;
    try { possessed = verify("sha256", Buffer.from(enrollmentMessage(confirmationId, keyId), "utf8"), key, Buffer.from(possession, "base64")); } catch {}
    if (!possessed) admissionError("admission_key_possession_refused", 403);
    let record: any;
    try { record = await confirmations.status(confirmationId); } catch (error: any) {
      admissionError(error?.statusCode === 404 ? "confirmation_not_found" : "confirmation_not_usable", error?.statusCode === 404 ? 404 : 409);
    }
    const intent = record?.intent;
    if (!intent || intent.origin?.channel !== ENROLL_ORIGIN.channel || intent.origin?.id !== ENROLL_ORIGIN.id)
      admissionError("confirmation_scope_mismatch", 403);
    const expected: OwnerIntent = {audience: "confirmation", action: {type: ENROLL_ACTION, reference: keyId, payloadHash: keyId},
      presentation: intent.presentation, origin: {channel: "samantha", id: "turn-admission"}};
    try { await confirmations.consume(confirmationId, expected); } catch (error: any) {
      // Signature biométrique absente, autre clé, autre action, déjà consommée ou expirée : rien n'est enrôlé.
      admissionError(error?.statusCode === 403 ? "confirmation_scope_mismatch" : "confirmation_not_usable", error?.statusCode === 403 ? 403 : 409);
    }
    const value: Enrollment = {version: 1, keyId, publicKey: der.toString("base64"), enrolledAt: now(), confirmationId, epoch: randomBytes(16).toString("hex")};
    fs.mkdirSync(stateDir(), {recursive: true, mode: 0o700});
    const temporary = file() + "." + randomBytes(6).toString("hex") + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(value), {mode: 0o600, flag: "wx"});
    fs.renameSync(temporary, file());
    cached = undefined;
    return {schemaVersion: 1, state: "enrolled", keyId, enrolledAt: value.enrolledAt};
  }

  /** Révocation : l'enrôlement disparaît ; les tickets émis deviennent non courants. */
  function revoke() {
    try { fs.unlinkSync(file()); } catch (error: any) { if (error?.code !== "ENOENT") admissionError("admission_revocation_failed", 503); }
    cached = undefined;
    return {schemaVersion: 1, state: "revoked", enrolled: false};
  }

  return {verifyRequest, isCurrent, status, enroll, revoke, nonceCount: () => nonces.size};
}

export const turnAdmission = createTurnAdmission();

/** Compatibilité de déploiement, OFF par défaut : ne rend que le contexte canonique, jamais le Gateway admin. */
export function legacyLoopbackOwnerContextEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.CLAWMOBILE_RUNS_LEGACY_LOOPBACK_CONTEXT === "1";
}

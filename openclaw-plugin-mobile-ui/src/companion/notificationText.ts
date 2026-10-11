// F4 (fichiers 35/41) : projection structurée d'un résultat de run pour l'écran
// Notifications (`GET /v1/runs?summary=1`, champ `result`). Fonction pure : le texte
// brut `result` reste inchangé dans la réponse et sert de repli. Formes réelles
// (capture s24-2026-10-11b/f4) : Markdown en ligne `**…**`, JSON brut d'opération,
// texte simple ; lignes `clé: valeur` / `clé=valeur` reconnues aussi.

export type NotificationField = { key: string; label: string; value: string };
export type NotificationEmphasis = { start: number; end: number };
export type StructuredNotification = {
  version: 1;
  format: "json" | "markdown" | "key_value" | "plain";
  title: string;
  body: string;
  fields: NotificationField[];
  emphasis?: NotificationEmphasis[];
  rawFallback: "result";
};

const MAX_INPUT_CHARS = 16 * 1024;
const MAX_FIELDS = 12;
const MAX_VALUE_CHARS = 120;
const MAX_TITLE_CHARS = 80;
// Technical keys of operation receipts: never useful to the owner in a notification.
const TECHNICAL_KEYS = new Set([
  "ok", "success", "run_id", "runId", "source", "transport", "ui_used", "latency_ms",
  "observed_at", "blocked_by", "request_id", "trace_id", "schema_version", "version",
]);
const LABELS: Record<string, string> = {
  state: "État", operation: "Opération", provider: "Fournisseur", workflow: "Parcours",
  offer: "Offre", level_percent: "Niveau (%)", charging: "En charge", plugged: "Branché",
  value: "Valeur", unit: "Unité", days_remaining: "Jours restants", kind: "Type",
  title: "Titre", section: "Section", status: "Statut", reason: "Raison", message: "Message",
};
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function clip(text: string, max: number) {
  const clean = text.replace(CONTROL_RE, "").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function labelFor(key: string) {
  const last = key.split(".").at(-1) || key;
  return LABELS[last] || last.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function scalar(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "oui" : "non";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return clip(value, MAX_VALUE_CHARS);
  return null;
}

function jsonFields(value: Record<string, unknown>): NotificationField[] {
  const fields: NotificationField[] = [];
  const push = (key: string, label: string, raw: unknown) => {
    const shown = scalar(raw);
    if (shown !== null && fields.length < MAX_FIELDS) fields.push({ key, label, value: shown });
  };
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, item] of Object.entries(obj)) {
      if (fields.length >= MAX_FIELDS) return;
      if (!KEY_RE.test(key) || TECHNICAL_KEYS.has(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        if (depth < 2) walk(item as Record<string, unknown>, path, depth + 1);
      } else if (Array.isArray(item)) {
        // Cards/rows {title, value, unit}: one field per row, label from its title.
        item.slice(0, MAX_FIELDS).forEach((row: any, index) => {
          if (row && typeof row === "object" && !Array.isArray(row) && scalar(row.title) !== null && scalar(row.value) !== null) {
            const unit = scalar(row.unit);
            push(`${path}[${index}]`, scalar(row.title)!, `${scalar(row.value)}${unit ? " " + unit : ""}`);
          } else if (scalar(row) !== null) {
            push(`${path}[${index}]`, labelFor(key), row);
          }
        });
      } else {
        push(path, labelFor(key), item);
      }
    }
  };
  walk(value, "", 0);
  return fields;
}

function jsonTitle(value: Record<string, unknown>) {
  const ok = value.ok ?? value.success;
  return ok === true ? "Action terminée" : ok === false ? "Action en échec" : "Résultat";
}

function markdownBody(text: string): { body: string; emphasis: NotificationEmphasis[] } | null {
  if (!/\*\*[^*\n]+\*\*/.test(text)) return null;
  const emphasis: NotificationEmphasis[] = [];
  let body = "";
  let last = 0;
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    body += text.slice(last, match.index);
    const start = body.length;
    body += match[1];
    emphasis.push({ start, end: body.length });
    last = (match.index || 0) + match[0].length;
  }
  body += text.slice(last);
  return { body, emphasis };
}

function keyValueFields(text: string): NotificationField[] | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const fields: NotificationField[] = [];
  for (const line of lines) {
    const match = /^([\p{L}_][\p{L}\p{N}_ .-]{0,40}?)\s*[:=]\s*(.+)$/u.exec(line);
    if (!match) return null;
    if (fields.length < MAX_FIELDS) {
      const key = match[1].trim();
      fields.push({ key, label: labelFor(key.replace(/\s+/g, "_")), value: clip(match[2], MAX_VALUE_CHARS) });
    }
  }
  return fields;
}

function firstSentence(text: string) {
  const sentence = (/^(.+?[.!?…])(\s|$)/u.exec(text)?.[1] || text).replace(/\s+/g, " ");
  return clip(sentence, MAX_TITLE_CHARS);
}

/** null when there is nothing to show (empty or interrupted voice result). */
export function structuredNotification(raw: string | undefined | null, request?: string): StructuredNotification | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const requestTitle = request ? clip(String(request).replace(/\s+/g, " "), MAX_TITLE_CHARS) : "";
  const base = { version: 1 as const, rawFallback: "result" as const };
  if (text.length <= MAX_INPUT_CHARS && text.startsWith("{")) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const fields = jsonFields(value);
        const title = jsonTitle(value);
        return { ...base, format: "json", title: requestTitle || title, body: title, fields };
      }
    } catch {}
  }
  const md = markdownBody(text);
  if (md) return { ...base, format: "markdown", title: requestTitle || firstSentence(md.body), body: md.body, fields: [], emphasis: md.emphasis };
  const kv = keyValueFields(text);
  if (kv) return { ...base, format: "key_value", title: requestTitle || "Résultat", body: "", fields: kv };
  return { ...base, format: "plain", title: requestTitle || firstSentence(text), body: text, fields: [] };
}

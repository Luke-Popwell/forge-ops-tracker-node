import { createHash } from "node:crypto";

/**
 * Strict privacy (Configuration#strictPrivacy): for apps that can't let personal or health data
 * leave their own servers. Only structured facts about an error are sent (its class, its stack
 * frames, release, environment, server, which route it happened in, timings and counts), never
 * free text that could carry a name, an email or a diagnosis: no message, breadcrumbs, endpoint,
 * SQL statement, source context, or user email/username, and only the context/tag keys listed in
 * Configuration#privacyAllowedFields. Ported from the server's own app/services/strict_privacy.rb,
 * which applies the same rules again on arrival; sdks/strict_privacy_vectors.json pins the results
 * both have to agree on.
 *
 * Errors still group without their message: message_fingerprint is a one-way hash of the message
 * with its numbers and ids taken out, computed here, in this process.
 */

export const FINGERPRINT_LENGTH = 32;

// ASCII "word" characters only, spelled out rather than \w so no engine's own idea of a word
// changes the result: the same in every SDK and on the server.
const HEX_OBJECT_ID = /0x[0-9a-fA-F]{4,}/g;
const UUID = /(?<![A-Za-z0-9_])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![A-Za-z0-9_])/g;
const NUMBER = /(?<![A-Za-z0-9_])[0-9]+(?![A-Za-z0-9_])/g;

// Free text, never sent; context, tags and user are rebuilt from what's allowed.
const DROPPED_EVENT_FIELDS = ["message", "breadcrumbs", "sql_statement", "endpoint", "context", "tags", "user"];
const SOURCE_CONTEXT_FIELDS = ["context_line", "pre_context", "post_context"];

// Span data that's structure, not content: the masked statement and which database it ran on.
const SPAN_DATA_KEYS = ["db.statement", "db.system"];
const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;
// A route parameter segment: ":id", "{id}", "<int:id>", "[slug]" or "*path" ([^\n] rather than "."
// so the match is the server's exactly).
const ROUTE_PARAMETER = /^(?::[^\n]+|\{[^\n]+\}|<[^\n]+>|\[[^\n]+\]|\*[^\n]*)$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const PORT = /:[0-9]+$/;

/**
 * The message with hex object ids, UUIDs and standalone numbers replaced, in that order.
 * @param {unknown} message
 * @returns {string}
 */
export function normalizeMessage(message) {
  return String(message ?? "")
    .replace(HEX_OBJECT_ID, "0x")
    .replace(UUID, "<uuid>")
    .replace(NUMBER, "<n>");
}

/**
 * First 32 hex characters of the SHA-256 of the normalized message's UTF-8 bytes.
 * @param {unknown} message
 * @returns {string}
 */
export function messageFingerprint(message) {
  return createHash("sha256").update(normalizeMessage(message), "utf8").digest("hex").slice(0, FINGERPRINT_LENGTH);
}

/**
 * An error event's payload, reduced to what strict privacy keeps. `fingerprint` is computed from
 * the message as it would otherwise have been sent (after PII scrubbing, when that's on).
 *
 * @param {Record<string, unknown>} payload
 * @param {string} fingerprint
 * @param {string[]} allowedFields
 * @returns {Record<string, unknown>}
 */
export function event(payload, fingerprint, allowedFields) {
  const { context, tags, user, backtrace } = payload;
  const result = { ...payload, message_fingerprint: fingerprint };
  if (typeof payload.transaction_name === "string" && payload.transaction_name !== "") {
    result.transaction_name = spanName(payload.transaction_name);
  }
  for (const key of DROPPED_EVENT_FIELDS) {
    delete result[key];
  }
  result.backtrace = (backtrace ?? []).map((frame) => {
    const kept = { ...frame };
    for (const key of SOURCE_CONTEXT_FIELDS) {
      delete kept[key];
    }
    return kept;
  });
  const allowedContext = allowed(context, allowedFields);
  if (allowedContext) {
    result.context = allowedContext;
  }
  const allowedTags = allowed(tags, allowedFields);
  if (allowedTags) {
    result.tags = allowedTags;
  }
  const userId = user?.id;
  if (userId !== undefined && userId !== null && userId !== false && String(userId).trim() !== "") {
    result.user = { id: String(userId) };
  }
  return result;
}

/**
 * A trace's span: an outbound call's name keeps its method and host, never its path or query, and
 * its data keeps only the masked statement and the database system.
 * @param {Record<string, unknown>} span
 * @returns {Record<string, unknown>}
 */
export function span(span) {
  const { data, ...rest } = span;
  const result = { ...rest, name: spanName(span.name) };
  const kept = {};
  for (const key of SPAN_DATA_KEYS) {
    if (data && data[key] !== undefined && data[key] !== null) {
      kept[key] = data[key];
    }
  }
  if (Object.keys(kept).length > 0) {
    result.data = kept;
  }
  return result;
}

/**
 * "GET https://api.example.com/patients/42?x=1" or "GET api.example.com/patients/42" becomes
 * "GET api.example.com"; a method and a path ("GET /patients/42/notes") or a bare path
 * ("/patients/jane-doe") goes through strictPath: "GET /patients/:path", "/patients/:path", while a
 * route template ("GET /patients/:id") is kept. A name that isn't a call or a path
 * ("OrdersController#create", "patients#show") is kept. Also how a transaction name is reduced.
 */
export function spanName(name) {
  const text = String(name ?? "");
  if (text.startsWith("/")) {
    return strictPath(text);
  }
  const match = HTTP_METHOD.exec(text);
  if (!match) {
    return name;
  }
  const method = match[1].toUpperCase();
  const target = match[2];
  if (target.startsWith("/")) {
    return `${method} ${strictPath(target)}`;
  }
  return `${method} ${hostOf(target) ?? strictPath(target)}`;
}

/**
 * A request or page path under strict privacy, with no query or fragment. A route template
 * ("/patients/:id/notes", "/patients/{id}", "users/<int:id>/", "/files/*path", "/posts/[slug]") is
 * kept as it is: its words are a developer's, and its parameters are already placeholders. A raw
 * path keeps only its first segment, and the rest becomes ":path": "/patients/jane-doe/12" is
 * "/patients/:path", since anything after the first segment could name a person and no rule can
 * tell a name from a word. A first segment that holds a digit or is over 40 characters is ":id".
 */
export function strictPath(path) {
  const text = String(path ?? "").split(/[?#]/)[0];
  if (text.split("/").some((segment) => ROUTE_PARAMETER.test(segment))) {
    return text;
  }
  const leading = text.startsWith("/") ? "/" : "";
  const segments = text.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    return "/";
  }
  const first = /[0-9]/.test(segments[0]) || [...segments[0]].length > 40 ? ":id" : segments[0];
  return `${leading}${first}${segments.length > 1 ? "/:path" : ""}`;
}

// The host of an outbound call's address, read by hand rather than with a URL parser (one that
// rejects an odd address must never lead to the whole address being sent): whatever comes before
// the first "/", "?" or "#", without a scheme, port, or credentials (up to the last "@": a password
// can hold one, a host never does). It's a host when the address had a scheme or a port, or the
// name has a dot or is "localhost"; otherwise (a relative path) null.
function hostOf(target) {
  const hadScheme = SCHEME.test(target);
  const authority = target.replace(SCHEME, "").split(/[/?#]/)[0].replace(/^.*@/, "");
  const hadPort = PORT.test(authority);
  const host = authority.replace(PORT, "");
  if (host === "") {
    return null;
  }
  return hadScheme || hadPort || host.includes(".") || host.toLowerCase() === "localhost" ? host : null;
}

function allowed(fields, allowedFields) {
  if (!fields || typeof fields !== "object" || !allowedFields || allowedFields.length === 0) {
    return null;
  }
  const kept = {};
  for (const key of allowedFields) {
    if (!Object.hasOwn(fields, key)) {
      continue;
    }
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      kept[key] = value;
    }
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * FORGE_OPS_STRICT_PRIVACY's value as a boolean: "true", "1", "yes" or "on" (any case) turn it on.
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function envFlag(value) {
  return /^(true|1|yes|on)$/i.test(String(value ?? "").trim());
}

/**
 * FORGE_OPS_PRIVACY_ALLOWED_FIELDS's comma separated names, trimmed, blanks dropped.
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function envList(value) {
  return String(value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

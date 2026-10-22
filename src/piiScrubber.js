/**
 * Redacts likely-sensitive content out of a payload before it ever leaves
 * this process: the same patterns ForgeOps itself applies again on
 * arrival (defense in depth: this layer keeps the data off the wire and
 * out of any request logging in between; the server-side layer is what
 * actually protects the database, and doesn't depend on every reporting
 * app running an up-to-date version of this client). Ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/pii_scrubber.rb: kept
 * standalone and dependency-free here for the same reason as the Ruby
 * original: this has to work in any host app regardless of what's
 * reporting into it.
 *
 * Can be turned off via Configuration#scrubPii = false for a host app
 * that already scrubs its own data before it ever reaches exception
 * context, or that has its own reasons to want the raw payload. Off by
 * default is not an option: the safe default has to be "on."
 */

export const REDACTED = "[FILTERED]";

const SENSITIVE_KEYS = new Set([
  "password", "passwd", "pwd",
  "secret", "apisecret", "clientsecret", "secretkey",
  "token", "accesstoken", "refreshtoken", "apikey", "apitoken", "authorization", "authtoken", "bearer",
  "sessiontoken", "csrftoken",
  "creditcard", "cardnumber", "cardnum", "cvv", "cvv2", "cvc",
  "ssn", "socialsecuritynumber", "socialsecurity",
  "privatekey",
]);

const PATTERNS = [
  ["EMAIL", /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g],
  ["SSN", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["CREDIT CARD", /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/g],
  ["BEARER TOKEN", /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi],
  ["JWT", /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["AWS KEY", /\bAKIA[0-9A-Z]{16}\b/g],
  ["STRIPE KEY", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g],
  ["GITHUB TOKEN", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
];

/**
 * @param {unknown} value
 * @param {string | null} [key]
 * @returns {unknown}
 */
export function scrub(value, key = null) {
  if (isSensitiveKey(key) && value !== null && value !== undefined) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, key));
  }

  if (value !== null && typeof value === "object") {
    const scrubbed = {};
    for (const [k, v] of Object.entries(value)) {
      scrubbed[k] = scrub(v, k);
    }
    return scrubbed;
  }

  if (typeof value === "string") {
    return scrubString(value);
  }

  return value;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function scrubString(text) {
  let result = text;
  for (const [label, pattern] of PATTERNS) {
    result = result.replace(pattern, `[${label} FILTERED]`);
  }
  return result;
}

/** @param {string | null} key */
function isSensitiveKey(key) {
  if (!key) {
    return false;
  }
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const sensitive of SENSITIVE_KEYS) {
    if (normalized.includes(sensitive)) {
      return true;
    }
  }
  return false;
}

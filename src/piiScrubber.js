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
  "iban", "accountnumber", "routingnumber", "bankaccount",
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

// Card numbers in any other shape, and IBANs: see sdks/PII_SCRUBBING.md, which every SDK follows,
// and sdks/pii_scrubbing_vectors.json (a copy is in test/fixtures), which pins the results.
const DIGIT_RUN = /(?<![A-Za-z0-9_])\d(?:[ -]?\d)*(?![A-Za-z0-9_])/g;
const CARD_PREFIXES = /^(?:4|5[1-5]|2(?:22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)|3[47]|6011|64[4-9]|65|35(?:2[89]|[3-8]\d)|36|30[0-5]|62)/;
const IBAN = /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/g;

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
  // IBANs first: a spaced IBAN's middle groups look like a formatted card number.
  let result = text.replace(IBAN, (candidate) => (isIban(candidate) ? "[IBAN FILTERED]" : candidate));
  for (const [label, pattern] of PATTERNS) {
    result = result.replace(pattern, `[${label} FILTERED]`);
  }
  return result.replace(DIGIT_RUN, (run) => scrubCardNumbersIn(run));
}

/**
 * From each group of the run on, the longest stretch of whole groups that is a card number is
 * replaced, so a card followed by its CVV, two cards in a row, and Amex's 4-6-5 are all found.
 *
 * @param {string} run
 * @returns {string}
 */
function scrubCardNumbersIn(run) {
  const parts = run.split(/([ -])/);
  const digits = parts.filter((_, index) => index % 2 === 0);
  const separators = parts.filter((_, index) => index % 2 === 1);
  let out = "";
  let i = 0;
  while (i < digits.length) {
    let j = digits.length - 1;
    while (j >= i && !isCardNumber(digits.slice(i, j + 1).join(""))) {
      j -= 1;
    }
    if (j >= i) {
      out += "[CREDIT CARD FILTERED]" + (separators[j] ?? "");
      i = j + 1;
    } else {
      out += digits[i] + (separators[i] ?? "");
      i += 1;
    }
  }
  return out;
}

/** @param {string} digits */
function isCardNumber(digits) {
  return digits.length >= 13 && digits.length <= 19 && CARD_PREFIXES.test(digits) && luhn(digits);
}

/** @param {string} digits */
function luhn(digits) {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let value = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
  }
  return sum % 10 === 0;
}

/**
 * The IBAN check, a digit at a time: the first four characters moved to the end, letters as two
 * digits (A is 10), and the remainder by 97 is 1.
 *
 * @param {string} candidate
 */
function isIban(candidate) {
  const compact = candidate.replaceAll(" ", "");
  if (compact.length < 15 || compact.length > 34) {
    return false;
  }
  let remainder = 0;
  for (const char of compact.slice(4) + compact.slice(0, 4)) {
    const asDigits = char >= "A" && char <= "Z" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of asDigits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
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

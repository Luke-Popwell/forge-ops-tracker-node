import { randomBytes } from "node:crypto";

/**
 * Reads and writes the W3C Trace Context `traceparent` header
 * (https://www.w3.org/TR/trace-context/), the vendor-neutral format for carrying one trace across
 * service boundaries: `00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>`. Used in both
 * directions: the Express/Fastify integrations parse an incoming one so a request continues the
 * caller's trace instead of starting its own, and httpTracing.js builds an outgoing one so the next
 * service along continues this request's. Ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/trace_parent.rb.
 *
 * Deliberately strict on the way in, the same posture the spec itself asks receivers to take: a
 * malformed value, uppercase hex, the reserved version "ff", or an all-zero trace/parent id are all
 * treated as "no usable header at all" (parseTraceparent returns null and the request starts a
 * fresh trace), never half-trusted. A version this client doesn't know yet is still accepted as
 * long as its first four fields have version 00's shape, which is exactly what the spec says a
 * version-00 parser should do with a future version; version 00 itself must have exactly four
 * fields.
 */

export const TRACEPARENT_HEADER = "traceparent";

const PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/s;
const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_PARENT_ID = "0".repeat(16);

// Always "01" (sampled) on the way out: this client decides whether to actually send a trace only
// once the request is over (see _finishSpanTrace in index.js), long after this header has already
// gone out on an outbound call, so there's no honest earlier answer to give than "this may be
// recorded." A downstream service is free to make its own decision either way.
const SAMPLED_FLAGS = "01";

/**
 * @param {unknown} value an incoming header's raw value
 * @returns {{ traceId: string, parentSpanId: string } | null} null for anything that isn't a usable header
 */
export function parseTraceparent(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  const [, version, traceId, parentSpanId, , rest] = match;
  if (version === "ff" || (version === "00" && rest !== undefined)) {
    return null;
  }
  if (traceId === INVALID_TRACE_ID || parentSpanId === INVALID_PARENT_ID) {
    return null;
  }
  return { traceId, parentSpanId };
}

/**
 * @param {string} traceId
 * @param {string} spanId
 * @returns {string}
 */
export function buildTraceparent(traceId, spanId) {
  return `00-${traceId}-${spanId}-${SAMPLED_FLAGS}`;
}

/**
 * 32 lowercase hex characters, the W3C trace-id format, never all zeros (the spec reserves that as
 * invalid, and a receiver drops the whole header over it): vanishingly unlikely from 16 random
 * bytes, but free to rule out.
 * @returns {string}
 */
export function generateTraceId() {
  return randomId(16);
}

/**
 * 16 lowercase hex characters, the W3C parent-id (span id) format, never all zeros.
 * @returns {string}
 */
export function generateSpanId() {
  return randomId(8);
}

function randomId(bytes) {
  let id = randomBytes(bytes).toString("hex");
  while (/^0+$/.test(id)) {
    id = randomBytes(bytes).toString("hex");
  }
  return id;
}

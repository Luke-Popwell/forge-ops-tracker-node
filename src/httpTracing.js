import http from "node:http";
import https from "node:https";
import { generateSpanId, TRACEPARENT_HEADER } from "./traceParent.js";

let installed = false;
let originalHttpRequest = null;
let originalHttpsRequest = null;

/**
 * Wraps Node's own http/https request() exactly once for the life of the process (idempotent, see
 * the installed guard below): most third-party HTTP clients (axios, node-fetch, undici's own
 * legacy adapter, ...) ultimately call through one of these two functions, so wrapping here
 * covers those as a side effect without a separate integration per library, the same reasoning
 * gems/forge_ops_tracker's own Net::HTTP.prepend(Timing) documents for Ruby's own HTTP ecosystem.
 * Known, honest gap this shares with that Ruby wrapper's own module-prepend approach: code that
 * destructures `request` off `http`/`https` (or otherwise captures a reference) *before*
 * installHttpTracing runs keeps calling the original, unwrapped function; calling init() before
 * any other library gets required, the normal way an app entry point is written anyway, avoids
 * this in practice.
 *
 * recordSpan is passed in as a plain parameter rather than imported directly from index.js: this
 * module gets installed FROM index.js's own init(), so importing index.js back from here would
 * create a circular module dependency index.js has never needed before, for no real benefit over
 * just passing the functions actually used.
 *
 * Also propagates the current request's trace to the service being called, as a W3C `traceparent`
 * header (see traceParent.js, and Configuration#propagateTraces/tracePropagationTargets for turning
 * it off or narrowing it to specific hosts). The header's parent id is this outbound call's own
 * span id, generated before the call is made (the span itself can only be recorded afterward, once
 * its duration is known) and then recorded with that exact id, so the downstream service's root
 * span points at a span that really exists in this trace. traceparentFor decides whether there is
 * a trace to continue at all (only inside a request) and returns null otherwise.
 *
 * @param {(name: string, kind: string, startedAt: Date, durationMs: number, data?: Record<string, unknown>, spanId?: string) => void} recordSpan
 * @param {(host: string, port: number | string | null | undefined, protocol: string, spanId: string) => string | null} [traceparentFor]
 */
export function installHttpTracing(recordSpan, traceparentFor = () => null) {
  if (installed) {
    return;
  }
  installed = true;
  originalHttpRequest = http.request;
  originalHttpsRequest = https.request;
  http.request = wrap(originalHttpRequest, recordSpan, traceparentFor, "http:");
  https.request = wrap(originalHttpsRequest, recordSpan, traceparentFor, "https:");
}

/** @internal test-only: restores http/https.request exactly as installHttpTracing found them. */
export function _uninstallHttpTracing() {
  if (!installed) {
    return;
  }
  http.request = originalHttpRequest;
  https.request = originalHttpsRequest;
  installed = false;
  originalHttpRequest = null;
  originalHttpsRequest = null;
}

function wrap(originalRequest, recordSpan, traceparentFor, defaultProtocol) {
  return function patchedRequest(...args) {
    const spanId = generateSpanId();
    const startedAt = new Date();
    const start = performance.now();
    const req = originalRequest.apply(this, args);
    const { method, host, port, protocol } = describeRequest(args, defaultProtocol);
    propagateTrace(req, () => traceparentFor(host, port, protocol, spanId));

    // "response" and "error" are mutually exclusive on a real ClientRequest, but guarded anyway:
    // recording twice for the same outbound call would double it up in the waterfall.
    let finished = false;
    const finish = (status) => {
      if (finished) {
        return;
      }
      finished = true;
      recordSpan(`${method} ${host}`, "http", startedAt, performance.now() - start, status === undefined ? {} : { status }, spanId);
    };

    // No status at all means the request itself failed (DNS, connection refused, timeout) before
    // any response ever came back: recorded regardless, an honest "this dependency call never
    // completed" span rather than silently dropping it.
    req.once("response", (res) => finish(res.statusCode));
    req.once("error", () => finish());

    return req;
  };
}

/**
 * Adds the traceparent header to a request that was just created and hasn't sent its headers yet
 * (the caller only writes or ends it after http.request returns). Leaves a traceparent the caller
 * already set alone: whoever set it explicitly knows better than this client which trace the call
 * belongs to. Skipped when headers were already flushed (a raw-array `headers` option sends them at
 * construction). Never throws, since a failure to add a header must never stop the host app's own
 * request from going out.
 *
 * @param {import("node:http").ClientRequest} req
 * @param {() => string | null} traceparent
 */
function propagateTrace(req, traceparent) {
  try {
    if (req.headersSent || req.hasHeader(TRACEPARENT_HEADER)) {
      return;
    }
    const value = traceparent();
    if (value !== null) {
      req.setHeader(TRACEPARENT_HEADER, value);
    }
  } catch {
    // See this function's own comment: the request goes out without the header.
  }
}

/**
 * Best-effort parse of whatever calling convention produced this request (a bare options object,
 * a URL string/object plus an optional options object, either form optionally followed by a
 * callback): only ever used to build a low-cardinality "<METHOD> <host>" label, never to read the
 * path or query string a customer's own request carries (that could hold a customer's own id or
 * a secret), the same reasoning every other transaction_name/span name in this client already
 * follows.
 *
 * port/protocol are only ever used to recognize this client's own deliveries to ForgeOps (see
 * Configuration#isOwnHost), never in a label.
 * @param {unknown[]} args
 * @param {string} defaultProtocol
 */
function describeRequest(args, defaultProtocol) {
  const [first, second] = args;
  const options = {};

  if (typeof first === "string" || first instanceof URL) {
    const url = typeof first === "string" ? new URL(first) : first;
    options.host = url.hostname;
    options.port = url.port;
    options.protocol = url.protocol;
    if (second && typeof second === "object") {
      Object.assign(options, second);
    }
  } else if (first && typeof first === "object") {
    Object.assign(options, first);
  }

  const method = String(options.method ?? "GET").toUpperCase();
  const host = options.host ?? options.hostname ?? "unknown";
  return { method, host, port: options.port, protocol: options.protocol ?? defaultProtocol };
}

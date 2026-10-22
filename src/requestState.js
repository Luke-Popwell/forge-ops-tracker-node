import { generateTraceId, parseTraceparent } from "./traceParent.js";

/**
 * Everything this client knows about the current request that isn't already owned by one of the
 * older, single-purpose AsyncLocalStorage instances (the user, the breadcrumb trail, the span
 * buffer): which trace it belongs to, which remote span called it (if any), what it's called, and
 * whether it errored. One instance per request, published by the Express/Fastify integrations
 * (see _runWithRequestState in index.js) so captureException, the tracing integration, and the
 * outbound-HTTP wrapper can all reach it. Ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/request_state.rb.
 *
 * The traceId exists for every request, not only when trackTracing is on: it's also what an error
 * event carries so ForgeOps can link it to errors reported by other services taking part in the
 * same trace, which works on any plan and with tracing off entirely.
 *
 * Also stashed on the framework's own request object (see requestStateFor), the Node equivalent of
 * the Ruby gem memoizing it in the Rack env: an error-handling middleware that runs outside the
 * tracing middleware's async context still finds the same instance there.
 */
export class RequestState {
  traceId;
  parentSpanId;
  errored = false;
  #describe;
  #transactionName = null;
  #endpoint = null;

  /**
   * @param {{ traceId?: string, parentSpanId?: string | null }} [ids]
   */
  constructor({ traceId = generateTraceId(), parentSpanId = null } = {}) {
    this.traceId = traceId;
    this.parentSpanId = parentSpanId;
  }

  /**
   * Continues the caller's trace when the request arrived with a usable W3C traceparent header,
   * remembering the caller's span as this request's remote parent; starts a fresh trace otherwise.
   * @param {unknown} traceparent
   */
  static fromTraceparent(traceparent) {
    const incoming = parseTraceparent(traceparent);
    return incoming === null ? new RequestState() : new RequestState(incoming);
  }

  /**
   * How to name this request, read lazily, each time an error needs it: Express only sets req.route
   * once the matched route's own handler starts running, with no app-level hook in between, so the
   * integration hands over a function that reads it then instead of a name it can't know yet at
   * request start. Returns null (and the event leaves both fields out) until a route has matched.
   * @param {() => { transactionName: string, endpoint: string } | null} describe
   */
  describeWith(describe) {
    this.#describe = describe;
  }

  /**
   * Sets both names outright, for a framework that already knows the matched route when the
   * request starts (Fastify's onRequest).
   * @param {string} transactionName
   * @param {string} endpoint
   */
  setRoute(transactionName, endpoint) {
    this.#transactionName = transactionName;
    this.#endpoint = endpoint;
  }

  /** @returns {string | null} */
  get transactionName() {
    return this.#transactionName ?? this.#described()?.transactionName ?? null;
  }

  /** @returns {string | null} */
  get endpoint() {
    return this.#endpoint ?? this.#described()?.endpoint ?? null;
  }

  markErrored() {
    this.errored = true;
  }

  #described() {
    try {
      return this.#describe?.() ?? null;
    } catch {
      return null;
    }
  }
}

const REQUEST_STATE_KEY = Symbol.for("forge-ops-tracker.requestState");

/**
 * The RequestState memoized on `request` (an Express req or a Fastify request), created from its
 * traceparent header on first use: whichever integration reaches a request first creates it, and
 * every other one gets the identical instance back, so they all agree on one trace id. A symbol
 * key, not a plain property: invisible to the app's own enumeration and serialization of req.
 *
 * @param {object} request
 * @param {unknown} traceparent the incoming traceparent header's raw value
 * @returns {RequestState}
 */
export function requestStateFor(request, traceparent) {
  if (request[REQUEST_STATE_KEY] === undefined) {
    request[REQUEST_STATE_KEY] = RequestState.fromTraceparent(traceparent);
  }
  return request[REQUEST_STATE_KEY];
}

/**
 * The RequestState already memoized on `request`, if any integration created one.
 * @param {object} request
 * @returns {RequestState | undefined}
 */
export function existingRequestState(request) {
  return request?.[REQUEST_STATE_KEY];
}

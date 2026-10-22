import { generateSpanId, generateTraceId } from "./traceParent.js";

/**
 * A short, unique-enough identifier for one span: a W3C span id (16 lowercase hex characters,
 * never all zeros; see traceParent.js), the same id a traceparent header's parent-id carries. The
 * server only ever needs these to be unique within one trace's own array (see
 * Api::V1::SpansController on the Rails side), never a real database id, so this is deliberately
 * cheap rather than a full UUID.
 * @returns {string}
 */
export function randomSpanId() {
  return generateSpanId();
}

/**
 * Accumulates one request's own nested call tree in-process: the tracing analog to
 * BreadcrumbBuffer's per-request trail. Ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/span_buffer.rb, with one deliberate departure: the
 * Ruby buffer tracks "what's currently open" with a single mutable stack, which is correct for
 * Ruby's own single-threaded-per-request execution model, but is the wrong tool here. A customer
 * can easily await two service-layer span() calls concurrently in the same request (Promise.all
 * rather than one after another); popping one call's own span off a shared stack while the other
 * is still pending would leave the second one mis-parented under the first instead of under the
 * request's own root. index.js's own span()/leaf-span recording instead tracks "the currently
 * open span" with a second, nested AsyncLocalStorage (see spanParentStorage there): each
 * concurrent branch gets its own correctly-scoped view automatically, the exact property that
 * storage exists to provide. This class only ever holds what doesn't depend on that: the trace's
 * own identifiers and the flat list every span, root or leaf, ends up recorded into.
 */
export class SpanBuffer {
  #configuration;
  traceId;
  rootSpanId;
  spans = [];
  #rootDurationMs = null;
  #remoteParentSpanId;

  /**
   * traceId/parentSpanId come from the request's own state (see _runWithRequestState in index.js)
   * when there is one, never generated separately here, so a trace this sends and an error event
   * from the same request always agree on which trace they belong to. parentSpanId is the calling
   * service's span (from an incoming traceparent header), recorded as the root span's parent: the
   * server treats a parent that isn't in this trace's own batch as remote, and nests this
   * service's root under the caller's outgoing HTTP span.
   *
   * @param {import("./configuration.js").Configuration} configuration
   * @param {{ traceId?: string, parentSpanId?: string | null }} [ids]
   */
  constructor(configuration, { traceId = generateTraceId(), parentSpanId = null } = {}) {
    this.#configuration = configuration;
    this.traceId = traceId;
    this.rootSpanId = randomSpanId();
    this.#remoteParentSpanId = parentSpanId;
  }

  /**
   * root: true only for the one call that records the request's own root span: forces
   * parent_span_id to the remote parent (null unless the request arrived with a traceparent
   * header) explicitly, the same reasoning span_buffer.rb's own #record documents for why that
   * can't just be read off of "whatever's currently open" for the root specifically.
   *
   * @param {{
   *   spanId: string,
   *   parentSpanId?: string | null,
   *   name: string,
   *   kind: string,
   *   startedAt: Date,
   *   durationMs: number,
   *   data?: Record<string, unknown>,
   *   root?: boolean,
   * }} span
   */
  record({ spanId, parentSpanId = null, name, kind, startedAt, durationMs, data = {}, root = false }) {
    this.spans.push({
      span_id: spanId,
      parent_span_id: root ? this.#remoteParentSpanId : parentSpanId,
      name,
      kind,
      // Date#toISOString() already yields millisecond precision UTC ("...sssZ"), exactly the wire
      // format the server expects; unlike BreadcrumbBuffer's own timestamp, this one must NOT
      // strip milliseconds, since a waterfall's own ordering depends on them.
      started_at: startedAt.toISOString(),
      duration_ms: durationMs,
      environment: this.#configuration.environment,
      release: this.#configuration.release,
      data,
    });
    if (root) {
      this.#rootDurationMs = durationMs;
    }
  }

  /**
   * Whether the request's own root span has been recorded: an errored request's trace is only sent
   * once it has, since spans with no root to hang from would render as a waterfall with no top.
   * @returns {boolean}
   */
  get rootRecorded() {
    return this.#rootDurationMs !== null;
  }

  /**
   * null (never sent) until the root span has actually been recorded: a request whose own
   * tracing integration never got the chance to call back at all has no duration to compare
   * against a threshold, so it's never mistakenly treated as slow.
   * @param {number} thresholdMs
   * @returns {boolean}
   */
  isSlow(thresholdMs) {
    return this.#rootDurationMs !== null && this.#rootDurationMs >= thresholdMs;
  }
}

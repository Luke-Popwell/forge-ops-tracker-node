import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import { inspect } from "node:util";
import { BreadcrumbBuffer } from "./breadcrumbBuffer.js";
import { buildChange, buildSnapshot } from "./changes.js";
import { Client } from "./client.js";
import { Configuration } from "./configuration.js";
import { installDatabaseTracing, instrumentPg as instrumentPgModule, _uninstallDatabaseTracing } from "./databaseTracing.js";
import { DeliveryQueue } from "./deliveryQueue.js";
import { EventBuilder } from "./eventBuilder.js";
import { installHttpTracing, _uninstallHttpTracing } from "./httpTracing.js";
import { MetricBuffer } from "./metricBuffer.js";
import { PerformanceFlusher } from "./performanceFlusher.js";
import { installRedisTracing, instrumentIoredis as instrumentIoredisClass, _uninstallRedisTracing } from "./redisTracing.js";
import { Reporter } from "./reporter.js";
import { requestStateFor } from "./requestState.js";
import { SessionFlusher } from "./sessionFlusher.js";
import { randomSpanId, SpanBuffer } from "./spanBuffer.js";
import { mask as maskSql } from "./sqlStatement.js";
import { span as strictSpan } from "./strictPrivacy.js";
import { buildTraceparent } from "./traceParent.js";

export { Configuration };
export { withSql } from "./sqlStatement.js";

let configuration = null;
let reporter = null;
let errorQueue = null;
let sessionFlusher = null;
let performanceFlusher = null;
let spanQueue = null;
let changeQueue = null;
let changeSnapshotStarted = false;
let metricBuffer = null;
let infrastructureMetricBuffer = null;
let processHandlersInstalled = false;
let uncaughtExceptionMonitorListener = null;
let uncaughtExceptionListener = null;
let unhandledRejectionListener = null;
let crashing = false;
let disabledEnvironmentWarned = false;

/** How long flush() waits by default, and how long an uncaught exception waits before the process exits. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

// Request-scoped affected-user storage. AsyncLocalStorage, not a plain module-level variable the
// way gems/forge_ops_tracker uses Thread.current or Python uses threading.local: Node is
// single-threaded, so a plain variable would leak across concurrent requests being interleaved
// on the same event loop, exactly the bug those other languages' own thread-local choice avoids
// for their own concurrency model. AsyncLocalStorage is the Node-idiomatic equivalent, but its
// API shape is different on purpose: it only propagates a value through an async call chain that
// was explicitly wrapped via runWithUser() below (there's no imperative "just set it from
// anywhere" the way Thread.current allows), which is why this SDK's own set_user-equivalent is a
// wrapping function, not a bare setter.
const userStorage = new AsyncLocalStorage();

// Request-scoped breadcrumb trail storage. A second, independent AsyncLocalStorage instance
// rather than folding this into userStorage above: distinct concern (an ordered trail, not a
// single attached value), same "own storage, own wrapping function" shape
// gems/forge_ops_tracker's own Thread.current[:forge_ops_tracker_breadcrumbs] (separate from
// Thread.current[:forge_ops_tracker_current_user]) and Python's own separate _breadcrumbs
// ContextVar (separate from its threading.local .user) both already take.
//
// Unlike Ruby's Thread.current and Python's contextvars.ContextVar, AsyncLocalStorage.run()
// needs no explicit "clear it when the request ends" step (see BreadcrumbContext's own
// ensure-clear, or _end_breadcrumb_trail's own reset()): once the callback passed to run()
// finishes (synchronously or, for everything causally descended from it, asynchronously), the
// store automatically stops being visible to anything outside that call chain, exactly the
// property AsyncLocalStorage exists to provide. That's why _runWithBreadcrumbTrail below is a
// single wrapping call, the same shape runWithUser already has, rather than a separate
// start/end pair the way Ruby's middleware or Python's Django/Flask/Celery hooks need (those
// frameworks fire two genuinely separate hooks, "request started" and "request ended," with no
// single function this client could wrap around the whole thing; Express's next()-based
// middleware chain and a real Fastify onRequest hook wrapping its own `done` callback both do
// give this client that single continuous call chain to wrap, confirmed directly below, not
// assumed).
const breadcrumbStorage = new AsyncLocalStorage();

// Request-scoped span-tracing storage: one SpanBuffer per request (see spanBuffer.js), the same
// per-request AsyncLocalStorage scoping breadcrumbStorage already uses above and for the identical
// reason (Node interleaves many concurrent requests' async callbacks on one thread, so anything
// less than AsyncLocalStorage would leak one request's spans into another's).
const spanStorage = new AsyncLocalStorage();

// A second, nested AsyncLocalStorage tracks "the currently open span" (a span_id, not a whole
// object) separately from the buffer itself: span() below and every leaf-span recorder read this
// to find their own real parent, and span() enters a fresh nested context around its own callback
// to make itself the parent for anything recorded further inside. This is deliberately NOT a
// mutable stack on SpanBuffer the way gems/forge_ops_tracker's own Ruby buffer uses (correct for
// Ruby's single-threaded-per-request execution, wrong here): two span() calls awaited
// concurrently in the same request (Promise.all rather than one after another) each get their own,
// correctly-scoped view of "what's currently open" for free, the exact property nested
// AsyncLocalStorage.run() calls already provide, rather than one call's pop() corrupting the
// other's still-pending parent. Defaults to the request's own root span id once _runWithSpanTrace
// below establishes it; genuinely unset outside of that (span()/_recordSpan both treat "no
// SpanBuffer at all" as the real signal for "not inside a traced request").
const spanParentStorage = new AsyncLocalStorage();

// Request-scoped RequestState (trace id, remote parent span id, transaction name, endpoint, errored
// flag; see requestState.js), published by the Express/Fastify integrations for the duration of a
// request through _runWithRequestState below. Not gated on trackTracing: the trace id links an
// error to errors in other services even when no spans are ever recorded. Unset outside a request,
// where captureException, span tracing, and the outbound-HTTP wrapper all behave exactly as they
// did before this existed.
const requestStorage = new AsyncLocalStorage();

function getConfiguration() {
  if (configuration === null) {
    configuration = new Configuration();
  }
  return configuration;
}

function getReporter() {
  if (reporter === null) {
    const config = getConfiguration();
    const client = new Client(config);
    errorQueue = new DeliveryQueue(config, client);
    reporter = new Reporter(config, new EventBuilder(config), errorQueue);
  }
  return reporter;
}

function getSessionFlusher() {
  if (sessionFlusher === null) {
    const config = getConfiguration();
    sessionFlusher = new SessionFlusher(config, new Client(config));
  }
  return sessionFlusher;
}

function getPerformanceFlusher() {
  if (performanceFlusher === null) {
    const config = getConfiguration();
    performanceFlusher = new PerformanceFlusher(config, new Client(config));
  }
  return performanceFlusher;
}

/** The two metric buffers, created together on first use: independent of each other (a script may only ever call one), but cheap enough that creating both is simpler than tracking which. */
function getMetricBuffers() {
  if (metricBuffer === null) {
    const config = getConfiguration();
    const client = new Client(config);
    metricBuffer = new MetricBuffer(config, (entries) => client.deliverMetrics(entries), () => config.metricFlushIntervalMs);
    infrastructureMetricBuffer = new MetricBuffer(
      config,
      (entries) => client.deliverInfrastructureMetrics(entries),
      () => config.infrastructureMetricFlushIntervalMs,
    );
  }
  return { metrics: metricBuffer, infrastructure: infrastructureMetricBuffer };
}

/**
 * Records a named business metric (a signup, a payment, anything you want to name), buffered and
 * flushed periodically as one batch rather than one network call per capture. `value` defaults to
 * 1 so a bare counter-style call needs no argument; pass one for a real magnitude
 * (`captureMetric("payment", 49)`); it may be negative (a refund). A no-op when the client isn't
 * enabled (no DSN, or this environment isn't in `enabledEnvironments`), and a NaN or infinite value
 * is dropped.
 *
 * @param {string} name
 * @param {number} [value]
 */
export function captureMetric(name, value = 1) {
  const config = getConfiguration();
  if (!config.isEnabled()) {
    return;
  }
  getMetricBuffers().metrics.record({ metric_name: name, value, environment: config.environment, release: config.release });
}

/**
 * Records one infrastructure reading (CPU, memory, disk, anything else a script of yours reads)
 * from one of your own hosts. `hostname` defaults to `Configuration#serverName`, so a script running
 * on the box it reports about needs no argument. Same buffered-batch delivery and no-op-when-disabled
 * contract as captureMetric. A short-lived cron script needs nothing more: the buffer also flushes
 * when the event loop drains ("beforeExit"); call `await flushMetrics()` if it exits another way
 * (`process.exit()`).
 *
 * @param {string} name
 * @param {number} value
 * @param {{ hostname?: string }} [options]
 */
export function captureInfrastructureMetric(name, value, options = {}) {
  const config = getConfiguration();
  if (!config.isEnabled()) {
    return;
  }
  getMetricBuffers().infrastructure.record({ metric_name: name, value, hostname: options.hostname ?? config.serverName });
}

/** Delivers every buffered metric and infrastructure reading right now, instead of waiting for the next flush interval. */
export async function flushMetrics() {
  if (metricBuffer === null) {
    return;
  }
  await Promise.all([metricBuffer.flush(), infrastructureMetricBuffer.flush()]);
}

function getChangeQueue() {
  if (changeQueue === null) {
    const config = getConfiguration();
    changeQueue = new DeliveryQueue(config, new Client(config), { deliverMethod: "deliverChange", label: "change" });
  }
  return changeQueue;
}

/**
 * Records one thing that changed in a running system, so ForgeOps can show it next to the errors
 * and slowdowns that followed:
 *
 *     recordChange({ kind: "feature_flag", title: "Enabled new_checkout for 10%", details: { rollout: 10 } });
 *
 * `kind` is one of feature_flag, config, migration, dependency, infrastructure, or other (anything
 * else is sent as "other"). `environment` defaults to the configured one; `occurredAt` (a Date or an
 * ISO 8601 string) defaults to now; `id` is an optional idempotency key. Queued and delivered on the
 * same async loop as error events, so it never blocks the caller. A no-op when the client isn't
 * enabled. Never throws: returns false when nothing was queued.
 *
 * @param {{ kind: string, title: string, details?: Record<string, unknown>, environment?: string,
 *   service?: string, actor?: string, url?: string, id?: string, occurredAt?: Date | string }} change
 * @returns {boolean}
 */
export function recordChange(change) {
  try {
    const config = getConfiguration();
    if (!config.isEnabled()) {
      return false;
    }
    const payload = buildChange(config, change ?? {});
    if (payload === null) {
      return false;
    }
    return getChangeQueue().push(payload);
  } catch (e) {
    getConfiguration().log(`[forge-ops-tracker] recordChange failed: ${e.name}: ${e.message}`);
    return false;
  }
}

/**
 * Sends the one startup snapshot this process sends (see changes.js), on a later event-loop turn so
 * init() returns immediately and startup never waits on it. A second call is a no-op. Does nothing,
 * and doesn't use up the once, when the client isn't enabled or detectChanges is off. The timer is
 * unref'd, so a short script that's otherwise done doesn't stay alive just to send it. Never throws.
 */
function startChangeSnapshot(config) {
  if (changeSnapshotStarted || !config.isEnabled() || !config.detectChanges) {
    return false;
  }
  changeSnapshotStarted = true;

  const timer = setTimeout(async () => {
    try {
      await new Client(config).deliverChangeSnapshot(await buildSnapshot(config));
    } catch (e) {
      config.log(`[forge-ops-tracker] change snapshot failed: ${e.name}: ${e.message}`);
    }
  }, 0);
  timer.unref?.();
  return true;
}

/**
 * A DeliveryQueue reused for spans (see that class's own comment for why it takes a
 * deliverMethod/label rather than needing a whole second, near-identical class the way
 * gems/forge_ops_tracker's own SpanQueue is): one whole trace is one queue entry, delivered
 * promptly, never batched together with other traces the way PerformanceFlusher/the error
 * DeliveryQueue's own default usage batch or accumulate over a time window.
 */
function getSpanQueue() {
  if (spanQueue === null) {
    const config = getConfiguration();
    spanQueue = new DeliveryQueue(config, new Client(config), { deliverMethod: "deliverSpans", label: "trace" });
  }
  return spanQueue;
}

/**
 * Internal; called by the Express/Fastify session-tracking integrations, never by host app
 * code directly (there's nothing for a caller to decide here beyond what the middleware/hook
 * itself already observed).
 *
 * @param {boolean} crashed
 */
export function _recordSession(crashed) {
  const config = getConfiguration();
  if (!config.trackSessions || !config.isEnabled()) {
    return;
  }
  getSessionFlusher().recordSession(crashed);
}

/**
 * Internal; called by the Express performance-tracking integration, never by host app code
 * directly, same reasoning as _recordSession above.
 *
 * @param {string} transactionName
 * @param {number} durationMs
 */
export function _recordPerformance(transactionName, durationMs) {
  const config = getConfiguration();
  if (!config.trackPerformance || !config.isEnabled()) {
    return;
  }
  getPerformanceFlusher().record(transactionName, durationMs);
}

/**
 * Internal; called by the Express/Fastify breadcrumb-context integrations, never by host app
 * code directly. Gives `callback`'s own async call chain a fresh, empty breadcrumb trail to
 * accumulate into (via addBreadcrumb() below, or whatever automatic source records into it
 * alongside its own timing; see integrations/performance.js), the same per-request scoping
 * gems/forge_ops_tracker's BreadcrumbContext middleware and Python's _start_breadcrumb_trail
 * both provide for their own concurrency model. A no-op wrapper (still calls callback, just
 * with no buffer set up) when trackBreadcrumbs is off or the client isn't enabled at all, the
 * same "skip entirely" gating _recordPerformance/_recordSession already apply to their own
 * automatic sources; addBreadcrumb() below still works regardless of this, by lazily creating
 * its own standalone buffer.
 *
 * @template T
 * @param {() => T} callback
 * @returns {T}
 */
export function _runWithBreadcrumbTrail(callback) {
  const config = getConfiguration();
  if (!config.trackBreadcrumbs || config.strictPrivacy || !config.isEnabled()) {
    return callback();
  }
  return breadcrumbStorage.run(new BreadcrumbBuffer(config), callback);
}

/**
 * Internal; called by the Express/Fastify integrations with their own request object and its
 * incoming traceparent header's raw value. Returns the RequestState memoized on that request (see
 * requestState.js), continuing the incoming trace or starting a fresh one, or null when the client
 * isn't enabled at all, the same "skip entirely" gating every other automatic source applies.
 *
 * @param {object} request an Express req or a Fastify request
 * @param {unknown} traceparent
 * @returns {import("./requestState.js").RequestState | null}
 */
export function _requestStateFor(request, traceparent) {
  if (!getConfiguration().isEnabled()) {
    return null;
  }
  return requestStateFor(request, traceparent);
}

/**
 * Internal; runs callback with `state` published as the current request's for its whole async
 * call chain. Just calls callback when state is null, or already the current one (two integrations
 * wrapping the same request), so it never nests a second identical context.
 *
 * @template T
 * @param {import("./requestState.js").RequestState | null} state
 * @param {() => T} callback
 * @returns {T}
 */
export function _runWithRequestState(state, callback) {
  if (!state || requestStorage.getStore() === state) {
    return callback();
  }
  return requestStorage.run(state, callback);
}

/**
 * Internal; called by the outbound-HTTP wrapper (httpTracing.js) just before a request to
 * `host`:`port` goes out. Returns the traceparent header value naming `spanId` (that request's own
 * span) as the parent, or null when this request shouldn't carry one: outside a request, with
 * propagateTraces off or `host` not a propagation target, or for a delivery to ForgeOps itself.
 *
 * @param {string} host
 * @param {number | string | null | undefined} port
 * @param {string} protocol
 * @param {string} spanId
 * @returns {string | null}
 */
export function _traceparentFor(host, port, protocol, spanId) {
  const state = requestStorage.getStore();
  if (!state) {
    return null;
  }
  const config = getConfiguration();
  if (config.isOwnHost(host, port, protocol) || !config.propagatesTraceTo(host)) {
    return null;
  }
  return buildTraceparent(state.traceId, spanId);
}

/**
 * Internal; called by the Express/Fastify tracing integration (integrations/tracing.js), never
 * by host app code directly. Gives callback's own async call chain a fresh SpanBuffer, with its
 * own root span id already established as "currently open" in spanParentStorage (see that
 * storage's own comment above), so a leaf span or a manual span() call recorded before the root
 * span itself is ever actually recorded still parents onto it correctly. A no-op wrapper (still
 * calls callback, just with no buffer set up) when trackTracing is off or the client isn't
 * enabled at all, the same "skip entirely" gating every other automatic source in this file
 * already applies to itself.
 *
 * @template T
 * @param {() => T} callback
 * @returns {T}
 */
export function _runWithSpanTrace(callback) {
  const config = getConfiguration();
  if (!config.trackTracing || !config.isEnabled()) {
    return callback();
  }
  // The trace id and remote parent come from the request's RequestState (see _runWithRequestState
  // above), so this trace and any error event from the same request agree on the trace.
  const state = requestStorage.getStore();
  const buffer = new SpanBuffer(config, state ? { traceId: state.traceId, parentSpanId: state.parentSpanId } : {});
  return spanStorage.run(buffer, () => spanParentStorage.run(buffer.rootSpanId, callback));
}

/**
 * Internal; called by the Express/Fastify tracing integration once the request has actually
 * finished and the root span's own real total duration is finally known (not any sooner: that
 * duration is what the slow/fast decision below is actually made against). Records the request's
 * own root "controller" span, then, only now and entirely client-side, decides whether the whole
 * trace crossed configuration.traceCaptureThresholdMs and is worth sending at all: a normal, fast
 * request's buffer is simply discarded here, unsent, the entire reason this feature never costs a
 * fast request a single byte over the wire. Mirrors
 * gems/forge_ops_tracker/lib/forge_ops_tracker/middleware/span_tracing.rb's own ensure block.
 *
 * @param {string} name
 * @param {Date} startedAt
 * @param {number} durationMs
 */
export function _finishSpanTrace(name, startedAt, durationMs) {
  const buffer = spanStorage.getStore();
  if (!buffer) {
    return;
  }
  buffer.record({ spanId: buffer.rootSpanId, name, kind: "controller", startedAt, durationMs, root: true });
  // An errored request's trace is always sent too, however fast it was, since the waterfall of
  // what led up to an error is exactly what an issue page wants to show next to it. "Errored" means
  // captureException ran during the request (the Express/Fastify error integrations call it too).
  const errored = requestStorage.getStore()?.errored === true;
  if (buffer.isSlow(getConfiguration().traceCaptureThresholdMs) || (errored && buffer.rootRecorded)) {
    // Strict privacy: outbound calls named by method and host only, span data kept to the masked
    // statement and database system (see strictPrivacy.js).
    const spans = getConfiguration().strictPrivacy ? buffer.spans.map(strictSpan) : buffer.spans;
    getSpanQueue().push({ trace_id: buffer.traceId, spans });
  }
}

/**
 * Internal; called by whatever this client already automatically times end-to-end with no
 * children of its own to nest anything under (the outbound HTTP wrapper in httpTracing.js, and the
 * pg, ioredis and node-redis wrappers in databaseTracing.js and redisTracing.js), never by host
 * app code directly. A no-op, the same as every other automatic source, when there's no
 * request-level trace currently open at all (trackTracing off, or genuinely outside any request
 * the tracing integration ever wrapped): never fabricates a trace with no request to belong to.
 *
 * @param {string} name
 * @param {string} kind
 * @param {Date} startedAt
 * @param {number} durationMs
 * @param {Record<string, unknown>} [data]
 * @param {string} [spanId] only passed by the outbound-HTTP wrapper, which has to pick it before
 *   the call goes out so the traceparent header it sends names this exact span
 */
export function _recordSpan(name, kind, startedAt, durationMs, data = {}, spanId = randomSpanId()) {
  const config = getConfiguration();
  const buffer = spanStorage.getStore();
  if (!config.trackTracing || !buffer) {
    return;
  }
  const parentSpanId = spanParentStorage.getStore() ?? buffer.rootSpanId;
  buffer.record({ spanId, parentSpanId, name, kind, startedAt, durationMs, data });
}

/**
 * Internal; whether a span recorded right now would land anywhere: trackTracing is on and the
 * current async context is inside a traced request. The database and Redis wrappers check this
 * before doing any work for a query or command, so outside a trace they cost nothing beyond the
 * call itself.
 *
 * @returns {boolean}
 */
export function _isTracing() {
  return getConfiguration().trackTracing && spanStorage.getStore() !== undefined;
}

/**
 * Records a "database" span and a "query" breadcrumb for every query run through this pg module
 * (`import pg from "pg"`), for an app where init() couldn't find pg by itself: a bundled app, or
 * one whose node_modules isn't under the directory it was started from. init() already does this for the pg it can
 * find, so most apps never need to call it. Safe to call more than once.
 *
 *     import pg from "pg";
 *     forgeOpsTracker.instrumentPg(pg);
 *
 * @param {unknown} pg
 * @returns {boolean} whether it was a pg module this could patch
 */
export function instrumentPg(pg) {
  return instrumentPgModule(pg, _recordSpan, _isTracing, _recordBreadcrumb, _ensureBreadcrumbTrail);
}

/**
 * Records a "redis" span and a "redis" breadcrumb for every command sent through this ioredis
 * Redis class, for an app where init() couldn't find ioredis by itself (see instrumentPg above).
 * Safe to call more than once.
 *
 *     import Redis from "ioredis";
 *     forgeOpsTracker.instrumentIoredis(Redis);
 *
 * @param {unknown} Redis
 * @returns {boolean} whether it was an ioredis class this could patch
 */
export function instrumentIoredis(Redis) {
  return instrumentIoredisClass(Redis, _recordSpan, _isTracing, _recordBreadcrumb, _ensureBreadcrumbTrail);
}

/**
 * Internal; called by whatever this client already automatically times (the Express
 * controller/route lifecycle, see integrations/performance.js, and the pg and Redis wrappers in
 * databaseTracing.js and redisTracing.js), never by host app code directly, same reasoning as _recordPerformance above. Independent of trackPerformance: an app
 * could want the trail without the timing data, or vice versa, and each call site already has
 * to check its own flag regardless, so there's no real cost to keeping the two independent
 * rather than tying breadcrumbs to whether performance monitoring happens to be on (mirrors
 * gems/forge_ops_tracker/lib/forge_ops_tracker/railtie.rb's own reasoning for the same design
 * choice).
 *
 * @param {string} message
 * @param {string} category
 * @param {string} [level]
 * @param {Record<string, unknown>} [data]
 */
export function _recordBreadcrumb(message, category, level = "info", data = {}) {
  const config = getConfiguration();
  if (!config.trackBreadcrumbs || config.strictPrivacy || !config.isEnabled()) {
    return;
  }
  addBreadcrumb(message, { category, level, data });
}

/**
 * Internal; whether an automatic breadcrumb recorded from the current async context would be kept
 * (trackBreadcrumbs is on and the client is enabled), for the pg and Redis wrappers to check before
 * timing a query or command, the same way they check _isTracing above. When it would be and there's
 * no trail yet (a query or command outside any request), starts the same standalone trail
 * addBreadcrumb() below would, right now, from the app's own call: the breadcrumb itself is only
 * recorded once the reply arrives, from a callback bound to this context, and a trail started
 * there would never be seen again.
 *
 * @returns {boolean}
 */
export function _ensureBreadcrumbTrail() {
  const config = getConfiguration();
  if (!config.trackBreadcrumbs || config.strictPrivacy || !config.isEnabled()) {
    return false;
  }
  if (breadcrumbStorage.getStore() === undefined) {
    breadcrumbStorage.enterWith(new BreadcrumbBuffer(config));
  }
  return true;
}

/**
 * Configure the client. Call once at startup.
 *
 * @param {Partial<Configuration> & { installProcessHandlers?: boolean }} [options]
 * @returns {Configuration}
 */
export function init(options = {}) {
  const config = getConfiguration();
  const { installProcessHandlers, ...overrides } = options;

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in config)) {
      throw new TypeError(`Configuration has no property ${JSON.stringify(key)}`);
    }
    config[key] = value;
  }

  // Once per process: a DSN with an environment that isn't enabled sends nothing, which is
  // otherwise silent. No DSN, no warning, since that's a deliberate "off".
  const warning = config.disabledEnvironmentWarning();
  if (warning !== null && !disabledEnvironmentWarned) {
    disabledEnvironmentWarned = true;
    console.warn(warning);
  }

  if (installProcessHandlers ?? true) {
    installProcessLevelHandlers();
  }

  // Independent of installProcessHandlers above (that flag is only about the two process-level
  // listeners): installed unconditionally, every init() call, the same way
  // gems/forge_ops_tracker's own Railtie always applies Net::HTTP.prepend(Timing) regardless of
  // config, checking configuration.trackTracing fresh on every actual outbound call instead (see
  // _recordSpan above), never at install time.
  installHttpTracing(_recordSpan, _traceparentFor);
  // The same for database queries (pg) and Redis commands (ioredis, node-redis), for whichever of
  // those the app has installed; nothing is loaded for one it doesn't (see optionalModules.js).
  installDatabaseTracing(_recordSpan, _isTracing, _recordBreadcrumb, _ensureBreadcrumbTrail);
  installRedisTracing(_recordSpan, _isTracing, _recordBreadcrumb, _ensureBreadcrumbTrail);

  startChangeSnapshot(config);

  return config;
}

/**
 * Report an exception you've already caught. `user` defaults to whatever runWithUser() below
 * established for this async call chain, if anything; pass one explicitly to override that for
 * this one report.
 *
 * Inside a request the Express/Fastify integrations are handling, the event also carries the
 * request's transaction_name, endpoint, and trace_id, and the request's trace is sent however fast
 * it was.
 *
 * @param {Error} error
 * @param {Record<string, unknown>} [context]
 * @param {Record<string, unknown> | null} [user]
 */
export function captureException(error, context = {}, user = null) {
  const breadcrumbs = breadcrumbStorage.getStore()?.all() ?? [];
  const state = requestStorage.getStore();
  state?.markErrored();
  const request = state ? { transactionName: state.transactionName, endpoint: state.endpoint, traceId: state.traceId } : {};
  getReporter().report(error, context, user ?? userStorage.getStore()?.user ?? null, breadcrumbs, request);
}

/**
 * Adds one breadcrumb to the current request's trail (see _runWithBreadcrumbTrail above for how
 * a request gets its own buffer to start with), or, outside a request entirely (a plain script,
 * a worker with no breadcrumb-context wrapping installed at all), this call's own standalone
 * trail for the rest of the process's root async context. Lazily creates a buffer the first
 * time it's needed on whatever AsyncLocalStorage context is currently active, the same "works
 * standalone, no specific setup required" shape gems/forge_ops_tracker's own
 * ForgeOpsTracker.add_breadcrumb and Python's forge_ops_tracker.add_breadcrumb both already have.
 *
 * Uses breadcrumbStorage.enterWith() rather than .run() for that lazy-creation path
 * specifically: unlike _runWithBreadcrumbTrail above, there's no callback here to wrap (this
 * function returns void, called from arbitrary places in host app code), so .run() has nothing
 * to scope the new buffer to. enterWith() sets the store for the remainder of whatever async
 * chain is currently executing, which is exactly the "persists for the rest of this thread"
 * behavior Ruby's Thread.current[:x] ||= ... and Python's ContextVar.set() both give their own
 * manual API for free; the one deliberate difference is test isolation, see
 * _resetForTesting's own comment below for why that needs an explicit disable().
 *
 * Works whether or not trackBreadcrumbs is on: that flag only gates the automatic sources
 * _recordBreadcrumb above records, never this manual call, matching
 * gems/forge_ops_tracker's own ForgeOpsTracker.add_breadcrumb. With strictPrivacy on it does
 * nothing: breadcrumbs are free text, never sent then, so they aren't recorded either.
 *
 * @param {string} message
 * @param {{ category?: string, level?: string, data?: Record<string, unknown> }} [options]
 */
export function addBreadcrumb(message, options = {}) {
  if (getConfiguration().strictPrivacy) {
    return;
  }
  let buffer = breadcrumbStorage.getStore();
  if (buffer === undefined) {
    buffer = new BreadcrumbBuffer(getConfiguration());
    breadcrumbStorage.enterWith(buffer);
  }
  buffer.add(message, options);
}

/**
 * Runs `callback` (sync or async) with an affected user attached to every `captureException()`
 * call made anywhere in its call chain that doesn't pass its own explicit `user`, e.g. from your
 * own middleware:
 *
 *     app.use((req, res, next) => runWithUser({ id: req.user?.id }, next));
 *
 * There's no imperative `setUser()` the way other languages in this repo have: AsyncLocalStorage
 * (see this module's own comment on `userStorage`) only propagates a value through an async call
 * chain that was explicitly wrapped like this, so wrapping is the correct, idiomatic shape here,
 * not a limitation being worked around.
 *
 * @template T
 * @param {Record<string, unknown>} user
 * @param {() => T} callback
 * @returns {T}
 */
export function runWithUser(user, callback) {
  return userStorage.run({ user }, callback);
}

/**
 * Wraps a block of your own service-layer code as a manual span, e.g.
 *
 *     await forgeOpsTracker.span("PaymentService.charge", async () => { ... });
 *
 * There's no automatic way to detect "this is a logically distinct service layer" the way a
 * database query or an outbound HTTP call already has a real instrumentation hook to extend, the
 * same gap gems/forge_ops_tracker's own ForgeOpsTracker.span exists to fill. Works with a sync or
 * async callback transparently, the same way runWithUser() above does: callback's own return
 * value (or settled promise) is what this returns, with duration measured either immediately for
 * a sync callback or once its promise settles for an async one, never forcing a synchronous
 * caller through an extra microtask the way an always-`async function span` would.
 *
 * Outside any request-level trace (trackTracing off, or genuinely outside a request the
 * Express/Fastify tracing integration ever wrapped), just runs callback and records nothing:
 * unlike addBreadcrumb, this does NOT lazily create its own standalone buffer, matching
 * gems/forge_ops_tracker's own ForgeOpsTracker.span exactly, since a lone span with no
 * request-level trace around it, and no middleware left running to ever flush it, would just
 * accumulate in memory forever with nothing to ever send it, worse than not recording it at all.
 *
 * A "database" span can also carry the SQL it ran, so ForgeOps can show which query was slow:
 *
 *     await forgeOpsTracker.span("Load orders", () => pool.query(sql, [userId]), {
 *       kind: "database",
 *       statement: sql,
 *       dbSystem: "postgresql",
 *     });
 *
 * The statement is masked (every string and number replaced by "?") before it's ever stored on
 * the span, and sent as data["db.statement"], with dbSystem lowercased as data["db.system"]. Bind
 * values are never taken, and both options are ignored on any other kind of span. Queries run
 * through pg are already recorded this way on their own (see databaseTracing.js); a span wrapped
 * around one just becomes its parent.
 *
 * @template T
 * @param {string} name
 * @param {() => T} callback
 * @param {{ kind?: string, data?: Record<string, unknown>, statement?: string, dbSystem?: string }} [options]
 * @returns {T}
 */
export function span(name, callback, { kind = "service", data = {}, statement, dbSystem } = {}) {
  const buffer = spanStorage.getStore();
  if (!buffer) {
    return callback();
  }
  data = databaseSpanData(kind, data, statement, dbSystem);

  const spanId = randomSpanId();
  const parentSpanId = spanParentStorage.getStore() ?? buffer.rootSpanId;
  const startedAt = new Date();
  const start = performance.now();
  const finish = () => {
    buffer.record({ spanId, parentSpanId, name, kind, startedAt, durationMs: performance.now() - start, data });
  };

  try {
    const result = spanParentStorage.run(spanId, callback);
    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          finish();
          return value;
        },
        (error) => {
          finish();
          throw error;
        },
      );
    }
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

/**
 * The data a span is recorded with: unchanged unless it's a database span, which gets the masked
 * statement as "db.statement" and the lowercased database name as "db.system". A "db.statement"
 * passed in `data` directly is masked as well, so the raw SQL can't reach the payload either way,
 * and masked for whichever system the span names (dbSystem, or a "db.system" in `data`).
 * @param {string} kind
 * @param {Record<string, unknown>} data
 * @param {string | undefined} statement
 * @param {string | undefined} dbSystem
 * @returns {Record<string, unknown>}
 */
function databaseSpanData(kind, data, statement, dbSystem) {
  if (kind !== "database") {
    return data;
  }
  const result = { ...data };
  if (typeof dbSystem === "string" && dbSystem.trim() !== "") {
    result["db.system"] = dbSystem.trim().toLowerCase();
  }
  // The system matters to the masking: MySQL and MariaDB "double quoted" text is a value.
  const system = typeof result["db.system"] === "string" ? result["db.system"].trim() : null;
  const masked = maskSql(typeof statement === "string" ? statement : result["db.statement"], system);
  if (masked === null) {
    delete result["db.statement"];
  } else {
    result["db.statement"] = masked;
  }
  return result;
}

/**
 * Sends everything this client has queued or buffered (error events, traces, recorded changes,
 * metrics, session and performance aggregates) and resolves once it has all been delivered or
 * timeoutMs has passed, whichever comes first. Resolves true when everything went out in time,
 * false when the timeout cut it short. Never rejects.
 *
 * Delivery is asynchronous, so anything captured just before `process.exit()` is lost unless the
 * process waits for it:
 *
 *     captureException(error);
 *     await flush();
 *     process.exit(1);
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS) {
  const log = (e) => getConfiguration().log(`[forge-ops-tracker] flush error: ${e?.name}: ${e?.message}`);
  const pending = [
    errorQueue?.whenIdle(),
    spanQueue?.whenIdle(),
    changeQueue?.whenIdle(),
    metricBuffer?.flush(),
    infrastructureMetricBuffer?.flush(),
    sessionFlusher?.flush(),
    performanceFlusher?.flush(),
  ]
    .filter((promise) => promise !== undefined)
    .map((promise) => promise.catch(log));
  if (pending.length === 0) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    // A referenced timer, not an unref'd one: an uncaught exception's exit (see
    // installProcessLevelHandlers) waits on this promise, and must still happen even when nothing
    // else is left to keep the event loop alive.
    const timer = setTimeout(() => resolve(false), Math.max(0, Number(timeoutMs) || 0));
    Promise.all(pending).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** The value of a Node flag that takes one (`--flag=value` or `--flag value`), last one winning. */
function flagValue(args, name) {
  let value = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      value = args[i + 1] ?? null;
    } else if (args[i].startsWith(`${name}=`)) {
      value = args[i].slice(name.length + 1);
    }
  }
  return value;
}

function nodeOptions() {
  return (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Which --unhandled-rejections mode this process runs under: command line flags win over
 * NODE_OPTIONS, the same precedence Node itself applies, and "throw" is Node's default.
 */
function unhandledRejectionsMode() {
  const name = "--unhandled-rejections";
  return flagValue(process.execArgv, name) ?? flagValue(nodeOptions(), name) ?? "throw";
}

function abortsOnUncaughtException() {
  const name = "--abort-on-uncaught-exception";
  return process.execArgv.includes(name) || nodeOptions().includes(name);
}

/** The same error Node itself raises for a promise rejected with something that isn't an Error. */
function unhandledRejectionError(reason) {
  const error = new Error(
    "This error originated either by throwing inside of an async function without a catch block, " +
      "or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason " +
      `"${inspect(reason)}".`,
  );
  error.name = "UnhandledPromiseRejection";
  error.code = "ERR_UNHANDLED_REJECTION";
  return error;
}

/**
 * Reports anything that would otherwise crash the process outright (a plain script, an unhandled
 * promise rejection) with no further wiring: the same "unhandled needs no wiring" case the
 * Express/Fastify integrations cover for web requests. Three listeners, each for its own reason:
 *
 * - "uncaughtExceptionMonitor" captures the error. It fires for every uncaught exception, whether
 *   or not the app handles them itself, and never changes what Node does afterward.
 *
 * - "uncaughtException" gives that error time to be delivered. Node exits as soon as the monitor
 *   listeners return, long before an asynchronous delivery could finish, so a crash was never sent.
 *   When this is the only "uncaughtException" listener (the app has none of its own), it waits for
 *   flush(), bounded at DEFAULT_FLUSH_TIMEOUT_MS, then prints the error to stderr and exits with
 *   code 1, as Node would have. When the app has its own listener it does nothing at all: the app
 *   decides what happens next. Not installed under --abort-on-uncaught-exception, so that flag
 *   still aborts and leaves its core dump.
 *
 * - "unhandledRejection" reports a rejection the app handles in an "unhandledRejection" listener
 *   of its own. Any listener here stops Node from crashing on its own under the default
 *   --unhandled-rejections=throw, so when this is the only one, it raises the rejection as an
 *   uncaught exception itself (reported, delivered and exited on through the two listeners above),
 *   keeping the crash the app would have had without this client.
 *
 * This does *not* catch a web request's unhandled exception under Express/Fastify: both catch that
 * themselves, long before it would ever reach here, which is what those integrations are for.
 */
function installProcessLevelHandlers() {
  if (processHandlersInstalled) {
    return;
  }
  processHandlersInstalled = true;

  uncaughtExceptionMonitorListener = (error) => {
    captureException(error);
  };

  uncaughtExceptionListener = (error) => {
    if (crashing || process.listenerCount("uncaughtException") > 1) {
      return;
    }
    crashing = true;
    flush(DEFAULT_FLUSH_TIMEOUT_MS).then(() => {
      // writeSync: process.stderr is asynchronous for pipes on macOS, and process.exit() would cut
      // it off.
      try {
        writeSync(2, `${inspect(error)}\n\nNode.js ${process.version}\n`);
      } catch {
        // Nowhere left to report it.
      }
      process.exit(1);
    });
  };

  unhandledRejectionListener = (reason) => {
    const mode = unhandledRejectionsMode();
    if (mode === "strict") {
      // Node already raised it as an uncaught exception, which the monitor reported, before this.
      return;
    }
    const error = reason instanceof Error ? reason : unhandledRejectionError(reason);
    const onlyListener = process.listenerCount("unhandledRejection") === 1;
    if (mode === "throw" && onlyListener) {
      throw error;
    }
    captureException(error);
    if (mode === "warn-with-error-code" && onlyListener) {
      process.exitCode = 1;
    }
  };

  process.on("uncaughtExceptionMonitor", uncaughtExceptionMonitorListener);
  if (!abortsOnUncaughtException()) {
    process.on("uncaughtException", uncaughtExceptionListener);
  }
  process.on("unhandledRejection", unhandledRejectionListener);
}

/**
 * @internal not part of the public API: resets module state between test cases. The startup change
 * snapshot is left marked as already sent, so the many tests that init() an enabled client and
 * count fetch calls don't see an extra one; pass { changeSnapshot: true } to let the next init()
 * send it (see test/changes.test.js).
 */
export function _resetForTesting({ changeSnapshot = false } = {}) {
  if (uncaughtExceptionMonitorListener) {
    process.off("uncaughtExceptionMonitor", uncaughtExceptionMonitorListener);
  }
  if (uncaughtExceptionListener) {
    process.off("uncaughtException", uncaughtExceptionListener);
  }
  if (unhandledRejectionListener) {
    process.off("unhandledRejection", unhandledRejectionListener);
  }
  configuration = null;
  reporter = null;
  errorQueue = null;
  sessionFlusher = null;
  performanceFlusher = null;
  spanQueue = null;
  changeQueue = null;
  changeSnapshotStarted = !changeSnapshot;
  metricBuffer?.discard();
  infrastructureMetricBuffer?.discard();
  metricBuffer = null;
  infrastructureMetricBuffer = null;
  processHandlersInstalled = false;
  crashing = false;
  disabledEnvironmentWarned = false;
  uncaughtExceptionMonitorListener = null;
  uncaughtExceptionListener = null;
  unhandledRejectionListener = null;
  // disable(), not just leaving it alone: a test that calls addBreadcrumb() standalone (outside
  // any _runWithBreadcrumbTrail wrapping, exercising the lazy-creation path on purpose) sets the
  // store via enterWith() on whatever async context Node's test runner happens to be executing
  // tests from, which, unlike a scoped run() call, has no natural point where it unwinds on its
  // own. Without this, that leftover store could otherwise bleed into a later, unrelated test
  // sharing the same root context. disable() drops it and leaves the instance perfectly usable
  // again for the next run()/enterWith() call, confirmed directly, not assumed.
  breadcrumbStorage.disable();
  requestStorage.disable();
  // Re-installed fresh on the very next init() call in whatever test runs next: without this,
  // http.request/https.request would stay wrapped by a closure over a *previous* test's own
  // _recordSpan reference forever (installHttpTracing's own guard only ever installs once per
  // process otherwise), which happens to still work correctly here since _recordSpan itself reads
  // module state fresh on every call rather than closing over anything test-specific, but relying
  // on that instead of actually restoring the original functions would be fragile, not a genuine
  // guarantee.
  _uninstallHttpTracing();
  _uninstallDatabaseTracing();
  _uninstallRedisTracing();
}

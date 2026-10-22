import { _finishSpanTrace, _requestStateFor, _runWithRequestState, _runWithSpanTrace } from "../index.js";

/**
 * How an Express request is named once a route has matched: transactionName the same
 * "<HTTP method> <route pattern>" the root span and performance samples use, endpoint the same
 * route pattern. req.route.path is the pattern as declared on the router that matched it; for a
 * router mounted with app.use("/api", router), that's the part declared on the router, without
 * "/api": req.baseUrl is the literal matched mount path, which for a parameterized mount
 * ("/users/:userId") would put a real id into a field that must never carry one. null before a
 * route has matched (the event then leaves both fields out).
 *
 * @param {import("express").Request} req
 */
export function describeExpressRoute(req) {
  if (!req.route) {
    return null;
  }
  const name = `${req.method} ${req.route.path}`;
  return { transactionName: name, endpoint: name };
}

/**
 * Express distributed-tracing middleware: wraps the rest of the request in _runWithSpanTrace
 * (see that function's own comment in index.js), the same "own file, own registration point"
 * shape breadcrumbContext.js already established for a genuinely distinct concern (this is
 * separate from, and independent of, error capture, session tracking, and aggregate performance
 * timing). Register wherever is convenient relative to routes, the same as
 * forgeOpsTrackerPerformanceExpressMiddleware, since it only reads req.route once the request has
 * already been routed, inside the "finish" listener below, not at request-start:
 *
 *   app.use(forgeOpsTrackerTracingExpressMiddleware);
 *
 * transactionName is built exactly like forgeOpsTrackerPerformanceExpressMiddleware's own
 * ("<HTTP method> <route pattern>", never the raw URL): this is the same request a performance
 * sample would already be recorded for, so a trace's own root span name has to match, not invent
 * a second naming scheme for the same thing.
 *
 * The actual send-or-don't decision happens inside _finishSpanTrace, only once the response has
 * actually finished and the root span's real total duration is known: nothing about a normal,
 * fast request costs a single byte over the wire, matching gems/forge_ops_tracker's own
 * Middleware::SpanTracing.
 *
 * Also publishes this request's RequestState (see requestState.js) whether or not trackTracing is
 * on, so every request gets a trace id, continuing an incoming W3C traceparent header when there
 * is one (its root span's parent is then the caller's span), and an error captured anywhere in
 * the request carries it plus the matched route. Register it before your routes for that: an
 * error thrown by a route registered ahead of it never sees this request's trace. Express only
 * sets req.route once the matched handler starts, so the route is read lazily, whenever an error
 * needs it (see RequestState#describeWith).
 */
export function forgeOpsTrackerTracingExpressMiddleware(req, res, next) {
  const state = _requestStateFor(req, req.headers?.traceparent);
  state?.describeWith(() => describeExpressRoute(req));

  _runWithRequestState(state, () =>
    _runWithSpanTrace(() => {
      const startedAt = new Date();
      const start = performance.now();

      res.on("finish", () => {
        const durationMs = performance.now() - start;
        const transactionName = `${req.method} ${req.route?.path ?? req.path}`;
        _finishSpanTrace(transactionName, startedAt, durationMs);
      });

      next();
    }),
  );
}

/**
 * Fastify equivalent, added as two separate hooks rather than one function wrapping "the rest of
 * this request" the way Express's next() allows (see
 * registerForgeOpsTrackerBreadcrumbContext's own comment in breadcrumbContext.js for why Fastify
 * needs this shape at all): onRequest establishes the span trace (wrapping `done`, the same
 * pattern that file already uses) and stashes this request's own start time on `request` itself,
 * the same "flag stashed on the request object" convention integrations/express.js's own
 * req._forgeOpsSessionCrashed already established; onResponse, Fastify's own dedicated
 * "the response has actually been sent" hook, reads that back once the real total duration is
 * known:
 *
 *   registerForgeOpsTrackerTracing(app); // alongside registerForgeOpsTrackerBreadcrumbContext
 *
 * transactionName reads request.routeOptions.url, Fastify's own matched route pattern (the
 * property that replaced the older, now-removed request.routerPath), falling back to routerPath
 * for an older Fastify version and finally to the literal request.url for a request that never
 * matched a route at all (a 404), the same "pattern first, literal path as the 404 fallback"
 * shape the Express integration above already takes.
 *
 * Also publishes this request's RequestState (see requestState.js) whether or not trackTracing is
 * on, the same as the Express middleware above: a trace id for every request, continuing an
 * incoming W3C traceparent header. Fastify has already matched the route by onRequest, so the
 * transaction name and endpoint are set right here, before any handler runs, and only from the
 * matched pattern: a request that matched no route (a 404) leaves both out.
 *
 * @param {import("fastify").FastifyInstance} fastify
 */
export function registerForgeOpsTrackerTracing(fastify) {
  fastify.addHook("onRequest", (request, reply, done) => {
    const state = _requestStateFor(request, request.headers?.traceparent);
    const route = fastifyRoutePattern(request);
    if (state && route) {
      state.setRoute(`${request.method} ${route}`, `${request.method} ${route}`);
    }

    _runWithRequestState(state, () =>
      _runWithSpanTrace(() => {
        request._forgeOpsSpanStartedAt = new Date();
        request._forgeOpsSpanStart = performance.now();
        done();
      }),
    );
  });

  fastify.addHook("onResponse", async (request) => {
    if (request._forgeOpsSpanStart === undefined) {
      // trackTracing was off (or the client wasn't enabled) when onRequest ran above, so there's
      // nothing to finish; _finishSpanTrace would no-op anyway (no buffer to read back), but
      // there's no point computing a duration for nothing.
      return;
    }
    const durationMs = performance.now() - request._forgeOpsSpanStart;
    const transactionName = `${request.method} ${request.routeOptions?.url ?? request.routerPath ?? request.url}`;
    _finishSpanTrace(transactionName, request._forgeOpsSpanStartedAt, durationMs);
  });
}

/**
 * Fastify's matched route pattern ("/orders/:id", prefixes included), or undefined for a request
 * that matched no route: request.routeOptions.url, falling back to the older request.routerPath.
 *
 * @param {import("fastify").FastifyRequest} request
 * @returns {string | undefined}
 */
export function fastifyRoutePattern(request) {
  return request.routeOptions?.url ?? request.routerPath ?? undefined;
}

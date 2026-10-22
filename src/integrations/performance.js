import { _recordBreadcrumb, _recordPerformance } from "../index.js";

/**
 * Express performance-tracking middleware. Register wherever is convenient relative to routes
 * (unlike sessionTracking.js's own middleware, this doesn't need to run first: it only reads
 * req.route once the request has already been routed, inside the "finish" listener below, not
 * at request-start), but after forgeOpsTrackerBreadcrumbContextExpressMiddleware (see
 * integrations/breadcrumbContext.js), so the breadcrumb recorded below has a trail to land in:
 *
 *   app.use(forgeOpsTrackerPerformanceExpressMiddleware);
 *
 * Times every request (performance.now() before next(), diffed inside res.on("finish")) so a
 * dashboard widget on ForgeOps can show which parts of your app are actually slow, not just
 * which ones raise. A separate, independent middleware from both the error and session-tracking
 * ones, same "several genuinely independent mechanisms" reasoning sessionTracking.js's own
 * comment documents.
 *
 * transactionName is "<HTTP method> <route pattern>", e.g. "GET /users/:id", not the raw URL:
 * req.route.path is Express's own matched route pattern, read here (after routing has actually
 * happened, unlike at request-start where it isn't populated yet), which keeps a distinct user
 * id from exploding into its own separate transaction the way the literal URL would: the
 * low-cardinality equivalent of a Rails controller#action. Falls back to req.path (the literal,
 * unmatched path) for a request that never matched a route at all (a 404).
 *
 * The same res.on("finish") listener also records a "controller" breadcrumb, gated on
 * trackBreadcrumbs independently of trackPerformance (each call below checks its own flag,
 * mirroring gems/forge_ops_tracker/lib/forge_ops_tracker/railtie.rb's own
 * process_action.action_controller subscription, which records both a performance sample and a
 * breadcrumb from the one event): an app could want the trail without the timing data, or vice
 * versa. The pg query and Redis command wrappers (databaseTracing.js, redisTracing.js) are the
 * only other automatic breadcrumb sources, and they need no middleware: a query or command outside
 * any request lands in the standalone trail addBreadcrumb() would start. The controller breadcrumb
 * itself still needs this middleware installed, whether or not the app also wants the performance
 * data.
 *
 * Deliberately recorded with the request's final status already known (from the same
 * res.on("finish") firing this middleware already needed for timing), the same "recorded once
 * the response actually finished" shape as Ruby's/Python's own automatic controller breadcrumb;
 * see those implementations' own documented gap (a breadcrumb recorded this late can never show
 * up on that exact same request's own error, only a later one on the same connection/process
 * could see it) for why that's an accepted trade-off, not an oversight here either.
 */
export function forgeOpsTrackerPerformanceExpressMiddleware(req, res, next) {
  const start = performance.now();

  res.on("finish", () => {
    const durationMs = performance.now() - start;
    const transactionName = `${req.method} ${req.route?.path ?? req.path}`;
    _recordPerformance(transactionName, durationMs);
    _recordBreadcrumb(transactionName, "controller", res.statusCode >= 500 ? "error" : "info", {
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 10) / 10,
    });
  });

  next();
}

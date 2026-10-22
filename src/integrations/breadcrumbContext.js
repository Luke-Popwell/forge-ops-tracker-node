import { _runWithBreadcrumbTrail } from "../index.js";

/**
 * Gives every request a fresh, empty breadcrumb trail to accumulate into (via
 * addBreadcrumb(), or whatever automatic source records into it alongside its own timing; see
 * integrations/performance.js), so one request's trail never bleeds into another's, the same
 * concern gems/forge_ops_tracker's own Middleware::BreadcrumbContext and Python's
 * _start_breadcrumb_trail/_end_breadcrumb_trail both solve for their own concurrency model. A
 * sibling to the session-tracking/user-context/performance integrations below, not folded into
 * any of them: distinct concern, same "own file, own registration point" shape every integration
 * in this client already takes.
 *
 * Register FIRST, before forgeOpsTrackerUserContextMiddleware and
 * forgeOpsTrackerPerformanceExpressMiddleware (and, for the same reason, before
 * forgeOpsTrackerSessionTrackingExpressMiddleware too): every one of those can record a
 * breadcrumb of its own or run host app code that calls addBreadcrumb(), so the trail has to
 * already exist by the time any of them runs, exactly why gems/forge_ops_tracker's own
 * initializer ordering comment documents the identical requirement for its Rack middleware.
 *
 *   app.use(forgeOpsTrackerBreadcrumbContextExpressMiddleware); // first, before everything else
 *   app.use(forgeOpsTrackerSessionTrackingExpressMiddleware);
 *   app.use(forgeOpsTrackerPerformanceExpressMiddleware);
 *   app.use(forgeOpsTrackerUserContextMiddleware);
 *   // ...routes...
 *   app.use(forgeOpsTrackerExpressMiddleware); // still last, after all routes
 *
 * Wraps `next` in _runWithBreadcrumbTrail (see that function's own doc comment in index.js for
 * why this needs no explicit "clear" step the way Ruby's ensure or Python's finally do): confirmed
 * directly, with a real Express app and a real async route handler, that a breadcrumb recorded
 * from deep inside an awaited route handler (or from the performance middleware's own
 * res.on("finish") listener, which fires later still) is visible to
 * forgeOpsTrackerExpressMiddleware's own captureException() call at the end of the same request,
 * the same "AsyncLocalStorage survives all the way through, not just synchronously" property
 * forgeOpsTrackerUserContextMiddleware's own comment already confirms for the user-context case.
 */
export function forgeOpsTrackerBreadcrumbContextExpressMiddleware(req, res, next) {
  _runWithBreadcrumbTrail(next);
}

/**
 * Fastify equivalent, added as an onRequest hook (Fastify's earliest request-lifecycle hook,
 * firing before routing and before any other hook this client registers) rather than exported as
 * a plain function to call directly, mirroring registerForgeOpsTracker in integrations/fastify.js:
 *
 *   registerForgeOpsTrackerBreadcrumbContext(app); // first, before registerForgeOpsTracker
 *
 * A real design question Ruby's/Python's implementations don't answer for Node, since Fastify has
 * no single function this client could wrap the way Express's next() or Ruby's app.call(env) both
 * let a middleware wrap "the rest of this request" in one call: Fastify's request lifecycle is a
 * sequence of independently-invoked hooks instead. The fix is _runWithBreadcrumbTrail(done): an
 * onRequest hook declared with the callback-style (request, reply, done) signature, wrapping done
 * itself (Fastify's own continuation, which advances to the next hook/handler) in
 * AsyncLocalStorage.run(). Node's async_hooks propagate context by causality, not by lexical
 * nesting, so the context established here is visible to everything Fastify goes on to invoke as
 * a consequence of calling done(): the route handler, and (should it throw) the onError hook this
 * client's own integrations/fastify.js registers. Confirmed directly against a real Fastify app,
 * a real async route handler, and two genuinely concurrent, interleaved requests (one slower than
 * the other, so their event-loop turns actually interleave, not just run back-to-back): each
 * request's own trail stayed correctly isolated from the other's, and each one's onError hook saw
 * only its own request's breadcrumbs, never the other's, exactly the property AsyncLocalStorage
 * exists to provide and exactly what needed confirming for a hook-based framework rather than
 * assuming it carries over unchanged from the Express case above.
 *
 * @param {import("fastify").FastifyInstance} fastify
 */
export function registerForgeOpsTrackerBreadcrumbContext(fastify) {
  fastify.addHook("onRequest", (request, reply, done) => {
    _runWithBreadcrumbTrail(done);
  });
}

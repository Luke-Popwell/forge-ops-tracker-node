import { _recordSession } from "../index.js";

/**
 * Express session-tracking middleware. Register FIRST, before any routes:
 *
 *   app.use(forgeOpsTrackerSessionTrackingExpressMiddleware);
 *   // ...routes...
 *   app.use(forgeOpsTrackerExpressMiddleware); // still last, per its own doc comment
 *
 * Counts every request as a session (crash-free unless an unhandled exception actually
 * affected it) toward the crash-free rate on a project's Releases page. A separate,
 * independent middleware from forgeOpsTrackerExpressMiddleware, not layered onto it, since
 * session tracking runs regardless of whether error reporting is even configured, mirroring
 * gems/forge_ops_tracker's own split between its Rack middleware (sessions) and its
 * Rails.error hook (errors), two genuinely independent mechanisms.
 *
 * Express has no single call that wraps a whole request/response cycle the way Rack's
 * app.call(env) does, so "crashed" is read from two signals rather than one: the response's
 * own final status code (>= 500, Express's own default for an unhandled error even with no
 * error-handling middleware installed at all), and a request-scoped flag that
 * forgeOpsTrackerExpressMiddleware sets before it does anything else, for the case a host app
 * has its own custom error handler that responds with something other than a plain 500. Either
 * signal alone would work when both middlewares are installed; checking both means session
 * tracking still works correctly even when the error-reporting middleware isn't.
 */
export function forgeOpsTrackerSessionTrackingExpressMiddleware(req, res, next) {
  req._forgeOpsSessionCrashed = false;
  res.on("finish", () => {
    _recordSession(req._forgeOpsSessionCrashed || res.statusCode >= 500);
  });
  next();
}

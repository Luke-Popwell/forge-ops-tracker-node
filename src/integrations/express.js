import { _requestStateFor, _runWithRequestState, captureException, runWithUser } from "../index.js";
import { describeExpressRoute } from "./tracing.js";

/**
 * Express error-handling middleware. Register last, after all routes:
 *
 *   app.use(forgeOpsTrackerExpressMiddleware);
 *
 * Reports, then calls next(err) so Express's own error handling (a
 * custom error handler registered after this one, or its default 500
 * response) continues exactly as if this middleware weren't there.
 * Express 5 forwards both synchronous throws and rejected promises from
 * async route handlers to error-handling middleware automatically,
 * verified directly against a real async handler, not assumed. Only an
 * exception your own code catches and handles is invisible to this.
 *
 * The event carries the request's trace id, transaction name, and
 * endpoint: the RequestState forgeOpsTrackerTracingExpressMiddleware
 * already stashed on req when that's installed, or one created here from
 * the request's own traceparent header when it isn't, so an unhandled
 * error is linked across services either way.
 */
export function forgeOpsTrackerExpressMiddleware(err, req, res, next) {
  // See integrations/sessionTracking.js's own comment: marks the request crashed before
  // anything else, so its res.on("finish") listener (which fires later, once this or
  // whatever error handling runs after it actually sends a response) already sees this by
  // the time it checks.
  req._forgeOpsSessionCrashed = true;

  const state = _requestStateFor(req, req.headers?.traceparent);
  state?.describeWith(() => describeExpressRoute(req));
  _runWithRequestState(state, () =>
    captureException(err, {
      path: req.path,
      method: req.method,
    }),
  );
  next(err);
}

/**
 * Automatically identifies the affected user for every error reported for the rest of this
 * request, when `req.user` is present. Register early, before your routes (and after whatever
 * middleware actually sets `req.user`, e.g. Passport's own session middleware):
 *
 *     app.use(passport.session());
 *     app.use(forgeOpsTrackerUserContextMiddleware);
 *     // ...routes...
 *     app.use(forgeOpsTrackerExpressMiddleware);
 *
 * `req.user` is Passport's own convention (the closest thing Express has to a single dominant
 * auth library, the same role Warden plays for Rails): set once `passport.authenticate()`/session
 * deserialization succeeds, left `undefined` otherwise, so a plain truthy check is enough, the
 * same duck-typed "is there a user object at all" check `gems/forge_ops_tracker`'s own Warden
 * integration does for `env["warden"].user`. A no-op for an app that never set `req.user` at all,
 * whether that's because nobody's signed in or Passport (or an equivalent) isn't installed.
 *
 * Wraps the rest of the request in `runWithUser()` (see that function's own doc comment for why
 * this SDK has no imperative `setUser()`) rather than setting anything imperatively itself:
 * confirmed directly, with a real Express app and a real async route handler, that
 * `AsyncLocalStorage`'s context set by an early middleware like this one does survive all the way
 * through to a later error-handling middleware (`forgeOpsTrackerExpressMiddleware`, typically
 * registered last, after every route) in the same request, not just to handlers registered
 * synchronously right after this one.
 */
export function forgeOpsTrackerUserContextMiddleware(req, res, next) {
  if (!req.user) {
    next();
    return;
  }
  runWithUser(serializeUser(req.user), next);
}

function serializeUser(user) {
  const result = {};
  if (user.id !== undefined && user.id !== null) {
    result.id = String(user.id);
  }
  if (user.email) {
    result.email = user.email;
  }
  if (user.username) {
    result.username = user.username;
  } else if (user.name) {
    result.username = user.name;
  }
  return result;
}

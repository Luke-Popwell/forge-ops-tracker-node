import { _requestStateFor, _runWithRequestState, captureException } from "../index.js";
import { fastifyRoutePattern } from "./tracing.js";

/**
 * Called directly with your Fastify instance: not registered via
 * app.register(), which would create a new encapsulation scope and
 * require the fastify-plugin package to break out of it:
 *
 *   registerForgeOpsTracker(app);
 *
 * Adds an onError hook, which fires for any error Fastify's own
 * lifecycle would otherwise handle: both synchronous throws and
 * rejected promises in async handlers, verified directly against a real
 * async handler, not assumed. Doesn't set the reply itself, so Fastify's
 * own error handling (setErrorHandler, or its default response)
 * continues exactly as if this hook weren't registered. Only an
 * exception your own code catches and handles is invisible to this.
 *
 * The event carries the request's trace id, transaction name, and
 * endpoint: the RequestState registerForgeOpsTrackerTracing already
 * created for this request when that's registered, or one created here
 * from the request's own traceparent header when it isn't.
 *
 * @param {import("fastify").FastifyInstance} fastify
 */
export function registerForgeOpsTracker(fastify) {
  fastify.addHook("onError", async (request, reply, error) => {
    const state = _requestStateFor(request, request.headers?.traceparent);
    const route = fastifyRoutePattern(request);
    if (state && route && state.transactionName === null) {
      state.setRoute(`${request.method} ${route}`, `${request.method} ${route}`);
    }
    _runWithRequestState(state, () =>
      captureException(error, {
        path: request.url,
        method: request.method,
      }),
    );
  });
}

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import express from "express";
import * as forgeOpsTracker from "../../src/index.js";
import { forgeOpsTrackerBreadcrumbContextExpressMiddleware } from "../../src/integrations/breadcrumbContext.js";
import { forgeOpsTrackerPerformanceExpressMiddleware } from "../../src/integrations/performance.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgeOpsTracker._resetForTesting();
});

function fakeFetch(requests) {
  return async (uri, init) => {
    if (String(uri).includes("tracker.example.com")) {
      requests.push({ uri: String(uri), init });
      return new Response(null, { status: 202 });
    }
    return originalFetch(uri, init);
  };
}

async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, port: server.address().port };
}

async function waitForSample(requests) {
  const deadline = Date.now() + 1000;
  let sample = null;
  while (Date.now() < deadline && !sample) {
    sample = requests.find((r) => r.uri.endsWith("/api/v1/performance_samples"));
    if (!sample) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return sample;
}

test("times a request against a parameterized route, using the route pattern (not the raw URL) as the transaction name", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    performanceFlushIntervalMs: 20,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerPerformanceExpressMiddleware);
  app.get("/users/:id", (req, res) => res.send("ok"));

  const { server, port } = await startServer(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/users/42`);
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }

  const sample = await waitForSample(requests);
  assert.ok(sample, "expected a performance sample to be delivered");
  const payload = JSON.parse(sample.init.body);
  assert.equal(payload.samples.length, 1);
  // The route pattern, not "GET /users/42": a distinct user id must not explode into its own
  // separate transaction the way the literal URL would.
  assert.equal(payload.samples[0].transaction_name, "GET /users/:id");
  assert.equal(payload.samples[0].request_count, 1);
  assert.ok(payload.samples[0].duration_sum_ms >= 0);
});

test("falls back to the literal path when no route matched (a 404)", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    performanceFlushIntervalMs: 20,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerPerformanceExpressMiddleware);
  // No routes at all; every request 404s with req.route left unset.

  const { server, port } = await startServer(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/nowhere`);
    assert.equal(response.status, 404);
  } finally {
    server.close();
  }

  const sample = await waitForSample(requests);
  assert.ok(sample, "expected a performance sample to be delivered");
  const payload = JSON.parse(sample.init.body);
  assert.equal(payload.samples[0].transaction_name, "GET /nowhere");
});

test("aggregates several requests to the same route into one bucket", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    // Long enough that both requests always land in the same flush, even on a busy machine; with
    // 20ms they could straddle one and arrive as two samples of one request each.
    performanceFlushIntervalMs: 300,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerPerformanceExpressMiddleware);
  app.get("/users/:id", (req, res) => res.send("ok"));

  const { server, port } = await startServer(app);
  try {
    await Promise.all([fetch(`http://127.0.0.1:${port}/users/1`), fetch(`http://127.0.0.1:${port}/users/2`)]);
  } finally {
    server.close();
  }

  const sample = await waitForSample(requests);
  assert.ok(sample, "expected a performance sample to be delivered");
  const payload = JSON.parse(sample.init.body);
  assert.equal(payload.samples.length, 1);
  assert.equal(payload.samples[0].transaction_name, "GET /users/:id");
  assert.equal(payload.samples[0].request_count, 2);
});

test("records a controller breadcrumb into the request's own trail once the response finishes", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    performanceFlushIntervalMs: 20,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerBreadcrumbContextExpressMiddleware);
  app.use(forgeOpsTrackerPerformanceExpressMiddleware);
  app.get("/users/:id", (req, res) => {
    res.send("ok");
    // A second "finish" listener, registered after the performance middleware's own: Node's
    // EventEmitter fires listeners on the same event in registration order and synchronously
    // within the same call chain, so by the time this one runs, forgeOpsTrackerPerformanceExpressMiddleware's
    // own listener has already called _recordBreadcrumb. Capturing an exception right here is
    // the most direct way to observe what actually landed in this request's own trail, still
    // inside the same AsyncLocalStorage context forgeOpsTrackerBreadcrumbContextExpressMiddleware
    // set up for it, without waiting on a second, separate request the way the documented
    // "never on this exact request's own error" gap would otherwise force.
    res.on("finish", () => {
      try {
        throw new Error("post-response checkpoint");
      } catch (error) {
        forgeOpsTracker.captureException(error);
      }
    });
  });

  const { server, port } = await startServer(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/users/42`);
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }

  const checkpointRequest = requests.find((r) => r.uri.endsWith("/api/v1/events"));
  assert.ok(checkpointRequest, "expected the checkpoint exception to be delivered");
  const body = JSON.parse(checkpointRequest.init.body);
  assert.equal(body.breadcrumbs.length, 1);
  assert.equal(body.breadcrumbs[0].category, "controller");
  assert.equal(body.breadcrumbs[0].message, "GET /users/:id");
  assert.equal(body.breadcrumbs[0].level, "info");
  assert.equal(body.breadcrumbs[0].data.status, 200);
});

test("controller breadcrumb recording is gated on trackBreadcrumbs independently of trackPerformance", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    performanceFlushIntervalMs: 20,
    trackBreadcrumbs: false,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerBreadcrumbContextExpressMiddleware);
  app.use(forgeOpsTrackerPerformanceExpressMiddleware);
  app.get("/users/:id", (req, res) => res.send("ok"));

  const { server, port } = await startServer(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/users/1`);
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }

  // Performance sample still flows even with breadcrumbs off: the two flags are independent.
  const sample = await waitForSample(requests);
  assert.ok(sample, "expected a performance sample to be delivered even with trackBreadcrumbs off");
});

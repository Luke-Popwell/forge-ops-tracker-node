import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import express from "express";
import Fastify from "fastify";
import * as forgeOpsTracker from "../../src/index.js";
import { forgeOpsTrackerTracingExpressMiddleware, registerForgeOpsTrackerTracing } from "../../src/integrations/tracing.js";

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

async function startExpress(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, port: server.address().port };
}

async function waitForSpans(requests) {
  const deadline = Date.now() + 1000;
  let request = null;
  while (Date.now() < deadline && !request) {
    request = requests.find((r) => r.uri.endsWith("/api/v1/spans"));
    if (!request) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return request;
}

test("Express: a slow request (over the threshold) delivers a trace with the route pattern as the root span's name", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    traceCaptureThresholdMs: 20,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerTracingExpressMiddleware);
  app.get("/users/:id", async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    res.send("ok");
  });

  const { server, port } = await startExpress(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/users/42`);
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }

  const request = await waitForSpans(requests);
  assert.ok(request, "expected a trace to be delivered for the slow request");
  const body = JSON.parse(request.init.body);
  assert.equal(body.spans.length, 1);
  const root = body.spans[0];
  assert.equal(root.parent_span_id, null);
  assert.equal(root.kind, "controller");
  // The route pattern, not "GET /users/42": matches forgeOpsTrackerPerformanceExpressMiddleware's
  // own transaction-naming convention exactly, not a second scheme for the same request.
  assert.equal(root.name, "GET /users/:id");
  assert.ok(root.duration_ms >= 30);
});

test("Express: a fast request (under the threshold) never sends a single byte", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    traceCaptureThresholdMs: 1000,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerTracingExpressMiddleware);
  app.get("/users/:id", (req, res) => res.send("ok"));

  const { server, port } = await startExpress(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/users/42`);
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }

  // Give any errant delivery a moment to show up; none should.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests.filter((r) => r.uri.endsWith("/api/v1/spans")).length, 0);
});

test("Express: a manual span() call inside the route handler nests correctly under the root", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    traceCaptureThresholdMs: 10,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerTracingExpressMiddleware);
  app.get("/checkout", async (req, res) => {
    await forgeOpsTracker.span("PaymentService.charge", async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    res.send("ok");
  });

  const { server, port } = await startExpress(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/checkout`);
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }

  const request = await waitForSpans(requests);
  assert.ok(request, "expected a trace to be delivered");
  const body = JSON.parse(request.init.body);
  assert.equal(body.spans.length, 2);

  const root = body.spans.find((s) => s.kind === "controller");
  const service = body.spans.find((s) => s.kind === "service");
  assert.equal(root.name, "GET /checkout");
  assert.equal(service.name, "PaymentService.charge");
  assert.equal(service.parent_span_id, root.span_id);
});

test("Fastify: a slow request delivers a trace, using the matched route pattern as the root span's name", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    traceCaptureThresholdMs: 20,
    installProcessHandlers: false,
  });

  const app = Fastify();
  registerForgeOpsTrackerTracing(app);
  app.get("/users/:id", async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "ok";
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/users/42`);
    assert.equal(response.status, 200);
  } finally {
    await app.close();
  }

  const request = await waitForSpans(requests);
  assert.ok(request, "expected a trace to be delivered for the slow request");
  const body = JSON.parse(request.init.body);
  assert.equal(body.spans.length, 1);
  const root = body.spans[0];
  assert.equal(root.parent_span_id, null);
  assert.equal(root.kind, "controller");
  assert.equal(root.name, "GET /users/:id");
  assert.ok(root.duration_ms >= 30);
});

test("Fastify: a fast request never sends a single byte", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    traceCaptureThresholdMs: 1000,
    installProcessHandlers: false,
  });

  const app = Fastify();
  registerForgeOpsTrackerTracing(app);
  app.get("/users/:id", async () => "ok");

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/users/42`);
    assert.equal(response.status, 200);
  } finally {
    await app.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests.filter((r) => r.uri.endsWith("/api/v1/spans")).length, 0);
});

test("Fastify: falls back to the literal path when no route matched (a 404)", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    traceCaptureThresholdMs: 0,
    installProcessHandlers: false,
  });

  const app = Fastify();
  registerForgeOpsTrackerTracing(app);
  // No routes at all; every request 404s with no matched route pattern.

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/nowhere`);
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }

  const request = await waitForSpans(requests);
  assert.ok(request, "expected a trace to be delivered even for a 404");
  const body = JSON.parse(request.init.body);
  assert.equal(body.spans[0].name, "GET /nowhere");
});

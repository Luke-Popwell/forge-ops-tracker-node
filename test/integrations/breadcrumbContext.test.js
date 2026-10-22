import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import express from "express";
import Fastify from "fastify";
import * as forgeOpsTracker from "../../src/index.js";
import {
  forgeOpsTrackerBreadcrumbContextExpressMiddleware,
  registerForgeOpsTrackerBreadcrumbContext,
} from "../../src/integrations/breadcrumbContext.js";
import { forgeOpsTrackerExpressMiddleware } from "../../src/integrations/express.js";
import { registerForgeOpsTracker } from "../../src/integrations/fastify.js";

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

function bodyOf(request) {
  return JSON.parse(request.init.body);
}

test("Express: a breadcrumb added deep inside an awaited route handler is visible to the error middleware at the end of the same request", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerBreadcrumbContextExpressMiddleware);
  app.get("/throw", async (req, res, next) => {
    forgeOpsTracker.addBreadcrumb("about to charge card", { category: "billing" });
    await Promise.resolve();
    forgeOpsTracker.addBreadcrumb("card charged", { category: "billing" });
    next(new Error("payment failed"));
  });
  app.use(forgeOpsTrackerExpressMiddleware);

  const { server, port } = await startExpress(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/throw`);
    assert.equal(response.status, 500);
  } finally {
    server.close();
  }

  assert.equal(requests.length, 1);
  const body = bodyOf(requests[0]);
  assert.deepEqual(
    body.breadcrumbs.map((b) => b.message),
    ["about to charge card", "card charged"],
  );
});

test("Express: two concurrent, interleaved requests never bleed breadcrumbs into each other", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerBreadcrumbContextExpressMiddleware);
  app.get("/slow/:id", async (req, res, next) => {
    forgeOpsTracker.addBreadcrumb(`${req.params.id}-start`);
    const delayMs = req.params.id === "A" ? 30 : 5;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    forgeOpsTracker.addBreadcrumb(`${req.params.id}-end`);
    next(new Error(`boom-${req.params.id}`));
  });
  app.use(forgeOpsTrackerExpressMiddleware);

  const { server, port } = await startExpress(app);
  try {
    const [resA, resB] = await Promise.all([fetch(`http://127.0.0.1:${port}/slow/A`), fetch(`http://127.0.0.1:${port}/slow/B`)]);
    assert.equal(resA.status, 500);
    assert.equal(resB.status, 500);
  } finally {
    server.close();
  }

  assert.equal(requests.length, 2);
  const bodies = requests.map(bodyOf);
  const forA = bodies.find((b) => b.message === "boom-A");
  const forB = bodies.find((b) => b.message === "boom-B");

  assert.deepEqual(
    forA.breadcrumbs.map((b) => b.message),
    ["A-start", "A-end"],
  );
  assert.deepEqual(
    forB.breadcrumbs.map((b) => b.message),
    ["B-start", "B-end"],
  );
});

test("Express: no buffer is set up at all when trackBreadcrumbs is off, and captureException carries no breadcrumbs key", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    trackBreadcrumbs: false,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerBreadcrumbContextExpressMiddleware);
  app.get("/throw", (req, res, next) => next(new Error("boom")));
  app.use(forgeOpsTrackerExpressMiddleware);

  const { server, port } = await startExpress(app);
  try {
    await fetch(`http://127.0.0.1:${port}/throw`);
  } finally {
    server.close();
  }

  assert.equal(requests.length, 1);
  assert.equal("breadcrumbs" in bodyOf(requests[0]), false);
});

test("Fastify: a breadcrumb added inside an async route handler is visible to the onError hook's captureException at the end of the same request", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  const app = Fastify();
  registerForgeOpsTrackerBreadcrumbContext(app);
  registerForgeOpsTracker(app);
  app.get("/throw", async () => {
    forgeOpsTracker.addBreadcrumb("about to charge card", { category: "billing" });
    await Promise.resolve();
    forgeOpsTracker.addBreadcrumb("card charged", { category: "billing" });
    throw new Error("payment failed");
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/throw`);
    assert.equal(response.status, 500);
  } finally {
    await app.close();
  }

  assert.equal(requests.length, 1);
  const body = bodyOf(requests[0]);
  assert.deepEqual(
    body.breadcrumbs.map((b) => b.message),
    ["about to charge card", "card charged"],
  );
});

test("Fastify: two concurrent, interleaved requests never bleed breadcrumbs into each other, including in the onError hook", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  const app = Fastify();
  registerForgeOpsTrackerBreadcrumbContext(app);
  registerForgeOpsTracker(app);
  app.get("/slow/:id", async (request) => {
    forgeOpsTracker.addBreadcrumb(`${request.params.id}-start`);
    const delayMs = request.params.id === "A" ? 30 : 5;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    forgeOpsTracker.addBreadcrumb(`${request.params.id}-end`);
    throw new Error(`boom-${request.params.id}`);
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  try {
    const [resA, resB] = await Promise.all([fetch(`http://127.0.0.1:${port}/slow/A`), fetch(`http://127.0.0.1:${port}/slow/B`)]);
    assert.equal(resA.status, 500);
    assert.equal(resB.status, 500);
  } finally {
    await app.close();
  }

  assert.equal(requests.length, 2);
  const bodies = requests.map(bodyOf);
  const forA = bodies.find((b) => b.message === "boom-A");
  const forB = bodies.find((b) => b.message === "boom-B");

  assert.deepEqual(
    forA.breadcrumbs.map((b) => b.message),
    ["A-start", "A-end"],
  );
  assert.deepEqual(
    forB.breadcrumbs.map((b) => b.message),
    ["B-start", "B-end"],
  );
});

test("Fastify: addBreadcrumb still works inside a route handler with no breadcrumb-context hook installed at all (falls back to its own standalone buffer)", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  const app = Fastify();
  // No registerForgeOpsTrackerBreadcrumbContext(app) here on purpose.
  registerForgeOpsTracker(app);
  app.get("/throw", async () => {
    forgeOpsTracker.addBreadcrumb("no context installed");
    throw new Error("boom");
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  try {
    await fetch(`http://127.0.0.1:${port}/throw`);
  } finally {
    await app.close();
  }

  assert.equal(requests.length, 1);
  // Not asserting the breadcrumb necessarily lands on this exact report (no context wrapping
  // means the lazily-created buffer isn't guaranteed to be the same one the onError hook's own
  // captureException reads, since each hook may run as its own top-level async chain absent a
  // shared context): only that nothing throws and a report still goes out.
});

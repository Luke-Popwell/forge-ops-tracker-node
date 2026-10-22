import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import express from "express";
import * as forgeOpsTracker from "../../src/index.js";
import { forgeOpsTrackerExpressMiddleware, forgeOpsTrackerUserContextMiddleware } from "../../src/integrations/express.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgeOpsTracker._resetForTesting();
});

test("reports an unhandled exception (sync or async) and still lets Express handle it", async () => {
  // Only intercepts calls meant for the ForgeOps ingestion endpoint:
  // the test also uses fetch() itself, against the real local Express
  // server below, which must actually go through.
  const requests = [];
  globalThis.fetch = async (uri, init) => {
    if (String(uri).includes("tracker.example.com")) {
      requests.push({ uri, init });
      return new Response(null, { status: 202 });
    }
    return originalFetch(uri, init);
  };

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  const app = express();
  app.get("/throw-sync", () => {
    throw new Error("sync boom");
  });
  app.get("/throw-async", async () => {
    throw new Error("async boom");
  });
  // The middleware only observes: it reports, then calls next(err), so
  // Express's own default error handling (a plain 500 here, since no
  // other error handler is registered) behaves exactly as if it weren't
  // there.
  app.use(forgeOpsTrackerExpressMiddleware);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  try {
    const syncResponse = await fetch(`http://127.0.0.1:${port}/throw-sync`);
    assert.equal(syncResponse.status, 500);

    const asyncResponse = await fetch(`http://127.0.0.1:${port}/throw-async`);
    assert.equal(asyncResponse.status, 500);
  } finally {
    server.close();
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers.Authorization, "Bearer key");
  assert.equal(requests[1].init.headers.Authorization, "Bearer key");
});

test("forgeOpsTrackerUserContextMiddleware attaches req.user to an exception thrown later, including from an async route handler", async () => {
  const requests = [];
  globalThis.fetch = async (uri, init) => {
    if (String(uri).includes("tracker.example.com")) {
      requests.push({ uri, init });
      return new Response(null, { status: 202 });
    }
    return originalFetch(uri, init);
  };

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  const app = express();
  // Stands in for Passport's own session middleware, which is what would normally set req.user
  // this early in a real app.
  app.use((req, res, next) => {
    req.user = { id: 42, email: "ada@example.com" };
    next();
  });
  app.use(forgeOpsTrackerUserContextMiddleware);
  app.get("/throw-async", async () => {
    // A real async hop (not a synchronous throw): proves AsyncLocalStorage's context, set by the
    // middleware above, really does survive across it, not just through a synchronous call chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    throw new Error("async boom");
  });
  app.use(forgeOpsTrackerExpressMiddleware);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/throw-async`);
    assert.equal(response.status, 500);
  } finally {
    server.close();
  }

  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.user, { id: "42", email: "ada@example.com" });
});

test("forgeOpsTrackerUserContextMiddleware is a no-op when req.user is never set", async () => {
  const requests = [];
  globalThis.fetch = async (uri, init) => {
    if (String(uri).includes("tracker.example.com")) {
      requests.push({ uri, init });
      return new Response(null, { status: 202 });
    }
    return originalFetch(uri, init);
  };

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerUserContextMiddleware);
  app.get("/throw", () => {
    throw new Error("boom");
  });
  app.use(forgeOpsTrackerExpressMiddleware);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/throw`);
    assert.equal(response.status, 500);
  } finally {
    server.close();
  }

  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.user, undefined);
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import express from "express";
import * as forgeOpsTracker from "../../src/index.js";
import { forgeOpsTrackerExpressMiddleware } from "../../src/integrations/express.js";
import { forgeOpsTrackerSessionTrackingExpressMiddleware } from "../../src/integrations/sessionTracking.js";

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

test("counts a successful request as a crash-free session", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    sessionFlushIntervalMs: 20,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerSessionTrackingExpressMiddleware);
  app.get("/ok", (req, res) => res.send("ok"));

  const { server, port } = await startServer(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ok`);
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }

  const deadline = Date.now() + 1000;
  let checkin = null;
  while (Date.now() < deadline && !checkin) {
    checkin = requests.find((r) => r.uri.endsWith("/api/v1/session_checkins"));
    if (!checkin) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.ok(checkin, "expected a session checkin to be delivered");
  const payload = JSON.parse(checkin.init.body);
  assert.equal(payload.sessions_count, 1);
  assert.equal(payload.crashed_sessions_count, 0);
});

test("counts a crashed request as a crashed session, coordinating with the error middleware", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    sessionFlushIntervalMs: 20,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerSessionTrackingExpressMiddleware);
  app.get("/throw", () => {
    throw new Error("boom");
  });
  app.use(forgeOpsTrackerExpressMiddleware);

  const { server, port } = await startServer(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/throw`);
    assert.equal(response.status, 500);
  } finally {
    server.close();
  }

  const deadline = Date.now() + 1000;
  let checkin = null;
  while (Date.now() < deadline && !checkin) {
    checkin = requests.find((r) => r.uri.endsWith("/api/v1/session_checkins"));
    if (!checkin) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.ok(checkin, "expected a session checkin to be delivered");
  const payload = JSON.parse(checkin.init.body);
  assert.equal(payload.sessions_count, 1);
  assert.equal(payload.crashed_sessions_count, 1);
});

test("counts a crashed request as crashed even with no error-reporting middleware installed", async () => {
  const requests = [];
  globalThis.fetch = fakeFetch(requests);

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    sessionFlushIntervalMs: 20,
    installProcessHandlers: false,
  });

  const app = express();
  app.use(forgeOpsTrackerSessionTrackingExpressMiddleware);
  app.get("/throw", () => {
    throw new Error("boom");
  });
  // Deliberately no forgeOpsTrackerExpressMiddleware here; relies on the status-code signal
  // (Express's own default 500) rather than the request-scoped flag.

  const { server, port } = await startServer(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/throw`);
    assert.equal(response.status, 500);
  } finally {
    server.close();
  }

  const deadline = Date.now() + 1000;
  let checkin = null;
  while (Date.now() < deadline && !checkin) {
    checkin = requests.find((r) => r.uri.endsWith("/api/v1/session_checkins"));
    if (!checkin) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.ok(checkin, "expected a session checkin to be delivered");
  const payload = JSON.parse(checkin.init.body);
  assert.equal(payload.crashed_sessions_count, 1);
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import Fastify from "fastify";
import * as forgeOpsTracker from "../../src/index.js";
import { registerForgeOpsTracker } from "../../src/integrations/fastify.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgeOpsTracker._resetForTesting();
});

test("reports an unhandled exception (sync or async) and still lets Fastify handle it", async () => {
  // Only intercepts calls meant for the ForgeOps ingestion endpoint:
  // the test also uses fetch() itself, against the real local Fastify
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

  const app = Fastify();
  registerForgeOpsTracker(app);
  app.get("/throw-sync", () => {
    throw new Error("sync boom");
  });
  app.get("/throw-async", async () => {
    throw new Error("async boom");
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;

  try {
    const syncResponse = await fetch(`http://127.0.0.1:${port}/throw-sync`);
    assert.equal(syncResponse.status, 500);

    const asyncResponse = await fetch(`http://127.0.0.1:${port}/throw-async`);
    assert.equal(asyncResponse.status, 500);
  } finally {
    await app.close();
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers.Authorization, "Bearer key");
  assert.equal(requests[1].init.headers.Authorization, "Bearer key");
});

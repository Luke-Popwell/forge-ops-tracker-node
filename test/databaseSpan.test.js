import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as forgeOpsTracker from "../src/index.js";

const originalFetch = globalThis.fetch;

function waitUntil(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgeOpsTracker._resetForTesting();
});

// Runs fn inside a traced request that always counts as slow, and returns the one trace delivered.
async function traceWithSpans(fn) {
  const requests = [];
  globalThis.fetch = async (uri, init) => {
    requests.push({ uri, init });
    return new Response(null, { status: 202 });
  };
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    traceCaptureThresholdMs: 0,
    installProcessHandlers: false,
  });
  await forgeOpsTracker._runWithSpanTrace(async () => {
    await fn();
    forgeOpsTracker._finishSpanTrace("OrdersController#index", new Date(), 10);
  });
  await waitUntil(() => requests.length === 1);
  return { raw: requests[0].init.body, body: JSON.parse(requests[0].init.body) };
}

test("a database span sends its statement masked as db.statement, with db.system lowercased", async () => {
  const sql = "SELECT * FROM orders WHERE email = 'jane@example.com' AND total > 4200";
  const { raw, body } = await traceWithSpans(() =>
    forgeOpsTracker.span("Load orders", async () => "rows", { kind: "database", statement: sql, dbSystem: "PostgreSQL" }),
  );

  const span = body.spans.find((s) => s.kind === "database");
  assert.equal(span.name, "Load orders");
  assert.equal(span.data["db.statement"], "SELECT * FROM orders WHERE email = ? AND total > ?");
  assert.equal(span.data["db.system"], "postgresql");
  assert.equal(raw.includes("jane@example.com"), false);
  assert.equal(raw.includes("4200"), false);
});

test("span() still returns the callback's own value when given a statement", async () => {
  let result;
  await traceWithSpans(async () => {
    result = await forgeOpsTracker.span("Load orders", async () => ["row"], { kind: "database", statement: "SELECT 1" });
  });
  assert.deepEqual(result, ["row"]);
});

test("a db.statement passed in data directly on a database span is masked too", async () => {
  const { raw, body } = await traceWithSpans(() =>
    forgeOpsTracker.span("Load user", () => null, { kind: "database", data: { "db.statement": "SELECT name FROM users WHERE id = 9911" } }),
  );

  const span = body.spans.find((s) => s.kind === "database");
  assert.equal(span.data["db.statement"], "SELECT name FROM users WHERE id = ?");
  assert.equal("db.system" in span.data, false);
  assert.equal(raw.includes("9911"), false);
});

test("a mysql or mariadb database span masks \"double quoted\" values too", async () => {
  const { raw, body } = await traceWithSpans(async () => {
    await forgeOpsTracker.span("Find token", () => null, { kind: "database", statement: 'SELECT id FROM t WHERE token = "abc123secret"', dbSystem: "MySQL" });
    await forgeOpsTracker.span("Find name", () => null, { kind: "database", data: { "db.system": "mariadb", "db.statement": 'SELECT id FROM t WHERE name = "jane"' } });
    await forgeOpsTracker.span("Quoted column", () => null, { kind: "database", statement: 'SELECT "user id" FROM t', dbSystem: "postgresql" });
  });

  const spans = body.spans.filter((s) => s.kind === "database");
  assert.deepEqual(
    spans.map((s) => [s.data["db.statement"], s.data["db.system"]]),
    [
      ["SELECT id FROM t WHERE token = ?", "mysql"],
      ["SELECT id FROM t WHERE name = ?", "mariadb"],
      ['SELECT "user id" FROM t', "postgresql"],
    ],
  );
  assert.equal(raw.includes("abc123secret"), false);
  assert.equal(raw.includes("jane"), false);
});

test("a long statement is truncated", async () => {
  const sql = `SELECT ${"column_name, ".repeat(500)}id FROM orders`;
  const { body } = await traceWithSpans(() => forgeOpsTracker.span("Load orders", () => null, { kind: "database", statement: sql }));

  const span = body.spans.find((s) => s.kind === "database");
  assert.ok(span.data["db.statement"].length <= 4003);
  assert.ok(span.data["db.statement"].endsWith("..."));
});

test("statement and dbSystem are ignored on a span that isn't a database span", async () => {
  const { raw, body } = await traceWithSpans(() =>
    forgeOpsTracker.span("PaymentService.charge", () => null, { statement: "SELECT 'secret-value'", dbSystem: "mysql" }),
  );

  const span = body.spans.find((s) => s.kind === "service");
  assert.deepEqual(span.data, {});
  assert.equal(raw.includes("secret-value"), false);
});

test("a database span with no statement carries no db.statement", async () => {
  const { body } = await traceWithSpans(() => forgeOpsTracker.span("Load orders", () => null, { kind: "database", dbSystem: "sqlite" }));

  const span = body.spans.find((s) => s.kind === "database");
  assert.deepEqual(span.data, { "db.system": "sqlite" });
});

test("outside a traced request a database span with a statement just runs the callback", () => {
  assert.equal(forgeOpsTracker.span("Load orders", () => 7, { kind: "database", statement: "SELECT 1" }), 7);
});

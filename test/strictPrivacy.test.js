import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { Configuration } from "../src/configuration.js";
import { EventBuilder } from "../src/eventBuilder.js";
import * as forgeOpsTracker from "../src/index.js";
import { PerformanceFlusher } from "../src/performanceFlusher.js";
import { messageFingerprint, normalizeMessage, strictPath, span, spanName } from "../src/strictPrivacy.js";

// A byte-identical copy of sdks/strict_privacy_vectors.json, generated from the server's own
// app/services/strict_privacy.rb: the results every SDK and the server have to agree on.
const fixtureUrl = new URL("./fixtures/strict_privacy_vectors.json", import.meta.url);
const vectors = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FORGE_OPS_STRICT_PRIVACY;
  delete process.env.FORGE_OPS_PRIVACY_ALLOWED_FIELDS;
  forgeOpsTracker._resetForTesting();
});

// That the fixture matches the repo's sdks/strict_privacy_vectors.json is checked by the server's own
// suite (spec/models/sdk_strict_privacy_vectors_spec.rb): a published package's tests can't read
// outside its own directory.

for (const vector of vectors.fingerprint) {
  test(`fingerprint vector ${JSON.stringify(vector.message)}`, () => {
    assert.equal(normalizeMessage(vector.message), vector.normalized);
    assert.equal(messageFingerprint(vector.message), vector.fingerprint);
  });
}

for (const vector of vectors.path) {
  test(`path vector ${JSON.stringify(vector.path)}`, () => {
    assert.equal(strictPath(vector.path), vector.strict);
  });
}

for (const vector of vectors.span_name) {
  test(`span_name vector ${JSON.stringify(vector.name)}`, () => {
    assert.equal(spanName(vector.name), vector.strict);
  });
}

function newConfiguration() {
  const config = new Configuration();
  config.environment = "production";
  config.release = "abc123";
  config.serverName = "web-1";
  config.appRoot = new URL(".", import.meta.url).pathname;
  config.captureSourceContext = true;
  config.captureSqlStatement = true;
  return config;
}

function sqlError() {
  const error = new Error("Couldn't find Patient with id=8821 (jane@example.com)");
  error.sql = "SELECT * FROM patients WHERE email = 'jane@example.com'";
  return error;
}

function build(config) {
  return new EventBuilder(config).build(
    sqlError(),
    { error_code: "E42", feature: "checkout", diagnosis: "flu", nested: { error_code: "x" } },
    { id: 7, email: "jane@example.com", username: "jane" },
    [{ message: "GET /patients/7", category: "http" }],
    { transactionName: "GET /patients/:id", endpoint: "GET /patients/:id", traceId: "a".repeat(32) },
  );
}

test("an event built with strict privacy on keeps only structured facts", () => {
  const config = newConfiguration();
  config.strictPrivacy = true;
  config.privacyAllowedFields = ["error_code", "nested", "missing"];

  const payload = build(config);

  assert.equal("message" in payload, false);
  assert.equal(payload.message_fingerprint, messageFingerprint("Couldn't find Patient with id=8821 ([EMAIL FILTERED])"));
  assert.match(payload.message_fingerprint, /^[0-9a-f]{32}$/);
  assert.equal("breadcrumbs" in payload, false);
  assert.equal("endpoint" in payload, false);
  assert.equal("sql_statement" in payload, false);
  assert.deepEqual(payload.sql_objects.relations, ["patients"]);
  assert.deepEqual(payload.context, { error_code: "E42" });
  assert.equal("tags" in payload, false);
  assert.deepEqual(payload.user, { id: "7" });
  assert.equal(payload.transaction_name, "GET /patients/:id");
  assert.equal(payload.trace_id, "a".repeat(32));
  assert.equal(payload.exception_class, "Error");
  assert.ok(payload.backtrace.length > 0);
  assert.ok(payload.backtrace.some((frame) => frame.in_app));
  for (const frame of payload.backtrace) {
    assert.equal("context_line" in frame, false);
    assert.equal("pre_context" in frame, false);
    assert.equal("post_context" in frame, false);
  }
  assert.doesNotMatch(JSON.stringify(payload), /jane|flu|8821/);
});

test("the fingerprint is taken from the message as it would have been sent: scrubbed only when scrubPii is on", () => {
  const config = newConfiguration();
  config.strictPrivacy = true;
  const scrubbed = new EventBuilder(config).build(new Error("no account for jane@example.com"));
  config.scrubPii = false;
  const raw = new EventBuilder(config).build(new Error("no account for jane@example.com"));

  assert.equal(scrubbed.message_fingerprint, messageFingerprint("no account for [EMAIL FILTERED]"));
  assert.equal(raw.message_fingerprint, messageFingerprint("no account for jane@example.com"));
});

test("strict privacy leaves context and user out entirely when nothing is allowed or there's no id", () => {
  const config = newConfiguration();
  config.strictPrivacy = true;

  const payload = new EventBuilder(config).build(new Error("boom"), { error_code: "E42" }, { email: "jane@example.com" });

  assert.equal("context" in payload, false);
  assert.equal("tags" in payload, false);
  assert.equal("user" in payload, false);
  assert.equal(payload.message_fingerprint, "81f52337ebb4cb1669bb802c708807dd");
});

test("with strict privacy off, events are exactly as before", () => {
  const config = newConfiguration();
  config.privacyAllowedFields = ["error_code"]; // ignored while strictPrivacy is off

  // Built from the same line, so the two backtraces are identical too.
  const [payload, untouched] = [config, newConfiguration()].map((each) => build(each));

  assert.equal(payload.message, "Couldn't find Patient with id=8821 ([EMAIL FILTERED])");
  assert.equal("message_fingerprint" in payload, false);
  assert.equal(payload.breadcrumbs.length, 1);
  assert.equal(payload.endpoint, "GET /patients/:id");
  assert.equal(typeof payload.sql_statement, "string");
  assert.deepEqual(Object.keys(payload.context), ["error_code", "feature", "diagnosis", "nested"]);
  assert.deepEqual(payload.tags, {});
  assert.deepEqual(payload.user, { id: 7, email: "jane@example.com", username: "jane" });
  assert.ok(payload.backtrace.some((frame) => "context_line" in frame));

  untouched.occurred_at = payload.occurred_at; // the only field that may differ between two builds
  assert.deepEqual(payload, untouched);
});

test("a span keeps its name's method and host, and only db.statement/db.system as data", () => {
  assert.deepEqual(span({ span_id: "1", name: "GET https://api.example.com/patients/42?x=1", kind: "http", data: { status: 200 } }), {
    span_id: "1",
    name: "GET api.example.com",
    kind: "http",
  });
  assert.deepEqual(
    span({ span_id: "2", name: "SELECT orders", kind: "database", data: { "db.statement": "SELECT ?", "db.system": "postgresql", rows: 3 } }),
    { span_id: "2", name: "SELECT orders", kind: "database", data: { "db.statement": "SELECT ?", "db.system": "postgresql" } },
  );
});

test("strictPrivacy and privacyAllowedFields default from the environment", () => {
  process.env.FORGE_OPS_STRICT_PRIVACY = "true";
  process.env.FORGE_OPS_PRIVACY_ALLOWED_FIELDS = "error_code, feature,,";

  const config = new Configuration();

  assert.equal(config.strictPrivacy, true);
  assert.deepEqual(config.privacyAllowedFields, ["error_code", "feature"]);
});

test("both are off and empty by default", () => {
  const config = new Configuration();

  assert.equal(config.strictPrivacy, false);
  assert.deepEqual(config.privacyAllowedFields, []);
});

test("an option passed to init() wins over the environment", () => {
  process.env.FORGE_OPS_STRICT_PRIVACY = "true";

  const config = forgeOpsTracker.init({ strictPrivacy: false, installProcessHandlers: false });

  assert.equal(config.strictPrivacy, false);
});

function mockFetchCapturing() {
  const requests = [];
  globalThis.fetch = async (uri, init) => {
    requests.push({ uri, init });
    return new Response(null, { status: 202 });
  };
  return requests;
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function initEnabled(options = {}) {
  return forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
    ...options,
  });
}

test("with strict privacy on, captureException sends no message or breadcrumbs, and breadcrumbs aren't recorded", async () => {
  const requests = mockFetchCapturing();
  initEnabled({ strictPrivacy: true, privacyAllowedFields: ["error_code"] });

  await forgeOpsTracker._runWithBreadcrumbTrail(async () => {
    forgeOpsTracker.addBreadcrumb("Viewed patient Jane Doe");
    forgeOpsTracker.captureException(new Error("Patient Jane Doe not found"), { error_code: "E1", name: "Jane" });
  });

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  const event = body;
  assert.equal("message" in event, false);
  assert.equal(event.message_fingerprint, messageFingerprint("Patient Jane Doe not found"));
  assert.equal("breadcrumbs" in event, false);
  assert.deepEqual(event.context, { error_code: "E1" });
  assert.doesNotMatch(requests[0].init.body, /Jane/);
});

test("with strict privacy on, a trace's spans go out by method and host, with no http data", async () => {
  const requests = mockFetchCapturing();
  initEnabled({ strictPrivacy: true, traceCaptureThresholdMs: 0 });

  await forgeOpsTracker._runWithSpanTrace(async () => {
    forgeOpsTracker._recordSpan("GET https://api.example.com/patients/42?x=1", "http", new Date(), 5, { status: 200 });
    forgeOpsTracker._finishSpanTrace("GET /patients/42", new Date(), 10);
  });

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  const leaf = body.spans.find((s) => s.kind === "http");
  const root = body.spans.find((s) => s.kind === "controller");
  assert.equal(leaf.name, "GET api.example.com");
  assert.equal("data" in leaf, false);
  assert.equal(root.name, "GET /patients/:path");
});

test("with strict privacy off, a trace's spans are unchanged", async () => {
  const requests = mockFetchCapturing();
  initEnabled({ traceCaptureThresholdMs: 0 });

  await forgeOpsTracker._runWithSpanTrace(async () => {
    forgeOpsTracker._recordSpan("GET api.example.com", "http", new Date(), 5, { status: 200 });
    forgeOpsTracker._finishSpanTrace("GET /patients/42", new Date(), 10);
  });

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.spans.find((s) => s.kind === "http").data, { status: 200 });
  assert.equal(body.spans.find((s) => s.kind === "controller").name, "GET /patients/42");
});

test("with strict privacy on, a raw-path transaction_name loses its ids and a route is kept", () => {
  const config = newConfiguration();
  config.strictPrivacy = true;
  const builder = new EventBuilder(config);

  const raw = builder.build(new Error("boom"), {}, null, [], { transactionName: "GET /patients/42/notes?q=jane" });
  const route = builder.build(new Error("boom"), {}, null, [], { transactionName: "GET /patients/:id" });
  const action = builder.build(new Error("boom"), {}, null, [], { transactionName: "PatientsController#show" });

  assert.equal(raw.transaction_name, "GET /patients/:path");
  assert.equal(route.transaction_name, "GET /patients/:id");
  assert.equal(action.transaction_name, "PatientsController#show");
});

for (const strict of [true, false]) {
  test(`performance samples' transaction names ${strict ? "lose raw-path ids" : "are unchanged"} with strict privacy ${strict ? "on" : "off"}`, async () => {
    const delivered = [];
    const client = { deliverPerformanceSamples: async (samples) => { delivered.push(samples); return "delivered"; } };
    const config = newConfiguration();
    config.strictPrivacy = strict;

    const flusher = new PerformanceFlusher(config, client);
    flusher.record("GET /patients/42", 100);
    flusher.record("GET /patients/43", 100);
    flusher.record("GET /patients/:id", 100);
    await flusher.flush();

    const names = delivered[0].map((sample) => sample.transaction_name).sort();
    assert.deepEqual(names, strict ? ["GET /patients/:id", "GET /patients/:path"] : ["GET /patients/42", "GET /patients/43", "GET /patients/:id"]);
  });
}

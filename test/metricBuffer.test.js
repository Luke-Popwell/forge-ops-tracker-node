import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { Configuration } from "../src/configuration.js";
import * as forgeOpsTracker from "../src/index.js";
import { MAX_ENTRIES, MetricBuffer } from "../src/metricBuffer.js";

function newConfiguration() {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.environment = "production";
  config.release = "1.2.3";
  config.enabledEnvironments = new Set(["production"]);
  return config;
}

const buffers = [];
function newBuffer(deliver, config = newConfiguration()) {
  const buffer = new MetricBuffer(config, deliver, () => 3_600_000);
  buffers.push(buffer);
  return buffer;
}

afterEach(() => {
  buffers.splice(0).forEach((b) => b.discard());
  forgeOpsTracker._resetForTesting();
});

test("delivers every entry as one batch, stamped with a seconds-precision UTC recorded_at", async () => {
  const delivered = [];
  const buffer = newBuffer(async (entries) => { delivered.push(entries); return "delivered"; });

  buffer.record({ metric_name: "signup", value: 1 });
  buffer.record({ metric_name: "payment", value: 49.5 });
  await buffer.flush();

  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].map((e) => e.metric_name), ["signup", "payment"]);
  assert.match(delivered[0][0].recorded_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test("keeps a negative value, since a refund is a real metric", async () => {
  const delivered = [];
  const buffer = newBuffer(async (entries) => { delivered.push(entries); return "delivered"; });
  buffer.record({ metric_name: "refund", value: -12 });
  await buffer.flush();
  assert.equal(delivered[0][0].value, -12);
});

test("drops NaN, infinite and non-numeric values so one bad entry cannot poison a batch", () => {
  const buffer = newBuffer(async () => "delivered");
  assert.equal(buffer.record({ metric_name: "a", value: NaN }), false);
  assert.equal(buffer.record({ metric_name: "b", value: Infinity }), false);
  assert.equal(buffer.record({ metric_name: "c", value: "12" }), false);
  assert.equal(buffer.record({ metric_name: "d", value: 3 }), true);
});

test("a failed delivery keeps every entry for the next flush", async () => {
  const outcomes = ["failed", "delivered"];
  const delivered = [];
  const buffer = newBuffer(async (entries) => { delivered.push(entries.map((e) => e.metric_name)); return outcomes.shift(); });

  buffer.record({ metric_name: "a", value: 1 });
  await buffer.flush();
  buffer.record({ metric_name: "b", value: 2 });
  await buffer.flush();
  await buffer.flush(); // nothing left: no third delivery

  assert.deepEqual(delivered, [["a"], ["a", "b"]]);
});

test("an entry recorded while delivery is in flight is never lost", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delivered = [];
  const buffer = newBuffer(async (entries) => {
    delivered.push(entries.map((e) => e.metric_name));
    if (delivered.length === 1) {
      await gate;
    }
    return "delivered";
  });

  buffer.record({ metric_name: "first", value: 1 });
  const flushing = buffer.flush();
  buffer.record({ metric_name: "during", value: 2 });
  release();
  await flushing;
  await buffer.flush();

  assert.deepEqual(delivered, [["first"], ["during"]]);
});

test("the buffer is capped and drops further entries until a flush succeeds", () => {
  const buffer = newBuffer(async () => "failed");
  let accepted = 0;
  for (let i = 0; i < MAX_ENTRIES + 50; i++) {
    if (buffer.record({ metric_name: "m", value: 1 })) accepted += 1;
  }
  assert.equal(accepted, MAX_ENTRIES);
});

test("captureMetric and captureInfrastructureMetric deliver to their own endpoints end to end", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.statusCode = 202;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    forgeOpsTracker.init({
      dsn: `http://key@127.0.0.1:${server.address().port}/api/v1/events`,
      environment: "production",
      release: "a1b2c3d",
      enabledEnvironments: new Set(["production"]),
      installProcessHandlers: false,
    });
    forgeOpsTracker.captureMetric("signup");
    forgeOpsTracker.captureMetric("payment", 49);
    forgeOpsTracker.captureInfrastructureMetric("cpu", 0.42, { hostname: "web-1" });
    forgeOpsTracker.captureInfrastructureMetric("memory", 0.7);
    await forgeOpsTracker.flushMetrics();

    const byPath = Object.fromEntries(requests.map((r) => [r.path, r]));
    const custom = byPath["/api/v1/custom_metrics"];
    assert.equal(custom.auth, "Bearer key");
    assert.deepEqual(custom.body.metrics.map((m) => [m.metric_name, m.value]), [["signup", 1], ["payment", 49]]);
    assert.equal(custom.body.metrics[0].environment, "production");
    assert.equal(custom.body.metrics[0].release, "a1b2c3d");
    const infrastructure = byPath["/api/v1/infrastructure_metrics"].body.metrics;
    assert.equal(infrastructure[0].hostname, "web-1");
    assert.equal(infrastructure[1].hostname, new Configuration().serverName);
  } finally {
    server.close();
  }
});

test("captureMetric is a no-op when the client is not enabled", async () => {
  forgeOpsTracker.init({ dsn: "https://key@tracker.example.com/api/v1/events", environment: "development", installProcessHandlers: false });
  forgeOpsTracker.captureMetric("signup");
  forgeOpsTracker.captureInfrastructureMetric("cpu", 1);
  await forgeOpsTracker.flushMetrics(); // resolves without a buffer ever having been created
});

test("the metric URIs swap the trailing events segment", () => {
  const config = newConfiguration();
  assert.equal(config.customMetricsUri(), "https://tracker.example.com/api/v1/custom_metrics");
  assert.equal(config.infrastructureMetricsUri(), "https://tracker.example.com/api/v1/infrastructure_metrics");
});

test("a script that captures a reading and just lets the process end still delivers it (beforeExit)", async () => {
  const { spawn } = await import("node:child_process");
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ path: req.url, body: JSON.parse(body) });
      res.statusCode = 202;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const script = `
      import { init, captureInfrastructureMetric } from ${JSON.stringify(new URL("../src/index.js", import.meta.url).href)};
      init({ dsn: "http://key@127.0.0.1:${server.address().port}/api/v1/events", environment: "production", enabledEnvironments: new Set(["production"]), installProcessHandlers: false, detectChanges: false });
      captureInfrastructureMetric("cpu", 0.5, { hostname: "cron-1" });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "inherit" });
    await new Promise((resolve) => child.on("exit", resolve));

    assert.equal(received.length, 1);
    assert.equal(received[0].path, "/api/v1/infrastructure_metrics");
    assert.equal(received[0].body.metrics[0].hostname, "cron-1");
  } finally {
    server.close();
  }
});

test("a batch the server rejects is dropped and never sent again", async () => {
  const logs = [];
  const config = newConfiguration();
  config.logger = (message) => logs.push(message);
  const delivered = [];
  const buffer = newBuffer(async (entries) => { delivered.push(entries.map((e) => e.metric_name)); return "rejected"; }, config);

  buffer.record({ metric_name: "a", value: 1 });
  await buffer.flush();
  await buffer.flush(); // nothing left: no second delivery
  buffer.record({ metric_name: "b", value: 2 });
  await buffer.flush();

  assert.deepEqual(delivered, [["a"], ["b"]]);
  assert.equal(logs.filter((m) => m.includes("dropping 1 metric(s): the server rejected them")).length, 2);
});

test("a rejected batch frees a full buffer for new metrics", async () => {
  const buffer = newBuffer(async () => "rejected");
  for (let i = 0; i < MAX_ENTRIES; i++) {
    buffer.record({ metric_name: "m", value: 1 });
  }
  assert.equal(buffer.record({ metric_name: "m", value: 1 }), false);

  await buffer.flush();

  assert.equal(buffer.record({ metric_name: "m", value: 1 }), true);
});

test("the fifth failed flush in a row drops the batch and starts clean", async () => {
  const logs = [];
  const config = newConfiguration();
  config.logger = (message) => logs.push(message);
  const delivered = [];
  const buffer = newBuffer(async (entries) => { delivered.push(entries.map((e) => e.metric_name)); return "failed"; }, config);

  buffer.record({ metric_name: "a", value: 1 });
  for (let i = 0; i < 4; i++) {
    await buffer.flush();
  }
  assert.equal(logs.length, 0);
  await buffer.flush(); // the fifth: gives up on the batch
  await buffer.flush(); // nothing left: no sixth delivery

  assert.equal(delivered.length, 5);
  assert.deepEqual(logs, ["[forge-ops-tracker] dropping 1 metric(s): 5 flushes in a row failed"]);

  // Clean again: the next batch gets its own five tries.
  buffer.record({ metric_name: "b", value: 2 });
  await buffer.flush();
  await buffer.flush();
  assert.deepEqual(delivered.slice(5), [["b"], ["b"]]);
});

test("a delivery in between resets the count of failed flushes", async () => {
  const outcomes = ["failed", "failed", "failed", "failed", "delivered", "failed", "failed", "failed", "failed", "delivered"];
  const delivered = [];
  const buffer = newBuffer(async (entries) => { delivered.push(entries.map((e) => e.metric_name)); return outcomes.shift(); });

  buffer.record({ metric_name: "a", value: 1 });
  for (let i = 0; i < 5; i++) {
    await buffer.flush();
  }
  buffer.record({ metric_name: "b", value: 2 });
  for (let i = 0; i < 5; i++) {
    await buffer.flush();
  }

  // Four failures after the delivery are not five in a row: "b" was still held for the tenth flush.
  assert.equal(delivered.length, 10);
  assert.deepEqual(delivered[9], ["b"]);
});

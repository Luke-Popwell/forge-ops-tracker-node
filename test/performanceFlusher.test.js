import assert from "node:assert/strict";
import { test } from "node:test";
import { Configuration } from "../src/configuration.js";
import { PerformanceFlusher } from "../src/performanceFlusher.js";

function newConfiguration() {
  const config = new Configuration();
  config.release = "1.2.3";
  config.environment = "production";
  return config;
}

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

test("buckets by transaction name and delivers one aggregate entry per transaction, resetting after a successful flush", async () => {
  const delivered = [];
  const client = { deliverPerformanceSamples: async (samples) => { delivered.push(samples); return "delivered"; } };

  const flusher = new PerformanceFlusher(newConfiguration(), client);
  flusher.record("GET /posts/:id", 100);
  flusher.record("GET /posts/:id", 200);
  flusher.record("GET /posts", 50);
  await flusher.flush();

  assert.equal(delivered.length, 1);
  const samples = delivered[0].sort((a, b) => a.transaction_name.localeCompare(b.transaction_name));
  assert.equal(samples.length, 2);

  const index = samples.find((s) => s.transaction_name === "GET /posts");
  assert.equal(index.request_count, 1);
  assert.equal(index.duration_sum_ms, 50);
  assert.equal(index.max_duration_ms, 50);
  assert.equal(index.release, "1.2.3");
  assert.equal(index.environment, "production");

  const show = samples.find((s) => s.transaction_name === "GET /posts/:id");
  assert.equal(show.request_count, 2);
  assert.equal(show.duration_sum_ms, 300);
  assert.equal(show.max_duration_ms, 200);

  // Nothing new was recorded since the successful flush above, so this one sends nothing.
  await flusher.flush();
  assert.equal(delivered.length, 1);
});

test("does nothing on a flush with nothing recorded", async () => {
  let called = false;
  const client = { deliverPerformanceSamples: async () => { called = true; return "delivered"; } };

  await new PerformanceFlusher(newConfiguration(), client).flush();

  assert.equal(called, false);
});

test("keeps every bucket for the next flush instead of losing them when delivery fails", async () => {
  const client = { deliverPerformanceSamples: async () => "failed" };

  const flusher = new PerformanceFlusher(newConfiguration(), client);
  flusher.record("GET /posts/:id", 100);
  await flusher.flush();

  const delivered = [];
  client.deliverPerformanceSamples = async (samples) => { delivered.push(samples); return "delivered"; };
  flusher.record("GET /posts/:id", 100);
  await flusher.flush();

  assert.equal(delivered[0][0].request_count, 2);
  assert.equal(delivered[0][0].duration_sum_ms, 200);
});

test("the interval timer flushes on its own after the configured interval", async () => {
  const delivered = [];
  const client = { deliverPerformanceSamples: async (samples) => { delivered.push(samples); return "delivered"; } };

  const configuration = newConfiguration();
  configuration.performanceFlushIntervalMs = 20;

  const flusher = new PerformanceFlusher(configuration, client);
  flusher.record("GET /posts/:id", 100);

  await waitUntil(() => delivered.length === 1);
  assert.equal(delivered[0][0].request_count, 1);
});

test("the interval timer survives the client throwing instead of resolving", async () => {
  const delivered = [];
  let callCount = 0;
  const client = {
    deliverPerformanceSamples: async (samples) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("boom");
      }
      delivered.push(samples);
      return "delivered";
    },
  };

  const configuration = newConfiguration();
  configuration.performanceFlushIntervalMs = 20;

  const flusher = new PerformanceFlusher(configuration, client);
  flusher.record("GET /posts/:id", 100); // the first tick rejects; must not stop the timer

  // A later tick recovers and delivers on its own; a dead timer would leave this array empty
  // forever and time out instead.
  await waitUntil(() => delivered.length === 1);
});

test("delivers a latency histogram per bucket alongside count, sum and max", async () => {
  const delivered = [];
  const client = { deliverPerformanceSamples: async (samples) => { delivered.push(samples); return "delivered"; } };

  const flusher = new PerformanceFlusher(newConfiguration(), client);
  for (const duration of [10, 40, 120, 700, 12000]) {
    flusher.record("GET /posts", duration);
  }
  await flusher.flush();

  const sample = delivered[0][0];
  assert.deepEqual(sample.histogram, { 50: 2, 250: 1, 1000: 1, inf: 1 });
  const total = Object.values(sample.histogram).reduce((a, b) => a + b, 0);
  assert.equal(total, sample.request_count);
});

test("keeps histogram counts for the next flush when delivery fails", async () => {
  const client = { deliverPerformanceSamples: async () => "failed" };

  const flusher = new PerformanceFlusher(newConfiguration(), client);
  flusher.record("GET /posts", 10);
  await flusher.flush();

  const delivered = [];
  client.deliverPerformanceSamples = async (samples) => { delivered.push(samples); return "delivered"; };
  flusher.record("GET /posts", 300);
  await flusher.flush();

  assert.deepEqual(delivered[0][0].histogram, { 50: 1, 500: 1 });
});

test("a record that lands during delivery is never lost and is sent on the next flush", async () => {
  const delivered = [];
  let flusher;
  const client = {
    deliverPerformanceSamples: async (samples) => {
      delivered.push(samples);
      // Lands in the window between the snapshot and delivery succeeding: for a bucket already in
      // the snapshot, and for a brand-new one.
      flusher.record("GET /posts", 300);
      flusher.record("GET /new", 5);
      return "delivered";
    },
  };

  flusher = new PerformanceFlusher(newConfiguration(), client);
  flusher.record("GET /posts", 10);
  await flusher.flush();
  assert.deepEqual(delivered[0][0].histogram, { 50: 1 });

  await flusher.flush();
  const second = Object.fromEntries(delivered[1].map((s) => [s.transaction_name, s]));
  assert.equal(second["GET /posts"].request_count, 1);
  assert.deepEqual(second["GET /posts"].histogram, { 500: 1 });
  assert.deepEqual(second["GET /new"].histogram, { 50: 1 });
});

test("a batch the server rejects is dropped and never sent again", async () => {
  const logs = [];
  const configuration = newConfiguration();
  configuration.logger = (message) => logs.push(message);
  const delivered = [];
  const client = { deliverPerformanceSamples: async (samples) => { delivered.push(samples); return "rejected"; } };

  const flusher = new PerformanceFlusher(configuration, client);
  flusher.record("GET /posts", 100);
  await flusher.flush();
  await flusher.flush(); // nothing left: no second delivery
  assert.equal(delivered.length, 1);

  flusher.record("GET /posts", 300);
  await flusher.flush();

  assert.equal(delivered[1][0].request_count, 1);
  assert.deepEqual(delivered[1][0].histogram, { 500: 1 });
  assert.equal(logs.filter((m) => m.includes("dropping 1 performance sample(s): the server rejected them")).length, 2);
});

test("the fifth failed flush in a row drops the batch and starts clean", async () => {
  const logs = [];
  const configuration = newConfiguration();
  configuration.logger = (message) => logs.push(message);
  const delivered = [];
  const client = { deliverPerformanceSamples: async (samples) => { delivered.push(samples); return "failed"; } };

  const flusher = new PerformanceFlusher(configuration, client);
  flusher.record("GET /posts", 100);
  for (let i = 0; i < 4; i++) {
    await flusher.flush();
  }
  assert.equal(logs.length, 0);
  flusher.record("GET /posts", 100);
  await flusher.flush(); // the fifth: gives up on the batch
  await flusher.flush(); // nothing left: no sixth delivery

  assert.equal(delivered.length, 5);
  assert.equal(delivered[4][0].request_count, 2);
  assert.deepEqual(logs, ["[forge-ops-tracker] dropping 1 performance sample(s): 5 flushes in a row failed"]);

  flusher.record("GET /posts", 100);
  await flusher.flush();
  assert.equal(delivered[5][0].request_count, 1);
});

test("a record that lands while a rejected batch is in flight is kept", async () => {
  const delivered = [];
  let flusher;
  const client = {
    deliverPerformanceSamples: async (samples) => {
      delivered.push(samples);
      if (delivered.length === 1) {
        flusher.record("GET /posts", 300);
      }
      return "rejected";
    },
  };

  flusher = new PerformanceFlusher(newConfiguration(), client);
  flusher.record("GET /posts", 10);
  await flusher.flush();
  await flusher.flush();

  assert.equal(delivered[1][0].request_count, 1);
  assert.deepEqual(delivered[1][0].histogram, { 500: 1 });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Configuration } from "../src/configuration.js";
import { DeliveryQueue } from "../src/deliveryQueue.js";

function newConfiguration(queueSize = 1) {
  const config = new Configuration();
  config.queueSize = queueSize;
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

test("delivers a pushed payload via the client on its background processing loop", async () => {
  const delivered = [];
  const client = { deliver: async (payload) => void delivered.push(payload) };

  const queue = new DeliveryQueue(newConfiguration(10), client);
  queue.push({ exception_class: "RuntimeError" });

  await waitUntil(() => delivered.length === 1);
  assert.deepEqual(delivered[0], { exception_class: "RuntimeError" });
});

test("drops a payload without blocking when the queue is already full", async () => {
  // A client whose delivery never resolves, so nothing drains the queue
  // and capacity stays exactly at queueSize (1) for a deterministic
  // full-queue test.
  const client = { deliver: () => new Promise(() => {}) };
  const queue = new DeliveryQueue(newConfiguration(1), client);

  assert.equal(queue.push({ n: 1 }), true);

  // The first push may already have been picked up by the processing
  // loop (draining the queue before it observes "full"), so retry
  // briefly rather than asserting on a single racy attempt.
  const deadline = Date.now() + 500;
  let secondPushResult = true;
  while (Date.now() < deadline) {
    secondPushResult = queue.push({ n: 2 });
    if (!secondPushResult) break;
  }

  assert.equal(secondPushResult, false);
});

test("calls a custom deliverMethod when given one, defaulting to deliver otherwise", async () => {
  const delivered = [];
  const client = { deliverSpans: async (payload) => void delivered.push(payload) };

  const queue = new DeliveryQueue(newConfiguration(10), client, { deliverMethod: "deliverSpans", label: "trace" });
  queue.push({ trace_id: "abc123", spans: [] });

  await waitUntil(() => delivered.length === 1);
  assert.deepEqual(delivered[0], { trace_id: "abc123", spans: [] });
});

test("uses the given label when logging a dropped payload on a full queue", async () => {
  const logs = [];
  const configuration = newConfiguration(1);
  configuration.logger = (message) => logs.push(message);
  // A client whose delivery never resolves, same as the plain DeliveryQueue full-queue test
  // above, so capacity stays exactly at queueSize (1) for a deterministic full-queue log.
  const client = { deliverSpans: () => new Promise(() => {}) };
  const queue = new DeliveryQueue(configuration, client, { deliverMethod: "deliverSpans", label: "trace" });

  queue.push({ n: 1 });
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && logs.length === 0) {
    queue.push({ n: 2 });
  }

  assert.ok(logs.some((m) => m.includes("dropping trace")));
});

test("recovers from the client throwing instead of resolving", async () => {
  const delivered = [];
  let callCount = 0;
  const client = {
    deliver: async (payload) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("boom");
      }
      delivered.push(payload);
    },
  };

  // A larger queue than the other tests, so both pushes below can be
  // enqueued regardless of exactly when the processing loop gets
  // scheduled.
  const queue = new DeliveryQueue(newConfiguration(10), client);
  queue.push({ n: 1 }); // rejects inside the processing loop; must not kill it
  queue.push({ n: 2 });

  await waitUntil(() => delivered.length === 1);
  assert.deepEqual(delivered[0], { n: 2 });
});

test("a payload the server rejects is dropped, logged once, and never sent again", async () => {
  const logs = [];
  const configuration = newConfiguration(10);
  configuration.logger = (message) => logs.push(message);
  const attempts = [];
  const client = { deliver: async (payload) => { attempts.push(payload); return "rejected"; } };

  const queue = new DeliveryQueue(configuration, client);
  queue.push({ n: 1 });
  await queue.whenIdle();
  queue.push({ n: 2 });
  await queue.whenIdle();

  assert.deepEqual(attempts, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(logs, [
    "[forge-ops-tracker] the server rejected the event, dropping it",
    "[forge-ops-tracker] the server rejected the event, dropping it",
  ]);
});

test("a failed delivery logs nothing more and does not stop the payloads queued after it", async () => {
  const logs = [];
  const configuration = newConfiguration(10);
  configuration.logger = (message) => logs.push(message);
  const attempts = [];
  const client = { deliver: async (payload) => { attempts.push(payload); return attempts.length === 1 ? "failed" : "delivered"; } };

  const queue = new DeliveryQueue(configuration, client);
  queue.push({ n: 1 });
  queue.push({ n: 2 });
  await queue.whenIdle();

  assert.deepEqual(attempts, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(logs, []);
});

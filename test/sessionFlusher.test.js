import assert from "node:assert/strict";
import { test } from "node:test";
import { Configuration } from "../src/configuration.js";
import { SessionFlusher } from "../src/sessionFlusher.js";

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

test("aggregates counts and delivers a snapshot, resetting after a successful flush", async () => {
  const delivered = [];
  const client = { deliverSessionCheckin: async (payload) => { delivered.push(payload); return "delivered"; } };

  const flusher = new SessionFlusher(newConfiguration(), client);
  flusher.recordSession(false);
  flusher.recordSession(true);
  flusher.recordSession(false);
  await flusher.flush();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sessions_count, 3);
  assert.equal(delivered[0].crashed_sessions_count, 1);
  assert.equal(delivered[0].release, "1.2.3");
  assert.equal(delivered[0].environment, "production");

  // Nothing new was recorded since the successful flush above, so this one sends nothing.
  await flusher.flush();
  assert.equal(delivered.length, 1);
});

test("does nothing on a flush with no sessions recorded", async () => {
  let called = false;
  const client = { deliverSessionCheckin: async () => { called = true; return "delivered"; } };

  await new SessionFlusher(newConfiguration(), client).flush();

  assert.equal(called, false);
});

test("keeps the counts for the next flush instead of losing them when delivery fails", async () => {
  const client = { deliverSessionCheckin: async () => "failed" };

  const flusher = new SessionFlusher(newConfiguration(), client);
  flusher.recordSession(false);
  await flusher.flush();

  const delivered = [];
  client.deliverSessionCheckin = async (payload) => { delivered.push(payload); return "delivered"; };
  flusher.recordSession(false);
  await flusher.flush();

  assert.equal(delivered[0].sessions_count, 2);
});

test("the interval timer flushes on its own after the configured interval", async () => {
  const delivered = [];
  const client = { deliverSessionCheckin: async (payload) => { delivered.push(payload); return "delivered"; } };

  const configuration = newConfiguration();
  configuration.sessionFlushIntervalMs = 20;

  const flusher = new SessionFlusher(configuration, client);
  flusher.recordSession(false);

  await waitUntil(() => delivered.length === 1);
  assert.equal(delivered[0].sessions_count, 1);
});

test("the interval timer survives the client throwing instead of resolving", async () => {
  const delivered = [];
  let callCount = 0;
  const client = {
    deliverSessionCheckin: async (payload) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("boom");
      }
      delivered.push(payload);
      return "delivered";
    },
  };

  const configuration = newConfiguration();
  configuration.sessionFlushIntervalMs = 20;

  const flusher = new SessionFlusher(configuration, client);
  flusher.recordSession(false); // the first tick rejects; must not stop the timer

  // A later tick recovers and delivers on its own; a dead timer would leave this array empty
  // forever and time out instead.
  await waitUntil(() => delivered.length === 1);
});

test("counts the server rejects are dropped and never sent again", async () => {
  const logs = [];
  const configuration = newConfiguration();
  configuration.logger = (message) => logs.push(message);
  const delivered = [];
  const client = { deliverSessionCheckin: async (payload) => { delivered.push(payload); return "rejected"; } };

  const flusher = new SessionFlusher(configuration, client);
  flusher.recordSession(false);
  flusher.recordSession(true);
  await flusher.flush();
  await flusher.flush(); // nothing left: no second delivery
  assert.equal(delivered.length, 1);

  flusher.recordSession(false);
  await flusher.flush();

  assert.equal(delivered[1].sessions_count, 1);
  assert.equal(delivered[1].crashed_sessions_count, 0);
  assert.equal(logs[0], "[forge-ops-tracker] dropping 2 session count(s): the server rejected them");
});

test("the fifth failed flush in a row drops the counts and starts clean", async () => {
  const logs = [];
  const configuration = newConfiguration();
  configuration.logger = (message) => logs.push(message);
  const delivered = [];
  const client = { deliverSessionCheckin: async (payload) => { delivered.push(payload); return "failed"; } };

  const flusher = new SessionFlusher(configuration, client);
  flusher.recordSession(false);
  for (let i = 0; i < 4; i++) {
    await flusher.flush();
  }
  assert.equal(logs.length, 0);
  await flusher.flush(); // the fifth: gives up on the counts
  await flusher.flush(); // nothing left: no sixth delivery

  assert.equal(delivered.length, 5);
  assert.deepEqual(logs, ["[forge-ops-tracker] dropping 1 session count(s): 5 flushes in a row failed"]);

  flusher.recordSession(false);
  await flusher.flush();
  assert.equal(delivered[5].sessions_count, 1);
});

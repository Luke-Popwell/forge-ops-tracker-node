import assert from "node:assert/strict";
import { test } from "node:test";
import { Configuration } from "../src/configuration.js";
import { Reporter } from "../src/reporter.js";

function enabledConfiguration() {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.enabledEnvironments = new Set(["production"]);
  config.environment = "production";
  return config;
}

test("builds and enqueues a payload when reporting is enabled", () => {
  const configuration = enabledConfiguration();
  const builtPayload = { exception_class: "RuntimeError" };
  const buildCalls = [];
  const pushCalls = [];
  const eventBuilder = { build: (error, context) => (buildCalls.push([error, context]), builtPayload) };
  const deliveryQueue = { push: (payload) => pushCalls.push(payload) };

  const reporter = new Reporter(configuration, eventBuilder, deliveryQueue);
  const error = new Error("boom");
  const context = { a: 1 };

  reporter.report(error, context);

  assert.deepEqual(buildCalls, [[error, context]]);
  assert.deepEqual(pushCalls, [builtPayload]);
});

test("passes the user through to the event builder", () => {
  const configuration = enabledConfiguration();
  const buildCalls = [];
  const eventBuilder = { build: (error, context, user) => (buildCalls.push([error, context, user]), {}) };
  const deliveryQueue = { push: () => {} };

  const reporter = new Reporter(configuration, eventBuilder, deliveryQueue);
  const error = new Error("boom");
  const user = { id: 42, email: "alice@example.com" };

  reporter.report(error, {}, user);

  assert.deepEqual(buildCalls, [[error, {}, user]]);
});

test("passes breadcrumbs through to the event builder", () => {
  const configuration = enabledConfiguration();
  const buildCalls = [];
  const eventBuilder = { build: (error, context, user, breadcrumbs) => (buildCalls.push(breadcrumbs), {}) };
  const deliveryQueue = { push: () => {} };

  const reporter = new Reporter(configuration, eventBuilder, deliveryQueue);
  const breadcrumbs = [{ category: "custom", message: "checkpoint" }];

  reporter.report(new Error("boom"), {}, null, breadcrumbs);

  assert.deepEqual(buildCalls, [breadcrumbs]);
});

test("does nothing when reporting is disabled", () => {
  const configuration = enabledConfiguration();
  configuration.environment = "development"; // not in enabledEnvironments
  let pushCallCount = 0;
  const eventBuilder = { build: () => ({}) };
  const deliveryQueue = { push: () => (pushCallCount += 1) };

  new Reporter(configuration, eventBuilder, deliveryQueue).report(new Error("boom"));

  assert.equal(pushCallCount, 0);
});

test("never throws even if building the event fails", () => {
  const configuration = enabledConfiguration();
  const eventBuilder = {
    build: () => {
      throw new Error("event builder exploded");
    },
  };
  const deliveryQueue = { push: () => {} };

  assert.doesNotThrow(() => {
    new Reporter(configuration, eventBuilder, deliveryQueue).report(new Error("boom"));
  });
});

test("never throws even if enqueueing fails", () => {
  const configuration = enabledConfiguration();
  const eventBuilder = { build: () => ({}) };
  const deliveryQueue = {
    push: () => {
      throw new Error("queue exploded");
    },
  };

  assert.doesNotThrow(() => {
    new Reporter(configuration, eventBuilder, deliveryQueue).report(new Error("boom"));
  });
});

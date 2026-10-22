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

function mockFetchCapturing() {
  const requests = [];
  globalThis.fetch = async (uri, init) => {
    requests.push({ uri, init });
    return new Response(null, { status: 202 });
  };
  return requests;
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgeOpsTracker._resetForTesting();
});

test("init configures and returns the configuration", () => {
  const config = forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    release: "abc123",
  });

  assert.equal(config.dsn, "https://key@tracker.example.com/api/v1/events");
  assert.equal(config.release, "abc123");
});

test("init rejects an unknown configuration property", () => {
  assert.throws(() => {
    forgeOpsTracker.init({ notARealSetting: true });
  }, TypeError);
});

test("captureException delivers through the full stack", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
  });

  try {
    throw new Error("boom");
  } catch (error) {
    forgeOpsTracker.captureException(error);
  }

  await waitUntil(() => requests.length === 1);
  assert.equal(requests[0].init.headers.Authorization, "Bearer key");
});

test("runWithUser attaches the user to a captureException call made anywhere in that async chain", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
  });

  await forgeOpsTracker.runWithUser({ id: 42, email: "alice@example.com" }, async () => {
    await Promise.resolve(); // confirms this survives a real async hop, not just a sync call
    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error);
    }
  });

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.user, { id: 42, email: "alice@example.com" });
});

test("an explicit user argument overrides whatever runWithUser established", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
  });

  forgeOpsTracker.runWithUser({ id: 42 }, () => {
    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error, {}, { id: 99 });
    }
  });

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.user, { id: 99 });
});

test("captureException carries no user at all outside runWithUser", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
  });

  try {
    throw new Error("boom");
  } catch (error) {
    forgeOpsTracker.captureException(error);
  }

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal("user" in body, false);
});

/**
 * Captures whatever listener functions init() actually passes to
 * process.on(), without genuinely registering them on the real process
 * object. Needed because actually emitting "uncaughtExceptionMonitor"/
 * "unhandledRejection" via process.emit() also triggers Node's own test
 * runner, which has its own listener for these events specifically to
 * fail a test when a *real* unhandled rejection happens during it,
 * found by actually running this, not assumed. Intercepting process.on
 * instead gets the real listener function this client installs, testable
 * as a plain function call with no such side effect.
 */
function captureProcessListeners(fn) {
  const registered = {};
  const originalOn = process.on;
  process.on = (event, listener) => {
    registered[event] = listener;
    return process;
  };
  try {
    fn();
  } finally {
    process.on = originalOn;
  }
  return registered;
}

test("uncaughtExceptionMonitor listener reports without needing to touch Node's own crash behavior", async () => {
  const requests = mockFetchCapturing();
  const listeners = captureProcessListeners(() => {
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });
  });

  // Node's own guarantee that this event never suppresses the default
  // crash behavior was verified separately, directly against a real
  // uncaught throw in a real process (not assumed, and not re-verified
  // here): this just confirms the listener itself reports correctly.
  listeners.uncaughtExceptionMonitor(new Error("uncaught"));

  await waitUntil(() => requests.length === 1);
  assert.equal(requests[0].init.headers.Authorization, "Bearer key");
});

test("unhandledRejection listener reports a rejection the app also listens for", async () => {
  const requests = mockFetchCapturing();
  const listeners = captureProcessListeners(() => {
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });
  });

  // The app's own listener alongside this client's: Node won't crash, so the listener only
  // reports. (Being the only listener, where it re-raises instead, is covered for real in
  // test/processExit.test.js.)
  const originalListenerCount = process.listenerCount;
  process.listenerCount = (event) => (event === "unhandledRejection" ? 2 : originalListenerCount.call(process, event));
  try {
    listeners.unhandledRejection(new Error("rejected"), Promise.resolve());
  } finally {
    process.listenerCount = originalListenerCount;
  }

  await waitUntil(() => requests.length === 1);
  assert.equal(requests[0].init.headers.Authorization, "Bearer key");
});

test("installProcessHandlers: false leaves process listeners untouched", () => {
  const events = ["uncaughtExceptionMonitor", "uncaughtException", "unhandledRejection"];
  const before = events.map((event) => process.listenerCount(event));

  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    installProcessHandlers: false,
  });

  assert.deepEqual(events.map((event) => process.listenerCount(event)), before);
});

test("flush resolves true right away when nothing was ever captured", async () => {
  assert.equal(await forgeOpsTracker.flush(10), true);
});

test("flush resolves true once a captured error has been delivered", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  forgeOpsTracker.captureException(new Error("boom"));
  forgeOpsTracker.recordChange({ kind: "config", title: "Raised the pool size" });

  assert.equal(await forgeOpsTracker.flush(1000), true);
  assert.equal(requests.length, 2);
});

test("flush resolves false once the timeout passes, without waiting for a delivery that hangs", async () => {
  globalThis.fetch = () => new Promise(() => {});
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  forgeOpsTracker.captureException(new Error("boom"));

  const startedAt = Date.now();
  assert.equal(await forgeOpsTracker.flush(50), false);
  assert.ok(Date.now() - startedAt < 1000);
});

test("addBreadcrumb lazily creates its own standalone buffer outside any _runWithBreadcrumbTrail wrapping", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  // No middleware, no runWithBreadcrumbTrail: this is the "plain script" case.
  forgeOpsTracker.addBreadcrumb("app booted", { category: "lifecycle" });
  forgeOpsTracker.addBreadcrumb("connected to db");

  try {
    throw new Error("boom");
  } catch (error) {
    forgeOpsTracker.captureException(error);
  }

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.breadcrumbs.length, 2);
  assert.equal(body.breadcrumbs[0].message, "app booted");
  assert.equal(body.breadcrumbs[0].category, "lifecycle");
  assert.equal(body.breadcrumbs[1].message, "connected to db");
  assert.equal(body.breadcrumbs[1].category, "custom");
});

test("captureException carries no breadcrumbs key at all when none were ever added", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  try {
    throw new Error("boom");
  } catch (error) {
    forgeOpsTracker.captureException(error);
  }

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal("breadcrumbs" in body, false);
});

test("_runWithBreadcrumbTrail scopes a fresh buffer to callback's own async chain, visible to captureException at the end", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  await forgeOpsTracker._runWithBreadcrumbTrail(async () => {
    forgeOpsTracker.addBreadcrumb("step one");
    await Promise.resolve(); // confirms this survives a real async hop
    forgeOpsTracker.addBreadcrumb("step two");
    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error);
    }
  });

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(
    body.breadcrumbs.map((b) => b.message),
    ["step one", "step two"],
  );
});

test("two concurrent, interleaved _runWithBreadcrumbTrail calls never bleed into each other's trail", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  async function runTrail(label, delayMs) {
    await forgeOpsTracker._runWithBreadcrumbTrail(async () => {
      forgeOpsTracker.addBreadcrumb(`${label}-start`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      forgeOpsTracker.addBreadcrumb(`${label}-end`);
      try {
        throw new Error(`boom-${label}`);
      } catch (error) {
        forgeOpsTracker.captureException(error);
      }
    });
  }

  // A is slower than B, so their event-loop turns genuinely interleave, not just run back-to-back.
  await Promise.all([runTrail("A", 30), runTrail("B", 5)]);

  await waitUntil(() => requests.length === 2);
  const bodies = requests.map((r) => JSON.parse(r.init.body));
  const forA = bodies.find((b) => b.message === "boom-A");
  const forB = bodies.find((b) => b.message === "boom-B");

  assert.deepEqual(
    forA.breadcrumbs.map((b) => b.message),
    ["A-start", "A-end"],
  );
  assert.deepEqual(
    forB.breadcrumbs.map((b) => b.message),
    ["B-start", "B-end"],
  );
});

test("_runWithBreadcrumbTrail sets up no buffer at all when trackBreadcrumbs is off", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    trackBreadcrumbs: false,
    installProcessHandlers: false,
  });

  await forgeOpsTracker._runWithBreadcrumbTrail(async () => {
    // addBreadcrumb still works standalone (lazily creates its own buffer), matching
    // gems/forge_ops_tracker's own "manual API isn't gated by the flag" contract, but that
    // buffer is a fresh one it made itself, not one _runWithBreadcrumbTrail set up.
    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error);
    }
  });

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal("breadcrumbs" in body, false);
});

test("_recordBreadcrumb is a no-op when trackBreadcrumbs is off", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    trackBreadcrumbs: false,
    installProcessHandlers: false,
  });

  await forgeOpsTracker._runWithBreadcrumbTrail(async () => {
    forgeOpsTracker._recordBreadcrumb("GET /users", "controller");
    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error);
    }
  });

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal("breadcrumbs" in body, false);
});

test("span outside any request-level trace just runs the callback and records nothing", () => {
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  const result = forgeOpsTracker.span("PaymentService.charge", () => 42);
  assert.equal(result, 42); // must not throw, and must not fabricate a trace with nothing to belong to
});

test("span propagates a synchronous throw from the callback unchanged", () => {
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  assert.throws(() => {
    forgeOpsTracker.span("PaymentService.charge", () => {
      throw new Error("card declined");
    });
  }, /card declined/);
});

test("a slow trace delivers root/service/leaf spans correctly nested, with environment/release stamped on each", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    release: "v2.41.0",
    traceCaptureThresholdMs: 0, // any completed root span counts as slow, for a deterministic test
    installProcessHandlers: false,
  });

  await forgeOpsTracker._runWithSpanTrace(async () => {
    const rootStartedAt = new Date();
    await forgeOpsTracker.span("PaymentService.charge", async () => {
      await Promise.resolve(); // confirms this survives a real async hop
      forgeOpsTracker._recordSpan("GET api.stripe.com", "http", new Date(), 5, { status: 200 });
    });
    forgeOpsTracker._finishSpanTrace("CheckoutController#create", rootStartedAt, 10);
  });

  await waitUntil(() => requests.length === 1);
  assert.ok(requests[0].uri.toString().endsWith("/api/v1/spans"));
  const body = JSON.parse(requests[0].init.body);

  assert.equal(typeof body.trace_id, "string");
  assert.equal(body.spans.length, 3);

  const root = body.spans.find((s) => s.kind === "controller");
  const service = body.spans.find((s) => s.kind === "service");
  const leaf = body.spans.find((s) => s.kind === "http");

  assert.equal(root.parent_span_id, null);
  assert.equal(root.name, "CheckoutController#create");
  assert.equal(root.environment, "production");
  assert.equal(root.release, "v2.41.0");

  assert.equal(service.parent_span_id, root.span_id);
  assert.equal(service.name, "PaymentService.charge");

  assert.equal(leaf.parent_span_id, service.span_id);
  assert.equal(leaf.name, "GET api.stripe.com");
  assert.deepEqual(leaf.data, { status: 200 });
});

test("a fast trace (below traceCaptureThresholdMs) is discarded, never sent", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    traceCaptureThresholdMs: 1000,
    installProcessHandlers: false,
  });

  await forgeOpsTracker._runWithSpanTrace(async () => {
    forgeOpsTracker._finishSpanTrace("CheckoutController#create", new Date(), 5);
  });

  // Give any errant delivery a moment to show up; none should.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests.length, 0);
});

test("_recordSpan is a no-op with no request-level trace open at all", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  // No _runWithSpanTrace wrapping at all: must not throw, and there's nothing to send.
  forgeOpsTracker._recordSpan("GET api.stripe.com", "http", new Date(), 5);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests.length, 0);
});

test("_runWithSpanTrace sets up no buffer at all when trackTracing is off", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    trackTracing: false,
    traceCaptureThresholdMs: 0,
    installProcessHandlers: false,
  });

  await forgeOpsTracker._runWithSpanTrace(async () => {
    forgeOpsTracker._finishSpanTrace("CheckoutController#create", new Date(), 5000);
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests.length, 0);
});

test("two concurrently-awaited span() calls in the same trace never mis-nest under each other", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    traceCaptureThresholdMs: 0,
    installProcessHandlers: false,
  });

  await forgeOpsTracker._runWithSpanTrace(async () => {
    const rootStartedAt = new Date();
    await Promise.all([
      forgeOpsTracker.span("ServiceA", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }),
      forgeOpsTracker.span("ServiceB", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
    ]);
    forgeOpsTracker._finishSpanTrace("CheckoutController#create", rootStartedAt, 30);
  });

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  const root = body.spans.find((s) => s.name === "CheckoutController#create");
  const a = body.spans.find((s) => s.name === "ServiceA");
  const b = body.spans.find((s) => s.name === "ServiceB");

  // Both are the root's own direct children, siblings of each other, not one nested under the
  // other: the bug a shared mutable stack (rather than nested AsyncLocalStorage) would produce.
  assert.equal(a.parent_span_id, root.span_id);
  assert.equal(b.parent_span_id, root.span_id);
});

test("breadcrumb message/data are scrubbed for likely PII, the same as message/backtrace/context", async () => {
  const requests = mockFetchCapturing();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });

  await forgeOpsTracker._runWithBreadcrumbTrail(async () => {
    forgeOpsTracker.addBreadcrumb("failed for user@example.com", { data: { password: "hunter2" } });
    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error);
    }
  });

  await waitUntil(() => requests.length === 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.breadcrumbs[0].message, "failed for [EMAIL FILTERED]");
  assert.deepEqual(body.breadcrumbs[0].data, { password: "[FILTERED]" });
});

function capturingWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    callback();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

test("init warns once when a DSN is set but the environment isn't enabled", () => {
  const options = { dsn: "https://key@tracker.example.com/api/v1/events", environment: "development", detectChanges: false };
  const warnings = capturingWarnings(() => {
    forgeOpsTracker.init(options);
    forgeOpsTracker.init(options);
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[ForgeOps\] Not sending: this environment is "development"/);
});

test("init doesn't warn without a DSN, or in an enabled environment", () => {
  const warnings = capturingWarnings(() => {
    forgeOpsTracker.init({ dsn: null, environment: "development", detectChanges: false });
    forgeOpsTracker.init({ dsn: "https://key@tracker.example.com/api/v1/events", environment: "production", detectChanges: false });
  });

  assert.deepEqual(warnings, []);
});

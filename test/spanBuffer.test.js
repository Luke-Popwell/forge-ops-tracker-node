import assert from "node:assert/strict";
import { test } from "node:test";
import { Configuration } from "../src/configuration.js";
import { randomSpanId, SpanBuffer } from "../src/spanBuffer.js";

function newConfiguration() {
  const config = new Configuration();
  config.environment = "production";
  config.release = "1.2.3";
  return config;
}

test("randomSpanId returns a short, unique-looking hex string each time", () => {
  const first = randomSpanId();
  const second = randomSpanId();

  assert.match(first, /^[0-9a-f]{16}$/);
  assert.notEqual(first, second);
});

test("constructor generates a distinct traceId and rootSpanId", () => {
  const buffer = new SpanBuffer(newConfiguration());

  assert.match(buffer.traceId, /^[0-9a-f]{32}$/);
  assert.match(buffer.rootSpanId, /^[0-9a-f]{16}$/);
  assert.notEqual(buffer.traceId, buffer.rootSpanId);
});

test("record stamps environment/release from configuration and formats started_at with millisecond precision UTC", () => {
  const buffer = new SpanBuffer(newConfiguration());

  buffer.record({
    spanId: "abc123",
    parentSpanId: null,
    name: "PaymentService.charge",
    kind: "service",
    startedAt: new Date("2026-01-01T10:00:00.123Z"),
    durationMs: 42.5,
  });

  const span = buffer.spans[0];
  assert.equal(span.span_id, "abc123");
  assert.equal(span.name, "PaymentService.charge");
  assert.equal(span.kind, "service");
  assert.equal(span.started_at, "2026-01-01T10:00:00.123Z");
  assert.equal(span.duration_ms, 42.5);
  assert.equal(span.environment, "production");
  assert.equal(span.release, "1.2.3");
  assert.deepEqual(span.data, {});
});

test("root: true forces parent_span_id null even when a parentSpanId is also given", () => {
  const buffer = new SpanBuffer(newConfiguration());

  buffer.record({
    spanId: buffer.rootSpanId,
    parentSpanId: "should-be-ignored",
    name: "CheckoutController#create",
    kind: "controller",
    startedAt: new Date(),
    durationMs: 1800,
    root: true,
  });

  assert.equal(buffer.spans[0].parent_span_id, null);
});

test("a non-root span keeps whatever parentSpanId it was given", () => {
  const buffer = new SpanBuffer(newConfiguration());

  buffer.record({
    spanId: "leaf1",
    parentSpanId: buffer.rootSpanId,
    name: "GET api.stripe.com",
    kind: "http",
    startedAt: new Date(),
    durationMs: 12,
  });

  assert.equal(buffer.spans[0].parent_span_id, buffer.rootSpanId);
});

test("isSlow is false until the root span has actually been recorded, regardless of threshold", () => {
  const buffer = new SpanBuffer(newConfiguration());
  assert.equal(buffer.isSlow(0), false);

  buffer.record({
    spanId: "leaf1",
    parentSpanId: buffer.rootSpanId,
    name: "GET api.stripe.com",
    kind: "http",
    startedAt: new Date(),
    durationMs: 5000,
  });
  // Only a leaf span so far, no root: still not slow no matter the threshold.
  assert.equal(buffer.isSlow(0), false);
});

test("isSlow compares the root span's own duration against the threshold", () => {
  const buffer = new SpanBuffer(newConfiguration());
  buffer.record({
    spanId: buffer.rootSpanId,
    name: "CheckoutController#create",
    kind: "controller",
    startedAt: new Date(),
    durationMs: 1000,
    root: true,
  });

  assert.equal(buffer.isSlow(1000), true);
  assert.equal(buffer.isSlow(1001), false);
  assert.equal(buffer.isSlow(999), true);
});

test("uses a given trace id and records the root span under a remote parent", () => {
  const buffer = new SpanBuffer(newConfiguration(), { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "00f067aa0ba902b7" });
  buffer.record({ spanId: buffer.rootSpanId, name: "GET /checkout", kind: "controller", startedAt: new Date(), durationMs: 5, root: true });

  assert.equal(buffer.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(buffer.spans[0].parent_span_id, "00f067aa0ba902b7");
});

test("generates W3C shaped ids, and rootRecorded turns true once the root is recorded", () => {
  const buffer = new SpanBuffer(newConfiguration());
  assert.match(buffer.traceId, /^[0-9a-f]{32}$/);
  assert.equal(buffer.rootRecorded, false);

  buffer.record({ spanId: buffer.rootSpanId, name: "GET /checkout", kind: "controller", startedAt: new Date(), durationMs: 5, root: true });
  assert.equal(buffer.rootRecorded, true);
  assert.equal(buffer.spans[0].parent_span_id, null);
});

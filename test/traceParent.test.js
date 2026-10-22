import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTraceparent, generateSpanId, generateTraceId, parseTraceparent } from "../src/traceParent.js";
import { RequestState } from "../src/requestState.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";

test("parses a valid version 00 header", () => {
  assert.deepEqual(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-01`), { traceId: TRACE_ID, parentSpanId: PARENT_ID });
});

test("accepts an unsampled flag and surrounding whitespace", () => {
  assert.deepEqual(parseTraceparent(`  00-${TRACE_ID}-${PARENT_ID}-00 `), { traceId: TRACE_ID, parentSpanId: PARENT_ID });
});

test("accepts a future version with extra fields", () => {
  assert.deepEqual(parseTraceparent(`cc-${TRACE_ID}-${PARENT_ID}-01-what-the-future-holds`), { traceId: TRACE_ID, parentSpanId: PARENT_ID });
});

test("rejects anything that is not a usable header", () => {
  const invalid = [
    undefined,
    null,
    "",
    42,
    ["00-" + TRACE_ID + "-" + PARENT_ID + "-01"],
    "garbage",
    `00-${TRACE_ID}-${PARENT_ID}`,
    `00-${TRACE_ID.toUpperCase()}-${PARENT_ID}-01`,
    `00-${TRACE_ID}-${PARENT_ID.toUpperCase()}-01`,
    `ff-${TRACE_ID}-${PARENT_ID}-01`,
    `00-${"0".repeat(32)}-${PARENT_ID}-01`,
    `00-${TRACE_ID}-${"0".repeat(16)}-01`,
    `00-${TRACE_ID}-${PARENT_ID}-01-extra`,
    `00-${TRACE_ID.slice(1)}-${PARENT_ID}-01`,
    `00-${TRACE_ID}-${PARENT_ID}0-01`,
    `00-${TRACE_ID}-${PARENT_ID}-1`,
    `00_${TRACE_ID}_${PARENT_ID}_01`,
    `00-${TRACE_ID}-${PARENT_ID}-0\n1`,
  ];
  for (const value of invalid) {
    assert.equal(parseTraceparent(value), null, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test("builds a sampled version 00 header that parses back", () => {
  const traceId = generateTraceId();
  const spanId = generateSpanId();

  assert.equal(buildTraceparent(TRACE_ID, PARENT_ID), `00-${TRACE_ID}-${PARENT_ID}-01`);
  assert.deepEqual(parseTraceparent(buildTraceparent(traceId, spanId)), { traceId, parentSpanId: spanId });
});

test("generated ids are W3C shaped lowercase hex, never all zeros", () => {
  for (let i = 0; i < 50; i++) {
    assert.match(generateTraceId(), /^(?!0+$)[0-9a-f]{32}$/);
    assert.match(generateSpanId(), /^(?!0+$)[0-9a-f]{16}$/);
  }
});

test("RequestState continues a valid traceparent and starts fresh otherwise", () => {
  const continued = RequestState.fromTraceparent(`00-${TRACE_ID}-${PARENT_ID}-01`);
  assert.equal(continued.traceId, TRACE_ID);
  assert.equal(continued.parentSpanId, PARENT_ID);

  const fresh = RequestState.fromTraceparent("nonsense");
  assert.match(fresh.traceId, /^[0-9a-f]{32}$/);
  assert.equal(fresh.parentSpanId, null);
});

test("RequestState reads a lazily described route each time, and never throws from it", () => {
  const state = new RequestState();
  assert.equal(state.transactionName, null);

  let route = null;
  state.describeWith(() => (route ? { transactionName: `GET ${route}`, endpoint: `GET ${route}` } : null));
  assert.equal(state.endpoint, null);
  route = "/orders/:id";
  assert.equal(state.transactionName, "GET /orders/:id");

  state.describeWith(() => {
    throw new Error("broken");
  });
  assert.equal(state.endpoint, null);
});

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Client } from "../src/client.js";
import { Configuration } from "../src/configuration.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function newConfiguration(dsn = "https://secret-key@tracker.example.com/api/v1/events") {
  const config = new Configuration();
  config.dsn = dsn;
  return config;
}

test("returns delivered on a successful response", async () => {
  globalThis.fetch = async () => new Response(null, { status: 202 });
  const client = new Client(newConfiguration());

  assert.equal(await client.deliver({ exception_class: "RuntimeError" }), "delivered");
});

test("returns rejected on a 4xx the server will never accept", async () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    globalThis.fetch = async () => new Response(null, { status });
    const client = new Client(newConfiguration());

    assert.equal(await client.deliver({ exception_class: "RuntimeError" }), "rejected", `status ${status}`);
  }
});

test("returns failed on a 5xx, a 408 and a 429, which may go through later", async () => {
  for (const status of [408, 429, 500, 502, 503]) {
    globalThis.fetch = async () => new Response(null, { status });
    const client = new Client(newConfiguration());

    assert.equal(await client.deliver({ exception_class: "RuntimeError" }), "failed", `status ${status}`);
  }
});

test("returns failed without throwing when the request throws a network error", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const client = new Client(newConfiguration());

  const result = await client.deliver({ exception_class: "RuntimeError" }); // must not throw
  assert.equal(result, "failed");
});

test("returns failed when there is no DSN configured", async () => {
  globalThis.fetch = async () => new Response(null, { status: 202 });
  const client = new Client(newConfiguration(null));

  assert.equal(await client.deliver({ exception_class: "RuntimeError" }), "failed");
});

test("sends the api key as a bearer token and the payload as JSON", async () => {
  let capturedUri;
  let capturedInit;
  globalThis.fetch = async (uri, init) => {
    capturedUri = uri;
    capturedInit = init;
    return new Response(null, { status: 202 });
  };
  const client = new Client(newConfiguration());

  await client.deliver({ exception_class: "RuntimeError", message: "boom" });

  assert.equal(capturedUri, "https://tracker.example.com/api/v1/events");
  assert.equal(capturedInit.headers.Authorization, "Bearer secret-key");
  assert.deepEqual(JSON.parse(capturedInit.body), { exception_class: "RuntimeError", message: "boom" });
});

test("deliverPerformanceSamples posts the batch wrapped in samples to the performance_samples path", async () => {
  let capturedUri;
  let capturedInit;
  globalThis.fetch = async (uri, init) => {
    capturedUri = uri;
    capturedInit = init;
    return new Response(null, { status: 202 });
  };
  const client = new Client(newConfiguration());

  const result = await client.deliverPerformanceSamples([ { transaction_name: "GET /posts/:id", request_count: 5 } ]);

  assert.equal(result, "delivered");
  assert.equal(capturedUri, "https://tracker.example.com/api/v1/performance_samples");
  assert.deepEqual(JSON.parse(capturedInit.body), { samples: [ { transaction_name: "GET /posts/:id", request_count: 5 } ] });
});

test("deliverPerformanceSamples returns failed without throwing when the request fails", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const client = new Client(newConfiguration());

  const result = await client.deliverPerformanceSamples([]); // must not throw
  assert.equal(result, "failed");
});

test("deliverSpans posts the trace_id/spans payload as-is to the spans path", async () => {
  let capturedUri;
  let capturedInit;
  globalThis.fetch = async (uri, init) => {
    capturedUri = uri;
    capturedInit = init;
    return new Response(null, { status: 202 });
  };
  const client = new Client(newConfiguration());

  const payload = {
    trace_id: "abc123",
    spans: [{ span_id: "s1", parent_span_id: null, name: "CheckoutController#create", kind: "controller" }],
  };
  const result = await client.deliverSpans(payload);

  assert.equal(result, "delivered");
  assert.equal(capturedUri, "https://tracker.example.com/api/v1/spans");
  assert.deepEqual(JSON.parse(capturedInit.body), payload);
});

test("deliverSpans returns failed without throwing when the request fails", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const client = new Client(newConfiguration());

  const result = await client.deliverSpans({ trace_id: "abc123", spans: [] }); // must not throw
  assert.equal(result, "failed");
});

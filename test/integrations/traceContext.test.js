import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, test } from "node:test";
import express from "express";
import Fastify from "fastify";
import * as forgeOpsTracker from "../../src/index.js";
import { forgeOpsTrackerExpressMiddleware } from "../../src/integrations/express.js";
import { registerForgeOpsTracker } from "../../src/integrations/fastify.js";
import { forgeOpsTrackerTracingExpressMiddleware, registerForgeOpsTrackerTracing } from "../../src/integrations/tracing.js";

// Trace context: every request's trace id, the matched route on its errors, and W3C traceparent
// continuation in both directions, end to end through real Express/Fastify servers.

const INCOMING_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const INCOMING_PARENT_ID = "00f067aa0ba902b7";
const INCOMING_TRACEPARENT = `00-${INCOMING_TRACE_ID}-${INCOMING_PARENT_ID}-01`;

const originalFetch = globalThis.fetch;
const servers = [];

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  forgeOpsTracker._resetForTesting();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function init(requests, overrides = {}) {
  globalThis.fetch = async (uri, requestInit) => {
    if (String(uri).includes("tracker.example.com")) {
      requests.push({ uri: String(uri), init: requestInit });
      return new Response(null, { status: 202 });
    }
    return originalFetch(uri, requestInit);
  };
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
    ...overrides,
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server.address().port;
}

async function waitFor(requests, suffix) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const found = requests.find((r) => r.uri.endsWith(suffix));
    if (found) {
      return JSON.parse(found.init.body);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
}

/** A downstream service recording the traceparent header each request to it carried. */
async function startDownstream() {
  const received = [];
  const port = await listen(
    http.createServer((req, res) => {
      received.push(req.headers.traceparent);
      res.writeHead(200);
      res.end("ok");
    }),
  );
  return { received, port };
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

function expressApp() {
  const app = express();
  app.use(forgeOpsTrackerTracingExpressMiddleware);
  app.get("/orders/:id", () => {
    throw new Error("boom");
  });
  app.get("/orders/:id/handled", (req, res) => {
    forgeOpsTracker.captureException(new Error(`order ${req.params.id} failed`));
    res.send("handled");
  });
  app.use(forgeOpsTrackerExpressMiddleware);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).send("error"));
  return app;
}

async function listenExpress(app) {
  return listen(http.createServer(app));
}

test("Express: an unhandled error carries the route pattern and continues an incoming traceparent", async () => {
  const requests = [];
  init(requests);
  const port = await listenExpress(expressApp());

  assert.equal(await get(port, "/orders/42", { traceparent: INCOMING_TRACEPARENT }), 500);

  const event = await waitFor(requests, "/api/v1/events");
  assert.equal(event.transaction_name, "GET /orders/:id");
  assert.equal(event.endpoint, "GET /orders/:id");
  assert.equal(event.trace_id, INCOMING_TRACE_ID);
});

test("Express: an error captured inside the handler already carries the route and a fresh W3C trace id", async () => {
  const requests = [];
  init(requests);
  const port = await listenExpress(expressApp());

  await get(port, "/orders/42/handled");

  const event = await waitFor(requests, "/api/v1/events");
  assert.equal(event.endpoint, "GET /orders/:id/handled");
  assert.match(event.trace_id, /^[0-9a-f]{32}$/);
  assert.notEqual(event.trace_id, "0".repeat(32));
});

test("Express: a malformed incoming traceparent starts a fresh trace", async () => {
  const requests = [];
  init(requests);
  const port = await listenExpress(expressApp());

  await get(port, "/orders/42", { traceparent: `ff-${INCOMING_TRACE_ID}-${INCOMING_PARENT_ID}-01` });

  const event = await waitFor(requests, "/api/v1/events");
  assert.match(event.trace_id, /^[0-9a-f]{32}$/);
  assert.notEqual(event.trace_id, INCOMING_TRACE_ID);
});

test("Express: every request gets a trace id even with trackTracing off", async () => {
  const requests = [];
  init(requests, { trackTracing: false });
  const port = await listenExpress(expressApp());

  await get(port, "/orders/42", { traceparent: INCOMING_TRACEPARENT });

  assert.equal((await waitFor(requests, "/api/v1/events")).trace_id, INCOMING_TRACE_ID);
});

test("Express: the error middleware alone still links an unhandled error to the incoming trace", async () => {
  const requests = [];
  init(requests);
  const app = express();
  app.get("/orders/:id", () => {
    throw new Error("boom");
  });
  app.use(forgeOpsTrackerExpressMiddleware);
  const port = await listenExpress(app);

  await get(port, "/orders/42", { traceparent: INCOMING_TRACEPARENT });

  const event = await waitFor(requests, "/api/v1/events");
  assert.equal(event.trace_id, INCOMING_TRACE_ID);
  assert.equal(event.endpoint, "GET /orders/:id");
});

test("Express: a fast request that errored still sends its trace, rooted under the remote parent", async () => {
  const requests = [];
  init(requests); // the default 1000ms threshold: only the error makes this request worth sending
  const port = await listenExpress(expressApp());

  await get(port, "/orders/42", { traceparent: INCOMING_TRACEPARENT });

  const trace = await waitFor(requests, "/api/v1/spans");
  assert.ok(trace, "expected the errored request's trace to be sent");
  assert.equal(trace.trace_id, INCOMING_TRACE_ID);
  const root = trace.spans.find((s) => s.kind === "controller");
  assert.equal(root.name, "GET /orders/:id");
  assert.equal(root.parent_span_id, INCOMING_PARENT_ID);
});

test("Express: a handled error during a fast request sends the trace too", async () => {
  const requests = [];
  init(requests);
  const port = await listenExpress(expressApp());

  await get(port, "/orders/42/handled");

  const event = await waitFor(requests, "/api/v1/events");
  const trace = await waitFor(requests, "/api/v1/spans");
  assert.equal(trace.trace_id, event.trace_id);
});

test("Express: an outbound call during the request carries a traceparent naming its own recorded span", async () => {
  const requests = [];
  init(requests, { traceCaptureThresholdMs: 0 });
  const downstream = await startDownstream();
  const app = express();
  app.use(forgeOpsTrackerTracingExpressMiddleware);
  app.get("/checkout", async (req, res) => {
    await get(downstream.port, "/orders");
    res.send("ok");
  });
  const port = await listenExpress(app);

  await get(port, "/checkout", { traceparent: INCOMING_TRACEPARENT });

  const [version, traceId, spanId, flags] = downstream.received[0].split("-");
  assert.deepEqual([version, traceId, flags], ["00", INCOMING_TRACE_ID, "01"]);
  const trace = await waitFor(requests, "/api/v1/spans");
  const httpSpan = trace.spans.find((s) => s.kind === "http");
  assert.equal(httpSpan.span_id, spanId);
  assert.equal(httpSpan.name, "GET 127.0.0.1");
});

test("Express: an outbound call keeps a traceparent the app set itself", async () => {
  const requests = [];
  init(requests);
  const downstream = await startDownstream();
  const own = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
  const app = express();
  app.use(forgeOpsTrackerTracingExpressMiddleware);
  app.get("/checkout", async (req, res) => {
    await get(downstream.port, "/orders", { TraceParent: own });
    res.send("ok");
  });
  const port = await listenExpress(app);

  await get(port, "/checkout", { traceparent: INCOMING_TRACEPARENT });

  assert.deepEqual(downstream.received, [own]);
});

test("Express: outbound calls only carry the header to tracePropagationTargets, and never with propagateTraces off", async () => {
  const requests = [];
  init(requests, { tracePropagationTargets: ["example.com", /^127\.0\.0\.2$/] });
  const downstream = await startDownstream();
  const app = express();
  app.use(forgeOpsTrackerTracingExpressMiddleware);
  app.get("/checkout", async (req, res) => {
    await get(downstream.port, "/orders");
    res.send("ok");
  });
  const port = await listenExpress(app);

  await get(port, "/checkout");
  forgeOpsTracker.init({ tracePropagationTargets: [/^127\.0\.0\.1$/] });
  await get(port, "/checkout");
  forgeOpsTracker.init({ propagateTraces: false });
  await get(port, "/checkout");

  assert.equal(downstream.received[0], undefined);
  assert.match(downstream.received[1], /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(downstream.received[2], undefined);
});

test("outside a request, outbound calls get no traceparent and errors carry no trace fields", async () => {
  const requests = [];
  init(requests);
  const downstream = await startDownstream();

  await get(downstream.port, "/orders");
  forgeOpsTracker.captureException(new Error("boom"));

  assert.deepEqual(downstream.received, [undefined]);
  const event = await waitFor(requests, "/api/v1/events");
  assert.equal(event.trace_id, undefined);
  assert.equal(event.transaction_name, undefined);
  assert.equal(event.endpoint, undefined);
});

test("nothing is traced or propagated when the client isn't enabled", async () => {
  const requests = [];
  init(requests, { dsn: null });
  const downstream = await startDownstream();
  const app = express();
  app.use(forgeOpsTrackerTracingExpressMiddleware);
  app.get("/checkout", async (req, res) => {
    await get(downstream.port, "/orders");
    res.send("ok");
  });
  const port = await listenExpress(app);

  await get(port, "/checkout", { traceparent: INCOMING_TRACEPARENT });

  assert.deepEqual(downstream.received, [undefined]);
  assert.equal(requests.length, 0);
});

async function fastifyApp() {
  const app = Fastify();
  registerForgeOpsTrackerTracing(app);
  registerForgeOpsTracker(app);
  app.post("/orders/:id", async () => {
    throw new Error("boom");
  });
  app.get("/orders/:id/handled", async (request) => {
    forgeOpsTracker.captureException(new Error(`order ${request.params.id} failed`));
    return "handled";
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  servers.push(app.server);
  return app.server.address().port;
}

function post(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

test("Fastify: an unhandled error carries the route pattern and continues an incoming traceparent", async () => {
  const requests = [];
  init(requests);
  const port = await fastifyApp();

  assert.equal(await post(port, "/orders/42", { traceparent: INCOMING_TRACEPARENT }), 500);

  const event = await waitFor(requests, "/api/v1/events");
  assert.equal(event.transaction_name, "POST /orders/:id");
  assert.equal(event.endpoint, "POST /orders/:id");
  assert.equal(event.trace_id, INCOMING_TRACE_ID);
});

test("Fastify: an error captured inside the handler already carries the route", async () => {
  const requests = [];
  init(requests, { trackTracing: false });
  const port = await fastifyApp();

  await get(port, "/orders/42/handled", { traceparent: INCOMING_TRACEPARENT });

  const event = await waitFor(requests, "/api/v1/events");
  assert.equal(event.endpoint, "GET /orders/:id/handled");
  assert.equal(event.trace_id, INCOMING_TRACE_ID);
});

test("Fastify: a fast request that errored still sends its trace, rooted under the remote parent", async () => {
  const requests = [];
  init(requests);
  const port = await fastifyApp();

  await post(port, "/orders/42", { traceparent: INCOMING_TRACEPARENT });

  const trace = await waitFor(requests, "/api/v1/spans");
  assert.ok(trace, "expected the errored request's trace to be sent");
  assert.equal(trace.trace_id, INCOMING_TRACE_ID);
  assert.equal(trace.spans.find((s) => s.kind === "controller").parent_span_id, INCOMING_PARENT_ID);
});

test("Fastify: the onError hook alone still links an unhandled error to the incoming trace", async () => {
  const requests = [];
  init(requests);
  const app = Fastify();
  registerForgeOpsTracker(app);
  app.post("/orders/:id", async () => {
    throw new Error("boom");
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  servers.push(app.server);

  await post(app.server.address().port, "/orders/42", { traceparent: INCOMING_TRACEPARENT });

  const event = await waitFor(requests, "/api/v1/events");
  assert.equal(event.trace_id, INCOMING_TRACE_ID);
  assert.equal(event.endpoint, "POST /orders/:id");
});

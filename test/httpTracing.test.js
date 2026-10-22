import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { installHttpTracing, _uninstallHttpTracing } from "../src/httpTracing.js";

let server;

afterEach(async () => {
  _uninstallHttpTracing();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
});

function startServer(handler) {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("records a kind: http span named '<METHOD> <host>', never the path or query string", async () => {
  const recorded = [];
  installHttpTracing((name, kind, startedAt, durationMs, data) => {
    recorded.push({ name, kind, startedAt, durationMs, data });
  });

  const port = await startServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  });

  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/charges?customer=cus_123&token=secret", method: "GET" },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end();
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].name, "GET 127.0.0.1");
  assert.equal(recorded[0].kind, "http");
  assert.ok(recorded[0].startedAt instanceof Date);
  assert.ok(recorded[0].durationMs >= 0);
  assert.deepEqual(recorded[0].data, { status: 200 });
});

test("uppercases the method and reflects the real status code", async () => {
  const recorded = [];
  installHttpTracing((name, kind, startedAt, durationMs, data) => {
    recorded.push({ name, data });
  });

  const port = await startServer((req, res) => {
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "post" }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });

  assert.equal(recorded[0].name, "POST 127.0.0.1");
  assert.deepEqual(recorded[0].data, { status: 404 });
});

test("records a span with no status when the request itself fails (connection refused)", async () => {
  const recorded = [];
  installHttpTracing((name, kind, startedAt, durationMs, data) => {
    recorded.push({ name, kind, data });
  });

  // Nothing is listening on this port: guaranteed ECONNREFUSED, not a live probe against any real
  // host.
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: 1, method: "GET" });
    req.on("error", () => resolve());
    req.end();
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].name, "GET 127.0.0.1");
  assert.deepEqual(recorded[0].data, {});
});

test("supports the string-URL calling convention", async () => {
  const recorded = [];
  installHttpTracing((name) => recorded.push(name));

  const port = await startServer((req, res) => res.end("ok"));

  await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}/anything`, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });

  assert.equal(recorded[0], "GET 127.0.0.1");
});

test("installHttpTracing only wraps http.request once; a second call is a no-op", async () => {
  let calls = 0;
  installHttpTracing(() => {
    calls += 1;
  });
  installHttpTracing(() => {
    calls += 1000; // would fire instead of the first callback if install ran again
  });

  const port = await startServer((req, res) => res.end("ok"));
  await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });

  assert.equal(calls, 1);
});

test("_uninstallHttpTracing restores the original http.request", async () => {
  const original = http.request;
  installHttpTracing(() => {});
  assert.notEqual(http.request, original);

  _uninstallHttpTracing();
  assert.equal(http.request, original);
});

test("adds the traceparent traceparentFor returns, naming the span id it then records", async () => {
  const recorded = [];
  const asked = [];
  installHttpTracing(
    (name, kind, startedAt, durationMs, data, spanId) => recorded.push({ name, spanId }),
    (host, port, protocol, spanId) => {
      asked.push({ host, port, protocol, spanId });
      return `00-${"a".repeat(32)}-${spanId}-01`;
    },
  );
  const received = [];
  const port = await startServer((req, res) => {
    received.push(req.headers.traceparent);
    res.writeHead(200);
    res.end("ok");
  });

  await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}/orders`, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });

  assert.equal(asked.length, 1);
  assert.deepEqual({ host: asked[0].host, port: asked[0].port, protocol: asked[0].protocol }, { host: "127.0.0.1", port: String(port), protocol: "http:" });
  assert.equal(received[0], `00-${"a".repeat(32)}-${recorded[0].spanId}-01`);
  assert.match(recorded[0].spanId, /^[0-9a-f]{16}$/);
});

test("never replaces a traceparent the caller set, and sends none when traceparentFor returns null", async () => {
  installHttpTracing(
    () => {},
    () => `00-${"a".repeat(32)}-${"c".repeat(16)}-01`,
  );
  const received = [];
  const port = await startServer((req, res) => {
    received.push(req.headers.traceparent);
    res.writeHead(200);
    res.end("ok");
  });
  const own = `00-${"b".repeat(32)}-${"d".repeat(16)}-01`;

  const send = (options) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/", ...options }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });

  await send({ headers: { TraceParent: own } });
  _uninstallHttpTracing();
  installHttpTracing(
    () => {},
    () => null,
  );
  await send({});

  assert.deepEqual(received, [own, undefined]);
});

test("a throwing traceparentFor never stops the request", async () => {
  installHttpTracing(
    () => {},
    () => {
      throw new Error("broken");
    },
  );
  const port = await startServer((req, res) => {
    res.writeHead(204);
    res.end();
  });

  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });

  assert.equal(status, 204);
});

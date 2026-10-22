import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Redis from "ioredis";
import { createClient } from "redis";
import * as forgeOpsTracker from "../src/index.js";
import { installRedisTracing, instrumentIoredis, instrumentNodeRedisClient, _uninstallRedisTracing } from "../src/redisTracing.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

// node-redis versions from before the "node-redis:command" channel (5.12), installed side by side
// as aliased devDependencies, each with the client package that version ships: node-redis 4.0.x
// kept it in @node-redis/client, 4.1 on in @redis/client.
const PATCHED_NODE_REDIS = [
  { alias: "redis4-0", clientPackage: "@node-redis/client" },
  { alias: "redis4", clientPackage: "@redis/client" },
  { alias: "redis5-0", clientPackage: "@redis/client" },
  { alias: "redis5-11", clientPackage: "@redis/client" },
];

// The package.json of the client package one of those node-redis copies loads.
function clientPackageJson(alias, clientPackage) {
  return createRequire(require.resolve(alias)).resolve(`${clientPackage}/package.json`);
}

// A just-enough Redis server (RESP), so these tests run the real ioredis and node-redis clients
// end to end with no Redis installed. GET "missing" is a miss, any other GET returns "value", and
// FAILME always fails. MULTI queues until EXEC. Records every command it receives, arguments
// included.
function startFakeRedis({ delayMs = 0 } = {}) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let queued = null;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parseCommand(buffer);
        if (parsed === null) return;
        buffer = buffer.subarray(parsed.length);
        received.push(parsed.command);
        let reply;
        const name = parsed.command[0].toUpperCase();
        if (name === "MULTI") {
          queued = [];
          reply = "+OK\r\n";
        } else if (name === "EXEC" && queued !== null) {
          reply = `*${queued.length}\r\n${queued.join("")}`;
          queued = null;
        } else if (queued !== null) {
          queued.push(replyTo(parsed.command));
          reply = "+QUEUED\r\n";
        } else {
          reply = replyTo(parsed.command);
        }
        if (delayMs > 0) {
          setTimeout(() => socket.destroyed || socket.write(reply), delayMs);
        } else {
          socket.write(reply);
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        received,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(done);
          }),
      });
    });
  });
}

// One "*<n>\r\n$<len>\r\n<arg>\r\n..." command off the front of buffer, or null if it's incomplete.
function parseCommand(buffer) {
  let offset = 0;
  const line = () => {
    const end = buffer.indexOf("\r\n", offset);
    if (end === -1) return null;
    const text = buffer.toString("utf8", offset, end);
    offset = end + 2;
    return text;
  };
  const header = line();
  if (header === null) return null;
  const count = Number(header.slice(1));
  const command = [];
  for (let i = 0; i < count; i++) {
    const size = line();
    if (size === null) return null;
    const length = Number(size.slice(1));
    if (buffer.length < offset + length + 2) return null;
    command.push(buffer.toString("utf8", offset, offset + length));
    offset += length + 2;
  }
  return { command, length: offset };
}

function replyTo([name, ...args]) {
  switch (name.toUpperCase()) {
    case "HELLO":
      return "%1\r\n$6\r\nserver\r\n$5\r\nredis\r\n";
    case "PING":
      return "+PONG\r\n";
    case "INFO": {
      const info = "# Server\r\nredis_version:7.4.0\r\nloading:0\r\n";
      return `$${Buffer.byteLength(info)}\r\n${info}\r\n`;
    }
    case "GET":
      return args[0] === "missing" ? "$-1\r\n" : "$5\r\nvalue\r\n";
    case "INCR":
      return ":1\r\n";
    case "FAILME":
      return "-ERR boom\r\n";
    default:
      return "+OK\r\n";
  }
}

let redisServer;
let clients = [];

beforeEach(async () => {
  redisServer = await startFakeRedis();
});

afterEach(async () => {
  _uninstallRedisTracing();
  forgeOpsTracker._resetForTesting();
  for (const client of clients) {
    if (client instanceof Redis) {
      client.disconnect();
    } else if (client.isOpen) {
      // destroy() from node-redis 5 on; 4.x only has disconnect().
      if (typeof client.destroy === "function") {
        client.destroy();
      } else {
        await client.disconnect().catch(() => {});
      }
    }
  }
  clients = [];
  await redisServer.close();
});

function ioredisClient(options = {}) {
  const client = new Redis({ host: "127.0.0.1", port: redisServer.port, maxRetriesPerRequest: 0, ...options });
  clients.push(client);
  return client;
}

async function nodeRedisClient(create = createClient) {
  const client = create({ url: `redis://127.0.0.1:${redisServer.port}` });
  client.on("error", () => {});
  clients.push(client);
  await client.connect();
  return client;
}

function install(isTracing = () => true) {
  const recorded = [];
  installRedisTracing((name, kind, startedAt, durationMs, data) => {
    recorded.push({ name, kind, startedAt, durationMs, data });
  }, isTracing);
  return recorded;
}

// Spans and breadcrumbs both, with breadcrumbs always kept.
function recorders(isTracing = () => false) {
  const spans = [];
  const breadcrumbs = [];
  return {
    spans,
    breadcrumbs,
    hooks: [
      (name) => spans.push(name),
      isTracing,
      (message, category, level, data) => breadcrumbs.push({ message, category, level, data }),
      () => true,
    ],
  };
}

// Connection setup (INFO, CLIENT SETINFO, HELLO...) happens before these tests' own commands,
// and isn't what they're checking.
function commandSpans(recorded) {
  return recorded.filter((span) => !/^Redis (INFO|CLIENT|HELLO|SELECT)$/.test(span.name));
}

test("ioredis: one redis span per command, named by the command alone, with no data", async () => {
  const client = ioredisClient();
  await client.ping();
  const recorded = install();

  assert.equal(await client.set("user:9911:session", "secret-token", "EX", 60), "OK");
  assert.equal(await client.get("user:9911:session"), "value");

  assert.deepEqual(
    recorded.map((span) => [span.name, span.kind, span.data]),
    [
      ["Redis SET", "redis", undefined],
      ["Redis GET", "redis", undefined],
    ],
  );
  assert.ok(recorded.every((span) => span.startedAt instanceof Date && span.durationMs >= 0));
  assert.deepEqual(redisServer.received.at(-1), ["get", "user:9911:session"]);
  const sent = JSON.stringify(recorded.map((span) => [span.name, span.data]));
  for (const secret of ["user:9911:session", "secret-token", "60"]) {
    assert.equal(sent.includes(secret), false, secret);
  }
});

test("ioredis: a callback-style command and a failed command are recorded, and the error still reaches the caller", async () => {
  const client = ioredisClient();
  await client.ping();
  const recorded = install();

  const value = await new Promise((resolve, reject) => client.get("missing", (error, result) => (error ? reject(error) : resolve(result))));
  await assert.rejects(client.call("FAILME", "some-key"), /boom/);

  assert.equal(value, null);
  assert.deepEqual(
    recorded.map((span) => span.name),
    ["Redis GET", "Redis FAILME"],
  );
});

test("ioredis: a command sent before the connection is ready is recorded once, from when the app sent it", async () => {
  const recorded = install();
  const client = ioredisClient();

  assert.equal(await client.incr("counter"), 1);

  assert.deepEqual(
    commandSpans(recorded).map((span) => span.name),
    ["Redis INCR"],
  );
});

test("ioredis: every command in a pipeline gets its own span", async () => {
  const client = ioredisClient();
  await client.ping();
  const recorded = install();

  const results = await client.pipeline().set("a", "1").get("a").incr("b").exec();

  assert.deepEqual(results, [
    [null, "OK"],
    [null, "value"],
    [null, 1],
  ]);
  assert.deepEqual(
    recorded.map((span) => span.name),
    ["Redis SET", "Redis GET", "Redis INCR"],
  );
});

test("ioredis: a failed command the app never handles is still reported as an unhandled rejection", async () => {
  // In a child process: this test runner fails whichever test an unhandled rejection happens in.
  const script = `
    import Redis from "ioredis";
    import { installRedisTracing } from "./src/redisTracing.js";
    installRedisTracing(() => {}, () => true);
    process.on("unhandledRejection", (reason) => {
      console.log("unhandled: " + reason.message);
      process.exit(0);
    });
    const client = new Redis({ host: "127.0.0.1", port: ${redisServer.port} });
    await client.ping();
    client.call("FAILME");
    setTimeout(() => process.exit(1), 2000);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: packageRoot });
  assert.equal(stdout.trim(), "unhandled: ERR boom");
});

test("ioredis: each command is recorded into the async context that sent it", async () => {
  await redisServer.close();
  redisServer = await startFakeRedis({ delayMs: 10 });
  const client = ioredisClient();
  await client.ping();
  const requests = new AsyncLocalStorage();
  const recorded = [];
  installRedisTracing(
    (name) => recorded.push({ name, request: requests.getStore() }),
    () => requests.getStore() !== undefined,
  );

  await Promise.all([requests.run("first", () => client.get("a")), requests.run("second", () => client.incr("b"))]);
  await client.get("outside");

  assert.deepEqual(
    recorded.map(({ name, request }) => [name, request]),
    [
      ["Redis GET", "first"],
      ["Redis INCR", "second"],
    ],
  );
});

test("ioredis: records nothing when no trace is being captured", async () => {
  const recorded = install(() => false);
  const client = ioredisClient();

  assert.equal(await client.get("a"), "value");
  assert.deepEqual(recorded, []);
});

test("ioredis: installing twice, or instrumenting the same class again, never wraps sendCommand twice", async () => {
  const client = ioredisClient();
  await client.ping();
  const recorded = install();
  installRedisTracing(() => recorded.push("second install"), () => true);
  assert.equal(instrumentIoredis(Redis, () => recorded.push("explicit"), () => true), true);

  await client.get("a");

  assert.deepEqual(
    recorded.map((span) => span.name),
    ["Redis GET"],
  );
});

test("ioredis: _uninstallRedisTracing puts sendCommand back exactly as it was", () => {
  const original = Redis.prototype.sendCommand;
  install();
  assert.notEqual(Redis.prototype.sendCommand, original);

  _uninstallRedisTracing();

  assert.equal(Redis.prototype.sendCommand, original);
});

test("instrumentIoredis ignores anything that isn't an ioredis class", () => {
  const record = () => {};
  assert.equal(instrumentIoredis(undefined, record, () => true), false);
  assert.equal(instrumentIoredis(class {}, record, () => true), false);
});

test("node-redis: one redis span per command, named by the command alone, with no data", async () => {
  const client = await nodeRedisClient();
  const recorded = install();

  assert.equal(await client.set("user:9911:session", "secret-token", { EX: 60 }), "OK");
  assert.equal(await client.get("user:9911:session"), "value");
  assert.equal(await client.get("missing"), null);

  assert.deepEqual(
    recorded.map((span) => [span.name, span.kind, span.data]),
    [
      ["Redis SET", "redis", undefined],
      ["Redis GET", "redis", undefined],
      ["Redis GET", "redis", undefined],
    ],
  );
  assert.ok(recorded.every((span) => span.startedAt instanceof Date && span.durationMs >= 0));
  const sent = JSON.stringify(recorded.map((span) => [span.name, span.data]));
  for (const secret of ["user:9911:session", "secret-token", "60"]) {
    assert.equal(sent.includes(secret), false, secret);
  }
});

test("node-redis: a failed command is recorded and its error still reaches the caller", async () => {
  const client = await nodeRedisClient();
  const recorded = install();

  await assert.rejects(client.sendCommand(["FAILME", "some-key"]), /boom/);

  assert.deepEqual(
    recorded.map((span) => span.name),
    ["Redis FAILME"],
  );
});

test("node-redis: each command is recorded into the async context that sent it, and nothing outside one", async () => {
  await redisServer.close();
  redisServer = await startFakeRedis({ delayMs: 10 });
  const client = await nodeRedisClient();
  const requests = new AsyncLocalStorage();
  const recorded = [];
  installRedisTracing(
    (name) => recorded.push({ name, request: requests.getStore() }),
    () => requests.getStore() !== undefined,
  );

  await Promise.all([requests.run("first", () => client.get("a")), requests.run("second", () => client.incr("b"))]);
  await client.get("outside");

  assert.deepEqual(
    recorded.map(({ name, request }) => [name, request]),
    [
      ["Redis GET", "first"],
      ["Redis INCR", "second"],
    ],
  );
});

test("node-redis: _uninstallRedisTracing stops recording", async () => {
  const client = await nodeRedisClient();
  const recorded = install();
  _uninstallRedisTracing();

  await client.get("a");

  assert.deepEqual(recorded, []);
});

test("ioredis: every command also adds a redis breadcrumb, outside a trace too, level error when it failed", async () => {
  const client = ioredisClient();
  await client.ping();
  const { spans, breadcrumbs, hooks } = recorders();
  installRedisTracing(...hooks);

  assert.equal(await client.get("user:9911:session"), "value");
  await assert.rejects(client.call("FAILME", "some-key"), /boom/);

  assert.deepEqual(spans, []);
  assert.deepEqual(
    breadcrumbs.map(({ message, category, level }) => [message, category, level]),
    [
      ["Redis GET", "redis", "info"],
      ["Redis FAILME", "redis", "error"],
    ],
  );
  assertBreadcrumbData(breadcrumbs);
});

test("node-redis: every command also adds a redis breadcrumb, outside a trace too, level error when it failed", async () => {
  const client = await nodeRedisClient();
  const { spans, breadcrumbs, hooks } = recorders();
  installRedisTracing(...hooks);

  assert.equal(await client.get("user:9911:session"), "value");
  await assert.rejects(client.sendCommand(["FAILME", "some-key"]), /boom/);

  assert.deepEqual(spans, []);
  assert.deepEqual(
    breadcrumbs.map(({ message, category, level }) => [message, category, level]),
    [
      ["Redis GET", "redis", "info"],
      ["Redis FAILME", "redis", "error"],
    ],
  );
  assertBreadcrumbData(breadcrumbs);
});

test("a span and a breadcrumb are each only recorded when their own check says so", async () => {
  const client = ioredisClient();
  await client.ping();
  const spans = [];
  installRedisTracing(
    (name) => spans.push(name),
    () => true,
    () => assert.fail("no breadcrumb should be recorded"),
    () => false,
  );

  await client.get("a");

  assert.deepEqual(spans, ["Redis GET"]);
});

// Only { duration_ms }, a number rounded to 0.1ms, and never a key.
function assertBreadcrumbData(breadcrumbs) {
  for (const { data } of breadcrumbs) {
    assert.deepEqual(Object.keys(data), ["duration_ms"]);
    assert.ok(data.duration_ms >= 0 && Number.isInteger(Math.round(data.duration_ms * 1000) / 100), String(data.duration_ms));
  }
  assert.equal(JSON.stringify(breadcrumbs).includes("user:9911"), false);
  assert.equal(JSON.stringify(breadcrumbs).includes("some-key"), false);
}

for (const { alias, clientPackage } of PATCHED_NODE_REDIS) {
  const { createClient: createOlderClient } = require(alias);
  const label = `node-redis ${require(`${alias}/package.json`).version}`;

  test(`${label}: one redis span per command, named by the command alone, and a failed command's error still reaches the caller`, async () => {
    const client = await nodeRedisClient(createOlderClient);
    const recorded = [];
    const patched = instrumentNodeRedisClient(
      clientPackageJson(alias, clientPackage),
      (name, kind, startedAt, durationMs, data) => recorded.push({ name, kind, startedAt, durationMs, data }),
      () => true,
    );

    assert.equal(patched, true);
    assert.equal(await client.set("user:9911:session", "secret-token", { EX: 60 }), "OK");
    assert.equal(await client.get("user:9911:session"), "value");
    assert.equal(await client.get("missing"), null);
    await assert.rejects(client.sendCommand(["FAILME", "some-key"]), /boom/);

    assert.deepEqual(
      recorded.map((span) => [span.name, span.kind, span.data]),
      [
        ["Redis SET", "redis", undefined],
        ["Redis GET", "redis", undefined],
        ["Redis GET", "redis", undefined],
        ["Redis FAILME", "redis", undefined],
      ],
    );
    assert.ok(recorded.every((span) => span.startedAt instanceof Date && span.durationMs >= 0));
    const sent = JSON.stringify(recorded.map((span) => [span.name, span.data]));
    for (const secret of ["user:9911:session", "secret-token", "60", "some-key"]) {
      assert.equal(sent.includes(secret), false, secret);
    }
  });

  test(`${label}: every command in a pipeline or a MULTI gets its own span, MULTI and EXEC included`, async () => {
    const client = await nodeRedisClient(createOlderClient);
    const recorded = [];
    instrumentNodeRedisClient(clientPackageJson(alias, clientPackage), (name) => recorded.push(name), () => true);

    assert.deepEqual(await client.multi().set("a", "1").get("a").incr("b").execAsPipeline(), ["OK", "value", 1]);
    assert.deepEqual(await client.multi().set("a", "1").get("a").exec(), ["OK", "value"]);

    assert.deepEqual(recorded, ["Redis SET", "Redis GET", "Redis INCR", "Redis MULTI", "Redis SET", "Redis GET", "Redis EXEC"]);
  });

  test(`${label}: each command is recorded into the async context that sent it, and nothing outside one`, async () => {
    await redisServer.close();
    redisServer = await startFakeRedis({ delayMs: 10 });
    const client = await nodeRedisClient(createOlderClient);
    const requests = new AsyncLocalStorage();
    const recorded = [];
    instrumentNodeRedisClient(
      clientPackageJson(alias, clientPackage),
      (name) => recorded.push({ name, request: requests.getStore() }),
      () => requests.getStore() !== undefined,
    );

    await Promise.all([requests.run("first", () => client.get("a")), requests.run("second", () => client.incr("b"))]);
    await client.get("outside");

    assert.deepEqual(
      recorded.map(({ name, request }) => [name, request]),
      [
        ["Redis GET", "first"],
        ["Redis INCR", "second"],
      ],
    );
  });

  test(`${label}: every command also adds a redis breadcrumb, outside a trace too, level error when it failed`, async () => {
    const client = await nodeRedisClient(createOlderClient);
    const { spans, breadcrumbs, hooks } = recorders();
    instrumentNodeRedisClient(clientPackageJson(alias, clientPackage), ...hooks);

    assert.equal(await client.get("user:9911:session"), "value");
    await assert.rejects(client.sendCommand(["FAILME", "some-key"]), /boom/);

    assert.deepEqual(spans, []);
    assert.deepEqual(
      breadcrumbs.map(({ message, category, level }) => [message, category, level]),
      [
        ["Redis GET", "redis", "info"],
        ["Redis FAILME", "redis", "error"],
      ],
    );
    assertBreadcrumbData(breadcrumbs);
  });
}

test("node-redis 4.x: a failed command the app never handles is still reported as an unhandled rejection", async () => {
  // In a child process: this test runner fails whichever test an unhandled rejection happens in.
  const script = `
    import { createRequire } from "node:module";
    import { instrumentNodeRedisClient } from "./src/redisTracing.js";
    const require = createRequire(import.meta.url);
    const { createClient } = require("redis4");
    instrumentNodeRedisClient(${JSON.stringify(clientPackageJson("redis4", "@redis/client"))}, () => {}, () => true);
    process.on("unhandledRejection", (reason) => {
      console.log("unhandled: " + reason.message);
      process.exit(0);
    });
    const client = createClient({ url: "redis://127.0.0.1:${redisServer.port}" });
    await client.connect();
    client.sendCommand(["FAILME"]);
    setTimeout(() => process.exit(1), 2000);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: packageRoot });
  assert.equal(stdout.trim(), "unhandled: ERR boom");
});

test("node-redis: a copy that publishes on the channel is never patched, so no command is recorded twice", async () => {
  // Stand-ins for @redis/client at each version, laid out the way the real package is.
  const root = mkdtempSync(path.join(os.tmpdir(), "forge-ops-node-redis-"));
  const fakeClient = (version) => {
    const dir = path.join(root, version);
    mkdirSync(path.join(dir, "dist/lib/client"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@redis/client", version }));
    writeFileSync(path.join(dir, "dist/lib/client/commands-queue.js"), "exports.default = class { addCommand() { return Promise.resolve('OK'); } };");
    return path.join(dir, "package.json");
  };
  try {
    const versions = ["1.0.5", "1.6.1", "5.0.0-next.7", "5.0.1", "5.11.9", "5.12.0", "5.12.1", "6.2.1", "7.0.0"];
    assert.deepEqual(
      versions.map((version) => [version, instrumentNodeRedisClient(fakeClient(version), () => {}, () => true)]),
      [
        ["1.0.5", true],
        ["1.6.1", true],
        ["5.0.0-next.7", true],
        ["5.0.1", true],
        ["5.11.9", true],
        ["5.12.0", false],
        ["5.12.1", false],
        ["6.2.1", false],
        ["7.0.0", false],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // The real thing: the redis these tests use publishes on the channel, and the automatic install
  // (the channel, plus whatever older copies it patches) records each of its commands exactly once.
  assert.equal(instrumentNodeRedisClient(clientPackageJson("redis", "@redis/client"), () => {}, () => true), false);
  const client = await nodeRedisClient();
  const recorded = install();
  await client.get("a");
  await client.incr("b");
  assert.deepEqual(
    recorded.map((span) => span.name),
    ["Redis GET", "Redis INCR"],
  );
});

test("node-redis: the automatic install patches an older copy it finds in the app, without being handed it", async () => {
  // redis4-0's @node-redis/client sits at the top of node_modules, where init() looks.
  const client = await nodeRedisClient(require("redis4-0").createClient);
  const recorded = install();

  await client.get("a");

  assert.deepEqual(
    recorded.map((span) => span.name),
    ["Redis GET"],
  );
});

test("end to end: Redis commands outside any request add redis breadcrumbs to the standalone trail an error reports", async () => {
  const requests = [];
  globalThis.fetch = async (uri, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(null, { status: 202 });
  };
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    installProcessHandlers: false,
  });
  const ioredis = ioredisClient();
  await ioredis.ping();
  const nodeRedis = await nodeRedisClient();

  await ioredis.get("cart:jane@example.com");
  await assert.rejects(nodeRedis.sendCommand(["FAILME", "cart:jane@example.com"]), /boom/);
  forgeOpsTracker.captureException(new Error("checkout failed"));
  await waitUntil(() => requests.length === 1);

  const redisBreadcrumbs = requests[0].breadcrumbs.filter((breadcrumb) => breadcrumb.category === "redis");
  assert.deepEqual(
    redisBreadcrumbs.map(({ message, level }) => [message, level]),
    [
      ["Redis PING", "info"],
      ["Redis GET", "info"],
      ["Redis FAILME", "error"],
    ],
  );
  assert.ok(redisBreadcrumbs.every((breadcrumb) => typeof breadcrumb.data.duration_ms === "number"));
  assert.equal(JSON.stringify(requests[0]).includes("jane@example.com"), false);
});

test("end to end: no redis breadcrumbs with trackBreadcrumbs off", async () => {
  const requests = [];
  globalThis.fetch = async (uri, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(null, { status: 202 });
  };
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    trackBreadcrumbs: false,
    installProcessHandlers: false,
  });
  const ioredis = ioredisClient();
  const nodeRedis = await nodeRedisClient();

  await ioredis.get("a");
  await nodeRedis.get("a");
  forgeOpsTracker.captureException(new Error("checkout failed"));
  await waitUntil(() => requests.length === 1);

  assert.equal("breadcrumbs" in requests[0], false);
});

test("end to end: Redis commands inside a traced request are sent as redis spans under the request's root", async () => {
  const requests = [];
  globalThis.fetch = async (uri, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(null, { status: 202 });
  };
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    traceCaptureThresholdMs: 0,
    installProcessHandlers: false,
  });
  const ioredis = ioredisClient();
  await ioredis.ping();
  const nodeRedis = await nodeRedisClient();

  await forgeOpsTracker._runWithSpanTrace(async () => {
    await ioredis.get("cart:jane@example.com");
    await forgeOpsTracker.span("CartService.load", () => nodeRedis.set("cart:jane@example.com", "3 items"));
    forgeOpsTracker._finishSpanTrace("GET /cart", new Date(), 10);
  });
  await waitUntil(() => requests.length === 1);

  const [trace] = requests;
  const root = trace.spans.find((span) => span.kind === "controller");
  const service = trace.spans.find((span) => span.name === "CartService.load");
  assert.deepEqual(
    trace.spans.filter((span) => span.kind === "redis").map((span) => [span.name, span.parent_span_id, span.data]),
    [
      ["Redis GET", root.span_id, {}],
      ["Redis SET", service.span_id, {}],
    ],
  );
  assert.equal(JSON.stringify(trace).includes("jane@example.com"), false);
  assert.equal(JSON.stringify(trace).includes("3 items"), false);
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

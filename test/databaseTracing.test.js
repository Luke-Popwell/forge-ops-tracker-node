import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import net from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { installDatabaseTracing, instrumentPg, queryName, _uninstallDatabaseTracing } from "../src/databaseTracing.js";
import * as forgeOpsTracker from "../src/index.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

// A just-enough PostgreSQL server (the v3 wire protocol, no auth), so these tests run the real pg
// Client and Pool end to end with no database installed. Answers every query with one text row,
// and with an error for any statement containing "fail_here". Records each statement it receives.
function startFakePostgres({ delayMs = 0 } = {}) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let started = false;
    let failing = false;
    let pending = Promise.resolve();
    const send = (message, delayed = false) => {
      pending = pending
        .then(() => (delayed && delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : null))
        .then(() => socket.destroyed || socket.write(message));
    };

    const handle = (type, body) => {
      switch (type) {
        case "Q": {
          const text = cString(body, 0).value;
          received.push(text);
          send(text.includes("fail_here") ? errorResponse() : Buffer.concat([rowDescription(), dataRow(), commandComplete()]), true);
          send(message("Z", Buffer.from("I")));
          break;
        }
        case "P": {
          const name = cString(body, 0);
          const text = cString(body, name.next).value;
          received.push(text);
          failing = text.includes("fail_here");
          send(failing ? errorResponse() : message("1"), true);
          break;
        }
        case "B":
          if (!failing) send(message("2"));
          break;
        case "D":
          if (!failing) send(rowDescription());
          break;
        case "E":
          if (!failing) send(Buffer.concat([dataRow(), commandComplete()]));
          break;
        case "C":
          if (!failing) send(message("3"));
          break;
        case "S":
          failing = false;
          send(message("Z", Buffer.from("I")));
          break;
        case "X":
          socket.end();
          break;
        default:
          break;
      }
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) return;
          const length = buffer.readInt32BE(0);
          const code = buffer.readInt32BE(4);
          buffer = buffer.subarray(length);
          if (code === 80877103) {
            socket.write("N"); // SSLRequest: no SSL here
            continue;
          }
          started = true;
          send(Buffer.concat([message("R", int32(0)), message("Z", Buffer.from("I"))]));
          continue;
        }
        if (buffer.length < 5 || buffer.length < 1 + buffer.readInt32BE(1)) return;
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        const body = buffer.subarray(5, 1 + length);
        buffer = buffer.subarray(1 + length);
        handle(type, body);
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

function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function int16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
}

function message(type, body = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
}

function cString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  return { value: buffer.toString("utf8", offset, end), next: end + 1 };
}

function rowDescription() {
  // One text column named "value".
  return message("T", Buffer.concat([int16(1), Buffer.from("value\0"), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)]));
}

function dataRow() {
  return message("D", Buffer.concat([int16(1), int32(1), Buffer.from("1")]));
}

function commandComplete() {
  return message("C", Buffer.from("SELECT 1\0"));
}

function errorResponse() {
  return message("E", Buffer.from("SERROR\0VERROR\0C42P01\0Mrelation does not exist\0\0"));
}

let database;
let clients = [];

beforeEach(async () => {
  database = await startFakePostgres();
});

afterEach(async () => {
  _uninstallDatabaseTracing();
  forgeOpsTracker._resetForTesting();
  for (const client of clients) {
    await client.end().catch(() => {});
  }
  clients = [];
  await database.close();
});

function connectionOptions(port = database.port) {
  return { host: "127.0.0.1", port, user: "test", database: "test" };
}

async function connectedClient() {
  const client = new pg.Client(connectionOptions());
  clients.push(client);
  await client.connect();
  return client;
}

function newPool(options = {}) {
  const pool = new pg.Pool({ ...connectionOptions(), ...options });
  clients.push(pool);
  return pool;
}

function install(isTracing = () => true) {
  const recorded = [];
  installDatabaseTracing((name, kind, startedAt, durationMs, data) => {
    recorded.push({ name, kind, startedAt, durationMs, data });
  }, isTracing);
  return recorded;
}

test("a promise-style query records one database span with its statement masked", async () => {
  const recorded = install();
  const client = await connectedClient();

  const result = await client.query("SELECT id FROM orders WHERE email = 'jane@example.com' AND total > 4200");

  assert.deepEqual(result.rows, [{ value: "1" }]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].name, "SELECT orders");
  assert.equal(recorded[0].kind, "database");
  assert.ok(recorded[0].startedAt instanceof Date);
  assert.ok(recorded[0].durationMs >= 0);
  assert.deepEqual(recorded[0].data, {
    "db.system": "postgresql",
    "db.statement": "SELECT id FROM orders WHERE email = ? AND total > ?",
  });
});

test("bind values are never read: placeholders stay as they are and the values never reach the span", async () => {
  const recorded = install();
  const client = await connectedClient();

  await client.query("UPDATE users SET email = $1 WHERE id = $2", ["jane@example.com", 9911]);

  assert.equal(database.received.at(-1), "UPDATE users SET email = $1 WHERE id = $2");
  assert.equal(recorded[0].name, "UPDATE users");
  assert.equal(recorded[0].data["db.statement"], "UPDATE users SET email = $1 WHERE id = $2");
  const sent = JSON.stringify(recorded.map((span) => [span.name, span.data]));
  assert.equal(sent.includes("jane@example.com"), false);
  assert.equal(sent.includes("9911"), false);
});

test("a callback-style query records its span before the callback runs", async () => {
  const recorded = install();
  const client = await connectedClient();

  const countWhenCalledBack = await new Promise((resolve, reject) => {
    client.query("DELETE FROM sessions WHERE token = 'abc123'", (error) => (error ? reject(error) : resolve(recorded.length)));
  });

  assert.equal(countWhenCalledBack, 1);
  assert.equal(recorded[0].name, "DELETE sessions");
  assert.equal(recorded[0].data["db.statement"], "DELETE FROM sessions WHERE token = ?");
});

test("a callback passed in place of values is recognized too", async () => {
  const recorded = install();
  const client = await connectedClient();

  const result = await new Promise((resolve, reject) => {
    client.query("SELECT 1", (error, res) => (error ? reject(error) : resolve(res)));
  });

  assert.deepEqual(result.rows, [{ value: "1" }]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].name, "SELECT");
  assert.equal(recorded[0].data["db.statement"], "SELECT ?");
});

test("a config object is read for its text, and a callback on it still gets called", async () => {
  const recorded = install();
  const client = await connectedClient();

  await client.query({ text: "INSERT INTO audit_log (note) VALUES ($1)", values: ["secret note"], name: "audit" });
  const config = { text: "SELECT total FROM invoices WHERE id = 77" };
  const result = await new Promise((resolve, reject) => {
    config.callback = (error, res) => (error ? reject(error) : resolve(res));
    assert.equal(client.query(config), undefined);
  });

  assert.deepEqual(result.rows, [{ value: "1" }]);
  assert.deepEqual(
    recorded.map((span) => [span.name, span.data["db.statement"]]),
    [
      ["INSERT INTO audit_log", "INSERT INTO audit_log (note) VALUES ($1)"],
      ["SELECT invoices", "SELECT total FROM invoices WHERE id = ?"],
    ],
  );
  assert.equal(JSON.stringify(recorded.map((span) => span.data)).includes("secret note"), false);
});

test("a config object whose text is a getter (a SQL template class) is read correctly", async () => {
  const recorded = install();
  const client = await connectedClient();

  class Statement {
    get text() {
      return "SELECT * FROM products WHERE sku = $1";
    }
    get values() {
      return ["A1"];
    }
  }
  await client.query(new Statement());

  assert.equal(database.received.at(-1), "SELECT * FROM products WHERE sku = $1");
  assert.equal(recorded[0].name, "SELECT products");
});

test("a failed query is recorded too, and its error still reaches the caller (promise and callback)", async () => {
  const recorded = install();
  const client = await connectedClient();

  await assert.rejects(client.query("SELECT * FROM fail_here"), /relation does not exist/);
  const callbackError = await new Promise((resolve) => {
    client.query("SELECT * FROM fail_here WHERE id = $1", [1], (error) => resolve(error));
  });

  assert.match(callbackError.message, /relation does not exist/);
  assert.equal(recorded.length, 2);
  assert.deepEqual(
    recorded.map((span) => span.name),
    ["SELECT fail_here", "SELECT fail_here"],
  );
});

test("a rejected query the app never handles is still reported as an unhandled rejection", async () => {
  // In a child process: this test runner fails whichever test an unhandled rejection happens in.
  const script = `
    import pg from "pg";
    import { installDatabaseTracing } from "./src/databaseTracing.js";
    installDatabaseTracing(() => {}, () => true);
    process.on("unhandledRejection", (reason) => {
      console.log("unhandled: " + reason.message);
      process.exit(0);
    });
    const client = new pg.Client(${JSON.stringify(connectionOptions())});
    await client.connect();
    client.query("SELECT * FROM fail_here");
    setTimeout(() => process.exit(1), 2000);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: packageRoot });
  assert.equal(stdout.trim(), "unhandled: relation does not exist");
});

test("pool.query goes through Client#query and is recorded once per query", async () => {
  const recorded = install();
  const pool = newPool();

  await pool.query("SELECT name FROM customers WHERE id = $1", [5]);
  await new Promise((resolve, reject) => pool.query("SELECT name FROM customers", (error) => (error ? reject(error) : resolve())));
  const checkedOut = await pool.connect();
  await checkedOut.query("SELECT 1");
  checkedOut.release();

  assert.deepEqual(
    recorded.map((span) => span.name),
    ["SELECT customers", "SELECT customers", "SELECT"],
  );
});

test("with every pooled client busy, a queued query is still recorded into its own caller's context", async () => {
  await database.close();
  database = await startFakePostgres({ delayMs: 20 });
  const requests = new AsyncLocalStorage();
  const recorded = [];
  installDatabaseTracing(
    (name) => recorded.push({ name, request: requests.getStore() }),
    () => requests.getStore() !== undefined,
  );
  const pool = newPool({ max: 1 });

  await Promise.all([
    requests.run("first", () => pool.query("SELECT * FROM first_table")),
    requests.run("second", () => pool.query("SELECT * FROM second_table")),
    requests.run("third", () => pool.query("SELECT * FROM third_table")),
  ]);

  assert.deepEqual(
    recorded.map(({ name, request }) => [name, request]).sort(),
    [
      ["SELECT first_table", "first"],
      ["SELECT second_table", "second"],
      ["SELECT third_table", "third"],
    ],
  );
});

test("records nothing, and hands back pg's own promise, when no trace is being captured", async () => {
  const recorded = install(() => false);
  const client = await connectedClient();

  const result = await client.query("SELECT 1");

  assert.deepEqual(result.rows, [{ value: "1" }]);
  assert.deepEqual(recorded, []);
});

test("a submittable (a cursor or stream) passes straight through unrecorded", async () => {
  const recorded = install();
  const client = await connectedClient();

  const query = new pg.Query("SELECT * FROM big_table");
  const rows = [];
  query.on("row", (row) => rows.push(row));
  const done = new Promise((resolve, reject) => {
    query.on("end", resolve);
    query.on("error", reject);
  });
  assert.equal(client.query(query), query);
  await done;

  assert.deepEqual(rows, [{ value: "1" }]);
  assert.deepEqual(recorded, []);
});

test("a query that throws synchronously still throws, with nothing recorded", async () => {
  const recorded = install();
  const client = new pg.Client(connectionOptions());

  assert.throws(() => client.query(null), TypeError);
  assert.deepEqual(recorded, []);
});

test("installing twice, or instrumenting the same pg again, never wraps a query twice", async () => {
  const recorded = install();
  installDatabaseTracing(() => recorded.push("second install"), () => true);
  instrumentPg(pg, () => recorded.push("explicit"), () => true);
  const client = await connectedClient();

  await client.query("SELECT 1");

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].name, "SELECT");
});

test("_uninstallDatabaseTracing puts Client#query and Pool#connect back exactly as they were", () => {
  const originalQuery = pg.Client.prototype.query;
  const hadOwnConnect = Object.prototype.hasOwnProperty.call(pg.Pool.prototype, "connect");
  install();
  assert.notEqual(pg.Client.prototype.query, originalQuery);

  _uninstallDatabaseTracing();

  assert.equal(pg.Client.prototype.query, originalQuery);
  assert.equal(Object.prototype.hasOwnProperty.call(pg.Pool.prototype, "connect"), hadOwnConnect);
});

test("instrumentPg ignores anything that isn't a pg module", () => {
  const record = () => {};
  assert.equal(instrumentPg(undefined, record, () => true), false);
  assert.equal(instrumentPg({}, record, () => true), false);
  assert.equal(instrumentPg({ Client: class {} }, record, () => true), false);
});

test("pg imported as an ES module is the same Client the automatic install patched", async () => {
  install();
  const esm = await import("pg");
  assert.equal(esm.default.Client.prototype.query, pg.Client.prototype.query);
  assert.equal(esm.Client, pg.Client);
});

test("queryName: '<VERB> <table>' where the table sits in a predictable place, the first keyword otherwise", () => {
  // The same cases the Elixir SDK's QueryNaming tests cover, so every SDK names a query the same.
  assert.equal(queryName('SELECT "auth_user"."id" FROM "auth_user" WHERE "auth_user"."id" = $1'), "SELECT auth_user");
  assert.equal(queryName('DELETE FROM "sessions" WHERE "sessions"."id" = $1'), "DELETE sessions");
  assert.equal(queryName('INSERT INTO "orders" ("id", "total") VALUES ($1, $2)'), "INSERT INTO orders");
  assert.equal(queryName('UPDATE "orders" SET "total" = $1 WHERE "orders"."id" = $2'), "UPDATE orders");
  assert.equal(queryName("SELECT * FROM users WHERE id = $1"), "SELECT users");
  assert.equal(queryName("SELECT * FROM `users` WHERE id = $1"), "SELECT users");
  assert.equal(queryName("select id\nfrom accounts"), "SELECT accounts");
  assert.equal(queryName("SELECT 1"), "SELECT");
  assert.equal(queryName("BEGIN"), "BEGIN");
  assert.equal(queryName("begin"), "BEGIN");
  assert.equal(queryName(""), "SQL");
  assert.equal(queryName("   "), "SQL");
  assert.equal(queryName(null), "SQL");
});

// The masking itself is sqlStatement.js's mask() (see test/sqlStatement.test.js); these check the
// statements a pg app actually sends come out of a span with nothing left of a value.
test("statements are masked the way gems/forge_ops_tracker's SqlStatement.mask masks them", async () => {
  const recorded = install();
  const client = await connectedClient();
  const cases = [
    ["SELECT * FROM orders2 WHERE email = 'a@b.co' AND id = 42 AND x = $1", "SELECT * FROM orders2 WHERE email = ? AND id = ? AND x = $1"],
    ["SELECT * FROM t WHERE note = 'it''s' AND n = 'cut", "SELECT * FROM t WHERE note = ? AND n = ?"],
    ["DO $body$ BEGIN PERFORM refund(9911); END $body$", "DO ?"],
    ["SELECT $$raw 'text' 12$$, price * 1.5 FROM t WHERE a IN (1,2,3)", "SELECT ?, price * ? FROM t WHERE a IN (?,?,?)"],
    ["SELECT col1, t2.col_3 FROM table2 t2 WHERE t2.v = -17 LIMIT 10 OFFSET 20", "SELECT col1, t2.col_3 FROM table2 t2 WHERE t2.v = -? LIMIT ? OFFSET ?"],
    ["INSERT INTO users (email, age) VALUES ('jane@example.com', 34), ('joe@example.com', 51)", "INSERT INTO users (email, age) VALUES (?, ?), (?, ?)"],
    ["SELECT id FROM users WHERE name ILIKE '%jo%' ORDER BY 2 DESC", "SELECT id FROM users WHERE name ILIKE ? ORDER BY ? DESC"],
    [
      "WITH recent AS (SELECT * FROM events WHERE ts > now() - interval '7 days') SELECT count(*) FROM recent",
      "WITH recent AS (SELECT * FROM events WHERE ts > now() - interval ?) SELECT count(*) FROM recent",
    ],
    ["SELECT data->>'email' FROM profiles WHERE (data->>'age')::int >= 21", "SELECT data->>? FROM profiles WHERE (data->>?)::int >= ?"],
    ["SELECT $1::int + 7, $10 FROM t", "SELECT $1::int + ?, $10 FROM t"],
    ["CALL refund_order(12345, 'reason text')", "CALL refund_order(?, ?)"],
  ];

  for (const [statement] of cases) {
    await client.query(statement);
  }

  assert.deepEqual(
    recorded.map((span) => span.data["db.statement"]),
    cases.map(([, masked]) => masked),
  );
  const serialized = JSON.stringify(recorded.map((span) => [span.name, span.data]));
  for (const secret of ["a@b.co", "it''s", "9911", "raw 'text'", "jane@example.com", "joe@example.com", "34", "51", "%jo%", "7 days", "12345", "reason text"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("every query also adds a query breadcrumb, named like its span, outside a trace too, with only its duration", async () => {
  const spans = [];
  const breadcrumbs = [];
  installDatabaseTracing(
    (name) => spans.push(name),
    () => false,
    (message, category, level, data) => breadcrumbs.push({ message, category, level, data }),
    () => true,
  );
  const client = await connectedClient();
  const pool = newPool();

  await client.query("SELECT id FROM orders WHERE customer_email = 'jane@example.com'");
  await new Promise((resolve) => client.query("UPDATE carts SET total = $1 WHERE id = $2", [42, 7], resolve));
  await assert.rejects(client.query("SELECT * FROM fail_here"), /relation does not exist/);
  await pool.query("DELETE FROM sessions WHERE token = $1", ["secret-token"]);

  assert.deepEqual(spans, []);
  assert.deepEqual(
    breadcrumbs.map(({ message, category, level }) => [message, category, level]),
    [
      ["SELECT orders", "query", "info"],
      ["UPDATE carts", "query", "info"],
      ["SELECT fail_here", "query", "info"],
      ["DELETE sessions", "query", "info"],
    ],
  );
  for (const { data } of breadcrumbs) {
    assert.deepEqual(Object.keys(data), ["duration_ms"]);
    assert.ok(data.duration_ms >= 0);
  }
  const sent = JSON.stringify(breadcrumbs);
  for (const secret of ["jane@example.com", "secret-token", "42", "customer_email"]) {
    assert.equal(sent.includes(secret), false, secret);
  }
});

test("end to end: queries outside any request add query breadcrumbs to the trail an error reports, unless trackBreadcrumbs is off", async () => {
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
  const pool = newPool();

  await pool.query("SELECT id FROM orders WHERE customer_email = 'jane@example.com'");
  forgeOpsTracker.captureException(new Error("checkout failed"));
  await waitUntil(() => requests.length === 1);

  assert.deepEqual(
    requests[0].breadcrumbs.map(({ category, message, level }) => [category, message, level]),
    [["query", "SELECT orders", "info"]],
  );
  assert.equal(typeof requests[0].breadcrumbs[0].data.duration_ms, "number");
  assert.equal(JSON.stringify(requests[0]).includes("jane@example.com"), false);

  forgeOpsTracker._resetForTesting();
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    enabledEnvironments: new Set(["production"]),
    environment: "production",
    trackBreadcrumbs: false,
    installProcessHandlers: false,
  });
  await pool.query("SELECT id FROM orders");
  forgeOpsTracker.captureException(new Error("checkout failed again"));
  await waitUntil(() => requests.length === 2);

  assert.equal("breadcrumbs" in requests[1], false);
});

test("end to end: a pg query inside a traced request is sent as a database span under the request's root", async () => {
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
  const pool = newPool();

  await forgeOpsTracker._runWithSpanTrace(async () => {
    await pool.query("SELECT id FROM orders WHERE customer_email = 'jane@example.com'");
    await forgeOpsTracker.span("Load invoices", () => pool.query("SELECT * FROM invoices WHERE id = $1", [8]));
    forgeOpsTracker._finishSpanTrace("GET /orders", new Date(), 10);
  });
  await waitUntil(() => requests.length === 1);

  const [trace] = requests;
  const root = trace.spans.find((span) => span.kind === "controller");
  const service = trace.spans.find((span) => span.name === "Load invoices");
  const queries = trace.spans.filter((span) => span.kind === "database");
  assert.deepEqual(
    queries.map((span) => [span.name, span.parent_span_id, span.data]),
    [
      ["SELECT orders", root.span_id, { "db.system": "postgresql", "db.statement": "SELECT id FROM orders WHERE customer_email = ?" }],
      ["SELECT invoices", service.span_id, { "db.system": "postgresql", "db.statement": "SELECT * FROM invoices WHERE id = $1" }],
    ],
  );
  assert.equal(JSON.stringify(trace).includes("jane@example.com"), false);
});

test("end to end: nothing is recorded outside a traced request, or with trackTracing off", async () => {
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
    trackTracing: false,
    installProcessHandlers: false,
  });
  const pool = newPool();

  await pool.query("SELECT 1");
  await forgeOpsTracker._runWithSpanTrace(async () => {
    await pool.query("SELECT 1");
    forgeOpsTracker._finishSpanTrace("GET /orders", new Date(), 10);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(requests, []);
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

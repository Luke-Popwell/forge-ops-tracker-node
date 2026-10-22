import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every test here runs a real child process against a local listener: what's under test is what
// happens as a process dies, which this test runner's own process can't do.

const indexUrl = JSON.stringify(new URL("../src/index.js", import.meta.url).href);

/**
 * Runs `body` as an ES module in a child Node process with the client initialized against a local
 * listener, and returns its exit code, stderr, stdout and every request the listener received.
 * With hang: true the listener never answers.
 */
async function runChild(body, { hang = false, execArgv = [], init, env, commonJs = false } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      received.push({ path: req.url, body: JSON.parse(data) });
      if (!hang) {
        res.statusCode = 202;
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const dsn = `http://key@127.0.0.1:${server.address().port}/api/v1/events`;
    const initCall =
      init ??
      `forgeOpsTracker.init({
        dsn: ${JSON.stringify(dsn)},
        environment: "production",
        enabledEnvironments: new Set(["production"]),
        detectChanges: false,
      });`;
    // commonJs: a plain `node -e` script, which is CommonJS, loading the client with require().
    const script = commonJs
      ? `const forgeOpsTracker = require(${JSON.stringify(fileURLToPath(new URL("../src/index.js", import.meta.url)))});
      ${initCall}
      ${body}`
      : `
      import * as forgeOpsTracker from ${indexUrl};
      ${initCall}
      ${body}
    `;
    const inputType = commonJs ? [] : ["--input-type=module"];
    const child = spawn(process.execPath, [...execArgv, ...inputType, "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? env(dsn) : process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const startedAt = Date.now();
    const code = await new Promise((resolve) => child.on("close", resolve));
    return { code, stdout, stderr, received, elapsedMs: Date.now() - startedAt };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function eventMessages(received) {
  return received.filter((request) => request.path === "/api/v1/events").map((request) => request.body.message);
}

test("an uncaught exception is delivered before the process exits with code 1 and Node's usual stderr", async () => {
  const { code, stderr, received } = await runChild(`
    setTimeout(() => { throw new Error("boom from a timer"); }, 0);
  `);

  assert.equal(code, 1);
  assert.deepEqual(eventMessages(received), ["boom from a timer"]);
  assert.match(stderr, /Error: boom from a timer\n\s+at /);
  assert.match(stderr, /Node\.js v\d+/);
});

test("a throw at the top level of the entry module is delivered too", async () => {
  const { code, received } = await runChild(`
    throw new Error("boom at the top level");
  `);

  assert.equal(code, 1);
  assert.deepEqual(eventMessages(received), ["boom at the top level"]);
});

test("an unhandled rejection still crashes the process with code 1, and is delivered first", async () => {
  const { code, stderr, received } = await runChild(`
    setTimeout(() => { Promise.reject(new Error("rejected and never handled")); }, 0);
  `);

  assert.equal(code, 1);
  assert.deepEqual(eventMessages(received), ["rejected and never handled"]);
  assert.match(stderr, /Error: rejected and never handled/);
});

test("a promise rejected with a non-Error still crashes the process the way Node does", async () => {
  const { code, stderr, received } = await runChild(`
    setTimeout(() => { Promise.reject("just a string"); }, 0);
  `);

  assert.equal(code, 1);
  assert.match(stderr, /ERR_UNHANDLED_REJECTION/);
  assert.equal(eventMessages(received).length, 1);
  assert.match(eventMessages(received)[0], /just a string/);
});

test("--unhandled-rejections=warn keeps the process running, and still reports the rejection", async () => {
  const { code, received } = await runChild(
    `
    Promise.reject(new Error("only a warning"));
    setTimeout(async () => { await forgeOpsTracker.flush(); console.log("still running"); }, 50);
  `,
    { execArgv: ["--unhandled-rejections=warn"] },
  );

  assert.equal(code, 0);
  assert.deepEqual(eventMessages(received), ["only a warning"]);
});

test("the app's own uncaughtException listener decides what happens; the error is still reported", async () => {
  const { code, stdout, stderr, received } = await runChild(`
    process.on("uncaughtException", async (error) => {
      await forgeOpsTracker.flush();
      console.log("app handled: " + error.message);
      process.exit(0);
    });
    setTimeout(() => { throw new Error("handled by the app"); }, 0);
  `);

  assert.equal(code, 0);
  assert.equal(stdout.trim(), "app handled: handled by the app");
  assert.doesNotMatch(stderr, /Node\.js v\d+/);
  assert.deepEqual(eventMessages(received), ["handled by the app"]);
});

test("the app's own unhandledRejection listener keeps the process alive, as without this client", async () => {
  const { code, stdout, received } = await runChild(`
    process.on("unhandledRejection", (reason) => console.log("app saw: " + reason.message));
    Promise.reject(new Error("seen by the app"));
    setTimeout(async () => { await forgeOpsTracker.flush(); console.log("still running"); }, 50);
  `);

  assert.equal(code, 0);
  assert.equal(stdout.trim(), "app saw: seen by the app\nstill running");
  assert.deepEqual(eventMessages(received), ["seen by the app"]);
});

test("await flush() before process.exit() delivers what was just captured", async () => {
  const { code, received } = await runChild(`
    forgeOpsTracker.captureException(new Error("reported, then exit"));
    await forgeOpsTracker.flush();
    process.exit(3);
  `);

  assert.equal(code, 3);
  assert.deepEqual(eventMessages(received), ["reported, then exit"]);
});

test("flush gives up once its timeout passes when ForgeOps doesn't answer", async () => {
  const { code, stdout } = await runChild(
    `
    forgeOpsTracker.captureException(new Error("never answered"));
    const startedAt = Date.now();
    const delivered = await forgeOpsTracker.flush(200);
    console.log(JSON.stringify({ delivered, elapsedMs: Date.now() - startedAt }));
    process.exit(0);
  `,
    { hang: true },
  );

  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.delivered, false);
  assert.ok(result.elapsedMs >= 150 && result.elapsedMs < 1500, `waited ${result.elapsedMs}ms`);
});

test("an uncaught exception waits at most about two seconds when ForgeOps doesn't answer", async () => {
  const { code, received, elapsedMs } = await runChild(
    `
    setTimeout(() => { throw new Error("crash while unreachable"); }, 0);
  `,
    { hang: true },
  );

  assert.equal(code, 1);
  assert.equal(eventMessages(received).length, 1);
  assert.ok(elapsedMs < 6000, `took ${elapsedMs}ms`);
});

/** The parent's environment minus the DSN and anything that picks the environment, plus `extra`. */
function bareEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of ["FORGE_OPS_ENVIRONMENT", "NODE_ENV", "FORGE_OPS_DSN"]) {
    delete env[name];
  }
  return { ...env, ...extra };
}

const NOT_SENDING = /\[ForgeOps\] Not sending: this environment is "development"/g;
const DSN_ONLY_INIT = "forgeOpsTracker.init({ detectChanges: false });";

test("with only FORGE_OPS_DSN set, an error is delivered: the environment defaults to production", async () => {
  const { code, stderr, received } = await runChild(
    `
    forgeOpsTracker.captureException(new Error("sent with nothing but a DSN"));
    await forgeOpsTracker.flush();
  `,
    { init: DSN_ONLY_INIT, env: (dsn) => bareEnv({ FORGE_OPS_DSN: dsn }) },
  );

  assert.equal(code, 0);
  assert.deepEqual(eventMessages(received), ["sent with nothing but a DSN"]);
  assert.doesNotMatch(stderr, /Not sending/);
});

test("the README's require() form works from a CommonJS script with only FORGE_OPS_DSN set", async () => {
  const { code, stderr, received } = await runChild(
    `
    forgeOpsTracker.captureException(new Error("sent from CommonJS"));
  `,
    { commonJs: true, init: DSN_ONLY_INIT, env: (dsn) => bareEnv({ FORGE_OPS_DSN: dsn }) },
  );

  assert.equal(code, 0, stderr);
  assert.deepEqual(eventMessages(received), ["sent from CommonJS"]);
});

test("an explicit development environment sends nothing and warns exactly once", async () => {
  const { code, stderr, received } = await runChild(
    `
    forgeOpsTracker.init({ detectChanges: false });
    forgeOpsTracker.captureException(new Error("never sent from development"));
    await forgeOpsTracker.flush();
  `,
    { init: DSN_ONLY_INIT, env: (dsn) => bareEnv({ FORGE_OPS_DSN: dsn, NODE_ENV: "development" }) },
  );

  assert.equal(code, 0);
  assert.deepEqual(eventMessages(received), []);
  assert.equal(stderr.match(NOT_SENDING)?.length, 1, stderr);
  assert.match(stderr, /only production, staging are enabled\. Set FORGE_OPS_ENVIRONMENT=production/);
});

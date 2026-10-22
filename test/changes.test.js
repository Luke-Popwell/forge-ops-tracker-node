import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildChange, buildSnapshot, CHANGE_KINDS, dependencies, envVarNames } from "../src/changes.js";
import { Configuration } from "../src/configuration.js";
import * as forgeOpsTracker from "../src/index.js";

const DSN = "https://secret-key@tracker.example.com/api/v1/events";
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mockFetch(status = 202) {
  const requests = [];
  globalThis.fetch = async (uri, init) => {
    requests.push({ uri, init, body: JSON.parse(init.body) });
    return new Response(null, { status });
  };
  return requests;
}

function newConfiguration(overrides = {}) {
  const config = new Configuration();
  config.dsn = DSN;
  config.environment = "production";
  return Object.assign(config, overrides);
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  forgeOpsTracker._resetForTesting();
});

// recordChange

test("recordChange posts the full payload to the changes endpoint", async () => {
  const requests = mockFetch();
  forgeOpsTracker.init({ dsn: DSN, environment: "production", installProcessHandlers: false });

  const queued = forgeOpsTracker.recordChange({
    kind: "feature_flag",
    title: "Enabled new_checkout for 10%",
    details: { flag: "new_checkout", rollout: 10 },
    service: "web",
    actor: "luke",
    url: "https://flags.example.com/new_checkout",
    id: "flag-42",
    occurredAt: new Date("2026-09-25T12:00:00Z"),
  });

  assert.equal(queued, true);
  await waitUntil(() => requests.length === 1);
  assert.equal(requests[0].uri, "https://tracker.example.com/api/v1/changes");
  assert.equal(requests[0].init.headers.Authorization, "Bearer secret-key");
  assert.deepEqual(requests[0].body, {
    kind: "feature_flag",
    title: "Enabled new_checkout for 10%",
    details: { flag: "new_checkout", rollout: 10 },
    environment: "production",
    service: "web",
    actor: "luke",
    url: "https://flags.example.com/new_checkout",
    id: "flag-42",
    occurred_at: "2026-09-25T12:00:00.000Z",
  });
});

test("optional fields are left out and occurred_at defaults to now", () => {
  const payload = buildChange(newConfiguration(), { kind: "config", title: "Raised the timeout" });

  assert.deepEqual(Object.keys(payload).sort(), ["details", "environment", "kind", "occurred_at", "title"]);
  assert.deepEqual(payload.details, {});
  assert.ok(Math.abs(Date.now() - Date.parse(payload.occurred_at)) < 5000);
});

test("an explicit environment overrides the configured one", () => {
  assert.equal(buildChange(newConfiguration(), { kind: "config", title: "x", environment: "staging" }).environment, "staging");
});

test("every known kind is sent as is, and anything else as other", () => {
  for (const kind of CHANGE_KINDS) {
    assert.equal(buildChange(newConfiguration(), { kind, title: "x" }).kind, kind);
  }
  for (const kind of ["deploy", "", undefined, "FEATURE_FLAG", 42]) {
    assert.equal(buildChange(newConfiguration(), { kind, title: "x" }).kind, "other");
  }
});

test("the title is truncated to 200 characters and non-object details are dropped", () => {
  const payload = buildChange(newConfiguration(), { kind: "config", title: "x".repeat(300), details: ["not", "an", "object"] });

  assert.equal(payload.title, "x".repeat(200));
  assert.deepEqual(payload.details, {});
});

test("a blank title sends nothing", async () => {
  const requests = mockFetch();
  forgeOpsTracker.init({ dsn: DSN, environment: "production", installProcessHandlers: false });

  assert.equal(forgeOpsTracker.recordChange({ kind: "config", title: "   " }), false);
  await sleep(20);
  assert.equal(requests.length, 0);
});

test("recordChange is a no-op when the client isn't enabled", async () => {
  const requests = mockFetch();
  forgeOpsTracker.init({ dsn: DSN, environment: "development", installProcessHandlers: false });

  assert.equal(forgeOpsTracker.recordChange({ kind: "config", title: "Raised the timeout" }), false);
  await sleep(20);
  assert.equal(requests.length, 0);
});

test("recordChange never throws on an error response or a network failure", async () => {
  for (const status of [403, 422, 500]) {
    forgeOpsTracker._resetForTesting();
    const requests = mockFetch(status);
    forgeOpsTracker.init({ dsn: DSN, environment: "production", installProcessHandlers: false });

    assert.equal(forgeOpsTracker.recordChange({ kind: "config", title: "x" }), true);
    await waitUntil(() => requests.length === 1);
  }

  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  assert.doesNotThrow(() => forgeOpsTracker.recordChange({ kind: "config", title: "x" }));
  assert.doesNotThrow(() => forgeOpsTracker.recordChange(undefined));
  await sleep(20);
});

// Startup snapshot

async function withApp(manifest, installed, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-ops-changes-"));
  try {
    if (manifest !== null) {
      await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
    }
    for (const [name, version] of Object.entries(installed)) {
      await mkdir(path.join(root, "node_modules", name), { recursive: true });
      await writeFile(path.join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
    }
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("dependencies are the app's direct dependencies resolved to installed versions", async () => {
  await withApp(
    { dependencies: { express: "^5.0.0", "@scope/tool": "~1.2.0", "not-installed": "^1.0.0" }, devDependencies: { eslint: "^10.0.0" } },
    { express: "5.1.0", "@scope/tool": "1.2.3", eslint: "10.0.0" },
    async (root) => {
      assert.deepEqual(await dependencies(root), { "@scope/tool": "1.2.3", express: "5.1.0" });
    },
  );
});

test("dependencies are left out rather than guessed when there's no package.json", async () => {
  await withApp(null, {}, async (root) => {
    const snapshot = await buildSnapshot(newConfiguration({ appRoot: root }));
    assert.equal("dependencies" in snapshot.state, false);
  });
});

test("dependencies are capped at 3000 entries", async () => {
  const manifest = { dependencies: {} };
  for (let i = 0; i < 3100; i++) {
    manifest.dependencies[`pkg-${String(i).padStart(5, "0")}`] = "^1.0.0";
  }
  await withApp(manifest, {}, async (root) => {
    await Promise.all(
      Object.keys(manifest.dependencies).map(async (name) => {
        await mkdir(path.join(root, "node_modules", name), { recursive: true });
        await writeFile(path.join(root, "node_modules", name, "package.json"), JSON.stringify({ version: "1.0.0" }));
      }),
    );
    const deps = await dependencies(root);
    assert.equal(Object.keys(deps).length, 3000);
    assert.equal(Object.keys(deps)[0], "pkg-00000");
  });
});

test("the snapshot has runtime and dependencies but no env var names by default", async () => {
  await withApp({ dependencies: { express: "^5.0.0" } }, { express: "5.1.0" }, async (root) => {
    const snapshot = await buildSnapshot(newConfiguration({ appRoot: root }));

    assert.equal(snapshot.environment, "production");
    assert.equal(snapshot.state.runtime, `node ${process.versions.node}`);
    assert.deepEqual(snapshot.state.dependencies, { express: "5.1.0" });
    assert.equal("env_var_names" in snapshot.state, false);
    assert.equal("schema_version" in snapshot.state, false);
  });
});

test("env var names, never values, are sent when trackEnvVarNames is on", async () => {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, { DATABASE_URL: "postgres://secret", HOSTNAME: "web-1", STRIPE_KEY: "sk_live" });

    const snapshot = await buildSnapshot(newConfiguration({ trackEnvVarNames: true }));

    assert.deepEqual(snapshot.state.env_var_names, ["DATABASE_URL", "STRIPE_KEY"]);
    assert.equal(JSON.stringify(snapshot).includes("sk_live"), false);
    assert.equal(JSON.stringify(snapshot).includes("postgres://secret"), false);
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test("the env var denylist drops host-specific noise and the SDK's own FORGE_OPS_* settings", () => {
  const names = [
    "HOSTNAME", "HOST", "HOME", "PATH", "PWD", "OLDPWD", "SHLVL", "_", "TERM", "USER", "LOGNAME", "SHELL",
    "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ", "PORT", "DYNO", "INVOCATION_ID", "JOURNAL_STREAM",
    "SYSTEMD_EXEC_PID", "MEMORY_PRESSURE_WATCH", "KUBERNETES_SERVICE_HOST", "REDIS_SERVICE_HOST",
    "REDIS_SERVICE_PORT", "REDIS_SERVICE_PORT_HTTP", "REDIS_PORT_6379_TCP", "REDIS_PORT_6379_TCP_ADDR",
    "FORGE_OPS_DSN", "FORGE_OPS_RELEASE", "SESSION_SECRET", "NODE_ENV", "DATABASE_URL",
  ];

  assert.deepEqual(envVarNames(Object.fromEntries(names.map((name) => [name, "value"]))), ["DATABASE_URL", "NODE_ENV", "SESSION_SECRET"]);
});

test("init sends one snapshot to the change_snapshots endpoint, once per process", async () => {
  forgeOpsTracker._resetForTesting({ changeSnapshot: true });
  const requests = mockFetch();

  forgeOpsTracker.init({ dsn: DSN, environment: "production", installProcessHandlers: false });
  forgeOpsTracker.init({ dsn: DSN, environment: "production", installProcessHandlers: false });

  await waitUntil(() => requests.length === 1);
  assert.equal(requests[0].uri, "https://tracker.example.com/api/v1/change_snapshots");
  assert.equal(requests[0].init.headers.Authorization, "Bearer secret-key");
  assert.equal(requests[0].body.environment, "production");
  assert.equal(requests[0].body.state.runtime, `node ${process.versions.node}`);
  await sleep(50);
  assert.equal(requests.length, 1);
});

test("detectChanges false sends no snapshot", async () => {
  forgeOpsTracker._resetForTesting({ changeSnapshot: true });
  const requests = mockFetch();

  forgeOpsTracker.init({ dsn: DSN, environment: "production", installProcessHandlers: false, detectChanges: false });

  await sleep(50);
  assert.equal(requests.length, 0);
});

test("no snapshot is sent when the client isn't enabled", async () => {
  forgeOpsTracker._resetForTesting({ changeSnapshot: true });
  const requests = mockFetch();

  forgeOpsTracker.init({ dsn: DSN, environment: "development", installProcessHandlers: false });

  await sleep(50);
  assert.equal(requests.length, 0);
});

test("a failing snapshot never throws", async () => {
  forgeOpsTracker._resetForTesting({ changeSnapshot: true });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError("fetch failed");
  };

  assert.doesNotThrow(() => forgeOpsTracker.init({ dsn: DSN, environment: "production", installProcessHandlers: false }));
  await waitUntil(() => attempts === 1);
});

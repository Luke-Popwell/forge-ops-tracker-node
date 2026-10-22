import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Configuration } from "../src/configuration.js";
import { EventBuilder } from "../src/eventBuilder.js";

function newConfiguration() {
  const config = new Configuration();
  config.environment = "production";
  config.release = "abc123";
  config.serverName = "web-1";
  return config;
}

function raiseAndCapture() {
  try {
    throw new TypeError("boom");
  } catch (e) {
    return e;
  }
}

test("builds a payload with the exception class, message, and configured metadata", () => {
  const builder = new EventBuilder(newConfiguration());
  const error = raiseAndCapture();

  const payload = builder.build(error, { url: "https://example.com" });

  assert.equal(payload.exception_class, "TypeError");
  assert.equal(payload.message, "boom");
  assert.equal(payload.environment, "production");
  assert.equal(payload.release, "abc123");
  assert.equal(payload.server_name, "web-1");
  assert.deepEqual(payload.context, { url: "https://example.com" });
  assert.match(payload.occurred_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(payload.sdk_name, "node");
});

test("parses real stack frames with file, line, and method", () => {
  const builder = new EventBuilder(newConfiguration());
  const error = raiseAndCapture();

  const frames = builder.build(error).backtrace;

  assert.ok(frames.length >= 1);
  const frame = frames[0]; // V8 lists innermost (where it was thrown) first
  assert.equal(frame.file, new URL(import.meta.url).pathname);
  assert.equal(frame.method, "raiseAndCapture");
  assert.equal(typeof frame.line, "number");
});

test("marks a frame under appRoot as in_app", () => {
  const config = newConfiguration();
  config.appRoot = new URL(".", import.meta.url).pathname;
  const error = raiseAndCapture();

  const frames = new EventBuilder(config).build(error).backtrace;

  assert.ok(frames.some((f) => f.in_app));
});

test("marks every frame as not in_app when appRoot does not match", () => {
  const config = newConfiguration();
  config.appRoot = "/definitely/not/here";
  const error = raiseAndCapture();

  const frames = new EventBuilder(config).build(error).backtrace;

  assert.ok(frames.every((f) => !f.in_app));
});

test("captures the backtrace at construction time, even before being thrown", () => {
  // Unlike Ruby/.NET/Python (and like PHP), V8 captures an Error's stack
  // at *construction* time, not at throw time: verified directly, not
  // assumed: so there's no "empty backtrace when never thrown" case to
  // test here; a constructed-but-unthrown Error still has a real, non-
  // empty stack.
  const builder = new EventBuilder(newConfiguration());
  const error = new TypeError("boom"); // constructed, never thrown

  const frames = builder.build(error).backtrace;

  assert.ok(frames.length >= 1);
});

test("scrubs likely PII out of the message and context by default", () => {
  const builder = new EventBuilder(newConfiguration());
  let payload;
  try {
    throw new Error("failed for user@example.com");
  } catch (error) {
    payload = builder.build(error, { user: { email: "ada@example.com", password: "hunter2" } });
  }

  assert.equal(payload.message, "failed for [EMAIL FILTERED]");
  assert.deepEqual(payload.context, { user: { email: "[EMAIL FILTERED]", password: "[FILTERED]" } });
});

test("includes the user when given one, never scrubbed even though it's an email", () => {
  const builder = new EventBuilder(newConfiguration());
  const error = raiseAndCapture();

  const payload = builder.build(error, {}, { id: 42, email: "ada@example.com" });

  assert.deepEqual(payload.user, { id: 42, email: "ada@example.com" });
});

test("omits the user key entirely when none was given", () => {
  const builder = new EventBuilder(newConfiguration());
  const error = raiseAndCapture();

  const payload = builder.build(error);

  assert.equal("user" in payload, false);
});

test("leaves the payload untouched when scrubPii is disabled", () => {
  const config = newConfiguration();
  config.scrubPii = false;
  const builder = new EventBuilder(config);
  let payload;
  try {
    throw new Error("failed for user@example.com");
  } catch (error) {
    payload = builder.build(error, { email: "ada@example.com" });
  }

  assert.equal(payload.message, "failed for user@example.com");
  assert.deepEqual(payload.context, { email: "ada@example.com" });
});

// Source context capture. Frames are fabricated the same way Ruby's spec
// does: an Error whose `.stack` is overwritten with a single hand-built
// frame line pointing at a real temp file and line, rather than one
// captured from wherever this test happens to throw: so the exact
// file/line under test is under our control.
function writeSourceFile(lineCount, name = "app_file.js") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ops-tracker-"));
  const filePath = path.join(dir, name);
  const content = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
  fs.writeFileSync(filePath, content);
  return filePath;
}

function frameFor(builder, filePath, line) {
  const error = new Error("boom");
  error.stack = `Error: boom\n    at call (${filePath}:${line}:1)`;
  return builder.build(error).backtrace[0];
}

test("attaches contextLine/preContext/postContext around an in-app frame's culprit line, by default", () => {
  const config = newConfiguration();
  const filePath = writeSourceFile(20);
  config.appRoot = path.dirname(filePath);
  const builder = new EventBuilder(config);

  const frame = frameFor(builder, filePath, 10);

  assert.equal(frame.context_line, "line 10");
  assert.deepEqual(
    frame.pre_context,
    Array.from({ length: 5 }, (_, i) => `line ${i + 5}`),
  );
  assert.deepEqual(
    frame.post_context,
    Array.from({ length: 5 }, (_, i) => `line ${i + 11}`),
  );
});

test("clamps pre_context/post_context at the start and end of the file rather than throwing", () => {
  const config = newConfiguration();
  const filePath = writeSourceFile(3);
  config.appRoot = path.dirname(filePath);
  const builder = new EventBuilder(config);

  const firstFrame = frameFor(builder, filePath, 1);
  const lastFrame = frameFor(builder, filePath, 3);

  assert.deepEqual(firstFrame.pre_context, []);
  assert.deepEqual(firstFrame.post_context, ["line 2", "line 3"]);
  assert.deepEqual(lastFrame.pre_context, ["line 1", "line 2"]);
  assert.deepEqual(lastFrame.post_context, []);
});

test("truncates an individual line longer than MAX_CONTEXT_LINE_LENGTH", () => {
  const config = newConfiguration();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ops-tracker-"));
  const filePath = path.join(dir, "app_file.js");
  fs.writeFileSync(filePath, "x".repeat(600));
  config.appRoot = dir;
  const builder = new EventBuilder(config);

  const frame = frameFor(builder, filePath, 1);

  assert.equal(frame.context_line, `${"x".repeat(500)}...`);
});

test("never attaches context to a frame outside appRoot", () => {
  const config = newConfiguration();
  const filePath = writeSourceFile(20);
  config.appRoot = "/somewhere/else";
  const builder = new EventBuilder(config);

  const frame = frameFor(builder, filePath, 10);

  assert.equal("context_line" in frame, false);
  assert.equal("pre_context" in frame, false);
  assert.equal("post_context" in frame, false);
});

test("leaves a frame untouched, with no file read attempted, when captureSourceContext is disabled", () => {
  const config = newConfiguration();
  config.captureSourceContext = false;
  const filePath = writeSourceFile(20);
  config.appRoot = path.dirname(filePath);
  const builder = new EventBuilder(config);

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error("fs.readFileSync should not be called when captureSourceContext is disabled");
  };
  try {
    const frame = frameFor(builder, filePath, 10);
    assert.equal("context_line" in frame, false);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("attaches breadcrumbs when given at least one", () => {
  const builder = new EventBuilder(newConfiguration());
  const error = raiseAndCapture();
  const breadcrumbs = [{ category: "query", message: "User Load", level: "info", timestamp: "2026-01-01T00:00:00Z", data: {} }];

  const payload = builder.build(error, {}, null, breadcrumbs);

  assert.deepEqual(payload.breadcrumbs, breadcrumbs);
});

test("omits the breadcrumbs key entirely when given an empty array", () => {
  const builder = new EventBuilder(newConfiguration());
  const error = raiseAndCapture();

  const payload = builder.build(error, {}, null, []);

  assert.equal("breadcrumbs" in payload, false);
});

test("omits the breadcrumbs key entirely when not given at all", () => {
  const builder = new EventBuilder(newConfiguration());
  const error = raiseAndCapture();

  const payload = builder.build(error);

  assert.equal("breadcrumbs" in payload, false);
});

test("scrubs likely PII out of breadcrumb message/data, unlike the exempt user", () => {
  const builder = new EventBuilder(newConfiguration());
  const error = raiseAndCapture();
  const breadcrumbs = [
    {
      category: "query",
      message: "lookup for user@example.com",
      level: "info",
      timestamp: "2026-01-01T00:00:00Z",
      data: { password: "hunter2" },
    },
  ];

  const payload = builder.build(error, {}, null, breadcrumbs);

  assert.equal(payload.breadcrumbs[0].message, "lookup for [EMAIL FILTERED]");
  assert.deepEqual(payload.breadcrumbs[0].data, { password: "[FILTERED]" });
});

test("leaves breadcrumbs untouched when scrubPii is disabled", () => {
  const config = newConfiguration();
  config.scrubPii = false;
  const builder = new EventBuilder(config);
  const error = raiseAndCapture();
  const breadcrumbs = [{ category: "query", message: "user@example.com", level: "info", timestamp: "2026-01-01T00:00:00Z", data: {} }];

  const payload = builder.build(error, {}, null, breadcrumbs);

  assert.equal(payload.breadcrumbs[0].message, "user@example.com");
});

test("leaves a frame untouched when the recorded file can't be read", () => {
  const config = newConfiguration();
  config.appRoot = os.tmpdir();
  const builder = new EventBuilder(config);
  const missingPath = path.join(os.tmpdir(), `forge-ops-tracker-missing-${Date.now()}.js`);

  const frame = frameFor(builder, missingPath, 1);

  assert.equal("context_line" in frame, false);
});

test("includes the request's trace fields when given, and never scrubs them", () => {
  const config = newConfiguration();
  config.scrubPii = true;

  const payload = new EventBuilder(config).build(raiseAndCapture(), {}, null, [], {
    transactionName: "POST /users/:email/confirm",
    endpoint: "POST /users/:email/confirm",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  });

  assert.equal(payload.transaction_name, "POST /users/:email/confirm");
  assert.equal(payload.endpoint, "POST /users/:email/confirm");
  assert.equal(payload.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
});

test("omits the request's trace fields entirely when not given", () => {
  const payload = new EventBuilder(newConfiguration()).build(raiseAndCapture(), {}, null, [], { transactionName: null });

  assert.equal("transaction_name" in payload, false);
  assert.equal("endpoint" in payload, false);
  assert.equal("trace_id" in payload, false);
});

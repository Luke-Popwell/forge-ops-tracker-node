import assert from "node:assert/strict";
import { test } from "node:test";
import { BreadcrumbBuffer } from "../src/breadcrumbBuffer.js";
import { Configuration } from "../src/configuration.js";

function configurationWithMax(maxBreadcrumbs) {
  const config = new Configuration();
  config.maxBreadcrumbs = maxBreadcrumbs;
  return config;
}

test("returns entries in insertion order, each carrying the given fields plus a timestamp", () => {
  const buffer = new BreadcrumbBuffer(configurationWithMax(3));

  buffer.add("User Load", { category: "query", level: "info", data: { duration_ms: 1.2 } });

  const entry = buffer.all()[0];
  assert.equal(entry.category, "query");
  assert.equal(entry.message, "User Load");
  assert.equal(entry.level, "info");
  assert.deepEqual(entry.data, { duration_ms: 1.2 });
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("defaults category to custom, level to info, and data to an empty object when not given", () => {
  const buffer = new BreadcrumbBuffer(configurationWithMax(3));

  buffer.add("checkpoint");

  const entry = buffer.all()[0];
  assert.equal(entry.category, "custom");
  assert.equal(entry.level, "info");
  assert.deepEqual(entry.data, {});
});

test("drops the oldest entry once maxBreadcrumbs is exceeded", () => {
  const buffer = new BreadcrumbBuffer(configurationWithMax(3));

  for (let n = 0; n < 4; n += 1) {
    buffer.add(`entry ${n}`);
  }

  assert.deepEqual(
    buffer.all().map((e) => e.message),
    ["entry 1", "entry 2", "entry 3"],
  );
});

test("re-reads maxBreadcrumbs on every add, not just at construction", () => {
  const config = configurationWithMax(3);
  const buffer = new BreadcrumbBuffer(config);

  buffer.add("one");
  buffer.add("two");
  config.maxBreadcrumbs = 1;
  buffer.add("three");

  assert.deepEqual(
    buffer.all().map((e) => e.message),
    ["three"],
  );
});

test("adds nothing at all when maxBreadcrumbs is 0", () => {
  const config = configurationWithMax(0);
  const buffer = new BreadcrumbBuffer(config);

  buffer.add("one");

  assert.deepEqual(buffer.all(), []);
});

test("treats a negative maxBreadcrumbs the same as 0, never throwing or growing unbounded", () => {
  const config = configurationWithMax(-5);
  const buffer = new BreadcrumbBuffer(config);

  buffer.add("one");

  assert.deepEqual(buffer.all(), []);
});

test("all() returns a copy, not the internal array", () => {
  const buffer = new BreadcrumbBuffer(configurationWithMax(3));
  buffer.add("one");

  const snapshot = buffer.all();
  snapshot.push({ category: "custom", message: "mutated externally" });

  assert.equal(buffer.all().length, 1);
});

test("stringifies category/message/level even when given a non-string", () => {
  const buffer = new BreadcrumbBuffer(configurationWithMax(3));

  buffer.add(404, { category: "http", level: "warning" });

  const entry = buffer.all()[0];
  assert.equal(entry.message, "404");
  assert.equal(typeof entry.message, "string");
});

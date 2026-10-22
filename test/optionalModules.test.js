import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import pg from "pg";
import { requireOptional, resolveOptional } from "../src/optionalModules.js";

test("a library that isn't installed resolves to nothing, without throwing", () => {
  assert.deepEqual(requireOptional("forge-ops-no-such-package"), []);
});

test("an installed library is loaded once, even when the app's directory and this package both find the same copy", () => {
  const loaded = requireOptional("pg");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].Client, pg.Client);
});

test("a dependency of another package is also found through that package, where only it can see it", () => {
  // redis4 (node-redis 4.x, installed under an alias) keeps its own @redis/client nested under it,
  // out of reach of the app's own directory, the way an isolating package manager lays out every one.
  const require = createRequire(import.meta.url);
  const nested = createRequire(require.resolve("redis4")).resolve("@redis/client/package.json");
  const hoisted = require.resolve("@redis/client/package.json");
  assert.notEqual(nested, hoisted);

  assert.deepEqual(resolveOptional("@redis/client/package.json"), [hoisted]);
  assert.deepEqual(resolveOptional("@redis/client/package.json", { via: "redis4" }), [hoisted, nested]);
  assert.deepEqual(resolveOptional("forge-ops-no-such-package", { via: "redis4" }), []);
});

test("no source file imports pg, ioredis or redis directly: they stay optional", () => {
  const sourceDir = new URL("../src/", import.meta.url);
  const sources = readdirSync(sourceDir, { recursive: true }).filter((file) => file.endsWith(".js"));
  for (const file of sources) {
    const source = readFileSync(new URL(file, sourceDir), "utf8");
    // A static import at the top of a file, or a direct require()/import() call; the usage examples
    // in doc comments are fine.
    assert.doesNotMatch(source, /^import\s[^\n]*["'](?:pg|ioredis|redis|@redis\/client)["']/m, file);
    assert.doesNotMatch(source, /\b(?:require|import)\(\s*["'](?:pg|ioredis|redis|@redis\/client)["']/, file);
  }
  const { dependencies = {} } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(dependencies), []);
});

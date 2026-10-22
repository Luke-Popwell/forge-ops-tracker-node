import { createRequire } from "node:module";
import path from "node:path";

/**
 * Loads a library the host app may or may not have installed (pg, ioredis), for the automatic
 * database and Redis span capture in databaseTracing.js and redisTracing.js. This SDK never
 * depends on any of them: a library that isn't installed just resolves to nothing here, and that
 * integration stays off.
 *
 * Resolved from the app's own directory (process.cwd()) first, then from this package's own
 * location, since a package manager that isolates dependencies (pnpm) may not let this package see
 * the app's copy at all. Every distinct copy found is returned (a monorepo can hold two), so each
 * one gets patched. An app whose copy can't be found this way (a bundled app, or one started from
 * another directory) can hand the module over itself instead: see instrumentPg/instrumentIoredis
 * in index.js.
 *
 * Loading through require() also covers an app that imports the library as ESM: pg's ESM entry
 * point and ioredis's CommonJS one both end up in the same require cache entry, so there's only
 * one Client/Redis class to patch either way.
 *
 * @param {string} name
 * @param {{ via?: string }} [options] see resolveOptional
 * @returns {unknown[]}
 */
export function requireOptional(name, options) {
  const require = createRequire(import.meta.url);
  return resolveOptional(name, options).map((resolved) => require(resolved));
}

/**
 * Where requireOptional would load `name` from: the absolute path of every distinct copy found,
 * without loading any of them.
 *
 * `via` names the package the app actually installs when `name` is one of its own dependencies
 * (node-redis's `redis` package depends on `@redis/client`): `name` is then also resolved from
 * wherever each copy of `via` is, since an isolating package manager only lets `via` itself see
 * it.
 *
 * @param {string} name
 * @param {{ via?: string }} [options]
 * @returns {string[]}
 */
export function resolveOptional(name, { via } = {}) {
  const bases = [path.join(process.cwd(), "package.json"), import.meta.url];
  if (via !== undefined) {
    bases.push(...bases.flatMap((base) => resolveFrom(base, via) ?? []));
  }
  const resolved = new Set();
  for (const base of bases) {
    const found = resolveFrom(base, name);
    if (found !== null) {
      resolved.add(found);
    }
  }
  return [...resolved];
}

function resolveFrom(base, name) {
  try {
    return createRequire(base).resolve(name);
  } catch {
    // Not installed where this base looks: nothing to patch from here.
    return null;
  }
}

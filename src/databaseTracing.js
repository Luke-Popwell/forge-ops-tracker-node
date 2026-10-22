import { AsyncResource } from "node:async_hooks";
import { requireOptional } from "./optionalModules.js";
import { mask } from "./sqlStatement.js";

const WRAPPED = Symbol("forgeOpsTrackerWrapped");

let installed = false;
// Every patch made, so _uninstallDatabaseTracing can put each method back exactly as found.
const patches = [];

/**
 * Records one "database" span and one "query" breadcrumb per query run through node-postgres (pg),
 * for any app that has it installed; installed from index.js's init() the same way
 * installHttpTracing is, exactly once for the life of the process (see the installed guard), and
 * checking whether a trace is being captured, and whether breadcrumbs are on, fresh on every query
 * rather than at install time. An app without pg gets nothing patched and nothing loaded (see
 * requireOptional).
 *
 * Wraps pg.Client.prototype.query, which pg.Pool's own query() also goes through, so a pooled
 * query is covered with no separate hook. Every calling style is handled: a callback (as the last
 * argument, or on a config object's own `callback`), a returned promise, and a string or config
 * object ({ text, values, name, ... }). A submittable (pg-cursor, pg-query-stream, or a raw
 * pg.Query) is passed straight through unrecorded: it has no single "done" moment this could
 * observe without adding an "error" listener, which would change what an unhandled stream error
 * does in the host app.
 *
 * The span is named "<VERB> <table>" (see queryName) and carries the statement masked by
 * sqlStatement.js's mask() as data["db.statement"] (every string and number replaced by "?", the
 * same masking span({ statement }) and gems/forge_ops_tracker's database spans apply) and
 * "postgresql" as data["db.system"]. Bind values are never read.
 *
 * The breadcrumb is the one gems/forge_ops_tracker and the Python SDK's SQLAlchemy integration add
 * per query: the span's own name as its message (never the statement), category "query", and only
 * { duration_ms } as data. A span is only recorded inside a trace; a breadcrumb whenever automatic
 * breadcrumbs are on, into whatever trail is current (a request's own, or the standalone one
 * addBreadcrumb would start outside a request).
 *
 * @param {(name: string, kind: string, startedAt: Date, durationMs: number, data?: Record<string, unknown>) => void} recordSpan
 * @param {() => boolean} isTracing whether the current async context has a trace to record into
 * @param {(message: string, category: string, level?: string, data?: Record<string, unknown>) => void} [recordBreadcrumb]
 * @param {() => boolean} [ensureBreadcrumbTrail] whether a breadcrumb recorded from the current
 *   async context would be kept (see index.js's _ensureBreadcrumbTrail)
 */
export function installDatabaseTracing(recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail) {
  if (installed) {
    return;
  }
  installed = true;
  for (const pg of requireOptional("pg")) {
    instrumentPg(pg, recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail);
  }
}

/**
 * Patches one pg module (what `import pg from "pg"` returns). Safe to call more than once for the
 * same module: a method this already wrapped is left alone.
 *
 * Also binds a callback passed to pg.Pool#connect to the async context it was called from, while a
 * trace is being captured or breadcrumbs are being kept. When every pooled client is busy, pg-pool
 * queues the request and later hands it a client from inside whichever other request released
 * one, so without this, a query run on that client would be recorded into the wrong request's
 * trace and breadcrumb trail.
 *
 * @param {any} pg
 * @param {Parameters<typeof installDatabaseTracing>[0]} recordSpan
 * @param {() => boolean} isTracing
 * @param {Parameters<typeof installDatabaseTracing>[2]} [recordBreadcrumb]
 * @param {() => boolean} [ensureBreadcrumbTrail]
 * @returns {boolean} whether there was a pg Client to patch
 */
export function instrumentPg(pg, recordSpan, isTracing, recordBreadcrumb = () => {}, ensureBreadcrumbTrail = () => false) {
  const clientPrototype = pg?.Client?.prototype;
  if (typeof clientPrototype?.query !== "function") {
    return false;
  }
  patch(clientPrototype, "query", (original) => wrapQuery(original, recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail));

  const poolPrototype = pg.Pool?.prototype;
  if (typeof poolPrototype?.connect === "function") {
    patch(poolPrototype, "connect", (original) => wrapConnect(original, isTracing, ensureBreadcrumbTrail));
  }
  return true;
}

/** @internal test-only: restores every method installDatabaseTracing/instrumentPg replaced. */
export function _uninstallDatabaseTracing() {
  while (patches.length > 0) {
    const { target, key, original, own } = patches.pop();
    if (own) {
      target[key] = original;
    } else {
      delete target[key];
    }
  }
  installed = false;
}

function patch(target, key, wrapper) {
  const original = target[key];
  if (original[WRAPPED]) {
    return;
  }
  const wrapped = wrapper(original);
  wrapped[WRAPPED] = true;
  patches.push({ target, key, original, own: Object.prototype.hasOwnProperty.call(target, key) });
  target[key] = wrapped;
}

function wrapQuery(originalQuery, recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail) {
  return function patchedQuery(config, values, callback) {
    if (config == null || typeof config.submit === "function") {
      return originalQuery.apply(this, arguments);
    }
    const span = isTracing();
    const breadcrumb = ensureBreadcrumbTrail();
    if (!span && !breadcrumb) {
      return originalQuery.apply(this, arguments);
    }

    const statement = typeof config === "string" ? config : config.text;
    const masked = typeof statement === "string" ? mask(statement, "postgresql") : null;
    const startedAt = new Date();
    const start = performance.now();

    // Bound to the caller's async context now: pg calls back (and settles its promise) from its
    // socket's own event handlers, where the trace and the breadcrumb trail this query belongs to
    // aren't the current ones.
    let finished = false;
    const finish = AsyncResource.bind(() => {
      if (finished) {
        return;
      }
      finished = true;
      const name = queryName(masked);
      const durationMs = performance.now() - start;
      if (breadcrumb) {
        recordBreadcrumb(name, "query", "info", { duration_ms: Math.round(durationMs * 10) / 10 });
      }
      if (span) {
        const data = { "db.system": "postgresql" };
        if (masked !== null) {
          data["db.statement"] = masked;
        }
        recordSpan(name, "database", startedAt, durationMs, data);
      }
    });

    const args = [...arguments];
    const callbackIndex = typeof callback === "function" ? 2 : typeof values === "function" ? 1 : -1;
    if (callbackIndex !== -1) {
      args[callbackIndex] = withFinish(args[callbackIndex], finish);
      return originalQuery.apply(this, args);
    }
    if (typeof config === "object" && typeof config.callback === "function") {
      // A new object inheriting from the caller's, with only `callback` replaced: pg reads the
      // rest (text, values, name, rowMode...) through it unchanged, getters included.
      args[0] = Object.create(config, {
        callback: { value: withFinish(config.callback, finish), writable: true, enumerable: true, configurable: true },
      });
      return originalQuery.apply(this, args);
    }

    const result = originalQuery.apply(this, args);
    if (!result || typeof result.then !== "function") {
      return result;
    }
    // The promise returned in pg's place settles exactly like pg's own, so a rejection the app
    // never handles is still reported as unhandled, the same as without this wrapper.
    return result.then(
      (value) => {
        finish();
        return value;
      },
      (error) => {
        finish();
        throw error;
      },
    );
  };
}

function withFinish(callback, finish) {
  return function queryCallback(...args) {
    finish();
    return callback.apply(this, args);
  };
}

function wrapConnect(originalConnect, isTracing, ensureBreadcrumbTrail) {
  return function patchedConnect(callback, ...rest) {
    if (typeof callback === "function" && (isTracing() || ensureBreadcrumbTrail())) {
      return originalConnect.call(this, AsyncResource.bind(callback), ...rest);
    }
    return originalConnect.apply(this, arguments);
  };
}

const SELECT_DELETE = /^\s*(SELECT|DELETE)\b[\s\S]*?\bFROM\s+["'`]?(\w+)/i;
const INSERT_UPDATE = /^\s*(INSERT INTO|UPDATE)\s+["'`]?(\w+)/i;

/**
 * A low-cardinality span name for a query, never the SQL text itself: "<VERB> <table>" for the
 * shapes that carry a table in a predictable place ("SELECT orders", "INSERT INTO orders",
 * "UPDATE orders", "DELETE sessions"), just the first keyword otherwise ("BEGIN", "SELECT" for
 * "SELECT 1"), and "SQL" for a blank or missing statement. A direct port of the Python SDK's
 * _query_transaction_name (and the Elixir SDK's QueryNaming), so the same query gets the same name
 * in every SDK. Given the masked statement, so a quoted value can never become part of a name.
 *
 * @param {string | null | undefined} sql
 * @returns {string}
 */
export function queryName(sql) {
  if (typeof sql !== "string") {
    return "SQL";
  }
  const match = SELECT_DELETE.exec(sql) ?? INSERT_UPDATE.exec(sql);
  if (match) {
    return `${match[1].toUpperCase()} ${match[2]}`;
  }
  const first = sql.trim().split(/\s+/, 1)[0];
  return first ? first.toUpperCase() : "SQL";
}

import { AsyncResource } from "node:async_hooks";
import diagnosticsChannel from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { requireOptional, resolveOptional } from "./optionalModules.js";

const WRAPPED = Symbol("forgeOpsTrackerWrapped");
const SEEN = Symbol("forgeOpsTrackerSeen");
const SPAN = Symbol("forgeOpsTrackerSpan");
const NODE_REDIS_COMMAND_CHANNEL = "node-redis:command";
// The package node-redis keeps its client in: @redis/client from node-redis 4.1 on, and
// @node-redis/client for 4.0.x.
const NODE_REDIS_CLIENT_PACKAGES = ["@redis/client", "@node-redis/client"];

let installed = false;
// Every patch made, so _uninstallRedisTracing can put each method back exactly as found.
const patches = [];
let nodeRedisSubscription = null;

/**
 * Records one "redis" span and one "redis" breadcrumb per Redis command, for an app using ioredis
 * or node-redis (the `redis` package); installed from index.js's init() the same way
 * installHttpTracing is, exactly once for the life of the process, and checking whether a trace is
 * being captured, and whether breadcrumbs are on, fresh on every command. Neither library is
 * loaded or required unless the app has it installed.
 *
 * Every span is named "Redis <COMMAND>" (the command alone, upcased: GET, SET, LPUSH...) with no
 * data at all: never a key or any other argument, since a key can easily carry a customer's own
 * id or other sensitive value. The same name and kind gems/forge_ops_tracker's
 * Integrations::RedisClientTiming records. The breadcrumb is the one that gem and the Python SDK's
 * integrations/redis.py add: that same name as its message, category "redis", level "error" when
 * the command failed, and only { duration_ms } as data. A span is only recorded inside a trace; a
 * breadcrumb whenever automatic breadcrumbs are on, into whatever trail is current (a request's
 * own, or the standalone one addBreadcrumb would start outside a request).
 *
 * ioredis (every version from 4.x on) is covered by wrapping Redis.prototype.sendCommand, which
 * every command goes through, pipelined and MULTI ones included (see instrumentIoredis).
 *
 * node-redis from 5.12 on is covered through the "node-redis:command" diagnostics channel it
 * publishes every command on (@redis/client), so nothing in it is patched and it's never loaded
 * from here: subscribing by name works whether or not the app ever loads it. Earlier versions
 * (4.x, and 5.x before 5.12) publish nothing there, so their command queue is patched instead
 * (see instrumentNodeRedisClient); a copy new enough to publish is never patched, so no command
 * is recorded twice.
 *
 * @param {(name: string, kind: string, startedAt: Date, durationMs: number, data?: Record<string, unknown>) => void} recordSpan
 * @param {() => boolean} isTracing whether the current async context has a trace to record into
 * @param {(message: string, category: string, level?: string, data?: Record<string, unknown>) => void} [recordBreadcrumb]
 * @param {() => boolean} [ensureBreadcrumbTrail] whether a breadcrumb recorded from the current
 *   async context would be kept (see index.js's _ensureBreadcrumbTrail)
 */
export function installRedisTracing(recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail) {
  if (installed) {
    return;
  }
  installed = true;
  for (const Redis of requireOptional("ioredis")) {
    instrumentIoredis(Redis, recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail);
  }
  for (const name of NODE_REDIS_CLIENT_PACKAGES) {
    for (const packageJsonPath of resolveOptional(`${name}/package.json`, { via: "redis" })) {
      instrumentNodeRedisClient(packageJsonPath, recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail);
    }
  }
  subscribeNodeRedis(hooksFor(recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail));
}

/**
 * Patches one ioredis Redis class (what `import Redis from "ioredis"` returns). Safe to call more
 * than once for the same class.
 *
 * ioredis can pass the same command through sendCommand more than once (flushing its offline
 * queue once connected, resending after a reconnect), so each command is only timed the first
 * time, from when the app sent it until its reply. The span is recorded when ioredis settles the
 * command (its own resolve/reject), rather than by attaching a handler to the command's promise:
 * that would mark a rejection the app never handles as handled, and it would no longer be
 * reported as an unhandled rejection.
 *
 * @param {any} Redis
 * @param {Parameters<typeof installRedisTracing>[0]} recordSpan
 * @param {() => boolean} isTracing
 * @param {Parameters<typeof installRedisTracing>[2]} [recordBreadcrumb]
 * @param {() => boolean} [ensureBreadcrumbTrail]
 * @returns {boolean} whether there was a sendCommand to patch
 */
export function instrumentIoredis(Redis, recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail) {
  const prototype = Redis?.prototype;
  if (typeof prototype?.sendCommand !== "function" || prototype.sendCommand[WRAPPED]) {
    return typeof prototype?.sendCommand === "function";
  }
  const hooks = hooksFor(recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail);
  const originalSendCommand = prototype.sendCommand;

  const patchedSendCommand = function patchedSendCommand(command, ...rest) {
    if (command && typeof command === "object" && !command[SEEN]) {
      command[SEEN] = true;
      const finish = startCommand(command.name, hooks);
      if (finish !== null) {
        observeCommand(command, finish);
      }
    }
    return originalSendCommand.call(this, command, ...rest);
  };
  patchedSendCommand[WRAPPED] = true;

  patches.push({ target: prototype, key: "sendCommand", original: originalSendCommand, own: Object.prototype.hasOwnProperty.call(prototype, "sendCommand") });
  prototype.sendCommand = patchedSendCommand;
  return true;
}

/**
 * Patches one copy of node-redis's client package (@redis/client or @node-redis/client), given
 * the path of its package.json, if it's a version that doesn't publish on the
 * "node-redis:command" channel: @redis/client 1.x and @node-redis/client 1.x (node-redis 4.x),
 * and @redis/client 5.x before 5.12. Anything newer is left alone for subscribeNodeRedis to cover.
 *
 * Wraps the client's command queue (RedisCommandsQueue.prototype.addCommand), the one method every
 * command goes through in all of those versions: a plain command, sendCommand(), every command in
 * a pipeline or a MULTI (MULTI and EXEC included), each one its own span, the same as ioredis
 * pipelines get. The queue settles its promise from the socket's own handlers, so the patch
 * returns a promise of its own in the queue's place, settling exactly like the queue's: a
 * rejection nothing ever handles is still reported as unhandled.
 *
 * @param {string} packageJsonPath
 * @param {Parameters<typeof installRedisTracing>[0]} recordSpan
 * @param {() => boolean} isTracing
 * @param {Parameters<typeof installRedisTracing>[2]} [recordBreadcrumb]
 * @param {() => boolean} [ensureBreadcrumbTrail]
 * @returns {boolean} whether its command queue is patched now
 */
export function instrumentNodeRedisClient(packageJsonPath, recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail) {
  let prototype;
  try {
    const require = createRequire(packageJsonPath);
    if (!publishesNothing(require(packageJsonPath).version)) {
      return false;
    }
    prototype = require("./dist/lib/client/commands-queue.js").default?.prototype;
  } catch {
    // Not a layout this knows: leave it alone rather than guess.
    return false;
  }
  if (typeof prototype?.addCommand !== "function") {
    return false;
  }
  if (prototype.addCommand[WRAPPED]) {
    return true;
  }
  const hooks = hooksFor(recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail);
  const originalAddCommand = prototype.addCommand;

  const patchedAddCommand = function patchedAddCommand(args) {
    const finish = Array.isArray(args) ? startCommand(commandName(args[0]), hooks) : null;
    const result = originalAddCommand.apply(this, arguments);
    if (finish === null || typeof result?.then !== "function") {
      return result;
    }
    return result.then(
      (value) => {
        finish(false);
        return value;
      },
      (error) => {
        finish(true);
        throw error;
      },
    );
  };
  patchedAddCommand[WRAPPED] = true;

  patches.push({ target: prototype, key: "addCommand", original: originalAddCommand, own: Object.prototype.hasOwnProperty.call(prototype, "addCommand") });
  prototype.addCommand = patchedAddCommand;
  return true;
}

// node-redis 4.x ships its client as 1.x; 5.12 is the first version with the diagnostics channel.
function publishesNothing(version) {
  const match = /^(\d+)\.(\d+)/.exec(String(version));
  if (match === null) {
    return false;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major === 1 || (major === 5 && minor < 12);
}

// node-redis passes each argument as a string or a Buffer; only the first (the command) is read.
function commandName(first) {
  return String(first ?? "").split(" ", 1)[0];
}

/** @internal test-only: restores every method installRedisTracing replaced, and unsubscribes. */
export function _uninstallRedisTracing() {
  while (patches.length > 0) {
    const { target, key, original, own } = patches.pop();
    if (own) {
      target[key] = original;
    } else {
      delete target[key];
    }
  }
  if (nodeRedisSubscription !== null) {
    diagnosticsChannel.tracingChannel(NODE_REDIS_COMMAND_CHANNEL).unsubscribe(nodeRedisSubscription);
    nodeRedisSubscription = null;
  }
  installed = false;
}

function hooksFor(recordSpan, isTracing, recordBreadcrumb = () => {}, ensureBreadcrumbTrail = () => false) {
  return { recordSpan, isTracing, recordBreadcrumb, ensureBreadcrumbTrail };
}

function observeCommand(command, finish) {
  const { resolve, reject } = command;
  if (typeof resolve !== "function" || typeof reject !== "function") {
    return;
  }
  command.resolve = function resolveWithSpan(...args) {
    finish(false);
    return resolve.apply(this, args);
  };
  command.reject = function rejectWithSpan(...args) {
    finish(true);
    return reject.apply(this, args);
  };
}

/**
 * Starts timing one command now, from the app's own call, and returns the function that records
 * it (given whether the command failed), or null when there's nothing to record it into: no trace
 * being captured and no breadcrumb being kept. The function is bound to the caller's async
 * context: the reply arrives from the connection's own socket handlers, where the trace and the
 * breadcrumb trail the command belongs to aren't the current ones. Only ever records once.
 */
function startCommand(command, hooks) {
  const span = hooks.isTracing();
  const breadcrumb = hooks.ensureBreadcrumbTrail();
  if (!span && !breadcrumb) {
    return null;
  }
  const name = `Redis ${String(command).toUpperCase()}`;
  const startedAt = new Date();
  const start = performance.now();
  let finished = false;
  return AsyncResource.bind((failed) => {
    if (finished) {
      return;
    }
    finished = true;
    const durationMs = performance.now() - start;
    if (breadcrumb) {
      hooks.recordBreadcrumb(name, "redis", failed ? "error" : "info", { duration_ms: Math.round(durationMs * 10) / 10 });
    }
    if (span) {
      hooks.recordSpan(name, "redis", startedAt, durationMs);
    }
  });
}

/**
 * node-redis runs each command inside TracingChannel#tracePromise: "start" is published
 * synchronously from the app's own call (so isTracing() sees the right trace), and "asyncEnd" once
 * the reply has settled the command either way, with `context.error` set if it failed. Only
 * `context.command` (already upcased by node-redis) is read, never `context.args`.
 */
function subscribeNodeRedis(hooks) {
  if (typeof diagnosticsChannel.tracingChannel !== "function") {
    return;
  }
  nodeRedisSubscription = {
    start(context) {
      if (context && typeof context === "object") {
        context[SPAN] = startCommand(context.command, hooks);
      }
    },
    asyncEnd(context) {
      context?.[SPAN]?.("error" in context);
    },
  };
  diagnosticsChannel.tracingChannel(NODE_REDIS_COMMAND_CHANNEL).subscribe(nodeRedisSubscription);
}

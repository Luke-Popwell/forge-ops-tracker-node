# @forge-ops/tracker

Node.js error reporting client for [ForgeOps](https://getforgeops.net).
Requires Node 18+ (for global `fetch`). It captures uncaught exceptions, unhandled promise
rejections, and explicitly reported errors, builds a backtrace, scrubs likely PII, and delivers
events to ForgeOps over HTTP without blocking the request or process that raised them.

> For health or personal data, turn on [strict privacy](#strict-privacy): the SDK then sends only structured facts about each error (its type, stack trace, release and route), never the message, a raw path, breadcrumbs, or context you haven't allowed.

## Installation

```bash
npm install @forge-ops/tracker
```

## Configuration

Set a DSN (from a project's settings page in ForgeOps), either via the `FORGE_OPS_DSN` environment
variable or explicitly:

In a CommonJS project (the default for a new `npm init -y` project, with no `"type": "module"` in
`package.json`):

```js
const forgeOpsTracker = require("@forge-ops/tracker");

forgeOpsTracker.init({
  dsn: "https://<api_key>@getforgeops.net/api/v1/events", // or leave unset to read FORGE_OPS_DSN
  release: "...",
});
```

In an ES module project (`"type": "module"`, or a `.mjs` file):

```js
import * as forgeOpsTracker from "@forge-ops/tracker";

forgeOpsTracker.init({
  dsn: "https://<api_key>@getforgeops.net/api/v1/events", // or leave unset to read FORGE_OPS_DSN
  release: "...",
});
```

`require()` of this package needs Node 20.19+ or 22.12+; on older Node, use
`const forgeOpsTracker = await import("@forge-ops/tracker")` from CommonJS instead.

Call `init()` once at startup, before handling any requests. Any `Configuration` property can be
overridden by passing it in the options object.

### Environments

Errors are only sent from the environments in `enabledEnvironments` (default `production` and
`staging`). The current environment is `FORGE_OPS_ENVIRONMENT`, then `NODE_ENV`, and
`"production"` when neither is set, so a DSN on its own is enough to start sending. Pass
`environment` to `init()` to set it explicitly.

When a DSN is set but the environment isn't enabled, `init()` prints one warning saying so, and
nothing is sent. To send from that environment too, add it:

```js
forgeOpsTracker.init({ enabledEnvironments: new Set(["production", "staging", "development"]) });
```

### Express

```js
import { forgeOpsTrackerBreadcrumbContextExpressMiddleware } from "@forge-ops/tracker/integrations/breadcrumb-context";
import { forgeOpsTrackerSessionTrackingExpressMiddleware } from "@forge-ops/tracker/integrations/session-tracking";
import { forgeOpsTrackerPerformanceExpressMiddleware } from "@forge-ops/tracker/integrations/performance";
import { forgeOpsTrackerUserContextMiddleware, forgeOpsTrackerExpressMiddleware } from "@forge-ops/tracker/integrations/express";

app.use(forgeOpsTrackerBreadcrumbContextExpressMiddleware); // first, before everything else below
app.use(forgeOpsTrackerSessionTrackingExpressMiddleware);
app.use(forgeOpsTrackerPerformanceExpressMiddleware); // order relative to routes doesn't matter
app.use(forgeOpsTrackerUserContextMiddleware); // after Passport's own session middleware, if used
// ...routes...
app.use(forgeOpsTrackerExpressMiddleware); // still last, after all routes
```

Requires Express 5+: its automatic forwarding of both synchronous throws *and* rejected promises
from `async` route handlers to error-handling middleware is what makes this work with zero other
wiring (verified directly against a real async handler, not assumed). Express 4 does not do this
for async handlers; each route would need its own try/catch there instead.

### Fastify

```js
import { registerForgeOpsTrackerBreadcrumbContext } from "@forge-ops/tracker/integrations/breadcrumb-context";
import { registerForgeOpsTracker } from "@forge-ops/tracker/integrations/fastify";

registerForgeOpsTrackerBreadcrumbContext(app); // first, before registerForgeOpsTracker
registerForgeOpsTracker(app); // called directly, not via app.register()
```

Called directly on your Fastify instance rather than through `app.register()`, which would create
a new encapsulation scope (and require the `fastify-plugin` package to break out of it): this
avoids that entirely.

## What gets reported automatically, and what doesn't

**An exception that crashes a request needs no further wiring at all.** Both integrations above
report anything that propagates uncaught out of a route handler, then let the framework handle it
exactly as if this client weren't installed.

**An exception your own code catches and handles is different: neither integration ever sees
it**, since it never propagates far enough to reach either hook:

```js
try {
  await chargeCard(order);
} catch (err) {
  logger.warn(`card declined: ${err.message}`);
  // ForgeOps never sees this: caught locally, never reaches the
  // middleware/hook at all.
}
```

There's no application-wide hook that reports an exception while still letting your own catch
block handle it: report it explicitly instead, right at the catch site:

```js
} catch (err) {
  forgeOpsTracker.captureException(err, { orderId: order.id });
  logger.warn(`card declined: ${err.message}`);
}
```

### Outside a web request (scripts, workers, unhandled promise rejections)

`init()` also installs `process` event listeners by default (`installProcessHandlers: false` to
opt out) covering two cases with no wiring needed:

- **Uncaught exceptions.** The error is reported, and the process waits up to 2 seconds for it to
  be delivered before it exits with code 1, printing the error to stderr the way Node does. Without
  that wait the crash would never be sent: Node exits before an asynchronous delivery can finish.
  If your app has its own `uncaughtException` listener, this client leaves the decision to it and
  only reports the error (call `await flush()` in your listener before you exit). Under
  `--abort-on-uncaught-exception` the error is reported and Node aborts as usual, without waiting.
- **Unhandled promise rejections**: a rejected promise nobody awaited or attached a `.catch()` to,
  arguably the most common way a modern async Node app silently fails. The process still crashes
  exactly as it would without this client (Node's default `--unhandled-rejections=throw`), after
  the rejection is delivered. If your app has its own `unhandledRejection` listener, the process
  keeps running, as it would without this client, and the rejection is reported.

Neither catches a web request's unhandled exception under Express/Fastify: both catch that
themselves, long before it would ever reach here.

### Before `process.exit()`

Errors are delivered asynchronously, so one reported just before `process.exit()` is lost unless the
process waits for it. `flush(timeoutMs = 2000)` sends everything queued or buffered (errors, traces,
recorded changes, metrics, session and performance counts) and resolves `true` once it has all gone
out, or `false` when the timeout passed first. It never rejects.

```js
forgeOpsTracker.captureException(error);
await forgeOpsTracker.flush();
process.exit(1);
```

A script that just ends on its own, with nothing left on the event loop, needs no flush: the pending
delivery keeps the process alive until it's sent.

Every failure mode (network errors, timeouts, a full queue, a malformed DSN) is caught and
dropped rather than thrown, so a broken or unreachable tracker can never take down the host app.

## Where an error happened

An error reported during a request carries three extra fields:

- `transaction_name`: the method and the route pattern, `"GET /orders/:id"`, the same name
  performance monitoring and traces use.
- `endpoint`: the method and the route as declared, `"GET /orders/:id"`. Never the literal path, so
  an id or a token in the URL never ends up here. On Express, it's the route as declared on the
  router that matched it: for a router mounted with `app.use("/api", router)`, that's the part
  declared on the router, without `/api`, since the mount path Express exposes is the literal
  matched one.
- `trace_id`: the request's W3C trace id, which ForgeOps uses to link this error to errors that
  other services reported for the same trace (see "Following a request across services" below).

Register `forgeOpsTrackerTracingExpressMiddleware` before your routes, or call
`registerForgeOpsTrackerTracing(app)` on Fastify (see "Distributed tracing" below), for these to be
set on an error you capture yourself inside a handler; Fastify knows the route before any handler
runs, Express as soon as the matched handler starts. `forgeOpsTrackerExpressMiddleware` and
`registerForgeOpsTracker` add them to an unhandled error on their own. They're left out entirely
outside a request (a script, a worker), and they're never PII-scrubbed, like `environment` and
`release`: they're structured fields, not free text.

## Identifying users

```js
captureException(error, {}, { id: user.id, email: user.email });
```

Or `runWithUser(user, callback)` to attach it to every `captureException()` call made anywhere in
`callback`'s own async chain, rather than passing it by hand every time, e.g. from your own
middleware:

```js
app.use((req, res, next) => runWithUser({ id: req.user?.id, email: req.user?.email }, next));
```

There's no imperative `setUser()` the way some other languages in this repo have: Node is
single-threaded, so a plain module-level variable would leak across concurrent requests
interleaved on the same event loop, exactly the bug the other languages' own thread-local choice
avoids for their own concurrency model. `AsyncLocalStorage` (Node's own built-in mechanism for
this) only propagates a value through an async call chain that was explicitly wrapped, so
`runWithUser`'s wrapping shape is the correct, idiomatic choice here, not a limitation being
worked around. `id`/`email`/`username` are all independently optional. Shows up on an issue's own
detail page, and as its own affected-users count alongside the regular event count.

**Express apps get this automatically**: add `forgeOpsTrackerUserContextMiddleware` (see the
Express snippet above), after whatever middleware actually sets `req.user` (Passport's own session
middleware, the closest thing Express has to a single dominant auth library, the same role Warden
plays for Rails). A no-op when `req.user` is never set, whether that's because nobody's signed in
or Passport isn't installed. Confirmed directly, with a real Express app and a real async route
handler, that the `AsyncLocalStorage` context this sets survives all the way through to
`forgeOpsTrackerExpressMiddleware` later in the same request, including across an `await`, not
just through a synchronous call chain. Composes with the manual API above rather than replacing
it: call `runWithUser` yourself for a route (or a custom auth setup this can't detect) that needs
to override what was auto-detected.

## Breadcrumbs

A trail of what happened right before an error. With `forgeOpsTrackerBreadcrumbContextExpressMiddleware`/
`registerForgeOpsTrackerBreadcrumbContext` installed (see the Express/Fastify snippets above), every
request gets its own trail, and the Express performance middleware records a `"controller"`
breadcrumb into it automatically, no further setup needed. Every `pg` query adds a `"query"`
breadcrumb and every Redis command a `"redis"` one too (see "Database spans" and "Redis spans"
below), inside a request or not. Shows up alongside the error on an issue's own detail page.

```js
forgeOpsTracker.init({
  dsn: "...",
  trackBreadcrumbs: false, // opt out of the automatic sources entirely
  maxBreadcrumbs: 30, // oldest entry dropped once this many have accumulated in one request
});
```

Add your own by hand, regardless of whether the automatic sources are on:

```js
forgeOpsTracker.addBreadcrumb("charged card", { category: "billing", data: { orderId: order.id } });
```

`category` defaults to `"custom"`, `level` to `"info"` (`"debug"`/`"info"`/`"warning"`/`"error"` are
the four levels the automatic sources themselves use too), and `data` to `{}`. Works outside a
request entirely too (a plain script, a worker with no breadcrumb-context middleware/hook
installed): the buffer it adds to is created lazily wherever it's first called, the same "works
standalone, no specific setup required" shape the manual API in every other SDK in this repo
already has.

Each request gets its own fresh, bounded trail (a ring buffer capped at `maxBreadcrumbs`, oldest
entry dropped once full), scoped with a second `AsyncLocalStorage` instance, the same mechanism
`runWithUser()`/the user-context middleware already use for the affected user: Node is
single-threaded, so a plain module-level variable would leak one request's trail into another's
interleaved on the same event loop, exactly the bug `AsyncLocalStorage` avoids here. Confirmed
directly, with a real Express app and a real Fastify app, each running two genuinely concurrent,
interleaved requests, that one request's trail never bleeds into the other's, and that a
breadcrumb recorded deep inside an awaited route handler (or the performance middleware's own
`res.on("finish")` listener, which fires later still) is still visible to `captureException()` at
the end of that same request. Unlike the affected user above, a breadcrumb's `message`/`data`
**is** scrubbed for likely PII: console-style/query/request trail entries are exactly the kind of
free text (a bind parameter showing up in a message, a URL with a token in it) the scrubber exists
to catch, not a deliberately-structured field the way `user` is.

The `"query"` and `"redis"` breadcrumbs need no middleware: a query or command run outside any
request (a script, a worker) lands in the same standalone trail `addBreadcrumb()` would start
there. Fastify gets no automatic `"controller"` breadcrumb today, since
there's no Fastify performance/timing integration in this client for one to ride alongside (see
"Performance monitoring" below); `registerForgeOpsTrackerBreadcrumbContext` still gives Fastify
requests their own trail, so `addBreadcrumb()` calls from inside a Fastify route handler work
correctly and show up on that request's error.

## Delivery: an async loop, not a thread

`DeliveryQueue` here isn't a background *thread*: Node is single-threaded. But a Node process is
long-running across many requests, so an async processing loop on the event loop is the natural
substitute: `push()` returns immediately, and delivery happens via non-blocking `fetch()` calls
without ever blocking the request that pushed it. The loop starts lazily, on first push, not at
import time: Node's `cluster` module can fork worker processes *after* the application has
already loaded, and an eagerly-started loop would be left dead in every forked child; starting
fresh on first push means each forked worker gets its own live loop regardless of when it was
forked relative to import.

## `in_app` backtrace frames

Node runs interpreted directly from real `.js` files on disk, so file-path matching against
`Configuration#appRoot` is a straightforward prefix comparison against those on-disk paths.
Defaults to the current working directory; set it explicitly if that doesn't match your app's
actual layout. `node_modules` frames are never marked `in_app`, regardless of `appRoot`; Node's own
internal modules (the `node:` scheme) never match a real `appRoot` prefix either, so they don't
need special-casing.

Backtrace parsing is a regex over `Error#stack`, a plain string in V8 rather than a structured
object: verified directly against real captured stack traces, both synchronous and `async`,
named and anonymous frames, before relying on it. One quirk worth knowing: V8 captures an Error's
stack at *construction* time, not at `throw` time, so there's no "empty backtrace" case for an
exception that's constructed but never thrown.

## PII scrubbing

By default, the message, backtrace, and any context/tags you attach are scanned
for likely personal data: email addresses, formatted SSNs/credit cards, known API key/token
formats, and anything under a suspiciously-named key (`password`, `apiKey`, `ssn`, and similar),
and redacted before the payload ever leaves this process. ForgeOps itself scrubs again on arrival
regardless, so this is a second, earlier layer, not the only one. The user attached via
`captureException`'s third argument or `runWithUser` above is a deliberate exception: it's never
scrubbed, since redacting it would defeat the whole point of identifying users in the first place.
Breadcrumbs (see "Breadcrumbs" above) are *not* exempt, unlike the user: they're scrubbed the same
as the message/backtrace/context.

To disable it:

```js
forgeOpsTracker.init({ dsn: "...", scrubPii: false });
```

## Strict privacy

For apps that can't let personal or health data (PII, PHI) leave their own servers. With strict
privacy on, this client sends only structured facts about an error, never free text that could
carry a name, an email or a diagnosis:

```js
forgeOpsTracker.init({
  dsn: "...",
  strictPrivacy: true,
  privacyAllowedFields: ["error_code", "feature"],
});
```

- An error event goes out without its message. It carries a `message_fingerprint` instead: a
  one-way hash of the message with its numbers, ids, emails and quoted values taken out, computed in this process, so
  errors still group the same way.
- No breadcrumbs (they aren't recorded either), no `endpoint`, no SQL statement (even with
  `captureSqlStatement` on; the table and procedure names are still sent), and no source context.
- The user is sent as its `id` only, never `email` or `username`.
- Context and tags keep only the top-level keys listed in `privacyAllowedFields`, and only when the
  value is a string, number or boolean. With none listed, neither is sent.
- Traces: an outbound HTTP span is named by its method and host (`GET api.example.com`), a request
  span named by its path follows the path rule below, and span data keeps only `db.statement`
  (already masked) and `db.system`.
- A transaction name that's a path follows the path rule below, in error events and performance
  samples alike; a `Controller#action` name is kept.
- Paths: a route template (`/patients/:id/notes`, `/patients/{id}`, `/files/*path`) is kept as it
  is. A raw path keeps only its first segment, the rest becomes `:path`
  (`/patients/jane-doe/12` is `/patients/:path`), and a first segment holding a digit becomes `:id`.

The exception class, backtrace frames (file, line, function), release, environment, server and
trace id are unchanged, as are session counts, performance timings, metrics and change snapshots.

Both options can also come from the environment: `FORGE_OPS_STRICT_PRIVACY=true` and
`FORGE_OPS_PRIVACY_ALLOWED_FIELDS=error_code,feature` (comma separated). A value passed to `init()`
wins over the environment.

ForgeOps applies the same rules again on arrival when the project's own Strict privacy setting is
on, so an app running an older client, or one configured without this, still can't get text stored
for that project.

## Source context

By default, each in-app backtrace frame (never a `node_modules` dependency) is captured along with
the 5 lines of source on either side of the culprit line, read straight off disk at raise-time, so
an issue's detail page can show the actual code that broke, not just a `file:line:method`
reference. This never applies to a frame outside your configured `appRoot`, and it fails silently
(no context, not a thrown error) for any file that can't be read for whatever reason.

This is a real, deliberate exception to "off by default is safer": literal source code is being
transmitted, not just a reference to it, and the real protection here is not this flag. Every
project on ForgeOps has its own setting (on by default, off durably and immediately once an org
owner turns it off, regardless of what any individual app's own `captureSourceContext` is still set
to) that governs whether the server will ever actually store what a client sends. Set this to
`false` if you'd rather this client never even attempt the disk read in the first place:

```js
forgeOpsTracker.init({ dsn: "...", captureSourceContext: false });
```

## Session tracking (release health)

By default, every request through the Express integration is counted as a session: crash-free
unless an unhandled exception (or a 5xx response) actually affects it, giving ForgeOps a crash-free
rate per release to show alongside the errors themselves, not just the errors on their own.
Counted in-process and flushed as a small periodic aggregate on a `setInterval` timer (never one
network call per request), the same delivery philosophy as everything else in this client: a broken
or unreachable tracker never affects the host app either way.

```js
forgeOpsTracker.init({
  dsn: "...",
  trackSessions: false, // opt out entirely
  sessionFlushIntervalMs: 30000, // default 60000
});
```

Requires a ForgeOps plan that includes release health; on a plan that doesn't, the periodic
flushes are accepted but not recorded, and the response says why.

One deliberate gap: unlike the Ruby gem's `at_exit`, this client does **not** hook `SIGTERM`/
`SIGINT` to force a final flush on shutdown. Registering a listener for either signal overrides
Node's own default disposition (the process no longer exits on its own unless something calls
`process.exit()`), which risks racing (or outright cutting off) a host app's own graceful
shutdown if this tracker's own listener won that race. The accepted trade-off: up to one
`sessionFlushIntervalMs` window of session data can be lost on a hard process exit, the same way it
would be if the interval simply hadn't ticked yet: never a behavior change for whatever app this
is installed into. See `src/sessionFlusher.js`'s own comment for the full reasoning.

## Performance monitoring

By default, the Express integration times every request (`performance.now()` before the route
runs, diffed once the response finishes) so a dashboard widget on ForgeOps can show which parts
of your app are actually slow, not just which ones raise. Bucketed by transaction
(`"GET /users/:id"`, the matched route pattern rather than the literal URL, so a distinct user id
doesn't explode into its own separate transaction) and flushed as a small periodic aggregate per
transaction on the same kind of `setInterval` timer session tracking above uses. The same
middleware also records a `"controller"` breadcrumb (see "Breadcrumbs" above), gated on
`trackBreadcrumbs` independently of `trackPerformance`: turning either one off doesn't affect the
other.

Each aggregate also carries a small latency histogram (a count per fixed latency bucket: 50, 100,
250, 500, 1000, 2500, 5000 and 10000ms, plus an overflow bucket), so ForgeOps can show an
approximate p50/p95/p99 per transaction, not just an average. Percentiles are accurate to the width
of whichever bucket a duration falls into; the SDK never stores the individual durations.

```js
forgeOpsTracker.init({
  dsn: "...",
  trackPerformance: false, // opt out entirely
  performanceFlushIntervalMs: 30000, // default 60000
});
```

Requires a ForgeOps plan that includes performance monitoring; on a plan that doesn't, the
periodic flushes are accepted but not recorded, and the response says why. Same deliberate no-flush-on-`SIGTERM`/`SIGINT` gap as session tracking above, and for
the identical reason; see `src/performanceFlusher.js`'s own comment.

Fastify isn't supported yet: unlike session tracking, there's no existing request-lifecycle hook
to build this on for Fastify today, so it's a separate piece of work rather than something this
version already covers.

## Custom metrics and infrastructure monitoring

Two explicit calls (nothing is automatic, so there is no `track*` flag): a business event you name
yourself, and a reading from one of your own hosts.

```js
forgeOpsTracker.captureMetric("signup"); // value defaults to 1: a bare counter
forgeOpsTracker.captureMetric("payment", 49); // a real magnitude; it may be negative (a refund)

forgeOpsTracker.captureInfrastructureMetric("cpu", 0.42); // hostname defaults to serverName
forgeOpsTracker.captureInfrastructureMetric("disk", 0.81, { hostname: "db-1" });
await forgeOpsTracker.flushMetrics(); // optional: send right now
```

Each capture is buffered and flushed as one batch every `metricFlushIntervalMs` /
`infrastructureMetricFlushIntervalMs` (60000 by default) on an unref'd `setInterval` timer, and once
more when the event loop drains (`beforeExit`, which does not change how the process exits the way a
`SIGTERM` listener would), so a short-lived cron script that captures a few readings and ends needs
nothing more. Call `await flushMetrics()` (or `await flush()`, which covers errors too) if it exits
another way (`process.exit()`). Every entry is
stored as it was captured (a signup is a row, not a running total), so a count or sum you compute later
is exact. Both are a no-op when the client isn't enabled for the environment.

A delivery that fails for now (a network error, a timeout, a 5xx, a 408 or a 429) keeps every entry
for the next flush, and an entry captured while a delivery is in flight is kept too (the Ruby gem's
own buffer loses it). After 5 flushes in a row have failed, the batch is dropped and the buffer
starts clean. A batch the server rejects (any other 4xx, such as the 403 a plan without the feature
answers) is dropped at once and never sent again. The buffer holds at most 1000 entries per kind
and drops further ones until a flush empties it. A NaN or infinite value is
dropped at capture: `JSON.stringify` turns it into `null` and the server would reject the whole
batch behind it. Requires a ForgeOps plan that includes custom metrics / infrastructure monitoring.

## What changed

ForgeOps can show what changed in your system next to the errors and slowdowns that followed it.
Two ways in:

**Record a change yourself** when something changes that no deploy captures, like a feature flag
flipped, a config value edited, or a migration run by hand:

```js
import * as forgeOpsTracker from "@forge-ops/tracker";

forgeOpsTracker.recordChange({
  kind: "feature_flag", // feature_flag, config, migration, dependency, infrastructure, or other
  title: "Enabled new_checkout for 10% of users",
  details: { flag: "new_checkout", rolloutPercent: 10 },
  actor: "ops@example.com",
  url: "https://flags.example.com/new_checkout",
});
```

`kind` and `title` are required; `details`, `environment` (defaults to the configured one),
`service`, `actor`, `url`, `id` (an idempotency key, so sending the same change twice records it
once), and `occurredAt` (a `Date` or ISO 8601 string, defaulting to now) are optional. An unknown
`kind` is sent as `other`. It's queued and delivered on the same async loop as error events, so it
never slows down the caller, never throws, and is a no-op when the client isn't enabled for the
environment.

**Changes between deploys are detected for you.** Once per process, `init()` schedules a snapshot
of what the process is running: the Node version, and each of the `dependencies` in your app's
`package.json` (read from `appRoot`, the working directory by default) resolved to the version
actually installed in `node_modules`. ForgeOps compares it with the previous boot's and records
whatever changed, such as a package upgrade. It's sent on a later event-loop turn, so startup never
waits on it.

```js
forgeOpsTracker.init({
  dsn: "https://<api_key>@getforgeops.net/api/v1/events",
  detectChanges: true, // default; false sends no startup snapshot
  trackEnvVarNames: false, // default; true also sends environment variable names
});
```

With `trackEnvVarNames` on, the snapshot lists the names of your environment variables (never their
values), so an added or removed variable shows up as a change. Names that differ from host to host,
like `HOSTNAME`, `PATH`, `PORT`, `LC_*`, and Kubernetes service variables, are left out, as are the
SDK's own `FORGE_OPS_*` settings.

Requires a ForgeOps plan that includes change tracking; on a plan that doesn't, both are accepted but not recorded,
and the response says why.

## Distributed tracing

For one slow or errored request, `forgeOpsTrackerTracingExpressMiddleware` (Express) and
`registerForgeOpsTrackerTracing()` (Fastify, `./integrations/tracing`) capture its full nested
call tree: the route span, plus every outbound HTTP call, database query, Redis command and
manually-wrapped span nested under it, so ForgeOps can render a waterfall for that one request.

```js
import { forgeOpsTrackerTracingExpressMiddleware } from "@forge-ops/tracker/integrations/tracing";

app.use(forgeOpsTrackerTracingExpressMiddleware); // before your routes
```

```js
import { registerForgeOpsTrackerTracing } from "@forge-ops/tracker/integrations/tracing";

registerForgeOpsTrackerTracing(fastify);
```

This is the whole point of the feature, so it's worth being explicit about: a request's own trace
is only ever built, let alone sent, once its own root span's duration crosses a threshold, decided
entirely client-side before a single byte goes over the wire. A normal, fast request costs
nothing extra. A request that errored (an unhandled error, or any `captureException()` during it)
is the one exception: its trace is always sent, however fast it was, since the spans leading up to
an error are exactly what you want next to it.

```js
forgeOpsTracker.init({
  dsn: "...",
  trackTracing: false, // opt out entirely
  traceCaptureThresholdMs: 500, // default 1000
});
```

Outbound HTTP calls made via Node's built-in `http`/`https` modules (and so anything built on top
of them, like `axios` or `node-fetch`) nest in automatically, no extra setup: `init()` always
installs this hook, the same way `gems/forge_ops_tracker`'s own `Net::HTTP.prepend` always applies
regardless of config, checking `trackTracing` fresh on every actual call rather than at install
time. Every span name (`"GET api.stripe.com"`) is low-cardinality by design, the same as every
transaction name elsewhere in this SDK: never the raw URL path or query string, since either can
carry a customer's own id or a secret.

There's no way to auto-detect "this is a logically distinct service layer" the way an outbound
HTTP call already has a real hook to extend, so wrap your own service-layer code by hand to have
it show up as its own span:

```js
await forgeOpsTracker.span("PaymentService.charge", () => chargeCard(order));
```

Works with both synchronous and `async` callbacks (the returned promise, if any, is awaited
before the span is recorded), and nests correctly even when two spans are awaited concurrently in
the same request (`Promise.all`), since span nesting is tracked per async execution branch via
`AsyncLocalStorage`, not a single shared stack. `kind` accepts `"controller"`, `"service"` (the
default), `"database"`, `"redis"`, `"http"`, `"job"`, or `"other"`, and takes an options object:
`forgeOpsTracker.span("PaymentService.charge", fn, { kind: "service", data: {} })`. A no-op
outside of a request currently being traced (a plain script, a request that already finished) or
with `trackTracing` off: it just runs the callback and records nothing, never throwing.

Requires a ForgeOps plan that includes distributed tracing; on a plan that doesn't, a captured
trace is accepted but not recorded, and the response says why.

### Following a request across services

Traces use the [W3C Trace Context](https://www.w3.org/TR/trace-context/) standard, so a request can
be followed from one service into the next, whichever language or tracing library the other
service uses:

- **Incoming**: a request that arrives with a valid `traceparent` header continues that trace (same
  trace id), and its root span records the caller's span as its parent. A missing or malformed
  header just starts a new trace.
- **Outgoing**: every outbound call made through Node's `http`/`https` modules during a request
  gets a `traceparent` header whose parent id is that call's own span, so the next service's spans
  nest under it. A `traceparent` you set yourself is never replaced, and this client's own
  deliveries to ForgeOps never get one. The global `fetch()` doesn't go through `http`/`https`, so
  it isn't instrumented and gets no header.

A trace id exists for every request even with `trackTracing` off, and the header is still sent,
since the trace id is also what links an error here to an error in the service you called. Seeing
the two errors connected in ForgeOps needs both services' projects linked there.

```js
import http from "node:http";
import express from "express";
import * as forgeOpsTracker from "@forge-ops/tracker";
import { forgeOpsTrackerExpressMiddleware } from "@forge-ops/tracker/integrations/express";
import { forgeOpsTrackerTracingExpressMiddleware } from "@forge-ops/tracker/integrations/tracing";

forgeOpsTracker.init({
  dsn: "https://<api_key>@getforgeops.net/api/v1/events",
  propagateTraces: true, // default true; false never sends traceparent
  // Default null: every host. A string matches that host and its subdomains on a dot boundary
  // ("internal.example" matches "orders.internal.example", not "notinternal.example"); a RegExp is
  // tested against the host, without the port.
  tracePropagationTargets: ["internal.example", /^10\.0\./],
});

const app = express();
app.use(forgeOpsTrackerTracingExpressMiddleware);

app.post("/checkout", (req, res, next) => {
  // Carries traceparent: 00-<this request's trace id>-<this call's span id>-01
  const call = http.request("http://orders.internal.example/orders", { method: "POST" }, (response) => {
    response.resume();
    res.status(response.statusCode === 201 ? 201 : 502).end();
  });
  call.on("error", next);
  call.end(JSON.stringify({ sku: "A1" }));
});

app.use(forgeOpsTrackerExpressMiddleware);
app.listen(3000);
```

### Database spans

Queries run through [`pg`](https://node-postgres.com) (node-postgres) are captured automatically,
one `"database"` span per query, with no extra setup: `init()` finds `pg` in your app and wraps
`Client#query`, which `Pool#query` goes through too. Callbacks, promises, and config objects
(`{ text, values, name }`) are all covered.

```js
import pg from "pg";

const pool = new pg.Pool();

app.get("/orders", async (req, res) => {
  // Recorded as a "SELECT orders" span, nested under this request's route span.
  const { rows } = await pool.query(
    "SELECT id, total FROM orders WHERE customer_id = $1 AND status = 'open'",
    [req.user.id],
  );
  res.json(rows);
});
```

The span is named after the statement's verb and table (`"SELECT orders"`, `"INSERT INTO orders"`,
`"UPDATE orders"`, `"DELETE sessions"`, or just the first keyword, like `"BEGIN"`), never the SQL
itself. It carries the statement in its data as `db.statement`, masked before it's stored: every
string and number becomes `?`, so the query above is sent as
`SELECT id, total FROM orders WHERE customer_id = $1 AND status = ?`, and ForgeOps masks it again
on arrival. It's cut to 4000 characters. Bind values (the `[req.user.id]` array) are never read or
sent. `db.system` is `"postgresql"`. A failed query is recorded too, and its error reaches your
code exactly as before.

Each query also adds a `"query"` breadcrumb (see "Breadcrumbs" above), named the same way as the
span (`"SELECT orders"`), with only `{ duration_ms }` as its data: never the statement, masked or
not. It's recorded whether or not the request is being traced, and outside a request too, unless
`trackBreadcrumbs` is off.

For any other database library, wrap a query by hand with `kind: "database"` and pass the SQL as
`statement`; it's masked the same way:

```js
import mysql from "mysql2/promise";
import * as forgeOpsTracker from "@forge-ops/tracker";

const connection = await mysql.createConnection(process.env.DATABASE_URL);

app.get("/orders", async (req, res) => {
  const sql = "SELECT id, total FROM orders WHERE customer_id = ? AND status = 'open'";
  const [rows] = await forgeOpsTracker.span("Load open orders", () => connection.execute(sql, [req.user.id]), {
    kind: "database",
    statement: sql,
    dbSystem: "mysql",
  });
  res.json(rows);
});
```

`dbSystem` is optional (`"postgresql"`, `"mysql"`, `"sqlite"`, `"mssql"`, `"oracle"`, or any other
lowercase name) and both options are ignored on spans of any other kind. They go out in the span's
data as `db.statement` and `db.system`. With `dbSystem` set to `"mysql"` or `"mariadb"`, text in
"double quotes" is masked too, since it's a string there rather than a name. A hand-made span
around a `pg` query still works: the automatic query span just nests under it.

Masking follows the same rules ForgeOps applies on arrival: `''` and backslash escapes inside a
string, a string's type prefix (`E'...'`, `X'DEADBEEF'`, `N'...'`, `B'...'`, `U&'...'`), `$tag$`
dollar quotes, and numbers of every shape (`42`, `1.5`, `.5`, `3e10`, `1.5E-3`, `0x1F`, `0b101`),
never the digits inside a name like `orders2` or a `$1` placeholder.

### Redis spans

Commands sent through [`ioredis`](https://github.com/redis/ioredis) or
[`redis`](https://github.com/redis/node-redis) (node-redis) are captured automatically too, one
`"redis"` span per command, pipelined ones included:

```js
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

app.get("/cart", async (req, res) => {
  // Recorded as a "Redis GET" span.
  const cart = await redis.get(`cart:${req.user.id}`);
  res.json(JSON.parse(cart ?? "[]"));
});
```

A span is named after the command alone (`"Redis GET"`, `"Redis SET"`, `"Redis LPUSH"`) and
carries no data: never the key or any other argument, since a key can easily hold a user's id or
another sensitive value. A failed command is recorded too.

Each command also adds a `"redis"` breadcrumb (see "Breadcrumbs" above) with the same name as its
message, level `"error"` when the command failed (`"info"` otherwise), and only `{ duration_ms }`
as its data. It's recorded whether or not the request is being traced, and outside a request too,
unless `trackBreadcrumbs` is off.

`ioredis` is covered from version 4 on. `redis` is covered from 4.0 on: from 5.12 (with Node 18.19
or later) through the diagnostics channel it publishes every command on, so nothing in it is
patched; before that (all of 4.x, and 5.0 to 5.11) by wrapping its client's command queue, which
every command goes through. A version that publishes on the channel is never wrapped, so no
command is counted twice. On those older versions every command in a pipeline or a `MULTI` gets
its own span (`MULTI` and `EXEC` included), like `ioredis` pipelines.

### When `init()` can't find `pg` or `ioredis`

`init()` looks for `pg`, `ioredis` and `redis` from the directory your app was started in, and
from where this package is installed. Neither is a dependency of this package: one your app doesn't have is
simply skipped. If your app is bundled, or started from a directory its `node_modules` isn't
under, hand the module over yourself, once, at startup:

```js
import pg from "pg";
import Redis from "ioredis";
import * as forgeOpsTracker from "@forge-ops/tracker";

forgeOpsTracker.init({ dsn: "..." });
forgeOpsTracker.instrumentPg(pg);
forgeOpsTracker.instrumentIoredis(Redis);
```

Both are safe to call more than once, and return `false` when given something that isn't `pg` or
an `ioredis` class. `redis` from 5.12 on never needs this.

**Known gaps:**

- `redis` (node-redis) before 5.12 can't be handed over by hand: in a bundled app, or one whose
  `node_modules` `init()` can't find, its commands aren't captured. Upgrade to 5.12 or later, or
  wrap the calls you care about with `span(name, fn, { kind: "redis" })`.
- `redis` from 5.12 on doesn't publish the commands inside a `MULTI` transaction on its
  diagnostics channel, so they don't show up (a pipeline's commands do).
- Pub/sub commands sent by `redis` before 5.12 (`SUBSCRIBE`, `UNSUBSCRIBE` and the like) aren't
  captured. The commands it sends on its own when it connects (`SELECT`, `CLIENT SETINFO`, `AUTH`,
  by name only) are, like any other command, and so are the `PING`s its `pingInterval` option
  sends.
- `pg-native` (`pg.native`), and cursors and streams passed to `query()` (`pg-cursor`,
  `pg-query-stream`), aren't captured.
- Other database libraries (`mysql2`, `better-sqlite3`, Prisma, and so on) aren't captured
  automatically; wrap their queries with `span()` as shown above.

## Database errors

When an error carries the SQL behind a failed database call, the event includes the names of the stored procedure, table and view that SQL touched, so the issue tells you where to start looking. This is on by default and sends identifiers only, never values. The statement is read from a `.sql` or `.query` string on the error or anything it wraps (`cause`, and Sequelize's `parent`/`original`), which covers Sequelize, mysql2 and TypeORM. node-postgres, better-sqlite3 and Prisma errors carry none, so attach it where you ran the query with `withSql`.

To also send the SQL statement itself, opt in. Every string and number is replaced by `?` before it
leaves your process (`WHERE email = 'a@b.co' AND id = 42` is sent as `WHERE email = ? AND id = ?`),
and ForgeOps masks it again on arrival:

```js
import { withSql } from "@forge-ops/tracker";

try {
  await pool.query(sql, params);
} catch (error) {
  throw withSql(error, sql);
}

// Opt in to also sending the masked statement (default false).
forgeOpsTracker.init({ dsn: "...", captureSqlStatement: true });
```

Each ForgeOps project also has its own "Capture the SQL behind database errors" setting. Turn it off
there and the statement is never stored for that project, whatever this flag says; the names are
still kept. A view and a table are written the same way in SQL, so both show as tables/views; the
database's own error message usually settles which it was.

## Running the tests

```bash
cd sdks/node
npm install
npm test
npm run lint
```

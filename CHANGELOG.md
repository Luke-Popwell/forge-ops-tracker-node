# Changelog

## 0.20.0 (2026-10-20)

- Strict privacy's path rule changed. A route template (`/patients/:id/notes`, `/patients/{id}`,
  `/files/*path`) is now kept exactly as it is, and a raw path keeps only its first segment, with
  the rest sent as `:path` (`/patients/jane-doe/12` is now `/patients/:path`; before, only segments
  holding a digit were replaced, so `jane-doe` went out). This applies to span names, request span
  names and transaction names. Nothing changes with strict privacy off.

## 0.19.0 (2026-10-20)

- Strict privacy, for apps that can't let personal or health data leave their own servers:
  `init({ strictPrivacy: true })` (or `FORGE_OPS_STRICT_PRIVACY=true`). Error events then go out
  without their message (a `message_fingerprint` instead, so errors still group), breadcrumbs,
  endpoint, SQL statement, source context, or the user's email and username, and with only the
  context and tag keys you list in `privacyAllowedFields` (or `FORGE_OPS_PRIVACY_ALLOWED_FIELDS`).
  Breadcrumbs aren't recorded at all. Outbound HTTP spans are named by method and host only, a
  request span named by its raw path has the ids taken out, and span data keeps only `db.statement`
  and `db.system`. A transaction name that is a raw path (an unmatched route) has its ids taken out
  too, in error events and performance samples. Off by default; nothing changes unless you turn it
  on.

## 0.18.0 (2026-10-13)

- A batch the server will never accept is no longer sent again and again. Before, any response
  other than a 2xx kept the batch (metrics, infrastructure readings, performance samples, session
  counts) and re-sent it at every flush with more added, for as long as the process lived; a plan
  without custom metrics answered 403 on every flush, and once the buffer was full, new metrics
  were dropped too. Now a 4xx other than 408 and 429 drops the batch at once.
- A delivery that fails for now (a network error, a timeout, a 5xx, a 408 or a 429) still keeps
  the batch for the next flush, but only for 5 flushes in a row: the fifth failure drops the batch
  and starts clean, so an endpoint that stays down can no longer grow one batch without end. A
  delivery that goes through resets the count. The 1000 entry cap on each metric buffer is
  unchanged.
- When a batch is dropped, or the server rejects an error event, a trace or a recorded change,
  `logger` is told once what was dropped and why. Nothing in the public API changed.

## 0.17.0 (2026-10-02)

- **Changed default:** with neither `FORGE_OPS_ENVIRONMENT` nor `NODE_ENV` set, the environment is
  now `"production"` instead of `"development"`. Before, an app that only set a DSN reported as
  `"development"`, which isn't an enabled environment, so nothing was ever sent and nothing said so.
  The order is unchanged otherwise: `FORGE_OPS_ENVIRONMENT`, then `NODE_ENV`, and an empty value now
  counts as unset. To keep the old behavior, set `NODE_ENV=development` (or
  `FORGE_OPS_ENVIRONMENT=development`) where you don't want to send, or pass
  `environment: "development"` to `init()`.
- `init()` now prints one warning (through `console.warn`, once per process) when a DSN is set but
  the environment isn't one of `enabledEnvironments`, naming the environment and how to send from
  it. Nothing is printed when no DSN is set.
- The README's setup now shows the `require()` form for CommonJS projects (the default for a new
  `npm init -y` project) alongside the `import` form.

## 0.16.0 (2026-10-01)

- An uncaught exception is now delivered before the process exits. Node exited before the
  asynchronous delivery could finish, so a crash was never sent. The process now waits up to 2
  seconds for it, then prints the error to stderr and exits with code 1, as Node would have. When
  your app has its own `uncaughtException` listener, this client only reports the error and leaves
  what happens next to your listener.
- An unhandled promise rejection crashes the process again, as it does without this client: the
  client's own `unhandledRejection` listener had stopped Node's default crash. The rejection is
  delivered first. When your app has its own `unhandledRejection` listener, the process keeps
  running and the rejection is still reported.
- New `flush(timeoutMs = 2000)` sends everything queued or buffered (errors, traces, recorded
  changes, metrics, session and performance counts) and resolves `true` once it has all gone out,
  or `false` when the timeout passed first. Call `await flush()` before `process.exit()`, which
  otherwise loses anything reported just before it.

## 0.15.0 (2026-09-29)

- Every Redis command sent through `ioredis` or `redis` now also adds a `"redis"` breadcrumb, named
  like its span (`"Redis GET"`), level `"error"` when the command failed, with only
  `{ duration_ms }` as data. Every `pg` query adds a `"query"` breadcrumb, named like its span
  (`"SELECT orders"`), with only `{ duration_ms }` as data, never the statement. Both are recorded
  inside a request or not, whether or not it's being traced, and turned off with
  `trackBreadcrumbs: false`.
- Redis commands sent through `redis` (node-redis) 4.x, and 5.x before 5.12, are now captured as
  spans (and breadcrumbs) too, by wrapping the client's command queue. Every command in a pipeline
  or a `MULTI` gets its own span. 5.12 and later are still captured through their diagnostics
  channel alone, so no command is recorded twice.
- SQL masking now matches ForgeOps's own exactly: backslash escapes inside strings (`'o\'brien'`,
  `E'o\'brien'`), a string's type prefix masked with it (`X'DEADBEEF'` becomes one `?`), and hex,
  binary, exponent and leading-dot numbers (`0x1F`, `0b101`, `3e10`, `1.5E-3`, `.5`). For MySQL
  and MariaDB, "double quoted" strings are masked too: on `pg` spans the system is always
  PostgreSQL, and on a hand-made database span it's the `dbSystem` you pass.
- A string cut off right after a backslash (`'secret\`, as a statement truncated mid-escape ends)
  is masked too, instead of being left visible.

## 0.14.0 (2026-09-28)

- Database queries run through `pg` (node-postgres) are now captured as spans automatically, one
  `"database"` span per query, `Pool#query` included, whether you use callbacks, promises or config
  objects. Each is named after the statement's verb and table (`"SELECT orders"`), and carries the
  statement masked (every string and number becomes `?`) as `db.statement`, with `db.system` set to
  `postgresql`. Bind values are never read.
- Redis commands sent through `ioredis` (4.x on) or `redis` (node-redis 5.12 on) are now captured
  as spans automatically, one `"redis"` span per command, named `"Redis <COMMAND>"` (`"Redis GET"`).
  Keys and other arguments are never sent.
- `init()` finds `pg` and `ioredis` in your app on its own; neither is a dependency of this package.
  New `instrumentPg(pg)` and `instrumentIoredis(Redis)` hand the module over yourself when it can't
  (a bundled app, say).
- Both only record inside a request being traced, and not at all with `trackTracing` off.

## 0.13.0 (2026-09-25)

- A database span can now carry the SQL it ran: `span("Load orders", fn, { kind: "database",
  statement: sql, dbSystem: "postgresql" })`. The statement is masked (every string and number
  becomes `?`) and cut to 4000 characters before it's stored, then sent in the span's data as
  `db.statement`, with `dbSystem` lowercased as `db.system`. Bind values are never read. Both
  options are ignored on spans of any other kind, and a `db.statement` passed in `data` directly is
  masked too.

## 0.12.0 (2026-09-25)

- New `recordChange({ kind, title, details, environment, service, actor, url, id, occurredAt })`
  records something that changed in your system (a feature flag, a config value, a hand-run
  migration) so ForgeOps can show it next to the errors that followed. `kind` is one of
  `feature_flag`, `config`, `migration`, `dependency`, `infrastructure`, or `other`; anything else
  is sent as `other`. Delivered on the same async loop as error events, never throws, and a no-op
  when the client isn't enabled.
- Changes between deploys are now detected automatically. Once per process, `init()` schedules a
  snapshot of the Node version and your `package.json` dependencies resolved to their installed
  versions, and ForgeOps records whatever changed since the previous boot. New `detectChanges`
  option (default `true`) turns this off.
- New `trackEnvVarNames` option (default `false`) adds environment variable names, never values, to
  that snapshot. Host-specific names (`HOSTNAME`, `PATH`, `PORT`, `LC_*`, Kubernetes service
  variables, and others) and the SDK's own `FORGE_OPS_*` settings are always left out.

## 0.11.0

- Every error reported during an Express or Fastify request now says where it happened:
  `transaction_name` (the same `GET /orders/:id` name performance samples and traces already use),
  `endpoint` (the method plus the route as declared, never the literal path, so no ids or tokens),
  and `trace_id` (the request's W3C trace id). With `forgeOpsTrackerTracingExpressMiddleware` or
  `registerForgeOpsTrackerTracing` installed, an error you capture yourself inside a handler already
  has them; `forgeOpsTrackerExpressMiddleware` and `registerForgeOpsTracker` add them to unhandled
  errors on their own. Left out entirely outside a request. Structured fields, so they're never
  PII-scrubbed.
- Distributed tracing across services, using the W3C Trace Context standard. A request that
  arrives with a valid `traceparent` header continues that trace instead of starting its own, and
  its root span points at the caller's span. Every outbound `http`/`https` request made during a
  request now sends a `traceparent` header whose parent id is that call's own span, so the next
  service (any service that understands the standard, not only ones reporting to ForgeOps) can
  continue the trace. A `traceparent` you set yourself is never overwritten, and the client's own
  deliveries to ForgeOps never get one. New `propagateTraces` (default true) and
  `tracePropagationTargets` (default null, meaning every host; or an array of host strings, each
  matching that host and its subdomains, and/or RegExps) control where the header goes. A trace id
  is created for every request even with `trackTracing` off, since it is also what links an error
  to errors in other services, once both projects are linked in ForgeOps.
- Trace and span ids are now guaranteed valid W3C ids (32 and 16 lowercase hex characters, never
  all zeros).
- An errored request's trace is always sent, however fast it was: an unhandled error, or any
  `captureException()` while the request was running. Previously only requests slower than
  `traceCaptureThresholdMs` were sent. Fast, successful requests are unchanged.

## 0.10.0

- Database errors now say where to look. When an error carries the SQL behind a failed database call (a `.sql` or `.query` string, as on Sequelize, mysql2 and TypeORM errors, including through `cause`), the event carries the names of the stored procedure, table and view that SQL touched. On by default (`captureSqlObjects`); names are identifiers, never values. New opt-in `captureSqlStatement` (default false) also sends the statement itself, with every string and number replaced by `?`. New `withSql(error, statement)` attaches the statement to an error from a driver that doesn't carry it. Each project has its own server-side setting that can stop the statement being stored regardless of this flag; the names are still kept.

## 0.9.1

- Documentation only: the README and package description now describe ForgeOps as a hosted service, link to getforgeops.net, and show the real host in the connection string example instead of a placeholder. No code changes.

## 0.9.0

- Performance percentiles: every performance sample now carries a small latency histogram alongside
  its count/sum/max (fixed buckets of 50, 100, 250, 500, 1000, 2500, 5000 and 10000ms, plus an
  overflow bucket), so ForgeOps can show an approximate p50/p95/p99 per transaction instead of
  only an average. No new config; this rides the existing performance tracking flag and flush
  interval. Also fixes a flush race: a request recorded while a flush was still delivering could be discarded
  when that delivery succeeded; now only what was actually delivered is removed.

## 0.8.0

- Custom metrics and infrastructure monitoring: `captureMetric(name, value = 1)` records a named
  business event (a signup, a payment), and `captureInfrastructureMetric(name, value, { hostname })`
  records a CPU/memory/disk reading from one of your own hosts. Both are buffered, flushed as a batch
  every `metricFlushIntervalMs`/`infrastructureMetricFlushIntervalMs` and when the event loop drains,
  or right away with `await flushMetrics()`. Nothing is automatic, so there is no `track*` flag.

## 0.7.0

- Distributed tracing: for one slow request, captures its full nested call tree (a route span,
  plus every outbound HTTP call and manually-wrapped span nested under it) and delivers it as a
  single trace, ready for ForgeOps to render as a waterfall. Only ever built, let alone sent,
  once a request's own root span duration crosses `traceCaptureThresholdMs` (default 1000ms,
  client-side, before a single byte goes over the wire): a normal, fast request costs nothing
  extra. `forgeOpsTrackerTracingExpressMiddleware` and `registerForgeOpsTrackerTracing()`
  (`./integrations/tracing`) capture the route span; outbound calls via Node's built-in
  `http`/`https` modules nest in automatically, no extra setup. A logically distinct chunk of your
  own code (typically a service-layer call) has no automatic hook to nest under, so wrap it by
  hand with the new `forgeOpsTracker.span(name, callback, { kind, data })`, which works with sync
  or async callbacks and nests correctly even under concurrent `Promise.all` calls; a no-op with
  no trace currently being captured. On by default (`trackTracing`), same posture as every other
  automatic instrumentation this client does. No database or Redis span capture yet; see the
  README's own note on those gaps.

## 0.6.0

- Breadcrumbs: a trail of the request/controller lifecycle leading up to an error, recorded
  automatically by `forgeOpsTrackerPerformanceExpressMiddleware` (on by default, same as every
  other automatic instrumentation this client does; opt out with `trackBreadcrumbs: false`, or
  tune `maxBreadcrumbs`, default 30). `addBreadcrumb(message, { category, level, data })` adds
  your own, regardless of whether the automatic sources are on, and works outside a request
  entirely too (a plain script, a worker with no breadcrumb-context middleware/hook installed).
  Unlike the affected user, a breadcrumb's message/data is scrubbed for likely PII. Scoped with a
  second `AsyncLocalStorage` instance, the same mechanism `runWithUser()` already uses for the
  affected user, so one request's trail never bleeds into another's interleaved on the same event
  loop; a new `forgeOpsTrackerBreadcrumbContextExpressMiddleware` (Express) and
  `registerForgeOpsTrackerBreadcrumbContext()` (Fastify) give every request its own trail, and
  must be registered/called before the user-context and performance integrations.

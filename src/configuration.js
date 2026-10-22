import os from "node:os";
import { envFlag, envList } from "./strictPrivacy.js";

/**
 * Holds a single ForgeOps DSN plus everything else the client needs to
 * build and deliver events. Mirrors gems/forge_ops_tracker's Configuration:
 * a single DSN string carries both the ingestion URL and
 * the project's api_key: "https://<api_key>@host/api/v1/events".
 */
export class Configuration {
  dsn = process.env.FORGE_OPS_DSN ?? null;
  environment = resolveEnvironment();
  release = process.env.FORGE_OPS_RELEASE ?? null;
  serverName = safeHostname();

  /**
   * Used to decide whether a backtrace frame is "in_app": a frame's file
   * path is compared against this root. Like the Ruby gem (and unlike
   * the .NET SDK, where a compiled assembly's file path never matches
   * its original source location), Node runs interpreted directly from
   * real .js files on disk, so file-path matching is the correct
   * approach here too. Defaults to the current working directory; set
   * explicitly if that doesn't match your app's actual layout.
   */
  appRoot = process.cwd();

  enabledEnvironments = new Set(["production", "staging"]);
  queueSize = 1000;
  timeoutMs = 2000;
  scrubPii = true;

  /**
   * Whether EventBuilder reads a few lines of source off disk around each
   * in-app frame's culprit line (see EventBuilder#attachSourceContext).
   * Defaults to true so a snippet shows up with no extra setup, but this
   * flag by itself isn't what actually keeps proprietary source code from
   * ending up somewhere it shouldn't: ForgeOps' own per-project setting is
   * the durable, server-enforced off switch, since it applies no matter
   * what this flag happens to be set to on any given deployment, and can't
   * quietly drift back on the way a local config value could. Set this to
   * false too if this host app should never even attempt that disk read in
   * the first place.
   */
  captureSourceContext = true;

  /**
   * When an error comes from a database call (Sequelize, TypeORM, mysql2, and anything that wraps
   * one), send the names of the stored procedure, table and view its SQL touched, so an issue says
   * where to start looking. Names are identifiers, never values, which is why this defaults on.
   * captureSqlStatement is the separate, opt-in step of also sending the statement itself, with
   * every string and number replaced by "?"; off by default because even a masked statement
   * describes your schema, and ForgeOps' own per-project setting is what durably governs whether
   * the server stores it. See sqlStatement.js.
   * @type {boolean}
   */
  captureSqlObjects = true;

  /** @type {boolean} */
  captureSqlStatement = false;

  /**
   * Strict privacy, for apps that can't let personal or health data leave this process: every
   * error event goes out without its message (a message_fingerprint instead, so errors still
   * group), breadcrumbs, endpoint, SQL statement, source context, or the user's email/username,
   * and with only the context/tag keys named in privacyAllowedFields. Outbound HTTP spans are named
   * by method and host only, and span data keeps only db.statement and db.system. See
   * strictPrivacy.js. Off by default; FORGE_OPS_STRICT_PRIVACY=true turns it on, and a value passed
   * to init() wins over the environment. ForgeOps applies the same rules again on arrival when
   * the project's own Strict privacy setting is on.
   * @type {boolean}
   */
  strictPrivacy = envFlag(process.env.FORGE_OPS_STRICT_PRIVACY);

  /**
   * Context and tag keys strict privacy still sends (only plain string, number or boolean values
   * under these exact top-level keys), e.g. ["error_code", "feature"]. Defaults to
   * FORGE_OPS_PRIVACY_ALLOWED_FIELDS, comma separated, or none.
   * @type {string[]}
   */
  privacyAllowedFields = envList(process.env.FORGE_OPS_PRIVACY_ALLOWED_FIELDS);

  /** @type {((message: string) => void) | null} */
  logger = null;

  /**
   * Whether the Express/Fastify integrations count every request as a session (crash-free
   * unless an unhandled exception actually escaped it) and periodically report an aggregate
   * crash-free rate. On by default, the same "on unless you turn it off" posture error
   * tracking itself already has.
   */
  trackSessions = true;
  /** Milliseconds between aggregate session reports; requests are counted in-process and
   * flushed as one small report on this interval, not one network call per request. */
  sessionFlushIntervalMs = 60000;

  /**
   * Whether the Express integration times every request's duration and periodically reports an
   * aggregate per transaction. On by default, the same posture trackSessions above already has.
   */
  trackPerformance = true;
  /** Milliseconds between aggregate performance reports; same "counted in-process, flushed as
   * one small batch on this interval" reasoning as sessionFlushIntervalMs above. */
  performanceFlushIntervalMs = 60000;

  /** Milliseconds between flushes of the buffered captureMetric()/captureInfrastructureMetric()
   * entries (see metricBuffer.js). No trackMetrics flag the way trackPerformance has one: these are
   * explicit calls the host app's own code makes, not automatic instrumentation, so there is nothing
   * to turn off that simply not calling them doesn't already do. */
  metricFlushIntervalMs = 60000;
  infrastructureMetricFlushIntervalMs = 60000;

  /**
   * Whether the Express/Fastify integrations give every request its own breadcrumb trail, and
   * whatever automatic sources this client already times (the Express controller/route lifecycle,
   * see integrations/performance.js; every pg query; every Redis command) also record a breadcrumb
   * alongside the timing they already do. On by default, the same posture trackSessions/
   * trackPerformance above already have. addBreadcrumb() itself is never gated by this: only the
   * automatic sources are, matching gems/forge_ops_tracker's own track_breadcrumbs.
   */
  trackBreadcrumbs = true;
  /** Oldest entry dropped once this many have accumulated in a single request: the same "bounded
   * ring buffer, not an unbounded log" reasoning sdks/typescript's own Configuration#maxBreadcrumbs
   * already documents. */
  maxBreadcrumbs = 30;

  /**
   * Whether the Express/Fastify integrations capture one request's own full nested call tree (its
   * root span plus every service/database/http/redis span recorded underneath it) as a
   * distributed trace, once that request's own total duration crosses traceCaptureThresholdMs
   * below. On by default, the same "on unless you turn it off" posture every other automatic
   * instrumentation flag above already has; a fast request still costs nothing regardless, since
   * the send-or-don't decision happens after the fact, per request, not by disabling this flag.
   */
  trackTracing = true;
  /** A request's own root span duration has to reach at least this many milliseconds before its
   * whole trace is sent at all; this is the entire point of the feature, not a sampling knob: a
   * normal, fast request never costs a single byte over the wire. Matches
   * gems/forge_ops_tracker's own Configuration#trace_capture_threshold_ms default. */
  traceCaptureThresholdMs = 1000;

  /**
   * Adds a W3C `traceparent` header (https://www.w3.org/TR/trace-context/) to every outbound
   * http/https request made during a request the Express/Fastify tracing integration is handling
   * (see httpTracing.js), so a service that reports to ForgeOps too (or anything else that
   * understands the standard) continues this request's trace instead of starting its own. On by
   * default, the same as gems/forge_ops_tracker's propagate_traces: the header also carries the
   * trace id that links an error here to an error there, which is useful with or without spans.
   * Never overwrites a traceparent the request already has.
   */
  propagateTraces = true;
  /**
   * Which hosts get that header. null (the default) means every host. Otherwise an array whose
   * entries are either a host string, matching that host and its subdomains on a dot boundary
   * ("example.com" matches "api.example.com", not "badexample.com"; a leading dot is ignored), or a
   * RegExp tested against the host (no port). Narrow it for a third-party API that rejects headers
   * it doesn't know, or that shouldn't learn this app's trace ids at all.
   * @type {Array<string | RegExp> | null}
   */
  tracePropagationTargets = null;

  /**
   * Sends one startup snapshot per process (the Node version and the installed versions of your
   * package.json dependencies; see changes.js) which ForgeOps diffs against the previous boot's to
   * record what changed between deploys. On by default, same posture as every other automatic
   * behavior here.
   */
  detectChanges = true;
  /**
   * Whether that snapshot also lists the names of this process's environment variables, so an
   * added or removed variable shows up as a change. Off by default: names only, never values, but
   * even names can say more about an app than some teams want to share. Host-specific names
   * (HOSTNAME, PATH, PORT, and so on; see changes.js) are always left out.
   */
  trackEnvVarNames = false;

  /** @returns {string | null} */
  apiKey() {
    const parsed = this.#parsedDsn();
    if (parsed === null || parsed.username === "") {
      return null;
    }
    return decodeURIComponent(parsed.username);
  }

  /**
   * The ingestion URL with credentials stripped out (they travel as the
   * Authorization header instead, not embedded in the request URI).
   * @returns {string | null}
   */
  ingestionUri() {
    const parsed = this.#parsedDsn();
    if (parsed === null) {
      return null;
    }
    const stripped = new URL(parsed.toString());
    stripped.username = "";
    stripped.password = "";
    return stripped.toString();
  }

  /**
   * Same derivation as ingestionUri, with the trailing /events swapped for /session_checkins:
   * one DSN, two endpoints, matching the Ruby gem's own Configuration#session_checkins_uri.
   * @returns {string | null}
   */
  sessionCheckinsUri() {
    const uri = this.ingestionUri();
    if (!uri) {
      return null;
    }
    return uri.replace(/\/events$/, "/session_checkins");
  }

  /**
   * Same derivation again, swapping the trailing /events for /performance_samples.
   * @returns {string | null}
   */
  performanceSamplesUri() {
    const uri = this.ingestionUri();
    if (!uri) {
      return null;
    }
    return uri.replace(/\/events$/, "/performance_samples");
  }

  /**
   * Same derivation again, swapping the trailing /events for /custom_metrics.
   * @returns {string | null}
   */
  customMetricsUri() {
    const uri = this.ingestionUri();
    if (!uri) {
      return null;
    }
    return uri.replace(/\/events$/, "/custom_metrics");
  }

  /**
   * Same derivation again, swapping the trailing /events for /infrastructure_metrics.
   * @returns {string | null}
   */
  infrastructureMetricsUri() {
    const uri = this.ingestionUri();
    if (!uri) {
      return null;
    }
    return uri.replace(/\/events$/, "/infrastructure_metrics");
  }

  /**
   * Same derivation again, swapping the trailing /events for /spans: one captured trace, one POST,
   * matching gems/forge_ops_tracker's own Configuration#spans_uri.
   * @returns {string | null}
   */
  spansUri() {
    const uri = this.ingestionUri();
    if (!uri) {
      return null;
    }
    return uri.replace(/\/events$/, "/spans");
  }

  /**
   * Same derivation again, swapping the trailing /events for /changes (recordChange()).
   * @returns {string | null}
   */
  changesUri() {
    const uri = this.ingestionUri();
    if (!uri) {
      return null;
    }
    return uri.replace(/\/events$/, "/changes");
  }

  /**
   * Same derivation again, swapping the trailing /events for /change_snapshots (the startup
   * snapshot).
   * @returns {string | null}
   */
  changeSnapshotsUri() {
    const uri = this.ingestionUri();
    if (!uri) {
      return null;
    }
    return uri.replace(/\/events$/, "/change_snapshots");
  }

  /**
   * Whether an outbound request to `host` should carry a traceparent header; see
   * propagateTraces/tracePropagationTargets above. Case-insensitive, since hostnames are.
   * @param {string} host
   * @returns {boolean}
   */
  propagatesTraceTo(host) {
    if (!this.propagateTraces) {
      return false;
    }
    if (this.tracePropagationTargets === null || this.tracePropagationTargets === undefined) {
      return true;
    }
    const normalized = String(host ?? "").toLowerCase();
    return this.tracePropagationTargets.some((target) => {
      if (target instanceof RegExp) {
        target.lastIndex = 0; // a /g or /y pattern would otherwise carry state from the last test
        return target.test(normalized);
      }
      const suffix = String(target).toLowerCase().replace(/^\./, "");
      return suffix !== "" && (normalized === suffix || normalized.endsWith(`.${suffix}`));
    });
  }

  /**
   * Whether a request to `host`:`port` is one of this client's own deliveries to ForgeOps (same
   * host and port as the DSN), so the outbound-HTTP wrapper never adds a traceparent to it. The
   * Client itself uses fetch(), which that wrapper never sees, so this is a second guard, not the
   * only one.
   * @param {string} host
   * @param {number | string | null | undefined} port
   * @param {string} protocol "http:" or "https:"
   * @returns {boolean}
   */
  isOwnHost(host, port, protocol) {
    const parsed = this.#parsedDsn();
    if (parsed === null || !host) {
      return false;
    }
    const defaultPort = (scheme) => (scheme === "http:" ? "80" : scheme === "https:" ? "443" : "");
    const ownPort = parsed.port || defaultPort(parsed.protocol);
    const targetPort = port === null || port === undefined || port === "" ? defaultPort(protocol) : String(port);
    return String(host).toLowerCase() === parsed.hostname.toLowerCase() && targetPort === ownPort;
  }

  /** @returns {boolean} */
  isEnabled() {
    return Boolean(this.dsn) && this.apiKey() !== null && this.enabledEnvironments.has(this.environment);
  }

  /**
   * The one-line warning init() prints when a DSN is configured but this environment isn't one of
   * enabledEnvironments, so nothing would be sent; null when there's nothing to warn about (no DSN,
   * or the environment is enabled).
   *
   * @returns {string | null}
   */
  disabledEnvironmentWarning() {
    if (!this.dsn || this.apiKey() === null || this.enabledEnvironments.has(this.environment)) {
      return null;
    }
    const enabled = [...this.enabledEnvironments].join(", ");
    return (
      `[ForgeOps] Not sending: this environment is ${JSON.stringify(this.environment)}, and only ${enabled} ` +
      `${this.enabledEnvironments.size === 1 ? "is" : "are"} enabled. Set FORGE_OPS_ENVIRONMENT=production ` +
      `(or add ${JSON.stringify(this.environment)} to the enabled environments) to send from here.`
    );
  }

  /** @param {string} message */
  log(message) {
    this.logger?.(message);
  }

  /** @returns {URL | null} */
  #parsedDsn() {
    if (!this.dsn) {
      return null;
    }
    try {
      // Unlike Ruby's URI.parse, Python's urlsplit, and PHP's parse_url
      // (all lenient, never throwing on malformed input: verified
      // directly for each), Node's URL constructor genuinely throws a
      // TypeError on a malformed string. Verified directly here too,
      // not assumed: hence this try/catch, which the other three
      // clients don't need.
      return new URL(this.dsn);
    } catch {
      return null;
    }
  }
}

/**
 * The environment a new Configuration starts with: FORGE_OPS_ENVIRONMENT, then NODE_ENV, then
 * "production" when neither is set (an empty value counts as unset). Production rather than
 * development, so an app that sets nothing at all still sends its errors.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveEnvironment(env = process.env) {
  for (const name of ["FORGE_OPS_ENVIRONMENT", "NODE_ENV"]) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return "production";
}

function safeHostname() {
  try {
    return os.hostname();
  } catch {
    return null;
  }
}

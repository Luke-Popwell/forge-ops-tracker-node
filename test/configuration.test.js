import assert from "node:assert/strict";
import { test } from "node:test";
import { Configuration, resolveEnvironment } from "../src/configuration.js";

function newConfiguration() {
  const config = new Configuration();
  config.dsn = null;
  config.enabledEnvironments = new Set(["production", "staging"]);
  config.environment = "production";
  return config;
}

test("extracts apiKey and a credential-free ingestionUri from the DSN", () => {
  const config = newConfiguration();
  config.dsn = "https://secret-key@tracker.example.com/api/v1/events";

  assert.equal(config.apiKey(), "secret-key");
  assert.equal(config.ingestionUri(), "https://tracker.example.com/api/v1/events");
});

test("returns null for both when there is no DSN", () => {
  const config = newConfiguration();
  config.dsn = null;

  assert.equal(config.apiKey(), null);
  assert.equal(config.ingestionUri(), null);
});

test("returns null for both when the DSN is malformed", () => {
  const config = newConfiguration();
  config.dsn = "not a uri :: at all";

  assert.equal(config.apiKey(), null);
  assert.equal(config.ingestionUri(), null);
});

test("isEnabled is true with a valid DSN in an enabled environment", () => {
  const config = newConfiguration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.environment = "production";

  assert.equal(config.isEnabled(), true);
});

test("isEnabled is false with no DSN configured", () => {
  const config = newConfiguration();
  config.dsn = null;

  assert.equal(config.isEnabled(), false);
});

test("isEnabled is false when the DSN has no api key", () => {
  const config = newConfiguration();
  config.dsn = "https://tracker.example.com/api/v1/events";

  assert.equal(config.isEnabled(), false);
});

test("isEnabled is false outside the configured enabledEnvironments", () => {
  const config = newConfiguration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.environment = "development";

  assert.equal(config.isEnabled(), false);
});

test("captureSourceContext defaults to true", () => {
  assert.equal(new Configuration().captureSourceContext, true);
});

test("trackSessions defaults to true", () => {
  assert.equal(new Configuration().trackSessions, true);
});

test("sessionFlushIntervalMs defaults to 60000", () => {
  assert.equal(new Configuration().sessionFlushIntervalMs, 60000);
});

test("sessionCheckinsUri swaps events for session_checkins", () => {
  const config = newConfiguration();
  config.dsn = "https://secret-key@tracker.example.com/api/v1/events";

  assert.equal(config.sessionCheckinsUri(), "https://tracker.example.com/api/v1/session_checkins");
});

test("sessionCheckinsUri is null with no DSN", () => {
  const config = newConfiguration();
  config.dsn = null;

  assert.equal(config.sessionCheckinsUri(), null);
});

test("trackPerformance defaults to true", () => {
  assert.equal(new Configuration().trackPerformance, true);
});

test("performanceFlushIntervalMs defaults to 60000", () => {
  assert.equal(new Configuration().performanceFlushIntervalMs, 60000);
});

test("performanceSamplesUri swaps events for performance_samples", () => {
  const config = newConfiguration();
  config.dsn = "https://secret-key@tracker.example.com/api/v1/events";

  assert.equal(config.performanceSamplesUri(), "https://tracker.example.com/api/v1/performance_samples");
});

test("performanceSamplesUri is null with no DSN", () => {
  const config = newConfiguration();
  config.dsn = null;

  assert.equal(config.performanceSamplesUri(), null);
});

test("trackTracing defaults to true", () => {
  assert.equal(new Configuration().trackTracing, true);
});

test("traceCaptureThresholdMs defaults to 1000", () => {
  assert.equal(new Configuration().traceCaptureThresholdMs, 1000);
});

test("spansUri swaps events for spans", () => {
  const config = newConfiguration();
  config.dsn = "https://secret-key@tracker.example.com/api/v1/events";

  assert.equal(config.spansUri(), "https://tracker.example.com/api/v1/spans");
});

test("spansUri is null with no DSN", () => {
  const config = newConfiguration();
  config.dsn = null;

  assert.equal(config.spansUri(), null);
});

test("propagates traces to every host by default", () => {
  const config = newConfiguration();

  assert.equal(config.propagateTraces, true);
  assert.equal(config.tracePropagationTargets, null);
  assert.equal(config.propagatesTraceTo("api.example.com"), true);
});

test("propagateTraces false turns the header off everywhere", () => {
  const config = newConfiguration();
  config.propagateTraces = false;
  config.tracePropagationTargets = ["api.example.com"];

  assert.equal(config.propagatesTraceTo("api.example.com"), false);
});

test("a string target matches that host and its subdomains on a dot boundary, ignoring case and a leading dot", () => {
  const config = newConfiguration();
  config.tracePropagationTargets = [".Example.com"];

  assert.equal(config.propagatesTraceTo("example.com"), true);
  assert.equal(config.propagatesTraceTo("API.example.COM"), true);
  assert.equal(config.propagatesTraceTo("badexample.com"), false);
  assert.equal(config.propagatesTraceTo("example.com.evil.net"), false);
});

test("a RegExp target is tested against the host, even a /g one twice in a row", () => {
  const config = newConfiguration();
  config.tracePropagationTargets = [/^10\.0\./g];

  assert.equal(config.propagatesTraceTo("10.0.0.5"), true);
  assert.equal(config.propagatesTraceTo("10.0.0.5"), true);
  assert.equal(config.propagatesTraceTo("110.0.0.5"), false);
});

test("an empty target list, or an empty string target, matches nothing", () => {
  const config = newConfiguration();
  config.tracePropagationTargets = [];
  assert.equal(config.propagatesTraceTo("api.example.com"), false);

  config.tracePropagationTargets = ["", "."];
  assert.equal(config.propagatesTraceTo("api.example.com"), false);
});

test("recognizes its own ingestion host and port", () => {
  const config = newConfiguration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";

  assert.equal(config.isOwnHost("tracker.example.com", undefined, "https:"), true);
  assert.equal(config.isOwnHost("Tracker.Example.com", 443, "https:"), true);
  assert.equal(config.isOwnHost("tracker.example.com", 8443, "https:"), false);
  assert.equal(config.isOwnHost("tracker.example.com", undefined, "http:"), false);
  assert.equal(config.isOwnHost("api.example.com", undefined, "https:"), false);

  config.dsn = null;
  assert.equal(config.isOwnHost("tracker.example.com", undefined, "https:"), false);
});

test("resolveEnvironment prefers FORGE_OPS_ENVIRONMENT, then NODE_ENV, then production", () => {
  assert.equal(resolveEnvironment({ FORGE_OPS_ENVIRONMENT: "staging", NODE_ENV: "development" }), "staging");
  assert.equal(resolveEnvironment({ NODE_ENV: "development" }), "development");
  assert.equal(resolveEnvironment({}), "production");
});

test("resolveEnvironment treats an empty or blank value as unset", () => {
  assert.equal(resolveEnvironment({ FORGE_OPS_ENVIRONMENT: "", NODE_ENV: "test" }), "test");
  assert.equal(resolveEnvironment({ FORGE_OPS_ENVIRONMENT: "  ", NODE_ENV: "" }), "production");
});

test("disabledEnvironmentWarning names the environment and the enabled ones when a DSN is set", () => {
  const config = newConfiguration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.environment = "development";

  assert.equal(
    config.disabledEnvironmentWarning(),
    '[ForgeOps] Not sending: this environment is "development", and only production, staging are enabled. ' +
      'Set FORGE_OPS_ENVIRONMENT=production (or add "development" to the enabled environments) to send from here.',
  );
});

test("disabledEnvironmentWarning is null without a DSN, or when the environment is enabled", () => {
  const config = newConfiguration();
  config.environment = "development";
  assert.equal(config.disabledEnvironmentWarning(), null);

  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.environment = "staging";
  assert.equal(config.disabledEnvironmentWarning(), null);
});

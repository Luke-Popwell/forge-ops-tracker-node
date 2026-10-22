import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Payloads for "what changed": one explicit recordChange() call (POST /api/v1/changes), and the
 * startup snapshot (POST /api/v1/change_snapshots) that ForgeOps diffs against the previous boot's
 * to record what changed between deploys. Mirrors gems/forge_ops_tracker's Change and
 * ChangeSnapshot.
 *
 * The snapshot leaves out any key it can't determine reliably rather than guessing, since the
 * server reads a missing key as "unknown", never as "everything was removed". Environment variable
 * names are only ever names, never values, and only when trackEnvVarNames is on.
 */

/** The server rejects any other kind outright (422), so an unknown one is sent as "other" rather
 * than dropped: the change still gets recorded, just less specifically categorized. */
export const CHANGE_KINDS = Object.freeze(["feature_flag", "config", "migration", "dependency", "infrastructure", "other"]);
const MAX_TITLE_LENGTH = 200;

const MAX_DEPENDENCIES = 3000;
const MAX_NAME_LENGTH = 200;
const MAX_VERSION_LENGTH = 100;
const MAX_ENV_VAR_NAMES = 3000;

/** Host-specific variables that differ from one box to the next (or one boot to the next) without
 * anything about the deploy having changed, so a fleet doesn't look like it's changing on every
 * restart. The SDK's own FORGE_OPS_* settings are dropped too. */
const ENV_VAR_DENYLIST = new Set([
  "HOSTNAME", "HOST", "HOME", "PATH", "PWD", "OLDPWD", "SHLVL", "_", "TERM", "USER", "LOGNAME", "SHELL",
  "LANG", "TMPDIR", "TZ", "PORT", "DYNO", "INVOCATION_ID", "JOURNAL_STREAM",
]);
const ENV_VAR_DENYLIST_PATTERNS = [
  /^LC_/, /^SYSTEMD_/, /^MEMORY_PRESSURE_/, /^KUBERNETES_/, /^FORGE_OPS_/,
  /_SERVICE_HOST$/, /_SERVICE_PORT/, /_PORT_.*_TCP/,
];

/** @param {unknown} kind */
export function normalizeKind(kind) {
  return CHANGE_KINDS.includes(kind) ? kind : "other";
}

/**
 * The body for one recordChange() call, or null when there's nothing sendable (a blank title: the
 * server requires one, so posting it anyway would only ever come back 422).
 * @param {import("./configuration.js").Configuration} configuration
 * @param {{ kind: string, title: string, details?: Record<string, unknown>, environment?: string,
 *   service?: string, actor?: string, url?: string, id?: string, occurredAt?: Date | string }} change
 */
export function buildChange(configuration, { kind, title, details, environment, service, actor, url, id, occurredAt } = {}) {
  const trimmed = title == null ? "" : String(title).trim();
  if (trimmed === "") {
    return null;
  }

  const payload = {
    kind: normalizeKind(kind),
    title: trimmed.slice(0, MAX_TITLE_LENGTH),
    details: details !== null && typeof details === "object" && !Array.isArray(details) ? details : {},
    environment: String(environment ?? configuration.environment),
  };
  for (const [key, value] of Object.entries({ service, actor, url, id })) {
    if (value != null) {
      payload[key] = String(value);
    }
  }
  payload.occurred_at = iso8601(occurredAt);
  return payload;
}

/** @param {Date | string | undefined} value */
function iso8601(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return new Date().toISOString();
}

/** @param {string} name */
export function isDeniedEnvVar(name) {
  return ENV_VAR_DENYLIST.has(name) || ENV_VAR_DENYLIST_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Names only, never values, sorted so the same set always serializes the same way.
 * @param {Record<string, string | undefined>} [env]
 */
export function envVarNames(env = process.env) {
  return Object.keys(env)
    .filter((name) => !isDeniedEnvVar(name))
    .sort()
    .slice(0, MAX_ENV_VAR_NAMES);
}

export function runtime() {
  return `node ${process.versions.node}`;
}

/**
 * The app's own direct dependencies (the "dependencies" in `<appRoot>/package.json`), each
 * resolved to the version actually installed under `<appRoot>/node_modules/<name>/package.json`,
 * never the semver range the manifest asks for. A dependency that isn't installed there is left
 * out rather than guessed at, and so is the whole key (null) when there's no package.json to read.
 * @param {string} appRoot
 */
export async function dependencies(appRoot) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
  } catch {
    return null;
  }

  const names = Object.keys(manifest?.dependencies ?? {}).sort().slice(0, MAX_DEPENDENCIES);
  const resolved = await Promise.all(names.map((name) => installedVersion(appRoot, name)));
  const found = {};
  names.forEach((name, index) => {
    if (resolved[index]) {
      found[name.slice(0, MAX_NAME_LENGTH)] = resolved[index].slice(0, MAX_VERSION_LENGTH);
    }
  });
  return Object.keys(found).length > 0 ? found : null;
}

async function installedVersion(appRoot, name) {
  try {
    const installed = JSON.parse(await readFile(path.join(appRoot, "node_modules", name, "package.json"), "utf8"));
    return typeof installed?.version === "string" ? installed.version : null;
  } catch {
    return null;
  }
}

/** @param {import("./configuration.js").Configuration} configuration */
export async function buildSnapshot(configuration) {
  const state = { runtime: runtime() };
  const deps = await dependencies(configuration.appRoot);
  if (deps) {
    state.dependencies = deps;
  }
  if (configuration.trackEnvVarNames) {
    state.env_var_names = envVarNames();
  }
  return { environment: configuration.environment, state };
}

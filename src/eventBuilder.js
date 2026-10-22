import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { scrub, scrubString } from "./piiScrubber.js";
import * as sqlStatement from "./sqlStatement.js";
import * as strictPrivacy from "./strictPrivacy.js";

const MAX_FRAMES = 500;

// How many lines of source to grab on either side of the culprit line (see
// #attachSourceContext), and the longest a single captured line is allowed
// to be before getting truncated: guards against one pathological
// minified/generated line ballooning the payload. ForgeOps itself
// re-truncates on arrival too, the same "don't just trust the SDK" posture
// MAX_FRAMES already gets on the server side.
const CONTEXT_LINES = 5;
const MAX_CONTEXT_LINE_LENGTH = 500;

// Identifies this client to the server's auto language-detection on the project the event lands
// in (see Project#note_sdk_platform server-side); matches this repo's own sdks/node directory
// name, the same convention every other language's client follows.
const SDK_NAME = "node";

// Parses a single V8 stack trace line, e.g.
//   "    at innerFunc (file:///app/src/foo.js:12:9)"
//   "    at file:///app/src/foo.js:8:3"           (no named function)
//   "    at async asyncFn (node:internal/...:5:1)" (async frame, internal module)
// Verified directly against real captured stack traces (both sync and
// async, named and anonymous frames, and Node's internal node: module
// scheme) before relying on it, not assumed to match V8's format.
const FRAME_RE = /^\s*at\s+(?:(async)\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;

/**
 * Turns a raised exception into the payload shape the ingestion API
 * expects. Ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/event_builder.rb:
 * backtrace parsing here is a regex over V8's Error#stack string, the
 * same general approach as the Ruby gem's own regex over MRI backtrace
 * lines (Node doesn't expose a structured frame list the way Python's
 * traceback module or PHP's Throwable::getTrace() do).
 */
export class EventBuilder {
  #configuration;

  constructor(configuration) {
    this.#configuration = configuration;
  }

  /**
   * @param {Error} error
   * @param {Record<string, unknown>} [context]
   * @param {Record<string, unknown> | null} [user]
   * @param {Array<Record<string, unknown>>} [breadcrumbs]
   * @param {{ transactionName?: string | null, endpoint?: string | null, traceId?: string | null }} [request]
   *   Where the error happened (see RequestState in requestState.js): transactionName is the same
   *   "GET /orders/:id" name the request's root span and performance samples use, endpoint the
   *   human-readable route ("GET /orders/:id"), traceId the request's 32-character lowercase hex
   *   W3C trace id, which is also what links this error to errors other services reported for the
   *   same trace. All absent outside a request, and a missing one is left out of the payload.
   */
  build(error, context = {}, user = null, breadcrumbs = [], request = {}) {
    const payload = {
      exception_class: error?.name ?? "Error",
      message: error?.message ?? "",
      backtrace: this.#backtrace(error),
      occurred_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      environment: this.#configuration.environment,
      release: this.#configuration.release,
      server_name: this.#configuration.serverName,
      context: { ...context },
      tags: {},
      sdk_name: SDK_NAME,
    };
    if (user && Object.keys(user).length > 0) {
      payload.user = { ...user };
    }
    if (breadcrumbs && breadcrumbs.length > 0) {
      payload.breadcrumbs = [...breadcrumbs];
    }
    if (request.transactionName) {
      payload.transaction_name = request.transactionName;
    }
    if (request.endpoint) {
      payload.endpoint = request.endpoint;
    }
    if (request.traceId) {
      payload.trace_id = request.traceId;
    }
    this.#attachSql(payload, error);

    const finished = this.#configuration.scrubPii ? this.#scrub(payload) : payload;
    if (!this.#configuration.strictPrivacy) {
      return finished;
    }
    // Fingerprinted from the message as it would otherwise have been sent (scrubbed, when scrubPii
    // is on), so it matches what the server fingerprints from a client without strict privacy, and
    // a message holding an email still groups as one.
    const fingerprint = strictPrivacy.messageFingerprint(finished.message);
    return strictPrivacy.event(finished, fingerprint, this.#configuration.privacyAllowedFields);
  }

  // exception_class/occurred_at/environment/release/server_name/user/
  // transaction_name/endpoint/trace_id are left alone (endpoint is a
  // declared route pattern, never the literal path, so there's no id or
  // token in it to scrub): structured fields this client or the host app sets
  // deliberately, not free text an exception or its context could
  // accidentally spill sensitive data into. user specifically is a
  // deliberate exemption, not an oversight: the scrubber's own email
  // pattern would otherwise redact the exact thing this field exists to
  // carry. breadcrumbs is *not* exempt, unlike user: console-style/query/
  // request trail entries are exactly the kind of free text (a bind
  // parameter showing up in a message, a URL with a token in it) the
  // scrubber exists to catch, matching the server's own
  // api/v1/events_controller.rb treatment of this field.
  #scrub(payload) {
    const scrubbed = {
      ...payload,
      message: scrubString(payload.message),
      backtrace: payload.backtrace.map((frame) => this.#scrubFrame(frame)),
      context: scrub(payload.context),
      tags: scrub(payload.tags),
    };
    if ("breadcrumbs" in payload) {
      scrubbed.breadcrumbs = scrub(payload.breadcrumbs);
    }
    if ("sql_statement" in payload) {
      scrubbed.sql_statement = scrubString(payload.sql_statement);
    }
    return scrubbed;
  }

  // See sqlStatement.js for what's read off the error and how it's masked. The statement itself
  // only goes out when captureSqlStatement is on; the extracted names go out on their own
  // (captureSqlObjects) so an issue can still name the procedure or view involved.
  #attachSql(payload, error) {
    const config = this.#configuration;
    if (!config.captureSqlObjects && !config.captureSqlStatement) {
      return;
    }

    const masked = sqlStatement.mask(sqlStatement.findIn(error));
    if (masked === null) {
      return;
    }

    const found = sqlStatement.objects(masked);
    if (found && config.captureSqlObjects) {
      payload.sql_objects = found;
    }
    if (config.captureSqlStatement && !config.strictPrivacy) {
      payload.sql_statement = masked;
    }
  }

  #scrubFrame(frame) {
    const scrubbed = {
      ...frame,
      file: frame.file ? scrubString(frame.file) : frame.file,
      method: frame.method ? scrubString(frame.method) : frame.method,
    };
    if ("context_line" in scrubbed) {
      scrubbed.context_line = scrubString(scrubbed.context_line);
      scrubbed.pre_context = scrubbed.pre_context.map(scrubString);
      scrubbed.post_context = scrubbed.post_context.map(scrubString);
    }
    return scrubbed;
  }

  #backtrace(error) {
    const stack = typeof error?.stack === "string" ? error.stack : "";
    const frames = [];

    for (const line of stack.split("\n")) {
      if (frames.length >= MAX_FRAMES) {
        break;
      }
      const match = FRAME_RE.exec(line);
      if (!match) {
        continue; // the "Error: message" header line, or anything unparseable
      }

      const [, , fn, rawFile, lineNo, ] = match;
      const file = normalizeFile(rawFile);

      frames.push(
        this.#attachSourceContext({
          file,
          line: Number(lineNo),
          method: fn ?? null,
          in_app: this.#isInApp(file),
        }),
      );
    }

    return frames;
  }

  #isInApp(file) {
    const root = this.#configuration.appRoot;
    if (!file || !root) {
      return false;
    }
    if (!file.startsWith(root)) {
      return false;
    }
    return !file.includes("/node_modules/");
  }

  // Reads a few lines of source straight off disk around the culprit line,
  // at raise-time, in the same running process the exception came from.
  // Gated on two things: the frame has to be in-app (never a
  // node_modules/vendored dependency: there'd be nothing meaningful to
  // show, and it's not the host app's own code to begin with), and
  // configuration.captureSourceContext has to be true (see Configuration
  // for why it defaults to true and why ForgeOps' own per-project setting,
  // not this flag, is the durable, protected way to turn it off).
  // Best-effort: any file that can't be read (deleted, permission denied, a
  // path that only ever existed inside a build step and isn't present in
  // this deployment) just means this one frame gets no source context,
  // never a thrown error of its own.
  #attachSourceContext(frame) {
    if (!this.#configuration.captureSourceContext || this.#configuration.strictPrivacy || !frame.in_app) {
      return frame;
    }

    let lines;
    try {
      lines = splitLines(fs.readFileSync(frame.file, "utf8"));
    } catch {
      return frame;
    }

    const index = frame.line - 1;
    if (index < 0 || index >= lines.length) {
      return frame;
    }

    const from = Math.max(index - CONTEXT_LINES, 0);
    const to = Math.min(index + CONTEXT_LINES, lines.length - 1);

    return {
      ...frame,
      context_line: truncateLine(lines[index]),
      pre_context: lines.slice(from, index).map(truncateLine),
      post_context: lines.slice(index + 1, to + 1).map(truncateLine),
    };
  }
}

// Splits file content into lines the same way Ruby's File.readlines and
// Python's readlines() do: no phantom empty final element when the file
// ends with a trailing newline (a plain `content.split("\n")` would add
// one), and no trailing "\r" left over from a CRLF line ending.
function splitLines(content) {
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines.map((line) => line.replace(/\r$/, ""));
}

function truncateLine(line) {
  if (line.length <= MAX_CONTEXT_LINE_LENGTH) {
    return line;
  }
  return `${line.slice(0, MAX_CONTEXT_LINE_LENGTH)}...`;
}

// V8 stack frames use file:// URLs under ESM, but plain paths under
// CommonJS: normalized to a plain path either way so it's comparable
// against Configuration#appRoot (always a plain path, from process.cwd()).
// Node's own internal modules (the "node:" scheme) are left as-is; they
// never match a real appRoot prefix anyway, so they're correctly never
// marked in_app without needing special-casing here.
function normalizeFile(rawFile) {
  if (rawFile.startsWith("file://")) {
    try {
      return fileURLToPath(rawFile);
    } catch {
      return rawFile;
    }
  }
  return rawFile;
}

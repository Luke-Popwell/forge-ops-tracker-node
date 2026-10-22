import { DELIVERED, FAILED, MAX_FAILED_FLUSHES } from "./client.js";

/**
 * Collects individual captureMetric()/captureInfrastructureMetric() calls in-process and periodically
 * flushes them as one batch, rather than one network call per capture. Unlike performanceFlusher.js
 * this keeps a *list* of individually meaningful entries instead of summing them into buckets: a
 * customer's own signup or payment is exactly the kind of thing they will want a genuinely accurate
 * count/sum of later, so the server stores one row per entry as-is. Ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/metric_buffer.rb and infrastructure_metric_buffer.rb,
 * which are the same class twice; here it is one class instantiated twice, told which delivery
 * method and flush interval to use.
 *
 * Three deliberate differences from the Ruby buffers:
 *
 * - A flush snapshots the first N entries and, on success, removes exactly those N, instead of
 *   resetting the whole list: an entry recorded while the request is in flight (this is async, so
 *   that window is real) is kept for the next flush rather than lost.
 * - The buffer is capped at MAX_ENTRIES, and once full further entries are dropped until a flush
 *   empties it: an endpoint that is down fails every flush, and an uncapped buffer would keep
 *   growing until the batch is given up on. Dropping the newest rather than the oldest keeps the
 *   entries a flush is delivering at the front of the list, which is what makes removing exactly
 *   those afterward exact.
 * - A NaN or infinite value is dropped at record time: JSON.stringify turns it into `null`, which
 *   the server would reject, taking the whole batch with it.
 *
 * setInterval(...).unref(), not a real background thread, same reasoning sessionFlusher.js's own
 * header comment documents. Unlike that flusher this also flushes on "beforeExit" (fired when the
 * event loop has nothing left, and which does not change how the process exits the way a
 * SIGTERM/SIGINT listener would): the real use of the infrastructure endpoint is a short-lived cron
 * script that captures a few readings and lets the process end.
 */
export const MAX_ENTRIES = 1000;

export class MetricBuffer {
  #configuration;
  #deliver;
  #intervalMs;
  #entries = [];
  #timer = null;
  #beforeExit = null;
  #failedFlushes = 0;

  /**
   * @param {import("./configuration.js").Configuration} configuration
   * @param {(entries: Record<string, unknown>[]) => Promise<string>} deliver resolves to one of client.js's statuses
   * @param {() => number} intervalMs read fresh each time the timer is created
   */
  constructor(configuration, deliver, intervalMs) {
    this.#configuration = configuration;
    this.#deliver = deliver;
    this.#intervalMs = intervalMs;
  }

  /**
   * @param {Record<string, unknown>} entry everything but recorded_at
   * @returns {boolean} whether it was kept
   */
  record(entry) {
    const value = entry.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.#configuration.log("[forge-ops-tracker] dropped a metric with a non-numeric or non-finite value");
      return false;
    }
    if (this.#entries.length >= MAX_ENTRIES) {
      this.#configuration.log("[forge-ops-tracker] metric buffer full, dropping a metric");
      return false;
    }

    this.#ensureStarted();
    this.#entries.push({ ...entry, recorded_at: `${new Date().toISOString().slice(0, 19)}Z` });
    return true;
  }

  /**
   * Delivers everything buffered so far as one batch. A failed delivery keeps every entry, so the
   * next flush's batch just grows, until MAX_FAILED_FLUSHES flushes in a row have failed: that one
   * drops the batch. A batch the server rejects (a plan without the feature answers 403) is dropped
   * at once, since it would be refused again every time.
   */
  async flush() {
    if (this.#entries.length === 0) {
      return;
    }

    const snapshot = this.#entries.slice();
    const status = await this.#deliver(snapshot);
    if (status === FAILED) {
      this.#failedFlushes += 1;
      if (this.#failedFlushes < MAX_FAILED_FLUSHES) {
        return;
      }
    }
    this.#failedFlushes = 0;
    if (status !== DELIVERED) {
      const reason = status === FAILED ? `${MAX_FAILED_FLUSHES} flushes in a row failed` : "the server rejected them";
      this.#configuration.log(`[forge-ops-tracker] dropping ${snapshot.length} metric(s): ${reason}`);
    }

    // Exactly the entries just delivered or dropped: anything recorded while the request was in flight sits
    // after them and stays for the next flush.
    this.#entries.splice(0, snapshot.length);
  }

  /** Stops the timer and the exit hook without delivering anything. */
  discard() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#beforeExit !== null) {
      process.off("beforeExit", this.#beforeExit);
      this.#beforeExit = null;
    }
    this.#entries = [];
    this.#failedFlushes = 0;
  }

  #ensureStarted() {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => this.#flushSafely(), this.#intervalMs());
    this.#timer.unref();
    this.#beforeExit = () => this.#flushSafely();
    process.on("beforeExit", this.#beforeExit);
  }

  #flushSafely() {
    return this.flush().catch((e) => {
      this.#configuration.log(`[forge-ops-tracker] metric flush error: ${e.name}: ${e.message}`);
    });
  }
}

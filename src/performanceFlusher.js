import { DELIVERED, FAILED, MAX_FAILED_FLUSHES } from "./client.js";
import { bucketFor } from "./histogramBucketer.js";
import { spanName } from "./strictPrivacy.js";

/**
 * Times requests in-process, bucketed by transactionName (see integrations/performance.js), and
 * periodically flushes each distinct bucket as one small aggregate report, rather than one
 * network call per request. Ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/performance_flusher.rb; structurally the same
 * shape as sessionFlusher.js right next to it, just keyed by a Map of buckets instead of two
 * scalar counters.
 *
 * setInterval(...).unref(), not a real background thread, same reasoning sessionFlusher.js's own
 * header comment documents. Also deliberately does NOT hook SIGTERM/SIGINT to force a final
 * flush on exit, for the exact same reason sessionFlusher.js already rejects that: registering
 * either listener overrides Node's own default exit behavior, a real correctness risk to the
 * host app's own graceful shutdown, not just a data-completeness one. The accepted trade-off is
 * the same too: up to one performanceFlushIntervalMs window of data can be lost on a hard
 * process exit, a bounded, honest gap rather than a behavior change for the host app.
 */
export class PerformanceFlusher {
  #configuration;
  #client;
  #buckets = new Map();
  #periodStartedAt = new Date();
  #timer = null;
  #failedFlushes = 0;

  constructor(configuration, client) {
    this.#configuration = configuration;
    this.#client = client;
  }

  /**
   * @param {string} transactionName
   * @param {number} durationMs
   */
  record(transactionName, durationMs) {
    this.#ensureTimerStarted();
    // Strict privacy: a raw path loses its ids, a route is kept (see strictPrivacy.js).
    const name = this.#configuration.strictPrivacy ? spanName(transactionName) : transactionName;

    const bucket = this.#buckets.get(name) ?? { count: 0, durationSumMs: 0, maxDurationMs: 0, histogram: {} };
    bucket.count += 1;
    bucket.durationSumMs += durationMs;
    if (durationMs > bucket.maxDurationMs) {
      bucket.maxDurationMs = durationMs;
    }
    // The distribution count/sum/max can't reconstruct: see histogramBucketer.js for why the
    // server approximates a percentile from these bucket counts.
    const label = bucketFor(durationMs);
    bucket.histogram[label] = (bucket.histogram[label] ?? 0) + 1;
    this.#buckets.set(name, bucket);
  }

  /**
   * Snapshots the buckets, then delivers them as one batch. A failed delivery keeps every bucket
   * where it is rather than resetting, so the next flush's batch just grows instead of losing what
   * was already tallied; same reasoning sessionFlusher.js's own flush() documents. That holds for
   * MAX_FAILED_FLUSHES flushes in a row; the last of them drops the batch instead. A batch the
   * server rejects (see client.js) is dropped at once: it would be refused again every time.
   *
   * Only exactly what this snapshot delivered (or dropped) is removed afterward, subtracted from whatever is in
   * each bucket by then, never the whole map reset: record() can run while the delivery is awaited,
   * so a record for a transaction already in the snapshot, or a brand-new one, can land between the
   * snapshot and delivery succeeding, and resetting afterward would silently discard it.
   * maxDurationMs is left as whatever is currently on the bucket, sent or not: a max can't be
   * "subtracted" back out, and leaving it never overstates the next period's own max.
   */
  async flush() {
    if (this.#buckets.size === 0) {
      return;
    }

    const periodEndedAt = new Date();
    const sent = new Map(
      [...this.#buckets.entries()].map(([transactionName, bucket]) => [
        transactionName,
        { count: bucket.count, durationSumMs: bucket.durationSumMs, histogram: { ...bucket.histogram } },
      ]),
    );
    const samples = [...this.#buckets.entries()].map(([transactionName, bucket]) => ({
      transaction_name: transactionName,
      environment: this.#configuration.environment,
      release: this.#configuration.release,
      period_started_at: this.#periodStartedAt.toISOString(),
      period_ended_at: periodEndedAt.toISOString(),
      request_count: bucket.count,
      duration_sum_ms: bucket.durationSumMs,
      max_duration_ms: bucket.maxDurationMs,
      histogram: { ...bucket.histogram },
    }));

    const status = await this.#client.deliverPerformanceSamples(samples);
    if (status === FAILED) {
      this.#failedFlushes += 1;
      if (this.#failedFlushes < MAX_FAILED_FLUSHES) {
        return;
      }
    }
    this.#failedFlushes = 0;
    if (status !== DELIVERED) {
      const reason = status === FAILED ? `${MAX_FAILED_FLUSHES} flushes in a row failed` : "the server rejected them";
      this.#configuration.log(`[forge-ops-tracker] dropping ${samples.length} performance sample(s): ${reason}`);
    }

    for (const [transactionName, deliveredBucket] of sent) {
      const current = this.#buckets.get(transactionName);
      if (!current) {
        continue;
      }
      current.count -= deliveredBucket.count;
      current.durationSumMs = Math.max(current.durationSumMs - deliveredBucket.durationSumMs, 0);
      for (const [label, count] of Object.entries(deliveredBucket.histogram)) {
        const remaining = (current.histogram[label] ?? 0) - count;
        if (remaining > 0) {
          current.histogram[label] = remaining;
        } else {
          delete current.histogram[label];
        }
      }
      if (current.count <= 0) {
        this.#buckets.delete(transactionName);
      }
    }
    this.#periodStartedAt = periodEndedAt;
  }

  #ensureTimerStarted() {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      this.flush().catch((e) => {
        this.#configuration.log(`[forge-ops-tracker] performance flush error: ${e.name}: ${e.message}`);
      });
    }, this.#configuration.performanceFlushIntervalMs);
    this.#timer.unref();
  }
}

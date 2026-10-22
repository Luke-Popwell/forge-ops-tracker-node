/**
 * What became of one delivery. The three are told apart because the caller owes each a different
 * answer: DELIVERED (any 2xx) is done; REJECTED (a 4xx other than 408 and 429) is a payload the
 * server will never take, so sending it again only repeats the refusal; FAILED (a network error, a
 * timeout, a 5xx, a 408 or a 429) may well go through later.
 */
export const DELIVERED = "delivered";
export const REJECTED = "rejected";
export const FAILED = "failed";

/**
 * How many flushes in a row may fail before a flusher or buffer gives up on the batch it is holding
 * and starts clean, so an endpoint that stays down can't keep one batch growing for good.
 */
export const MAX_FAILED_FLUSHES = 5;

/** @param {number} status an HTTP status code */
function statusFor(status) {
  if (status >= 200 && status < 300) {
    return DELIVERED;
  }
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return REJECTED;
  }
  return FAILED;
}

/**
 * Delivers one payload over HTTP. Every failure mode (DNS, connection,
 * timeout, TLS, a non-2xx response) is caught here and turned into a
 * REJECTED or FAILED return rather than a thrown exception, since a broken
 * or unreachable tracker must never be able to break the host app. Ported
 * from gems/forge_ops_tracker/lib/forge_ops_tracker/client.rb.
 *
 * Uses the global fetch() (stable since Node 18), not a package
 * dependency (axios, node-fetch, etc.): same reason the Ruby gem uses
 * plain Net::HTTP and the Python/PHP clients use only their own
 * standard library: this has to work in any host app without adding an
 * HTTP client dependency of its own.
 */
export class Client {
  #configuration;

  constructor(configuration) {
    this.#configuration = configuration;
  }

  /** @param {Record<string, unknown>} payload */
  async deliver(payload) {
    return this.#post(this.#configuration.ingestionUri(), payload);
  }

  /** @param {Record<string, unknown>} payload */
  async deliverSessionCheckin(payload) {
    return this.#post(this.#configuration.sessionCheckinsUri(), payload);
  }

  /**
   * Same delivery contract again; samples is a batch (one entry per distinct transaction a
   * flush interval saw), not a single aggregate the way deliverSessionCheckin's own payload is,
   * so this posts { samples } rather than the array bare, matching what
   * Api::V1::PerformanceSamplesController expects.
   * @param {Record<string, unknown>[]} samples
   */
  async deliverPerformanceSamples(samples) {
    return this.#post(this.#configuration.performanceSamplesUri(), { samples });
  }

  /**
   * One whole captured trace (a trace_id plus every span belonging to it) delivered as one POST,
   * unlike deliverPerformanceSamples' own batched-over-a-time-window shape: a trace is already a
   * complete, immediately relevant unit the moment its own request finishes, matching
   * Api::V1::SpansController's own expected body and gems/forge_ops_tracker's own
   * Client#deliver_spans.
   * @param {{ trace_id: string, spans: Array<Record<string, unknown>> }} payload
   */
  async deliverSpans(payload) {
    return this.#post(this.#configuration.spansUri(), payload);
  }

  /**
   * A batch of individual capture_metric entries, posted as { metrics }, matching
   * Api::V1::CustomMetricsController's own expected body.
   * @param {Record<string, unknown>[]} metrics
   */
  async deliverMetrics(metrics) {
    return this.#post(this.#configuration.customMetricsUri(), { metrics });
  }

  /**
   * Same again for infrastructure readings; see Api::V1::InfrastructureMetricsController.
   * @param {Record<string, unknown>[]} metrics
   */
  async deliverInfrastructureMetrics(metrics) {
    return this.#post(this.#configuration.infrastructureMetricsUri(), { metrics });
  }

  /**
   * One recordChange() call; see Api::V1::ChangesController. A plan without change tracking
   * answers 403, which is just a REJECTED here like any other 4xx.
   * @param {Record<string, unknown>} payload
   */
  async deliverChange(payload) {
    return this.#post(this.#configuration.changesUri(), payload);
  }

  /**
   * The startup snapshot; see Api::V1::ChangeSnapshotsController.
   * @param {Record<string, unknown>} payload
   */
  async deliverChangeSnapshot(payload) {
    return this.#post(this.#configuration.changeSnapshotsUri(), payload);
  }

  /**
   * @param {string | null} uri
   * @param {Record<string, unknown>} payload
   * @returns {Promise<typeof DELIVERED | typeof REJECTED | typeof FAILED>}
   */
  async #post(uri, payload) {
    if (!uri) {
      return FAILED;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#configuration.timeoutMs);

    try {
      const response = await fetch(uri, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#configuration.apiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      return statusFor(response.status);
    } catch (e) {
      this.#configuration.log(`[forge-ops-tracker] delivery failed: ${e.name}: ${e.message}`);
      return FAILED;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Ties Configuration, EventBuilder, and DeliveryQueue together into the
 * one thing callers actually need: report an exception. Mirrors
 * gems/forge_ops_tracker's ErrorSubscriber#report: never throws. An
 * error reporter that itself throws while reporting an error is the
 * worst possible failure mode, so every path here is wrapped to
 * guarantee this never propagates back into the host app.
 */
export class Reporter {
  #configuration;
  #eventBuilder;
  #deliveryQueue;

  constructor(configuration, eventBuilder, deliveryQueue) {
    this.#configuration = configuration;
    this.#eventBuilder = eventBuilder;
    this.#deliveryQueue = deliveryQueue;
  }

  /**
   * @param {Error} error
   * @param {Record<string, unknown>} [context]
   * @param {Record<string, unknown> | null} [user]
   * @param {Array<Record<string, unknown>>} [breadcrumbs]
   * @param {{ transactionName?: string | null, endpoint?: string | null, traceId?: string | null }} [request] see EventBuilder#build
   */
  report(error, context = {}, user = null, breadcrumbs = [], request = {}) {
    try {
      if (!this.#configuration.isEnabled()) {
        return;
      }

      const payload = this.#eventBuilder.build(error, context, user, breadcrumbs, request);
      this.#deliveryQueue.push(payload);
    } catch (e) {
      this.#configuration.log(`[forge-ops-tracker] report failed: ${e.name}: ${e.message}`);
    }
  }
}

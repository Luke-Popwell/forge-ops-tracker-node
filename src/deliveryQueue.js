import { REJECTED } from "./client.js";

/**
 * A small in-process bounded queue drained by an async processing loop,
 * so delivery never blocks the caller that raised the error and never
 * depends on the host app having any particular job backend configured.
 * Ported from gems/forge_ops_tracker/lib/forge_ops_tracker/delivery_queue.rb.
 *
 * Not a real background thread the way the Ruby/.NET/Python clients'
 * DeliveryQueue is: Node is single-threaded, but (unlike PHP-FPM) a
 * Node process is long-running across many requests, so async scheduling
 * on the event loop is the natural, idiomatic substitute: push() returns
 * immediately, and delivery happens via non-blocking I/O (fetch) on
 * however many microtask turns it takes, without ever blocking the
 * request that pushed it.
 *
 * The processing loop is started lazily, on first push, not at
 * construction/import time: mirroring the Ruby/Python clients rather
 * than assuming eager start is safe. Node's `cluster` module can fork
 * worker processes *after* the application (and this module) has
 * already loaded, the same hazard Puma/Gunicorn have for those clients;
 * starting fresh on first push means each forked worker gets its own
 * live loop regardless of when it was forked relative to import.
 */
export class DeliveryQueue {
  #configuration;
  #client;
  #deliverMethod;
  #label;
  #queue = [];
  #processing = false;
  #idleWaiters = [];

  /**
   * deliverMethod/label default to Client#deliver's own "event" shape, so every existing call
   * site (Reporter, and every test written against it) keeps working unchanged. Spans reuse this
   * same queue rather than a second, near-identical class (the shape gems/forge_ops_tracker's own
   * SpanQueue takes instead, since Ruby's DeliveryQueue has no such parameter to extend): only the
   * client method actually called, and the word used in a dropped/failed log line, ever differ
   * between an error event and a captured trace.
   * @param {{ deliverMethod?: string, label?: string }} [options]
   */
  constructor(configuration, client, { deliverMethod = "deliver", label = "event" } = {}) {
    this.#configuration = configuration;
    this.#client = client;
    this.#deliverMethod = deliverMethod;
    this.#label = label;
  }

  /** @param {Record<string, unknown>} payload */
  push(payload) {
    const maxSize = Math.max(1, this.#configuration.queueSize);
    if (this.#queue.length >= maxSize) {
      this.#configuration.log(`[forge-ops-tracker] delivery queue full, dropping ${this.#label}`);
      return false;
    }

    this.#queue.push(payload);
    this.#ensureProcessing();
    return true;
  }

  /**
   * Resolves once everything pushed so far has been handed to the client and the processing loop
   * has gone idle (including anything pushed while waiting). Never rejects; bounding how long a
   * caller waits is the caller's job (see flush() in index.js).
   * @returns {Promise<void>}
   */
  whenIdle() {
    if (!this.#processing && this.#queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #ensureProcessing() {
    if (this.#processing) {
      return;
    }
    this.#processing = true;
    // Deliberately not awaited: this is the background loop itself;
    // push() must return synchronously regardless of how long delivery
    // takes.
    this.#processLoop();
  }

  async #processLoop() {
    while (this.#queue.length > 0) {
      const payload = this.#queue.shift();
      try {
        // One attempt each, whatever the outcome: nothing is ever put back on the queue, so a
        // payload the server refuses is dropped here and never sent again.
        const status = await this.#client[this.#deliverMethod](payload);
        if (status === REJECTED) {
          this.#configuration.log(`[forge-ops-tracker] the server rejected the ${this.#label}, dropping it`);
        }
      } catch (e) {
        // Per-item, not wrapping the whole loop: one bad delivery must
        // not stop every event queued after it.
        this.#configuration.log(`[forge-ops-tracker] delivery worker error: ${e.name}: ${e.message}`);
      }
    }
    this.#processing = false;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}

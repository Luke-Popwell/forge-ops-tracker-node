import { DELIVERED, FAILED, MAX_FAILED_FLUSHES } from "./client.js";

/**
 * Counts requests and crashes in-process (see the Express/Fastify session-tracking
 * integrations) and periodically flushes the totals as one small aggregate report, rather
 * than one network call per request. Ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/session_flusher.rb.
 *
 * setInterval(...).unref(), not a real background thread; Node is single-threaded, and
 * unref() specifically so an idle flush timer never holds a short script's process open on
 * its own, the same "never affect the host app just by being configured" principle
 * DeliveryQueue's own lazy start already follows.
 *
 * Deliberately does NOT hook SIGTERM/SIGINT to force a final flush the way Ruby's at_exit
 * does. Considered and rejected: registering a listener for either signal overrides Node's
 * own default disposition (the process no longer exits on its own; something has to call
 * process.exit() explicitly), which risks racing with, or outright cutting off, a host app's
 * own graceful shutdown (draining in-flight requests, closing a database pool) if this
 * tracker's own listener calls exit() first. That's a real correctness risk to the host app
 * itself, not just a data-completeness one, and this SDK's whole design already treats "never
 * affect the host app" as non-negotiable everywhere else (Client#deliver never throws,
 * DeliveryQueue drops rather than blocks when full). The accepted trade-off instead: up to one
 * sessionFlushIntervalMs window of session data can be lost on a hard process exit, the same
 * way it would be if the interval simply hadn't ticked yet: a bounded, honest gap, not a
 * behavior change for whatever app this is installed into.
 */
export class SessionFlusher {
  #configuration;
  #client;
  #sessionsCount = 0;
  #crashedSessionsCount = 0;
  #periodStartedAt = new Date();
  #timer = null;
  #failedFlushes = 0;

  constructor(configuration, client) {
    this.#configuration = configuration;
    this.#client = client;
  }

  /** @param {boolean} crashed */
  recordSession(crashed) {
    this.#ensureTimerStarted();
    this.#sessionsCount += 1;
    if (crashed) {
      this.#crashedSessionsCount += 1;
    }
  }

  /**
   * Snapshots and resets the in-process counters, then delivers them. A failed delivery keeps
   * the counts where they are rather than resetting, so the next flush's window just grows
   * instead of losing what was already tallied; there's no other copy of this data anywhere.
   * That holds for MAX_FAILED_FLUSHES flushes in a row; the last of them drops the counts instead.
   * Counts the server rejects (see client.js) are dropped at once: they would be refused again
   * every time.
   */
  async flush() {
    if (this.#sessionsCount === 0) {
      return;
    }

    const snapshot = {
      release: this.#configuration.release,
      environment: this.#configuration.environment,
      period_started_at: this.#periodStartedAt.toISOString(),
      period_ended_at: new Date().toISOString(),
      sessions_count: this.#sessionsCount,
      crashed_sessions_count: this.#crashedSessionsCount,
    };

    const status = await this.#client.deliverSessionCheckin(snapshot);
    if (status === FAILED) {
      this.#failedFlushes += 1;
      if (this.#failedFlushes < MAX_FAILED_FLUSHES) {
        return;
      }
    }
    this.#failedFlushes = 0;
    if (status !== DELIVERED) {
      const reason = status === FAILED ? `${MAX_FAILED_FLUSHES} flushes in a row failed` : "the server rejected them";
      this.#configuration.log(`[forge-ops-tracker] dropping ${snapshot.sessions_count} session count(s): ${reason}`);
    }

    this.#sessionsCount = 0;
    this.#crashedSessionsCount = 0;
    this.#periodStartedAt = new Date();
  }

  #ensureTimerStarted() {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      this.flush().catch((e) => {
        // Per-tick, not left to reject silently: one bad flush must not kill every flush
        // after it (setInterval keeps calling this callback regardless either way, but a
        // silently swallowed rejection would still be worth logging).
        this.#configuration.log(`[forge-ops-tracker] session flush error: ${e.name}: ${e.message}`);
      });
    }, this.#configuration.sessionFlushIntervalMs);
    this.#timer.unref();
  }
}

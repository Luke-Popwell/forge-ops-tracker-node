/**
 * A bounded, in-order trail of whatever happened recently in this request: the controller/route
 * lifecycle, plus anything added by hand via addBreadcrumb() in index.js, recorded automatically
 * once a breadcrumb-context middleware/hook (see integrations/breadcrumbContext.js) gives the
 * request its own buffer to accumulate into. Ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/breadcrumb_buffer.rb: the same ring buffer contract
 * (capped at Configuration#maxBreadcrumbs, oldest entry dropped once full), but scoped per request
 * via AsyncLocalStorage rather than Ruby's Thread.current or Python's contextvars.ContextVar; see
 * index.js's own breadcrumbStorage comment for why that's the correct mechanism here.
 */
export class BreadcrumbBuffer {
  #configuration;
  #entries = [];

  constructor(configuration) {
    this.#configuration = configuration;
  }

  /**
   * @param {string} message
   * @param {{ category?: string, level?: string, data?: Record<string, unknown> }} [options]
   */
  add(message, { category = "custom", level = "info", data = {} } = {}) {
    // Read fresh on every add, not captured once at construction: the same reasoning
    // DeliveryQueue re-reads Configuration#queueSize on every push(), so a config change from
    // init() takes effect on whatever's added next, not just on a buffer created earlier.
    const maxSize = Math.max(this.#configuration.maxBreadcrumbs, 0);
    if (maxSize === 0) {
      return;
    }

    this.#entries.push({
      category: String(category),
      message: String(message),
      level: String(level),
      timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      data: data ?? {},
    });
    while (this.#entries.length > maxSize) {
      this.#entries.shift();
    }
  }

  /** @returns {Array<Record<string, unknown>>} a copy, never the internal array itself */
  all() {
    return [...this.#entries];
  }
}

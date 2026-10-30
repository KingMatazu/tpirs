/**
 * Load-harness primitives (Phase 10, Step 3 / ADR 0041).
 *
 * A fixed-rate driver with a bounded concurrency pool, percentile maths, and
 * budget comparison. Deliberately dependency-free: `undici` ships with Node, and
 * the arithmetic is small enough to read.
 */

/** Nearest-rank percentile over a sorted copy; 0 for an empty sample. */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

export function summarise({ latencies, statuses, errors, durationMs }) {
  const total = latencies.length + errors.length;
  return {
    requests: total,
    ok: latencies.length,
    failed: errors.length,
    rps: durationMs === 0 ? 0 : (total / durationMs) * 1000,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.length === 0 ? 0 : Math.max(...latencies),
    statuses,
    errors: errors.slice(0, 5),
  };
}

/**
 * Drives `send` at `rate` requests per second for `durationMs`, with at most
 * `concurrency` requests in flight. A slow server therefore lowers throughput
 * instead of growing an unbounded queue — the same back-pressure a real client
 * pool has.
 */
export async function runFixedRate({ rate, durationMs, concurrency, send }) {
  const latencies = [];
  const statuses = new Map();
  const errors = [];
  const startedAt = Date.now();
  const total = Math.max(1, Math.floor((rate * durationMs) / 1000));
  const pending = new Set();
  let inFlight = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const fire = (requestStartedAt) => {
    inFlight += 1;
    const task = send()
      .then((status) => {
        latencies.push(Date.now() - requestStartedAt);
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
      })
      .catch((error) => {
        errors.push(String(error));
      })
      .finally(() => {
        inFlight -= 1;
        pending.delete(task);
      });
    pending.add(task);
  };

  for (let index = 0; index < total; index += 1) {
    const dueAt = startedAt + (index * 1000) / rate;
    const wait = dueAt - Date.now();
    if (wait > 0) await sleep(wait);
    // Back-pressure: a slow server lowers throughput instead of growing an
    // unbounded queue, which is what a real client pool does.
    while (inFlight >= concurrency) await sleep(1);
    fire(Date.now());
  }

  await Promise.all([...pending]);

  return {
    latencies,
    statuses: Object.fromEntries([...statuses.entries()].sort((a, b) => a[0] - b[0])),
    errors,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Compares a summary against a budget from docs/performance-budgets.md.
 * Returns human-readable breaches; empty means the run passed.
 */
export function compareToBudget(summary, budget) {
  const breaches = [];
  if (summary.p95 > budget.p95) {
    breaches.push(`p95 ${summary.p95.toFixed(0)} ms > ${String(budget.p95)} ms`);
  }
  if (summary.p99 > budget.p99) {
    breaches.push(`p99 ${summary.p99.toFixed(0)} ms > ${String(budget.p99)} ms`);
  }
  const serverErrors = Object.entries(summary.statuses)
    .filter(([status]) => Number(status) >= 500)
    .reduce((sum, [, count]) => sum + count, 0);
  const errorRate = summary.requests === 0 ? 0 : serverErrors / summary.requests;
  if (errorRate > budget.maxErrorRate) {
    breaches.push(
      `5xx rate ${(errorRate * 100).toFixed(2)}% > ${(budget.maxErrorRate * 100).toFixed(2)}%`,
    );
  }
  if (summary.failed > 0) {
    breaches.push(
      `${String(summary.failed)} transport errors (first: ${summary.errors[0] ?? "?"})`,
    );
  }
  return breaches;
}

/** Renders a summary as a fixed-width table row block for the console. */
export function formatSummary(name, summary) {
  return [
    `${name}`,
    `  requests   ${String(summary.requests)} (${summary.rps.toFixed(1)} rps, ${String(summary.failed)} transport errors)`,
    `  statuses   ${JSON.stringify(summary.statuses)}`,
    `  latency    p50 ${summary.p50.toFixed(0)} ms · p95 ${summary.p95.toFixed(0)} ms · p99 ${summary.p99.toFixed(0)} ms · max ${summary.max.toFixed(0)} ms`,
  ].join("\n");
}

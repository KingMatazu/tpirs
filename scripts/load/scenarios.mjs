/**
 * Load scenarios (Phase 10, Step 3). Each entry knows how to build one request
 * and which budget from docs/performance-budgets.md it must meet.
 *
 * The webhook scenario is deliberately absent: it needs a provisioned endpoint
 * token (stored only as a hash) and a provider-signed body, so it lands with the
 * CI wiring in Step 11 rather than pretending a synthetic unsigned POST proves
 * anything about intake.
 */

/** @typedef {{ p95: number, p99: number, maxErrorRate: number }} Budget */

/**
 * @typedef {{
 *   name: string,
 *   budget: Budget,
 *   defaultRate: number,
 *   needsAuth?: boolean,
 *   needsVerifyToken?: boolean,
 *   request: (ctx: { baseUrl: string, token?: string, verifyToken?: string, random: () => number }) => Promise<Response>,
 * }} Scenario
 */

/** @type {Record<string, Scenario>} */
export const SCENARIOS = {
  health: {
    name: "GET /v1/health",
    budget: { p95: 50, p99: 150, maxErrorRate: 0.001 },
    defaultRate: 200,
    request: async ({ baseUrl }) => fetch(`${baseUrl}/v1/health`),
  },

  verify: {
    name: "GET /v1/verify/:token",
    budget: { p95: 150, p99: 400, maxErrorRate: 0.001 },
    defaultRate: 200,
    needsVerifyToken: true,
    // The same valid token every time: the point is the lookup path, and a
    // forged token would exercise only the 404 branch.
    request: async ({ baseUrl, verifyToken }) =>
      fetch(`${baseUrl}/v1/verify/${encodeURIComponent(verifyToken ?? "")}`),
  },

  payments: {
    name: "GET /v1/payments",
    budget: { p95: 400, p99: 1000, maxErrorRate: 0.001 },
    defaultRate: 20,
    needsAuth: true,
    // The finance list needs a finance permission; the demo finance user is beta.
    auth: { tenant: "beta-state", username: "beta.finance", password: "beta-finance-password" },
    request: async ({ baseUrl, token }) =>
      fetch(`${baseUrl}/v1/payments?limit=50`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      }),
  },

  sync: {
    name: "GET /v1/sync/paid?since=",
    budget: { p95: 800, p99: 2000, maxErrorRate: 0.001 },
    defaultRate: 10,
    needsAuth: true,
    // The paid-set feed is an officer read; the demo collector holds asset:read.
    auth: {
      tenant: "alpha-state",
      username: "alpha.collector",
      password: "alpha-collector-password",
    },
    request: async ({ baseUrl, token }) =>
      fetch(`${baseUrl}/v1/sync/paid?since=1970-01-01`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      }),
  },
};

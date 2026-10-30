/**
 * Load scenarios (Phase 10, Step 3). Each entry knows how to build one request
 * and which budget from docs/performance-budgets.md it must meet.
 *
 * The webhook scenario signs a Paystack payload with the adapter's test secret
 * and posts it to a provisioned endpoint token, so it exercises the real intake
 * path: signature verification, dedupe, attribution and suspense. Ten per cent
 * of the requests replay an earlier event id, which is the property most likely
 * to regress under concurrency (ADR 0041).
 */

import { createHmac } from "node:crypto";

/**
 * Paystack signs the raw body with HMAC-SHA512. The adapter ships a test secret
 * for exactly this purpose; a real deployment reads its own from secrets.
 */
const PAYSTACK_TEST_SECRET = "paystack-test-secret";

function signedPayload(eventId, reference) {
  const body = JSON.stringify({
    event: "charge.success",
    data: {
      id: eventId,
      reference,
      amount: 20000,
      currency: "NGN",
      status: "success",
      paid_at: new Date().toISOString(),
    },
  });
  return { body, signature: createHmac("sha512", PAYSTACK_TEST_SECRET).update(body).digest("hex") };
}

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

  webhooks: {
    name: "POST /webhooks/paystack/:token",
    budget: { p95: 300, p99: 800, maxErrorRate: 0.001 },
    defaultRate: 50,
    needsWebhookToken: true,
    request: async ({ baseUrl, webhookToken, random }) => {
      // Every tenth request replays a fixed event id; the rest are new payments.
      const replayed = random() < 0.1;
      const eventId = replayed ? 1 : Math.floor(random() * 1e9);
      const { body, signature } = signedPayload(eventId, `load-${String(eventId)}`);
      return fetch(`${baseUrl}/webhooks/paystack/${encodeURIComponent(webhookToken ?? "")}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-paystack-signature": signature },
        body,
      });
    },
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

#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { compareToBudget, formatSummary, runFixedRate, summarise } from "./lib.mjs";
import { SCENARIOS } from "./scenarios.mjs";

/**
 * Load runner (Phase 10, Step 3 / ADR 0041).
 *
 *   node scripts/load/run.mjs --scenario verify --rate 200 --duration 30
 *
 * Signs in for a bearer when the scenario needs one, reads the verify token from
 * `--verify-token` (minted by scripts/load/seed.mjs), prints a summary and exits
 * non-zero when a budget from docs/performance-budgets.md is breached.
 */

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const scenarioKey = arg("scenario", "verify");
const scenario = SCENARIOS[scenarioKey];
if (scenario === undefined) {
  process.stderr.write(
    `unknown scenario "${scenarioKey}" (known: ${Object.keys(SCENARIOS).join(", ")})\n`,
  );
  process.exit(2);
}

const baseUrl = arg("base-url", process.env.LOAD_BASE_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const rate = Number(arg("rate", String(scenario.defaultRate)));
const durationSeconds = Number(arg("duration", "30"));
const concurrency = Number(arg("concurrency", "50"));
const jsonOut = arg("json", undefined);

async function login() {
  if (scenario.needsAuth !== true) return undefined;
  const tenantSlug = process.env.LOAD_TENANT ?? scenario.auth?.tenant ?? "alpha-state";
  const username = process.env.LOAD_USER ?? scenario.auth?.username ?? "alpha.admin";
  const password = process.env.LOAD_PASSWORD ?? scenario.auth?.password ?? "alpha-admin-password";
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantSlug, username, password }),
  });
  if (!response.ok) {
    throw new Error(`login failed with ${String(response.status)}`);
  }
  const body = await response.json();
  if (typeof body.token !== "string") throw new Error("login returned no token");
  return body.token;
}

async function main() {
  const token = await login();
  const verifyToken = arg("verify-token", process.env.LOAD_VERIFY_TOKEN);
  if (scenario.needsVerifyToken === true && (verifyToken === undefined || verifyToken === "")) {
    throw new Error("this scenario needs --verify-token (run scripts/load/seed.mjs first)");
  }

  process.stdout.write(
    `load: ${scenario.name} · ${String(rate)} rps · ${String(durationSeconds)}s · ${baseUrl}\n`,
  );

  const raw = await runFixedRate({
    rate,
    durationMs: durationSeconds * 1000,
    concurrency,
    send: async () => {
      const response = await scenario.request({ baseUrl, token, verifyToken });
      // Drain the body so the connection can be reused.
      await response.arrayBuffer();
      return response.status;
    },
  });

  const summary = summarise(raw);
  process.stdout.write(`${formatSummary(scenario.name, summary)}\n`);

  const breaches = compareToBudget(summary, scenario.budget);
  const report = {
    scenario: scenarioKey,
    rate,
    durationSeconds,
    baseUrl,
    budget: scenario.budget,
    summary,
    breaches,
    passed: breaches.length === 0,
  };
  if (jsonOut !== undefined) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

  if (breaches.length > 0) {
    process.stderr.write(`load: BUDGET BREACHED\n`);
    for (const breach of breaches) process.stderr.write(`  - ${breach}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("load: within budget\n");
}

main().catch((error) => {
  process.stderr.write(`load: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

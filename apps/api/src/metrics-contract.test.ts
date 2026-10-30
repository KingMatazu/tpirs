import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Alert rules may only reference metrics the code actually emits (Phase 10,
 * Step 10). The contract lives in `infra/alerts/metric-contract.json`; this test
 * reads the Prometheus rules and fails when a name or a label drifts — a rename
 * should break the build, not the pager.
 *
 * PromQL functions, aggregations and keywords are allowlisted explicitly, so a
 * new construct has to be added here deliberately rather than silently passing.
 */

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const contractPath = path.join(repoRoot, "infra/alerts/metric-contract.json");
const rulesPath = path.join(repoRoot, "infra/alerts/tpirs.rules.yml");

interface ContractMetric {
  readonly name: string;
  readonly type: "counter" | "gauge" | "histogram";
  readonly labels: readonly string[];
}

const contract = JSON.parse(readFileSync(contractPath, "utf8")) as { metrics: ContractMetric[] };
const rules = readFileSync(rulesPath, "utf8");

/** PromQL functions, aggregators, keywords and label names we use on purpose. */
const ALLOWED_TOKENS = new Set([
  "sum",
  "max",
  "min",
  "avg",
  "by",
  "without",
  "rate",
  "increase",
  "histogram_quantile",
  "clamp_min",
  "time",
  "absent",
  "and",
  "or",
  "unless",
  "le",
  "job",
  "instance",
  "severity",
  "summary",
  "runbook",
  "expr",
  "alert",
  "for",
  "labels",
  "annotations",
  "groups",
  "name",
  "rules",
  "group",
]);

/**
 * Every `expr:` value, including YAML block scalars (`expr: |`), with comments
 * and quoted strings removed so only metric and label names remain.
 */
function expressions(): string[] {
  // A CRLF checkout leaves a trailing \r that `.` cannot match.
  const lines = rules.split(/\r?\n/);
  const found: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^(\s*)expr:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const indent = (match[1] ?? "").length;
    let value = match[2] ?? "";
    if (value === "|" || value === ">") {
      const parts: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next] ?? "";
        const candidateIndent = candidate.search(/\S/);
        if (candidate.trim() !== "" && candidateIndent <= indent) break;
        if (!candidate.trim().startsWith("#")) parts.push(candidate.trim());
      }
      value = parts.join(" ");
    }
    found.push(value.replace(/"[^"]*"/g, '""'));
  }
  return found;
}

/** Tokens that look like a metric or label reference inside the expressions. */
function referencedTokens(expr: string): string[] {
  // Prometheus duration literals (`5m`, `1h`) are not identifiers; drop them so
  // the unit letter is not mistaken for a metric.
  const withoutDurations = expr.replace(/\d+[smhdwy]\b/g, " ");
  return [...withoutDurations.matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*/g)].map((match) => match[0]);
}

describe("alert rule metric contract", () => {
  it("finds the rules (the parse must not silently return nothing)", () => {
    expect(expressions().length).toBeGreaterThanOrEqual(8);
    expect(contract.metrics.length).toBeGreaterThanOrEqual(6);
  });

  it("references only metrics and labels the contract declares", () => {
    const known = new Set(contract.metrics.map((metric) => metric.name));
    const knownLabels = new Set(contract.metrics.flatMap((metric) => metric.labels));
    const unknown = new Set<string>();

    for (const expr of expressions()) {
      for (const token of referencedTokens(expr)) {
        if (ALLOWED_TOKENS.has(token)) continue;
        if (known.has(token)) continue;
        if (knownLabels.has(token)) continue;
        // `_total` suffix and `_bucket`/`_sum`/`_count` histogram suffixes are
        // derived from the declared metric, not declared separately.
        const derived = token.replace(/_(bucket|sum|count)$/, "");
        if (known.has(derived)) continue;
        unknown.add(token);
      }
    }

    expect([...unknown].sort()).toEqual([]);
  });

  it("gives every alert a runbook section and a severity", () => {
    const alerts = [...rules.matchAll(/- alert: (\S+)/g)].map((match) => match[1]);
    expect(alerts.length).toBeGreaterThanOrEqual(8);

    const blocks = rules.split("- alert: ").slice(1);
    const missing: string[] = [];
    for (const block of blocks) {
      const name = block.split("\n")[0]?.trim() ?? "";
      if (!/severity:\s*(critical|warning)/.test(block)) missing.push(`${name}: severity`);
      if (!/runbook:\s*"docs\/runbooks\/alerting\.md#/.test(block))
        missing.push(`${name}: runbook`);
    }
    expect(missing).toEqual([]);
  });

  it("uses every metric the contract declares", () => {
    const text = expressions().join("\n");
    const unused = contract.metrics
      .filter((metric) => !text.includes(metric.name))
      .map((metric) => metric.name);
    expect(unused).toEqual([]);
  });
});

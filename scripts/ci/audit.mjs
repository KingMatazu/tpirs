#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Dependency-audit gate (Phase 10, Step 4).
 *
 * Policy:
 * - A critical or high advisory in a **production** dependency always fails the
 *   build. It cannot be allowlisted: an allowlist entry only silences dev-only
 *   findings, because a vulnerable package that ships to a state is a defect we
 *   fix, not a note we file.
 * - A critical or high advisory in a **dev-only** dependency fails unless it has
 *   a live allowlist entry. Test tooling never ships, but an unbounded exception
 *   would hide a real one, so entries expire.
 * - Moderate and low findings are reported and never fail the build.
 *
 * Input: `pnpm audit --json` on stdin. Allowlist: docs/security/audit-allowlist.json.
 */

const root = path.resolve(import.meta.dirname, "../..");
const allowlistPath = path.join(root, "docs/security/audit-allowlist.json");

function readAllowlist() {
  try {
    const parsed = JSON.parse(readFileSync(allowlistPath, "utf8"));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function findingIsProductionOnly(advisory) {
  const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
  return findings.some((finding) => finding.dev === false);
}

function describe(advisory) {
  const paths = (advisory.findings ?? [])
    .flatMap((finding) => (Array.isArray(finding.paths) ? finding.paths : []))
    .slice(0, 3);
  return `${advisory.severity.toUpperCase()} ${advisory.module_name}@${advisory.vulnerable_versions} (${advisory.id})${paths.length > 0 ? ` via ${paths.join(", ")}` : ""}`;
}

async function main() {
  const raw = await readStdin();
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    process.stderr.write("audit: could not parse `pnpm audit --json` output\n");
    return 2;
  }

  const advisories = Object.values(report.advisories ?? {});
  const today = new Date().toISOString().slice(0, 10);
  const allowlist = readAllowlist();
  const byId = new Map(allowlist.map((entry) => [String(entry.id), entry]));

  const failures = [];
  const notes = [];

  for (const advisory of advisories) {
    const severity = String(advisory.severity ?? "unknown");
    const blocking = severity === "critical" || severity === "high";
    const entry = byId.get(String(advisory.id));

    if (entry !== undefined && entry.expires < today) {
      failures.push(
        `expired allowlist entry for ${advisory.module_name} (${advisory.id}), expired ${entry.expires}`,
      );
    }

    if (!blocking) {
      notes.push(describe(advisory));
      continue;
    }

    if (findingIsProductionOnly(advisory)) {
      failures.push(
        `production ${describe(advisory)} — production advisories cannot be allowlisted`,
      );
      continue;
    }

    if (entry === undefined) {
      failures.push(
        `dev ${describe(advisory)} — add an allowlist entry with a reason and an expiry, or upgrade`,
      );
    }
  }

  // An allowlist entry whose advisory disappeared should be deleted, not kept as
  // folklore: it is the difference between a live exception and a stale excuse.
  for (const entry of allowlist) {
    const stillPresent = advisories.some((advisory) => String(advisory.id) === String(entry.id));
    if (!stillPresent) {
      notes.push(
        `allowlist entry ${entry.id} (${entry.package}) is no longer reported — remove it`,
      );
    }
  }

  if (notes.length > 0) {
    process.stdout.write("audit: non-blocking findings\n");
    for (const note of notes) process.stdout.write(`  - ${note}\n`);
  }

  if (failures.length > 0) {
    process.stderr.write("audit: FAILED\n");
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    return 1;
  }

  process.stdout.write(
    `audit: OK — no blocking advisories (${String(advisories.length)} total, ${String(allowlist.length)} allowlisted)\n`,
  );
  return 0;
}

process.exitCode = await main();

#!/usr/bin/env node
import { cpSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const compose = ["compose", "-f", "infra/docker-compose.yml"];

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** `docker compose ps` as rows; undefined when the command cannot be read yet. */
function services() {
  const result = spawnSync("docker", [...compose, "ps", "--all", "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    shell: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const rows = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      return undefined;
    }
  }
  return rows;
}

/**
 * Wait for the long-running services to be healthy and the bucket initialiser
 * to finish cleanly.
 *
 * `docker compose up -d --wait` is not used: it treats the one-shot
 * `object-store-init` container exiting 0 as a failure on some Compose
 * versions, which aborted setup after the stack was already healthy.
 */
function waitForStack(timeoutMs = 180_000) {
  const required = ["postgres", "redis", "object-store"];
  const deadline = Date.now() + timeoutMs;
  console.log("waiting for postgres, redis and object storage…");
  while (Date.now() < deadline) {
    const rows = services();
    if (rows !== undefined) {
      const healthy = required.every((name) => {
        const row = rows.find((candidate) => candidate.Service === name);
        if (row === undefined || row.State !== "running") return false;
        return row.Health === undefined || row.Health === "" || row.Health === "healthy";
      });
      const init = rows.find((candidate) => candidate.Service === "object-store-init");
      const initFinished = init !== undefined && init.State === "exited";
      if (initFinished && Number(init.ExitCode) !== 0) {
        throw new Error(
          `object-store-init exited with code ${String(init.ExitCode)}; the upload buckets were not created`,
        );
      }
      if (healthy && initFinished) return;
    }
    sleep(1_000);
  }
  throw new Error("Timed out waiting for the local infrastructure to become healthy");
}

if (!existsSync(path.join(root, ".env"))) {
  cpSync(path.join(root, ".env.example"), path.join(root, ".env"));
  console.log("Created .env from .env.example");
}

run("docker", [...compose, "up", "-d"]);
waitForStack();
run("pnpm", ["db:migrate"]);
run("pnpm", ["db:seed"]);

console.log("\nSetup complete. Start dev servers with: pnpm dev");

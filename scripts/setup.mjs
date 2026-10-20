#!/usr/bin/env node
import { cpSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(path.join(root, ".env"))) {
  cpSync(path.join(root, ".env.example"), path.join(root, ".env"));
  console.log("Created .env from .env.example");
}

run("docker", ["compose", "-f", "infra/docker-compose.yml", "up", "-d", "--wait"]);
run("pnpm", ["db:migrate"]);
run("pnpm", ["db:seed"]);

console.log("\nSetup complete. Start dev servers with: pnpm dev");

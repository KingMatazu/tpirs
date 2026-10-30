#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import path from "node:path";

/**
 * `pnpm dev` — starts the four dev servers in one terminal and stops all of
 * them on a single Ctrl+C.
 *
 * Why not `turbo run dev`: turbo 2.10+ forwards SIGINT to each task and waits
 * for it to exit. On Windows the task is `pnpm run dev`, i.e. a cmd.exe batch
 * job, and Ctrl+C makes cmd.exe ask "Terminate batch job (Y/N)?" — so the tasks
 * never exit, turbo keeps printing "4 tasks shutting down…", and a second
 * Ctrl+C is needed to force it. Spawning the tools directly (node + tsx/vite,
 * no shell, no package-manager shim) removes that layer: the children handle
 * SIGINT themselves, and this supervisor also kills their trees explicitly.
 *
 * `pnpm dev:turbo` still runs the turbo pipeline for anyone who wants it.
 */

const root = path.resolve(import.meta.dirname, "..");

/** Resolves a package's install directory from the workspace that declares it. */
function packageDir(fromPackageJson, name) {
  const from = createRequire(fromPackageJson);
  return path.dirname(from.resolve(`${name}/package.json`));
}

const tsxCli = path.join(packageDir(path.join(root, "package.json"), "tsx"), "dist", "cli.mjs");

const apps = [
  {
    name: "api",
    dir: path.join(root, "apps/api"),
    command: process.execPath,
    args: [tsxCli, "watch", "--env-file-if-exists=../../.env", "src/index.ts"],
  },
  {
    name: "worker",
    dir: path.join(root, "apps/worker"),
    command: process.execPath,
    args: [tsxCli, "watch", "--env-file-if-exists=../../.env", "src/index.ts"],
  },
  {
    name: "admin",
    dir: path.join(root, "apps/admin"),
    command: process.execPath,
    args: [
      path.join(packageDir(path.join(root, "apps/admin/package.json"), "vite"), "bin", "vite.js"),
    ],
  },
  {
    name: "field",
    dir: path.join(root, "apps/field"),
    command: process.execPath,
    args: [
      path.join(packageDir(path.join(root, "apps/field/package.json"), "vite"), "bin", "vite.js"),
    ],
  },
];

const colors = {
  api: "\u001b[36m",
  worker: "\u001b[35m",
  admin: "\u001b[32m",
  field: "\u001b[33m",
};
const reset = "\u001b[0m";

const children = new Map();
let stopping = false;

function prefixLines(name, stream) {
  const label = `${colors[name] ?? ""}${name.padEnd(6)}${reset} | `;
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => {
    process.stdout.write(`${label}${line}\n`);
  });
}

/** Kills a child and everything it spawned. */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // POSIX children are their own process group (detached), so the negative pid
  // reaches the whole tree — tsx watch's compiler child included.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function stopAll(code) {
  if (stopping) {
    process.exit(code);
  }
  stopping = true;
  if (children.size > 0) {
    process.stdout.write(`\nStopping ${String(children.size)} dev servers…\n`);
  }
  for (const child of children.values()) killTree(child);
  // Give the trees a moment to die before the supervisor exits.
  setTimeout(() => process.exit(code), 500).unref();
}

for (const app of apps) {
  const child = spawn(app.command, app.args, {
    cwd: app.dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1" },
    // On Windows the children stay in this console so Ctrl+C reaches them too;
    // elsewhere they get their own group so killTree can signal the tree.
    detached: process.platform !== "win32",
  });
  children.set(app.name, child);
  if (child.stdout !== null) prefixLines(app.name, child.stdout);
  if (child.stderr !== null) prefixLines(app.name, child.stderr);

  child.on("error", (error) => {
    process.stderr.write(`${app.name}: failed to start — ${error.message}\n`);
    stopAll(1);
  });

  child.on("exit", (code, signal) => {
    children.delete(app.name);
    if (stopping) return;
    // A Ctrl+C that reached the child before this process handled it is a
    // shutdown, not a crash: stop the rest quietly. Windows surfaces the same
    // event as exit code 0xC000013A (STATUS_CONTROL_C_EXIT).
    if (signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP" || code === 3221225786) {
      stopAll(0);
      return;
    }
    process.stderr.write(`${app.name}: exited (${signal ?? `code ${String(code)}`})\n`);
    stopAll(code === 0 ? 0 : 1);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    // First signal: graceful tree kill. A second one exits immediately.
    stopAll(0);
  });
}

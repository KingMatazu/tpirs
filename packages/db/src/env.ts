import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/** Load the repo-root .env into process.env when variables are not already set. */
export function loadRootEnv(rootDir: string): void {
  const envPath = path.join(rootDir, ".env");
  if (!existsSync(envPath)) return;
  const parsed = parseEnv(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

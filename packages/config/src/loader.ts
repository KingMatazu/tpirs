import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { TenantConfigError } from "./errors.js";
import type { TenantConfig } from "./schema.js";
import { validateTenantConfig } from "./validate.js";

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Parses YAML text into a validated TenantConfig. */
export function loadTenantConfigFromString(text: string): TenantConfig {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new TenantConfigError("parse_error", `Invalid YAML: ${toError(error).message}`, "", {
      cause: error,
    });
  }
  return validateTenantConfig(parsed);
}

/** Reads and validates a tenant config file from disk. */
export async function loadTenantConfig(filePath: string): Promise<TenantConfig> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new TenantConfigError("read_error", `Cannot read config '${filePath}': ${toError(error).message}`, "", {
      cause: error,
    });
  }
  return loadTenantConfigFromString(text);
}

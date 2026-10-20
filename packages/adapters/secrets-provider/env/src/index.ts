import { PortError } from "@tpirs/ports";
import type { SecretsProvider } from "@tpirs/ports";

export interface EnvSecretsOptions {
  /** Maps a secret ref (e.g. "payments/paystack/secret-key") to an env var name. */
  readonly mapping?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function defaultEnvName(ref: string): string {
  return `SECRET_${ref.replaceAll(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

/**
 * Reads secrets from process.env. Refs that are not explicitly mapped fall back
 * to an uppercased, underscore-normalised variable name (e.g. `SECRET_...`).
 */
export function createEnvSecretsProvider(options: EnvSecretsOptions = {}): SecretsProvider {
  const env = options.env ?? process.env;
  const mapping = options.mapping ?? {};

  return {
    getSecret(ref: string): Promise<string> {
      const envName = mapping[ref] ?? defaultEnvName(ref);
      const value = env[envName];
      if (value === undefined || value === "") {
        return Promise.reject(
          new PortError(
            "SecretsProvider",
            "not_found",
            `Secret "${ref}" (env ${envName}) is not set`,
          ),
        );
      }
      return Promise.resolve(value);
    },
  };
}

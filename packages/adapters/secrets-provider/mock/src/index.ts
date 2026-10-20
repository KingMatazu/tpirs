import { PortError } from "@tpirs/ports";
import type { SecretsProvider } from "@tpirs/ports";
import { conformanceFixtures } from "@tpirs/contracts";

export interface MockSecretsProvider extends SecretsProvider {
  setSecret(ref: string, value: string): void;
  /** All known references (test inspection). */
  refs(): readonly string[];
}

export function createMockSecretsProvider(
  initial: Readonly<Record<string, string>> = {
    [conformanceFixtures.secretRef]: conformanceFixtures.secretValue,
  },
): MockSecretsProvider {
  const secrets = new Map(Object.entries(initial));

  return {
    getSecret(ref) {
      const value = secrets.get(ref);
      if (value === undefined) {
        return Promise.reject(
          new PortError("SecretsProvider", "not_found", `Secret "${ref}" was not found`),
        );
      }
      return Promise.resolve(value);
    },
    setSecret(ref, value) {
      secrets.set(ref, value);
    },
    refs() {
      return [...secrets.keys()];
    },
  };
}

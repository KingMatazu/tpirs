import type { ObjectStorage, Telemetry, IdentityProvider } from "@tpirs/ports";
import type { AnyDb } from "@tpirs/db";

export interface AppConfig {
  readonly nodeEnv: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly deploymentRegion: string;
  readonly databaseUrl: string;
}

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly telemetry: Telemetry;
  /** Injected so routes use the port, never the environment directly. */
  readonly objectStorage?: ObjectStorage;
  /** Staff authentication port; required for auth routes. */
  readonly identity?: IdentityProvider;
  /** Database handle for authenticated queries and the audit log. */
  readonly db?: AnyDb;
  /** Optional readiness probe (e.g. database ping). Resolves true when ready. */
  readonly readiness?: () => Promise<boolean>;
}

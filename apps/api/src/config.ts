import type { ObjectStorage, Telemetry } from "@tpirs/ports";

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
  /** Optional readiness probe (e.g. database ping). Resolves true when ready. */
  readonly readiness?: () => Promise<boolean>;
}

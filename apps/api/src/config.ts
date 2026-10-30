import type { ObjectStorage, Telemetry, IdentityProvider } from "@tpirs/ports";
import type { TenantConfig } from "@tpirs/config";
import type { AnyDb } from "@tpirs/db";
import type { Services } from "./services.js";

export interface AppConfig {
  readonly nodeEnv: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly deploymentRegion: string;
  readonly databaseUrl: string;
  /** Exposes `GET /metrics` when true (ADR 0042); 404 otherwise. */
  readonly metricsEnabled: boolean;
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
  /** Application services (asset, owner, otp); enables registry routes. */
  readonly services?: Services;
  /** Loads a validated tenant config; enables tenant-driven route behaviour. */
  readonly loadConfig?: (tenantId: string) => Promise<TenantConfig | undefined>;
  /** Optional readiness probe (e.g. database ping). Resolves true when ready. */
  readonly readiness?: () => Promise<boolean>;
  /**
   * Abuse control for the unauthenticated auth routes (ADR 0046). Compositions
   * without services (some tests) may omit it; the running API always supplies
   * the same limiter the rest of the routes use.
   */
  readonly rateLimiter?: import("@tpirs/application").RateLimiter;
  /**
   * Prometheus exposition sink (ADR 0042). Present only when the process built
   * one; the route still needs `config.metricsEnabled` to answer.
   */
  readonly metrics?: { render(): string };
}

import type { ObjectStorage, Telemetry, IdentityProvider } from "@tpirs/ports";
import type { FastifyInstance } from "fastify";
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
  /**
   * Browser origins allowed to call the API (ADR 0052). Empty/absent keeps the
   * same-origin assumption: no CORS headers, no preflight. A hosted deployment
   * with frontends on another origin lists them here.
   */
  readonly corsOrigins?: readonly string[];
  /**
   * `SameSite` on the refresh cookie. `strict` for same-origin deployments;
   * `none` (with `Secure`) when the frontend is on a different site, otherwise
   * the browser never stores or sends the cookie.
   */
  readonly refreshCookieSameSite?: "strict" | "lax" | "none";
  /**
   * Shared secret required by `POST /v1/setup/tenant` when first-run setup is
   * reachable from the internet. In production an unset token disables setup
   * instead of leaving the tenant-creation window open.
   */
  readonly setupToken?: string;
  /** Trust `X-Forwarded-For` (Vercel, Railway, any reverse proxy). */
  readonly trustProxy?: boolean;
  /**
   * Development affordances, currently the collector wallet top-up simulator
   * (`POST /v1/dev/collector-topup`). Always on outside production; a hosted
   * deployment opts in with `DEV_TOOLS_ENABLED=true`. It mints float, so it must
   * never be on for a live-money deployment.
   */
  readonly devTools?: boolean;
}

export interface BuildAppOptions {
  readonly config: AppConfig;
  /**
   * A pre-created Fastify server. The process entrypoint builds it so Vercel's
   * Fastify detector sees `fastify` imported by the entrypoint; tests omit it
   * and `buildApp` creates one with the same options.
   */
  readonly fastify?: FastifyInstance;
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

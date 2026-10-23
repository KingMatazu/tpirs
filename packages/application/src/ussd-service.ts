import { advanceUssdSession } from "@tpirs/domain";
import type { UssdAction } from "@tpirs/domain";
import type { TenantConfig } from "@tpirs/config";
import { CHANNEL_MESSAGE_KEYS, DRIVER_ASSET_INPUT_KEY } from "@tpirs/config";
import { hashToken } from "@tpirs/crypto";
import type {
  Cache,
  LockService,
  Telemetry,
  UssdProvider,
  UssdRenderedResponse,
} from "@tpirs/ports";
import type { ChannelRenderer } from "./channel-renderer.js";
import { createChannelRenderer } from "./channel-renderer.js";
import type { DriverChannelService } from "./driver-channel-service.js";
import type { RateLimiter } from "./rate-limiter.js";

/**
 * A defensive ceiling on the cumulative text a provider may send. The step
 * limit already rejects a session with too many segments, but a single huge
 * segment would still be hashed and cached, so the transport drops it first.
 */
export const MAX_USSD_TEXT_LENGTH = 2048;

/** Everything the HTTP layer knows about one provider callback. */
export interface UssdCallbackContext {
  readonly tenantId: string;
  readonly config: TenantConfig;
  readonly provider: UssdProvider;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  /** Source address of the provider callback, when the HTTP layer can see it. */
  readonly clientIp?: string;
}

export interface UssdService {
  handle(context: UssdCallbackContext): Promise<UssdRenderedResponse>;
}

export interface UssdServiceDeps {
  readonly cache: Cache;
  readonly locks: LockService;
  readonly driver: DriverChannelService;
  readonly rateLimiter: RateLimiter;
  readonly telemetry?: Telemetry;
}

export class UssdServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UssdServiceError";
  }
}

function isRenderedResponse(value: unknown): value is UssdRenderedResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["statusCode"] === "number" &&
    typeof candidate["contentType"] === "string" &&
    typeof candidate["body"] === "string"
  );
}

/**
 * Drives one USSD callback through parse, cache, rate limit, the pure session
 * engine, and an optional driver action.
 *
 * Providers replay the *cumulative* text on every request and may retry a
 * callback they think failed. Two mechanisms make that safe:
 *
 * - the rendered response is cached under tenant + provider + session + hash of
 *   the cumulative text, so a retry returns exactly what the driver already
 *   saw instead of re-running an action;
 * - an action runs under a per-session lock, so two concurrent callbacks for
 *   the same session cannot both spend wallet credit.
 *
 * Rate limiting happens after the cache lookup: a genuine provider retry is
 * idempotent and should not consume the driver's quota, while a caller sending
 * new cumulative text on every request still hits the limit.
 */
export function createUssdService(deps: UssdServiceDeps): UssdService {
  const renderers = new WeakMap<TenantConfig, ChannelRenderer>();

  function rendererFor(config: TenantConfig): ChannelRenderer {
    const existing = renderers.get(config);
    if (existing !== undefined) return existing;
    const created = createChannelRenderer(config, {
      ...(deps.telemetry === undefined ? {} : { telemetry: deps.telemetry }),
    });
    renderers.set(config, created);
    return created;
  }

  async function handle(context: UssdCallbackContext): Promise<UssdRenderedResponse> {
    const settings = context.config.channels.ussd;
    if (settings === undefined) {
      throw new UssdServiceError("Tenant configuration has no USSD settings");
    }
    const renderer = rendererFor(context.config);
    const request = context.provider.parseCallback({
      body: context.body,
      ...(context.headers === undefined ? {} : { headers: context.headers }),
    });
    const capabilities = context.provider.capabilities();

    function end(key: string, vars?: Readonly<Record<string, string | number>>) {
      return context.provider.renderResponse({
        type: "end",
        message: renderer.fit(renderer.safeText(key, vars), capabilities.maxResponseLength),
      });
    }

    const cacheKey = `ussd:response:${context.tenantId}:${context.provider.name}:${hashToken(
      `${request.sessionId}\u0000${request.text}`,
    )}`;
    const ttlSeconds = settings.sessionTimeoutSeconds;
    const cached = await deps.cache.get(cacheKey);
    if (isRenderedResponse(cached)) {
      deps.telemetry?.counter("ussd.callback", 1, { outcome: "replayed" });
      return cached;
    }

    if (request.text.length > MAX_USSD_TEXT_LENGTH) {
      const response = end(CHANNEL_MESSAGE_KEYS.tooManySteps);
      deps.telemetry?.counter("ussd.callback", 1, { outcome: "too_long" });
      await deps.cache.set(cacheKey, response, ttlSeconds);
      return response;
    }

    const msisdn = await deps.rateLimiter.consume(
      `ussd:msisdn:${context.tenantId}:${request.from}`,
      { limit: settings.rateLimit.perMsisdnPerMinute, windowSeconds: 60 },
    );
    let limited = !msisdn.allowed;
    if (!limited && context.clientIp !== undefined && context.clientIp !== "") {
      const ip = await deps.rateLimiter.consume(`ussd:ip:${context.tenantId}:${context.clientIp}`, {
        limit: settings.rateLimit.perIpPerMinute,
        windowSeconds: 60,
      });
      limited = !ip.allowed;
    }
    if (limited) {
      const response = end(CHANNEL_MESSAGE_KEYS.rateLimited);
      deps.telemetry?.counter("ussd.callback", 1, { outcome: "rate_limited" });
      await deps.cache.set(cacheKey, response, ttlSeconds);
      return response;
    }

    const step = advanceUssdSession({
      menus: context.config.channels.menus,
      startMenu: context.config.channels.startMenu ?? "",
      text: request.text,
      maxSteps: settings.maxSteps,
      maxInputLength: settings.maxInputLength,
    });

    let response: UssdRenderedResponse;
    if (step.kind === "prompt") {
      response = context.provider.renderResponse({
        type: "continue",
        message: renderer.fit(
          renderer.prompt(step, context.config.channels.menus),
          capabilities.maxResponseLength,
        ),
      });
      deps.telemetry?.counter("ussd.callback", 1, { outcome: "prompt" });
    } else if (step.kind === "end") {
      const key =
        step.reason === "cancelled"
          ? CHANNEL_MESSAGE_KEYS.cancelled
          : step.reason === "too_many_steps"
            ? CHANNEL_MESSAGE_KEYS.tooManySteps
            : CHANNEL_MESSAGE_KEYS.error;
      response = end(key);
      deps.telemetry?.counter("ussd.callback", 1, { outcome: step.reason });
    } else {
      response = await runAction(context, renderer, step.action, step.collected);
    }

    await deps.cache.set(cacheKey, response, ttlSeconds);
    return response;
  }

  async function runAction(
    context: UssdCallbackContext,
    renderer: ChannelRenderer,
    action: UssdAction,
    collected: Readonly<Record<string, string>>,
  ): Promise<UssdRenderedResponse> {
    const settings = context.config.channels.ussd;
    if (settings === undefined) {
      throw new UssdServiceError("Tenant configuration has no USSD settings");
    }
    const capabilities = context.provider.capabilities();

    function end(key: string, vars?: Readonly<Record<string, string | number>>) {
      return context.provider.renderResponse({
        type: "end",
        message: renderer.fit(renderer.safeText(key, vars), capabilities.maxResponseLength),
      });
    }

    const assetRef = (collected[DRIVER_ASSET_INPUT_KEY] ?? "").trim();
    if (assetRef === "") {
      // The graph reached an action without collecting the reserved input key.
      // That is a configuration problem, so say so generically rather than
      // guessing which vehicle the driver meant.
      deps.telemetry?.log("error", "USSD action reached without an asset reference", {
        tenantId: context.tenantId,
        action,
      });
      return end(CHANNEL_MESSAGE_KEYS.error);
    }

    const lock = await deps.locks.acquire(
      `ussd:action:${context.tenantId}:${context.provider.name}:${hashToken(assetRef + action)}`,
      Math.max(30, settings.sessionTimeoutSeconds),
    );
    if (lock === undefined) {
      deps.telemetry?.counter("ussd.action", 1, { outcome: "busy" });
      return end(CHANNEL_MESSAGE_KEYS.sessionBusy);
    }

    try {
      const reply = await deps.driver.execute({
        tenantId: context.tenantId,
        assetRef,
        action,
      });
      deps.telemetry?.counter("ussd.action", 1, { outcome: reply.kind, action });
      return end(reply.messageKey, reply.variables);
    } catch (error) {
      deps.telemetry?.captureError(error, { stage: "ussd-action", tenantId: context.tenantId });
      deps.telemetry?.counter("ussd.action", 1, { outcome: "error", action });
      return end(CHANNEL_MESSAGE_KEYS.error);
    } finally {
      try {
        await deps.locks.release(lock);
      } catch (error) {
        deps.telemetry?.captureError(error, { stage: "ussd-unlock", tenantId: context.tenantId });
      }
    }
  }

  return { handle };
}

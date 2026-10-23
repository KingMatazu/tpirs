import type { TenantConfig } from "@tpirs/config";
import { CHANNEL_MESSAGE_KEYS } from "@tpirs/config";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { SmsProvider, Telemetry } from "@tpirs/ports";
import type { ChannelRenderer } from "./channel-renderer.js";
import { createChannelRenderer } from "./channel-renderer.js";
import type { DriverChannelService } from "./driver-channel-service.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { SmsCostGuard } from "./sms-cost-guard.js";

/** What happened to one inbound SMS callback. */
export type InboundSmsOutcome =
  "recorded" | "duplicate" | "rate_limited" | "ignored" | "budget_exhausted";

export interface InboundSmsResult {
  readonly outcome: InboundSmsOutcome;
  /** True only when a reply was added to the channel outbox. */
  readonly enqueued: boolean;
  readonly messageId?: string;
}

/** Everything the HTTP layer knows about one inbound SMS callback. */
export interface InboundSmsContext {
  readonly tenantId: string;
  readonly config: TenantConfig;
  readonly provider: SmsProvider;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

export interface InboundSmsService {
  handle(context: InboundSmsContext): Promise<InboundSmsResult>;
}

export interface InboundSmsServiceDeps {
  readonly db: AnyDb;
  readonly driver: DriverChannelService;
  readonly rateLimiter: RateLimiter;
  readonly costGuard: SmsCostGuard;
  readonly telemetry?: Telemetry;
}

/**
 * Handles a driver's inbound SMS command and queues one reply.
 *
 * The grammar is deliberately tiny and comes from tenant config: an SMS is
 * `<smsKeyword> <plate-or-short-code>`. Everything else gets the configured
 * help text, which is itself a message key, so a tenant can change both the
 * keyword and the wording without a code change.
 *
 * Delivery never happens here. The reply is written to the channel outbox in
 * the same operation that records the inbound message, and the worker sends it
 * later (ADR 0020). That keeps a slow gateway out of the provider's callback
 * window and makes the reply idempotent: the dedupe key is the inbound row id,
 * so a replayed callback cannot queue a second SMS.
 */
export function createInboundSmsService(deps: InboundSmsServiceDeps): InboundSmsService {
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

  async function handle(context: InboundSmsContext): Promise<InboundSmsResult> {
    const capabilities = context.provider.capabilities();
    if (!capabilities.supportsInbound || context.provider.parseInboundCallback === undefined) {
      deps.telemetry?.log("warn", "SMS provider cannot parse inbound callbacks", {
        tenantId: context.tenantId,
      });
      return { outcome: "ignored", enqueued: false };
    }

    const inbound = context.provider.parseInboundCallback({
      body: context.body,
      ...(context.headers === undefined ? {} : { headers: context.headers }),
    });
    const settings = context.config.channels.sms;

    if (settings !== undefined) {
      const limit = await deps.rateLimiter.consume(
        `sms:msisdn:${context.tenantId}:${inbound.from}`,
        { limit: settings.rateLimit.perMsisdnPerMinute, windowSeconds: 60 },
      );
      if (!limit.allowed) {
        deps.telemetry?.counter("sms.inbound", 1, { outcome: "rate_limited" });
        return { outcome: "rate_limited", enqueued: false };
      }
    }

    const recorded = await withTenant(deps.db, context.tenantId, async (tx) =>
      repositories(tx).channelMessages.recordInbound(context.tenantId, {
        channel: "sms",
        kind: "inbound",
        recipient: inbound.from,
        body: inbound.text,
        providerMessageId: inbound.providerMessageId,
        dedupeKey: `sms:inbound:${inbound.providerMessageId}`,
        receivedAt: inbound.receivedAt,
      }),
    );
    if (recorded === undefined) {
      deps.telemetry?.counter("sms.inbound", 1, { outcome: "duplicate" });
      return { outcome: "duplicate", enqueued: false };
    }

    const renderer = rendererFor(context.config);
    const command = parseCommand(inbound.text, context.config.channels.smsKeyword);
    let kind: "status" | "notice" = "notice";
    let body: string;
    if (command.assetRef === undefined) {
      body = renderer.safeText(CHANNEL_MESSAGE_KEYS.unknownSmsCommand, {
        keyword: context.config.channels.smsKeyword,
      });
    } else {
      kind = "status";
      const reply = await deps.driver.status({
        tenantId: context.tenantId,
        assetRef: command.assetRef,
      });
      body = renderer.safeText(reply.messageKey, reply.variables);
      deps.telemetry?.counter("sms.inbound", 1, { outcome: reply.kind });
    }

    const budget = await deps.costGuard.check({
      tenantId: context.tenantId,
      config: context.config,
      recipient: inbound.from,
    });
    if (budget !== "allowed") {
      // The inbound command is recorded either way: the driver's request is a
      // fact, even when the tenant has spent its reply budget. Operations can
      // see the unanswered row and decide what to do.
      deps.telemetry?.counter("sms.reply.suppressed", 1, { reason: budget });
      return { outcome: "budget_exhausted", enqueued: false, messageId: recorded.id };
    }

    const queued = await withTenant(deps.db, context.tenantId, async (tx) =>
      repositories(tx).channelMessages.enqueueOutbound(context.tenantId, {
        channel: "sms",
        kind,
        recipient: inbound.from,
        body,
        // One reply per inbound row, forever.
        dedupeKey: `sms:reply:${recorded.id}`,
        replyToId: recorded.id,
      }),
    );
    if (queued === undefined) {
      return { outcome: "duplicate", enqueued: false, messageId: recorded.id };
    }

    deps.telemetry?.counter("sms.reply.queued", 1, { kind });
    return { outcome: "recorded", enqueued: true, messageId: recorded.id };
  }

  return { handle };
}

export interface ParsedSmsCommand {
  /** The plate or short code, or undefined when the keyword was not used. */
  readonly assetRef?: string;
}

/**
 * Splits `<keyword> <reference>` from a driver's message.
 *
 * The keyword comparison is case-insensitive because the driver's phone may
 * capitalise it for them. Everything after the first token is the reference,
 * so a plate with a space survives.
 */
export function parseCommand(text: string, keyword: string): ParsedSmsCommand {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  const separator = trimmed.search(/\s/);
  const first = separator === -1 ? trimmed : trimmed.slice(0, separator);
  if (first.toUpperCase() !== keyword.trim().toUpperCase()) return {};
  const rest = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  return rest === "" ? {} : { assetRef: rest };
}

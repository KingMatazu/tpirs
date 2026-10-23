import type { TenantConfig, TenantProviderBinding } from "@tpirs/config";
import type { SecretsProvider, SmsProvider, UssdProvider } from "@tpirs/ports";
import {
  createAfricaSTalkingSmsProvider,
  createFetchHttpTransport,
} from "@tpirs/sms-provider-africastalking";
import type { HttpTransport } from "@tpirs/sms-provider-africastalking";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";
import { createTermiiSmsProvider } from "@tpirs/sms-provider-termii";
import { createAfricaSTalkingUssdProvider } from "@tpirs/ussd-provider-africastalking";
import { createMockUssdProvider } from "@tpirs/ussd-provider-mock";

/**
 * Tenant config chooses the adapter; the composition root turns that choice
 * into a live port instance.
 *
 * Both `apps/api` and `apps/worker` need the same mapping - the API answers
 * callbacks, the worker delivers queued replies - so the mapping lives in one
 * package rather than being copied into each composition root. Core packages
 * still know nothing about aggregator names: only this package and tenant
 * config do (ADR 0022).
 */

export interface TenantSmsBinding {
  /** The adapter key from tenant config; the webhook URL carries the same key. */
  readonly adapter: string;
  readonly provider: SmsProvider;
}

export interface TenantUssdBinding {
  readonly adapter: string;
  readonly provider: UssdProvider;
}

/** Only the channels the tenant actually configured are present. */
export interface TenantChannelAdapters {
  readonly sms?: TenantSmsBinding;
  readonly ussd?: TenantUssdBinding;
}

export interface ChannelProviderFactory {
  /**
   * Resolves (and caches per config object) the adapters enabled for a tenant.
   * A channel with no provider binding is simply absent, which callers must
   * treat as "this tenant does not use that channel" rather than a failure.
   */
  forTenant(config: TenantConfig): Promise<TenantChannelAdapters>;
}

export interface ChannelProviderFactoryDeps {
  readonly secrets: SecretsProvider;
  /** Real HTTP transport for aggregators; tests inject a recorded one. */
  readonly transport?: HttpTransport;
}

export class ChannelProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelProviderConfigError";
  }
}

function bindingFor(config: TenantConfig, port: string): TenantProviderBinding | undefined {
  return config.providers.find((binding) => binding.port === port);
}

async function readSettings(
  binding: TenantProviderBinding,
  secrets: SecretsProvider,
): Promise<Record<string, string>> {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(binding.options ?? {})) {
    settings[key] = String(value);
  }
  for (const [key, reference] of Object.entries(binding.secrets ?? {})) {
    settings[key] = await secrets.getSecret(reference);
  }
  return settings;
}

function required(
  settings: Readonly<Record<string, string>>,
  key: string,
  port: string,
  adapter: string,
): string {
  const value = settings[key];
  if (value === undefined || value.trim() === "") {
    throw new ChannelProviderConfigError(
      `${port} adapter "${adapter}" requires "${key}" in its options or secrets`,
    );
  }
  return value;
}

const TERMII_CHANNELS = new Set(["generic", "dnd", "whatsapp"]);

export function createChannelProviderFactory(
  deps: ChannelProviderFactoryDeps,
): ChannelProviderFactory {
  const transport = deps.transport ?? createFetchHttpTransport();
  const cache = new WeakMap<TenantConfig, Promise<TenantChannelAdapters>>();

  async function buildSms(
    config: TenantConfig,
    binding: TenantProviderBinding,
  ): Promise<TenantSmsBinding> {
    const adapter = binding.adapter;
    switch (adapter) {
      case "mock":
        return { adapter, provider: createMockSmsProvider() };
      case "africastalking": {
        const settings = await readSettings(binding, deps.secrets);
        return {
          adapter,
          provider: createAfricaSTalkingSmsProvider({
            username: required(settings, "username", "SmsProvider", adapter),
            apiKey: required(settings, "apiKey", "SmsProvider", adapter),
            transport,
            senderId: config.branding.smsSenderId,
          }),
        };
      }
      case "termii": {
        const settings = await readSettings(binding, deps.secrets);
        const channel = settings["channel"];
        if (channel !== undefined && !TERMII_CHANNELS.has(channel)) {
          throw new ChannelProviderConfigError(
            `SmsProvider adapter "termii" has unsupported channel "${channel}"`,
          );
        }
        return {
          adapter,
          provider: createTermiiSmsProvider({
            apiKey: required(settings, "apiKey", "SmsProvider", adapter),
            transport,
            senderId: config.branding.smsSenderId,
            ...(channel === undefined
              ? {}
              : { channel: channel as "generic" | "dnd" | "whatsapp" }),
          }),
        };
      }
      default:
        throw new ChannelProviderConfigError(`Unknown SmsProvider adapter "${adapter}"`);
    }
  }

  async function buildUssd(
    config: TenantConfig,
    binding: TenantProviderBinding,
  ): Promise<TenantUssdBinding> {
    const adapter = binding.adapter;
    switch (adapter) {
      case "mock":
        return { adapter, provider: createMockUssdProvider() };
      case "africastalking": {
        const settings = await readSettings(binding, deps.secrets);
        return {
          adapter,
          provider: createAfricaSTalkingUssdProvider({
            shortcode: settings["shortcode"] ?? config.channels.ussdCode,
          }),
        };
      }
      default:
        throw new ChannelProviderConfigError(`Unknown UssdProvider adapter "${adapter}"`);
    }
  }

  async function build(config: TenantConfig): Promise<TenantChannelAdapters> {
    const smsBinding = bindingFor(config, "SmsProvider");
    const ussdBinding = bindingFor(config, "UssdProvider");
    const [sms, ussd] = await Promise.all([
      smsBinding === undefined ? undefined : buildSms(config, smsBinding),
      ussdBinding === undefined ? undefined : buildUssd(config, ussdBinding),
    ]);
    return {
      ...(sms === undefined ? {} : { sms }),
      ...(ussd === undefined ? {} : { ussd }),
    };
  }

  return {
    forTenant(config) {
      const existing = cache.get(config);
      if (existing !== undefined) return existing;
      const created = build(config);
      cache.set(config, created);
      return created;
    },
  };
}

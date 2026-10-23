import { todayInTimeZone } from "@tpirs/domain";
import type { BusinessDate, UssdAction } from "@tpirs/domain";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb, PaymentInstructionRow } from "@tpirs/db";
import type { FeeEngine, PaymentProvider } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";
import type { TenantConfig } from "@tpirs/config";
import { CHANNEL_MESSAGE_KEYS, DRIVER_ASSET_INPUT_KEY } from "@tpirs/config";
import type { TenantConfigLoader } from "./asset-service.js";
import { ObligationService } from "./obligation-service.js";
import type { PeriodStatus } from "./obligation-service.js";
import { createPaymentService } from "./payment-service.js";
import type { PaymentService } from "./payment-service.js";
import { formatMinor } from "./receipt-renderer.js";

/**
 * Message keys the driver-channel service refers to. The text behind each key
 * lives in `channels.messages`, so changing a reply is configuration, not code.
 * The canonical names are defined by `@tpirs/config` because the same keys are
 * required by config validation; this alias keeps the application-level name
 * that existing callers use.
 */
export const DRIVER_MESSAGE_KEYS = CHANNEL_MESSAGE_KEYS;

export type DriverMessageKey = (typeof DRIVER_MESSAGE_KEYS)[keyof typeof DRIVER_MESSAGE_KEYS];

/** Reserved input key a USSD input step must collect before an action runs. */
export { DRIVER_ASSET_INPUT_KEY };

export class DriverChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverChannelError";
  }
}

export interface DriverChannelServiceDeps {
  readonly db: AnyDb;
  readonly loadConfig: TenantConfigLoader;
  readonly feeEngine: FeeEngine;
  /** Resolves a provider name to its adapter, as in the payment service. */
  readonly providerFor: (provider: string) => PaymentProvider | undefined;
  readonly now?: () => Date;
}

export interface DriverAssetInput {
  readonly tenantId: string;
  /** A plate number or a sticker short code, as typed by the driver. */
  readonly assetRef: string;
}

/** Where an asset stands for the current business day. */
export interface DriverStatusReply {
  readonly kind: "status";
  readonly assetId: string;
  readonly assetRef: string;
  readonly businessDate: BusinessDate;
  readonly status: PeriodStatus["status"];
  /** True for `paid` and `waived`; absence is never a debt. */
  readonly settled: boolean;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly messageKey: DriverMessageKey;
  readonly variables: Readonly<Record<string, string>>;
}

export interface DriverUnknownAssetReply {
  readonly kind: "unknown_asset";
  readonly assetRef: string;
  readonly messageKey: DriverMessageKey;
  readonly variables: Readonly<Record<string, string>>;
}

export interface DriverPaymentRequestReply {
  readonly kind: "payment_request";
  readonly assetId: string;
  readonly assetRef: string;
  readonly businessDate: BusinessDate;
  readonly provider: string;
  readonly instructionId: string | null;
  readonly reference: string;
  readonly attributionKind: Exclude<PaymentInstructionRow["kind"], null>;
  readonly amountMinor: bigint;
  readonly currency: string;
  /** True when a long-lived instruction was reused rather than a new intent issued. */
  readonly existingInstruction: boolean;
  readonly messageKey: DriverMessageKey;
  readonly variables: Readonly<Record<string, string>>;
}

export interface DriverAlreadyPaidReply {
  readonly kind: "already_paid";
  readonly assetId: string;
  readonly assetRef: string;
  readonly businessDate: BusinessDate;
  readonly messageKey: DriverMessageKey;
  readonly variables: Readonly<Record<string, string>>;
}

export interface DriverNothingRequiredReply {
  readonly kind: "nothing_required";
  readonly assetId: string;
  readonly assetRef: string;
  readonly businessDate: BusinessDate;
  readonly currency: string;
  readonly messageKey: DriverMessageKey;
  readonly variables: Readonly<Record<string, string>>;
}

export interface DriverPaidFromBalanceReply {
  readonly kind: "paid_from_balance";
  readonly assetId: string;
  readonly assetRef: string;
  readonly businessDate: BusinessDate;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly messageKey: DriverMessageKey;
  readonly variables: Readonly<Record<string, string>>;
}

export interface DriverInsufficientBalanceReply {
  readonly kind: "insufficient_balance";
  readonly assetId: string;
  readonly assetRef: string;
  readonly businessDate: BusinessDate;
  readonly shortfallMinor: bigint;
  readonly currency: string;
  readonly messageKey: DriverMessageKey;
  readonly variables: Readonly<Record<string, string>>;
}

export interface DriverPaymentFailedReply {
  readonly kind: "payment_failed";
  readonly assetId: string;
  readonly assetRef: string;
  readonly businessDate: BusinessDate;
  readonly provider: string;
  /** Provider-neutral diagnostic for logs and tests; never shown to the driver. */
  readonly reason: string;
  readonly messageKey: DriverMessageKey;
  readonly variables: Readonly<Record<string, string>>;
}

export type DriverChannelReply =
  | DriverStatusReply
  | DriverUnknownAssetReply
  | DriverPaymentRequestReply
  | DriverAlreadyPaidReply
  | DriverNothingRequiredReply
  | DriverPaidFromBalanceReply
  | DriverInsufficientBalanceReply
  | DriverPaymentFailedReply;

export interface DriverChannelService {
  /** Reports whether the current business day has a recorded payment. */
  status(input: DriverAssetInput): Promise<DriverChannelReply>;
  /** Issues an intent, or returns the asset's long-lived instruction. */
  pay(input: DriverAssetInput): Promise<DriverChannelReply>;
  /** Spends wallet credit on the current business day when it covers the fee. */
  payFromBalance(input: DriverAssetInput): Promise<DriverChannelReply>;
  /** Dispatches an action from the pure USSD engine. */
  execute(input: DriverAssetInput & { readonly action: UssdAction }): Promise<DriverChannelReply>;
}

function assetReference(input: DriverAssetInput): string {
  return input.assetRef.trim();
}

function isSettled(status: PeriodStatus["status"]): boolean {
  return status === "paid" || status === "waived";
}

function intentKey(tenantId: string, assetId: string, businessDate: BusinessDate): string {
  // One intent per asset per business day. Replaying the same USSD session, or
  // a driver pressing the same option twice, returns the first reference rather
  // than asking the gateway for a second charge.
  return `driver:pay:${tenantId}:${assetId}:${businessDate}`;
}

function balanceKey(tenantId: string, assetId: string, businessDate: BusinessDate): string {
  return `driver:pay-from-balance:${tenantId}:${assetId}:${businessDate}`;
}

/**
 * Driver-channel use cases shared by USSD and inbound SMS.
 *
 * This layer is deliberately provider- and channel-agnostic: it resolves a
 * typed reference to an asset, reads the business day from tenant config, and
 * returns a semantic reply plus a message key. The transport layer translates
 * the key and renders it in the provider's format (Step 6).
 *
 * Under `pay_per_use`, a day with no payment is reported as "no payment
 * recorded today". There is no debt, and no reply here ever accuses a driver of
 * owing money for a day they did not work.
 */
export function createDriverChannelService(deps: DriverChannelServiceDeps): DriverChannelService {
  const obligations = new ObligationService(deps.db, deps.feeEngine);
  const now = deps.now ?? (() => new Date());
  const payments: PaymentService = createPaymentService({
    db: deps.db,
    loadConfig: deps.loadConfig,
    feeEngine: deps.feeEngine,
    providerFor: deps.providerFor,
    now,
  });

  async function requireConfig(tenantId: string): Promise<TenantConfig> {
    const config = await deps.loadConfig(tenantId);
    if (config === undefined) {
      throw new DriverChannelError(`No configuration found for tenant "${tenantId}"`);
    }
    return config;
  }

  function requirePaymentProvider(config: TenantConfig): PaymentProvider {
    const binding = config.providers.find((provider) => provider.port === "PaymentProvider");
    if (binding === undefined) {
      throw new DriverChannelError("Tenant config has no PaymentProvider binding");
    }
    const adapter = deps.providerFor(binding.adapter);
    if (adapter === undefined) {
      throw new DriverChannelError(`Unknown payment provider "${binding.adapter}"`);
    }
    return adapter;
  }

  async function resolveAsset(input: DriverAssetInput): Promise<{
    readonly id: string;
    readonly assetTypeKey: string;
    readonly status: string;
  } | null> {
    const asset = await withTenant(deps.db, input.tenantId, async (tx) =>
      repositories(tx).assets.findByReference(assetReference(input)),
    );
    if (asset === undefined) return null;
    return { id: asset.id, assetTypeKey: asset.assetTypeKey, status: asset.status };
  }

  function businessDay(config: TenantConfig): BusinessDate {
    return todayInTimeZone(config.locale.timezone, now());
  }

  function unknownAsset(input: DriverAssetInput): DriverUnknownAssetReply {
    const assetRef = assetReference(input);
    return {
      kind: "unknown_asset",
      assetRef,
      messageKey: DRIVER_MESSAGE_KEYS.assetUnknown,
      variables: { assetRef },
    };
  }

  function statusReply(input: {
    assetId: string;
    assetRef: string;
    businessDate: BusinessDate;
    period: PeriodStatus;
  }): DriverStatusReply {
    const settled = isSettled(input.period.status);
    return {
      kind: "status",
      assetId: input.assetId,
      assetRef: input.assetRef,
      businessDate: input.businessDate,
      status: input.period.status,
      settled,
      amountMinor: input.period.amountMinor,
      currency: input.period.currency,
      messageKey: settled ? DRIVER_MESSAGE_KEYS.statusPaid : DRIVER_MESSAGE_KEYS.statusNone,
      variables: { assetRef: input.assetRef },
    };
  }

  function alreadyPaid(input: {
    assetId: string;
    assetRef: string;
    businessDate: BusinessDate;
  }): DriverAlreadyPaidReply {
    return {
      kind: "already_paid",
      assetId: input.assetId,
      assetRef: input.assetRef,
      businessDate: input.businessDate,
      messageKey: DRIVER_MESSAGE_KEYS.statusPaid,
      variables: { assetRef: input.assetRef },
    };
  }

  function nothingRequired(input: {
    assetId: string;
    assetRef: string;
    businessDate: BusinessDate;
    currency: string;
  }): DriverNothingRequiredReply {
    return {
      kind: "nothing_required",
      assetId: input.assetId,
      assetRef: input.assetRef,
      businessDate: input.businessDate,
      currency: input.currency,
      messageKey: DRIVER_MESSAGE_KEYS.payCovered,
      variables: { assetRef: input.assetRef },
    };
  }

  async function status(input: DriverAssetInput): Promise<DriverChannelReply> {
    const config = await requireConfig(input.tenantId);
    const asset = await resolveAsset(input);
    if (asset === null) return unknownAsset(input);

    const businessDate = businessDay(config);
    const period = await obligations.getPeriodStatus(input.tenantId, asset.id, businessDate);
    return statusReply({
      assetId: asset.id,
      assetRef: assetReference(input),
      businessDate,
      period,
    });
  }

  async function pay(input: DriverAssetInput): Promise<DriverChannelReply> {
    const config = await requireConfig(input.tenantId);
    const asset = await resolveAsset(input);
    if (asset === null) return unknownAsset(input);

    const businessDate = businessDay(config);
    const adapter = requirePaymentProvider(config);
    const assetRef = assetReference(input);
    const capabilities = adapter.capabilities();

    // A long-lived instruction (for example a dedicated virtual account) is
    // already the tenant's configured way to pay this asset. Return it instead
    // of issuing a one-shot intent, but still report whether today is settled
    // and what is actually still required.
    if (capabilities.attributionKinds.includes("virtual_account")) {
      const required = await obligations.getRequiredPayment({
        tenantId: input.tenantId,
        config,
        assetId: asset.id,
        assetTypeKey: asset.assetTypeKey,
        businessDate,
      });
      if (required.alreadySettled) {
        return alreadyPaid({ assetId: asset.id, assetRef, businessDate });
      }
      if (required.requiredMinor === 0n) {
        return nothingRequired({
          assetId: asset.id,
          assetRef,
          businessDate,
          currency: required.currency,
        });
      }

      const instruction = await withTenant(deps.db, input.tenantId, async (tx) =>
        repositories(tx).paymentInstructions.findActiveForAsset(
          input.tenantId,
          adapter.name,
          asset.id,
          "virtual_account",
        ),
      );
      if (instruction !== undefined) {
        return {
          kind: "payment_request",
          assetId: asset.id,
          assetRef,
          businessDate,
          provider: instruction.provider,
          instructionId: instruction.id,
          reference: instruction.reference,
          attributionKind: instruction.kind,
          amountMinor: required.requiredMinor,
          currency: required.currency,
          existingInstruction: true,
          messageKey: DRIVER_MESSAGE_KEYS.payCreated,
          variables: { assetRef, reference: instruction.reference },
        };
      }
    }

    try {
      const intent = await payments.createIntent({
        tenantId: input.tenantId,
        provider: adapter.name,
        assetId: asset.id,
        businessDate,
        idempotencyKey: intentKey(input.tenantId, asset.id, businessDate),
      });

      if (intent.alreadySettled) {
        return alreadyPaid({ assetId: asset.id, assetRef, businessDate });
      }
      if (intent.nothingRequired || intent.amountMinor === 0n) {
        return nothingRequired({
          assetId: asset.id,
          assetRef,
          businessDate,
          currency: intent.currency,
        });
      }
      if (intent.kind === null || intent.reference === "") {
        return {
          kind: "payment_failed",
          assetId: asset.id,
          assetRef,
          businessDate,
          provider: adapter.name,
          reason: "provider_returned_no_instruction",
          messageKey: DRIVER_MESSAGE_KEYS.payFailed,
          variables: { assetRef },
        };
      }

      return {
        kind: "payment_request",
        assetId: asset.id,
        assetRef,
        businessDate,
        provider: intent.provider,
        instructionId: intent.instructionId,
        reference: intent.reference,
        attributionKind: intent.kind,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        existingInstruction: false,
        messageKey: DRIVER_MESSAGE_KEYS.payCreated,
        variables: { assetRef, reference: intent.reference },
      };
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      return {
        kind: "payment_failed",
        assetId: asset.id,
        assetRef,
        businessDate,
        provider: adapter.name,
        reason: `${error.code}: ${error.message}`,
        messageKey: DRIVER_MESSAGE_KEYS.payFailed,
        variables: { assetRef },
      };
    }
  }

  async function payFromBalance(input: DriverAssetInput): Promise<DriverChannelReply> {
    const config = await requireConfig(input.tenantId);
    const asset = await resolveAsset(input);
    if (asset === null) return unknownAsset(input);

    const businessDate = businessDay(config);
    const assetRef = assetReference(input);

    const current = await obligations.getPeriodStatus(input.tenantId, asset.id, businessDate);
    if (isSettled(current.status)) {
      return alreadyPaid({ assetId: asset.id, assetRef, businessDate });
    }

    const result = await obligations.settleDeclaredDay({
      tenantId: input.tenantId,
      config,
      assetId: asset.id,
      assetTypeKey: asset.assetTypeKey,
      businessDate,
      idempotencyKey: balanceKey(input.tenantId, asset.id, businessDate),
    });

    if (result.settled) {
      return {
        kind: "paid_from_balance",
        assetId: asset.id,
        assetRef,
        businessDate,
        amountMinor: result.allocatedMinor,
        currency: config.locale.currency,
        messageKey: DRIVER_MESSAGE_KEYS.payBalance,
        variables: { assetRef },
      };
    }

    const amount = formatMinor(
      result.shortfallMinor,
      config.locale.currency,
      config.locale.numberFormat,
    );
    return {
      kind: "insufficient_balance",
      assetId: asset.id,
      assetRef,
      businessDate,
      shortfallMinor: result.shortfallMinor,
      currency: config.locale.currency,
      messageKey: DRIVER_MESSAGE_KEYS.payInsufficient,
      variables: { assetRef, amount },
    };
  }

  return {
    status,
    pay,
    payFromBalance,
    execute(input) {
      switch (input.action) {
        case "status":
          return status(input);
        case "pay":
          return pay(input);
        case "pay_from_balance":
          return payFromBalance(input);
        case "cancel":
          throw new DriverChannelError("Cancel is handled by the session engine, not this service");
      }
    },
  };
}

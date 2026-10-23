import type { UssdAction } from "@tpirs/domain";

/**
 * The contract between the channel runtime and a tenant's message catalogue.
 *
 * Core code never contains driver-facing copy. It refers to one of these keys
 * and the tenant's `channels.messages` catalogue supplies the text in every
 * enabled language. Because the keys are shared by the USSD engine, the inbound
 * SMS handler, and the driver-channel service, they live here rather than in
 * the application package: `@tpirs/config` is the lowest package that can see
 * both the menu graph and the validation rules, and nothing may depend on
 * `@tpirs/application`.
 *
 * A key is a platform-wide name, not a tenant literal. Two tenants may say
 * entirely different things behind `ussd.status.paid`; what they may not do is
 * change the name, because the runtime needs to know which entry to render.
 */
export const CHANNEL_MESSAGE_KEYS = {
  /** The current business day has a recorded payment. */
  statusPaid: "ussd.status.paid",
  /** No payment is recorded for today. Never worded as a debt. */
  statusNone: "ussd.status.none",
  /** The typed plate or short code matches no asset. */
  assetUnknown: "ussd.asset.unknown",
  /** A payment instruction or reference was issued. */
  payCreated: "ussd.pay.created",
  /** The gateway could not start a payment. */
  payFailed: "ussd.pay.failed",
  /** Today's levy was settled from wallet credit. */
  payBalance: "ussd.pay.balance",
  /** Today is already settled, so nothing further is required. */
  payCovered: "ussd.pay.covered",
  /** Wallet credit does not cover today's levy; `{amount}` is the shortfall. */
  payInsufficient: "ussd.pay.insufficient",
  /** The driver chose cancel. */
  cancelled: "ussd.session.cancelled",
  /** The cumulative input exceeded the configured number of steps. */
  tooManySteps: "ussd.session.too_many_steps",
  /** The sender exceeded a configured per-minute limit. */
  rateLimited: "ussd.rate.limited",
  /** Another request for the same session is still being processed. */
  sessionBusy: "ussd.session.busy",
  /** A malformed menu graph, an unknown action target, or an internal failure. */
  error: "ussd.common.error",
  /** An inbound SMS did not start with the configured keyword. */
  unknownSmsCommand: "sms.command.unknown",
} as const;

export type ChannelMessageKey = (typeof CHANNEL_MESSAGE_KEYS)[keyof typeof CHANNEL_MESSAGE_KEYS];

/**
 * Keys every tenant with a message catalogue must provide. Each one is reached
 * by a path that has nothing to do with the tenant's menu graph - a rate limit,
 * a cancel, a malformed session - so leaving one out would be a configuration
 * hole discovered by a driver rather than by the loader.
 */
export const OPERATIONAL_MESSAGE_KEYS: readonly ChannelMessageKey[] = [
  CHANNEL_MESSAGE_KEYS.error,
  CHANNEL_MESSAGE_KEYS.cancelled,
  CHANNEL_MESSAGE_KEYS.tooManySteps,
  CHANNEL_MESSAGE_KEYS.rateLimited,
  CHANNEL_MESSAGE_KEYS.sessionBusy,
  CHANNEL_MESSAGE_KEYS.unknownSmsCommand,
];

/**
 * Keys required for each action the menu graph can reach. `cancel` is absent on
 * purpose: the pure session engine ends the session without calling the driver
 * service, so its text is one of the operational keys above.
 */
export const ACTION_MESSAGE_KEYS: Readonly<
  Record<Exclude<UssdAction, "cancel">, readonly ChannelMessageKey[]>
> = {
  status: [
    CHANNEL_MESSAGE_KEYS.statusPaid,
    CHANNEL_MESSAGE_KEYS.statusNone,
    CHANNEL_MESSAGE_KEYS.assetUnknown,
  ],
  pay: [
    CHANNEL_MESSAGE_KEYS.payCreated,
    CHANNEL_MESSAGE_KEYS.payFailed,
    CHANNEL_MESSAGE_KEYS.payCovered,
    CHANNEL_MESSAGE_KEYS.statusPaid,
    CHANNEL_MESSAGE_KEYS.assetUnknown,
  ],
  pay_from_balance: [
    CHANNEL_MESSAGE_KEYS.payBalance,
    CHANNEL_MESSAGE_KEYS.payInsufficient,
    CHANNEL_MESSAGE_KEYS.payCovered,
    CHANNEL_MESSAGE_KEYS.statusPaid,
    CHANNEL_MESSAGE_KEYS.assetUnknown,
  ],
};

/**
 * The reserved input key whose value the channel runtime hands to the driver
 * service. A USSD input step must collect it before an action can run; the
 * menus in `tenants/_template` already do.
 */
export const DRIVER_ASSET_INPUT_KEY = "assetRef";

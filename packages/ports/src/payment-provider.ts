import type { Money } from "@tpirs/domain";

/**
 * How a payment is tied back to the asset it belongs to (ADR 0018).
 *
 * - `intent_reference`: the adapter issues a reference for one intent and the
 *   webhook returns it, so no payer-typed text is involved.
 * - `virtual_account`: a persistent account per asset.
 * - `narration`: a shared account plus a reference the payer types, matched
 *   tolerantly. Supported for gateways with no better mechanism, never assumed.
 */
export type PaymentAttributionKind = "intent_reference" | "virtual_account" | "narration";

export const PAYMENT_ATTRIBUTION_KINDS: readonly PaymentAttributionKind[] = [
  "intent_reference",
  "virtual_account",
  "narration",
];

export function isPaymentAttributionKind(value: string): value is PaymentAttributionKind {
  return (PAYMENT_ATTRIBUTION_KINDS as readonly string[]).includes(value);
}

export interface PaymentProviderCapabilities {
  /**
   * Convenience flag, true only when `attributionKinds` includes
   * `virtual_account`. `attributionKinds` is the source of truth; the
   * conformance suite asserts the two cannot disagree.
   */
  readonly supportsVirtualAccounts: boolean;
  /** True when the adapter can attribute a payment by a reference the payer holds. */
  readonly supportsPaymentReferences: boolean;
  readonly supportsSettlementFetch: boolean;
  /**
   * Attribution mechanisms the adapter implements, ordered by preference. The
   * platform may only create intents for a declared kind, and an adapter that
   * cannot issue an intent reference must say so here rather than falling back
   * to narration silently.
   */
  readonly attributionKinds: readonly PaymentAttributionKind[];
}

export interface PaymentIntentRequest {
  readonly idempotencyKey: string;
  readonly amount: Money;
  readonly reference: string;
  readonly customer?: {
    readonly name?: string;
    readonly phone?: string;
  };
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PaymentInstruction {
  readonly type: "virtual_account" | "reference";
  readonly value: string;
  readonly expiresAt?: Date;
}

export interface PaymentIntentAttribution {
  readonly kind: PaymentAttributionKind;
  /**
   * What to show the payer. Absent when the adapter issues nothing for this
   * kind, for example a shared account the platform already knows.
   */
  readonly instruction?: PaymentInstruction;
}

export interface PaymentIntent {
  readonly providerId: string;
  readonly status: "pending" | "completed" | "failed" | "abandoned";
  readonly authorizationUrl?: string;
  /** How this intent's payment will be attributed, and what the payer must use. */
  readonly attribution: PaymentIntentAttribution;
  readonly raw: unknown;
}

export interface WebhookVerification {
  readonly ok: boolean;
}

export interface NormalizedPaymentEvent {
  /** Stable dedupe key: replaying the same webhook must produce the same value. */
  readonly providerEventId: string;
  readonly providerReference: string;
  /**
   * The destination the money arrived at, when the gateway reports one that is
   * not the transaction reference.
   *
   * A Virtual Terminal payment is the motivating case (ADR 0069): the payer
   * transfers to the terminal's dedicated account, and Paystack names the
   * terminal in `metadata.virtual_terminal.code` while `providerReference` is
   * Paystack's own `T…`. Collector deposits resolve their instruction by this
   * value first, so the collector can be credited without a reference of ours.
   */
  readonly attributionKey?: string;
  readonly amount: Money;
  readonly status: "success" | "failed";
  readonly paidAt: Date;
  readonly raw: unknown;
}

export interface Settlement {
  readonly providerReference: string;
  /** Gross amount that was charged; not the amount that reached the bank. */
  readonly amount: Money;
  /**
   * The gateway's cut, when the feed reports it (ADR 0035/0036). Absent means
   * "the adapter does not know": core then treats the whole difference between
   * `amount` and the bank amount as a fee only while it is inside the tenant's
   * fee tolerance, and as an exception otherwise. An adapter must never
   * compute a fee it was not told.
   */
  readonly fee?: Money;
  readonly settledAt: Date;
  readonly raw: unknown;
}

/** What the platform asks the adapter for when provisioning a deposit instruction. */
export interface DepositAttributionRequest {
  /** The collector the deposit account/reference will belong to. */
  readonly collectorUserId: string;
  /**
   * The tenant the destination belongs to. Sent to the gateway as support
   * metadata so a terminal can be traced to the tenant that created it.
   */
  readonly tenantId?: string;
  /** Correlation key for the adapter's own idempotent bookkeeping. */
  readonly idempotencyKey: string;
  /** A human name for the destination; the terminal name a payer sees. */
  readonly name?: string;
  /** Phone that receives the gateway's own payment notifications, E.164. */
  readonly phone?: string;
  /** ISO currency the destination should collect in. */
  readonly currency?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A deposit destination the adapter issued, in the form the collector pays with. */
export interface DepositAttribution {
  /**
   * `virtual_terminal`: a terminal code plus, where the market issues one, a
   * dedicated account number (ADR 0069). `virtual_account` and `narration` are
   * the older shapes kept for adapters that only offer those.
   */
  readonly kind: "virtual_account" | "narration" | "virtual_terminal";
  /**
   * What the webhook resolves the collector from: the terminal code for
   * `virtual_terminal`, the account number for `virtual_account`, or the text
   * the payer writes for `narration`.
   */
  readonly value: string;
  /** Present when the gateway issued a transfer destination (a NUBAN in Nigeria). */
  readonly accountNumber?: string;
  readonly accountName?: string;
  readonly bank?: string;
  /** Hosted page a payer can open instead of transferring, when the gateway has one. */
  readonly pageUrl?: string;
  readonly currency?: string;
}

export interface PaymentProvider {
  readonly name: string;
  capabilities(): PaymentProviderCapabilities;
  createPaymentIntent(request: PaymentIntentRequest): Promise<PaymentIntent>;
  verifyWebhook(request: {
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly rawBody: string;
  }): Promise<WebhookVerification>;
  /** Parse a signature-verified webhook body. Throws PortError("invalid_request") when malformed. */
  normalizeWebhook(rawBody: string): NormalizedPaymentEvent;
  fetchSettlements(range: {
    readonly from: Date;
    readonly to: Date;
  }): Promise<readonly Settlement[]>;
  /**
   * Attribution for a collector's dedicated deposit instruction (ADR 0032).
   *
   * Optional: providers without per-collector deposit mechanics do not
   * implement it, and provisioning a deposit instruction for them then fails
   * loudly rather than falling back to a reference format the adapter never
   * sanctioned. The adapter owns the reference format; core never invents one.
   */
  createDepositAttribution?(request: DepositAttributionRequest): Promise<DepositAttribution>;
  /**
   * Turns a destination off at the gateway, when the gateway has a remote
   * object that outlives the platform's row (a Virtual Terminal does).
   *
   * Optional so adapters whose destination is a platform-side reference keep
   * working; the caller treats a failure as a loud, retryable error rather than
   * silently leaving a destination that still credits a departed collector.
   */
  deactivateDepositAttribution?(reference: string): Promise<void>;
}

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
  /** Correlation key for the adapter's own idempotent bookkeeping. */
  readonly idempotencyKey: string;
}

/** A deposit destination the adapter issued, in the form the collector pays with. */
export interface DepositAttribution {
  readonly kind: "virtual_account" | "narration";
  /**
   * What the collector pays into for `virtual_account`, or what they write in
   * the payment narration for `narration`. The webhook resolves the collector
   * from this value.
   */
  readonly value: string;
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
}

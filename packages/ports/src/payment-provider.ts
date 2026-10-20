import type { Money } from "@tpirs/domain";

export interface PaymentProviderCapabilities {
  readonly supportsVirtualAccounts: boolean;
  readonly supportsPaymentReferences: boolean;
  readonly supportsSettlementFetch: boolean;
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

export interface PaymentIntent {
  readonly providerId: string;
  readonly status: "pending" | "completed" | "failed" | "abandoned";
  readonly authorizationUrl?: string;
  readonly instruction?: PaymentInstruction;
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
  readonly amount: Money;
  readonly settledAt: Date;
  readonly raw: unknown;
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
}

export interface SmsCapabilities {
  readonly supportsDeliveryReceipts: boolean;
  readonly supportsInbound: boolean;
  readonly maxSegments: number;
}

export interface SmsMessage {
  readonly to: string;
  readonly text: string;
  readonly idempotencyKey: string;
  readonly senderId?: string;
}

export interface SmsSendResult {
  readonly providerMessageId: string;
  readonly status: "accepted" | "queued";
}

export interface SmsDeliveryReceipt {
  readonly providerMessageId: string;
  readonly status: "delivered" | "failed" | "undeliverable";
  readonly receivedAt: Date;
}

export interface InboundSms {
  readonly providerMessageId: string;
  readonly from: string;
  readonly text: string;
  readonly receivedAt: Date;
}

/**
 * An inbound SMS callback after the HTTP layer has decoded it into fields. As
 * with USSD, the adapter owns the provider-specific field names and validation.
 */
export interface SmsCallbackInput {
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

export interface SmsProvider {
  capabilities(): SmsCapabilities;
  send(message: SmsMessage): Promise<SmsSendResult>;
  fetchDeliveryReceipts(since: Date): Promise<readonly SmsDeliveryReceipt[]>;
  /** Polling fallback for providers that do not push inbound callbacks. */
  fetchInbound(since: Date): Promise<readonly InboundSms[]>;
  /**
   * Parse a pushed inbound callback. Required when
   * `capabilities().supportsInbound` is true; providers that only support
   * polling leave it undefined and rely on `fetchInbound`.
   */
  parseInboundCallback?(input: SmsCallbackInput): InboundSms;
}

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

export interface SmsProvider {
  capabilities(): SmsCapabilities;
  send(message: SmsMessage): Promise<SmsSendResult>;
  fetchDeliveryReceipts(since: Date): Promise<readonly SmsDeliveryReceipt[]>;
  fetchInbound(since: Date): Promise<readonly InboundSms[]>;
}

import { PortError } from "@tpirs/ports";
import type {
  InboundSms,
  SmsCapabilities,
  SmsDeliveryReceipt,
  SmsMessage,
  SmsProvider,
  SmsSendResult,
} from "@tpirs/ports";

export interface MockSmsProvider extends SmsProvider {
  /** All messages accepted by send(), in order (test inspection). */
  readonly sent: SmsMessage[];
  /** Make the next send() fail with the given PortError code. */
  failNextSend(code: "unavailable" | "rate_limited" | "invalid_request"): void;
  /** Push a delivery receipt for a previously sent message. */
  queueDeliveryReceipt(providerMessageId: string, status: SmsDeliveryReceipt["status"]): void;
  /** Push an inbound message. */
  queueInbound(message: InboundSms): void;
}

export function createMockSmsProvider(): MockSmsProvider {
  const sent: SmsMessage[] = [];
  const receipts: SmsDeliveryReceipt[] = [];
  const inbound: InboundSms[] = [];
  let failure: "unavailable" | "rate_limited" | "invalid_request" | undefined;
  let counter = 0;

  const capabilities: SmsCapabilities = {
    supportsDeliveryReceipts: true,
    supportsInbound: true,
    maxSegments: 3,
  };

  return {
    sent,
    capabilities: () => capabilities,
    send(message) {
      if (failure !== undefined) {
        const code = failure;
        failure = undefined;
        return Promise.reject(new PortError("SmsProvider", code, `Mock SMS failure: ${code}`));
      }
      if (message.to.trim().length === 0) {
        return Promise.reject(
          new PortError("SmsProvider", "invalid_request", "Recipient must not be empty"),
        );
      }
      counter += 1;
      const result: SmsSendResult = {
        providerMessageId: `mock-sms-${String(counter)}`,
        status: "accepted",
      };
      sent.push(message);
      return Promise.resolve(result);
    },
    fetchDeliveryReceipts(since) {
      return Promise.resolve(receipts.filter((r) => r.receivedAt >= since));
    },
    fetchInbound(since) {
      return Promise.resolve(inbound.filter((m) => m.receivedAt >= since));
    },
    failNextSend(code) {
      failure = code;
    },
    queueDeliveryReceipt(providerMessageId, status) {
      receipts.push({ providerMessageId, status, receivedAt: new Date() });
    },
    queueInbound(message) {
      inbound.push(message);
    },
  };
}

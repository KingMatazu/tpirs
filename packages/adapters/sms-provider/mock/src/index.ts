import { PortError } from "@tpirs/ports";
import type {
  InboundSms,
  SmsCallbackInput,
  SmsCapabilities,
  SmsDeliveryReceipt,
  SmsMessage,
  SmsProvider,
  SmsSendResult,
} from "@tpirs/ports";

/** The canonical inbound callback body the mock adapter understands. */
export const MOCK_INBOUND_SMS_CALLBACK: Readonly<Record<string, unknown>> = {
  providerMessageId: "mock-inbound-1",
  from: "+2348000000001",
  text: "LEVY KJA-123",
  receivedAt: "2026-06-15T09:00:00.000Z",
};

/** Builds a callback body from a normalized inbound message, for fixtures. */
export function createMockInboundSmsCallback(
  message: InboundSms,
): Readonly<Record<string, unknown>> {
  return {
    providerMessageId: message.providerMessageId,
    from: message.from,
    text: message.text,
    receivedAt: message.receivedAt.toISOString(),
  };
}

function readRequiredString(body: Readonly<Record<string, unknown>>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new PortError(
      "SmsProvider",
      "invalid_request",
      `Missing, empty, or non-string inbound SMS field "${field}"`,
    );
  }
  return value;
}

function readReceivedAt(body: Readonly<Record<string, unknown>>): Date {
  const value = body["receivedAt"];
  if (value === undefined) return new Date();
  const receivedAt =
    value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (receivedAt === null || Number.isNaN(receivedAt.getTime())) {
    throw new PortError("SmsProvider", "invalid_request", 'Invalid inbound SMS field "receivedAt"');
  }
  return receivedAt;
}

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
    parseInboundCallback(input: SmsCallbackInput): InboundSms {
      return {
        providerMessageId: readRequiredString(input.body, "providerMessageId"),
        from: readRequiredString(input.body, "from"),
        text: readRequiredString(input.body, "text"),
        receivedAt: readReceivedAt(input.body),
      };
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

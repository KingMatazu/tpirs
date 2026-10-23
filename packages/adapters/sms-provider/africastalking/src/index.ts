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

/**
 * Africa's Talking SMS transport.
 *
 * The adapter builds the aggregator's request shape and parses its response; it
 * owns no sockets. Transport is injected so tests replay recorded payloads and
 * production wires a real HTTP client at the composition root. No fixture in
 * this package ever reaches the network.
 *
 * Delivery receipts and inbound messages arrive as provider *push* callbacks.
 * The `SmsProvider` port only models a polling fallback, so
 * `fetchDeliveryReceipts`/`fetchInbound` answer with an empty list instead of
 * inventing data; `parseInboundCallback` covers the inbound push.
 */

export interface HttpTransportRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpTransportResponse {
  readonly status: number;
  readonly body: string;
}

export interface HttpTransport {
  send(request: HttpTransportRequest): Promise<HttpTransportResponse>;
}

export interface HttpTransportFailure {
  readonly request: HttpTransportRequest;
  readonly error: unknown;
}

/**
 * A transport that answers from recorded responses. Tests and conformance
 * suites use this so they never touch the network; the recorded request is kept
 * for assertions about what the adapter would have sent.
 */
export interface RecordedHttpTransport extends HttpTransport {
  readonly requests: HttpTransportRequest[];
  /** Queue or replace the next response(s). */
  respond(response: HttpTransportResponse): void;
}

export function createRecordedHttpTransport(
  responses: readonly HttpTransportResponse[] = [],
): RecordedHttpTransport {
  const queue = [...responses];
  const requests: HttpTransportRequest[] = [];
  return {
    requests,
    send(request) {
      requests.push(request);
      const response = queue.shift();
      if (response === undefined) {
        return Promise.reject(new Error("No recorded HTTP response for this request"));
      }
      return Promise.resolve(response);
    },
    respond(response) {
      queue.push(response);
    },
  };
}

/**
 * Production transport. This is the only place an adapter package uses the
 * network, and it is constructed at the composition root; tests always inject
 * `createRecordedHttpTransport` instead.
 */
export function createFetchHttpTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return {
    async send(request) {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      return { status: response.status, body: await response.text() };
    },
  };
}

/** The aggregator's send endpoint. */
export const AFRICASTALKING_SMS_URL = "https://api.africastalking.com/version1/messaging";

/** A recorded send response, as Africa's Talking returns it. */
export const AFRICASTALKING_SEND_RESPONSE = JSON.stringify({
  SMSMessageData: {
    Message: "Sent to 1/1 Total Cost: KES 0.8000",
    Recipients: [
      {
        statusCode: 101,
        status: "Success",
        messageId: "ATXid_0f2c9a1b4d",
        cost: "KES 0.8000",
        number: "+254700000001",
      },
    ],
  },
});

/** A recorded inbound callback, as Africa's Talking posts it. */
export const AFRICASTALKING_INBOUND_CALLBACK: Readonly<Record<string, unknown>> = {
  linkId: "ATLink-7788",
  text: "LEVY KJA-123",
  to: "*384*1234#",
  id: "ATXid_inbound_9911",
  date: "2026-06-15T09:00:00.000Z",
  from: "+254700000001",
};

export interface AfricaSTalkingSmsOptions {
  readonly username: string;
  readonly apiKey: string;
  readonly transport: HttpTransport;
  /** Default sender id when a message does not override it. */
  readonly senderId?: string;
}

function readString(body: Readonly<Record<string, unknown>>, field: string): string {
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

function parseBody(response: HttpTransportResponse): unknown {
  try {
    return JSON.parse(response.body) as unknown;
  } catch (error) {
    throw new PortError("SmsProvider", "unavailable", "SMS provider returned non-JSON", {
      cause: error,
    });
  }
}

interface SendPayload {
  readonly SMSMessageData?: {
    readonly Recipients?: readonly {
      readonly statusCode?: unknown;
      readonly status?: unknown;
      readonly messageId?: unknown;
    }[];
  };
}

const ACCEPTED_STATUS_CODES = new Set([100, 101, 102]);

export function createAfricaSTalkingSmsProvider(options: AfricaSTalkingSmsOptions): SmsProvider {
  const capabilities: SmsCapabilities = {
    // Delivery reports are push-only; the port models polling.
    supportsDeliveryReceipts: false,
    supportsInbound: true,
    maxSegments: 3,
  };

  return {
    capabilities: () => capabilities,
    async send(message: SmsMessage): Promise<SmsSendResult> {
      if (message.to.trim() === "") {
        throw new PortError("SmsProvider", "invalid_request", "Recipient must not be empty");
      }
      const form = new URLSearchParams();
      form.set("username", options.username);
      form.set("to", message.to);
      form.set("message", message.text);
      const senderId = message.senderId ?? options.senderId;
      if (senderId !== undefined) form.set("from", senderId);

      const response = await options.transport.send({
        url: AFRICASTALKING_SMS_URL,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          apiKey: options.apiKey,
        },
        body: form.toString(),
      });
      if (response.status >= 500) {
        throw new PortError(
          "SmsProvider",
          "unavailable",
          `SMS provider is unavailable (status ${String(response.status)})`,
        );
      }
      const payload = parseBody(response) as SendPayload;
      const recipient = payload.SMSMessageData?.Recipients?.[0];
      const statusCode =
        typeof recipient?.statusCode === "number" ? recipient.statusCode : undefined;
      const messageId = recipient?.messageId;
      if (
        response.status >= 400 ||
        statusCode === undefined ||
        !ACCEPTED_STATUS_CODES.has(statusCode) ||
        typeof messageId !== "string" ||
        messageId === ""
      ) {
        throw new PortError(
          "SmsProvider",
          statusCode === 403 ? "rate_limited" : "invalid_request",
          `SMS provider rejected the message (status ${String(statusCode ?? response.status)})`,
        );
      }
      return { providerMessageId: messageId, status: "accepted" };
    },
    fetchDeliveryReceipts(_since: Date): Promise<readonly SmsDeliveryReceipt[]> {
      // Push-only at the provider; a receipt callback has no port method yet.
      return Promise.resolve([]);
    },
    fetchInbound(_since: Date): Promise<readonly InboundSms[]> {
      // Push-only at the provider; see parseInboundCallback.
      return Promise.resolve([]);
    },
    parseInboundCallback(input: SmsCallbackInput): InboundSms {
      const providerMessageId = readString(input.body, "id");
      const from = readString(input.body, "from");
      const text = readString(input.body, "text");
      const date = readString(input.body, "date");
      const receivedAt = new Date(date);
      if (Number.isNaN(receivedAt.getTime())) {
        throw new PortError(
          "SmsProvider",
          "invalid_request",
          'Inbound SMS field "date" is not a valid timestamp',
        );
      }
      return { providerMessageId, from, text, receivedAt };
    },
  };
}

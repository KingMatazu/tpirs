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
 * Termii SMS transport.
 *
 * Termii is the alternative aggregator: same `SmsProvider` port, same
 * conformance suite, different wire format (JSON body with the API key in the
 * payload and a `message_id` in the response). Transport is injected, so tests
 * replay recorded payloads and production wires a real HTTP client at the
 * composition root.
 *
 * Termii pushes delivery reports and inbound messages to a configured URL. The
 * port only models polling for those, so `fetchDeliveryReceipts`/`fetchInbound`
 * return an empty list rather than fabricating records;
 * `parseInboundCallback` handles the inbound push.
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

export interface RecordedHttpTransport extends HttpTransport {
  readonly requests: HttpTransportRequest[];
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
export const TERMII_SMS_URL = "https://api.ng.termii.com/api/sms/send";

/** A recorded send response, as Termii returns it. */
export const TERMII_SEND_RESPONSE = JSON.stringify({
  code: "ok",
  message_id: "termii-msg-88112233",
  message: "Successfully Sent",
  balance: 1200,
});

/** A recorded inbound callback, as Termii posts it. */
export const TERMII_INBOUND_CALLBACK: Readonly<Record<string, unknown>> = {
  message_id: "termii-inbound-4455",
  from: "2347000000001",
  to: "LEVY",
  text: "LEVY KJA-123",
  date: "2026-06-15T09:00:00.000Z",
};

export interface TermiiSmsOptions {
  readonly apiKey: string;
  readonly transport: HttpTransport;
  /** Sender id approved with the aggregator; required by Termii. */
  readonly senderId: string;
  /** Always sent; Termii returns the text unchanged. */
  readonly channel?: "generic" | "dnd" | "whatsapp";
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

interface TermiiSendPayload {
  readonly code?: unknown;
  readonly message_id?: unknown;
  readonly message?: unknown;
}

export function createTermiiSmsProvider(options: TermiiSmsOptions): SmsProvider {
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
      const response = await options.transport.send({
        url: TERMII_SMS_URL,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          to: message.to,
          from: message.senderId ?? options.senderId,
          sms: message.text,
          type: "plain",
          channel: options.channel ?? "generic",
          api_key: options.apiKey,
        }),
      });
      if (response.status >= 500) {
        throw new PortError(
          "SmsProvider",
          "unavailable",
          `SMS provider is unavailable (status ${String(response.status)})`,
        );
      }
      let payload: TermiiSendPayload;
      try {
        payload = JSON.parse(response.body) as TermiiSendPayload;
      } catch (error) {
        throw new PortError("SmsProvider", "unavailable", "SMS provider returned non-JSON", {
          cause: error,
        });
      }
      const messageId = payload.message_id;
      if (
        response.status >= 400 ||
        payload.code !== "ok" ||
        typeof messageId !== "string" ||
        messageId === ""
      ) {
        throw new PortError(
          "SmsProvider",
          response.status === 429 ? "rate_limited" : "invalid_request",
          `SMS provider rejected the message (status ${String(response.status)}, code ${String(payload.code)})`,
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
      const providerMessageId = readString(input.body, "message_id");
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

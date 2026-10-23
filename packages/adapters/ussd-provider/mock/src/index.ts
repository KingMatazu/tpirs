import { PortError } from "@tpirs/ports";
import type {
  UssdCallbackInput,
  UssdCapabilities,
  UssdProvider,
  UssdRenderedResponse,
  UssdSessionRequest,
  UssdSessionResponse,
} from "@tpirs/ports";

/** The canonical callback body the mock adapter understands. */
export const MOCK_USSD_CALLBACK: Readonly<Record<string, unknown>> = {
  sessionId: "mock-session-1",
  from: "+2348000000001",
  text: "",
  shortcode: "*123#",
  serviceCode: "*123#",
};

/** Builds a callback body from an internal request, for tests and fixtures. */
export function createMockUssdCallback(
  request: UssdSessionRequest,
): Readonly<Record<string, unknown>> {
  return {
    sessionId: request.sessionId,
    from: request.from,
    text: request.text,
    shortcode: request.shortcode,
    ...(request.serviceCode === undefined ? {} : { serviceCode: request.serviceCode }),
  };
}

function readString(body: Readonly<Record<string, unknown>>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new PortError(
      "UssdProvider",
      "invalid_request",
      `Missing or non-string USSD callback field "${field}"`,
    );
  }
  return value;
}

function readRequiredString(body: Readonly<Record<string, unknown>>, field: string): string {
  const value = readString(body, field);
  if (value.trim() === "") {
    throw new PortError(
      "UssdProvider",
      "invalid_request",
      `USSD callback field "${field}" is empty`,
    );
  }
  return value;
}

/**
 * Transport-only mock. It knows the wire format and nothing about menus: the
 * session engine is pure domain code supplied by the application layer.
 */
export function createMockUssdProvider(): UssdProvider {
  const capabilities: UssdCapabilities = {
    maxResponseLength: 182,
    supportsServiceCode: true,
  };

  return {
    name: "mock-ussd",
    capabilities: () => capabilities,
    parseCallback(input: UssdCallbackInput): UssdSessionRequest {
      const sessionId = readRequiredString(input.body, "sessionId");
      const from = readRequiredString(input.body, "from");
      // The cumulative text is empty on the first request, so emptiness is
      // valid here; the provider must still send the field.
      const text = readString(input.body, "text");
      const shortcode = readRequiredString(input.body, "shortcode");
      const serviceCode = input.body["serviceCode"];
      if (serviceCode !== undefined && typeof serviceCode !== "string") {
        throw new PortError(
          "UssdProvider",
          "invalid_request",
          'USSD callback field "serviceCode" must be a string when present',
        );
      }
      return {
        sessionId,
        from,
        text,
        shortcode,
        ...(serviceCode === undefined ? {} : { serviceCode }),
      };
    },
    renderResponse(response: UssdSessionResponse): UssdRenderedResponse {
      const prefix = response.type === "continue" ? "CON" : "END";
      return {
        statusCode: 200,
        contentType: "text/plain; charset=utf-8",
        body: `${prefix} ${response.message}`,
      };
    },
  };
}

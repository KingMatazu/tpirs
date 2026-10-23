import { PortError } from "@tpirs/ports";
import type {
  UssdCallbackInput,
  UssdCapabilities,
  UssdProvider,
  UssdRenderedResponse,
  UssdSessionRequest,
  UssdSessionResponse,
} from "@tpirs/ports";

/**
 * Africa's Talking USSD transport.
 *
 * The aggregator posts `application/x-www-form-urlencoded` fields
 * (`sessionId`, `serviceCode`, `phoneNumber`, `text`, optionally `networkCode`)
 * and expects a plain-text body starting with `CON` (more input is needed) or
 * `END` (session over). It knows nothing about menus: session state and message
 * rendering stay in the domain and application layers.
 */

/** A recorded callback, exactly as Africa's Talking posts it. */
export const AFRICASTALKING_USSD_CALLBACK: Readonly<Record<string, unknown>> = {
  sessionId: "ATUssdSession1234",
  serviceCode: "*384*1234#",
  phoneNumber: "+254700000001",
  text: "",
  networkCode: "63902",
};

function readRequiredString(body: Readonly<Record<string, unknown>>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new PortError(
      "UssdProvider",
      "invalid_request",
      `Missing or non-string USSD callback field "${field}"`,
    );
  }
  if (value.trim() === "") {
    throw new PortError(
      "UssdProvider",
      "invalid_request",
      `USSD callback field "${field}" is empty`,
    );
  }
  return value;
}

/** Africa's Talking sends cumulative text; an empty value is a first request. */
function readCumulativeText(body: Readonly<Record<string, unknown>>): string {
  const value = body["text"];
  if (typeof value !== "string") {
    throw new PortError(
      "UssdProvider",
      "invalid_request",
      'Missing or non-string USSD callback field "text"',
    );
  }
  return value;
}

export interface AfricaSTalkingUssdOptions {
  /**
   * The shortcode the driver dialled. Africa's Talking reports it per request
   * as `serviceCode`; the option only supplies a default when the callback
   * omits it and that behaviour is declared by capabilities.
   */
  readonly shortcode?: string;
}

export function createAfricaSTalkingUssdProvider(
  options: AfricaSTalkingUssdOptions = {},
): UssdProvider {
  const capabilities: UssdCapabilities = {
    // Africa's Talking truncates responses beyond 182 characters.
    maxResponseLength: 182,
    supportsServiceCode: true,
  };

  return {
    name: "africastalking-ussd",
    capabilities: () => capabilities,
    parseCallback(input: UssdCallbackInput): UssdSessionRequest {
      const sessionId = readRequiredString(input.body, "sessionId");
      const from = readRequiredString(input.body, "phoneNumber");
      const text = readCumulativeText(input.body);
      const serviceCode =
        input.body["serviceCode"] === undefined
          ? undefined
          : readRequiredString(input.body, "serviceCode");
      const shortcode = serviceCode ?? options.shortcode;
      if (shortcode === undefined || shortcode.trim() === "") {
        throw new PortError(
          "UssdProvider",
          "invalid_request",
          "Africa's Talking callback did not include a service code",
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

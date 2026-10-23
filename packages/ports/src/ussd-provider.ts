export interface UssdSessionRequest {
  readonly sessionId: string;
  readonly from: string;
  /** Cumulative session input for this request. */
  readonly text: string;
  readonly shortcode: string;
  readonly serviceCode?: string;
}

export interface UssdSessionResponse {
  readonly type: "continue" | "end";
  readonly message: string;
}

export interface UssdCapabilities {
  /** Maximum characters the provider accepts in one response. */
  readonly maxResponseLength: number;
  /** Whether callbacks include the service code the driver dialled. */
  readonly supportsServiceCode: boolean;
}

/**
 * A provider callback after the HTTP layer has decoded it into fields. The
 * adapter, not the route, knows which fields the provider sends and how to
 * validate them.
 */
export interface UssdCallbackInput {
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

/** A provider-shaped reply the HTTP layer can write back unchanged. */
export interface UssdRenderedResponse {
  readonly statusCode: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * The USSD transport port.
 *
 * The adapter only translates between a provider's callback shape and the
 * internal request/response types. The session engine itself is pure domain
 * code, injected by the application layer, so the same menu graph works with
 * every aggregator and can be replayed without touching a provider SDK.
 */
export interface UssdProvider {
  readonly name: string;
  capabilities(): UssdCapabilities;
  /** Parse a provider callback. Throws PortError("invalid_request") when malformed. */
  parseCallback(input: UssdCallbackInput): UssdSessionRequest;
  /** Render an engine response in the provider's expected format. */
  renderResponse(response: UssdSessionResponse): UssdRenderedResponse;
}

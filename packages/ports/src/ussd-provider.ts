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

/**
 * The adapter translates a provider-specific callback into UssdSessionRequest,
 * delegates to the internal session engine (injected at construction), and
 * renders the engine's response back in the provider's format.
 */
export interface UssdProvider {
  readonly name: string;
  handleSession(request: UssdSessionRequest): Promise<UssdSessionResponse>;
}

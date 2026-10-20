import { PortError } from "@tpirs/ports";
import type { UssdProvider, UssdSessionRequest, UssdSessionResponse } from "@tpirs/ports";

export type MockUssdEngine = (request: UssdSessionRequest) => UssdSessionResponse;

/** Default engine: empty input shows a welcome menu; anything else ends the session. */
export const defaultMockUssdEngine: MockUssdEngine = (request) => {
  if (request.text === "") {
    return { type: "continue", message: "Welcome\n1. Pay levy\n2. Exit" };
  }
  return { type: "end", message: "Thank you for using the mock USSD service." };
};

export interface MockUssdProviderOptions {
  readonly engine?: MockUssdEngine;
}

export function createMockUssdProvider(options: MockUssdProviderOptions = {}): UssdProvider {
  const engine = options.engine ?? defaultMockUssdEngine;
  return {
    name: "mock-ussd",
    handleSession(request) {
      if (request.sessionId.trim().length === 0) {
        return Promise.reject(
          new PortError("UssdProvider", "invalid_request", "Session id must not be empty"),
        );
      }
      return Promise.resolve(engine(request));
    },
  };
}

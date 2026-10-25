/**
 * Test-only shim: openapi-fetch addresses the API with same-origin relative
 * paths (the dashboard is served behind the /v1 proxy). Browsers accept
 * relative URLs, but the Request implementation vitest provides (undici)
 * does not. Tests install this wrapper so relative request URLs resolve
 * against a virtual localhost origin.
 */
export const relativeAwareRequest: typeof Request = class extends globalThis.Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === "string" && !input.startsWith("http")) {
      super(new URL(input, "http://localhost").toString(), init);
    } else if (input instanceof Request && !input.url.startsWith("http")) {
      super(new URL(input.url, "http://localhost").toString(), init);
    } else {
      super(input, init);
    }
  }
};

/** Installs the Request stub; tests stub `fetch` separately. */
export function stubRelativeRequests(): void {
  globalThis.Request = relativeAwareRequest;
}

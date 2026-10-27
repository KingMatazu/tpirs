import { beforeAll } from "vitest";
import { setRuntimeFetch } from "@tpirs/api-client";
import { stubRelativeRequests } from "./src/test-support/browserStubs.js";

beforeAll(() => {
  stubRelativeRequests();
  // Deferred so a test that stubs `fetch` later still reaches its stub; passing
  // `globalThis.fetch` here would snapshot the pre-stub implementation.
  setRuntimeFetch((...args) => globalThis.fetch(...args));
});

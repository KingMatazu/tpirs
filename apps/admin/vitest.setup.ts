import { beforeAll } from "vitest";
import { stubRelativeRequests } from "./src/test-support/browserStubs.js";

beforeAll(() => {
  stubRelativeRequests();
});

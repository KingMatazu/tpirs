import { describe, expect, it } from "vitest";
import { isDisputeStatus } from "./dispute.js";

describe("dispute vocabulary", () => {
  it("knows the dispute lifecycle states", () => {
    expect(isDisputeStatus("open")).toBe(true);
    expect(isDisputeStatus("resolved")).toBe(true);
    expect(isDisputeStatus("rejected")).toBe(true);
    expect(isDisputeStatus("closed")).toBe(false);
  });
});

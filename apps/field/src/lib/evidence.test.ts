import { describe, expect, it } from "vitest";
import { MAX_EVIDENCE_BASE64, base64Of, fitsBudget } from "./evidence.js";

describe("base64Of", () => {
  it("strips the data-url prefix a canvas produces", () => {
    expect(base64Of("data:image/jpeg;base64,QUJD")).toBe("QUJD");
  });

  it("returns nothing for a string that is not a data url", () => {
    expect(base64Of("QUJD")).toBeUndefined();
  });
});

describe("fitsBudget", () => {
  it("accepts a photo inside the request budget", () => {
    expect(fitsBudget("a".repeat(1000))).toBe(true);
  });

  it("refuses a photo that would blow the 1 MB body limit", () => {
    expect(fitsBudget("a".repeat(MAX_EVIDENCE_BASE64 + 1))).toBe(false);
  });

  it("refuses an empty payload", () => {
    expect(fitsBudget("")).toBe(false);
  });
});

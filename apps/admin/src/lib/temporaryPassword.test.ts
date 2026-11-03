import { describe, expect, it } from "vitest";
import { TEMPORARY_PASSWORD_LENGTH, temporaryPassword } from "./temporaryPassword.js";

describe("generated temporary password", () => {
  it("is long enough to read out and short enough to type", () => {
    expect(temporaryPassword()).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
  });

  it("uses only characters that cannot be mistaken for another", () => {
    // No l, o, 0 or 1: a password read down a phone line is the real use case.
    expect(temporaryPassword()).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]+$/);
  });

  it("is different every time", () => {
    expect(temporaryPassword()).not.toBe(temporaryPassword());
  });
});

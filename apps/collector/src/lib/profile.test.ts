import { describe, expect, it } from "vitest";
import { initialsFor, maskNationalId, roleLabel } from "./profile.js";

describe("profile helpers", () => {
  it("takes two initials from a name, and never three", () => {
    expect(initialsFor("Musa Abdullahi")).toBe("MA");
    expect(initialsFor("Musa")).toBe("M");
    expect(initialsFor("  musa   abdullahi  ")).toBe("MA");
    expect(initialsFor("Musa Bello Abdullahi")).toBe("MA");
  });

  it("has something to show when the account has no name", () => {
    expect(initialsFor("")).toBe("?");
    expect(initialsFor("   ")).toBe("?");
  });

  it("keeps the last four digits of the national ID", () => {
    expect(maskNationalId("12345678901")).toBe("•••••••8901");
    // Short values are hidden entirely rather than partly exposed.
    expect(maskNationalId("1234")).toBe("••••");
    expect(maskNationalId("12")).toBe("••");
  });

  it("labels a role key for a person to read", () => {
    expect(roleLabel("collector")).toBe("Collector");
    expect(roleLabel("finance_admin")).toBe("Finance Admin");
  });
});

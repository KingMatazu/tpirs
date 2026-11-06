import { describe, expect, it } from "vitest";
import { cookiePolicyFor } from "./auth.js";

/**
 * The refresh cookie's SameSite is what decides whether a reload keeps the
 * session. A `strict` cookie is stored on the API's site but never *presented*
 * on a cross-site request, so the split-origin pilot signed the user out on
 * every reload while the server looked perfectly healthy (ADR 0068).
 */

const CROSS_SITE = ["https://admin.example.gov", "https://field.example.gov"];

function request(origin: string | undefined) {
  return { headers: origin === undefined ? {} : { origin } } as Parameters<
    typeof cookiePolicyFor
  >[0];
}

describe("refresh cookie policy", () => {
  it("keeps a same-origin deployment strict", () => {
    const policy = cookiePolicyFor(request(undefined), true, "strict", CROSS_SITE);
    expect(policy).toEqual({ secure: true, sameSite: "strict" });
  });

  it("switches to SameSite=None for a configured cross-site origin", () => {
    const policy = cookiePolicyFor(
      request("https://admin.example.gov"),
      true,
      "strict",
      CROSS_SITE,
    );
    expect(policy).toEqual({ secure: true, sameSite: "none" });
  });

  it("ignores an origin the deployment does not trust", () => {
    const policy = cookiePolicyFor(request("https://evil.example"), true, "strict", CROSS_SITE);
    expect(policy).toEqual({ secure: true, sameSite: "strict" });
  });

  it("never emits SameSite=None without Secure, which browsers reject outright", () => {
    const policy = cookiePolicyFor(request("http://localhost:5173"), false, "none", [
      "http://localhost:5173",
    ]);
    expect(policy).toEqual({ secure: false, sameSite: "lax" });
  });

  it("honours an explicit SameSite=None on a same-origin deployment", () => {
    const policy = cookiePolicyFor(request(undefined), true, "none", []);
    expect(policy).toEqual({ secure: true, sameSite: "none" });
  });
});

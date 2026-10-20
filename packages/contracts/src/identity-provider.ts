import { PortError } from "@tpirs/ports";
import type { IdentityProvider } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { conformanceFixtures, withAdapter } from "./harness.js";

/** Factories must authenticate conformanceFixtures.identityUsername / identityPassword
 *  for tenant "conformance-tenant". */
export function createIdentityProviderConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<IdentityProvider>,
): void {
  const { describe, it, expect } = harness;

  describe("IdentityProvider conformance", () => {
    it("authenticates valid credentials into a session", () =>
      withAdapter(factory, async (identity) => {
        const session = await identity.authenticate({
          tenantId: "conformance-tenant",
          username: conformanceFixtures.identityUsername,
          password: conformanceFixtures.identityPassword,
        });
        expect(session.token.length > 0).toBe(true);
        expect(session.user.tenantId).toBe("conformance-tenant");
        expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
      }));

    it("rejects bad passwords with PortError unauthorized", () =>
      withAdapter(factory, async (identity) => {
        await expect(
          identity.authenticate({
            tenantId: "conformance-tenant",
            username: conformanceFixtures.identityUsername,
            password: "wrong-password",
          }),
        ).rejects.toThrow(PortError);
      }));

    it("verifies and revokes sessions", () =>
      withAdapter(factory, async (identity) => {
        const session = await identity.authenticate({
          tenantId: "conformance-tenant",
          username: conformanceFixtures.identityUsername,
          password: conformanceFixtures.identityPassword,
        });
        expect((await identity.verifySession(session.token)).userId).toBe(session.user.userId);
        await identity.revokeSession(session.token);
        await expect(identity.verifySession(session.token)).rejects.toThrow(PortError);
      }));

    it("revoking an unknown token succeeds", () =>
      withAdapter(factory, async (identity) => {
        await expect(identity.revokeSession("unknown-token")).resolves.toBeUndefined();
      }));
  });
}

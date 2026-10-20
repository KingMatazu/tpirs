import { describe, expect, it } from "vitest";
import { createIdentityProviderConformanceSuite } from "@tpirs/contracts";
import { createMockIdentityProvider } from "./index.js";

createIdentityProviderConformanceSuite({ describe, it, expect }, () => ({
  port: createMockIdentityProvider(),
}));

describe("createMockIdentityProvider", () => {
  it("supports adding users after construction", async () => {
    const identity = createMockIdentityProvider([]);
    identity.addUser({
      username: "later.user",
      password: "secret",
      identity: {
        userId: "u-2",
        tenantId: "t-1",
        displayName: "Later User",
        roles: ["finance"],
      },
    });
    const session = await identity.authenticate({
      tenantId: "t-1",
      username: "later.user",
      password: "secret",
    });
    expect(session.user.displayName).toBe("Later User");
  });
});

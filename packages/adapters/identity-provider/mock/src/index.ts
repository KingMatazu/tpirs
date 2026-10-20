import { PortError } from "@tpirs/ports";
import type {
  AuthSession,
  AuthenticateRequest,
  IdentityProvider,
  StaffIdentity,
} from "@tpirs/ports";
import { conformanceFixtures } from "@tpirs/contracts";

export interface MockIdentityUser {
  readonly username: string;
  readonly password: string;
  readonly identity: StaffIdentity;
}

export interface MockIdentityProvider extends IdentityProvider {
  /** Sessions issued so far, keyed by token (test inspection). */
  readonly sessions: Map<string, AuthSession>;
  addUser(user: MockIdentityUser): void;
}

export function createMockIdentityProvider(
  initialUsers: readonly MockIdentityUser[] = [
    {
      username: conformanceFixtures.identityUsername,
      password: conformanceFixtures.identityPassword,
      identity: {
        userId: "mock-user-1",
        tenantId: "conformance-tenant",
        displayName: "Conformance User",
        roles: ["officer"],
      },
    },
  ],
): MockIdentityProvider {
  const users = new Map(initialUsers.map((u) => [`${u.identity.tenantId}:${u.username}`, u]));
  const sessions = new Map<string, AuthSession>();
  let counter = 0;

  function unauthorized(message: string): PortError {
    return new PortError("IdentityProvider", "unauthorized", message);
  }

  return {
    sessions,
    authenticate(request: AuthenticateRequest): Promise<AuthSession> {
      const user = users.get(`${request.tenantId}:${request.username}`);
      if (user?.password !== request.password) {
        return Promise.reject(unauthorized("Invalid credentials"));
      }
      counter += 1;
      const session: AuthSession = {
        token: `mock-session-${String(counter)}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        user: user.identity,
      };
      sessions.set(session.token, session);
      return Promise.resolve(session);
    },
    verifySession(token): Promise<StaffIdentity> {
      const session = sessions.get(token);
      if (session === undefined) {
        return Promise.reject(unauthorized("Session is unknown or revoked"));
      }
      return Promise.resolve(session.user);
    },
    revokeSession(token) {
      sessions.delete(token);
      return Promise.resolve();
    },
    addUser(user) {
      users.set(`${user.identity.tenantId}:${user.username}`, user);
    },
  };
}

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

function issueToken(prefix: string, counter: number): string {
  return `mock-${prefix}-${String(counter)}`;
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
  const refreshOwners = new Map<string, { userKey: string; session: AuthSession }>();
  let counter = 0;

  function unauthorized(message: string): PortError {
    return new PortError("IdentityProvider", "unauthorized", message);
  }

  function issue(user: MockIdentityUser): AuthSession {
    counter += 1;
    const session: AuthSession = {
      token: issueToken("session", counter),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      user: user.identity,
      refreshToken: issueToken("refresh", counter),
      refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
    sessions.set(session.token, session);
    refreshOwners.set(session.refreshToken, {
      userKey: `${user.identity.tenantId}:${user.identity.displayName}`,
      session,
    });
    return session;
  }

  return {
    sessions,
    authenticate(request: AuthenticateRequest): Promise<AuthSession> {
      const user = users.get(`${request.tenantId}:${request.username}`);
      if (user?.password !== request.password) {
        return Promise.reject(unauthorized("Invalid credentials"));
      }
      return Promise.resolve(issue(user));
    },
    refreshSession(refreshToken: string): Promise<AuthSession> {
      const owner = refreshOwners.get(refreshToken);
      if (owner === undefined) {
        return Promise.reject(unauthorized("Session is unknown or revoked"));
      }
      // Single use: delete the old refresh token so replay fails closed.
      refreshOwners.delete(refreshToken);
      const userKey = owner.userKey;
      // Find the user by scanning initial users; the mock keeps its identity map.
      for (const user of users.values()) {
        if (`${user.identity.tenantId}:${user.identity.displayName}` === userKey) {
          return Promise.resolve(issue(user));
        }
      }
      return Promise.reject(unauthorized("Session is unknown or revoked"));
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
      // Best effort: if a refresh token is passed, drop its rotation entry.
      refreshOwners.delete(token);
      return Promise.resolve();
    },
    addUser(user) {
      users.set(`${user.identity.tenantId}:${user.username}`, user);
    },
  };
}

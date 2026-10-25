import { randomUUID } from "node:crypto";
import { PortError } from "@tpirs/ports";
import type {
  AuthSession,
  AuthenticateRequest,
  DeviceRegistration,
  IdentityProvider,
  StaffIdentity,
} from "@tpirs/ports";
import { hashToken, verifyPassword, verifyTotp } from "@tpirs/crypto";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";

export interface DbIdentityProviderOptions {
  readonly db: AnyDb;
  /** Access token lifetime in seconds. */
  readonly sessionTtlSeconds?: number;
  /** Refresh token lifetime in seconds (default 30 days). */
  readonly refreshTtlSeconds?: number;
  /** When true, a TOTP code is required for every authentication. */
  readonly requireTotp?: boolean;
}

function unauthorized(message: string): PortError {
  return new PortError("IdentityProvider", "unauthorized", message);
}

function issueToken(): string {
  return randomUUID() + randomUUID();
}

function staffIdentity(
  userId: string,
  tenantId: string,
  displayName: string,
  roles: readonly string[],
): StaffIdentity {
  return {
    userId,
    tenantId,
    displayName,
    roles: [...roles],
  };
}

/**
 * IdentityProvider backed by Postgres. Every read/write runs inside a tenant
 * scope so row-level security confines it to the requested tenant. Passwords
 * are scrypt hashes; sessions are opaque random tokens stored only as hashes.
 */
export function createDbIdentityProvider(options: DbIdentityProviderOptions): IdentityProvider {
  const { db } = options;
  const sessionTtlSeconds = options.sessionTtlSeconds ?? 12 * 60 * 60;
  const refreshTtlSeconds = options.refreshTtlSeconds ?? 30 * 24 * 60 * 60;
  const requireTotp = options.requireTotp ?? false;

  async function bindDevice(
    tenantId: string,
    userId: string,
    device: DeviceRegistration,
  ): Promise<void> {
    await withTenant(db, tenantId, async (tx) => {
      await repositories(tx).devices.bind({
        tenantId,
        userId,
        deviceId: device.deviceId,
        platform: device.platform,
      });
    });
  }

  async function loadIdentity(db: AnyDb, tenantId: string, userId: string): Promise<StaffIdentity> {
    return withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      const user = await repos.users.findById(userId);
      if (user?.status !== "active") {
        throw unauthorized("User is not active");
      }
      const roles = await repos.roles.roleKeysForUser(user.id);
      return staffIdentity(user.id, tenantId, user.displayName, roles);
    });
  }

  async function findSessionTenant(
    tokenHash: string,
  ): Promise<{ tenantId: string; userId: string; kind: "access" | "refresh" } | undefined> {
    const row = await db
      .selectFrom("sessions")
      .select(["tenantId", "userId", "kind"])
      .where("tokenHash", "=", tokenHash)
      .executeTakeFirst();
    if (row?.tenantId == null) {
      return undefined;
    }
    return { tenantId: row.tenantId, userId: row.userId, kind: row.kind as "access" | "refresh" };
  }

  async function issueSessionPair(
    tenantId: string,
    userId: string,
  ): Promise<{
    accessToken: string;
    accessExpiresAt: Date;
    refreshToken: string;
    refreshExpiresAt: Date;
    identity: StaffIdentity;
  }> {
    const identity = await loadIdentity(db, tenantId, userId);
    const accessToken = issueToken();
    const refreshToken = issueToken();
    const accessExpiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
    const refreshExpiresAt = new Date(Date.now() + refreshTtlSeconds * 1000);
    await withTenant(db, tenantId, async (tx) => {
      const repos = repositories(tx);
      await repos.sessions.create({
        tenantId,
        userId,
        tokenHash: hashToken(accessToken),
        kind: "access",
        expiresAt: accessExpiresAt,
      });
      await repos.sessions.create({
        tenantId,
        userId,
        tokenHash: hashToken(refreshToken),
        kind: "refresh",
        expiresAt: refreshExpiresAt,
      });
    });
    return { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, identity };
  }

  return {
    authenticate(request: AuthenticateRequest): Promise<AuthSession> {
      return (async () => {
        const result = await withTenant(db, request.tenantId, async (tx) => {
          const repos = repositories(tx);
          const user = await repos.users.findByUsername(request.username);
          if (user === undefined) {
            return { ok: false as const };
          }
          if (user.status !== "active") {
            return { ok: false as const };
          }
          if (!(await verifyPassword(request.password, user.passwordHash))) {
            return { ok: false as const };
          }
          if (requireTotp || user.totpSecret !== null) {
            if (
              user.totpSecret !== null &&
              (request.totpCode === undefined ||
                !verifyTotp(user.totpSecret, request.totpCode, new Date(), { window: 1 }))
            ) {
              return { ok: false as const };
            }
          }
          return { ok: true as const, userId: user.id };
        });

        if (!result.ok) throw unauthorized("Invalid credentials");
        const pair = await issueSessionPair(request.tenantId, result.userId);
        if (request.device !== undefined) {
          await bindDevice(request.tenantId, pair.identity.userId, request.device);
        }
        return {
          token: pair.accessToken,
          expiresAt: pair.accessExpiresAt,
          user: pair.identity,
          refreshToken: pair.refreshToken,
          refreshExpiresAt: pair.refreshExpiresAt,
        };
      })();
    },

    refreshSession(refreshToken: string): Promise<AuthSession> {
      return (async () => {
        const tokenHash = hashToken(refreshToken);
        // Rotation must be atomic: revoke the presented refresh token and
        // create a new pair before returning. The sessions table is tenant-scoped,
        // so discover the tenant under system privileges then rotate inside that
        // tenant scope.
        const discovery = await findSessionTenant(tokenHash);
        if (discovery === undefined) throw unauthorized("Session is unknown or revoked");
        if (discovery.kind !== "refresh") throw unauthorized("Session is unknown or revoked");

        const rotated = await withTenant(db, discovery.tenantId, async (tx) => {
          const repos = repositories(tx);
          const session = await repos.sessions.findByTokenHash(tokenHash);
          if (session === undefined) {
            throw unauthorized("Session is unknown or revoked");
          }
          if (session.revokedAt !== null) {
            throw unauthorized("Session is unknown or revoked");
          }
          if ((session as { kind?: string }).kind !== "refresh") {
            throw unauthorized("Session is unknown or revoked");
          }
          if (session.expiresAt.getTime() <= Date.now()) {
            throw unauthorized("Session has expired");
          }
          // Single use: revoking must succeed; if another call already did it,
          // the row is gone from the active set and the second caller gets 401.
          const revoked = await repos.sessions.revoke(tokenHash);
          if (!revoked) {
            throw unauthorized("Session is unknown or revoked");
          }
          return issueSessionPair(discovery.tenantId, discovery.userId);
        });

        return {
          token: rotated.accessToken,
          expiresAt: rotated.accessExpiresAt,
          user: rotated.identity,
          refreshToken: rotated.refreshToken,
          refreshExpiresAt: rotated.refreshExpiresAt,
        };
      })();
    },

    verifySession(token: string): Promise<StaffIdentity> {
      return (async () => {
        const tokenHash = hashToken(token);
        const discovery = await findSessionTenant(tokenHash);
        if (discovery === undefined) throw unauthorized("Session is unknown or revoked");
        if (discovery.kind !== "access") throw unauthorized("Session is unknown or revoked");
        return withTenant(db, discovery.tenantId, async (tx) => {
          const repos = repositories(tx);
          const session = await repos.sessions.findByTokenHash(tokenHash);
          if (session === undefined) {
            throw unauthorized("Session is unknown or revoked");
          }
          if (session.revokedAt !== null) {
            throw unauthorized("Session is unknown or revoked");
          }
          if ((session as { kind?: string }).kind !== "access") {
            throw unauthorized("Session is unknown or revoked");
          }
          if (session.expiresAt.getTime() <= Date.now()) {
            throw unauthorized("Session has expired");
          }
          const user = await repos.users.findById(session.userId);
          if (user?.status !== "active") {
            throw unauthorized("User is not active");
          }
          const roles = await repos.roles.roleKeysForUser(user.id);
          return staffIdentity(user.id, discovery.tenantId, user.displayName, roles);
        });
      })();
    },

    revokeSession(token: string): Promise<void> {
      return (async () => {
        const tokenHash = hashToken(token);
        const discovery = await findSessionTenant(tokenHash);
        if (discovery === undefined) return;
        await withTenant(db, discovery.tenantId, async (tx) => {
          await repositories(tx).sessions.revoke(tokenHash);
        });
      })();
    },
  };
}

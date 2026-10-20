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
  /** Session lifetime in seconds. */
  readonly sessionTtlSeconds?: number;
  /** When true, a TOTP code is required for every authentication. */
  readonly requireTotp?: boolean;
}

function unauthorized(message: string): PortError {
  return new PortError("IdentityProvider", "unauthorized", message);
}

/**
 * IdentityProvider backed by Postgres. Every read/write runs inside a tenant
 * scope so row-level security confines it to the requested tenant. Passwords
 * are scrypt hashes; sessions are opaque random tokens stored only as hashes.
 */
export function createDbIdentityProvider(options: DbIdentityProviderOptions): IdentityProvider {
  const { db } = options;
  const sessionTtlSeconds = options.sessionTtlSeconds ?? 12 * 60 * 60;
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
          const token = randomUUID() + randomUUID();
          const tokenHash = hashToken(token);
          const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
          await repos.sessions.create({
            tenantId: request.tenantId,
            userId: user.id,
            tokenHash,
            expiresAt,
          });
          const roles = await repos.roles.roleKeysForUser(user.id);
          const identity: StaffIdentity = {
            userId: user.id,
            tenantId: request.tenantId,
            displayName: user.displayName,
            roles: [...roles],
          };
          return { ok: true as const, token, expiresAt, identity };
        });

        if (!result.ok) throw unauthorized("Invalid credentials");
        if (request.device !== undefined) {
          await bindDevice(request.tenantId, result.identity.userId, request.device);
        }
        return {
          token: result.token,
          expiresAt: result.expiresAt,
          user: result.identity,
        };
      })();
    },

    verifySession(token: string): Promise<StaffIdentity> {
      return (async () => {
        // Sessions are tenant-scoped, but a token does not reveal its tenant.
        // The sessions table is queried by token hash under system privileges
        // to discover the tenant, then re-read within that tenant's scope.
        const tenantId = await findSessionTenant(db, hashToken(token));
        if (tenantId === undefined) throw unauthorized("Session is unknown or revoked");
        return withTenant(db, tenantId, async (tx) => {
          const repos = repositories(tx);
          const session = await repos.sessions.findByTokenHash(hashToken(token));
          if (session === undefined) {
            throw unauthorized("Session is unknown or revoked");
          }
          if (session.revokedAt !== null) {
            throw unauthorized("Session is unknown or revoked");
          }
          if (session.expiresAt.getTime() <= Date.now()) {
            throw unauthorized("Session has expired");
          }
          const user = await repos.users.findById(session.userId);
          if (user === undefined) {
            throw unauthorized("User is not active");
          }
          if (user.status !== "active") {
            throw unauthorized("User is not active");
          }
          const roles = await repos.roles.roleKeysForUser(user.id);
          return {
            userId: user.id,
            tenantId,
            displayName: user.displayName,
            roles: [...roles],
          };
        });
      })();
    },

    revokeSession(token: string): Promise<void> {
      return (async () => {
        const tenantId = await findSessionTenant(db, hashToken(token));
        if (tenantId === undefined) return;
        await withTenant(db, tenantId, async (tx) => {
          await repositories(tx).sessions.revoke(hashToken(token));
        });
      })();
    },
  };
}

/** Resolves the tenant that owns a session token hash, using system privileges. */
async function findSessionTenant(db: AnyDb, tokenHash: string): Promise<string | undefined> {
  const row = await db
    .selectFrom("sessions")
    .select("tenantId")
    .where("tokenHash", "=", tokenHash)
    .executeTakeFirst();
  return row?.tenantId;
}

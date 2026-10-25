export interface StaffIdentity {
  readonly userId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export interface DeviceRegistration {
  readonly deviceId: string;
  readonly platform: string;
}

export interface AuthenticateRequest {
  readonly tenantId: string;
  readonly username: string;
  readonly password: string;
  readonly totpCode?: string;
  readonly device?: DeviceRegistration;
}

export interface AuthSession {
  readonly token: string;
  readonly expiresAt: Date;
  readonly user: StaffIdentity;
  /** Long-lived, single-use token for silent re-login (ADR 0026). */
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export interface IdentityProvider {
  /** Throws PortError("unauthorized") on bad credentials or TOTP. */
  authenticate(request: AuthenticateRequest): Promise<AuthSession>;
  /**
   * Exchanges a refresh token for a new access/refresh pair, revoking the used
   * refresh token in the same transaction (single use). Throws
   * PortError("unauthorized") when the token is unknown, revoked, or expired.
   */
  refreshSession(refreshToken: string): Promise<AuthSession>;
  /** Throws PortError("unauthorized") when the token is unknown or expired. */
  verifySession(token: string): Promise<StaffIdentity>;
  /** Idempotent: revoking an unknown token succeeds. */
  revokeSession(token: string): Promise<void>;
}

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
}

export interface IdentityProvider {
  /** Throws PortError("unauthorized") on bad credentials or TOTP. */
  authenticate(request: AuthenticateRequest): Promise<AuthSession>;
  /** Throws PortError("unauthorized") when the token is unknown or expired. */
  verifySession(token: string): Promise<StaffIdentity>;
  /** Idempotent: revoking an unknown token succeeds. */
  revokeSession(token: string): Promise<void>;
}

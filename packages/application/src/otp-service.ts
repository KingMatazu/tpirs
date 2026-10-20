import { hashToken, randomOpaqueId, randomNumericCode } from "@tpirs/crypto";
import type { Cache, Clock, SmsProvider } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";

export interface OtpServiceDeps {
  readonly cache: Cache;
  readonly sms: SmsProvider;
  readonly clock: Clock;
  /** Defaults applied when a call site does not override them. */
  readonly defaults?: {
    readonly codeDigits?: number;
    readonly ttlSeconds?: number;
    readonly maxAttempts?: number;
    readonly sendWindowSeconds?: number;
    readonly maxSendsPerWindow?: number;
  };
}

export interface RequestOtpInput {
  readonly tenantId: string;
  readonly phone: string;
  /** Pre-rendered SMS body; must already contain the substituted code. */
  readonly message: (code: string) => string;
  readonly senderId?: string;
  readonly purpose?: string;
}

export interface VerifyOtpInput {
  readonly tenantId: string;
  readonly phone: string;
  readonly code: string;
  readonly purpose?: string;
}

export class OtpError extends Error {
  readonly code: "not_found" | "expired" | "too_many_attempts" | "rate_limited";

  constructor(code: OtpError["code"], message: string) {
    super(message);
    this.name = "OtpError";
    this.code = code;
  }
}

interface OtpRecord {
  readonly hash: string;
  readonly attempts: number;
  readonly createdAt: string;
}

const DEFAULTS = {
  codeDigits: 6,
  ttlSeconds: 300,
  maxAttempts: 5,
  sendWindowSeconds: 3600,
  maxSendsPerWindow: 3,
} as const;

function normalizePhone(phone: string): string {
  return phone.trim().replaceAll(/\s+/g, "");
}

function digest(tenantId: string, phone: string, code: string, purpose: string): string {
  return hashToken(`${tenantId}:${phone}:${purpose}:${code}`);
}

/**
 * Phone verification for asset owners. Codes are stored only as salted hashes,
 * sending is rate limited per phone, and verification is attempt limited. SMS
 * text is supplied by the caller from tenant config so no message text is
 * hardcoded here.
 */
export function createOtpService(deps: OtpServiceDeps) {
  const config = { ...DEFAULTS, ...deps.defaults };

  function codeKey(tenantId: string, phone: string, purpose: string): string {
    return `otp:${tenantId}:${purpose}:${phone}`;
  }

  function sendKey(tenantId: string, phone: string, purpose: string): string {
    return `otp-sends:${tenantId}:${purpose}:${phone}`;
  }

  async function requestOtp(input: RequestOtpInput): Promise<{ readonly sent: true }> {
    const phone = normalizePhone(input.phone);
    if (phone.length === 0) {
      throw new OtpError("not_found", "A phone number is required");
    }
    const purpose = input.purpose ?? "owner_verification";

    const existingSends = await deps.cache.get(sendKey(input.tenantId, phone, purpose));
    const sendCount = typeof existingSends === "number" ? existingSends : 0;
    if (sendCount >= config.maxSendsPerWindow) {
      throw new OtpError(
        "rate_limited",
        "Too many verification codes requested for this number; try again later",
      );
    }

    const code = randomNumericCode(config.codeDigits);
    const record: OtpRecord = {
      hash: digest(input.tenantId, phone, code, purpose),
      attempts: 0,
      createdAt: deps.clock.now().toISOString(),
    };
    await deps.cache.set(codeKey(input.tenantId, phone, purpose), record, config.ttlSeconds);
    await deps.cache.set(
      sendKey(input.tenantId, phone, purpose),
      sendCount + 1,
      config.sendWindowSeconds,
    );

    try {
      await deps.sms.send({
        to: phone,
        text: input.message(code),
        idempotencyKey: randomOpaqueId(),
        ...(input.senderId === undefined ? {} : { senderId: input.senderId }),
      });
    } catch (error) {
      await deps.cache.delete(codeKey(input.tenantId, phone, purpose));
      if (error instanceof PortError) throw error;
      throw new PortError("OtpService", "provider_error", "Failed to send verification code");
    }

    return { sent: true };
  }

  async function verifyOtp(input: VerifyOtpInput): Promise<{ readonly verified: true }> {
    const phone = normalizePhone(input.phone);
    const purpose = input.purpose ?? "owner_verification";
    const key = codeKey(input.tenantId, phone, purpose);
    const stored = await deps.cache.get(key);
    if (stored === undefined || stored === null) {
      throw new OtpError("not_found", "No verification code is pending for this number");
    }
    const record = stored as OtpRecord;
    if (record.attempts >= config.maxAttempts) {
      await deps.cache.delete(key);
      throw new OtpError("too_many_attempts", "Too many incorrect attempts; request a new code");
    }
    const expected = digest(input.tenantId, phone, input.code, purpose);
    if (expected !== record.hash) {
      const attempts = record.attempts + 1;
      if (attempts >= config.maxAttempts) {
        await deps.cache.delete(key);
        throw new OtpError("too_many_attempts", "Too many incorrect attempts; request a new code");
      }
      await deps.cache.set(key, { ...record, attempts }, config.ttlSeconds);
      throw new OtpError("not_found", "The verification code is incorrect");
    }
    await deps.cache.delete(key);
    return { verified: true };
  }

  return { requestOtp, verifyOtp };
}

export type OtpService = ReturnType<typeof createOtpService>;

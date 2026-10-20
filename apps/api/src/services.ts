import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { createQrTokenSigner } from "@tpirs/crypto";
import type { AnyDb } from "@tpirs/db";
import type { AssetService, OtpService, OwnerService } from "@tpirs/application";
import type { QrTokenSigner } from "@tpirs/domain";
import { createAssetService, createOtpService, createOwnerService } from "@tpirs/application";
import { createConfigAssetSchemaRegistry } from "@tpirs/asset-schema-registry-config";
import type { Cache, Clock, ObjectStorage, SecretsProvider, SmsProvider } from "@tpirs/ports";
import { readTenantConfig } from "./tenants.js";

/**
 * Loads and validates a tenant's stored configuration document. Returns
 * undefined when the tenant is unknown; throws when config is present but
 * invalid, so a broken config fails loudly rather than silently.
 */
export function makeTenantConfigLoader(
  db: AnyDb,
): (tenantId: string) => Promise<TenantConfig | undefined> {
  return async (tenantId) => {
    const stored = await readTenantConfig(db, tenantId);
    if (stored === undefined) return undefined;
    return validateTenantConfig(stored.config);
  };
}

export interface ServiceDeps {
  readonly db: AnyDb;
  readonly objectStorage: ObjectStorage;
  readonly secrets: SecretsProvider;
  readonly sms: SmsProvider;
  readonly cache: Cache;
  readonly clock: Clock;
  /** Secret reference holding the per-deployment QR signing key. */
  readonly qrKeyRef: string;
}

export interface Services {
  readonly asset: AssetService;
  readonly owner: OwnerService;
  readonly otp: OtpService;
  /** Verifies presented QR tokens; also used by the public verify route. */
  readonly qrSigner: QrTokenSigner;
}

/**
 * Application services shared by routes. The QR signing key is read from the
 * SecretsProvider by reference; no secret is ever read from the environment in
 * core code.
 */
export async function buildServices(deps: ServiceDeps): Promise<Services> {
  const loadConfig = makeTenantConfigLoader(deps.db);
  const qrKey = await deps.secrets.getSecret(deps.qrKeyRef);
  const qrSigner = createQrTokenSigner(qrKey);

  const asset = createAssetService({
    db: deps.db,
    registry: createConfigAssetSchemaRegistry({ loadConfig }),
    qrSigner,
    objectStorage: deps.objectStorage,
    loadConfig,
  });
  const owner = createOwnerService({ db: deps.db });
  const otp = createOtpService({ cache: deps.cache, sms: deps.sms, clock: deps.clock });

  return { asset, owner, otp, qrSigner };
}

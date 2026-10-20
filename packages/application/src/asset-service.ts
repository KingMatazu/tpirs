import {
  buildQrToken,
  formatStickerCode,
  parseQrToken,
  qrPayload,
  tenantId as asTenantId,
} from "@tpirs/domain";
import type { AssetStatus, QrTokenSigner } from "@tpirs/domain";
import type { AssetSchemaRegistry, ObjectStorage } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";
import { randomOpaqueId } from "@tpirs/crypto";
import { repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { AssetRecord } from "@tpirs/db";
import type { TenantConfig } from "@tpirs/config";
import { renderAssetSticker } from "./sticker.js";

export type TenantConfigLoader = (tenantId: string) => Promise<TenantConfig | undefined>;

export interface AssetServiceDeps {
  readonly db: AnyDb;
  readonly registry: AssetSchemaRegistry;
  readonly qrSigner: QrTokenSigner;
  readonly objectStorage: ObjectStorage;
  readonly loadConfig: TenantConfigLoader;
}

export interface RegisterAssetInput {
  readonly tenantId: string;
  readonly assetTypeKey: string;
  readonly zoneId?: string | null;
  readonly ownerId?: string | null;
  readonly owner?: { readonly displayName: string; readonly phone: string } | undefined;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly createdByUserId?: string | null;
}

export interface AttachPhotoInput {
  readonly tenantId: string;
  readonly assetId: string;
  readonly contentType: string;
  readonly body: Uint8Array | string;
  readonly createdByUserId?: string | null;
}

export interface AssetSearchQuery {
  readonly tenantId: string;
  readonly assetTypeKey?: string;
  readonly status?: AssetStatus;
  readonly zoneId?: string;
  readonly ownerId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export class AssetValidationError extends Error {
  readonly errors: readonly { readonly attribute: string; readonly message: string }[];

  constructor(errors: readonly { readonly attribute: string; readonly message: string }[]) {
    super("Asset attributes are invalid");
    this.name = "AssetValidationError";
    this.errors = errors;
  }
}

export class AssetNotFoundError extends Error {
  constructor(message = "Asset not found") {
    super(message);
    this.name = "AssetNotFoundError";
  }
}

async function requireConfig(deps: AssetServiceDeps, tenantId: string): Promise<TenantConfig> {
  const config = await deps.loadConfig(tenantId);
  if (config === undefined) {
    throw new PortError(
      "AssetSchemaRegistry",
      "not_found",
      `No configuration found for tenant "${tenantId}"`,
    );
  }
  return config;
}

function assetTypeFromConfig(
  config: TenantConfig,
  typeKey: string,
): TenantConfig["assetTypes"][number] | undefined {
  return config.assetTypes.find((type) => type.key === typeKey);
}

/**
 * Asset registry use cases. Every operation runs inside the tenant's row-level
 * security scope; format strings (QR, short code) and the sticker spec come from
 * tenant config, never from code, so a new state is onboarding, not a fork.
 */
export function createAssetService(deps: AssetServiceDeps) {
  async function register(input: RegisterAssetInput): Promise<AssetRecord> {
    const config = await requireConfig(deps, input.tenantId);
    const type = assetTypeFromConfig(config, input.assetTypeKey);
    if (type === undefined) {
      throw new PortError(
        "AssetSchemaRegistry",
        "not_found",
        `Asset type "${input.assetTypeKey}" is not defined in tenant config`,
      );
    }

    const validation = await deps.registry.validateAttributes(
      asTenantId(input.tenantId),
      input.assetTypeKey,
      input.attributes,
    );
    if (!validation.ok) {
      throw new AssetValidationError(validation.errors);
    }

    const payload = randomOpaqueId();
    const token = buildQrToken(payload, deps.qrSigner);
    const shortCode = formatStickerCode(type.shortCodeFormat, payload);

    return withTenant(deps.db, input.tenantId, async (tx) => {
      const repos = repositories(tx);
      let ownerId = input.ownerId ?? null;
      if (input.owner !== undefined) {
        const created = await repos.owners.create({
          tenantId: input.tenantId,
          displayName: input.owner.displayName,
          phone: input.owner.phone,
        });
        ownerId = created.id;
      }
      return repos.assets.create({
        tenantId: input.tenantId,
        zoneId: input.zoneId ?? null,
        ownerId,
        assetTypeKey: input.assetTypeKey,
        attributes: { ...input.attributes },
        qrPayload: qrPayload(payload),
        qrToken: token,
        shortCode,
        createdByUserId: input.createdByUserId ?? null,
      });
    });
  }

  async function attachPhoto(input: AttachPhotoInput): Promise<void> {
    const asset = await getById(input.tenantId, input.assetId);
    const extension = input.contentType.split("/")[1] ?? "bin";
    const objectKey = `tenants/${input.tenantId}/assets/${asset.id}/${randomOpaqueId()}.${extension}`;
    await deps.objectStorage.put({
      key: objectKey,
      body: input.body,
      contentType: input.contentType,
    });
    await withTenant(deps.db, input.tenantId, async (tx) => {
      await repositories(tx).assetPhotos.create({
        tenantId: input.tenantId,
        assetId: asset.id,
        objectKey,
        contentType: input.contentType,
        createdByUserId: input.createdByUserId ?? null,
      });
    });
  }

  async function getById(tenantId: string, assetId: string): Promise<AssetRecord> {
    const asset = await withTenant(deps.db, tenantId, async (tx) =>
      repositories(tx).assets.findById(assetId),
    );
    if (asset === undefined) throw new AssetNotFoundError();
    return asset;
  }

  async function search(query: AssetSearchQuery): Promise<readonly AssetRecord[]> {
    return withTenant(deps.db, query.tenantId, async (tx) =>
      repositories(tx).assets.search({
        ...(query.assetTypeKey === undefined ? {} : { assetTypeKey: query.assetTypeKey }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.zoneId === undefined ? {} : { zoneId: query.zoneId }),
        ...(query.ownerId === undefined ? {} : { ownerId: query.ownerId }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      }),
    );
  }

  async function listPhotos(tenantId: string, assetId: string) {
    return withTenant(deps.db, tenantId, async (tx) =>
      repositories(tx).assetPhotos.listForAsset(assetId),
    );
  }

  /**
   * Loads a photo's metadata and bytes for download. The asset must exist in
   * the tenant's scope first, so a cross-tenant probe never reveals whether a
   * photo id exists.
   */
  async function getPhoto(
    tenantId: string,
    assetId: string,
    photoId: string,
  ): Promise<{ readonly contentType: string; readonly body: Uint8Array }> {
    const photo = await withTenant(deps.db, tenantId, async (tx) =>
      repositories(tx).assetPhotos.findForAsset(photoId, assetId),
    );
    if (photo === undefined) throw new AssetNotFoundError("Asset photo not found");
    const object = await deps.objectStorage.get(photo.objectKey);
    return { contentType: photo.contentType, body: object.body };
  }

  /**
   * Resolves a presented QR token to its asset. The token is verified first
   * (forged checksums fail closed before any lookup), then the opaque payload
   * is searched across tenants under the system scope, because the token
   * itself reveals nothing about its tenant. Throws InvalidQrTokenError for a
   * bad token and AssetNotFoundError when no asset owns the payload — both
   * surface as the same 404 so probing cannot distinguish them.
   */
  async function verifyQrToken(token: string): Promise<{
    readonly asset: AssetRecord;
    readonly photos: readonly { readonly id: string; readonly contentType: string }[];
  }> {
    const payload = parseQrToken(token, deps.qrSigner);
    const asset = await withSystem(deps.db, (tx) =>
      repositories(tx).assets.findByQrPayload(payload),
    );
    if (asset === undefined) throw new AssetNotFoundError();
    const photos = await withSystem(deps.db, (tx) =>
      repositories(tx).assetPhotos.listForAsset(asset.id),
    );
    return { asset, photos };
  }

  /**
   * Renders the printable sticker for an asset as SVG. Branding, asset-type
   * label, and sticker dimensions all come from tenant config.
   */
  async function getSticker(tenantId: string, assetId: string): Promise<string> {
    const asset = await getById(tenantId, assetId);
    const config = await requireConfig(deps, tenantId);
    const type = assetTypeFromConfig(config, asset.assetTypeKey);
    return renderAssetSticker({
      qrToken: asset.qrToken,
      shortCode: asset.shortCode,
      appName: config.branding.appName,
      primaryColor: config.branding.colors.primary,
      secondaryColor: config.branding.colors.secondary,
      accentColor: config.branding.colors.accent,
      assetTypeLabel: type?.label ?? asset.assetTypeKey,
      stickerSpec: type?.stickerSpec ?? "",
    });
  }

  async function setStatus(
    tenantId: string,
    assetId: string,
    status: AssetStatus,
  ): Promise<AssetRecord> {
    const existing = await withTenant(deps.db, tenantId, async (tx) =>
      repositories(tx).assets.findById(assetId),
    );
    if (existing === undefined) throw new AssetNotFoundError();
    return withTenant(deps.db, tenantId, async (tx) =>
      repositories(tx).assets.update(assetId, { status }),
    );
  }

  async function correctAttributes(
    tenantId: string,
    assetId: string,
    attributes: Readonly<Record<string, unknown>>,
  ): Promise<AssetRecord> {
    const existing = await getById(tenantId, assetId);
    const validation = await deps.registry.validateAttributes(
      asTenantId(tenantId),
      existing.assetTypeKey,
      attributes,
    );
    if (!validation.ok) {
      throw new AssetValidationError(validation.errors);
    }
    return withTenant(deps.db, tenantId, async (tx) =>
      repositories(tx).assets.update(assetId, { attributes: { ...attributes } }),
    );
  }

  return {
    register,
    attachPhoto,
    getById,
    search,
    listPhotos,
    getPhoto,
    getSticker,
    setStatus,
    correctAttributes,
    verifyQrToken,
  };
}

export type AssetService = ReturnType<typeof createAssetService>;

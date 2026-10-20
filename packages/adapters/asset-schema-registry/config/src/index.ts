import { assetTypeId, validateAttributesAgainstSchema } from "@tpirs/domain";
import type { AssetTypeDefinition, AttributeSchema, TenantId } from "@tpirs/domain";
import type { TenantConfig } from "@tpirs/config";
import { PortError } from "@tpirs/ports";
import type { AssetSchemaRegistry, ValidationResult } from "@tpirs/ports";

/**
 * Loads a tenant's validated configuration. Injected so this adapter holds no
 * database or tenant-resolution logic; a request handler passes a loader backed
 * by the tenant config repository.
 */
export type TenantConfigLoader = (tenantId: string) => Promise<TenantConfig | undefined>;

export interface ConfigAssetSchemaRegistryOptions {
  readonly loadConfig: TenantConfigLoader;
  /**
   * Prefix for synthesised AssetTypeId values. Config asset types have no
   * numeric id; a stable per-tenant string keeps ids unique and reproducible.
   */
  readonly idPrefix?: string;
}

const ATTRIBUTE_TYPES = new Set(["string", "number", "date", "enum"]);

function toAttributeSchema(
  attribute: TenantConfig["assetTypes"][number]["attributes"][number],
): AttributeSchema {
  if (!ATTRIBUTE_TYPES.has(attribute.type)) {
    throw new PortError(
      "AssetSchemaRegistry",
      "invalid_request",
      `Unsupported attribute type "${attribute.type}" for "${attribute.key}"`,
    );
  }
  return {
    key: attribute.key,
    label: attribute.label,
    type: attribute.type,
    required: attribute.required,
    ...(attribute.options === undefined ? {} : { options: attribute.options }),
    ...(attribute.pattern === undefined ? {} : { pattern: attribute.pattern }),
  };
}

function toDefinition(
  idPrefix: string,
  tenantId: string,
  type: TenantConfig["assetTypes"][number],
): AssetTypeDefinition {
  return {
    id: assetTypeId(`${idPrefix}:${tenantId}:${type.key}`),
    key: type.key,
    name: type.label,
    attributes: type.attributes.map(toAttributeSchema),
  };
}

async function requireConfig(loader: TenantConfigLoader, tenantId: string): Promise<TenantConfig> {
  const config = await loader(tenantId);
  if (config === undefined) {
    throw new PortError(
      "AssetSchemaRegistry",
      "not_found",
      `No configuration found for tenant "${tenantId}"`,
    );
  }
  return config;
}

/**
 * Reads asset types from the tenant configuration. This is the production
 * adapter for AssetSchemaRegistry: onboarding a new asset type is a config
 * change, not a code change (build brief section 1.3).
 */
export function createConfigAssetSchemaRegistry(
  options: ConfigAssetSchemaRegistryOptions,
): AssetSchemaRegistry {
  const idPrefix = options.idPrefix ?? "config";

  function findType(config: TenantConfig, typeKey: string): AssetTypeDefinition | undefined {
    const type = config.assetTypes.find((candidate) => candidate.key === typeKey);
    return type === undefined ? undefined : toDefinition(idPrefix, config.identity.slug, type);
  }

  return {
    async listTypes(tenantId: TenantId): Promise<readonly AssetTypeDefinition[]> {
      const config = await requireConfig(options.loadConfig, tenantId);
      return config.assetTypes.map((type) => toDefinition(idPrefix, config.identity.slug, type));
    },

    async getType(tenantId: TenantId, typeKey: string): Promise<AssetTypeDefinition> {
      const config = await requireConfig(options.loadConfig, tenantId);
      const definition = findType(config, typeKey);
      if (definition === undefined) {
        throw new PortError(
          "AssetSchemaRegistry",
          "not_found",
          `Asset type "${typeKey}" not found for tenant "${tenantId}"`,
        );
      }
      return definition;
    },

    async validateAttributes(
      tenantId: TenantId,
      typeKey: string,
      attributes: Readonly<Record<string, unknown>>,
    ): Promise<ValidationResult> {
      const config = await requireConfig(options.loadConfig, tenantId);
      const definition = findType(config, typeKey);
      if (definition === undefined) {
        throw new PortError(
          "AssetSchemaRegistry",
          "not_found",
          `Asset type "${typeKey}" not found for tenant "${tenantId}"`,
        );
      }
      return validateAttributesAgainstSchema(definition.attributes, attributes);
    },
  };
}

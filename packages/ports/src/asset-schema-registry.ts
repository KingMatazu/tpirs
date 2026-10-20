import type { AssetTypeDefinition, AssetTypeId, TenantId, ValidationResult } from "@tpirs/domain";

export type {
  AssetTypeDefinition,
  AttributeSchema,
  AttributeValidationError,
  ValidationResult,
} from "@tpirs/domain";

export interface AssetSchemaRegistry {
  listTypes(tenantId: TenantId): Promise<readonly AssetTypeDefinition[]>;
  /** Throws PortError("not_found") for unknown type keys. */
  getType(tenantId: TenantId, typeKey: string): Promise<AssetTypeDefinition>;
  validateAttributes(
    tenantId: TenantId,
    typeKey: string,
    attributes: Readonly<Record<string, unknown>>,
  ): Promise<ValidationResult>;
}

export type { AssetTypeId, TenantId };

import type { AssetTypeId, TenantId } from "@tpirs/domain";

export interface AttributeSchema {
  readonly key: string;
  readonly label: string;
  readonly type: "string" | "number" | "date" | "enum";
  readonly required: boolean;
  readonly options?: readonly string[];
}

export interface AssetTypeDefinition {
  readonly id: AssetTypeId;
  readonly key: string;
  readonly name: string;
  readonly attributes: readonly AttributeSchema[];
}

export interface AttributeValidationError {
  readonly attribute: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly AttributeValidationError[];
}

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

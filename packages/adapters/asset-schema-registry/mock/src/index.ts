import { assetTypeId } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import type {
  AssetSchemaRegistry,
  AssetTypeDefinition,
  AttributeSchema,
  AttributeValidationError,
  ValidationResult,
} from "@tpirs/ports";
import { conformanceFixtures } from "@tpirs/contracts";

export interface MockAssetTypeSeed {
  readonly tenantId: string;
  readonly definition: AssetTypeDefinition;
}

export const defaultMockAssetTypeSeed: MockAssetTypeSeed = {
  tenantId: "conformance-tenant",
  definition: {
    id: assetTypeId(conformanceFixtures.assetTypeKey),
    key: conformanceFixtures.assetTypeKey,
    name: "Bike",
    attributes: [
      {
        key: conformanceFixtures.requiredAttributeKey,
        label: "Plate number",
        type: "string",
        required: true,
      },
      { key: "colour", label: "Colour", type: "string", required: false },
    ],
  },
};

export interface MockAssetSchemaRegistry extends AssetSchemaRegistry {
  registerType(tenantId: string, definition: AssetTypeDefinition): void;
}

function validateAgainstSchema(
  schema: readonly AttributeSchema[],
  attributes: Readonly<Record<string, unknown>>,
): ValidationResult {
  const errors: AttributeValidationError[] = [];
  for (const attribute of schema) {
    const value = attributes[attribute.key];
    if (value === undefined) {
      if (attribute.required) {
        errors.push({ attribute: attribute.key, message: "Required attribute is missing" });
      }
      continue;
    }
    switch (attribute.type) {
      case "string":
        if (typeof value !== "string") {
          errors.push({ attribute: attribute.key, message: "Must be a string" });
        }
        break;
      case "number":
        if (typeof value !== "number") {
          errors.push({ attribute: attribute.key, message: "Must be a number" });
        }
        break;
      case "date":
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          errors.push({ attribute: attribute.key, message: "Must be a YYYY-MM-DD date" });
        }
        break;
      case "enum":
        if (typeof value !== "string" || !attribute.options?.includes(value)) {
          errors.push({
            attribute: attribute.key,
            message: `Must be one of: ${(attribute.options ?? []).join(", ")}`,
          });
        }
        break;
    }
  }
  return { ok: errors.length === 0, errors };
}

export function createMockAssetSchemaRegistry(
  seeds: readonly MockAssetTypeSeed[] = [defaultMockAssetTypeSeed],
): MockAssetSchemaRegistry {
  const types = new Map(seeds.map((s) => [`${s.tenantId}:${s.definition.key}`, s.definition]));

  function requireType(tenantId: string, typeKey: string): AssetTypeDefinition {
    const definition = types.get(`${tenantId}:${typeKey}`);
    if (definition === undefined) {
      throw new PortError(
        "AssetSchemaRegistry",
        "not_found",
        `Asset type "${typeKey}" not found for tenant "${tenantId}"`,
      );
    }
    return definition;
  }

  return {
    listTypes(tenantId) {
      return Promise.resolve(
        [...types.entries()]
          .filter(([key]) => key.startsWith(`${tenantId}:`))
          .map(([, definition]) => definition),
      );
    },
    getType(tenantId, typeKey) {
      try {
        return Promise.resolve(requireType(tenantId, typeKey));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    validateAttributes(tenantId, typeKey, attributes) {
      try {
        const definition = requireType(tenantId, typeKey);
        return Promise.resolve(validateAgainstSchema(definition.attributes, attributes));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    registerType(tenantId, definition) {
      types.set(`${tenantId}:${definition.key}`, definition);
    },
  };
}

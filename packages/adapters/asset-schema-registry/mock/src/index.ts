import { assetTypeId, validateAttributesAgainstSchema } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import type { AssetSchemaRegistry, AssetTypeDefinition } from "@tpirs/ports";
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
        return Promise.resolve(validateAttributesAgainstSchema(definition.attributes, attributes));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    registerType(tenantId, definition) {
      types.set(`${tenantId}:${definition.key}`, definition);
    },
  };
}

import type { AssetTypeId } from "./ids.js";

/**
 * The shape of a tenant-defined asset attribute. This is the single source of
 * truth shared by the config schema and every AssetSchemaRegistry adapter, so
 * validation behaves identically no matter where a type is loaded from.
 */
export interface AttributeSchema {
  readonly key: string;
  readonly label: string;
  readonly type: "string" | "number" | "date" | "enum";
  readonly required: boolean;
  readonly options?: readonly string[];
  readonly pattern?: string;
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

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  return ISO_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function validateAttribute(
  attribute: AttributeSchema,
  value: unknown,
): AttributeValidationError | undefined {
  if (value === undefined) {
    return attribute.required
      ? { attribute: attribute.key, message: "Required attribute is missing" }
      : undefined;
  }
  switch (attribute.type) {
    case "string":
      if (typeof value !== "string") {
        return { attribute: attribute.key, message: "Must be a string" };
      }
      if (attribute.pattern !== undefined && !new RegExp(attribute.pattern).test(value)) {
        return {
          attribute: attribute.key,
          message: `Must match pattern ${attribute.pattern}`,
        };
      }
      return undefined;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { attribute: attribute.key, message: "Must be a number" };
      }
      return undefined;
    case "date":
      if (typeof value !== "string" || !isRealDate(value)) {
        return { attribute: attribute.key, message: "Must be a YYYY-MM-DD date" };
      }
      return undefined;
    case "enum":
      if (typeof value !== "string" || !(attribute.options ?? []).includes(value)) {
        return {
          attribute: attribute.key,
          message: `Must be one of: ${(attribute.options ?? []).join(", ")}`,
        };
      }
      return undefined;
  }
}

/**
 * Validates a set of attribute values against a schema. Unknown attributes are
 * allowed (tenants may extend types), but declared attributes are enforced so a
 * malformed asset is rejected before it reaches the database.
 */
export function validateAttributesAgainstSchema(
  schema: readonly AttributeSchema[],
  attributes: Readonly<Record<string, unknown>>,
): ValidationResult {
  const errors: AttributeValidationError[] = [];
  for (const attribute of schema) {
    const error = validateAttribute(attribute, attributes[attribute.key]);
    if (error !== undefined) errors.push(error);
  }
  return { ok: errors.length === 0, errors };
}

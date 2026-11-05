import type { TenantAssetAttribute, TenantAssetType } from "@tpirs/config";
import { apiUrl } from "../api/client.js";

/**
 * Pure helpers behind the registry screens (Phase 9, Step 2).
 *
 * The page is an arrangement of queries and forms; the interesting rules live
 * here so they can be unit-tested without rendering: which filters a query
 * string may carry, how an asset's attributes are laid out from the tenant's
 * *configured* schema (never a hardcoded field list), what a status badge
 * reads, and which body each mutation sends. Nothing here touches React or the
 * client, except `downloadSticker` — a file download bypasses the generated
 * client for the same reason an export does (the client parses JSON).
 *
 * The wire shapes mirror the generated contract: `Asset`, `Owner` and the
 * detail payload with its photos. Attribute values are `unknown` on the wire —
 * the tenant config says what they mean, so rendering goes through the schema.
 */

export type AssetStatus = "active" | "suspended" | "retired";

/**
 * The badge tones the dashboard understands. Kept in step with
 * `components/ui.tsx`; the page never builds a colour class itself.
 */
export type Tone = "neutral" | "brand" | "positive" | "warning" | "danger";

/** One asset as `GET /v1/assets` returns it. */
export interface AssetView {
  readonly id: string;
  readonly assetTypeKey: string;
  readonly status: AssetStatus;
  readonly zoneId: string | null;
  readonly ownerId: string | null;
  /** The owner's display name, resolved by the API; null when unassigned. */
  readonly ownerName: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly qrToken: string;
  readonly shortCode: string;
}

/** One photo as the asset detail returns it (the `url` is same-origin). */
export interface AssetPhotoView {
  readonly id: string;
  readonly url: string;
  readonly contentType?: string;
}

/** The `GET /v1/assets/{id}` payload. */
export interface AssetDetailView {
  readonly asset: AssetView;
  readonly photos: readonly AssetPhotoView[];
}

/** One owner as `GET /v1/owners/{id}` returns it. */
export interface OwnerView {
  readonly id: string;
  readonly displayName: string;
  readonly phone: string;
  readonly phoneVerifiedAt: string | null;
}

export interface RegistryFilters {
  readonly query?: string;
  readonly status?: string;
  readonly assetTypeKey?: string;
  readonly zoneId?: string;
  readonly ownerId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** The query object the generated client accepts for `GET /v1/assets`. */
export interface RegistryQueryParams {
  readonly query?: string;
  readonly status?: string;
  readonly assetTypeKey?: string;
  readonly zoneId?: string;
  readonly ownerId?: string;
  readonly limit?: string;
  readonly offset?: string;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * Builds the asset-list querystring. A blank filter is omitted rather than sent
 * as `status=`/`assetTypeKey=`, which the server would read as a real (and
 * unknown) value; `limit`/`offset` are strings on the wire like every other
 * Fastify querystring.
 */
export function registryQueryParams(filters: RegistryFilters): RegistryQueryParams {
  return {
    ...(present(filters.query) ? { query: filters.query.trim() } : {}),
    ...(present(filters.status) ? { status: filters.status.trim() } : {}),
    ...(present(filters.assetTypeKey) ? { assetTypeKey: filters.assetTypeKey.trim() } : {}),
    ...(present(filters.zoneId) ? { zoneId: filters.zoneId.trim() } : {}),
    ...(present(filters.ownerId) ? { ownerId: filters.ownerId.trim() } : {}),
    ...(filters.limit === undefined ? {} : { limit: String(filters.limit) }),
    ...(filters.offset === undefined ? {} : { offset: String(filters.offset) }),
  };
}

/** Filter choices rendered by the list. `""` means "all". */
export const ASSET_STATUS_OPTIONS: readonly {
  readonly value: AssetStatus | "";
  readonly label: string;
}[] = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "retired", label: "Retired" },
];

/** Human label for an asset state; the API keeps the enum, the UI explains it. */
export function assetStatusLabel(status: AssetStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "suspended":
      return "Suspended";
    case "retired":
      return "Retired";
  }
}

/** An active asset is positive, a suspension is amber, a retirement is neutral. */
export function assetStatusTone(status: AssetStatus): Tone {
  switch (status) {
    case "active":
      return "positive";
    case "suspended":
      return "warning";
    case "retired":
      return "neutral";
  }
}

/** The configured label for an asset type, falling back to its key. */
export function assetTypeLabel(assetTypes: readonly TenantAssetType[], key: string): string {
  return assetTypes.find((assetType) => assetType.key === key)?.label ?? key;
}

/** The configured schema for an asset type, if the tenant still declares it. */
export function findAssetType(
  assetTypes: readonly TenantAssetType[],
  key: string,
): TenantAssetType | undefined {
  return assetTypes.find((assetType) => assetType.key === key);
}

/** One row of the detail's attribute table. */
export interface AttributeRow {
  readonly key: string;
  readonly label: string;
  readonly type: TenantAssetAttribute["type"] | "extra";
  readonly required: boolean;
  /** The value as it renders: scalars verbatim, objects as JSON, empty as `—`. */
  readonly value: string;
  /** True when the asset carries a key the tenant's schema does not declare. */
  readonly extra: boolean;
}

/** How one stored attribute value reads on screen. */
export function attributeValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.trim() === "" ? "—" : value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "symbol") return value.description ?? "—";
  // A function is not a storable attribute value; render it as empty rather
  // than as its source text.
  return "—";
}

/**
 * Lays an asset's attributes out from the tenant's schema.
 *
 * Configured attributes keep their configured order and label; a key the asset
 * carries but the schema does not declare is appended as an extra row instead
 * of being dropped, so an older or newer registry is never silently hidden.
 */
export function attributeRows(
  assetType: TenantAssetType | undefined,
  attributes: Readonly<Record<string, unknown>>,
): readonly AttributeRow[] {
  const configured = assetType?.attributes ?? [];
  const known = new Set(configured.map((attribute) => attribute.key));
  const rows: AttributeRow[] = configured.map((attribute) => ({
    key: attribute.key,
    label: attribute.label,
    type: attribute.type,
    required: attribute.required,
    value: attributeValue(attributes[attribute.key]),
    extra: false,
  }));
  for (const key of Object.keys(attributes)) {
    if (known.has(key)) continue;
    rows.push({
      key,
      label: key,
      type: "extra",
      required: false,
      value: attributeValue(attributes[key]),
      extra: true,
    });
  }
  return rows;
}

/**
 * One input on the correction form, derived from the tenant's schema.
 *
 * The registry screen never shows an operator raw JSON: a state's staff are not
 * developers, and a typo in a brace is an outage, not a correction. Each
 * configured attribute becomes the control its type implies — text, number,
 * date or a picker — and the value travels as text until it is converted back
 * for the request.
 */
export interface AttributeField {
  readonly key: string;
  readonly label: string;
  readonly type: TenantAssetAttribute["type"];
  readonly required: boolean;
  /** For `enum`: the configured choices, in order. */
  readonly options: readonly string[];
  /** For patterned `string` fields: the tenant's own format rule, shown as a hint. */
  readonly pattern: string | undefined;
  /** The current value, as the input shows it. */
  readonly value: string;
}

export type AttributeFormResult =
  | { readonly ok: true; readonly attributes: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

function textValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The form's starting values, one per attribute the tenant's schema declares. */
export function attributeFields(
  assetType: TenantAssetType | undefined,
  attributes: Readonly<Record<string, unknown>>,
): readonly AttributeField[] {
  return (assetType?.attributes ?? []).map((attribute) => ({
    key: attribute.key,
    label: attribute.label,
    type: attribute.type,
    required: attribute.required,
    options: attribute.options ?? [],
    pattern: attribute.pattern,
    value: textValue(attributes[attribute.key]),
  }));
}

/**
 * Values the asset carries that the schema does not declare.
 *
 * They cannot be edited here — nothing says what they mean — but a correction
 * replaces the whole set, so they are sent back unchanged rather than dropped by
 * a screen that does not know about them.
 */
export function attributeExtras(
  assetType: TenantAssetType | undefined,
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const declared = new Set((assetType?.attributes ?? []).map((attribute) => attribute.key));
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!declared.has(key)) extras[key] = value;
  }
  return extras;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turns the form's text into the attribute object the API replaces.
 *
 * The server re-validates everything (patterns included) and answers 422 with
 * its own issues; this catches what an operator gets wrong in the browser — a
 * blank required field, a number that is not a number, a plate in the wrong
 * shape — before a round trip, and says which field it was in the tenant's own
 * wording. Errors are keyed by attribute key so the form can put each message
 * under its own input.
 */
export function attributesFromForm(
  assetType: TenantAssetType | undefined,
  values: Readonly<Record<string, string>>,
  extras: Readonly<Record<string, unknown>> = {},
): AttributeFormResult {
  const attributes: Record<string, unknown> = { ...extras };
  const errors: Record<string, string> = {};

  for (const attribute of assetType?.attributes ?? []) {
    const raw = (values[attribute.key] ?? "").trim();
    if (raw === "") {
      if (attribute.required) errors[attribute.key] = `${attribute.label} is required.`;
      continue;
    }
    switch (attribute.type) {
      case "number": {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          errors[attribute.key] = `${attribute.label} must be a number.`;
          break;
        }
        attributes[attribute.key] = parsed;
        break;
      }
      case "date": {
        if (!ISO_DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
          errors[attribute.key] = `${attribute.label} must be a date.`;
          break;
        }
        attributes[attribute.key] = raw;
        break;
      }
      case "enum": {
        const options = attribute.options ?? [];
        if (options.length > 0 && !options.includes(raw)) {
          errors[attribute.key] = `${attribute.label} must be one of: ${options.join(", ")}.`;
          break;
        }
        attributes[attribute.key] = raw;
        break;
      }
      default: {
        if (attribute.pattern !== undefined) {
          let matches = true;
          try {
            matches = new RegExp(attribute.pattern, "u").test(raw);
          } catch {
            // A tenant's pattern that does not compile is the server's problem to
            // report; the form must not block a correction over it.
            matches = true;
          }
          if (!matches) {
            errors[attribute.key] = `${attribute.label} does not match the expected format.`;
            break;
          }
        }
        attributes[attribute.key] = raw;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, attributes };
}

/**
 * The attribute that holds a driver's plate.
 *
 * The dashboard's driver form asks for four things, but a tenant names its
 * attributes: the default config uses `plate_number`, another state may use
 * `registration` or `plateNumber`. The form writes the plate into the type's own
 * required string attribute, falling back to the first attribute, so a tenant
 * with a different schema still gets a working form without a code change.
 */
export function plateAttributeKey(assetType: TenantAssetType | undefined): string | undefined {
  const attributes = assetType?.attributes ?? [];
  return (
    attributes.find((attribute) => attribute.key === "plate_number")?.key ??
    attributes.find((attribute) => attribute.required && attribute.type === "string")?.key ??
    attributes[0]?.key
  );
}

export interface DriverInput {
  readonly displayName: string;
  readonly phone: string;
  readonly plate: string;
  readonly email?: string;
  readonly assetTypeKey: string;
  readonly assetType: TenantAssetType | undefined;
  readonly zoneId?: string;
}

/**
 * The body `POST /v1/assets` takes for the dashboard's "Add a driver" form.
 *
 * One request creates the owner and the asset, which is the same shape the
 * collector app used to send: a driver is an owner plus a vehicle, never a login.
 * A missing plate attribute is left out so the API answers with its own
 * per-attribute reason rather than the form inventing one.
 */
export function driverBody(input: DriverInput): Record<string, unknown> {
  const attributeKey = plateAttributeKey(input.assetType);
  const email = input.email?.trim() ?? "";
  return {
    assetTypeKey: input.assetTypeKey,
    attributes: attributeKey === undefined ? {} : { [attributeKey]: input.plate.trim() },
    owner: {
      displayName: input.displayName.trim(),
      phone: input.phone.trim(),
      ...(email === "" ? {} : { email }),
    },
    ...(input.zoneId === undefined || input.zoneId === "" ? {} : { zoneId: input.zoneId }),
  };
}

/** The sticker file name a download saves under, derived from the short code. */
export function stickerFilename(shortCode: string): string {
  const safe = shortCode
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `sticker-${safe === "" ? "asset" : safe}.svg`;
}

/** The suspend body: exactly the single field the contract requires, trimmed. */
export function suspendBody(reason: string): { readonly reason: string } {
  return { reason: reason.trim() };
}

/** The correction body: the full attribute set the server replaces. */
export function correctionBody(attributes: Readonly<Record<string, unknown>>): {
  readonly attributes: Record<string, unknown>;
} {
  return { attributes: { ...attributes } };
}

/** The create-owner body, trimmed so a stray space is not stored as the name. */
export function ownerCreateBody(
  displayName: string,
  phone: string,
): { readonly displayName: string; readonly phone: string } {
  return { displayName: displayName.trim(), phone: phone.trim() };
}

/**
 * The OTP request body. The contract accepts either an owner id or a bare
 * phone; a blank field is omitted so the server does not have to guess which
 * one the operator meant.
 */
export function ownerVerifyRequestBody(input: {
  readonly ownerId?: string;
  readonly phone?: string;
}): { readonly ownerId?: string; readonly phone?: string } {
  return {
    ...(present(input.ownerId) ? { ownerId: input.ownerId.trim() } : {}),
    ...(present(input.phone) ? { phone: input.phone.trim() } : {}),
  };
}

/** The OTP confirm body: the owner the code was sent for plus the code. */
export function ownerVerifyConfirmBody(
  ownerId: string,
  code: string,
): { readonly ownerId: string; readonly code: string } {
  return { ownerId, code: code.trim() };
}

/** Whether the owner's phone is verified, in words. */
export function ownerVerifiedLabel(owner: OwnerView): string {
  return owner.phoneVerifiedAt === null ? "Not verified" : "Verified";
}

export interface StickerDownloadRequest {
  readonly assetId: string;
  readonly shortCode: string;
  readonly token: string | undefined;
}

export interface StickerDependencies {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to an anchor click with an object URL. */
  readonly saveBlob?: (blob: Blob, filename: string, href: string) => void;
}

/**
 * Fetches the sticker SVG and saves it.
 *
 * The generated client parses JSON and a sticker is an image, so this uses
 * `fetch` directly with the in-memory bearer token — the same seam the report
 * export uses. The path is same-origin, so the browser's /v1 proxy serves it.
 *
 * @returns the filename the file was saved as.
 */
export async function downloadSticker(
  request: StickerDownloadRequest,
  dependencies: StickerDependencies = {},
): Promise<string> {
  const path = apiUrl(`/v1/assets/${encodeURIComponent(request.assetId)}/sticker`);
  const blob = await fetchSticker(request, dependencies);
  const filename = stickerFilename(request.shortCode);
  (dependencies.saveBlob ?? saveBlobInBrowser)(blob, filename, path);
  return filename;
}

/**
 * Fetches the sticker as a blob, for the on-screen preview and for printing.
 *
 * Same seam as the download: the generated client parses JSON, and the sticker
 * is an SVG behind the in-memory bearer. Returning a Blob lets the page show it
 * from an object URL — which is also what makes "Print sticker" print the image
 * rather than a broken icon.
 */
export async function fetchSticker(
  request: Pick<StickerDownloadRequest, "assetId" | "token">,
  dependencies: StickerDependencies = {},
): Promise<Blob> {
  const path = apiUrl(`/v1/assets/${encodeURIComponent(request.assetId)}/sticker`);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(path, {
    method: "GET",
    headers:
      request.token === undefined || request.token === ""
        ? {}
        : { authorization: `Bearer ${request.token}` },
  });
  if (!response.ok) {
    throw new Error(`Sticker download failed with status ${response.status}`);
  }
  return await response.blob();
}

/**
 * Saves a blob through a temporary anchor.
 *
 * jsdom has no `URL.createObjectURL`, so the object URL is best-effort: when it
 * cannot be created the anchor falls back to the same-origin sticker path,
 * which is what the page test asserts (the anchor carries the filename).
 */
function saveBlobInBrowser(blob: Blob, filename: string, href: string): void {
  let objectUrl = "";
  try {
    objectUrl = URL.createObjectURL(blob);
  } catch {
    objectUrl = "";
  }
  const anchor = document.createElement("a");
  anchor.href = objectUrl === "" ? href : objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  if (objectUrl !== "") {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      // The URL is already unusable; nothing to revoke.
    }
  }
}

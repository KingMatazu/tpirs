import type { TenantAssetAttribute, TenantAssetType } from "@tpirs/config";

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

/** The pretty-printed JSON the correction textarea opens with. */
export function attributesJsonText(attributes: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(attributes, null, 2);
}

export type AttributesParse =
  | { readonly ok: true; readonly attributes: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };

/**
 * Parses the correction textarea and checks it against the schema.
 *
 * The server re-validates every attribute (patterns included) and answers 422
 * with the issues; this only catches the two mistakes an operator makes in the
 * browser — malformed JSON and a dropped required field — before a round trip.
 */
export function attributesJson(text: string, assetType?: TenantAssetType): AttributesParse {
  if (text.trim() === "") {
    return { ok: false, error: "Attributes JSON is required." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Attributes must be valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Attributes must be a JSON object." };
  }
  const attributes = parsed as Record<string, unknown>;
  const missing = (assetType?.attributes ?? [])
    .filter((attribute) => attribute.required)
    .filter((attribute) => {
      const value = attributes[attribute.key];
      return value === undefined || value === null || attributeValue(value) === "—";
    })
    .map((attribute) => attribute.label);
  if (missing.length > 0) {
    return { ok: false, error: `Missing required attribute: ${missing.join(", ")}.` };
  }
  return { ok: true, attributes };
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
  const path = `/v1/assets/${encodeURIComponent(request.assetId)}/sticker`;
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
  const filename = stickerFilename(request.shortCode);
  const blob = await response.blob();
  (dependencies.saveBlob ?? saveBlobInBrowser)(blob, filename, path);
  return filename;
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

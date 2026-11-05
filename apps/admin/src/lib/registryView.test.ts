import { describe, expect, it } from "vitest";
import type { TenantAssetType } from "@tpirs/config";
import { loadFixtureConfig } from "../test-support/tenant.js";
import {
  ASSET_STATUS_OPTIONS,
  assetStatusLabel,
  assetStatusTone,
  assetTypeLabel,
  attributeRows,
  attributeValue,
  attributeExtras,
  attributeFields,
  attributesFromForm,
  correctionBody,
  downloadSticker,
  driverBody,
  fetchSticker,
  findAssetType,
  ownerCreateBody,
  ownerPhoneParam,
  reassignOwnerBody,
  ownerVerifiedLabel,
  ownerVerifyConfirmBody,
  ownerVerifyRequestBody,
  plateAttributeKey,
  registryQueryParams,
  stickerFilename,
  suspendBody,
  type OwnerView,
} from "./registryView.js";

/**
 * The pure rules behind the registry screen. The attribute layout is the one
 * that must never drift: it comes from the tenant's schema, so a new asset type
 * or a renamed label changes the screen without a code edit, and an attribute
 * the schema does not declare is still shown rather than silently dropped.
 */

const config = loadFixtureConfig();
const assetTypes = config.assetTypes;
const bike = findAssetType(assetTypes, "bike");

if (bike === undefined) throw new Error("the fixture must declare a bike asset type");

const bikeSchema: TenantAssetType = bike;

describe("registryQueryParams", () => {
  it("keeps the filters an operator set", () => {
    expect(
      registryQueryParams({
        query: "AB12345",
        status: "active",
        assetTypeKey: "bike",
        zoneId: "zone-a",
        ownerId: "ow_1",
        limit: 50,
        offset: 100,
      }),
    ).toEqual({
      query: "AB12345",
      status: "active",
      assetTypeKey: "bike",
      zoneId: "zone-a",
      ownerId: "ow_1",
      limit: "50",
      offset: "100",
    });
  });

  it("omits blank filters instead of sending empty values", () => {
    expect(registryQueryParams({ query: "  ", status: "" })).toEqual({});
  });

  it("trims what it does send", () => {
    expect(registryQueryParams({ query: " AB12345 ", status: " active " })).toEqual({
      query: "AB12345",
      status: "active",
    });
  });
});

describe("attributeRows", () => {
  it("lays attributes out from the configured schema, in configured order", () => {
    const rows = attributeRows(bikeSchema, { plate_number: "AB12345" });
    expect(rows).toEqual([
      {
        key: "plate_number",
        label: "Plate number",
        type: "string",
        required: true,
        value: "AB12345",
        extra: false,
      },
    ]);
  });

  it("appends keys the schema does not declare instead of dropping them", () => {
    const rows = attributeRows(bikeSchema, { plate_number: "AB12345", colour: "red" });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ key: "colour", label: "colour", type: "extra", extra: true });
    expect(rows[1]?.value).toBe("red");
  });

  it("renders a missing configured attribute as an em dash", () => {
    expect(attributeRows(bikeSchema, {})[0]?.value).toBe("—");
  });

  it("still lists the stored values when the tenant dropped the asset type", () => {
    const rows = attributeRows(undefined, { plate_number: "AB12345" });
    expect(rows).toEqual([
      {
        key: "plate_number",
        label: "plate_number",
        type: "extra",
        required: false,
        value: "AB12345",
        extra: true,
      },
    ]);
  });

  it("renders scalars and objects without inventing a format", () => {
    expect(attributeValue("AB12345")).toBe("AB12345");
    expect(attributeValue(7)).toBe("7");
    expect(attributeValue(true)).toBe("true");
    expect(attributeValue(null)).toBe("—");
    expect(attributeValue("  ")).toBe("—");
    expect(attributeValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("status labels and tones", () => {
  it("spells out every status", () => {
    expect(assetStatusLabel("active")).toBe("Active");
    expect(assetStatusLabel("suspended")).toBe("Suspended");
    expect(assetStatusLabel("retired")).toBe("Retired");
  });

  it("tones a suspension as a warning and a retirement as neutral", () => {
    expect(assetStatusTone("active")).toBe("positive");
    expect(assetStatusTone("suspended")).toBe("warning");
    expect(assetStatusTone("retired")).toBe("neutral");
  });

  it("offers an all-statuses choice first", () => {
    expect(ASSET_STATUS_OPTIONS[0]).toEqual({ value: "", label: "All statuses" });
  });

  it("labels an asset type from config and falls back to the key", () => {
    expect(assetTypeLabel(assetTypes, "bike")).toBe("Motorbike");
    expect(assetTypeLabel(assetTypes, "tuk-tuk")).toBe("tuk-tuk");
  });
});

describe("stickerFilename", () => {
  it("derives the file name from the short code", () => {
    expect(stickerFilename("B123")).toBe("sticker-B123.svg");
  });

  it("replaces characters that cannot sit in a file name", () => {
    expect(stickerFilename(" B 12/3 ")).toBe("sticker-B-12-3.svg");
  });

  it("falls back when the short code is empty", () => {
    expect(stickerFilename("   ")).toBe("sticker-asset.svg");
  });
});

describe("mutation bodies", () => {
  it("trims the suspension reason", () => {
    expect(suspendBody("  Sticker swapped  ")).toEqual({ reason: "Sticker swapped" });
  });

  it("sends the full attribute set for a correction", () => {
    const attributes = { plate_number: "AB12345" };
    const body = correctionBody(attributes);
    expect(body).toEqual({ attributes: { plate_number: "AB12345" } });
    // A copy: the textarea state must not be mutated by the request layer.
    expect(body.attributes).not.toBe(attributes);
  });

  it("sends only the owner the vehicle moves to", () => {
    expect(reassignOwnerBody("  ow_2  ")).toEqual({ ownerId: "ow_2" });
  });

  it("encodes a phone number for the lookup path", () => {
    // `+` and spaces would otherwise break the segment.
    expect(ownerPhoneParam(" +234 801 234 5678 ")).toBe("%2B234%20801%20234%205678");
  });

  it("trims the create-owner fields", () => {
    expect(ownerCreateBody("  Ada  ", " +2348012345678 ")).toEqual({
      displayName: "Ada",
      phone: "+2348012345678",
    });
  });

  it("carries an optional email for a new owner, and omits a blank one", () => {
    expect(ownerCreateBody("Ada", "+2348012345678", " ada@example.test ")).toEqual({
      displayName: "Ada",
      phone: "+2348012345678",
      email: "ada@example.test",
    });
    expect(ownerCreateBody("Ada", "+2348012345678", "   ")).toEqual({
      displayName: "Ada",
      phone: "+2348012345678",
    });
  });

  it("omits a blank half of the OTP request", () => {
    expect(ownerVerifyRequestBody({ ownerId: "ow_1" })).toEqual({ ownerId: "ow_1" });
    expect(ownerVerifyRequestBody({ phone: " +2348012345678 " })).toEqual({
      phone: "+2348012345678",
    });
    expect(ownerVerifyRequestBody({ ownerId: " ", phone: "" })).toEqual({});
  });

  it("trims the OTP code", () => {
    expect(ownerVerifyConfirmBody("ow_1", " 123456 ")).toEqual({
      ownerId: "ow_1",
      code: "123456",
    });
  });

  it("reads verification from the timestamp", () => {
    const base: OwnerView = {
      id: "ow_1",
      displayName: "Ada",
      phone: "+2348012345678",
      phoneVerifiedAt: null,
    };
    expect(ownerVerifiedLabel(base)).toBe("Not verified");
    expect(ownerVerifiedLabel({ ...base, phoneVerifiedAt: "2026-10-27T09:00:00.000Z" })).toBe(
      "Verified",
    );
  });
});

describe("attributeFields", () => {
  const schema: TenantAssetType = {
    key: "bike",
    label: "Motorbike",
    qrFormat: "EX-{id}",
    shortCodeFormat: "B{id}",
    stickerSpec: "60x60mm",
    attributes: [
      {
        key: "plate_number",
        label: "Plate number",
        type: "string",
        required: true,
        pattern: "^[A-Z0-9]{5,8}$",
      },
      { key: "seats", label: "Seats", type: "number", required: false },
      { key: "registered_on", label: "Registered on", type: "date", required: false },
      {
        key: "colour",
        label: "Colour",
        type: "enum",
        required: false,
        options: ["red", "blue"],
      },
    ],
  };

  it("builds one labelled field per configured attribute, in schema order", () => {
    const fields = attributeFields(schema, { plate_number: "AB12345", seats: 2 });
    expect(fields.map((field) => field.label)).toEqual([
      "Plate number",
      "Seats",
      "Registered on",
      "Colour",
    ]);
    expect(fields[0]?.value).toBe("AB12345");
    expect(fields[1]?.value).toBe("2");
    expect(fields[2]?.value).toBe("");
    expect(fields[3]?.options).toEqual(["red", "blue"]);
  });

  it("carries a configured pattern so the form can show the expected format", () => {
    expect(attributeFields(schema, {})[0]?.pattern).toBe("^[A-Z0-9]{5,8}$");
  });

  it("has nothing to render when the asset type is unknown", () => {
    expect(attributeFields(undefined, { plate_number: "AB12345" })).toEqual([]);
  });
});

describe("attributeExtras", () => {
  it("keeps values the schema does not declare so a correction cannot drop them", () => {
    expect(attributeExtras(bikeSchema, { plate_number: "AB12345", colour: "red" })).toEqual({
      colour: "red",
    });
  });
});

describe("attributesFromForm", () => {
  const schema: TenantAssetType = {
    key: "bike",
    label: "Motorbike",
    qrFormat: "EX-{id}",
    shortCodeFormat: "B{id}",
    stickerSpec: "60x60mm",
    attributes: [
      {
        key: "plate_number",
        label: "Plate number",
        type: "string",
        required: true,
        pattern: "^[A-Z0-9]{5,8}$",
      },
      { key: "seats", label: "Seats", type: "number", required: false },
      { key: "registered_on", label: "Registered on", type: "date", required: false },
      {
        key: "colour",
        label: "Colour",
        type: "enum",
        required: false,
        options: ["red", "blue"],
      },
    ],
  };

  it("converts each field to the type its schema declares", () => {
    expect(
      attributesFromForm(schema, {
        plate_number: " AB12345 ",
        seats: "2",
        registered_on: "2026-10-27",
        colour: "blue",
      }),
    ).toEqual({
      ok: true,
      attributes: {
        plate_number: "AB12345",
        seats: 2,
        registered_on: "2026-10-27",
        colour: "blue",
      },
    });
  });

  it("leaves an empty optional field out instead of storing a blank string", () => {
    expect(attributesFromForm(schema, { plate_number: "AB12345", seats: "" })).toEqual({
      ok: true,
      attributes: { plate_number: "AB12345" },
    });
  });

  it("names the missing field in the tenant's own wording", () => {
    expect(attributesFromForm(schema, { plate_number: "  " })).toEqual({
      ok: false,
      errors: { plate_number: "Plate number is required." },
    });
  });

  it("refuses a plate that does not match the configured pattern", () => {
    expect(attributesFromForm(schema, { plate_number: "AB1" })).toEqual({
      ok: false,
      errors: { plate_number: "Plate number does not match the expected format." },
    });
  });

  it("refuses a number that is not a number, and a date that is not a date", () => {
    expect(attributesFromForm(schema, { plate_number: "AB12345", seats: "two" })).toEqual({
      ok: false,
      errors: { seats: "Seats must be a number." },
    });
    expect(
      attributesFromForm(schema, { plate_number: "AB12345", registered_on: "27/10/2026" }),
    ).toEqual({
      ok: false,
      errors: { registered_on: "Registered on must be a date." },
    });
  });

  it("refuses a value that is not one of the configured choices", () => {
    expect(attributesFromForm(schema, { plate_number: "AB12345", colour: "green" })).toEqual({
      ok: false,
      errors: { colour: "Colour must be one of: red, blue." },
    });
  });

  it("carries undeclared values through unchanged", () => {
    expect(attributesFromForm(schema, { plate_number: "AB12345" }, { colour_code: "R" })).toEqual({
      ok: true,
      attributes: { colour_code: "R", plate_number: "AB12345" },
    });
  });
});

describe("downloadSticker", () => {
  it("requests the sticker path with the bearer and saves the derived filename", async () => {
    const calls: { path: string; authorization: string | undefined }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ path: requestPath(input), authorization: headerValue(init?.headers) });
      return new Response("<svg/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      });
    };
    const saved: { filename: string; href: string }[] = [];

    const filename = await downloadSticker(
      { assetId: "as_1", shortCode: "B123", token: "tok" },
      {
        fetchImpl,
        saveBlob: (_blob, name, href) => {
          saved.push({ filename: name, href });
        },
      },
    );

    expect(filename).toBe("sticker-B123.svg");
    // Absolute, because a relative path resolves against the dashboard's origin
    // on a split deployment and the SPA rewrite answers index.html.
    expect(saved).toHaveLength(1);
    expect(saved[0]?.filename).toBe("sticker-B123.svg");
    expect(saved[0]?.href).toMatch(/\/v1\/assets\/as_1\/sticker$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toMatch(/\/v1\/assets\/as_1\/sticker$/);
    expect(calls[0]?.authorization).toBe("Bearer tok");
  });

  it("throws instead of saving a failed response", async () => {
    let saved = 0;
    await expect(
      downloadSticker(
        { assetId: "as_1", shortCode: "B123", token: undefined },
        {
          fetchImpl: async () => new Response("nope", { status: 404 }),
          saveBlob: () => {
            saved += 1;
          },
        },
      ),
    ).rejects.toThrow("Sticker download failed with status 404");
    expect(saved).toBe(0);
  });
});

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headerValue(headers: HeadersInit | undefined): string | undefined {
  if (headers === undefined) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("authorization") ?? undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === "authorization")?.[1];
  }
  const record = headers as Record<string, string>;
  return record["authorization"];
}

describe("driver registration", () => {
  const config = loadFixtureConfig();
  const bike = findAssetType(config.assetTypes, "bike");

  it("finds the attribute that holds a plate, whatever the tenant calls it", () => {
    expect(plateAttributeKey(bike)).toBe("plate_number");
    const renamed: TenantAssetType = {
      ...(bike as TenantAssetType),
      attributes: [{ key: "registration", label: "Registration", type: "string", required: true }],
    };
    expect(plateAttributeKey(renamed)).toBe("registration");
    expect(plateAttributeKey(undefined)).toBeUndefined();
  });

  it("builds the body from four answers, with no password and no account", () => {
    const body = driverBody({
      displayName: "  Musa Driver  ",
      phone: " 08012345678 ",
      plate: " XYZ123 ",
      email: "  ",
      assetTypeKey: "bike",
      assetType: bike,
      zoneId: "",
    });
    expect(body).toEqual({
      assetTypeKey: "bike",
      attributes: { plate_number: "XYZ123" },
      owner: { displayName: "Musa Driver", phone: "08012345678" },
    });
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("includes the email and zone only when they are given", () => {
    const body = driverBody({
      displayName: "Musa Driver",
      phone: "08012345678",
      plate: "XYZ123",
      email: "musa@example.com",
      assetTypeKey: "bike",
      assetType: bike,
      zoneId: "zone-a",
    });
    expect(body).toMatchObject({
      owner: { email: "musa@example.com" },
      zoneId: "zone-a",
    });
  });
});

describe("fetchSticker", () => {
  it("sends the bearer and returns the image body", async () => {
    const seen: { url: string; authorization: string | undefined }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, authorization: headers.get("authorization") ?? undefined });
      return new Response("<svg/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      });
    }) as unknown as typeof fetch;

    const blob = await fetchSticker({ assetId: "as_1", token: "tok" }, { fetchImpl });
    expect(blob.size).toBeGreaterThan(0);
    expect(seen[0]?.url).toMatch(/\/v1\/assets\/as_1\/sticker$/);
    expect(seen[0]?.authorization).toBe("Bearer tok");
  });

  it("fails loudly rather than printing an error page", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchSticker({ assetId: "as_1", token: "tok" }, { fetchImpl })).rejects.toThrow(
      /status 401/,
    );
  });
});

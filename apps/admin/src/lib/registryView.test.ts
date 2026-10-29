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
  attributesJson,
  attributesJsonText,
  correctionBody,
  downloadSticker,
  findAssetType,
  ownerCreateBody,
  ownerVerifiedLabel,
  ownerVerifyConfirmBody,
  ownerVerifyRequestBody,
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
    expect(assetTypeLabel(assetTypes, "bike")).toBe("Bicycle");
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

  it("trims the create-owner fields", () => {
    expect(ownerCreateBody("  Ada  ", " +2348012345678 ")).toEqual({
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

describe("attributesJson", () => {
  it("accepts a JSON object and round-trips the textarea text", () => {
    const text = attributesJsonText({ plate_number: "AB12345" });
    expect(text).toContain('"plate_number"');
    const parsed = attributesJson(text, bikeSchema);
    expect(parsed).toEqual({ ok: true, attributes: { plate_number: "AB12345" } });
  });

  it("rejects empty input", () => {
    expect(attributesJson("   ")).toEqual({ ok: false, error: "Attributes JSON is required." });
  });

  it("rejects malformed JSON", () => {
    expect(attributesJson("{")).toEqual({ ok: false, error: "Attributes must be valid JSON." });
  });

  it("rejects a JSON array", () => {
    expect(attributesJson("[]")).toEqual({
      ok: false,
      error: "Attributes must be a JSON object.",
    });
  });

  it("rejects a dropped required attribute by its configured label", () => {
    expect(attributesJson('{"colour":"red"}', bikeSchema)).toEqual({
      ok: false,
      error: "Missing required attribute: Plate number.",
    });
  });

  it("keeps extra keys the schema does not declare", () => {
    expect(attributesJson('{"plate_number":"AB12345","colour":"red"}', bikeSchema)).toEqual({
      ok: true,
      attributes: { plate_number: "AB12345", colour: "red" },
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
    expect(saved).toEqual([{ filename: "sticker-B123.svg", href: "/v1/assets/as_1/sticker" }]);
    expect(calls).toEqual([{ path: "/v1/assets/as_1/sticker", authorization: "Bearer tok" }]);
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

import { afterAll, describe, expect, it } from "vitest";
import { createObjectStorageConformanceSuite } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import { createS3ObjectStorage } from "./index.js";

/**
 * The contract tests run against any S3-compatible endpoint. Point them at
 * SeaweedFS (local compose) or the state host's S3 store via env. When no
 * endpoint is configured the suite is skipped so unit CI stays green; the
 * pipeline (and local `pnpm setup`) run it against SeaweedFS.
 */
const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
const bucket = process.env.OBJECT_STORAGE_BUCKET ?? "tpirs-uploads";
const region = process.env.OBJECT_STORAGE_REGION ?? "us-east-1";
const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;

const runSuite = endpoint !== undefined && endpoint !== "";

function makeStorage() {
  return createS3ObjectStorage({
    bucket,
    region,
    endpoint,
    ...(accessKeyId === undefined ? {} : { accessKeyId }),
    ...(secretAccessKey === undefined ? {} : { secretAccessKey }),
    forcePathStyle: true,
  });
}

if (runSuite) {
  createObjectStorageConformanceSuite({ describe, it, expect }, () => ({ port: makeStorage() }));
} else {
  describe("S3 ObjectStorage conformance", () => {
    it.skip("runs against an S3 endpoint when OBJECT_STORAGE_ENDPOINT is set", () => undefined);
  });
}

describe("createS3ObjectStorage", () => {
  it("surfaces a missing object as a not_found PortError (when a store is configured)", async () => {
    if (!runSuite) return;
    const storage = makeStorage();
    const error = await storage.get("conformance/definitely-missing.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).code).toBe("not_found");
  });
});

afterAll(() => undefined);

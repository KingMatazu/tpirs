import { createLocalDiskObjectStorage } from "@tpirs/adapters-localdisk-storage";
import { createS3ObjectStorage } from "@tpirs/adapters-s3-storage";
import { createMockObjectStorage } from "@tpirs/object-storage-mock";
import type { ObjectStorage } from "@tpirs/ports";

/**
 * Chooses the ObjectStorage adapter from configuration. This is the one place
 * the environment decides which adapter to build; domain code depends only on
 * the port. Tenant-specific behaviour would come from tenant config, never from
 * branching on tenant identity here.
 */
export interface ObjectStorageEnv {
  readonly OBJECT_STORAGE_ADAPTER?: string;
  readonly OBJECT_STORAGE_ENDPOINT?: string;
  readonly OBJECT_STORAGE_REGION?: string;
  readonly OBJECT_STORAGE_BUCKET?: string;
  readonly OBJECT_STORAGE_ACCESS_KEY_ID?: string;
  readonly OBJECT_STORAGE_SECRET_ACCESS_KEY?: string;
  readonly OBJECT_STORAGE_LOCAL_DIR?: string;
}

export function buildObjectStorage(env: ObjectStorageEnv): ObjectStorage {
  const adapter = env.OBJECT_STORAGE_ADAPTER ?? "s3";

  if (adapter === "localdisk") {
    return createLocalDiskObjectStorage({
      baseDir: env.OBJECT_STORAGE_LOCAL_DIR ?? ".docker-data/object-storage",
    });
  }

  // Deliberately process-local: a hosted pilot that has not provisioned a
  // bucket can still boot and register assets. Uploads are lost when the
  // instance recycles, so this is a testing adapter, never a deployment one.
  if (adapter === "mock") {
    return createMockObjectStorage(env.OBJECT_STORAGE_BUCKET ?? "mock-bucket");
  }

  if (adapter !== "s3") {
    throw new Error(
      `Unknown OBJECT_STORAGE_ADAPTER "${adapter}" (expected "s3", "localdisk" or "mock")`,
    );
  }

  if (env.OBJECT_STORAGE_BUCKET === undefined || env.OBJECT_STORAGE_BUCKET === "") {
    throw new Error("OBJECT_STORAGE_BUCKET is required when OBJECT_STORAGE_ADAPTER=s3");
  }

  return createS3ObjectStorage({
    bucket: env.OBJECT_STORAGE_BUCKET,
    region: env.OBJECT_STORAGE_REGION ?? "us-east-1",
    ...(env.OBJECT_STORAGE_ENDPOINT === undefined ? {} : { endpoint: env.OBJECT_STORAGE_ENDPOINT }),
    ...(env.OBJECT_STORAGE_ACCESS_KEY_ID === undefined
      ? {}
      : { accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID }),
    ...(env.OBJECT_STORAGE_SECRET_ACCESS_KEY === undefined
      ? {}
      : { secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY }),
  });
}

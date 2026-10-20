import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PortError } from "@tpirs/ports";
import type { ObjectContent, ObjectStorage, PutObjectRequest, StoredObject } from "@tpirs/ports";

export interface S3StorageOptions {
  readonly bucket: string;
  readonly region: string;
  /** Custom endpoint for S3-compatible stores (SeaweedFS, MinIO, etc.). */
  readonly endpoint?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  /** Use path-style addressing (required by most S3-compatible stores). */
  readonly forcePathStyle?: boolean;
}

/**
 * S3-compatible ObjectStorage adapter. Works against AWS S3 and any
 * S3-compatible endpoint (SeaweedFS in local/CI, the state host's store in
 * production). The adapter is the only place an S3 SDK is allowed.
 */
export function createS3ObjectStorage(options: S3StorageOptions): ObjectStorage {
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.accessKeyId === undefined || options.secretAccessKey === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }),
    forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
  });

  return {
    async put(request: PutObjectRequest): Promise<StoredObject> {
      const body =
        typeof request.body === "string" ? new TextEncoder().encode(request.body) : request.body;
      try {
        const result = await client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: request.key,
            Body: body,
            ContentType: request.contentType,
            ...(request.metadata === undefined ? {} : { Metadata: { ...request.metadata } }),
          }),
        );
        return { key: request.key, size: body.byteLength, etag: result.ETag ?? "" };
      } catch (error) {
        throw toPortError(error);
      }
    },
    async get(key: string): Promise<ObjectContent> {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        const bytes = await result.Body?.transformToByteArray();
        if (bytes === undefined) {
          throw new PortError("ObjectStorage", "not_found", `Object "${key}" has no body`);
        }
        return { body: bytes, contentType: result.ContentType ?? "application/octet-stream" };
      } catch (error) {
        throw toPortError(error, key);
      }
    },
    async delete(key: string): Promise<void> {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
      } catch (error) {
        throw toPortError(error);
      }
    },
    presignGet(key: string, ttlSeconds: number): Promise<string> {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: options.bucket, Key: key }), {
        expiresIn: ttlSeconds,
      }).catch((error: unknown) => {
        throw toPortError(error);
      });
    },
  };
}

function toPortError(error: unknown, key?: string): PortError {
  if (error instanceof PortError) return error;
  const name =
    typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
      ? error.name
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "NoSuchKey" || name === "NotFound" || name === "NoSuchBucket") {
    return new PortError(
      "ObjectStorage",
      "not_found",
      key === undefined ? message : `Object "${key}" does not exist`,
    );
  }
  return new PortError("ObjectStorage", "provider_error", message, {
    provider: "s3",
    retryable: false,
  });
}

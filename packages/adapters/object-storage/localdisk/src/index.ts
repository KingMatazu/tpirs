import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PortError } from "@tpirs/ports";
import type { ObjectContent, ObjectStorage, PutObjectRequest, StoredObject } from "@tpirs/ports";

export interface LocalDiskStorageOptions {
  /** Directory where objects are stored. Created on demand. */
  readonly baseDir: string;
  /**
   * Secret used to sign presigned URLs. When omitted, a random per-process
   * secret is used (URLs remain well-formed but are not verifiable after restart).
   */
  readonly signingSecret?: string;
  /** Public base URL presigned links should point at. Defaults to a file-like scheme. */
  readonly publicBaseUrl?: string;
}

interface StoredMeta {
  readonly contentType: string;
  readonly etag: string;
  readonly size: number;
}

function etagOf(body: Uint8Array): string {
  return createHash("md5").update(body).digest("hex");
}

function assertSafeKey(key: string): void {
  if (key.length === 0 || key.startsWith("/") || key.split("/").includes("..")) {
    throw new PortError("ObjectStorage", "invalid_request", `Unsafe object key "${key}"`);
  }
}

/**
 * Filesystem-backed ObjectStorage. Intended for unit tests and developers who
 * do not want to run an object store; not for production. Keys map to nested
 * directories under baseDir, with a metadata sidecar per object.
 *
 * Path traversal is rejected. Metadata (content type, etag, size) is stored
 * alongside the object so reads are self-contained.
 */
export function createLocalDiskObjectStorage(options: LocalDiskStorageOptions): ObjectStorage {
  const baseDir = path.resolve(options.baseDir);
  const signingSecret = options.signingSecret ?? randomUUID();
  const publicBaseUrl = options.publicBaseUrl ?? "localdisk";

  function objectPath(key: string): string {
    return path.join(baseDir, key);
  }

  function metaPath(key: string): string {
    return `${path.join(baseDir, key)}.meta.json`;
  }

  return {
    async put(request: PutObjectRequest): Promise<StoredObject> {
      assertSafeKey(request.key);
      const body =
        typeof request.body === "string" ? new TextEncoder().encode(request.body) : request.body;
      const etag = etagOf(body);
      const file = objectPath(request.key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
      const meta: StoredMeta = { contentType: request.contentType, etag, size: body.byteLength };
      await writeFile(metaPath(request.key), JSON.stringify(meta));
      return { key: request.key, size: body.byteLength, etag };
    },
    async get(key: string): Promise<ObjectContent> {
      assertSafeKey(key);
      let body: Buffer;
      let meta: StoredMeta;
      try {
        body = await readFile(objectPath(key));
        meta = JSON.parse(await readFile(metaPath(key), "utf8")) as StoredMeta;
      } catch {
        throw new PortError("ObjectStorage", "not_found", `Object "${key}" does not exist`);
      }
      return { body: new Uint8Array(body), contentType: meta.contentType };
    },
    async delete(key: string): Promise<void> {
      assertSafeKey(key);
      await rm(objectPath(key), { force: true });
      await rm(metaPath(key), { force: true });
    },
    presignGet(key: string, ttlSeconds: number): Promise<string> {
      assertSafeKey(key);
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const signature = createHmac("sha256", signingSecret)
        .update(`${key}:${String(expires)}`)
        .digest("hex");
      const url = `${publicBaseUrl}/${key}?expires=${String(expires)}&signature=${signature}`;
      return Promise.resolve(url);
    },
  };
}

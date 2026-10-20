export interface PutObjectRequest {
  readonly key: string;
  readonly body: Uint8Array | string;
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
}

export interface ObjectContent {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface ObjectStorage {
  put(request: PutObjectRequest): Promise<StoredObject>;
  get(key: string): Promise<ObjectContent>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
}

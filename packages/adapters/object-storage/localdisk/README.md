# @tpirs/adapters-localdisk-storage

Filesystem-backed `ObjectStorage` adapter for unit tests and local development
when no object store is running. Not for production. Rejects path traversal,
stores per-object metadata (content type, etag, size), and signs presigned URLs
with an HMAC. Passes the shared object-storage conformance suite.

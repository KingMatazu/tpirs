# @tpirs/adapters-s3-storage

`ObjectStorage` adapter for any S3-compatible store (AWS S3, SeaweedFS in
local/CI, the state host's store in production). This is the only package where
an S3 SDK dependency may live. It passes the shared object-storage conformance
suite; the suite runs against SeaweedFS when `OBJECT_STORAGE_ENDPOINT` is set and
is skipped otherwise so unit CI stays green.

Configure via `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`,
`OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ACCESS_KEY_ID`,
`OBJECT_STORAGE_SECRET_ACCESS_KEY`.

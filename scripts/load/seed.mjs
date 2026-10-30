#!/usr/bin/env node
/**
 * Seeds a valid QR token for the verify scenario (Phase 10, Step 3).
 *
 * The public verify endpoint takes `<assetId>.<checksum>`, signed with the
 * deployment's QR key (ADR 0007). The token is not stored anywhere, so the load
 * harness mints one from a seeded asset using the same signing key the API
 * loads from `SECRET_QR_TOKEN_SIGNING_KEY`.
 *
 * Runs from the repo root against the workspace packages' built output, so it
 * needs `pnpm build` (or the specific package builds) to have run:
 *   node scripts/load/seed.mjs
 * Prints `{ "assetId": "...", "verifyToken": "..." }` on stdout.
 */
const { createDb, repositories, withTenant } = await import("../../packages/db/dist/index.js");
const { buildQrToken } = await import("../../packages/domain/dist/index.js");
const { createQrTokenSigner } = await import("../../packages/crypto/dist/index.js");

const databaseUrl = process.env.DATABASE_URL ?? "";
const key = process.env.SECRET_QR_TOKEN_SIGNING_KEY ?? "";
const slug = process.env.LOAD_TENANT ?? "alpha-state";

if (databaseUrl === "" || key === "") {
  process.stderr.write("seed: DATABASE_URL and SECRET_QR_TOKEN_SIGNING_KEY are required\n");
  process.exit(1);
}

const db = createDb({ connectionString: databaseUrl });
try {
  const tenant = await db
    .selectFrom("tenants")
    .select(["id"])
    .where("slug", "=", slug)
    .executeTakeFirst();
  if (tenant === undefined) {
    process.stderr.write(`seed: tenant "${slug}" not found; run \`pnpm db:seed\` first\n`);
    process.exit(1);
  }

  const asset = await withTenant(db, tenant.id, async (tx) => {
    const rows = await repositories(tx).assets.listAll(tenant.id);
    return rows[0];
  });
  if (asset === undefined) {
    process.stderr.write(`seed: no asset for "${slug}"; run \`pnpm db:seed\` first\n`);
    process.exit(1);
  }

  // The QR payload is the asset's own opaque token, not its id (ADR 0007).
  const verifyToken = buildQrToken(asset.qrPayload, createQrTokenSigner(key));
  process.stdout.write(`${JSON.stringify({ assetId: asset.id, verifyToken })}\n`);
} finally {
  await db.destroy();
}

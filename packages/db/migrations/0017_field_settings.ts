import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Officer field-app settings become part of the validated tenant config.
 *
 * `field.offlineGraceHours`, `field.maxQueueItems` and `field.disputeReasons`
 * lived in `tenants/_template/field.json`, which nothing read: the app could not
 * get them and the validator did not know they existed. They are policy the
 * officer app needs (how long a cached paid set is trusted, how deep the offline
 * queue may go, which reasons a dispute may cite), so the config schema now
 * requires them and every read of a stored config validates.
 *
 * That makes this migration part of the upgrade, not a nicety: a deployment
 * created before the field section existed would fail validation on its next
 * request. Existing tenants are backfilled with the documented defaults — the
 * same values the template and the seed use — and the application can change
 * them through the config editor afterwards.
 */
const DEFAULT_FIELD = JSON.stringify({
  offlineGraceHours: 8,
  maxQueueItems: 1000,
  disputeReasons: [
    { code: "wrong_location", label: "Wrong location" },
    { code: "already_paid", label: "Already paid" },
    { code: "technical_issue", label: "Technical issue" },
    { code: "other", label: "Other" },
  ],
});

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update tenants
    set config = jsonb_set(config, '{field}', ${DEFAULT_FIELD}::jsonb, true)
    where config -> 'field' is null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`update tenants set config = config - 'field' where config ? 'field'`.execute(db);
}

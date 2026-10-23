import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 4: the Postgres-backed job queue (ADR 0020).
 *
 * The queue carries follow-on work only: sending a receipt enqueued by intake,
 * retrying a delivery, sweeping an outbox. Payment intake itself deliberately
 * does not go through it - `webhook_events` stays the intake outbox (ADR 0016).
 *
 * One table holds every job. Workers claim with `FOR UPDATE SKIP LOCKED`, so
 * several can run at once without a distributed lock. A job that exhausts its
 * attempts is marked dead rather than deleted, so a receipt nobody could
 * deliver stays visible to operations.
 *
 * The table is not tenant-scoped and carries no `tenant_id`: it is
 * infrastructure shared by every tenant, read only by the worker through the
 * application role. Tenancy lives in each job's payload, which is produced by
 * the tenant-scoped code that enqueues it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create type job_status as enum ('pending', 'running', 'done', 'dead')
  `.execute(db);

  await sql`
    create table jobs (
      id uuid primary key default gen_random_uuid(),
      queue text not null,
      payload jsonb not null,
      dedupe_key text,
      status job_status not null default 'pending',
      attempts integer not null default 0 check (attempts >= 0),
      max_attempts integer not null default 3 check (max_attempts > 0),
      run_at timestamptz not null default now(),
      locked_at timestamptz,
      locked_by text,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      completed_at timestamptz,
      constraint jobs_attempts_within_max check (attempts <= max_attempts)
    )
  `.execute(db);

  // The claim query: the oldest due job in a queue that nobody holds.
  await sql`
    create index jobs_claimable_idx
      on jobs (queue, run_at)
      where status = 'pending'
  `.execute(db);

  // A dedupe key is unique while the job is still live (pending or running), so
  // re-enqueueing a receipt for the same payment is a no-op rather than a second
  // SMS. Once the job is done or dead the key is free again.
  await sql`
    create unique index jobs_dedupe_idx
      on jobs (queue, dedupe_key)
      where dedupe_key is not null and status in ('pending', 'running')
  `.execute(db);

  // A job's identity and its payload never change; only its lifecycle does.
  await sql`
    create function reject_job_mutation() returns trigger as $$
    begin
      if NEW.queue <> OLD.queue
        or NEW.payload <> OLD.payload
        or NEW.max_attempts <> OLD.max_attempts
        or NEW.dedupe_key is distinct from OLD.dedupe_key
      then
        raise exception 'job identity is immutable';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger jobs_identity_immutable
      before update on jobs
      for each row execute function reject_job_mutation()
  `.execute(db);

  await sql`grant select, insert, update, delete on jobs to tpirs_app`.execute(db);
  await sql`grant execute on function reject_job_mutation() to tpirs_app`.execute(db);

  // The receipt outbox is tenant-scoped by row-level security, but the worker
  // that drains it is not: it has no tenant to scan with. Rather than grant the
  // application role a cross-tenant read of `sms_log`, expose one narrow
  // `SECURITY DEFINER` function that returns only the tenant and message id of
  // pending messages - never their body or recipient. The worker then opens a
  // normal tenant-scoped transaction per row to claim and deliver it
  // (ADR 0016, ADR 0020).
  await sql`
    create function list_pending_sms(p_limit integer)
    returns table (tenant_id uuid, sms_id uuid)
    language sql
    stable
    security definer
    set search_path = public, pg_temp
    as $$
      select tenant_id, id
      from sms_log
      where status = 'pending'
      order by created_at, id
      limit greatest(p_limit, 0)
    $$
  `.execute(db);
  await sql`revoke all on function list_pending_sms(integer) from public`.execute(db);
  await sql`grant execute on function list_pending_sms(integer) to tpirs_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists list_pending_sms(integer) cascade`.execute(db);
  await sql`drop function if exists reject_job_mutation() cascade`.execute(db);
  await sql`drop table if exists jobs cascade`.execute(db);
  await sql`drop type if exists job_status`.execute(db);
}

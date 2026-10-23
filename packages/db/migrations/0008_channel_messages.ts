import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 5: driver-channel message storage.
 *
 * USSD menus and SMS commands need their own record. `sms_log` is deliberately
 * not reused: it is bound to a payment or an obligation period, carries only
 * receipt/notice content, and freezes its body on insert. A channel message is
 * a different fact: a prompt shown to a driver, an inbound command, or a reply
 * delivered over SMS. Keeping them apart means channel retries and provider
 * callbacks never touch the financial outbox.
 *
 * The table is tenant-scoped with the same row-level security policy as every
 * other tenant table. `dedupe_key` is unique per tenant so replaying a provider
 * callback or a retry cannot create a second message; a null key is allowed for
 * messages that have no natural idempotency token (Postgres treats nulls as
 * distinct).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create type channel_kind as enum ('sms', 'ussd')`.execute(db);
  await sql`create type channel_direction as enum ('inbound', 'outbound')`.execute(db);
  await sql`
    create type channel_message_kind as enum
      ('inbound', 'menu', 'status', 'payment', 'receipt', 'notice')
  `.execute(db);
  await sql`
    create type channel_message_status as enum ('pending', 'sent', 'failed', 'received')
  `.execute(db);

  await sql`
    create table channel_messages (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      channel channel_kind not null,
      direction channel_direction not null,
      kind channel_message_kind not null,
      recipient text not null,
      body text not null,
      status channel_message_status not null default 'pending',
      provider_message_id text,
      reply_to_id uuid,
      dedupe_key text,
      attempts integer not null default 0 check (attempts >= 0),
      last_error text,
      created_at timestamptz not null default now(),
      sent_at timestamptz,
      unique (tenant_id, id),
      constraint channel_messages_reply_fk
        foreign key (tenant_id, reply_to_id)
        references channel_messages (tenant_id, id),
      constraint channel_messages_inbound_is_received check (
        direction <> 'inbound' or status = 'received'
      ),
      constraint channel_messages_outbound_is_not_received check (
        direction <> 'outbound' or status <> 'received'
      )
    )
  `.execute(db);

  await sql`
    create index channel_messages_tenant_idx on channel_messages (tenant_id, created_at)
  `.execute(db);
  await sql`
    create unique index channel_messages_dedupe_idx
      on channel_messages (tenant_id, dedupe_key)
  `.execute(db);
  await sql`
    create index channel_messages_pending_idx
      on channel_messages (tenant_id, created_at)
      where status = 'pending' and direction = 'outbound'
  `.execute(db);
  await sql`
    create index channel_messages_reply_idx
      on channel_messages (tenant_id, reply_to_id)
      where reply_to_id is not null
  `.execute(db);

  // A message's content is written once; only delivery state may change. This
  // mirrors the sms_log guarantee without sharing its table or subject columns.
  await sql`
    create function reject_channel_message_mutation() returns trigger as $$
    begin
      if NEW.tenant_id <> OLD.tenant_id
        or NEW.channel <> OLD.channel
        or NEW.direction <> OLD.direction
        or NEW.kind <> OLD.kind
        or NEW.recipient <> OLD.recipient
        or NEW.body <> OLD.body
        or NEW.reply_to_id is distinct from OLD.reply_to_id
        or NEW.dedupe_key is distinct from OLD.dedupe_key
      then
        raise exception 'channel message content is immutable once recorded';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger channel_messages_content_immutable
      before update on channel_messages
      for each row execute function reject_channel_message_mutation()
  `.execute(db);

  await sql`alter table channel_messages enable row level security`.execute(db);
  await sql`
    create policy tenant_isolation_channel_messages on channel_messages
    using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  `.execute(db);

  await sql`grant select, insert, update on channel_messages to tpirs_app`.execute(db);
  await sql`grant execute on function reject_channel_message_mutation() to tpirs_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists channel_messages cascade`.execute(db);
  await sql`drop function if exists reject_channel_message_mutation() cascade`.execute(db);
  await sql`drop type if exists channel_message_status`.execute(db);
  await sql`drop type if exists channel_message_kind`.execute(db);
  await sql`drop type if exists channel_direction`.execute(db);
  await sql`drop type if exists channel_kind`.execute(db);
}

import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 4: payment intake.
 *
 * Five tables, each with one job:
 *
 * - `webhook_endpoints` maps a per-tenant endpoint token (stored as a SHA-256
 *   hash) to a tenant. It is deliberately not readable by the application role:
 *   the only way in is `resolve_webhook_endpoint()`, a `SECURITY DEFINER`
 *   function that returns the tenant id for one provider/token pair and nothing
 *   else (ADR 0017).
 * - `payment_instructions` maps a payment reference to the asset it pays for,
 *   which is how a webhook is attributed to an asset at all (ADR 0018). Intent
 *   references are single use; a dedicated virtual account or a narration short
 *   code is a long-lived instruction for one asset.
 * - `payments` records money that actually arrived, with the state the intake
 *   decision gave it: `applied` (a day was settled), `credited` (the asset
 *   wallet was credited, no day settled), `suspense`, or `rejected` (ADR 0019).
 * - `webhook_events` is the intake outbox: the raw, signature-verified body is
 *   committed before processing, claimed with `FOR UPDATE SKIP LOCKED`, and
 *   retried with a visible attempt count (ADR 0016).
 * - `sms_log` is the receipt outbox: the rendered body is inserted in the same
 *   transaction as the payment state change, with a unique `(payment_id, kind)`
 *   so a replay or retry cannot send twice (ADR 0020).
 *
 * Applied payments and enqueued SMS bodies are protected by triggers: the money
 * facts of an applied payment never move again, and an outbox row's content is
 * written once.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create type payment_status as enum ('applied', 'credited', 'suspense', 'rejected')
  `.execute(db);
  await sql`
    create type payment_attribution_kind as enum ('intent_reference', 'virtual_account', 'narration')
  `.execute(db);
  await sql`
    create type payment_instruction_status as enum ('active', 'consumed', 'expired', 'revoked')
  `.execute(db);
  await sql`create type sms_kind as enum ('receipt', 'underpayment_notice')`.execute(db);
  await sql`create type sms_status as enum ('pending', 'sent', 'failed')`.execute(db);

  // Per-tenant webhook endpoint tokens. The token itself is never stored.
  await sql`
    create table webhook_endpoints (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      provider text not null,
      token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
      created_at timestamptz not null default now(),
      revoked_at timestamptz,
      unique (token_hash)
    )
  `.execute(db);
  await sql`
    create index webhook_endpoints_tenant_idx on webhook_endpoints (tenant_id, provider)
  `.execute(db);

  // Attribution: which asset a provider reference pays for.
  await sql`
    create table payment_instructions (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      asset_id uuid not null references assets(id),
      provider text not null,
      reference text not null,
      kind payment_attribution_kind not null,
      status payment_instruction_status not null default 'active',
      amount_minor bigint check (amount_minor is null or amount_minor > 0),
      currency char(3),
      idempotency_key text,
      expires_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, provider, reference),
      constraint payment_instructions_amount_currency
        check ((amount_minor is null) = (currency is null))
    )
  `.execute(db);
  await sql`
    create index payment_instructions_tenant_idx on payment_instructions (tenant_id)
  `.execute(db);
  await sql`
    create index payment_instructions_asset_idx on payment_instructions (tenant_id, asset_id)
  `.execute(db);
  // Intent references are created once per payment attempt, so the caller's
  // idempotency key must resolve to the same instruction on a retry.
  await sql`
    create unique index payment_instructions_idempotency_idx
      on payment_instructions (tenant_id, provider, idempotency_key)
      where idempotency_key is not null
  `.execute(db);
  // A long-lived instruction (virtual account, narration) is one per asset and
  // provider. Intent references are one-shot and may accumulate over time.
  await sql`
    create unique index payment_instructions_active_asset_idx
      on payment_instructions (tenant_id, provider, asset_id, kind)
      where status = 'active' and kind <> 'intent_reference'
  `.execute(db);

  await sql`
    create table payments (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      asset_id uuid references assets(id),
      instruction_id uuid references payment_instructions(id),
      provider text not null,
      provider_event_id text not null,
      provider_reference text,
      attribution_kind payment_attribution_kind,
      status payment_status not null,
      amount_minor bigint not null check (amount_minor > 0),
      currency char(3) not null,
      business_date date,
      obligation_period_id uuid references obligation_periods(id),
      transaction_id uuid references transactions(id),
      receipt_number text,
      failure_reason text,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, provider, provider_event_id),
      constraint payments_applied_is_complete check (
        status <> 'applied'
        or (
          asset_id is not null
          and attribution_kind is not null
          and business_date is not null
          and obligation_period_id is not null
          and transaction_id is not null
          and receipt_number is not null
        )
      ),
      constraint payments_business_date_only_when_applied check (
        business_date is null or status = 'applied'
      )
    )
  `.execute(db);
  await sql`create index payments_tenant_idx on payments (tenant_id, created_at)`.execute(db);
  await sql`create index payments_tenant_status_idx on payments (tenant_id, status)`.execute(db);
  await sql`create index payments_asset_idx on payments (tenant_id, asset_id)`.execute(db);
  // An intent reference identifies exactly one payment. Virtual-account and
  // narration references are reused by design, so they are exempt.
  await sql`
    create unique index payments_intent_reference_idx
      on payments (tenant_id, provider, provider_reference)
      where provider_reference is not null and attribution_kind = 'intent_reference'
  `.execute(db);
  await sql`
    create unique index payments_receipt_number_idx
      on payments (tenant_id, receipt_number)
      where receipt_number is not null
  `.execute(db);

  // Intake outbox: raw delivery first, processing afterwards.
  await sql`
    create table webhook_events (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      provider text not null,
      provider_event_id text not null,
      raw_body text not null,
      signature_verified boolean not null,
      received_at timestamptz not null default now(),
      processed_at timestamptz,
      attempts integer not null default 0 check (attempts >= 0),
      last_error text,
      payment_id uuid references payments(id),
      unique (tenant_id, provider, provider_event_id)
    )
  `.execute(db);
  await sql`
    create index webhook_events_pending_idx
      on webhook_events (tenant_id, received_at)
      where processed_at is null
  `.execute(db);

  // Receipt outbox. The body is rendered before insert, so delivery never has
  // to read tenant config or recompute an amount.
  await sql`
    create table sms_log (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      payment_id uuid references payments(id),
      obligation_period_id uuid references obligation_periods(id),
      kind sms_kind not null,
      recipient text not null,
      body text not null,
      status sms_status not null default 'pending',
      attempts integer not null default 0 check (attempts >= 0),
      provider_message_id text,
      last_error text,
      created_at timestamptz not null default now(),
      sent_at timestamptz,
      constraint sms_log_has_a_subject check (
        payment_id is not null or obligation_period_id is not null
      )
    )
  `.execute(db);
  await sql`
    create unique index sms_log_payment_kind_idx
      on sms_log (payment_id, kind)
      where payment_id is not null
  `.execute(db);
  await sql`
    create unique index sms_log_period_kind_idx
      on sms_log (tenant_id, obligation_period_id, kind)
      where obligation_period_id is not null
  `.execute(db);
  await sql`
    create index sms_log_pending_idx on sms_log (tenant_id, created_at) where status = 'pending'
  `.execute(db);

  // The money facts of an applied payment are final. Status may still change if
  // a later phase adds a reversal state, but the date, amount, and ledger links
  // cannot be rewritten.
  await sql`
    create function reject_applied_payment_mutation() returns trigger as $$
    begin
      if OLD.status = 'applied' and (
        NEW.asset_id is distinct from OLD.asset_id
        or NEW.provider_event_id <> OLD.provider_event_id
        or NEW.amount_minor <> OLD.amount_minor
        or NEW.currency <> OLD.currency
        or NEW.business_date is distinct from OLD.business_date
        or NEW.obligation_period_id is distinct from OLD.obligation_period_id
        or NEW.transaction_id is distinct from OLD.transaction_id
        or NEW.receipt_number is distinct from OLD.receipt_number
      ) then
        raise exception 'an applied payment is immutable';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger payments_applied_immutable
      before update on payments
      for each row execute function reject_applied_payment_mutation()
  `.execute(db);

  // An outbox row's content is written once; only delivery state may change.
  await sql`
    create function reject_sms_log_content_mutation() returns trigger as $$
    begin
      if NEW.kind <> OLD.kind
        or NEW.recipient <> OLD.recipient
        or NEW.body <> OLD.body
        or NEW.payment_id is distinct from OLD.payment_id
        or NEW.obligation_period_id is distinct from OLD.obligation_period_id
      then
        raise exception 'sms_log content is immutable once enqueued';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger sms_log_content_immutable
      before update on sms_log
      for each row execute function reject_sms_log_content_mutation()
  `.execute(db);

  // An instruction's identity never changes; only its lifecycle does.
  await sql`
    create function reject_payment_instruction_mutation() returns trigger as $$
    begin
      if NEW.tenant_id <> OLD.tenant_id
        or NEW.asset_id <> OLD.asset_id
        or NEW.provider <> OLD.provider
        or NEW.reference <> OLD.reference
        or NEW.kind <> OLD.kind
      then
        raise exception 'payment instruction identity is immutable';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger payment_instructions_identity_immutable
      before update on payment_instructions
      for each row execute function reject_payment_instruction_mutation()
  `.execute(db);

  // The only read path to webhook_endpoints. Returns one tenant id or null;
  // never the token, the provider configuration, or the tenant's other rows.
  await sql`
    create function resolve_webhook_endpoint(p_provider text, p_token_hash text)
    returns uuid
    language sql
    stable
    security definer
    set search_path = public, pg_temp
    as $$
      select tenant_id
      from webhook_endpoints
      where provider = p_provider
        and token_hash = p_token_hash
        and revoked_at is null
    $$
  `.execute(db);
  await sql`
    revoke all on function resolve_webhook_endpoint(text, text) from public
  `.execute(db);
  await sql`grant execute on function resolve_webhook_endpoint(text, text) to tpirs_app`.execute(
    db,
  );

  const tenantTables = ["payment_instructions", "payments", "webhook_events", "sms_log"];
  for (const table of tenantTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`
      create policy ${sql.raw(`tenant_isolation_${table}`)} on ${sql.table(table)}
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `.execute(db);
  }

  // `webhook_endpoints` is intentionally unreachable for the app role: no
  // policy and no grant. Row-level security with no policy denies every row even
  // if a grant is added later by mistake.
  await sql`alter table webhook_endpoints enable row level security`.execute(db);
  await sql`revoke all on webhook_endpoints from tpirs_app`.execute(db);

  await sql`
    grant select, insert, update on payment_instructions, payments, webhook_events, sms_log
    to tpirs_app
  `.execute(db);
  await sql`grant execute on function reject_applied_payment_mutation() to tpirs_app`.execute(db);
  await sql`grant execute on function reject_sms_log_content_mutation() to tpirs_app`.execute(db);
  await sql`grant execute on function reject_payment_instruction_mutation() to tpirs_app`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists sms_log cascade`.execute(db);
  await sql`drop table if exists webhook_events cascade`.execute(db);
  await sql`drop table if exists payments cascade`.execute(db);
  await sql`drop table if exists payment_instructions cascade`.execute(db);
  await sql`drop table if exists webhook_endpoints cascade`.execute(db);
  await sql`drop function if exists resolve_webhook_endpoint(text, text) cascade`.execute(db);
  await sql`drop function if exists reject_payment_instruction_mutation() cascade`.execute(db);
  await sql`drop function if exists reject_sms_log_content_mutation() cascade`.execute(db);
  await sql`drop function if exists reject_applied_payment_mutation() cascade`.execute(db);
  await sql`drop type if exists sms_status`.execute(db);
  await sql`drop type if exists sms_kind`.execute(db);
  await sql`drop type if exists payment_instruction_status`.execute(db);
  await sql`drop type if exists payment_attribution_kind`.execute(db);
  await sql`drop type if exists payment_status`.execute(db);
}

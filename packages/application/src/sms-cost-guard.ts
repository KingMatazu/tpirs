import { todayInTimeZone } from "@tpirs/domain";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { TenantConfig } from "@tpirs/config";
import type { Clock, Telemetry } from "@tpirs/ports";

/**
 * Why a channel reply was, or was not, allowed to be queued.
 *
 * `allowed` is the only outcome that should enqueue an outbound message. The
 * two limit outcomes are deliberately distinguishable so operations can see
 * whether one noisy recipient or the whole tenant hit the ceiling.
 */
export type SmsCostGuardOutcome = "allowed" | "tenant_limit" | "recipient_limit";

export interface SmsCostGuardInput {
  readonly tenantId: string;
  readonly config: TenantConfig;
  /** The driver's phone number, counted against the per-recipient ceiling. */
  readonly recipient: string;
}

export interface SmsCostGuard {
  check(input: SmsCostGuardInput): Promise<SmsCostGuardOutcome>;
}

export interface SmsCostGuardDeps {
  readonly db: AnyDb;
  readonly clock: Clock;
  readonly telemetry?: Telemetry;
}

/**
 * Caps proactive SMS spend per tenant and per recipient per business day.
 *
 * Counts two tables because they are two halves of one budget: channel replies
 * live in `channel_messages`, and receipts live in `sms_log`. Receipts are
 * transactional and are never suppressed here - a driver who paid is entitled
 * to the receipt - but they consume the same daily allowance, so a burst of
 * payments cannot be followed by an unbounded burst of replies.
 *
 * The business day comes from the tenant's timezone, exactly like obligations,
 * so "today" means the same thing everywhere.
 */
export function createSmsCostGuard(deps: SmsCostGuardDeps): SmsCostGuard {
  async function check(input: SmsCostGuardInput): Promise<SmsCostGuardOutcome> {
    const settings = input.config.channels.sms;
    if (settings === undefined) return "allowed";

    const timeZone = input.config.locale.timezone;
    const businessDate = todayInTimeZone(timeZone, deps.clock.now());

    return withTenant(deps.db, input.tenantId, async (tx) => {
      const channels = repositories(tx).channelMessages;
      const receipts = repositories(tx).smsLog;

      const [channelTotal, receiptTotal] = await Promise.all([
        channels.countSentOnDate(input.tenantId, { channel: "sms", timeZone, businessDate }),
        receipts.countSentOnDate(input.tenantId, { timeZone, businessDate }),
      ]);
      if (channelTotal + receiptTotal >= settings.maxSendsPerDay) return "tenant_limit";

      const [channelRecipient, receiptRecipient] = await Promise.all([
        channels.countSentOnDate(input.tenantId, {
          channel: "sms",
          timeZone,
          businessDate,
          recipient: input.recipient,
        }),
        receipts.countSentOnDate(input.tenantId, {
          timeZone,
          businessDate,
          recipient: input.recipient,
        }),
      ]);
      if (channelRecipient + receiptRecipient >= settings.maxSendsPerRecipientPerDay) {
        return "recipient_limit";
      }

      return "allowed";
    });
  }

  return { check };
}

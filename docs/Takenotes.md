# Takenotes: the "fee leg" in plain language

This note explains one small piece of Phase 8 — the **fee leg** — without
accounting or engineering jargon. It is written for whoever is signing off on
the design: managers, finance staff, new team members. Read this and you should
be able to say what will happen to a payment at the bank, and what "the money
does not add up" actually means here.

---

## 1. The short version

A driver pays a levy of, say, ₦500 through the payment gateway. The gateway
keeps a small commission, say ₦10, and sends ₦490 to the state's bank account.

Our books record the full ₦500 as the driver's payment. The bank statement
shows ₦490. That ₦10 gap is **not** an error, and it is not the state being
short-changed — it is the gateway's fee, announced in the gateway's contract.

The **fee leg** is the bookkeeping entry that records the ₦10 as a known
expense, so the books can balance exactly against the bank. Without it, every
single payment would look like it had gone missing by ₦10, and a genuine
shortfall could hide in that noise forever.

That is the whole idea: **record the fee openly so that only real problems show
up as problems.**

---

## 2. What happens today (before Phase 8)

Right now the platform does the first half of the story and then stops.

- When the gateway confirms a driver's payment, we record: "the gateway owes us
  ₦500". That is correct — the driver has paid in full.
- But nothing ever records the gateway paying us, and nothing records the fee.

So the pile labelled "money the gateway still owes us" only ever grows. It
never shrinks, even though money has genuinely arrived in the bank. Nobody has
done anything wrong; the second half of the process simply does not exist yet.

For the first deployment this stayed invisible because the fee is small and the
platform was not deepening its bank reconciliation. Phase 8 is where that
changes, because Phase 8 is where we start comparing our books to the bank.

**In v1, therefore, the fee leg does not exist yet: there is no fee expense
account, no fee posting, and no way for the books to reach zero against a real
statement.** That is exactly the gap Phase 8 closes.

---

## 3. What Phase 8 will do (step by step, in everyday terms)

A finance person uploads the bank statement for the day, or the platform fetches
it from the gateway. For each line on that statement, the platform does three
things:

1. **Find the matching payment.** A statement line carries the gateway's
   reference for a payment, so we look up which driver's payment it is.
2. **Check the arithmetic.** We compare what the driver paid with what the bank
   received. If the difference is a plausible gateway fee — inside a limit
   configured for the tenant — we accept the explanation.
3. **Write the three-part entry.** In one indivisible step:
   - money arrived in the bank: **bank goes up by what was received**;
   - the gateway charged a fee: **fee expense goes up by the difference**;
   - the gateway no longer owes us: **the gateway's debt goes down by the full
     payment amount**.

The gateway's debt therefore falls by exactly the amount that was originally
recorded, the bank rises by exactly what arrived, and the fee sits visibly as a
cost. The numbers close.

### Worked example

| Item                                 | Amount |
| ------------------------------------ | ------ |
| Driver paid (levy)                   | ₦500   |
| Gateway fee                          | ₦10    |
| Money received in the bank           | ₦490   |
| Fee limit configured for this tenant | ₦25    |

Result: the ₦10 difference is inside the ₦25 limit, so the entry is written
automatically, and the day's "gateway still owes us" figure drops by ₦500 —
to zero for that payment. The ₦10 appears in the books as a fee cost. Nothing
appears in the exceptions queue, because nothing is wrong.

Now the same day, but the fee turns out to be ₦60:

| Item                                 | Amount |
| ------------------------------------ | ------ |
| Driver paid (levy)                   | ₦500   |
| Gateway fee                          | ₦60    |
| Money received in the bank           | ₦440   |
| Fee limit configured for this tenant | ₦25    |

Result: the ₦60 difference is **outside** the ₦25 limit. Nothing is written to
the books automatically. An item is placed in the **exceptions queue** showing
"we expected between ₦475 and ₦500 in the bank, we received ₦440". A person
investigates. No money is invented, and no fee is quietly accepted just because
the software found a way to make the totals match.

### The two guard rails

- **Fees are capped, not assumed.** The limit decides whether a difference is
  "explainable as a fee" or "needs a human". It is per tenant configuration, not
  hardcoded, because different gateways charge differently. Start it low; raise
  it only with evidence from real statements.
- **Over-payment never posts itself.** If the bank receives _more_ than the
  driver was charged, the difference is not treated as a negative fee. That line
  becomes an exception, exactly as the Phase 7 cash rules already leave an
  over-deposit in suspense rather than crediting someone twice.

---

## 4. What "reconciled" means to a non-accountant

At the end of the nightly run, Phase 8 asks a handful of plain questions, and
the checklist answers them:

- Did every line on the bank statement find its payment? (If not: which lines?)
- Did every payment for the day end up accounted for at the gateway and at the
  bank, allowing for fees within the limit?
- Does the money we say the gateway owes us actually reach zero? (It should,
  once fees are recorded.)
- Does the cash collectors took in match the cash they deposited?
- Does the money we booked as revenue match the days we marked as paid?
- Do the total amounts on the left of the books equal the total on the right?

If all of that is yes, a finance user signs the day off. Signing off is a
recorded act with a name, a time and a note — and it cannot be undone by
editing. If something later turns up (a late payment, a missing statement
line), the platform produces a **new version** of that day's reconciliation
rather than changing the old one. History stays history.

If something is "no", an exception appears in a queue with an owner-assigned
severity: blocking (do not sign off) or warning (carry on, but look at it).

---

## 5. The honest limits of v1

Worth stating plainly, so nobody expects more than was built:

- **Fees must be plausible, not itemised.** We record a total fee per statement
  line. We do not itemise the gateway's fee breakdown (VAT, stamp duty,
  per-transaction charge, cap). If a gateway's real total falls outside the
  limit, it becomes an exception rather than a modelled fee.
- **One statement line must match one payment.** If a gateway sends a single
  lump-sum line covering many payments, v1 cannot split it. It goes to the
  exceptions queue for finance to handle deliberately. Automatic splitting is
  future work.
- **No foreign currency yet.** Settlement is expected in the tenant's currency.
  Multi-currency settlement and exchange-rate differences are out of scope.
- **Fee limits are a tenant setting, tuned against real statements.** Until a
  tenant has uploaded real statements, the limit is a starting guess, and some
  exceptions in the first weeks are expected and healthy.
- **Settlement data arrives either as an upload or via a gateway feed.** Both
  end up in the same place, but not every gateway can supply the feed yet.
- **Nothing about this changes what a driver owes.** The fee is the state's cost
  of collecting, not an extra charge added to the levy. The driver pays the
  levy; the state receives the levy minus the gateway's cut; the platform shows
  that cut honestly.

---

## 6. Why this matters beyond tidiness

Under `pay_per_use`, a day with no payment is not a debt, so the platform must
never present "no money moved" as a problem. By contrast, "money moved but we
cannot explain the difference" is a real problem, and it should be visible
immediately.

The fee leg is what makes that distinction possible. Once fees are recorded
openly:

- a gap that remains after fees is a genuine exception, worth a phone call;
- a quiet, growing pile of "gateway owes us" cannot hide, because the pile is
  expected to reach zero each night;
- a state auditor can see the full journey of a driver's levy, from the driver's
  phone to the state's bank account, including what the gateway kept.

That is the entire purpose of the fee leg: **make the normal difference normal,
so the abnormal difference stands out.**

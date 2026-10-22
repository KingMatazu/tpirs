# 0013: Reversal by mirrored entries with dual approval

## Context

Build brief section 6: "Corrections are reversing entries needing a second
approver" and "Reversal needs a second approver". The ledger is append-only
(ADR 0012), so a correction cannot be an edit or a delete; it has to be a new
transaction that undoes the old one.

The platform also separates roles: a system admin administers tenants and
configuration but must not be able to touch financial data.

## Decision

- A correction is requested first and posted later. `reversal_requests` holds
  the request, its reason, the requester, the status, and the reversing
  transaction once one is posted.
- `LedgerService.requestReversal` opens a request. It refuses outright when
  the caller is a system admin.
- `LedgerService.approveReversal` posts the reversing transaction and marks
  the request approved **in the same database transaction**, so an approved
  reversal can never exist without its reversing transaction, and a posted
  reversal can never be left unapproved.
- Approval requires:
  - a different person from the requester (`cannot approve own reversal
request`),
  - finance approval (`finance approval required`), and
  - a pending request.
    A system admin is refused here too.
- The reversing entries are the **mirror** of the original: every direction is
  flipped, every amount and currency and dimension is copied. The mirror is
  produced by the pure domain function `mirrorPostings` in
  `packages/domain/src/ledger.ts`, which is also covered by the property tests
  in `packages/domain/src/ledger.property.test.ts`.
- The reversing transaction is idempotent on `reversal:{requestId}` and its
  source type is `reversal`, with the original transaction id as its source,
  so the pair is always traceable in both directions.
- The original transaction is never touched. Its entries remain exactly as
  posted, and the pair nets to zero for every account.

## Consequences

- A reversal cannot be forged by editing history: the only way to undo money
  is to post the mirror of a real transaction.
- The mirrored transaction is itself a balanced transaction, so the deferred
  balance trigger (ADR 0012) applies to it as well.
- The request/approval split gives the audit trail a "who asked and who
  approved" answer that a single posting would not.
- Reversals are full-transaction only. Partial reversals are deferred
  (decisions-needed D13).
- The finance-approval flag is passed in by the caller. The service does not
  decide who is finance; that is the permission layer's job, and the
  database records the approver id either way.

## Alternatives considered

- **Update the original entries to their opposite.** Rejected: it destroys
  the original record and breaks the append-only guarantee.
- **Delete the original and re-post.** Rejected: same objection, and it loses
  the audit trail entirely.
- **Store a "reversed" flag on the original transaction.** Rejected as a
  _substitute_ for the mirror: a flag alone does not move the money, and the
  balances would stay wrong. The flag may be added later as a convenience
  view, on top of the mirror.
- **Allow the requester to approve their own request.** Rejected: it is a
  single-person control over financial data, and the brief requires a second
  approver.
- **Post the reversal in a separate transaction from the approval.** Rejected:
  a crash between the two would leave money reversed with no approved
  request, or an approved request with no reversal.

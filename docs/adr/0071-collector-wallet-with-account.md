# ADR 0071: A collector account comes with its wallet

## Status

Accepted.

## Context

`collector_wallets` was created lazily: the seed made one, `lockWallet` made one
on the first intake, and the dashboard's **Collectors** screen listed only rows
that already existed. A collector therefore stayed invisible to the cash screen
until they had taken cash — and could not be provisioned with a funding
destination before that, because the destination route and the collector app both
assume a wallet row exists.

On a fresh tenant created through the setup wizard, the only collector account
was the one an administrator added, and it had no wallet. The app answered "no
funding account" while finance had no wallet to open and provision.

## Decision

- **Creating an account whose roles include `collector` creates its wallet** in
  the same transaction. The same happens on an edit that adds the collector role.
- **Existing collector accounts are backfilled** by migration 0030, which inserts
  the missing wallet for every non-deleted user holding the collector role.
- **Provisioning a funding destination ensures the wallet exists** before it
  writes the instruction, covering any account the backfill missed.
- **The wallets list repairs the invariant before it reads**, so a database that
  missed the backfill (or an account created by an older build) cannot hide a
  collector from finance. The insert is idempotent and creates only an empty
  wallet.
- The wallet stays a single row per collector, with `ensureWallet` idempotent, so
  the paths converge rather than competing.
- This does not create wallets for other roles: an officer or finance admin has
  no cash position.

## Consequences

- Every collector appears on the dashboard's cash screen from the day the account
  is created, and can be given a terminal immediately.
- A collector who never takes cash has an empty wallet row; the derived balance
  remains zero and nothing posts until an intake.
- The dev-tools "Set up demo funding account" button in the collector app uses
  the same provisioning route and therefore also benefits from the ensured
  wallet; it is not a second creation path.
- Deleting an account keeps its tombstoned row and wallet history, as before.

## Alternatives considered

- **Make the wallet list join `users` with the collector role** and show a
  walletless row. Rejected: every screen would carry a nullable wallet, and the
  funding destination would still have no row to hang from.
- **Create the wallet on first view** (`GET /v1/cash/wallets`). Rejected: a read
  would write, and the dashboard list itself is the read.
- **Keep lazy creation and provision the instruction anyway.** Rejected: the
  collector's screen calls the wallet endpoint first and would 404.

# ADR 0056: The handover card prints itself, and a lost password is re-issued rather than recovered

## Status

Accepted

## Context

The handover card (ADR 0053) is the only moment a temporary password is readable:
the server stores a hash. Two gaps showed up in pilot use.

1. **Print printed the page.** `window.print()` printed the whole dashboard — the
   navigation, the account list, the "Add an account" form — with the card
   somewhere in the middle. What an administrator needs is a slip for a shared
   handset, or a PDF to send.
2. **Re-opening the card showed no password.** The **Handover** button on an
   account row exists to repeat the address and the username, and it correctly
   omitted the password. An administrator reading it as "show me the password
   again" found a sentence telling them to ask the person who created the account
   — which is often themselves.

## Decision

- **Printing is a print stylesheet, not a PDF library.** The card is marked
  `data-print="handover"`; `@media print` removes every element from the print
  layout and puts back the card and its ancestors (a `:has()` rule — `display:
none` on a parent cannot be undone by a child). Controls that only exist on
  screen carry `no-print`. The PDF is the browser's **Save as PDF** destination.
- **The ancestor chain comes back, so the page does not print blank.** The common
  `visibility: hidden` approach leaves hidden elements occupying their height,
  which turns a long account list into several empty pages.
- **`display: revert`, not a second layout.** Rows print stacked rather than
  side by side. That is acceptable on paper and avoids a parallel print-only
  stylesheet that would drift from the screen.
- **A lost password is re-issued, never recovered.** When the card was opened from
  the account row, it offers **Set a new temporary password**: the same route as
  a reset, with a generated password, which ends the account's sessions and
  re-flags it. The card then carries the new password, so **Copy handover text**
  includes it.

## Consequences

- `:has()` requires Chrome 105 / Safari 15.4 / Firefox 121. The dashboard already
  requires `Intl.supportedValuesOf` for the setup wizard's dropdowns, which has
  the same baseline, so no new browser is excluded.
- No dependency was added. A PDF library would have meant shipping fonts, a
  layout engine and a second renderer of the same card, to produce something the
  browser already produces.
- Re-issuing a password is destructive by design: the old one stops working and
  any session it opened ends. The button says so, and the toast repeats it, so an
  administrator cannot do it by accident while trying to "view" a password.
- The printed slip has no password when the card was re-opened — the password
  line is absent rather than misleading, because a handover slip without a
  password is only useful after a re-issue.

## Alternatives considered

- **A PDF library (jsPDF, pdf-lib, react-pdf).** Rejected: a new dependency, a
  second layout of the same content, and fonts to embed, for output the print
  dialog already produces. The brief requires an ADR for any new dependency; this
  one would have been hard to justify.
- **`visibility: hidden` on `body *`.** Rejected for the blank-page problem above.
- **Storing the temporary password so it can be shown again.** Rejected outright:
  it turns a hashed credential into a recoverable one, and the audit trail would
  have to explain why.
- **Rendering a print-only copy of the card into a body-level container.**
  Rejected as more machinery (portal, duplicate markup, cleanup) for the same
  result as one `:has()` rule.

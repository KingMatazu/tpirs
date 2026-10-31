# ADR 0048: QR scanning and the test-only IndexedDB fake

## Status

Accepted

## Context

The officer app has to read a sticker. The requirements are: it must work on the
Android phones the pilot will use (low-end, Chrome), it must work on an iPhone
for a supervisor who happens to carry one, it must not ship a megabyte of
decoder to a handset on a 2G connection, and manual entry of the short code or
plate must always be available because stickers get scratched.

Two decoders exist in browsers:

- `BarcodeDetector` — a native API, present in Chrome on Android, hardware
  accelerated, zero bundle cost. Absent in Safari and in older WebViews.
- Pure-JavaScript decoders — work everywhere, cost bundle size and CPU per frame.

The app also needs tests for its offline store. The sync logic that matters
(cursor resume, business-date rollover, removal on reversal) only fails in ways a
UI test would not catch, and those tests need IndexedDB under jsdom.

## Decision

**Scanning: native first, `jsqr` as the fallback, behind one module**
(`apps/field/src/scanner`). `scannerSupport()` reports which path is available so
the screen can open on the manual tab instead of prompting for a camera that does
not exist. `jsqr` is imported dynamically, so a browser with `BarcodeDetector`
never downloads it.

Alternatives considered:

- **`BarcodeDetector` only** — fails on iOS and older Android WebViews, and a
  supervisor's phone is not a device we control.
- **`@zxing/browser` only** — capable and well maintained, but ~300 KB before
  gzip and a heavier API than this needs.
- **Manual entry only** — cheapest, but scanning is the product: an officer
  typing plate numbers at a checkpoint is slower than the paper process it
  replaces.
- **Server-side decoding of a photo** — needs a network round trip per scan,
  which is exactly what the offline requirement forbids.

**Tests: `fake-indexeddb` as a dev dependency.** It is an in-memory IndexedDB
implementation used only by the field app's tests. Alternatives: a real browser
in CI (slow, flaky, and the repo has no browser runner), or abstracting the store
behind an interface and testing only pure functions (which would leave the
transactional parts — exactly where rollover and idempotency live — untested).

## Consequences

- Two decoder paths to keep working. They are covered by one contract: both hand
  a raw string to the same `onToken`, and `normaliseToken` is unit-tested for
  what a scanner adds (whitespace, a sticker URL wrapper).
- `jsqr` adds ~40 KB, in a lazy chunk, only for browsers without a native
  detector.
- `fake-indexeddb` is dev-only and never reaches a bundle.
- Camera behaviour itself (permissions, torch, focus) cannot be asserted in
  jsdom; it is verified by hand on a phone, which is recorded in the Phase 6
  acceptance table.

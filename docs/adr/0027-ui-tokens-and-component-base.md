# 0027: UI tokens and the copy-in component base

## Context

The dashboard must re-theme and re-label per tenant with no code changes (Phase 9 acceptance), and white-labelling forbids hardcoded colors, logos, or copy in core UI code. We also need accessible primitives (menus, dialogs, popovers) without taking a heavyweight component framework into `apps/admin`.

## Decision

- **`packages/ui-tokens`:** a pure, framework-free package that maps a validated `TenantConfig` (branding + locale) into design tokens:
  - `buildDesignTokens(config)` produces a token map; `tokensToCssRoot()` emits CSS custom properties (`--tpirs-color-primary`, `--color-secondary`, `--color-accent`, plus locale facts like currency/timezone/default language) that the app applies to `:root` on tenant load. Components read only tokens.
  - Intl helpers (`formatMoneyMinor`, `formatBusinessDate`) using the tenant's currency/number/date-format and language — the same contract the backend uses for serialisation.
- **Copy-in component base (shadcn-style):** `apps/admin` carries local `src/components/ui/*` components built on Radix primitives + Tailwind classes, copied in rather than imported from an npm UI kit. The dashboard is replaceable and themable, so owning the components beats depending on a library that ships its own theme.
- **Stack:** Vite + React + TypeScript strict, Tailwind v4 (`@tailwindcss/vite`), TanStack Query for server state, zustand for session/UI state, react-hook-form + zod for forms, lucide for icons, jsdom + Testing Library for component tests.
- **Tailwind palette binds to tokens:** utility classes reference the `--tpirs-*` custom properties via Tailwind variables, so switching tenants re-themes by swapping one CSS block — no component code branches on tenant.

## Consequences

- Onboarding a state = config change; two tenants side by side re-theme with zero component edits (Phase 9 acceptance).
- The polish of an npm UI kit is traded for ownership: we update copied components ourselves; accepted, and the count of copy-in components stays small.

## Alternatives considered

- **MUI/Ant.** Rejected: heavy runtime, opinionated theming that fights CSS-variable white-labelling, and hard to make "replaceable client" true.
- **npm shadcn/ui package import.** Rejected: it is published as copy-in source by design; importing a third-party mirror would defeat the theming goal.
- **Fetch tokens at runtime in CSS only.** Rejected: locale-sensitive formatting must be available to JS (dates, money), so tokens are computed in TS and surfaced both to CSS and to helpers.

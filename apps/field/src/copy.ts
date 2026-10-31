/**
 * Officer-facing copy, in one place.
 *
 * `@tpirs/i18n` exists for the *driver* channels: USSD menus and SMS templates
 * are tenant-supplied data validated at startup, because a driver reads them on
 * a feature phone in their own language. The officer app is staff tooling and is
 * English in v1, like the dashboard and the collector app. Keeping the strings in
 * one module means a later translation pass is mechanical (replace `copy.x` with
 * `t("field.x")`) instead of a hunt through JSX.
 *
 * One rule is load-bearing: no string here may say a vehicle is "unpaid". The
 * only truthful offline answer is "not in the offline list" — absence from a
 * cache is not evidence of debt.
 */
export const copy = {
  app: {
    title: "Officer",
    signOut: "Sign out",
    signOutConfirm: "Sign out of this device?",
  },
  login: {
    heading: "Officer sign-in",
    subheading: "Scan stickers and check today's payment.",
    state: "State",
    stateHint: "The tenant slug, for example alpha-state.",
    username: "Username",
    password: "Password",
    totp: "Authenticator code",
    totpHint: "Six digits from your authenticator app.",
    submit: "Sign in",
    submitting: "Signing in…",
    failed: "Check the state, username and password, then try again.",
    locked: "Too many attempts. Wait a minute and try again.",
    offline: "No connection. Sign in when the phone is back online.",
  },
  home: {
    greeting: "Signed in as",
    today: "Today",
    scan: "Scan a sticker",
    scanHint: "Camera or the short code on the sticker.",
    scanComing: "The scanner arrives with the scan screen.",
    sync: "Sync now",
    syncNever: "Not synced yet",
    settings: "Settings",
  },
} as const;

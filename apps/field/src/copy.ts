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
    today: "Business date",
    scan: "Scan a sticker",
    scanHint: "Camera or the short code on the sticker.",
    paidList: "Paid today",
    vehicle: "vehicle",
    vehicles: "vehicles",
    lastSync: "Last sync",
    waitingToSync: "Waiting to upload",
    sync: "Sync now",
    syncing: "Syncing…",
    syncNever: "Not synced yet",
    neverSynced: "This phone has no paid list yet. Sync before scanning.",
    staleList: "The paid list is more than {hours} hours old. Sync before relying on it.",
    syncOffline: "No connection. The list on this phone is unchanged.",
    syncRateLimited: "The server asked us to slow down. Try again in a minute.",
    syncDisabled: "This state has switched offline checking off. Sync is not available.",
    syncFailed: "The sync did not finish. Try again before relying on the list.",
    flushAuth: "Your session has expired, so scans cannot upload. Sign in again.",
    flushFailed:
      "{count} scan(s) could not be uploaded and will not be retried. Show them to your supervisor.",
    settings: "Settings",
  },
  scan: {
    title: "Scan",
    cameraTab: "Camera",
    manualTab: "Type a code",
    cameraLabel: "Camera viewfinder",
    hint: "Point the camera at the sticker's QR code.",
    starting: "Starting the camera…",
    cameraDenied: "Camera permission was refused. Type the short code or plate instead.",
    cameraUnavailable: "This phone cannot scan QR codes here. Type the code instead.",
    manualLabel: "Short code or plate number",
    manualSubmit: "Check this vehicle",
  },
  dispute: {
    title: "Raise a dispute",
    for: "About",
    reasonLabel: "What happened?",
    descriptionLabel: "What did you see?",
    descriptionHint: "A sentence or two. The office reads this, not the driver.",
    photoLabel: "Photo (optional)",
    photoHint: "The sticker, the vehicle or the situation.",
    photoTooLarge:
      "That photo could not be shrunk enough to send, so the dispute will be saved without it.",
    submit: "Send dispute",
    submitting: "Sending…",
    needReason: "Pick what happened.",
    needDescription: "Describe what you saw.",
    recorded: "Dispute sent to the office.",
    queued: "Dispute saved on this phone. It will upload when there is a connection.",
    queueFull: "This phone cannot hold any more. Tell your supervisor about this one now.",
    rejected: "The office did not accept this dispute. Check the vehicle and try again.",
    done: "Done",
  },
  result: {
    title: "Result",
    scanAgain: "Scan another",
    dispute: "Raise a dispute",
    paidHeading: "Paid today",
    paidDetail: "This vehicle is in today's paid list.",
    noPaymentHeading: "No payment recorded today",
    noPaymentDetail: "The ledger has no payment for this vehicle on this business date.",
    notInListHeading: "Not in the offline list",
    notInListDetail: "The phone has no record of a payment today for this vehicle.",
    unknownHeading: "Could not confirm",
    unknownDetail: "The payment record could not be read. Ask the driver for a receipt.",
    queued: "Saved on this phone. It will upload when there is a connection.",
    corrected: "The ledger has a newer record than this phone did. The ledger is shown.",
    unreadableHeading: "Code not recognised",
    unreadableDetail: "That is not one of our stickers. Check the sticker or type the code.",
    unreadableHint: "Clean the sticker and try again, or type the short code or plate number.",
    smsFallback:
      "Ask the driver to text {keyword} {reference} to {sender} — the reply is the authority.",
    smsFallbackNoConfig:
      "Ask the driver for their receipt, or check again when the phone is back online.",
    reference: "Reference",
    businessDate: "Business date",
    unknownReference: "—",
    unknownDate: "—",
  },
} as const;

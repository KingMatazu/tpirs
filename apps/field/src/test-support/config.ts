import { loadTenantConfigFromString } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";

/**
 * A minimal but *validated* tenant config for the app's tests.
 *
 * It goes through the real loader on purpose: a hand-built object literal would
 * drift from the schema and let the app compile against fields the server no
 * longer sends.
 */
const YAML = `
identity:
  name: "Alpha State"
  slug: "alpha-state"
  legalEntity: "Alpha State Revenue Board"
  supportContacts:
    email: "help@alpha.example"
    phone: "+2348000000000"
locale:
  defaultLanguage: "en"
  enabledLanguages: ["en"]
  timezone: "Africa/Lagos"
  currency: "NGN"
  numberFormat: "en-NG"
  dateFormat: "dd/MM/yyyy"
branding:
  appName: "Alpha Levy"
  logoUrl: "https://alpha.example/logo.svg"
  colors:
    primary: "#0a5"
    secondary: "#111"
    accent: "#222"
  smsSenderId: "ALPHA"
  receiptHeader: "Alpha State"
  receiptFooter: "Thank you"
assetTypes:
  - key: "bike"
    label: "Bike"
    attributes:
      - key: "plate_number"
        label: "Plate number"
        type: "string"
        required: true
    qrFormat: "A-{id}"
    shortCodeFormat: "A{id}"
    stickerSpec: "60x60mm"
obligations:
  model: "pay_per_use"
  frequency: "daily"
  prepaidAllowed: false
  arrearsPolicy: "none"
  graceDays: 0
  feeRules:
    - key: "bike-daily"
      assetTypeKey: "bike"
      amountMinor: 20000
      effectiveFrom: "2026-01-01"
providers: []
channels:
  ussdCode: "*347#"
  smsKeyword: "LEVY"
  otpMessageTemplate: "Your code is {code}"
  smsReceiptTemplate: "Receipt {receiptNo}: {amount} for {assetRef} on {date}."
  menus: []
cashRules:
  enabled: true
  floatCeilingMinor: 5000000
  depositDeadlineHours: 24
  freezeOnShortfall: true
featureFlags:
  disputes: true
  prepay: false
  offlineMode: true
  anomalyAlerts: true
field:
  offlineGraceHours: 8
  maxQueueItems: 1000
  disputeReasons:
    - code: "already_paid"
      label: "Already paid"
    - code: "other"
      label: "Other"
reconciliation:
  enabled: true
  schedule: "0 2 * * *"
  toleranceMinor: 100
  notifyRole: "finance_admin"
compliance:
  retentionDays: 2555
  dataResidency: "ng"
  consentTextKey: "consent.default"
`;

export function testConfig(): TenantConfig {
  return loadTenantConfigFromString(YAML);
}

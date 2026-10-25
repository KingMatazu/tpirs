import { loadTenantConfigFromString } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";

/**
 * Shared tenant-config fixture for the admin tests. Loaded through the real
 * validator so assertions hold this file honest: if the fixture stops being a
 * valid TenantConfig, loading throws.
 */
export const fixtureYaml = `
identity:
  name: "Example State"
  slug: "example-state"
  legalEntity: "Example State Revenue Authority"
  supportContacts:
    email: "support@example.state.gov"
    phone: "+2348000000000"
locale:
  defaultLanguage: "en"
  enabledLanguages: ["en", "ha"]
  timezone: "Africa/Lagos"
  currency: "NGN"
  numberFormat: "en-NG"
  dateFormat: "dd/MM/yyyy"
branding:
  appName: "Example Levy"
  logoUrl: "https://cdn.example.state.gov/logo.svg"
  colors:
    primary: "#0a5"
    secondary: "#053"
    accent: "#fc0"
  smsSenderId: "EXLEVY"
  receiptHeader: "Example State Levy"
  receiptFooter: "Thank you"
assetTypes:
  - key: "bike"
    label: "Bicycle"
    attributes:
      - key: "plate_number"
        label: "Plate number"
        type: "string"
        required: true
        pattern: "^[A-Z0-9]{5,8}$"
    qrFormat: "EX-{id}"
    shortCodeFormat: "B{id}"
    stickerSpec: "60x60mm vinyl"
obligations:
  model: "pay_per_use"
  frequency: "daily"
  prepaidAllowed: false
  arrearsPolicy: "none"
  graceDays: 0
  allocationOrder: "today_first"
  feeRules:
    - key: "bike-daily"
      assetTypeKey: "bike"
      amountMinor: 20000
      effectiveFrom: "2026-01-01"
providers:
  - port: "PaymentProvider"
    adapter: "mock"
    secrets:
      apiKey: "tenant/example/paystack-key"
channels:
  ussdCode: "*347*9#"
  smsKeyword: "LEVY"
  otpMessageTemplate: "Example: your code is {code}"
  smsReceiptTemplate: "Example receipt {receiptNo}: {amount} paid for {assetRef} on {date}."
  startMenu: "main"
  messages:
    en:
      ussd.main.prompt: "Example Levy. Reply with an option."
      ussd.main.pay: "Pay levy"
      ussd.main.invalid: "Unknown option."
      ussd.account.prompt: "Enter the vehicle short code."
      ussd.account.error: "Short code looks wrong."
    ha:
      ussd.main.prompt: "Kuɗin Jiha. Amsa da zaɓi."
      ussd.main.pay: "Biya kuɗin"
      ussd.main.invalid: "Zaɓi mara inganci."
      ussd.account.prompt: "Shigar da lambar motar."
      ussd.account.error: "Lamba ba daidai ba."
  ussd:
    sessionTimeoutSeconds: 120
    maxInputLength: 16
    maxSteps: 8
    rateLimit:
      perMsisdnPerMinute: 10
      perIpPerMinute: 60
  menus:
    - key: "main"
      promptKey: "ussd.main.prompt"
      invalidKey: "ussd.main.invalid"
      options:
        - key: "1"
          labelKey: "ussd.main.pay"
          next: "account"
        - key: "9"
          labelKey: "ussd.main.pay"
          action: "status"
    - key: "account"
      type: "input"
      promptKey: "ussd.account.prompt"
      input:
        key: "assetRef"
        pattern: "^[A-Z0-9]{6,8}$"
        errorKey: "ussd.account.error"
      next: "complete"
    - key: "complete"
      type: "action"
      action: "pay"
    - key: "orphan"
      type: "action"
      action: "cancel"
cashRules:
  enabled: true
  floatCeilingMinor: 5000000
  depositDeadlineHours: 24
  freezeOnShortfall: true
payments:
  underpaymentPolicy: "suspense"
featureFlags:
  disputes: true
  prepay: false
  offlineMode: true
  anomalyAlerts: true
reconciliation:
  schedule: "0 2 * * *"
  toleranceMinor: 100
  notifyRole: "finance_admin"
compliance:
  retentionDays: 2555
  dataResidency: "ng"
  consentTextKey: "consent.default"
`;

export function loadFixtureConfig(): TenantConfig {
  return loadTenantConfigFromString(fixtureYaml);
}

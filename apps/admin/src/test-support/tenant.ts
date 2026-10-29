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
  cashReceiptTemplate: "Example cash {amount} for {assetRef}. Receipt {receiptNo}, {date}."
  startMenu: "main"
  messages:
    en:
      ussd.main.prompt: "Example Levy. Reply with an option."
      ussd.main.pay: "Pay levy"
      ussd.main.invalid: "Unknown option."
      ussd.account.prompt: "Enter the vehicle short code."
      ussd.account.error: "Short code looks wrong."
      ussd.common.error: "Something went wrong. Please try again."
      ussd.session.cancelled: "Cancelled."
      ussd.session.too_many_steps: "Too many steps. Please start again."
      ussd.rate.limited: "Too many requests. Please wait a minute."
      ussd.session.busy: "Your session is still processing. Please wait."
      sms.command.unknown: "Unknown command. Send LEVY with your short code."
      ussd.status.paid: "Payment recorded for today."
      ussd.status.none: "No payment recorded for today."
      ussd.asset.unknown: "No vehicle matches that code."
      ussd.pay.created: "Payment instruction created. Check your SMS."
      ussd.pay.failed: "Payment could not be started. Please try again."
      ussd.pay.covered: "Today is already paid."
    ha:
      ussd.main.prompt: "Kuɗin Jiha. Amsa da zaɓi."
      ussd.main.pay: "Biya kuɗin"
      ussd.main.invalid: "Zaɓi mara inganci."
      ussd.account.prompt: "Shigar da lambar motar."
      ussd.account.error: "Lamba ba daidai ba."
      ussd.common.error: "An sami matsala. Don Allah sake gwadawa."
      ussd.session.cancelled: "An soke."
      ussd.session.too_many_steps: "Matakai da yawa. Don Allah fara sabo."
      ussd.rate.limited: "Buƙatu da yawa. Don Allah jira minti ɗaya."
      ussd.session.busy: "Ana sarrafa buƙatarka. Don Allah jira."
      sms.command.unknown: "Umarni mara inganci. Aika LEVY da lambar motar."
      ussd.status.paid: "An rubuta biyan kuɗin yau."
      ussd.status.none: "Ba a rubuta biyan kuɗin yau ba."
      ussd.asset.unknown: "Babu motar da ta dace da wannan lambar."
      ussd.pay.created: "An ƙirƙiri umarnin biya. Duba saƙonka."
      ussd.pay.failed: "Ba a iya fara biya ba. Don Allah sake gwadawa."
      ussd.pay.covered: "An riga an biya na yau."
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
  feeToleranceMinor: 1000
  suspenseAgeingDays: 7
  notifyRole: "finance_admin"
  anomalyRules:
    - key: "collector_volume_drop"
      enabled: false
      windowDays: 14
      thresholdPercent: 30
      severity: "warning"
    - key: "collector_deposit_lag"
      enabled: false
      windowDays: 7
      thresholdMinor: 1
      severity: "warning"
    - key: "zone_compliance_drop"
      enabled: false
      windowDays: 14
      thresholdPercent: 20
      severity: "warning"
    - key: "officer_scan_volume_change"
      enabled: false
      windowDays: 14
      thresholdPercent: 50
      severity: "info"
    - key: "suspense_growth"
      enabled: false
      windowDays: 7
      thresholdMinor: 500000
      severity: "warning"
  settlementImport:
    provider: "mock"
    defaultCurrency: "NGN"
    columns:
      reference: "reference"
      amount: "amount"
      fee: "fee"
      currency: "currency"
      settledAt: "settled_at"
      description: "narration"
    dateFormat: "YYYY-MM-DD HH:mm:ss"
    amountInMinorUnits: true
    decimalSeparator: "."
compliance:
  retentionDays: 2555
  dataResidency: "ng"
  consentTextKey: "consent.default"
`;

export function loadFixtureConfig(): TenantConfig {
  return loadTenantConfigFromString(fixtureYaml);
}

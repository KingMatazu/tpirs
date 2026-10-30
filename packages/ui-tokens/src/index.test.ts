import { describe, expect, it } from "vitest";
import { loadTenantConfigFromString } from "@tpirs/config";
import {
  buildDesignTokens,
  formatBusinessDate,
  formatMajorAmountInput,
  formatMoneyMinor,
  parseMajorToMinor,
  tokensToCssRoot,
} from "./index.js";

const fixtureYaml = `
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
    label: "Motorbike"
    attributes: []
    qrFormat: "EX-{id}"
    shortCodeFormat: "B{id}"
    stickerSpec: "60x60mm vinyl"
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
providers:
  - port: "PaymentProvider"
    adapter: "mock"
channels:
  ussdCode: "*347*9#"
  smsKeyword: "LEVY"
  otpMessageTemplate: "Example: your code is {code}"
  smsReceiptTemplate: "Example receipt {receiptNo}: {amount} paid for {assetRef} on {date}."
  startMenu: "main"
  messages:
    en:
      ussd.main.prompt: "Example Levy. Reply with an option."
      ussd.main.invalid: "Unknown option."
      ussd.main.pay: "Pay levy"
      ussd.pay.asset: "Enter short code"
      ussd.pay.asset_error: "Short code looks wrong."
      ussd.status.asset: "Enter short code"
      ussd.status.asset_error: "Short code looks wrong."
      ussd.status.none: "No payment recorded for this asset today."
      ussd.status.paid: "Paid for today."
      ussd.pay.created: "Payment request created."
      ussd.pay.failed: "Payment request failed."
      ussd.pay.balance: "Balance is {amount}."
      ussd.pay.covered: "Covers until {date}."
      ussd.pay.insufficient: "Amount too low."
      ussd.session.cancelled: "Session cancelled."
      ussd.session.too_many_steps: "Too many steps."
      ussd.rate.limited: "Too many requests. Try again later."
      ussd.session.busy: "Please try again."
      ussd.common.error: "Something went wrong."
      ussd.asset.unknown: "Asset not found."
      sms.command.unknown: "Unknown command."
    ha:
      ussd.main.prompt: "Example Levy. Reply with an option."
      ussd.main.invalid: "Unknown option."
      ussd.main.pay: "Pay levy"
      ussd.pay.asset: "Enter short code"
      ussd.pay.asset_error: "Short code looks wrong."
      ussd.status.asset: "Enter short code"
      ussd.status.asset_error: "Short code looks wrong."
      ussd.status.none: "No payment recorded for this asset today."
      ussd.status.paid: "Paid for today."
      ussd.pay.created: "Payment request created."
      ussd.pay.failed: "Payment request failed."
      ussd.pay.balance: "Balance is {amount}."
      ussd.pay.covered: "Covers until {date}."
      ussd.pay.insufficient: "Amount too low."
      ussd.session.cancelled: "Session cancelled."
      ussd.session.too_many_steps: "Too many steps."
      ussd.rate.limited: "Too many requests. Try again later."
      ussd.session.busy: "Please try again."
      ussd.common.error: "Something went wrong."
      ussd.asset.unknown: "Asset not found."
      sms.command.unknown: "Unknown command."
  menus:
    - key: "main"
      promptKey: "ussd.main.prompt"
      invalidKey: "ussd.main.invalid"
      options:
        - key: "1"
          labelKey: "ussd.main.pay"
          next: "pay"
    - key: "pay"
      type: "action"
      action: "pay"
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

const config = loadTenantConfigFromString(fixtureYaml);

describe("buildDesignTokens", () => {
  it("emits every configured brand colour as a custom property", () => {
    const tokens = buildDesignTokens(config);
    expect(tokens.variables["--tpirs-color-primary"]).toBe("#0a5");
    expect(tokens.variables["--tpirs-color-secondary"]).toBe("#053");
    expect(tokens.variables["--tpirs-color-accent"]).toBe("#fc0");
    expect(tokens.variables["--tpirs-locale-currency"]).toBe("NGN");
    expect(tokens.variables["--tpirs-locale-timezone"]).toBe("Africa/Lagos");
    expect(tokens.branding.appName).toBe("Example Levy");
  });

  it("renders injectable CSS with no tenant literals left in code", () => {
    const css = tokensToCssRoot(buildDesignTokens(config));
    expect(css).toContain(":root {");
    expect(css).toContain("--tpirs-color-primary: #0a5;");
    expect(css.endsWith("}")).toBe(true);
  });
});

describe("formatMoneyMinor", () => {
  it("divides minor units and respects the currency's digits", () => {
    expect(formatMoneyMinor(20000, "NGN", "en-NG")).toBe("₦200.00");
    expect(formatMoneyMinor(20000n, "NGN", "en-NG")).toBe("₦200.00");
    expect(formatMoneyMinor("30000", "NGN", "en-NG")).toBe("₦300.00");
  });

  it("formats zero-decimal currencies without fraction digits", () => {
    // Cedi has digits=2; use a zero-digit currency to exercise the branch.
    expect(formatMoneyMinor(2500, "JPY", "en")).toBe("¥2,500");
  });
});

describe("formatBusinessDate", () => {
  const instant = "2026-03-07T08:30:00.000Z";

  it("applies the tenant date pattern with zero padding", () => {
    expect(formatBusinessDate(instant, "en-NG", "dd/MM/yyyy")).toBe("07/03/2026");
    expect(formatBusinessDate(instant, "en-GH", "yyyy-MM-dd")).toBe("2026-03-07");
  });

  it("rejects invalid dates loudly", () => {
    expect(() => formatBusinessDate("not-a-date", "en-NG", "dd/MM/yyyy")).toThrow();
  });
});

describe("major-unit input", () => {
  it("parses a typed amount into minor units", () => {
    expect(parseMajorToMinor("200", "NGN", "en-NG")).toBe(20000n);
    expect(parseMajorToMinor("200.5", "NGN", "en-NG")).toBe(20050n);
    expect(parseMajorToMinor("1,250.00", "NGN", "en-NG")).toBe(125000n);
  });

  it("refuses what is not an amount", () => {
    expect(parseMajorToMinor("", "NGN", "en-NG")).toBeUndefined();
    expect(parseMajorToMinor("abc", "NGN", "en-NG")).toBeUndefined();
    expect(parseMajorToMinor("-5", "NGN", "en-NG")).toBeUndefined();
    // More decimals than the currency has.
    expect(parseMajorToMinor("1.234", "NGN", "en-NG")).toBeUndefined();
  });

  it("round-trips a fee rule into the input and back", () => {
    const typed = formatMajorAmountInput(20000n, "NGN", "en-NG");
    expect(typed).toBe("200.00");
    expect(parseMajorToMinor(typed, "NGN", "en-NG")).toBe(20000n);
  });
});

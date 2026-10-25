const fs = require('fs');
const path = 'apps/admin/src/test-support/tenant.ts';
let s = fs.readFileSync(path, 'utf8');
const start = s.indexOf('  channels:');
const end = s.indexOf('\n  cashRules:');
const replacement = `  channels:
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
        ussd.main.cancel: "Cancel"
        ussd.account.prompt: "Enter the vehicle short code."
        ussd.account.error: "Short code looks wrong."
        ussd.status.paid: "Paid today for {assetRef}."
        ussd.status.none: "No payment recorded today for {assetRef}."
        ussd.asset.unknown: "Unknown vehicle."
        ussd.pay.created: "Payment request created for {assetRef}."
        ussd.pay.failed: "Could not start payment for {assetRef}."
        ussd.pay.covered: "Already covered for {assetRef} today."
        ussd.pay.balance: "Paid from wallet for {assetRef}."
        ussd.pay.insufficient: "Wallet balance is not enough for {assetRef}."
        ussd.session.cancelled: "Session cancelled."
        ussd.session.too_many_steps: "Too many steps."
        ussd.rate.limited: "Too many requests. Try again later."
        ussd.session.busy: "Please try again."
        ussd.common.error: "Something went wrong."
        sms.command.unknown: "Unknown command."
      ha:
        ussd.main.prompt: "Kuɗin Jiha. Amsa da zaɓi."
        ussd.main.pay: "Biya kuɗin"
        ussd.main.invalid: "Zaɓi mara inganci."
        ussd.main.cancel: "Soke"
        ussd.account.prompt: "Shigar da lambar motar."
        ussd.account.error: "Lamba ba daidai ba."
        ussd.status.paid: "An biya yau don {assetRef}."
        ussd.status.none: "Ba a biya ba yau don {assetRef}."
        ussd.asset.unknown: "Ba a san abin hawa ba."
        ussd.pay.created: "An ƙirƙiri buƙatar biya don {assetRef}."
        ussd.pay.failed: "Ba a iya fara biya ba don {assetRef}."
        ussd.pay.covered: "An riga an biya don {assetRef} yau."
        ussd.pay.balance: "An biya daga walat don {assetRef}."
        ussd.pay.insufficient: "Bai isa ba don {assetRef}."
        ussd.session.cancelled: "An soke zaman."
        ussd.session.too_many_steps: "Matakai sun yi yawa."
        ussd.rate.limited: "Yawan buƙata. Gwada kuma."
        ussd.session.busy: "Gwada kuma."
        ussd.common.error: "Wani kuskure ya faru."
        sms.command.unknown: "Umurni ba a sani ba."
`;
s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(path, s);
console.log('done');

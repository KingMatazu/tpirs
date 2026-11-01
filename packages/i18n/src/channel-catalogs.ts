import type { MessageCatalogs } from "./index.js";

/**
 * The platform's shipped driver-channel copy, one catalogue per language.
 *
 * These are defaults, not tenant data: a tenant's `channels.messages` is seeded
 * from here when it is provisioned and then belongs to that tenant, who may
 * reword every key. Keeping them in `@tpirs/i18n` rather than in an app or a
 * seed script is what lets onboarding create a working tenant without a
 * developer pasting message text into a form.
 *
 * Two rules for this file:
 *
 * - **Copy is app-neutral.** No `{appName}` placeholder: the menu prompt is
 *   rendered without variables, so one would raise `missing_variable` at a
 *   driver's first dial.
 * - **Every key the runtime can reach exists in every language.**
 *   `defaults.test.ts` in `@tpirs/config` asserts the contract
 *   (`CHANNEL_MESSAGE_KEYS`) and the default menu graph are both satisfied, so a
 *   missing translation fails the build rather than a USSD session.
 */
export const CHANNEL_CATALOGS: MessageCatalogs = {
  en: {
    "ussd.main.prompt": "Reply with an option.",
    "ussd.main.pay": "Pay today's levy",
    "ussd.main.status": "Check payment status",
    "ussd.main.invalid": "Unknown option. Try again.",
    "ussd.common.cancel": "Cancel",
    "ussd.common.confirm": "Confirm",
    "ussd.pay.enter": "Enter your vehicle plate or sticker code.",
    "ussd.pay.invalid": "That code is not valid. Try again.",
    "ussd.pay.confirm": "Pay today's levy for {assetRef}?",
    "ussd.status.enter": "Enter your vehicle plate or sticker code.",
    "ussd.status.invalid": "That code is not valid. Try again.",
    "ussd.status.paid": "Paid today for {assetRef}.",
    "ussd.status.none": "No payment recorded today for {assetRef}.",
    "ussd.pay.created": "Payment request created for {assetRef}.",
    "ussd.pay.failed": "We could not start a payment. Try again later.",
    "ussd.pay.balance": "Paid today from your balance for {assetRef}.",
    "ussd.pay.covered": "Your balance already covers today's levy for {assetRef}.",
    "ussd.pay.insufficient": "Your balance is short by {amount} for {assetRef}.",
    "ussd.asset.unknown": "No vehicle matches {assetRef}.",
    "ussd.common.error": "Something went wrong. Try again later.",
    "ussd.session.cancelled": "Cancelled. Dial back whenever you need to pay.",
    "ussd.session.too_many_steps": "Too many steps. Please start again.",
    "ussd.rate.limited": "Too many requests. Please wait a minute and try again.",
    "ussd.session.busy": "Your request is still being processed. Please wait.",
    "sms.command.unknown": "Reply with {keyword} followed by your plate or sticker code.",
  },
  fr: {
    "ussd.main.prompt": "Choisissez une option.",
    "ussd.main.pay": "Payer la taxe du jour",
    "ussd.main.status": "Vérifier le paiement",
    "ussd.main.invalid": "Option inconnue. Réessayez.",
    "ussd.common.cancel": "Annuler",
    "ussd.common.confirm": "Confirmer",
    "ussd.pay.enter": "Entrez la plaque ou le code du véhicule.",
    "ussd.pay.invalid": "Code invalide. Réessayez.",
    "ussd.pay.confirm": "Payer la taxe du jour pour {assetRef} ?",
    "ussd.status.enter": "Entrez la plaque ou le code du véhicule.",
    "ussd.status.invalid": "Code invalide. Réessayez.",
    "ussd.status.paid": "Payé aujourd'hui pour {assetRef}.",
    "ussd.status.none": "Aucun paiement enregistré aujourd'hui pour {assetRef}.",
    "ussd.pay.created": "Demande de paiement créée pour {assetRef}.",
    "ussd.pay.failed": "Impossible de démarrer le paiement. Réessayez plus tard.",
    "ussd.pay.balance": "Payé aujourd'hui depuis votre solde pour {assetRef}.",
    "ussd.pay.covered": "Votre solde couvre déjà la taxe du jour pour {assetRef}.",
    "ussd.pay.insufficient": "Votre solde est insuffisant de {amount} pour {assetRef}.",
    "ussd.asset.unknown": "Aucun véhicule ne correspond à {assetRef}.",
    "ussd.common.error": "Une erreur est survenue. Réessayez plus tard.",
    "ussd.session.cancelled": "Annulé. Recomposez le code quand vous voulez payer.",
    "ussd.session.too_many_steps": "Trop d'étapes. Veuillez recommencer.",
    "ussd.rate.limited": "Trop de demandes. Patientez une minute puis réessayez.",
    "ussd.session.busy": "Votre demande est encore en cours. Veuillez patienter.",
    "sms.command.unknown": "Répondez avec {keyword} suivi de votre plaque ou code.",
  },
};

/** Languages this build can provision: every one has a complete catalogue. */
export const CHANNEL_CATALOG_LANGUAGES: readonly string[] = Object.keys(CHANNEL_CATALOGS);

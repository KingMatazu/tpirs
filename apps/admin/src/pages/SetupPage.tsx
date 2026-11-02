import { useState, type ReactElement } from "react";
import { formatMoneyMinor, parseMajorToMinor } from "@tpirs/ui-tokens";
import { api } from "../api/client.js";
import { errorFrom, type ApiResult } from "../api/unwrap.js";
import { Button, Field, TextInput } from "../components/ui.js";

/**
 * First-run onboarding: turns an empty deployment into one with a tenant.
 *
 * Four steps — State, Levy, Review, Sign in — rendered outside `Layout` because
 * there is no tenant to brand or navigate yet. All colour comes from the
 * `--tpirs-color-*` variables whose `:root` defaults are neutral.
 *
 * Money is entered in **major units** ("300.00") and converted to minor units on
 * submit with `parseMajorToMinor`, the inverse of the `formatMoneyMinor` every
 * screen uses — the exact pair the brief requires, so the only place a decimal
 * point is ever typed is here.
 */
const STEPS = ["State", "Levy", "Review", "Sign in"] as const;
type Step = 1 | 2 | 3 | 4;

/** Languages this build can provision: those with a shipped driver catalogue. */
const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
] as const;

interface Draft {
  readonly name: string;
  readonly slug: string;
  readonly legalEntity: string;
  readonly supportEmail: string;
  readonly supportPhone: string;
  readonly timezone: string;
  readonly currency: string;
  readonly language: string;
  readonly adminEmail: string;
  readonly bikeFeeMajor: string;
  readonly tuktukFeeMajor: string;
  readonly ussdCode: string;
  readonly smsSenderId: string;
}

interface CreatedTenant {
  readonly tenantSlug: string;
  readonly temporaryUsername: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const EMPTY: Draft = {
  name: "",
  slug: "",
  legalEntity: "",
  supportEmail: "",
  supportPhone: "",
  timezone: "",
  currency: "",
  language: "en",
  adminEmail: "",
  bikeFeeMajor: "",
  tuktukFeeMajor: "",
  ussdCode: "",
  smsSenderId: "",
};

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Field props for an error that may or may not be present. `Field` declares
 * `error?: string` under exactOptionalPropertyTypes, so passing `error={undefined}`
 * is a type error; the spread keeps the "no error" case truly absent.
 */
function fieldError(
  errors: Readonly<Record<string, string>>,
  key: string,
): { readonly error: string } | Record<string, never> {
  const message = errors[key];
  return message === undefined ? {} : { error: message };
}

/** The API's issue paths map back to the field the wizard rendered them under. */
function issuePathToField(path: string): string | undefined {
  switch (path) {
    case "name":
      return "name";
    case "slug":
      return "slug";
    case "legalEntity":
      return "legalEntity";
    case "supportContacts.email":
      return "supportEmail";
    case "supportContacts.phone":
      return "supportPhone";
    case "locale.timezone":
      return "timezone";
    case "locale.currency":
      return "currency";
    case "locale.defaultLanguage":
    case "locale.enabledLanguages":
      return "language";
    case "branding.smsSenderId":
      return "smsSenderId";
    case "channels.ussdCode":
      return "ussdCode";
    case "obligations.feeRules.0.amountMinor":
      return "bikeFeeMajor";
    case "obligations.feeRules.1.amountMinor":
      return "tuktukFeeMajor";
    case "adminEmail":
      return "adminEmail";
    default:
      return undefined;
  }
}

/** The step a field belongs to, so a server rejection can land on it. */
function fieldStep(field: string): Step {
  const step1 = new Set([
    "name",
    "slug",
    "legalEntity",
    "supportEmail",
    "supportPhone",
    "timezone",
    "currency",
    "language",
    "adminEmail",
  ]);
  if (step1.has(field)) return 1;
  return 2;
}

interface SetupIssue {
  readonly path: string;
  readonly message: string;
}

function setupIssues(error: unknown): SetupIssue[] {
  const body =
    typeof error === "object" && error !== null
      ? (error as { error?: Record<string, unknown> }).error
      : undefined;
  const raw = body?.issues;
  if (!Array.isArray(raw)) return [];
  const issues: SetupIssue[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : "";
    const message = typeof record.message === "string" ? record.message : "";
    issues.push({ path, message });
  }
  return issues;
}

export function SetupPage(): ReactElement {
  const [step, setStep] = useState<Step>(1);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [reviewIssues, setReviewIssues] = useState<readonly string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [tenant, setTenant] = useState<CreatedTenant | undefined>(undefined);

  const set = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const setName = (name: string): void => {
    setDraft((current) => ({
      ...current,
      name,
      slug: slugTouched ? current.slug : deriveSlug(name),
    }));
  };

  const stepTitle: Record<Step, string> = {
    1: "State details",
    2: "Daily levy",
    3: "Review",
    4: "Create your sign-in",
  };

  const bikeHint = majorHint(draft.bikeFeeMajor, draft.currency, draft.language);
  const tuktukHint = majorHint(draft.tuktukFeeMajor, draft.currency, draft.language);

  function step1Errors(): Record<string, string> {
    const result: Record<string, string> = {};
    if (draft.name.trim() === "") result["name"] = "State name is required";
    if (draft.slug.trim() === "") result["slug"] = "Slug is required";
    else if (!SLUG_PATTERN.test(draft.slug)) {
      result["slug"] = "Slug must be lowercase letters, digits and hyphens";
    }
    if (draft.legalEntity.trim() === "") result["legalEntity"] = "Legal entity is required";
    if (!EMAIL_PATTERN.test(draft.supportEmail.trim())) {
      result["supportEmail"] = "Support email must be a valid email address";
    }
    if (draft.supportPhone.trim() === "") result["supportPhone"] = "Support phone is required";
    if (!draft.timezone.includes("/")) {
      result["timezone"] = "Timezone must be an IANA zone like Region/City";
    }
    if (!/^[A-Za-z]{3}$/.test(draft.currency.trim())) {
      result["currency"] = "Currency must be a 3-letter ISO code";
    }
    if (!EMAIL_PATTERN.test(draft.adminEmail.trim())) {
      result["adminEmail"] = "Administrator email must be a valid email address";
    }
    return result;
  }

  function step2Errors(): Record<string, string> {
    const result: Record<string, string> = {};
    const bike = parseMajorToMinor(draft.bikeFeeMajor, draft.currency, draft.language);
    const tuktuk = parseMajorToMinor(draft.tuktukFeeMajor, draft.currency, draft.language);
    if (bike === undefined || bike <= 0n) result["bikeFeeMajor"] = "Enter the daily motorbike levy";
    if (tuktuk === undefined || tuktuk <= 0n) {
      result["tuktukFeeMajor"] = "Enter the daily tuk-tuk levy";
    }
    if (draft.ussdCode.trim() === "") result["ussdCode"] = "USSD code is required";
    if (draft.smsSenderId.trim() === "") result["smsSenderId"] = "SMS sender id is required";
    return result;
  }

  function submit(): void {
    void (async () => {
      setErrors({});
      setReviewIssues([]);
      const bikeFeeMinor = parseMajorToMinor(draft.bikeFeeMajor, draft.currency, draft.language);
      const tuktukFeeMinor = parseMajorToMinor(draft.tuktukFeeMajor, draft.currency, draft.language);
      if (bikeFeeMinor === undefined || tuktukFeeMinor === undefined) return;

      setSubmitting(true);
      // The setup route declares only its 201 response, so openapi-fetch types
      // `error` as absent; cast to the loose result shape the rest of the
      // dashboard reads (unwrap.ts) before inspecting the envelope.
      const result = (await api.POST("/v1/setup/tenant", {
        body: {
          name: draft.name.trim(),
          slug: draft.slug.trim(),
          legalEntity: draft.legalEntity.trim(),
          supportEmail: draft.supportEmail.trim(),
          supportPhone: draft.supportPhone.trim(),
          timezone: draft.timezone.trim(),
          currency: draft.currency.trim().toUpperCase(),
          ussdCode: draft.ussdCode.trim(),
          smsSenderId: draft.smsSenderId.trim(),
          bikeFeeMinor: Number(bikeFeeMinor),
          tuktukFeeMinor: Number(tuktukFeeMinor),
          adminEmail: draft.adminEmail.trim(),
          languages: [draft.language],
          defaultLanguage: draft.language,
        },
      })) as ApiResult<CreatedTenant>;

      if (result.error !== undefined && result.error !== null) {
        const issues = setupIssues(result.error);
        const fieldErrors: Record<string, string> = {};
        const unmapped: string[] = [];
        let firstField: string | undefined;
        for (const issue of issues) {
          const field = issuePathToField(issue.path);
          if (field === undefined) unmapped.push(issue.message);
          else {
            fieldErrors[field] = issue.message;
            firstField ??= field;
          }
        }
        if (issues.length === 0) unmapped.push(errorFrom(result).message);
        setErrors(fieldErrors);
        setReviewIssues(unmapped);
        setSubmitting(false);
        // Land on the first field that needs fixing rather than leaving the
        // operator on a review screen that does not show the problem.
        setStep(firstField === undefined ? 3 : fieldStep(firstField));
        return;
      }

      const created = result.data;
      if (created === undefined) {
        setReviewIssues(["The tenant was not created"]);
        setSubmitting(false);
        return;
      }
      setTenant({ tenantSlug: created.tenantSlug, temporaryUsername: created.temporaryUsername });
      setSubmitting(false);
      setStep(4);
    })();
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-xl">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--tpirs-color-accent)]">
            First-run setup
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            Welcome to your revenue platform
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            This deployment has no tenant yet. Four short steps turn it into a working levy
            system.
          </p>
        </header>

        <ol className="mb-8 flex flex-wrap items-center gap-2" aria-label="Setup steps">
          {STEPS.map((label, index) => (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                  index + 1 === step
                    ? "bg-[var(--tpirs-color-accent)] text-slate-900"
                    : "bg-[var(--tpirs-color-primary)] text-white"
                }`}
              >
                {index + 1}
              </span>
              <span className="text-sm text-slate-700">{label}</span>
              {index < STEPS.length - 1 ? (
                <span className="h-px w-6 bg-slate-300" aria-hidden="true" />
              ) : null}
            </li>
          ))}
        </ol>

        <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">{stepTitle[step]}</h2>

          {step === 1 ? (
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const fieldErrors = step1Errors();
                setErrors(fieldErrors);
                setReviewIssues([]);
                if (Object.keys(fieldErrors).length === 0) setStep(2);
              }}
            >
              <Field label="State name" {...fieldError(errors, "name")}>
                <TextInput
                  value={draft.name}
                  onValueChange={setName}
                  placeholder="State name"
                  autoComplete="off"
                />
              </Field>
              <Field label="Slug" {...fieldError(errors, "slug")} hint="Used in the sign-in form and URLs.">
                <TextInput
                  value={draft.slug}
                  onValueChange={(value) => {
                    setSlugTouched(true);
                    set({ slug: deriveSlug(value) });
                  }}
                  placeholder="state-slug"
                  autoComplete="off"
                />
              </Field>
              <Field label="Legal entity" {...fieldError(errors, "legalEntity")}>
                <TextInput
                  value={draft.legalEntity}
                  onValueChange={(value) => {
                    set({ legalEntity: value });
                  }}
                  placeholder="State revenue authority"
                  autoComplete="off"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Support email" {...fieldError(errors, "supportEmail")}>
                  <TextInput
                    value={draft.supportEmail}
                    onValueChange={(value) => {
                      set({ supportEmail: value });
                    }}
                    placeholder="support@state.gov"
                    autoComplete="off"
                  />
                </Field>
                <Field label="Support phone" {...fieldError(errors, "supportPhone")}>
                  <TextInput
                    value={draft.supportPhone}
                    onValueChange={(value) => {
                      set({ supportPhone: value });
                    }}
                    placeholder="+000000000000"
                    autoComplete="off"
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Timezone" {...fieldError(errors, "timezone")}>
                  <TextInput
                    value={draft.timezone}
                    onValueChange={(value) => {
                      set({ timezone: value });
                    }}
                    placeholder="Region/City"
                    autoComplete="off"
                  />
                </Field>
                <Field label="Currency" {...fieldError(errors, "currency")}>
                  <TextInput
                    value={draft.currency}
                    onValueChange={(value) => {
                      set({ currency: value.toUpperCase() });
                    }}
                    placeholder="ISO code"
                    autoComplete="off"
                  />
                </Field>
              </div>
              <Field label="Language" {...fieldError(errors, "language")}>
                <select
                  aria-label="Language"
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  value={draft.language}
                  onChange={(event) => {
                    set({ language: event.currentTarget.value });
                  }}
                >
                  {LANGUAGES.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Administrator email"
                {...fieldError(errors, "adminEmail")}
                hint="Where the person who finishes setup can be reached; nothing is sent yet."
              >
                <TextInput
                  value={draft.adminEmail}
                  onValueChange={(value) => {
                    set({ adminEmail: value });
                  }}
                  placeholder="admin@state.gov"
                  autoComplete="off"
                />
              </Field>
              <div className="flex justify-end">
                <Button type="submit">Continue</Button>
              </div>
            </form>
          ) : null}

          {step === 2 ? (
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const fieldErrors = step2Errors();
                setErrors(fieldErrors);
                setReviewIssues([]);
                if (Object.keys(fieldErrors).length === 0) setStep(3);
              }}
            >
              <p className="text-sm text-slate-600">
                The daily levy a driver pays for each asset type, in your currency.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="Motorbike (per day)"
                  {...fieldError(errors, "bikeFeeMajor")}
                  {...(bikeHint === undefined ? {} : { hint: bikeHint })}
                >
                  <TextInput
                    value={draft.bikeFeeMajor}
                    onValueChange={(value) => {
                      set({ bikeFeeMajor: value });
                    }}
                    placeholder="300.00"
                    inputMode="decimal"
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Tuk-tuk (per day)"
                  {...fieldError(errors, "tuktukFeeMajor")}
                  {...(tuktukHint === undefined ? {} : { hint: tuktukHint })}
                >
                  <TextInput
                    value={draft.tuktukFeeMajor}
                    onValueChange={(value) => {
                      set({ tuktukFeeMajor: value });
                    }}
                    placeholder="450.00"
                    inputMode="decimal"
                    autoComplete="off"
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="USSD code" {...fieldError(errors, "ussdCode")}>
                  <TextInput
                    value={draft.ussdCode}
                    onValueChange={(value) => {
                      set({ ussdCode: value });
                    }}
                    placeholder="*123#"
                    autoComplete="off"
                  />
                </Field>
                <Field label="SMS sender id" {...fieldError(errors, "smsSenderId")}>
                  <TextInput
                    value={draft.smsSenderId}
                    onValueChange={(value) => {
                      set({ smsSenderId: value });
                    }}
                    placeholder="LEVY"
                    autoComplete="off"
                  />
                </Field>
              </div>
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStep(1);
                  }}
                >
                  Back
                </Button>
                <Button type="submit">Continue</Button>
              </div>
            </form>
          ) : null}

          {step === 3 ? (
            <div className="mt-4 space-y-4">
              <ReviewRows
                rows={[
                  ["State name", draft.name],
                  ["Slug", draft.slug],
                  ["Legal entity", draft.legalEntity],
                  ["Support", `${draft.supportEmail} · ${draft.supportPhone}`],
                  ["Timezone", draft.timezone],
                  ["Currency", draft.currency.toUpperCase()],
                  [
                    "Language",
                    LANGUAGES.find((l) => l.value === draft.language)?.label ?? draft.language,
                  ],
                  ["Motorbike levy", money(draft.bikeFeeMajor, draft.currency, draft.language)],
                  ["Tuk-tuk levy", money(draft.tuktukFeeMajor, draft.currency, draft.language)],
                  ["USSD code", draft.ussdCode],
                  ["SMS sender id", draft.smsSenderId],
                  ["Administrator email", draft.adminEmail],
                ]}
              />
              {reviewIssues.length > 0 ? <ProblemList problems={reviewIssues} /> : null}
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStep(2);
                  }}
                >
                  Back
                </Button>
                <Button onClick={submit} disabled={submitting}>
                  {submitting ? "Creating…" : "Create tenant"}
                </Button>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="mt-4 space-y-4">
              {tenant !== undefined ? (
                <p className="text-sm text-slate-600">
                  The tenant{" "}
                  <span className="font-medium text-slate-900">{tenant.tenantSlug}</span> is ready.
                  Choose the administrator&rsquo;s sign-in next.
                </p>
              ) : (
                <p className="text-sm text-slate-600">Sign-in setup arrives in the next step.</p>
              )}
              <div className="flex justify-start">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStep(3);
                  }}
                >
                  Back
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function money(major: string, currency: string, language: string): string {
  const minor = parseMajorToMinor(major, currency, language);
  if (minor === undefined || major.trim() === "") return "—";
  return formatMoneyMinor(minor, currency, language);
}

function majorHint(major: string, currency: string, language: string): string | undefined {
  const minor = parseMajorToMinor(major, currency, language);
  if (minor === undefined) return undefined;
  return formatMoneyMinor(minor, currency, language);
}

function ProblemList(props: { readonly problems: readonly string[] }): ReactElement {
  return (
    <ul className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {props.problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

function ReviewRows(props: { readonly rows: readonly (readonly [string, string])[] }): ReactElement {
  return (
    <dl className="divide-y divide-slate-100 rounded-md border border-slate-200">
      {props.rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 px-3 py-2">
          <dt className="text-sm text-slate-500">{label}</dt>
          <dd className="text-sm font-medium text-slate-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

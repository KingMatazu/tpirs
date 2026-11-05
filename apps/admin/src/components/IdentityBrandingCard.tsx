import { useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TenantConfig } from "@tpirs/config";
import { api } from "../api/client.js";
import { BrandingLogo } from "./BrandingLogo.js";
import { Button, Card, Field, TextInput } from "./ui.js";
import { describeError, pushToast } from "../toast.js";
import { fetchLogoUrl, LogoError, readLogoFile } from "../lib/logoImage.js";

/**
 * The state's own details: logo, support contacts, legal entity, app name and
 * brand colours. System admin only — the API guards it with `tenant:configure`
 * and audits the change with its before/after.
 *
 * The fee, providers and channels are deliberately absent. Those are operational
 * configuration with their own rules (a fee change moves money), not branding a
 * state authority fixes after the first-run wizard.
 */

type FieldKey = "logoUrl" | "supportEmail" | "supportPhone" | "legalEntity" | "appName" | "colors";

/** Server issue paths are config paths; map them onto the fields on this card. */
const FIELD_FOR_PATH: Readonly<Record<string, FieldKey>> = {
  "branding.logoUrl": "logoUrl",
  "identity.supportContacts.email": "supportEmail",
  "identity.supportContacts.phone": "supportPhone",
  "identity.legalEntity": "legalEntity",
  "branding.appName": "appName",
  "branding.colors.primary": "colors",
  "branding.colors.secondary": "colors",
  "branding.colors.accent": "colors",
};

export function fieldIssues(error: unknown): Readonly<Record<string, string>> {
  // Accepts either the error envelope or a `{ error: envelope }` wrapper, so a
  // caller cannot get it subtly wrong.
  const record =
    typeof error === "object" && error !== null
      ? (error as { issues?: unknown; error?: { issues?: unknown } })
      : undefined;
  const issues = record?.issues ?? record?.error?.issues;
  if (!Array.isArray(issues)) return {};
  const mapped: Record<string, string> = {};
  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue;
    const path = (issue as { path?: unknown }).path;
    const message = (issue as { message?: unknown }).message;
    if (typeof path !== "string" || typeof message !== "string") continue;
    const field = FIELD_FOR_PATH[path];
    if (field !== undefined) mapped[field] = message;
  }
  return mapped;
}

export function IdentityBrandingCard(
  props: Readonly<{ readonly config: TenantConfig }>,
): ReactElement {
  const queryClient = useQueryClient();
  const branding = props.config.branding;
  const identity = props.config.identity;

  const [logoUrl, setLogoUrl] = useState(branding.logoUrl);
  const [supportEmail, setSupportEmail] = useState(identity.supportContacts.email);
  const [supportPhone, setSupportPhone] = useState(identity.supportContacts.phone);
  const [legalEntity, setLegalEntity] = useState(identity.legalEntity);
  const [appName, setAppName] = useState(branding.appName);
  const [primary, setPrimary] = useState(branding.colors.primary);
  const [secondary, setSecondary] = useState(branding.colors.secondary);
  const [accent, setAccent] = useState(branding.colors.accent);
  const [urlDraft, setUrlDraft] = useState("");
  const [showUrl, setShowUrl] = useState(false);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // `exactOptionalPropertyTypes` is on: pass `error` only when there is one.
  const fieldError = (key: FieldKey): { error?: string } => {
    const message = errors[key];
    return message === undefined ? {} : { error: message };
  };

  const readFile = async (file: File): Promise<void> => {
    setBusy(true);
    setErrors({});
    try {
      setLogoUrl(await readLogoFile(file));
    } catch (error) {
      const message =
        error instanceof LogoError ? error.message : "That image could not be prepared.";
      pushToast({ kind: "error", message });
    } finally {
      setBusy(false);
    }
  };

  const useUrl = async (): Promise<void> => {
    setBusy(true);
    setErrors({});
    try {
      setLogoUrl(await fetchLogoUrl(urlDraft));
      setUrlDraft("");
      setShowUrl(false);
      pushToast({ kind: "success", message: "Logo fetched. Save to apply it." });
    } catch (error) {
      const message =
        error instanceof LogoError ? error.message : "That image could not be fetched.";
      pushToast({ kind: "error", message });
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const result = (await api.PATCH("/v1/tenants/current/identity", {
        body: {
          logoUrl,
          supportEmail: supportEmail.trim(),
          supportPhone: supportPhone.trim(),
          legalEntity: legalEntity.trim(),
          appName: appName.trim(),
          colors: { primary, secondary, accent },
        },
      })) as unknown as { error?: unknown };
      if (result.error !== undefined && result.error !== null) {
        const issues = fieldIssues(result.error);
        setErrors(issues);
        if (Object.keys(issues).length === 0) {
          pushToast({ kind: "error", message: describeError(result.error).message });
        }
        return;
      }
      // The whole dashboard reads branding from this query, so invalidating it
      // re-themes the shell, retitles the tab and redraws the logo in place.
      await queryClient.invalidateQueries({ queryKey: ["tenant-config"] });
      pushToast({ kind: "success", message: "State details saved." });
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    if (file !== undefined) void readFile(file);
    event.currentTarget.value = "";
  };

  return (
    <Card
      title="State identity and branding"
      description="What drivers and staff see: the state's logo, its name on documents, and how to reach support."
    >
      <form className="space-y-4" noValidate onSubmit={(event) => void save(event)}>
        <div className="flex flex-wrap items-center gap-3">
          <BrandingLogo
            logoUrl={logoUrl}
            name={appName === "" ? identity.name : appName}
            className="h-14 w-14 rounded-md border border-slate-200"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              className="hidden"
              aria-label="Logo file"
              onChange={onFileChange}
            />
            <Button variant="ghost" disabled={busy} onClick={() => fileInput.current?.click()}>
              Choose file
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setShowUrl((current) => !current);
              }}
            >
              Use a URL
            </Button>
            {logoUrl === "" ? null : (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setLogoUrl("");
                }}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-slate-500">
          PNG, JPEG, SVG or WebP. Large images are shrunk in the browser before saving; an SVG stays
          sharp at any size.
        </p>
        {errors["logoUrl"] === undefined ? null : (
          <p className="text-xs text-red-600">{errors["logoUrl"]}</p>
        )}

        {showUrl ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[16rem] flex-1">
              <Field label="Logo address" hint="Only works when the site allows embedding.">
                <TextInput
                  value={urlDraft}
                  onValueChange={setUrlDraft}
                  placeholder="https://example.gov/logo.svg"
                />
              </Field>
            </div>
            <Button
              variant="secondary"
              disabled={busy || urlDraft.trim() === ""}
              onClick={() => void useUrl()}
            >
              Fetch
            </Button>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="App name" {...fieldError("appName")}>
            <TextInput value={appName} onValueChange={setAppName} />
          </Field>
          <Field
            label="Legal entity"
            hint="Printed on receipts and reports."
            {...fieldError("legalEntity")}
          >
            <TextInput value={legalEntity} onValueChange={setLegalEntity} />
          </Field>
          <Field label="Support email" {...fieldError("supportEmail")}>
            <TextInput
              value={supportEmail}
              onValueChange={setSupportEmail}
              type="email"
              autoComplete="off"
            />
          </Field>
          <Field label="Support phone" {...fieldError("supportPhone")}>
            <TextInput
              value={supportPhone}
              onValueChange={setSupportPhone}
              type="tel"
              inputMode="tel"
              autoComplete="off"
            />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">Brand colours</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <ColourField label="Primary" value={primary} onChange={setPrimary} />
            <ColourField label="Secondary" value={secondary} onChange={setSecondary} />
            <ColourField label="Accent" value={accent} onChange={setAccent} />
          </div>
          {errors["colors"] === undefined ? null : (
            <p className="mt-1 text-xs text-red-600">{errors["colors"]}</p>
          )}
        </fieldset>

        <p className="text-xs text-slate-500">
          Receipt header: <span className="font-medium text-slate-700">{identity.name}</span> — it
          always matches the state's name.
        </p>

        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save state details"}
        </Button>
      </form>
    </Card>
  );
}

function ColourField(
  props: Readonly<{
    readonly label: string;
    readonly value: string;
    readonly onChange: (value: string) => void;
  }>,
): ReactElement {
  return (
    <Field label={props.label}>
      <span className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${props.label} colour`}
          className="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-white"
          value={/^#[0-9a-fA-F]{6}$/.test(props.value) ? props.value : "#000000"}
          onInput={(event) => {
            props.onChange(event.currentTarget.value);
          }}
        />
        <TextInput
          value={props.value}
          ariaLabel={`${props.label} colour hex`}
          onValueChange={props.onChange}
        />
      </span>
    </Field>
  );
}

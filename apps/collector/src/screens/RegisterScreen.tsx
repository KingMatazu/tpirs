import { useMemo, useState, type ReactElement } from "react";
import type { TenantAssetAttribute } from "@tpirs/config";
import { api } from "../api/client.js";
import { Banner, Card, Field, PrimaryButton, Screen, inputClass } from "../components/ui.js";
import { useTenantConfig } from "../lib/data.js";

interface RegisteredAsset {
  readonly id: string;
  readonly shortCode: string;
  readonly assetTypeKey: string;
}

/**
 * Register a vehicle in the street: one request creates the owner and the asset
 * (`POST /v1/assets` takes an inline owner), which is what makes this usable at a
 * roadside instead of a two-screen form. The attributes come from the tenant's
 * asset-type schema, so a new vehicle type is config, not code.
 */
export function RegisterScreen(props: Readonly<{ onBack: () => void }>): ReactElement {
  const config = useTenantConfig();
  const types = config?.assetTypes ?? [];
  const [typeKey, setTypeKey] = useState(() => types[0]?.key ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [registered, setRegistered] = useState<RegisteredAsset | undefined>(undefined);

  const type = useMemo(() => types.find((entry) => entry.key === typeKey), [types, typeKey]);
  const attributes = type?.attributes ?? [];

  const reset = (): void => {
    setValues({});
    setOwnerName("");
    setOwnerPhone("");
    setError(undefined);
    setRegistered(undefined);
  };

  const submit = async (): Promise<void> => {
    if (type === undefined) {
      setError("Pick a vehicle type.");
      return;
    }
    const missing = attributes.filter(
      (attribute) => attribute.required && (values[attribute.key] ?? "").trim() === "",
    );
    if (missing.length > 0) {
      setError(`Fill in: ${missing.map((attribute) => attribute.label).join(", ")}`);
      return;
    }
    if (ownerName.trim() === "" || ownerPhone.trim() === "") {
      setError("The owner's name and phone number are required.");
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      const result = await api.POST("/v1/assets", {
        body: {
          assetTypeKey: type.key,
          attributes: coerceAttributes(attributes, values),
          owner: { displayName: ownerName.trim(), phone: ownerPhone.trim() },
        },
      });
      if (!result.response.ok) {
        // The server returns per-attribute issues (a plate that fails its
        // pattern, a missing required field); show them, not just "invalid".
        const body = result.data as
          | { error?: { message?: string; issues?: { path: string; message: string }[] } }
          | undefined;
        const issues = body?.error?.issues ?? [];
        setError(
          issues.length > 0
            ? issues.map((issue) => `${issue.path}: ${issue.message}`).join(" · ")
            : (body?.error?.message ?? "The server refused the registration."),
        );
        return;
      }
      const asset = (result.data as { asset?: RegisteredAsset } | undefined)?.asset;
      if (asset === undefined) {
        setError("The vehicle was saved but the response was empty.");
        return;
      }
      setRegistered(asset);
    } catch {
      setError("No connection. Register the vehicle when the phone is back online.");
    } finally {
      setBusy(false);
    }
  };

  if (registered !== undefined) {
    return (
      <Screen
        title="Registered"
        onBack={props.onBack}
        footer={<PrimaryButton onClick={reset}>Register another</PrimaryButton>}
      >
        <Card className="text-center">
          <p className="text-sm text-slate-500">Short code</p>
          <p className="text-2xl font-semibold tracking-wide text-slate-900">
            {registered.shortCode}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Give the driver this code. They can pay by USSD or SMS with it, and the sticker prints
            from the dashboard.
          </p>
        </Card>
        <a
          className="block rounded-xl border border-slate-300 bg-white px-4 py-3 text-center text-base font-medium text-slate-900"
          href={`/v1/assets/${registered.id}/sticker`}
          target="_blank"
          rel="noreferrer"
        >
          Open the sticker
        </a>
        <Banner tone="info">
          The owner&apos;s phone is recorded but not verified. Verification happens by SMS from the
          dashboard; it does not block the vehicle from paying.
        </Banner>
      </Screen>
    );
  }

  return (
    <Screen title="Register vehicle" onBack={props.onBack}>
      {types.length === 0 ? (
        <Banner tone="warning">
          This tenant has no vehicle types configured, so nothing can be registered yet.
        </Banner>
      ) : (
        <Card>
          <Field label="Vehicle type">
            <select
              className={inputClass}
              value={typeKey}
              onChange={(event) => {
                setTypeKey(event.currentTarget.value);
                setValues({});
              }}
            >
              {types.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
        </Card>
      )}

      <Card>
        <div className="flex flex-col gap-3">
          {attributes.map((attribute) => (
            <Field
              key={attribute.key}
              label={attribute.label + (attribute.required ? "" : " (optional)")}
            >
              {attribute.type === "enum" ? (
                <select
                  className={inputClass}
                  value={values[attribute.key] ?? ""}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    setValues((current) => ({ ...current, [attribute.key]: next }));
                  }}
                >
                  <option value="">Select…</option>
                  {(attribute.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={inputClass}
                  type={attribute.type === "date" ? "date" : "text"}
                  inputMode={attribute.type === "number" ? "numeric" : "text"}
                  value={values[attribute.key] ?? ""}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    setValues((current) => ({ ...current, [attribute.key]: next }));
                  }}
                />
              )}
            </Field>
          ))}
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-3">
          <Field label="Owner name">
            <input
              className={inputClass}
              value={ownerName}
              onChange={(event) => {
                setOwnerName(event.currentTarget.value);
              }}
              autoComplete="name"
            />
          </Field>
          <Field label="Owner phone" hint="Used for the receipt SMS and USSD payments.">
            <input
              className={inputClass}
              inputMode="tel"
              value={ownerPhone}
              onChange={(event) => {
                setOwnerPhone(event.currentTarget.value);
              }}
              placeholder="+2348000000000"
            />
          </Field>
        </div>
      </Card>

      {error === undefined ? null : <Banner tone="danger">{error}</Banner>}

      <PrimaryButton onClick={() => void submit()} disabled={busy || types.length === 0}>
        {busy ? "Registering…" : "Register vehicle"}
      </PrimaryButton>
    </Screen>
  );
}

/**
 * The schema decides the type: a `number` attribute is sent as a number, an enum
 * as its string, and everything else as trimmed text. An empty optional field is
 * omitted rather than sent as "", so the server's pattern checks see absence.
 */
function coerceAttributes(
  schema: readonly TenantAssetAttribute[],
  values: Readonly<Record<string, string>>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const attribute of schema) {
    const raw = values[attribute.key];
    if (raw === undefined || raw.trim() === "") continue;
    out[attribute.key] = attribute.type === "number" ? Number(raw.trim()) : raw.trim();
  }
  return out;
}

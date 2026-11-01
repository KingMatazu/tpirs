import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { TenantAssetAttribute } from "@tpirs/config";
import { api } from "../api/client.js";
import {
  Banner,
  Card,
  Field,
  PrimaryButton,
  Screen,
  SecondaryButton,
  inputClass,
} from "../components/ui.js";
import { useTenantConfig } from "../lib/data.js";

interface Issue {
  readonly path: string;
  readonly message: string;
}

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
        // openapi-fetch puts a non-2xx body in `error`, not `data` — reading
        // `data` here meant every refusal showed the fallback sentence instead of
        // the server's reason, which is exactly the message an officer needs.
        // The generated types only describe the 200 branch, so `error` is typed
        // as never here; at runtime it is where openapi-fetch put the body.
        const payload = result as unknown as {
          readonly error?: { error?: { message?: string; issues?: Issue[] } };
          readonly data?: { error?: { message?: string; issues?: Issue[] } };
        };
        const body = payload.error ?? payload.data;
        const issues = body?.error?.issues ?? [];
        setError(
          issues.length > 0
            ? // The issue paths are attribute keys; the officer typed labels.
              issues
                .map((issue) => {
                  const label =
                    attributes.find((attribute) => attribute.key === issue.path)?.label ??
                    issue.path;
                  return `${label}: ${issue.message}`;
                })
                .join(" · ")
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
        <StickerPanel assetId={registered.id} shortCode={registered.shortCode} />
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
              {...(patternHint(attribute.pattern) === undefined
                ? {}
                : { hint: patternHint(attribute.pattern) ?? "" })}
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
                  autoCapitalize="characters"
                  autoCorrect="off"
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
 * The sticker, fetched with the bearer and shown from an object URL.
 *
 * It cannot be a plain link to `/v1/assets/:id/sticker`: the access token lives in
 * memory, and a browser navigation in a new tab carries no `Authorization`
 * header, so the API answered 401 and the officer saw a JSON error instead of a
 * sticker. Fetching it here and rendering the blob keeps the token where it
 * belongs and works on a phone, where a popup after an `await` is often blocked.
 */
function StickerPanel(props: Readonly<{ assetId: string; shortCode: string }>): ReactElement {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [url]);

  const load = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.GET("/v1/assets/{id}/sticker", {
        params: { path: { id: props.assetId } },
      });
      if (!result.response.ok) {
        setError("The sticker could not be loaded. Try again when the phone is online.");
        return;
      }
      // The route answers with SVG, so the generated client hands back text.
      const svg = result.data as unknown as string;
      const blob = new Blob([svg], { type: "image/svg+xml" });
      setUrl(URL.createObjectURL(blob));
    } catch {
      setError("The sticker could not be loaded. Try again when the phone is online.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      {url === undefined ? (
        <SecondaryButton disabled={busy} onClick={() => void load()}>
          {busy ? "Loading sticker…" : "Show the sticker"}
        </SecondaryButton>
      ) : (
        <div className="flex flex-col gap-2">
          <img src={url} alt={`Sticker for ${props.shortCode}`} className="mx-auto w-48" />
          <a
            className="block rounded-xl border border-slate-300 bg-white px-4 py-3 text-center text-base font-medium text-slate-900"
            href={url}
            download={`sticker-${props.shortCode}.svg`}
          >
            Save the sticker
          </a>
        </div>
      )}
      {error === undefined ? null : <p className="mt-2 text-sm text-red-700">{error}</p>}
    </Card>
  );
}

/**
 * Turns the tenant's pattern into something an officer can act on before the
 * server refuses them. Only the common shape is translated — a plate or code that
 * is "5 to 8 capital letters or digits" — because inventing words for an
 * arbitrary regex would be worse than saying nothing.
 */
function patternHint(pattern: string | undefined): string | undefined {
  if (pattern === undefined) return undefined;
  const simple = /^\^?\[A-Z0-9\]\{(\d+),(\d+)\}\$?$/.exec(pattern);
  if (simple !== null) {
    return `${simple[1] ?? ""}–${simple[2] ?? ""} capital letters or digits, no spaces or dashes.`;
  }
  return undefined;
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

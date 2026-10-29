import { useState, type FormEvent, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TenantAssetType } from "@tpirs/config";
import { api } from "../api/client.js";
import { unwrap } from "../api/unwrap.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  ReadOnlyNote,
  TextInput,
} from "../components/ui.js";
import {
  ASSET_STATUS_OPTIONS,
  assetStatusLabel,
  assetStatusTone,
  assetTypeLabel,
  attributeRows,
  attributesJson,
  attributesJsonText,
  correctionBody,
  downloadSticker,
  findAssetType,
  ownerCreateBody,
  ownerVerifyConfirmBody,
  ownerVerifyRequestBody,
  ownerVerifiedLabel,
  registryQueryParams,
  suspendBody,
  type AssetDetailView,
  type AssetStatus,
  type AssetView,
  type OwnerView,
  type RegistryQueryParams,
} from "../lib/registryView.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { describeError, pushToast } from "../toast.js";
import { useSession } from "../session.js";

const PAGE_SIZE = 50;

/**
 * Phase 9, Step 2: the asset registry.
 *
 * Search, open, correct and suspend an asset, and manage its owner's phone
 * verification. The detail renders the attributes from the tenant's own
 * asset-type schema, so onboarding a new asset type (a stall, a bus) is a config
 * change and this page keeps working with no code edit — there is no hardcoded
 * field list anywhere below.
 *
 * Permissions gate every affordance on `asset:manage`: an auditor holds only
 * `asset:read` and sees the same records with no mutation controls at all. The
 * server enforces the same rule; this only hides what would 403.
 *
 * The sticker is an SVG, not JSON, so it bypasses the generated client and is
 * fetched with the in-memory bearer (the same seam the report export uses).
 */
export function RegistryPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("asset:read"));
  const { config } = useTenantConfig();
  const queryClient = useQueryClient();

  const [searchText, setSearchText] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState<AssetStatus | "">("");
  const [assetTypeKey, setAssetTypeKey] = useState("");
  const [selected, setSelected] = useState<string | undefined>(undefined);

  const params = registryQueryParams({
    query: appliedQuery,
    status,
    assetTypeKey,
    limit: PAGE_SIZE,
  });
  const assets = useQuery({
    queryKey: ["registry-assets", params],
    queryFn: async () => await fetchAssets(params),
    enabled: canRead,
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["registry-assets"] }),
      queryClient.invalidateQueries({ queryKey: ["registry-asset"] }),
    ]);
  };

  if (!canRead) {
    return (
      <p className="text-sm text-slate-600">You do not have permission to view the registry.</p>
    );
  }

  const assetTypes = config?.config.assetTypes ?? [];
  const rows = assets.data ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Registry</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Assets registered in this tenant, their attributes, photos and sticker. Attributes are
          laid out from the tenant's asset-type schema, so a new asset type needs config only.
        </p>
      </div>

      <Card title="Find assets" description="Free text matches a short code or a plate/identifier.">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setAppliedQuery(searchText);
          }}
        >
          <Field label="Search">
            <TextInput
              name="query"
              value={searchText}
              onValueChange={setSearchText}
              placeholder="Short code or plate"
            />
          </Field>
          <Field label="Status">
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={status}
              onChange={(event) => {
                setStatus(event.currentTarget.value as AssetStatus | "");
              }}
            >
              {ASSET_STATUS_OPTIONS.map((option) => (
                <option key={option.value === "" ? "all" : option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Asset type">
            <select
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={assetTypeKey}
              onChange={(event) => {
                setAssetTypeKey(event.currentTarget.value);
              }}
            >
              <option value="">All asset types</option>
              {assetTypes.map((assetType) => (
                <option key={assetType.key} value={assetType.key}>
                  {assetType.label}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit">Search</Button>
        </form>
      </Card>

      <Card title="Assets" description="Newest first, as the registry service returns them.">
        {assets.isLoading ? (
          <p className="text-sm text-slate-500">Loading assets…</p>
        ) : assets.error !== null ? (
          <p className="text-sm text-red-600">Assets could not be loaded.</p>
        ) : rows.length === 0 ? (
          <EmptyState message="No assets match these filters." />
        ) : (
          <AssetTable
            assets={rows}
            assetTypes={assetTypes}
            selected={selected}
            onSelect={setSelected}
          />
        )}
      </Card>

      {selected === undefined ? null : (
        <AssetDetail
          key={selected}
          assetId={selected}
          assetTypes={assetTypes}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

async function fetchAssets(params: RegistryQueryParams): Promise<readonly AssetView[]> {
  const data = await unwrap(api.GET("/v1/assets", { params: { query: params } }));
  return (data as { assets: readonly AssetView[] }).assets;
}

async function fetchAssetDetail(assetId: string): Promise<AssetDetailView> {
  return await unwrap(api.GET("/v1/assets/{id}", { params: { path: { id: assetId } } }));
}

function AssetTable(props: {
  readonly assets: readonly AssetView[];
  readonly assetTypes: readonly TenantAssetType[];
  readonly selected: string | undefined;
  readonly onSelect: (assetId: string) => void;
}): ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th className="py-2 pr-4 font-medium">Short code</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Zone</th>
            <th className="py-2 pr-4 font-medium">Owner</th>
            <th className="py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {props.assets.map((asset) => (
            <tr key={asset.id} className="border-b border-slate-100">
              <td className="py-2 pr-4 font-mono text-xs text-slate-700">{asset.shortCode}</td>
              <td className="py-2 pr-4 text-slate-700">
                {assetTypeLabel(props.assetTypes, asset.assetTypeKey)}
              </td>
              <td className="py-2 pr-4">
                <Badge tone={assetStatusTone(asset.status)}>{assetStatusLabel(asset.status)}</Badge>
              </td>
              <td className="py-2 pr-4 text-slate-600">{asset.zoneId ?? "—"}</td>
              <td className="py-2 pr-4 font-mono text-xs text-slate-600">{asset.ownerId ?? "—"}</td>
              <td className="py-2">
                <button
                  type="button"
                  className="cursor-pointer text-xs underline"
                  onClick={() => {
                    props.onSelect(asset.id);
                  }}
                >
                  {props.selected === asset.id ? "Selected" : "Open"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AssetDetail(props: {
  readonly assetId: string;
  readonly assetTypes: readonly TenantAssetType[];
  readonly onChanged: () => Promise<void>;
}): ReactElement {
  const canManage = useSession((state) => state.hasPermission("asset:manage"));
  const [downloading, setDownloading] = useState(false);

  const detail = useQuery({
    queryKey: ["registry-asset", props.assetId],
    queryFn: async () => await fetchAssetDetail(props.assetId),
  });

  if (detail.isLoading) return <p className="text-sm text-slate-500">Loading asset…</p>;
  if (detail.error !== null || detail.data === undefined) {
    return <p className="text-sm text-red-600">This asset could not be loaded.</p>;
  }

  const asset = detail.data.asset;
  const photos = detail.data.photos;
  const assetType = findAssetType(props.assetTypes, asset.assetTypeKey);
  const rows = attributeRows(assetType, asset.attributes);

  const download = async (): Promise<void> => {
    setDownloading(true);
    try {
      const filename = await downloadSticker({
        assetId: asset.id,
        shortCode: asset.shortCode,
        token: useSession.getState().accessToken,
      });
      pushToast({ kind: "success", message: `Downloaded ${filename}.` });
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card
        title="Asset"
        description="Opaque identifiers are shown verbatim so an operator can search with them."
      >
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Short code</dt>
          <dd className="font-mono text-xs text-slate-900">{asset.shortCode}</dd>
          <dt className="text-slate-500">Type</dt>
          <dd className="text-slate-900">{assetTypeLabel(props.assetTypes, asset.assetTypeKey)}</dd>
          <dt className="text-slate-500">Status</dt>
          <dd>
            <Badge tone={assetStatusTone(asset.status)}>{assetStatusLabel(asset.status)}</Badge>
          </dd>
          <dt className="text-slate-500">Zone</dt>
          <dd className="text-slate-900">{asset.zoneId ?? "—"}</dd>
          <dt className="text-slate-500">Owner</dt>
          <dd className="font-mono text-xs text-slate-900">{asset.ownerId ?? "—"}</dd>
        </dl>
        <div className="mt-3">
          <Button
            variant="ghost"
            disabled={downloading}
            onClick={() => {
              void download();
            }}
          >
            {downloading ? "Preparing sticker…" : "Download sticker"}
          </Button>
        </div>
        {canManage ? null : (
          <div className="mt-3">
            <ReadOnlyNote>Read-only: your role can view assets but not change them.</ReadOnlyNote>
          </div>
        )}
      </Card>

      <Card
        title="Attributes"
        description="Laid out from the tenant's asset-type schema; extra keys are shown, never dropped."
      >
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500">
              <th className="py-2 pr-4 font-medium">Attribute</th>
              <th className="py-2 pr-4 font-medium">Value</th>
              <th className="py-2 font-medium">Rules</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-slate-100">
                <td className="py-2 pr-4 text-slate-700">
                  {row.label}
                  {row.key === row.label ? null : (
                    <span className="ml-2 font-mono text-xs text-slate-400">{row.key}</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-slate-900">{row.value}</td>
                <td className="py-2 text-xs text-slate-500">
                  {row.extra ? "not in schema" : `${row.type}${row.required ? ", required" : ""}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Photos" description="Evidence attached at registration; the newest is last.">
        {photos.length === 0 ? (
          <EmptyState message="No photo has been attached to this asset." />
        ) : (
          <ul className="flex flex-wrap gap-3">
            {photos.map((photo, index) => (
              <li key={photo.id}>
                <img
                  src={photo.url}
                  alt={`Asset photo ${String(index + 1)}`}
                  className="h-32 w-32 rounded border border-slate-200 object-cover"
                />
              </li>
            ))}
          </ul>
        )}
        {canManage ? <PhotoUpload assetId={asset.id} onDone={props.onChanged} /> : null}
      </Card>

      {canManage ? (
        <>
          {asset.status === "active" ? (
            <SuspendForm assetId={asset.id} onDone={props.onChanged} />
          ) : (
            <Card title="Suspend">
              <ReadOnlyNote>
                Only an active asset can be suspended; this one is{" "}
                {assetStatusLabel(asset.status).toLowerCase()}.
              </ReadOnlyNote>
            </Card>
          )}
          <CorrectionForm
            assetId={asset.id}
            assetType={assetType}
            attributes={asset.attributes}
            onDone={props.onChanged}
          />
          <OwnerPanel initialOwnerId={asset.ownerId} />
        </>
      ) : null}
    </div>
  );
}

function SuspendForm(props: {
  readonly assetId: string;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (reason.trim() === "") {
      pushToast({ kind: "error", message: "A reason is required." });
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/assets/{id}/suspend", {
          params: { path: { id: props.assetId } },
          body: suspendBody(reason),
        }),
      );
      pushToast({ kind: "success", message: "Asset suspended." });
      await props.onDone();
      setReason("");
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Suspend"
      description="Suspension is audited with the reason; the asset stops verifying as paid."
    >
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void submit(event)}>
        <Field label="Reason">
          <TextInput
            name="reason"
            value={reason}
            onValueChange={setReason}
            placeholder="Reason for suspension"
          />
        </Field>
        <Button type="submit" variant="ghost" disabled={busy}>
          {busy ? "Suspending…" : "Suspend asset"}
        </Button>
      </form>
    </Card>
  );
}

function CorrectionForm(props: {
  readonly assetId: string;
  readonly assetType: TenantAssetType | undefined;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const [text, setText] = useState(() => attributesJsonText(props.attributes));
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const parsed = attributesJson(text, props.assetType);
    if (!parsed.ok) {
      pushToast({ kind: "error", message: parsed.error });
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        api.PATCH("/v1/assets/{id}", {
          params: { path: { id: props.assetId } },
          body: correctionBody(parsed.attributes),
        }),
      );
      pushToast({ kind: "success", message: "Asset corrected." });
      await props.onDone();
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Correct attributes"
      description="Corrections replace the whole attribute set and are audited with the actor."
    >
      <form className="space-y-3" onSubmit={(event) => void submit(event)}>
        <Field label="Attributes (JSON)" hint="A JSON object; the server re-validates every rule.">
          <textarea
            name="attributes"
            aria-label="Attributes JSON"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-[var(--tpirs-color-primary)] focus:outline-none"
            rows={8}
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value);
            }}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save correction"}
        </Button>
      </form>
    </Card>
  );
}

function PhotoUpload(props: {
  readonly assetId: string;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const [busy, setBusy] = useState(false);

  const attach = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const content = await readBase64(file);
      await unwrap(
        api.POST("/v1/assets/{id}/photos", {
          params: { path: { id: props.assetId } },
          body: { contentType: file.type === "" ? "image/jpeg" : file.type, content },
        }),
      );
      pushToast({ kind: "success", message: "Photo attached." });
      await props.onDone();
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <Field label="Attach photo" hint="Uploaded as base64; the server stores the bytes.">
        <input
          type="file"
          accept="image/*"
          disabled={busy}
          className="block w-full text-sm text-slate-700"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file !== undefined) void attach(file);
          }}
        />
      </Field>
    </div>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("The file could not be read."));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => {
      reject(new Error("The file could not be read."));
    };
    reader.readAsDataURL(file);
  });
}

function OwnerPanel(props: { readonly initialOwnerId: string | null }): ReactElement {
  const [ownerId, setOwnerId] = useState(props.initialOwnerId ?? "");
  const [owner, setOwner] = useState<OwnerView | undefined>(undefined);
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const lookup = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (ownerId.trim() === "") {
      pushToast({ kind: "error", message: "An owner id is required." });
      return;
    }
    setBusy(true);
    try {
      const found = await unwrap(
        api.GET("/v1/owners/{id}", { params: { path: { id: ownerId.trim() } } }),
      );
      setOwner(found.owner);
    } catch (error) {
      setOwner(undefined);
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (displayName.trim() === "" || phone.trim() === "") {
      pushToast({ kind: "error", message: "A name and phone number are required." });
      return;
    }
    setBusy(true);
    try {
      const created = await unwrap(
        api.POST("/v1/owners", { body: ownerCreateBody(displayName, phone) }),
      );
      setOwner(created.owner);
      setOwnerId(created.owner.id);
      pushToast({ kind: "success", message: `Owner ${created.owner.displayName} created.` });
      setDisplayName("");
      setPhone("");
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const requestCode = async (): Promise<void> => {
    if (owner === undefined) return;
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/owners/verify/request", {
          body: ownerVerifyRequestBody({ ownerId: owner.id }),
        }),
      );
      pushToast({ kind: "success", message: "Verification code sent." });
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (owner === undefined) return;
    if (code.trim() === "") {
      pushToast({ kind: "error", message: "The code from the SMS is required." });
      return;
    }
    setBusy(true);
    try {
      const verified = await unwrap(
        api.POST("/v1/owners/verify/confirm", {
          body: ownerVerifyConfirmBody(owner.id, code),
        }),
      );
      setOwner(verified.owner);
      setCode("");
      pushToast({ kind: "success", message: "Owner phone verified." });
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Owner"
      description="Look up, create or verify the owner who is liable for this asset."
    >
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void lookup(event)}>
        <Field label="Owner id">
          <TextInput name="ownerId" value={ownerId} onValueChange={setOwnerId} />
        </Field>
        <Button type="submit" variant="ghost" disabled={busy}>
          Look up owner
        </Button>
      </form>

      {owner === undefined ? null : (
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Name</dt>
          <dd className="text-slate-900">{owner.displayName}</dd>
          <dt className="text-slate-500">Phone</dt>
          <dd className="text-slate-900">{owner.phone}</dd>
          <dt className="text-slate-500">Verification</dt>
          <dd className="text-slate-900">
            {ownerVerifiedLabel(owner)}
            {owner.phoneVerifiedAt === null ? null : (
              <span className="ml-2 font-mono text-xs text-slate-500">{owner.phoneVerifiedAt}</span>
            )}
          </dd>
        </dl>
      )}

      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(event) => void create(event)}
      >
        <Field label="Owner name">
          <TextInput name="displayName" value={displayName} onValueChange={setDisplayName} />
        </Field>
        <Field label="Owner phone">
          <TextInput
            name="phone"
            inputMode="tel"
            value={phone}
            onValueChange={setPhone}
            placeholder="+234…"
          />
        </Field>
        <Button type="submit" variant="ghost" disabled={busy}>
          Create owner
        </Button>
      </form>

      {owner === undefined ? null : (
        <div className="mt-4 space-y-3">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              void requestCode();
            }}
          >
            Send verification code
          </Button>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => void confirm(event)}
          >
            <Field label="Verification code">
              <TextInput name="code" inputMode="numeric" value={code} onValueChange={setCode} />
            </Field>
            <Button type="submit" disabled={busy}>
              Confirm code
            </Button>
          </form>
        </div>
      )}
    </Card>
  );
}

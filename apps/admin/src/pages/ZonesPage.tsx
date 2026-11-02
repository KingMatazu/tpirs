import { useState, type FormEvent, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { unwrap } from "../api/unwrap.js";
import { Button, Card, EmptyState, Field, ReadOnlyNote, TextInput } from "../components/ui.js";
import { describeError, pushToast } from "../toast.js";
import { useSession } from "../session.js";

/**
 * Zone management (Phase 11, 11.0b).
 *
 * Zones are the tenant's parks, markets and districts: the hierarchy the
 * registry, reports and collector views group by. An empty list is a perfectly
 * valid tenant — an asset needs no zone — so the screen says so rather than
 * pressuring the operator to invent geography. Editing is create and rename;
 * zones are never deleted, because payments, scans and audit rows point at them.
 */
export interface ZoneView {
  readonly id: string;
  readonly parentZoneId: string | null;
  readonly name: string;
}

const ZONES_KEY = ["zones"] as const;

/** Order zones as a tree: each parent immediately followed by its children. */
export function zoneRows(zones: readonly ZoneView[]): readonly { zone: ZoneView; depth: number }[] {
  const byParent = new Map<string | null, ZoneView[]>();
  for (const zone of zones) {
    const siblings = byParent.get(zone.parentZoneId) ?? [];
    siblings.push(zone);
    byParent.set(zone.parentZoneId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name));
  }
  const rows: { zone: ZoneView; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    for (const zone of byParent.get(parentId) ?? []) {
      // A cycle cannot be created through this API (parents are immutable), but
      // a hand-written row would otherwise loop forever.
      if (seen.has(zone.id)) continue;
      seen.add(zone.id);
      rows.push({ zone, depth });
      walk(zone.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything whose parent is missing from the list is still shown, at the top.
  for (const zone of zones) {
    if (!seen.has(zone.id)) rows.push({ zone, depth: 0 });
  }
  return rows;
}

export function ZonesPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("zone:read"));
  const canManage = useSession((state) => state.hasPermission("zone:manage"));
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [renameValue, setRenameValue] = useState("");

  const query = useQuery({
    queryKey: ZONES_KEY,
    enabled: canRead,
    queryFn: async () => {
      const result = await api.GET("/v1/zones");
      return (await unwrap(result)).zones;
    },
  });

  if (!canRead) {
    return <p className="text-sm text-slate-600">You do not have permission to view zones.</p>;
  }

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ZONES_KEY });
  };

  const createZone = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const name = newName.trim();
    if (name === "") return;
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/zones", {
          body: { name, ...(newParentId === "" ? {} : { parentZoneId: newParentId }) },
        }),
      );
      pushToast({ kind: "success", message: `Zone "${name}" created.` });
      setNewName("");
      await refresh();
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const renameZone = async (zone: ZoneView): Promise<void> => {
    const name = renameValue.trim();
    if (name === "" || name === zone.name) {
      setRenamingId(undefined);
      return;
    }
    setBusy(true);
    try {
      await unwrap(api.PATCH("/v1/zones/{id}", { params: { path: { id: zone.id } }, body: { name } }));
      pushToast({ kind: "success", message: `Zone renamed to "${name}".` });
      setRenamingId(undefined);
      await refresh();
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const zones = query.data ?? [];
  const rows = zoneRows(zones);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Zones</h1>
      <ReadOnlyNote>
        Parks, markets and districts used to group assets, scans and reports. Leaving this list
        empty is valid: an asset can be registered without a zone, and no report requires one.
      </ReadOnlyNote>

      <Card title="Zones" description={`${zones.length} configured`}>
        {query.isLoading ? <p className="text-sm text-slate-500">Loading zones…</p> : null}
        {query.error !== null ? (
          <p className="text-sm text-red-600">Zones could not be loaded.</p>
        ) : null}
        {!query.isLoading && query.error === null && rows.length === 0 ? (
          <EmptyState message="No zones yet. Add one below if this tenant groups work by zone." />
        ) : null}
        {rows.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {rows.map(({ zone, depth }) => (
              <li key={zone.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1" style={{ paddingLeft: `${String(depth * 16)}px` }}>
                  {renamingId === zone.id ? (
                    <span className="inline-flex items-center gap-2">
                      <TextInput
                        name={`rename-${zone.id}`}
                        ariaLabel="Rename zone"
                        value={renameValue}
                        onValueChange={setRenameValue}
                      />
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() => {
                          void renameZone(zone);
                        }}
                      >
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setRenamingId(undefined);
                        }}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <span className="text-slate-900">{zone.name}</span>
                  )}
                </span>
                {canManage && renamingId !== zone.id ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setRenamingId(zone.id);
                      setRenameValue(zone.name);
                    }}
                  >
                    Rename
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {canManage ? (
        <Card title="Add a zone" description="Names must be unique within the same parent.">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void createZone(event)}>
            <div className="w-56">
              <Field label="Name">
                <TextInput
                  name="zone-name"
                  value={newName}
                  onValueChange={setNewName}
                  placeholder="Central market"
                />
              </Field>
            </div>
            <div className="w-56">
              <Field label="Parent zone" hint="Optional">
                <select
                  aria-label="Parent zone"
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  value={newParentId}
                  onChange={(event) => {
                    setNewParentId(event.target.value);
                  }}
                >
                  <option value="">No parent (top level)</option>
                  {rows.map(({ zone, depth }) => (
                    <option key={zone.id} value={zone.id}>
                      {`${"– ".repeat(depth)}${zone.name}`}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Button type="submit" disabled={busy || newName.trim() === ""}>
              {busy ? "Saving…" : "Add zone"}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

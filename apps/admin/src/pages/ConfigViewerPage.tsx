import { type ReactElement } from "react";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { configSections } from "../lib/configSections.js";
import { Badge, Card, ReadOnlyNote } from "../components/ui.js";
import { useSession } from "../session.js";

/**
 * Step 4: read-only config viewer, permission-gated on `tenant:read`. It renders
 * the validated config the API serves; changing configuration belongs to the
 * audited PUT endpoint (dual control), not to this screen.
 */
export function ConfigViewerPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("tenant:read"));
  const { config, isLoading, error } = useTenantConfig();

  if (!canRead) {
    return <p className="text-sm text-slate-600">You do not have permission to view configuration.</p>;
  }
  if (isLoading) return <p className="text-sm text-slate-500">Loading configuration…</p>;
  if (error !== null || config === undefined) {
    return <p className="text-sm text-red-600">Tenant configuration could not be loaded.</p>;
  }

  const tenantConfig = config.config;
  const sections = configSections(tenantConfig);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Tenant configuration</h1>
        <Badge tone="brand">version {String(config.version)}</Badge>
      </div>
      <ReadOnlyNote>
        Read-only view of the validated tenant config. Changes go through the audited
        configuration endpoint with `tenant:configure`.
      </ReadOnlyNote>
      {sections.map((section) => (
        <Card key={section.id} title={section.title}>
          <EntriesList entries={section.entries} />
          {section.subGroups.map((group) => (
            <div key={group.title} className="mt-3 border-t border-slate-100 pt-3">
              <h3 className="mb-2 text-sm font-semibold text-slate-700">{group.title}</h3>
              <EntriesList entries={group.entries} />
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

function EntriesList(props: {
  readonly entries: readonly { label: string; value: string }[];
}): ReactElement {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {props.entries.map((entry) => (
        <div key={entry.label} className="contents">
          <dt className="text-slate-500">{entry.label}</dt>
          <dd className="break-words text-slate-900">{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}
